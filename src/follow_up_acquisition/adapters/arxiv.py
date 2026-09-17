"""Bounded arXiv acquisition adapter.

The adapter discovers recent papers from an official arXiv RSS feed and only
uses the Atom metadata API when an entry lacks fields required by the local
candidate contract.  It never downloads PDFs, follows arbitrary links, or
uses page HTML as an authority for metadata.
"""

from __future__ import annotations

import calendar
from email.utils import parsedate_to_datetime
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import replace
from datetime import date, datetime, timezone
from typing import Any, Callable, Mapping
from urllib.parse import urlencode, urlsplit

from ..http_client import HttpClient
from ..runtime import AcquisitionRuntime, AdapterError, CheckpointUpdate, SourceCandidate, SourceResult
from ..source_state import MAX_RECENT_NATIVE_IDS

_MODES = {"central", "shadow", "hybrid", "local"}
_RSS_HOST = "rss.arxiv.org"
_METADATA_HOST = "export.arxiv.org"
_RSS_PATH_PREFIX = "/rss"
_METADATA_PATH_PREFIX = "/api"
_METADATA_QUERY_URL = f"https://{_METADATA_HOST}/api/query"
_INPUT_FIELDS = frozenset({"rss_url", "url", "tags"})
_BROAD_TAGS = frozenset({"academic", "daily", "weekly", "monthly"})
_OLD_ID_RE = re.compile(
    r"^(?:[a-z][a-z0-9-]*\.[A-Z]{2,}/)?[0-9]{4}[0-9]{3}$",
    re.IGNORECASE,
)
_NEW_ID_RE = re.compile(r"^(?:[0-9]{4}\.[0-9]{4,5})$", re.IGNORECASE)
_VERSION_RE = re.compile(r"v([0-9]+)$", re.IGNORECASE)
_ARXIV_ID_FROM_URL_RE = re.compile(
    r"(?:arxiv\.org/(?:abs|pdf)/|arxiv:)([^?#\s]+)",
    re.IGNORECASE,
)


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return " ".join(value.split())
    if isinstance(value, bytes):
        try:
            return " ".join(value.decode("utf-8").split())
        except UnicodeDecodeError:
            return ""
    return ""


