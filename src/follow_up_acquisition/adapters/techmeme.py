"""Bounded keyless Techmeme acquisition adapter.

Techmeme's public HTML is read-only content and is not available as a stable
JSON API. This adapter parses only the public front page and one dated archive
snapshot, extracts lead-story links, and never executes embedded scripts.
"""

from __future__ import annotations

import hashlib
import re
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Callable, Mapping

from ..http_client import HttpClient
from ..runtime import AcquisitionRuntime, AdapterError, CheckpointUpdate, SourceCandidate, SourceResult
from ..source_state import MAX_RECENT_NATIVE_IDS

_MODES = {"central", "shadow", "hybrid", "local"}
_TECHMEME_HOST = "www.techmeme.com"
_FRONT_URL = f"https://{_TECHMEME_HOST}/"
_ARCHIVE_TEMPLATE = f"https://{_TECHMEME_HOST}/{{snapshot}}"
_INPUT_FIELDS = frozenset({"front_url", "archive_url_template"})
_VOID_ELEMENTS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
})
_RELATED_CLASSES = frozenset({"bls", "di", "drhed", "dbpt"})
_PGRDAD_RE = re.compile(r"pgrdad\s*=\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)
_META_EAD_RE = re.compile(
    r"<meta\b[^>]*\bname\s*=\s*['\"]m2_ead['\"][^>]*\bcontent\s*=\s*['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)


def _now_iso(clock: Callable[[], Any]) -> str:
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


def _parse_iso(value: Any) -> str | None:
    if type(value) is not str or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _window_bounds(request: dict[str, Any]) -> tuple[str | None, str | None]:
    window = request.get("window")
    if not isinstance(window, Mapping):
        return None, None
    return _parse_iso(window.get("start")), _parse_iso(window.get("end"))


def _in_window(published_at: str | None, start: str | None, end: str | None) -> bool:
    if published_at is None:
        return start is None and end is None
    if start is not None and published_at < start:
        return False
    if end is not None and published_at > end:
        return False
    return True


def _clock_date(clock: Callable[[], Any]) -> date:
    value = clock()
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()


def _parse_date(value: Any) -> date | None:
    if type(value) is not str:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _date_to_snapshot(value: str) -> str:
    parsed = _parse_date(value)
    if parsed is None:
        raise AdapterError("Techmeme archive processing date is invalid", status="schema-drift")
    return f"{parsed.strftime('%y%m%d')}/h2000"


def _next_date(value: str) -> str:
    parsed = _parse_date(value)
    if parsed is None:
        raise AdapterError("Techmeme archive processing date is invalid", status="schema-drift")
    return (parsed + timedelta(days=1)).isoformat()


def _body_text(body: Any) -> str:
    if isinstance(body, str):
        return body
    if isinstance(body, bytes):
        try:
            return body.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AdapterError("Techmeme response is not UTF-8 HTML", status="schema-drift") from exc
    raise AdapterError("Techmeme response is not HTML text", status="schema-drift")


def _parse_pgrdad(text: str) -> str | None:
    match = _PGRDAD_RE.search(text)
    if match is None:
        return None
    value = match.group(1).strip()
    try:
        parsed = datetime.strptime(value, "%B %d, %Y, %I:%M %p")
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_meta_ead(text: str) -> str | None:
    match = _META_EAD_RE.search(text)
    if match is None:
        return None
    value = match.group(1).strip()
    if len(value) < 6:
        return None
    day = value[:6]
    hour_match = re.search(r"h(\d{1,2})", value, re.IGNORECASE)
    hour = 0
    if hour_match is not None:
        try:
            hour = int(hour_match.group(1))
        except ValueError:
            return None
    try:
        parsed = datetime.strptime(day, "%y%m%d")
    except ValueError:
        return None
    if not 0 <= hour <= 23:
        return None
    return parsed.replace(hour=hour, tzinfo=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _snapshot_time(snapshot: str | None) -> str | None:
    if snapshot is None:
        return None
    match = re.match(r"^(\d{6})/h(\d{2})(?:\d{2})?$", snapshot)
    if match is None:
        return None
    try:
        parsed = datetime.strptime(match.group(1), "%y%m%d")
        hour = int(match.group(2))
    except (ValueError, IndexError):
        return None
    if not 0 <= hour <= 23:
        return None
    return parsed.replace(hour=hour, tzinfo=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _page_time(text: str, snapshot: str | None) -> tuple[str | None, str]:
    pgrdad = _parse_pgrdad(text)
    if pgrdad is not None:
        return pgrdad, "inferred"
    meta = _parse_meta_ead(text)
    if meta is not None:
        return meta, "inferred"
    snapshot_time = _snapshot_time(snapshot)
    if snapshot_time is not None:
        return snapshot_time, "inferred"
    return None, "unknown"


class _Node:
    __slots__ = ("tag", "attrs", "children", "text")

    def __init__(self, tag: str, attrs: Mapping[str, str]) -> None:
        self.tag = tag
        self.attrs = attrs
        self.children: list[_Node] = []
        self.text = ""


class _TechmemeHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root", {})
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = _Node(tag.lower(), {str(key).lower(): str(value) for key, value in attrs})
        self.stack[-1].children.append(node)
        if node.tag not in _VOID_ELEMENTS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = _Node(tag.lower(), {str(key).lower(): str(value) for key, value in attrs})
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == lowered:
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        self.stack[-1].text += data


def _parse_html(text: str) -> _Node:
    parser = _TechmemeHtmlParser()
    try:
        parser.feed(text)
    except Exception as exc:  # HTMLParser is an untrusted input boundary.
        raise AdapterError("Techmeme response could not be parsed", status="schema-drift") from exc
    parser.close()
    return parser.root


def _walk(node: _Node, predicate: Callable[[_Node], bool], output: list[_Node] | None = None) -> list[_Node]:
    output = [] if output is None else output
    if predicate(node):
        output.append(node)
    for child in node.children:
        _walk(child, predicate, output)
    return output


def _node_text(node: _Node) -> str:
    parts = [node.text]
    for child in node.children:
        parts.append(_node_text(child))
    return " ".join(" ".join(parts).split())


def _has_class(node: _Node, names: set[str] | frozenset[str]) -> bool:
    classes = set((node.attrs.get("class") or "").lower().split())
    return bool(classes & names)


def _lead_link(cluster: _Node) -> _Node | None:
    for node in _walk(cluster, lambda item: item.tag == "a" and _has_class(item, {"ourh"})):
        href = (node.attrs.get("href") or "").strip()
        if href:
            return node
    return None


def _identity_from_cluster(cluster: _Node, lead: _Node, page_date: str, lead_url: str) -> str:
    for node in _walk(cluster, lambda item: item.tag == "a"):
        name = (node.attrs.get("name") or "").strip()
        if name:
            return name[1:] if name.startswith("a") else name
    for node in _walk(cluster, lambda item: item.tag == "div" and _has_class(item, {"itc2"})):
        identity = (node.attrs.get("id") or "").strip()
        if identity:
            return identity
    digest = hashlib.sha256(f"{page_date}\n{lead_url}".encode("utf-8")).hexdigest()
    return f"tm-{digest[:24]}"


def _related_links(cluster: _Node) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()

    def visit(node: _Node, ancestors: tuple[_Node, ...]) -> None:
        is_container = _has_class(node, _RELATED_CLASSES)
        if node.tag == "a":
            href = (node.attrs.get("href") or "").strip()
            if href and (is_container or any(_has_class(item, _RELATED_CLASSES) for item in ancestors)):
                canonical = AcquisitionRuntime.canonical_url(href)
                if canonical and canonical not in seen:
                    seen.add(canonical)
                    links.append(canonical)
        next_ancestors = ancestors + (node,) if is_container else ancestors
        for child in node.children:
            visit(child, next_ancestors)

    visit(cluster, ())
    return links


class TechmemeAdapter:
    adapter_id = "techmeme"
    adapter_version = "0.4.0"

    def __init__(
        self,
        resolve_source: Callable[[str], Any],
        http_client: HttpClient | None = None,
        clock: Callable[[], Any] | None = None,
        checkpoint_resolver: Callable[[str], Mapping[str, Any] | None] | None = None,
    ) -> None:
        self._resolve = resolve_source
        self._http = http_client or HttpClient()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._checkpoints = checkpoint_resolver or (lambda _source: None)

    def availability_probe(self) -> str:
        return "ok"

    def validate_request(self, request: dict[str, Any]) -> None:
        if type(request) is not dict or request.get("mode") not in _MODES:
            raise AdapterError("request.mode is invalid", status="error")
        if set(request) - {"mode", "topic", "subject", "window", "depth"}:
            raise AdapterError("request contains unsupported fields", status="error")
        if request.get("depth") is not None and (
            type(request["depth"]) is not int or not 1 <= request["depth"] <= 10
        ):
            raise AdapterError("request.depth is invalid", status="error")
        if request.get("window") is not None and (
            type(request["window"]) is not dict or set(request["window"]) != {"start", "end"}
        ):
            raise AdapterError("request.window is invalid", status="error")
        window = request.get("window")
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
        now = _now_iso(self._clock)
        streams = self._streams(source)
        budget = config["budget"]
        window_start, window_end = _window_bounds(request)

        candidates: list[SourceCandidate] = []
        failures: list[dict[str, str]] = []
        updates: list[CheckpointUpdate] = []

        for stream in ("front", "archive"):
            try:
                outcome = self._collect_stream(
                    stream, config, streams, budget, now, window_start, window_end,
                )
            except AdapterError as exc:
                failures.append({
                    "stream": stream,
                    "status": exc.status,
                    "message": exc.args[0] if exc.args else "Techmeme stream failed",
                })
                continue
            candidates.extend(outcome[0])
            if outcome[1] is not None:
                updates.append(outcome[1])

        candidates = self._finalize(candidates, budget)
        status, code, message = self._status(failures, candidates)
        return SourceResult(
            self.adapter_id, self.adapter_version, source, status,
            candidates=tuple(candidates), code=code, message=message,
            retryable=status in {"partial", "rate-limited", "timeout", "unreachable"},
            request=request, checkpoint_updates=tuple(updates),
        )

    def _config(self, source: str) -> dict[str, Any]:
        value = self._resolve(source)
        if type(value) is not dict or value.get("id") != source or value.get("adapter") != "techmeme":
            raise AdapterError("Techmeme source configuration is unavailable", status="skipped-unconfigured")
        inp = value.get("input")
        if type(inp) is not dict or set(inp) != _INPUT_FIELDS:
            raise AdapterError("Techmeme source input is invalid", status="schema-drift")
        if type(value.get("budget")) is not int or not 1 <= value["budget"] <= 1000:
            raise AdapterError("Techmeme source budget is invalid", status="schema-drift")
        if inp["front_url"] != _FRONT_URL or inp["archive_url_template"] != _ARCHIVE_TEMPLATE:
            raise AdapterError("Techmeme source endpoint is invalid", status="schema-drift")
        return value

    def _streams(self, source: str) -> Mapping[str, Any]:
        state = self._checkpoints(source)
        if state is None:
            return {}
        if not isinstance(state, Mapping) or not isinstance(state.get("streams"), Mapping):
            raise AdapterError("Techmeme checkpoint state is invalid", status="schema-drift")
        return state["streams"]

    def _collect_stream(
        self,
        stream: str,
        config: dict[str, Any],
        streams: Mapping[str, Any],
        budget: int,
        now: str,
        window_start: str | None,
        window_end: str | None,
    ) -> tuple[list[SourceCandidate], CheckpointUpdate | None]:
        previous = streams.get(stream)
        previous = previous if isinstance(previous, Mapping) else None
        seen = set(previous.get("recent_native_ids", ())) if previous else set()
        inp = config["input"]
        if stream == "front":
            page_url = inp["front_url"]
            snapshot = None
            cursor: dict[str, Any] = {"window_end": window_end or now}
        else:
            previous_cursor = previous.get("cursor") if previous else None
            previous_cursor = previous_cursor if isinstance(previous_cursor, Mapping) else {}
            processing = previous_cursor.get("current_processing_date")
            processing = processing if type(processing) is str else (
                _clock_date(self._clock) - timedelta(days=1)
            ).isoformat()
            snapshot = _date_to_snapshot(processing)
            page_url = inp["archive_url_template"].replace("{snapshot}", snapshot)
            cursor = {
                "current_processing_date": _next_date(processing),
                "complete_dates": self._completed_dates(previous_cursor, processing),
            }

        response = self._fetch(page_url)
        text = _body_text(response.body)
        page_date = processing if stream == "archive" else _clock_date(self._clock).isoformat()
        page_time, confidence = _page_time(text, snapshot)
        clusters = self._clusters(text, page_url)
        raw_candidates = [
            self._map_cluster(cluster, stream, page_url, page_date, page_time, confidence, now, rank)
            for rank, cluster in enumerate(clusters, start=1)
        ]
        stream_candidates = [
            candidate for candidate in raw_candidates
            if candidate is not None and _in_window(candidate.published_at, window_start, window_end)
        ]
        stream_candidates = self._finalize(stream_candidates, budget)
        recent = list(dict.fromkeys(
            [candidate.native_id for candidate in stream_candidates if candidate.native_id] + list(seen)
        ))[:MAX_RECENT_NATIVE_IDS]
        checkpoint = {
            "successful_window_end": window_end or now,
            "cursor": cursor,
            "etag": None,
            "last_modified": None,
            "recent_native_ids": recent,
            "checkpoint_at": now,
        }
        return stream_candidates, CheckpointUpdate(
            stream, previous.get("checkpoint_at") if previous else None, checkpoint,
        )

    @staticmethod
    def _completed_dates(previous: Mapping[str, Any], processing: str) -> list[str]:
        values = previous.get("complete_dates")
        values = list(values) if isinstance(values, list) else []
        values = [value for value in values if type(value) is str and _parse_date(value) is not None]
        values.append(processing)
        return sorted(set(values), key=lambda value: value.encode("utf-8"))[-14:]

    def _fetch(self, page_url: str) -> Any:
        return self._http.get(
            page_url,
            allowed_hosts={_TECHMEME_HOST},
            allowed_paths={"/"},
        )

    @staticmethod
    def _clusters(text: str, page_url: str) -> list[_Node]:
        root = _parse_html(text)
        has_meta_ead = bool(_META_EAD_RE.search(text))
        has_title = any(
            node.tag == "title" and "techmeme" in _node_text(node).lower()
            for node in _walk(root, lambda _item: True)
        )
        clusters = _walk(root, lambda item: item.tag == "div" and _has_class(item, {"clus"}))
        if not clusters and not has_meta_ead and not has_title:
            raise AdapterError("Techmeme layout is unrecognized", status="schema-drift")
        return clusters

    def _map_cluster(
        self,
        cluster: _Node,
        stream: str,
        page_url: str,
        page_date: str,
        page_time: str | None,
        confidence: str,
        fetched_at: str,
        rank: int,
    ) -> SourceCandidate | None:
        lead = _lead_link(cluster)
        if lead is None:
            return None
        href = (lead.attrs.get("href") or "").strip()
        if not href:
            return None
        url = AcquisitionRuntime.canonical_url(href)
        if not url:
            return None
        title = _node_text(lead).strip() or None
        anchor = ""
        for node in _walk(cluster, lambda item: item.tag == "a"):
            anchor = (node.attrs.get("name") or "").strip()
            if anchor:
                break
        cluster_url = f"{page_url}#{anchor}" if anchor else page_url
        identity = _identity_from_cluster(cluster, lead, page_date, url)
        warnings = [] if page_time is not None else [{
            "code": "missing_date",
            "message": "Techmeme story has no parseable page date",
        }]
        return SourceCandidate(
            native_id=identity,
            url=url,
            source_type="story",
            date_confidence=confidence,
            fetched_at=fetched_at,
            title=title,
            author=None,
            published_at=page_time,
            text=None,
            native_metrics={"rank": rank},
            provenance={
                "stream": stream,
                "techmeme_url": page_url,
                "cluster_url": cluster_url,
                "related_links": _related_links(cluster),
                "rank": rank,
            },
            item_warnings=warnings,
        )

    @staticmethod
    def _finalize(values: list[SourceCandidate], budget: int) -> list[SourceCandidate]:
        unique: dict[str, SourceCandidate] = {}
        for value in values:
            unique.setdefault(value.native_id, value)
        return list(unique.values())[:budget]

    @staticmethod
    def _status(failures: list[dict[str, str]], candidates: list[SourceCandidate]) -> tuple[str, str | None, str | None]:
        if not failures:
            return ("ok" if candidates else "no-results"), None, None
        if len(failures) < 2:
            return "partial", "techmeme-partial", "Techmeme streams partially failed"
        statuses = {failure["status"] for failure in failures}
        status = next(iter(statuses)) if len(statuses) == 1 else "error"
        return status, "techmeme-stream-failed", failures[0]["message"]


__all__ = ["TechmemeAdapter"]
