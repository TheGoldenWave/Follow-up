"""Shared RSS/Atom adapter built on feedparser.

One :class:`RssAdapter` instance serves every RSS/Atom source (newsletters,
podcasts, Chinese tech feeds, arXiv, and blogs that expose a feed). The source's
feed URL is resolved from the registry via an injected ``resolve_source``
callable; it is never taken from the acquisition ``request``, so the batch's
``request`` field stays within the contract (mode/topic/subject/window/depth).
"""

from __future__ import annotations

import calendar
import socket
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..runtime import AdapterError, SourceCandidate, SourceResult

DEFAULT_TIMEOUT_SECONDS = 30.0
USER_AGENT = "Follow-up/0.3 (local acquisition; contact your instance owner)"


def _struct_to_iso(value: Any) -> str:
    """Convert a ``time.struct_time`` (UTC) to an ISO-8601 second timestamp."""
    return datetime.fromtimestamp(
        calendar.timegm(value), tz=timezone.utc
    ).isoformat(timespec="seconds")


def _entry_date(entry: Any) -> tuple[str | None, str]:
    """Return ``(published_at_iso, confidence)`` for one feedparser entry.

    Confidence follows the Signal Batch taxonomy: a feed-stated publication time
    is ``exact``; a fallback update time or a reparsed raw string is ``inferred``;
    anything else is ``unknown``.
    """
    if entry.get("published_parsed"):
        return _struct_to_iso(entry["published_parsed"]), "exact"
    if entry.get("updated_parsed"):
        return _struct_to_iso(entry["updated_parsed"]), "inferred"
    raw = entry.get("published") or entry.get("updated")
    if raw:
        from email.utils import parsedate_to_datetime

        try:
            parsed = parsedate_to_datetime(raw)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.isoformat(timespec="seconds"), "inferred"
        except (TypeError, ValueError, OverflowError):
            return None, "unknown"
    return None, "unknown"


def _entry_text(entry: Any) -> str | None:
    content = entry.get("content")
    if content and content[0].get("value"):
        return content[0]["value"]
    return entry.get("summary") or entry.get("description") or None


def _entry_author(entry: Any) -> str | None:
    # Prefer the parsed name so RSS ``email (Name)`` authors do not leak emails.
    detail = entry.get("author_detail")
    if detail and detail.get("name"):
        return detail["name"]
    return entry.get("author") or None


def _entry_native_metrics(entry: Any) -> dict[str, Any]:
    metrics: dict[str, Any] = {}
    links = entry.get("links") or []
    enclosures = [link for link in links if link.get("rel") == "enclosure"]
    if enclosures:
        metrics["enclosures"] = enclosures
    for key in ("itunes_duration", "itunes_episodetype"):
        if entry.get(key):
            metrics[key] = entry[key]
    return metrics


class RssAdapter:
    adapter_id = "rss"
    adapter_version = "0.3.0"

    def __init__(
        self,
        resolve_source: Callable[[str], Any] | None = None,
        fetch: Callable[[str], bytes] | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._resolve = resolve_source or (lambda _source: None)
        self._fetch = fetch or self._default_fetch
        self._timeout = timeout

    def _default_fetch(self, url: str) -> bytes:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=self._timeout) as response:
            return response.read()

    # ---- Adapter protocol ----

    def availability_probe(self) -> str:
        try:
            import feedparser  # noqa: F401
        except ImportError as exc:
            raise AdapterError(
                "feedparser is not installed",
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
        import feedparser

        rss_url, source_type = self._resolve_feed(source)

        try:
            payload = self._fetch(rss_url)
        except (socket.timeout, TimeoutError) as exc:
            raise AdapterError(
                f"feed fetch timed out: {rss_url}",
                status="timeout",
                retryable=True,
            ) from exc
        except HTTPError as exc:
            status = self._http_error_status(exc.code)
            raise AdapterError(
                f"feed fetch failed with HTTP {exc.code}: {rss_url}",
                status=status,
                retryable=status in ("rate-limited", "unreachable"),
            ) from exc
        except (URLError, OSError) as exc:
            raise AdapterError(
                f"feed unreachable: {rss_url}",
                status="unreachable",
                retryable=True,
            ) from exc

        parsed = feedparser.parse(payload)
        if parsed.bozo and not parsed.entries:
            detail = getattr(parsed, "bozo_exception", None)
            raise AdapterError(
                f"feed parse failed: {detail or 'malformed feed'}",
                status="schema-drift",
                retryable=False,
            )

        fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        candidates = tuple(
            self._map_entry(entry, source_type, fetched_at)
            for entry in parsed.entries
        )
        return SourceResult(
            adapter_id=self.adapter_id,
            adapter_version=self.adapter_version,
            source=source,
            status="ok",
            candidates=candidates,
            request=request,
        )

    # ---- internals ----

    def _resolve_feed(self, source: str) -> tuple[str, str]:
        config = self._resolve(source)
        rss_url: str | None = None
        source_type = "rss"
        if isinstance(config, str):
            rss_url = config
        elif isinstance(config, dict):
            source_type = config.get("channel") or source_type
            inp = config.get("input") or {}
            rss_url = inp.get("rss_url") or config.get("rss_url")
        if not rss_url:
            raise AdapterError(
                f"no rss_url configured for source {source}",
                status="skipped-unconfigured",
                retryable=False,
            )
        return rss_url, source_type

    @staticmethod
    def _http_error_status(code: int) -> str:
        if code == 429:
            return "rate-limited"
        if code in (401, 403):
            return "auth-failed"
        return "unreachable"

    def _map_entry(
        self,
        entry: Any,
        source_type: str,
        fetched_at: str,
    ) -> SourceCandidate:
        warnings: list[dict[str, str]] = []
        has_stable_id = bool(entry.get("id") or entry.get("guid"))
        native_id = entry.get("id") or entry.get("guid") or entry.get("link")
        if not native_id:
            warnings.append({
                "code": "missing_native_id",
                "message": "entry has no id, guid, or link",
            })
            native_id = ""
        elif not has_stable_id:
            warnings.append({
                "code": "missing_guid",
                "message": "entry has no stable id/guid; using link as native id",
            })
        url = entry.get("link") or ""

        published_at, confidence = _entry_date(entry)
        if published_at is None:
            warnings.append({
                "code": "missing_date",
                "message": "entry has no parseable publication date",
            })

        return SourceCandidate(
            native_id=native_id,
            url=url,
            source_type=source_type,
            date_confidence=confidence,
            fetched_at=fetched_at,
            title=entry.get("title"),
            author=_entry_author(entry),
            published_at=published_at,
            text=_entry_text(entry),
            native_metrics=_entry_native_metrics(entry),
            item_warnings=warnings,
        )