def _parse_iso(value: Any) -> str | None:
    if type(value) is not str:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(text)
        except (TypeError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _datetime_to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, time.struct_time):
        try:
            parsed = datetime.fromtimestamp(calendar.timegm(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    elif isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        return _parse_iso(value)
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _entry_value(entry: Any, names: tuple[str, ...], default: Any = None) -> Any:
    if isinstance(entry, Mapping):
        for name in names:
            value = entry.get(name)
            if value not in (None, ""):
                return value
    else:
        for name in names:
            value = getattr(entry, name, None)
            if value not in (None, ""):
                return value
    return default


def _entry_text(entry: Any, names: tuple[str, ...]) -> str | None:
    value = _entry_value(entry, names)
    if isinstance(value, list) and value:
        if isinstance(value[0], Mapping):
            value = value[0].get("value")
        else:
            value = value[0]
    text = _as_text(value)
    return text or None


def _feedparser_author(entry: Any) -> str | None:
    detail = _entry_value(entry, ("author_detail",))
    if isinstance(detail, Mapping) and detail.get("name"):
        return _as_text(detail["name"]) or None
    authors = _entry_value(entry, ("authors",))
    if isinstance(authors, list):
        names = [
            _as_text(item.get("name"))
            for item in authors
            if isinstance(item, Mapping) and item.get("name")
        ]
        if names:
            return ", ".join(names)
    value = _entry_value(entry, ("author", "creator"))
    return _as_text(value) or None


def normalize_arxiv_id(value: Any) -> str | None:
    """Return ``arxiv:<lowercase-id-without-version>`` for an arXiv identifier."""
    text = _as_text(value)
    if not text:
        return None
    candidate = text.strip()
    if candidate.lower().startswith("oai:arxiv.org:"):
        candidate = candidate.rsplit(":", 1)[-1]
    if candidate.lower().startswith("arxiv:"):
        candidate = candidate.split(":", 1)[1]
    match = _ARXIV_ID_FROM_URL_RE.search(candidate)
    if match:
        candidate = match.group(1)
    candidate = candidate.rstrip("/").split("?", 1)[0]
    candidate = re.sub(_VERSION_RE, "", candidate, count=1).strip().lower()
    if not candidate:
        return None
    if _NEW_ID_RE.fullmatch(candidate) or _OLD_ID_RE.fullmatch(candidate):
        return f"arxiv:{candidate}"
    # Accept a conservative version-less ID emitted by fixtures. The contract
    # deliberately avoids inventing IDs for arbitrary external strings.
    if re.fullmatch(r"[a-z][a-z0-9-]*\.[a-z0-9-]{2,}/[0-9]{7}", candidate):
        return f"arxiv:{candidate}"
    return None


def _arxiv_url(native_id: str) -> str:
    if not native_id.startswith("arxiv:"):
        return ""
    return f"https://arxiv.org/abs/{native_id.split(':', 1)[1]}"


def _version_from_text(value: str) -> int | None:
    match = _VERSION_RE.search(value or "")
    if match is None:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _entry_native_id(entry: Any) -> tuple[str | None, str | None, str | None]:
    raw_id = _entry_text(entry, ("id", "guid", "link"))
    link = _entry_text(entry, ("link",))
    normalized = normalize_arxiv_id(raw_id or link)
    if normalized is None:
        normalized = normalize_arxiv_id(link)
    if normalized is None:
        return None, raw_id, link
    return normalized, raw_id, link


def parse_arxiv_entry(entry: Any, fetched_at: str | None = None, *, stream: str = "rss") -> dict[str, Any] | None:
    """Parse a feedparser entry or Atom ``<entry>`` into candidate data."""
    if isinstance(entry, ET.Element):
        fields = _element_entry_fields(entry)
    elif isinstance(entry, Mapping):
        fields = _feedparser_entry_fields(entry)
    else:
        return None
    native_id, raw_id, raw_link = _entry_native_id(entry)
    if native_id is None:
        native_id, raw_id, raw_link = fields["native_id"], fields["raw_id"], fields["raw_link"]
    if native_id is None:
        return None
    canonical_url = AcquisitionRuntime.canonical_url(_arxiv_url(native_id))
    if not canonical_url:
        return None
    title = fields.get("title") or _entry_text(entry, ("title",)) or None
    text = fields.get("text") or _entry_text(entry, ("summary", "description", "abstract")) or None
    published_at = fields.get("published_at") or _datetime_to_iso(_entry_value(entry, ("published_parsed", "updated_parsed")))
    updated_at = fields.get("updated_at") or _datetime_to_iso(_entry_value(entry, ("updated_parsed",)))
    author = fields.get("author") or _feedparser_author(entry)
    version = fields.get("version")
    if version is None:
        version = _version_from_text(raw_id or raw_link or "")
    metrics: dict[str, Any] = {}
    if updated_at:
        metrics["updated_at"] = updated_at
    if version is not None:
        metrics["version"] = version
    if fields.get("primary_category"):
        metrics["primary_category"] = fields["primary_category"]
    warnings: list[dict[str, str]] = []
    if published_at is None:
        warnings.append({"code": "missing_date", "message": "arXiv entry has no parseable date"})
    return {
        "native_id": native_id,
        "url": canonical_url,
        "source_type": "paper",
        "date_confidence": "exact" if published_at else "unknown",
        "fetched_at": fetched_at or "",
        "title": title,
        "author": author,
        "published_at": published_at,
        "text": text,
        "native_metrics": metrics,
        "provenance": {
            "stream": stream,
            "arxiv_url": canonical_url,
            "raw_id": raw_id,
        },
        "item_warnings": warnings,
    }


def is_relevant(tags: Any, title: Any, abstract: Any) -> bool:
    """Return whether a paper matches at least one configured semantic tag."""
    configured = tags if isinstance(tags, (list, tuple, set, frozenset)) else []
    semantic = sorted(
        {
            _as_text(tag).strip().lower()
            for tag in configured
            if _as_text(tag).strip().lower() and _as_text(tag).strip().lower() not in _BROAD_TAGS
        },
        key=lambda item: item.encode("utf-8"),
    )
    if not semantic:
        return True
    haystack = f"{_as_text(title)}\n{_as_text(abstract)}".lower()
    return any(tag in haystack for tag in semantic)


def sort_and_limit(items: list[dict[str, Any]], budget: int) -> list[dict[str, Any]]:
    """Sort by ``updated_at desc, native_id asc`` then apply ``budget``."""
    values = list(items)
    values.sort(key=lambda item: _as_text(item.get("native_id")).encode("utf-8"))
    values.sort(
        key=lambda item: _as_text((item.get("native_metrics") or {}).get("updated_at")),
        reverse=True,
    )
    return values[:budget]


def _feedparser_entry_fields(entry: Mapping[str, Any]) -> dict[str, Any]:
    published_at = (
        _datetime_to_iso(entry.get("published_parsed"))
        or _parse_iso(entry.get("published") or entry.get("pubDate"))
    )
    updated_at = _datetime_to_iso(entry.get("updated_parsed")) or published_at
    raw_id = entry.get("id") or entry.get("guid") or entry.get("link")
    normalized = normalize_arxiv_id(raw_id or entry.get("link"))
    raw_link = entry.get("link")
    return {
        "native_id": normalized,
        "raw_id": raw_id,
        "raw_link": raw_link,
        "title": _entry_text(entry, ("title",)),
        "author": _feedparser_author(entry),
        "published_at": published_at,
        "updated_at": updated_at,
        "text": _entry_text(entry, ("summary", "description", "abstract")),
        "version": _version_from_text(str(raw_id or raw_link or "")),
        "primary_category": _entry_text(entry, ("arxiv_primary_category",)),
    }


def _element_attr(element: ET.Element, name: str) -> str | None:
    return element.attrib.get(name) or None


def _element_text(element: ET.Element, tag: str) -> str | None:
    child = element.find(tag)
    if child is None:
        return None
    return _as_text(child.text) or None


def _element_author(element: ET.Element) -> str | None:
    names: list[str] = []
    for author in element.findall("author"):
        name = _element_text(author, "name")
        if name:
            names.append(name)
    return ", ".join(names) if names else None


def _element_entry_fields(element: ET.Element) -> dict[str, Any]:
    guid = _child_text(element, "guid")
    raw_id = _child_text(element, "id") or guid
    link = raw_id
    for child in _children(element, "link"):
        rel = (child.attrib.get("rel") or "alternate").lower()
        href = child.attrib.get("href") or _as_text(child.text)
        if href:
            if rel == "alternate" and "arxiv.org" in href:
                link = href
            elif not link:
                link = href
            elif "arxiv.org" not in link:
                link = href
    if not link:
        link = _child_text(element, "link")
    normalized = normalize_arxiv_id(raw_id or guid or link)
    title = _child_text(element, "title")
    abstract = (
        _child_text(element, "summary")
        or _child_text(element, "abstract")
        or _child_text(element, "description")
    )
    published_at = _parse_iso(
        _child_text(element, "published")
        or _child_text(element, "pubDate")
        or _child_text(element, "dc:date")
    )
    updated_at = _parse_iso(_child_text(element, "updated")) or published_at
    author_names: list[str] = []
    for author in _children(element, "author"):
        name = _child_text(author, "name") or _as_text(author.text)
        if name:
            author_names.append(name)
    direct_author = _child_text(element, "author") or _child_text(element, "creator")
    if direct_author and not author_names:
        author_names.append(direct_author)
    return {
        "native_id": normalized,
        "raw_id": raw_id,
        "raw_link": link,
        "title": title,
        "author": ", ".join(author_names) if author_names else None,
        "published_at": published_at,
        "updated_at": updated_at,
        "text": abstract,
        "version": _version_from_text(raw_id or link or ""),
        "primary_category": _child_text(element, "primary_category"),
    }


def _element_entries(body: Any) -> list[ET.Element]:
    if isinstance(body, ET.Element):
        root = body
    elif isinstance(body, (bytes, bytearray, str)):
        try:
            root = ET.fromstring(bytes(body) if isinstance(body, (bytes, bytearray)) else body)
        except ET.ParseError as exc:
            raise AdapterError("arXiv metadata XML drifted", status="schema-drift") from exc
    else:
        raise AdapterError("arXiv metadata response drifted", status="schema-drift")
    tag = root.tag.rsplit("}", 1)[-1].lower()
    if tag == "entry":
        return [root]
    if tag != "feed":
        raise AdapterError("arXiv metadata XML drifted", status="schema-drift")
    return _children(root, "entry")


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(element: ET.Element, *local_names: str) -> list[ET.Element]:
    return [
        child for child in list(element)
        if _local_name(child.tag) in local_names
    ]


def _child_text(element: ET.Element, *local_names: str) -> str | None:
    for child in _children(element, *local_names):
        value = _as_text(child.text)
        if value:
            return value
    return None


def _parse_xml_body(body: Any) -> ET.Element:
    if isinstance(body, ET.Element):
        return body
    if isinstance(body, bytes):
        try:
            return ET.fromstring(body)
        except ET.ParseError as exc:
            raise AdapterError("arXiv response is malformed XML", status="schema-drift") from exc
    if isinstance(body, str):
        try:
            return ET.fromstring(body)
        except ET.ParseError as exc:
            raise AdapterError("arXiv response is malformed XML", status="schema-drift") from exc
    raise AdapterError("arXiv response is not XML", status="schema-drift")


def _rss_entries(body: Any) -> list[ET.Element]:
    root = _parse_xml_body(body)
    name = _local_name(root.tag)
    if name == "rss":
        channel = next(iter(_children(root, "channel")), None)
        if channel is None:
            raise AdapterError("arXiv RSS channel is missing", status="schema-drift")
        return _children(channel, "item")
    if name == "feed":
        return _children(root, "entry")
    items = _children(root, "item")
    if items:
        return items
    entries = _children(root, "entry")
    if entries:
        return entries
    raise AdapterError("arXiv RSS response is not RSS or Atom", status="schema-drift")


def _clock_iso(clock: Callable[[], Any]) -> str:
    value = clock()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc)
    else:
        value = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc)
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _clock_date(clock: Callable[[], Any]) -> date:
    value = clock()
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()


