"""Official-blog discovery + extraction adapter (shadow mode).

Discovery follows a fixed order per source: declared RSS/Atom, then sitemap,
then the configured index page. Each discovered article URL is fetched and its
body extracted with trafilatura. Index layout drift maps to ``schema-drift``, a
single article extraction failure becomes an ``item_warnings`` entry, and an
unreachable feed/index maps to ``unreachable``.
"""

from __future__ import annotations

import json
import re
import socket
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from ..runtime import AdapterError, SourceCandidate, SourceResult

DEFAULT_TIMEOUT_SECONDS = 30.0
USER_AGENT = "Follow-up/0.3 (local acquisition; contact your instance owner)"

_SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
_HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""")


def _normalize_date(value: Any) -> tuple[str | None, str]:
    """Normalize a trafilatura date to ISO-8601; confidence is ``inferred``."""
    if value is None:
        return None, "unknown"
    try:
        if isinstance(value, datetime):
            parsed = value
        else:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None, "unknown"
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat(timespec="seconds"), "inferred"


class WebPublicationAdapter:
    adapter_id = "web-publication"
    adapter_version = "0.3.0"

    def __init__(
        self,
        resolve_source: Callable[[str], Any] | None = None,
        fetch: Callable[[str], bytes] | None = None,
        extract: Callable[[bytes, str], dict[str, Any] | None] | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._resolve = resolve_source or (lambda _source: None)
        self._fetch = fetch or self._default_fetch
        self._extract = extract or self._trafilatura_extract
        self._timeout = timeout

    def _default_fetch(self, url: str) -> bytes:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=self._timeout) as response:
            return response.read()

    @staticmethod
    def _trafilatura_extract(html: bytes, url: str) -> dict[str, Any] | None:
        import trafilatura

        result = trafilatura.extract(
            html, url=url, output_format="json", with_metadata=True
        )
        if not result:
            return None
        data = json.loads(result)
        return {
            "title": data.get("title"),
            "author": data.get("author"),
            "date": data.get("date"),
            "text": data.get("text") or data.get("raw_text"),
        }

    # ---- Adapter protocol ----

    def availability_probe(self) -> str:
        try:
            import feedparser  # noqa: F401
            import trafilatura  # noqa: F401
        except ImportError as exc:
            raise AdapterError(
                "web-publication dependencies are not installed",
                status="error",
                retryable=False,
            ) from exc
        return "ok"

    def validate_request(self, request: dict[str, Any]) -> None:
        if not isinstance(request, dict) or not request.get("mode"):
            raise AdapterError(
                "request.mode must be a non-empty string",
                status="error",
                retryable=False,
            )

    def collect(self, source: str, request: dict[str, Any]) -> SourceResult:
        config = self._resolve(source)
        if not isinstance(config, dict):
            raise AdapterError(
                f"no config for source {source}",
                status="skipped-unconfigured",
                retryable=False,
            )
        inp = config.get("input") or {}
        discovery = inp.get("discovery") or []
        patterns = inp.get("article_url_patterns") or []
        excludes = inp.get("exclude_url_patterns") or []

        article_urls, first_error = self._discover(discovery, patterns, excludes)
        if not article_urls:
            if first_error is not None:
                raise first_error
            return SourceResult(
                self.adapter_id, self.adapter_version, source, "ok", request=request
            )

        fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        candidates = tuple(
            self._extract_article(url, "blogs", fetched_at) for url in article_urls
        )
        return SourceResult(
            self.adapter_id, self.adapter_version, source, "ok",
            candidates=candidates, request=request,
        )

    # ---- discovery ----

    def _discover(
        self,
        discovery: list[dict[str, Any]],
        patterns: list[str],
        excludes: list[str],
    ) -> tuple[list[str], AdapterError | None]:
        first_error: AdapterError | None = None
        for method in discovery:
            mtype = method.get("type")
            murl = method.get("url")
            if not murl:
                continue
            try:
                urls = self._discover_by_type(mtype, murl, patterns)
            except AdapterError as exc:
                if first_error is None:
                    first_error = exc
                continue
            urls = self._filter_urls(urls, excludes)
            if urls:
                return self._dedupe_urls(urls), None
        return [], first_error

    def _discover_by_type(
        self, mtype: str, murl: str, patterns: list[str]
    ) -> list[str]:
        if mtype == "rss":
            return self._discover_rss(murl)
        if mtype == "sitemap":
            return self._discover_sitemap(murl, patterns)
        if mtype == "html":
            return self._discover_html(murl, patterns)
        return []

    def _discover_rss(self, rss_url: str) -> list[str]:
        import feedparser

        parsed = feedparser.parse(self._fetch_bytes(rss_url))
        if parsed.bozo and not parsed.entries:
            raise AdapterError(
                "rss discovery parse failed", status="schema-drift", retryable=False
            )
        return [entry.get("link") for entry in parsed.entries if entry.get("link")]

    def _discover_sitemap(self, sitemap_url: str, patterns: list[str]) -> list[str]:
        try:
            root = ET.fromstring(self._fetch_bytes(sitemap_url))
        except ET.ParseError as exc:
            raise AdapterError(
                "sitemap parse failed", status="schema-drift", retryable=False
            ) from exc
        urls = [
            loc.text.strip()
            for loc in root.iter(f"{_SITEMAP_NS}loc")
            if loc is not None and loc.text and loc.text.strip()
        ]
        return self._match_patterns(urls, patterns) if patterns else urls

    def _discover_html(self, index_url: str, patterns: list[str]) -> list[str]:
        html = self._fetch_bytes(index_url).decode("utf-8", errors="replace")
        urls = [urljoin(index_url, href) for href in _HREF_RE.findall(html)]
        matched = self._match_patterns(urls, patterns) if patterns else urls
        if not matched:
            raise AdapterError(
                "index layout drifted: no article links matched",
                status="schema-drift",
                retryable=False,
            )
        return matched

    def _match_patterns(self, urls: list[str], patterns: list[str]) -> list[str]:
        return [url for url in urls if any(re.search(p, url) for p in patterns)]

    @staticmethod
    def _filter_urls(urls: list[str], excludes: list[str]) -> list[str]:
        if not excludes:
            return urls
        return [u for u in urls if not any(re.search(p, u) for p in excludes)]

    @staticmethod
    def _dedupe_urls(urls: list[str]) -> list[str]:
        seen: list[str] = []
        for url in urls:
            if url not in seen:
                seen.append(url)
        return seen

    # ---- extraction ----

    def _fetch_bytes(self, url: str) -> bytes:
        try:
            return self._fetch(url)
        except (socket.timeout, TimeoutError) as exc:
            raise AdapterError(
                f"fetch timed out: {url}", status="timeout", retryable=True
            ) from exc
        except HTTPError as exc:
            status = self._http_error_status(exc.code)
            raise AdapterError(
                f"fetch failed with HTTP {exc.code}: {url}",
                status=status,
                retryable=status in ("rate-limited", "unreachable"),
            ) from exc
        except (URLError, OSError) as exc:
            raise AdapterError(
                f"unreachable: {url}", status="unreachable", retryable=True
            ) from exc

    @staticmethod
    def _http_error_status(code: int) -> str:
        if code == 429:
            return "rate-limited"
        if code in (401, 403):
            return "auth-failed"
        return "unreachable"

    def _extract_article(
        self, url: str, source_type: str, fetched_at: str
    ) -> SourceCandidate:
        warnings: list[dict[str, str]] = []
        meta: dict[str, Any] = {}
        try:
            html = self._fetch_bytes(url)
            extracted = self._extract(html, url)
            if not extracted:
                warnings.append({
                    "code": "extraction_failed",
                    "message": "no extractable content from article",
                })
            else:
                meta = extracted
        except AdapterError as exc:
            warnings.append({
                "code": "extraction_failed",
                "message": f"{exc.status}: {exc}",
            })

        published_at, confidence = _normalize_date(meta.get("date"))
        return SourceCandidate(
            native_id=url,
            url=url,
            source_type=source_type,
            date_confidence=confidence,
            fetched_at=fetched_at,
            title=meta.get("title"),
            author=meta.get("author"),
            published_at=published_at,
            text=meta.get("text"),
            item_warnings=warnings,
        )