def _window_bounds(request: dict[str, Any]) -> tuple[str | None, str | None]:
    window = request.get("window")
    if not isinstance(window, Mapping):
        return None, None
    return _parse_iso(window.get("start")), _parse_iso(window.get("end"))


def _in_window(candidate: Mapping[str, Any] | None, start: str | None, end: str | None) -> bool:
    if candidate is None:
        return False
    value = ((candidate.get("native_metrics") or {}).get("updated_at")
             or candidate.get("published_at"))
    if value is None:
        return start is None and end is None
    if start is not None and value < start:
        return False
    if end is not None and value > end:
        return False
    return True


def _checkpoint(
    now: str,
    window_end: str,
    recent: list[str],
    *,
    cursor: Any = None,
    etag: str | None = None,
    last_modified: str | None = None,
) -> dict[str, Any]:
    return {
        "successful_window_end": window_end,
        "cursor": cursor,
        "etag": etag,
        "last_modified": last_modified,
        "recent_native_ids": recent[:MAX_RECENT_NATIVE_IDS],
        "checkpoint_at": now,
    }


def _recent_ids(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in value if type(item) is str and item]
    if isinstance(value, tuple):
        return [item for item in value if type(item) is str and item]
    return []


def _dedupe_data(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for value in values:
        native_id = value.get("native_id")
        if native_id:
            output.setdefault(native_id, value)
    return list(output.values())


class ArxivAdapter:
    adapter_id = "arxiv"
    adapter_version = "0.4.0"

    def __init__(
        self,
        resolve_source: Callable[[str], Any],
        http_client: HttpClient | None = None,
        clock: Callable[[], Any] | None = None,
        sleeper: Callable[[float], Any] | None = None,
        checkpoint_resolver: Callable[[str], Mapping[str, Any] | None] | None = None,
    ) -> None:
        self._resolve = resolve_source
        self._http = http_client or HttpClient()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._sleeper = sleeper or time.sleep
        self._checkpoints = checkpoint_resolver or (lambda _source: None)
        self._metadata_cache: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}

    def availability_probe(self) -> str:
        return "ok"

    def validate_request(self, request: dict[str, Any]) -> None:
        if type(request) is not dict or request.get("mode") not in _MODES:
            raise AdapterError("request.mode is invalid", status="error")
        allowed = {"mode", "topic", "subject", "window"}
        if set(request) - allowed:
            raise AdapterError("request contains unsupported fields", status="error")
        window = request.get("window")
        if window is not None and (
            type(window) is not dict or set(window) != {"start", "end"}
        ):
            raise AdapterError("request.window is invalid", status="error")
        if isinstance(window, dict):
            parsed: dict[str, datetime] = {}
            for field in ("start", "end"):
                value = window[field]
                if value is None:
                    continue
                instant = _parse_iso(value)
                if instant is None:
                    raise AdapterError("request.window is invalid", status="error")
                parsed[field] = datetime.fromisoformat(instant.replace("Z", "+00:00"))
            if "start" in parsed and "end" in parsed and parsed["start"] > parsed["end"]:
                raise AdapterError("request.window is invalid", status="error")

    def collect(self, source: str, request: dict[str, Any]) -> SourceResult:
        self.validate_request(request)
        config = self._config(source)
        streams = self._streams(source)
        budget = config["budget"]
        inp = config["input"]
        now = _clock_iso(self._clock)
        window_start, window_end = _window_bounds(request)

        candidates: list[SourceCandidate] = []
        failures: list[dict[str, str]] = []
        updates: list[CheckpointUpdate] = []

        selected, rss_update, rss_failure = self._collect_rss(
            config, streams, budget, now, window_start, window_end,
        )
        if rss_failure is not None:
            failures.append(rss_failure)
        if rss_update is not None:
            updates.append(rss_update)

        if selected:
            needed = [value for value in selected if _metadata_needed(value)]
            if needed:
                metadata_map, metadata_update, metadata_failure = self._collect_metadata(
                    source, config, streams, needed, now, window_end,
                )
                if metadata_failure is not None:
                    failures.append(metadata_failure)
                if metadata_update is not None:
                    updates.append(metadata_update)
                if metadata_map:
                    selected = [_merge_metadata(value, metadata_map.get(value["native_id"])) for value in selected]

        selected = sort_and_limit(selected, budget)
        candidates = [_to_candidate(value) for value in selected]
        status, code, message = self._status(failures, candidates)
        return SourceResult(
            self.adapter_id,
            self.adapter_version,
            source,
            status,
            candidates=tuple(candidates),
            code=code,
            message=message,
            retryable=status in {"partial", "rate-limited", "timeout", "unreachable"},
            request=request,
            checkpoint_updates=tuple(updates),
        )

    def _collect_rss(
        self,
        config: dict[str, Any],
        streams: Mapping[str, Any],
        budget: int,
        now: str,
        window_start: str | None,
        window_end: str | None,
    ) -> tuple[list[dict[str, Any]], CheckpointUpdate | None, dict[str, str] | None]:
        previous = streams.get("rss")
        previous = previous if isinstance(previous, Mapping) else None
        previous_recent = _recent_ids(previous.get("recent_native_ids")) if previous else []
        etag = previous.get("etag") if previous else None
        last_modified = previous.get("last_modified") if previous else None
        headers: dict[str, str] = {}
        if type(etag) is str and etag:
            headers["If-None-Match"] = etag
        if type(last_modified) is str and last_modified:
            headers["If-Modified-Since"] = last_modified

        try:
            response = self._http.get(
                config["input"]["rss_url"],
                allowed_hosts={_RSS_HOST},
                allowed_paths={_RSS_PATH_PREFIX},
                headers=headers or None,
            )
        except AdapterError as exc:
            return [], None, {
                "stream": "rss",
                "status": exc.status,
                "message": exc.args[0],
            }

        if response.status == 304:
            recent = previous_recent
            checkpoint = _checkpoint(
                now,
                window_end or now,
                recent,
                etag=response.etag if type(response.etag) is str else etag,
                last_modified=response.last_modified if type(response.last_modified) is str else last_modified,
            )
            return [], CheckpointUpdate(
                "rss",
                previous.get("checkpoint_at") if previous else None,
                checkpoint,
            ), None

        try:
            raw: list[dict[str, Any]] = []
            for entry in _rss_entries(response.body):
                value = parse_arxiv_entry(entry, now, stream="rss")
                if value is None:
                    continue
                if not is_relevant(config["input"].get("tags"), value.get("title"), value.get("text")):
                    continue
                if not _in_window(value, window_start, window_end):
                    continue
                raw.append(value)
        except AdapterError as exc:
            return [], None, {
                "stream": "rss",
                "status": exc.status,
                "message": exc.args[0],
            }

        selected = sort_and_limit(_dedupe_data(raw), budget)
        recent = list(dict.fromkeys(
            [value["native_id"] for value in selected if value.get("native_id")] + previous_recent
        ))[:MAX_RECENT_NATIVE_IDS]
        checkpoint = _checkpoint(
            now,
            window_end or now,
            recent,
            etag=response.etag if type(response.etag) is str else None,
            last_modified=response.last_modified if type(response.last_modified) is str else None,
        )
        return selected, CheckpointUpdate(
            "rss",
            previous.get("checkpoint_at") if previous else None,
            checkpoint,
        ), None

    def _collect_metadata(
        self,
        source: str,
        config: dict[str, Any],
        streams: Mapping[str, Any],
        needed: list[dict[str, Any]],
        now: str,
        window_end: str | None,
    ) -> tuple[dict[str, dict[str, Any]], CheckpointUpdate | None, dict[str, str] | None]:
        previous = streams.get("metadata")
        previous = previous if isinstance(previous, Mapping) else None
        previous_recent = _recent_ids(previous.get("recent_native_ids")) if previous else []
        query_day = _clock_date(self._clock).isoformat()
        cache_key = (source, query_day)
        cached = self._metadata_cache.get(cache_key)

        if cached is not None:
            metadata_map = dict(cached)
        else:
            self._sleeper(3.0)
            try:
                response = self._http.get(
                    _metadata_url([value["native_id"] for value in needed]),
                    allowed_hosts={_METADATA_HOST},
                    allowed_paths={_METADATA_PATH_PREFIX},
                )
            except AdapterError as exc:
                return {}, None, {
                    "stream": "metadata",
                    "status": exc.status,
                    "message": exc.args[0],
                }
            metadata_map = {}
            for entry in _element_entries(response.body):
                value = parse_arxiv_entry(entry, now, stream="metadata")
                if value is not None and value.get("native_id"):
                    metadata_map[value["native_id"]] = value
            self._metadata_cache[cache_key] = dict(metadata_map)

        recent = list(dict.fromkeys(
            list(metadata_map) + previous_recent
        ))[:MAX_RECENT_NATIVE_IDS]
        checkpoint = _checkpoint(
            now,
            window_end or now,
            recent,
            cursor={"query_day": query_day},
        )
        update = CheckpointUpdate(
            "metadata",
            previous.get("checkpoint_at") if previous else None,
            checkpoint,
        )
        return metadata_map, update, None

    def _config(self, source: str) -> dict[str, Any]:
        value = self._resolve(source)
        if type(value) is not dict or value.get("id") != source or value.get("adapter") != self.adapter_id:
            raise AdapterError("arXiv source configuration is unavailable", status="skipped-unconfigured")
        inp = value.get("input")
        if type(inp) is not dict or set(inp) != _INPUT_FIELDS:
            raise AdapterError("arXiv source input is invalid", status="schema-drift")
        if type(value.get("budget")) is not int or not 1 <= value["budget"] <= 1000:
            raise AdapterError("arXiv source budget is invalid", status="schema-drift")
        _validate_allowed_url(inp["rss_url"], _RSS_HOST, _RSS_PATH_PREFIX, "rss_url")
        _validate_allowed_url(inp["url"], "arxiv.org", "/list", "url")
        tags = inp.get("tags")
        if tags is not None and not isinstance(tags, (list, tuple)):
            raise AdapterError("arXiv source tags are invalid", status="schema-drift")
        return value

    def _streams(self, source: str) -> Mapping[str, Any]:
        state = self._checkpoints(source)
        if not isinstance(state, Mapping):
            return {}
        streams = state.get("streams")
        return streams if isinstance(streams, Mapping) else {}

    @staticmethod
    def _status(
        failures: list[dict[str, str]],
        candidates: list[SourceCandidate],
    ) -> tuple[str, str | None, str | None]:
        if not failures:
            return ("ok" if candidates else "no-results"), None, None
        if candidates:
            return "partial", "arxiv-partial", "arXiv streams partially failed"
        statuses = {failure["status"] for failure in failures}
        status = next(iter(statuses)) if len(statuses) == 1 else "error"
        return status, "arxiv-stream-failed", failures[0]["message"]


def _metadata_needed(value: Mapping[str, Any]) -> bool:
    metrics = value.get("native_metrics") or {}
    return any(value.get(field) in (None, "") for field in ("title", "author", "published_at", "text")) or (
        "updated_at" not in metrics or metrics.get("version") is None
    )


def _merge_metadata(base: dict[str, Any], metadata: Mapping[str, Any] | None) -> dict[str, Any]:
    if metadata is None:
        return base
    merged = dict(base)
    for field in ("title", "author", "published_at", "text"):
        metadata_value = metadata.get(field)
        if metadata_value not in (None, ""):
            merged[field] = metadata_value
    metrics = dict(merged.get("native_metrics") or {})
    for field in ("updated_at", "version", "primary_category"):
        if field not in metrics and field in (metadata.get("native_metrics") or {}):
            metrics[field] = metadata["native_metrics"][field]
    merged["native_metrics"] = metrics
    provenance = dict(merged.get("provenance") or {})
    metadata_url = (metadata.get("provenance") or {}).get("arxiv_url")
    if metadata_url and not provenance.get("metadata_arxiv_url"):
        provenance["metadata_arxiv_url"] = metadata_url
    merged["provenance"] = provenance
    return merged


def _to_candidate(value: Mapping[str, Any]) -> SourceCandidate:
    return SourceCandidate(
        native_id=value["native_id"],
        url=value["url"],
        source_type=value.get("source_type") or "paper",
        date_confidence=value.get("date_confidence") or "unknown",
        fetched_at=value.get("fetched_at") or "",
        title=value.get("title"),
        author=value.get("author"),
        published_at=value.get("published_at"),
        text=value.get("text"),
        native_metrics=dict(value.get("native_metrics") or {}),
        provenance=dict(value.get("provenance") or {}),
        item_warnings=list(value.get("item_warnings") or []),
    )


def _metadata_url(native_ids: list[str]) -> str:
    id_list = ",".join(
        value.split(":", 1)[1] if value.startswith("arxiv:") else value
        for value in native_ids
    )
    return f"{_METADATA_QUERY_URL}?{urlencode({'id_list': id_list})}"


def _validate_allowed_url(value: Any, host: str, path_prefix: str, label: str) -> None:
    if type(value) is not str:
        raise AdapterError(f"arXiv source {label} is invalid", status="schema-drift")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise AdapterError(f"arXiv source {label} is invalid", status="schema-drift") from exc
    if parsed.scheme != "https" or parsed.hostname != host:
        raise AdapterError(f"arXiv source {label} is invalid", status="schema-drift")
    if parsed.port not in (None, 443):
        raise AdapterError(f"arXiv source {label} is invalid", status="schema-drift")
    if not (parsed.path or "/").startswith(path_prefix):
        raise AdapterError(f"arXiv source {label} is invalid", status="schema-drift")
