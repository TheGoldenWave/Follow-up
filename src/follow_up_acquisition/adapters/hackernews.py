"""Bounded Hacker News acquisition adapter.

The adapter uses the public Firebase REST API for ``top`` and ``new`` item
streams and Algolia's public search endpoint for user-defined query streams.
It deliberately fetches only story metadata; comments are not downloaded.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from urllib.parse import urlencode

from ..http_client import HttpClient
from ..runtime import AcquisitionRuntime, AdapterError, CheckpointUpdate, SourceCandidate, SourceResult
from ..source_state import MAX_RECENT_NATIVE_IDS, query_fingerprint

_MODES = {"central", "shadow", "hybrid", "local"}
_FIREBASE_HOST = "hacker-news.firebaseio.com"
_ALGOLIA_HOST = "hn.algolia.com"
_FIREBASE_BASE = f"https://{_FIREBASE_HOST}/v0"
_ALGOLIA_BASE = f"https://{_ALGOLIA_HOST}/api/v1"


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


def _parse_time(value: Any) -> str | None:
    if type(value) is not int or value < 0:
        return None
    try:
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def _parse_iso(value: Any) -> str | None:
    if type(value) is not str:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _window_bounds(request: dict[str, Any], now: str) -> tuple[str | None, str]:
    window = request.get("window")
    if not isinstance(window, Mapping):
        return None, now
    start = _parse_iso(window.get("start"))
    end = _parse_iso(window.get("end")) or now
    return start, end


def _in_window(published_at: str | None, start: str | None, end: str | None) -> bool:
    if published_at is None:
        return False
    if start is not None and published_at < start:
        return False
    if end is not None and published_at > end:
        return False
    return True


def _checkpoint(now: str, window_end: str, recent: list[str], cursor: Any, fingerprint: str | None) -> dict[str, Any]:
    value = {
        "successful_window_end": window_end,
        "cursor": cursor,
        "etag": None,
        "last_modified": None,
        "recent_native_ids": recent[:MAX_RECENT_NATIVE_IDS],
        "checkpoint_at": now,
    }
    if fingerprint:
        value["query_fingerprint"] = fingerprint
    return value


def _stream_ids(candidates: list[SourceCandidate]) -> list[str]:
    return [candidate.native_id for candidate in candidates if candidate.native_id]


class HackerNewsAdapter:
    adapter_id = "hackernews"
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
        inp = config["input"]
        window_start, window_end = _window_bounds(request, now)

        candidates: list[SourceCandidate] = []
        failures: list[dict[str, str]] = []
        updates: list[CheckpointUpdate] = []

        if inp["top_enabled"]:
            outcome = self._collect_item_stream(
                "top", config, streams, budget, now, window_start, window_end,
            )
            candidates.extend(outcome[0])
            failures.extend(outcome[1])
            if outcome[2] is not None:
                updates.append(outcome[2])

        if inp["new_enabled"]:
            outcome = self._collect_item_stream(
                "new", config, streams, budget, now, window_start, window_end,
            )
            candidates.extend(outcome[0])
            failures.extend(outcome[1])
            if outcome[2] is not None:
                updates.append(outcome[2])

        for query in sorted(inp["queries"], key=lambda value: value["id"].encode()):
            outcome = self._collect_search(
                query, config, streams, budget, now, window_start, window_end,
            )
            candidates.extend(outcome[0])
            failures.extend(outcome[1])
            if outcome[2] is not None:
                updates.append(outcome[2])

        candidates = self._finalize(candidates, budget)
        status, code, message = self._status(failures, candidates)
        return SourceResult(
            self.adapter_id, self.adapter_version, source, status,
            candidates=tuple(candidates), code=code, message=message,
            retryable=status in {"partial", "rate-limited", "timeout", "unreachable"},
            request=request, checkpoint_updates=tuple(updates),
        )

    def _collect_item_stream(
        self,
        stream: str,
        config: dict[str, Any],
        streams: Mapping[str, Any],
        budget: int,
        now: str,
        window_start: str | None,
        window_end: str,
    ) -> tuple[list[SourceCandidate], list[dict[str, str]], CheckpointUpdate | None]:
        previous = streams.get(stream)
        previous = previous if isinstance(previous, Mapping) else None
        seen = set(previous.get("recent_native_ids", ())) if previous else set()
        try:
            ids = self._fetch_ids(stream, config["input"]["firebase_url"])
        except AdapterError as exc:
            return [], [{"stream": stream, "status": exc.status, "message": exc.args[0]}], None

        stream_candidates: list[SourceCandidate] = []
        seen_in_stream: set[str] = set()
        for item_id in ids:
            native_id = str(item_id)
            if native_id in seen or native_id in seen_in_stream:
                continue
            if len(stream_candidates) >= budget:
                break
            try:
                item = self._fetch_item(native_id, config["input"]["firebase_url"])
                candidate = self._map_item(item, stream, now, len(stream_candidates) + 1)
            except AdapterError as exc:
                return [], [{"stream": stream, "status": exc.status, "message": exc.args[0]}], None
            if candidate is not None:
                if _in_window(candidate.published_at, window_start, window_end):
                    stream_candidates.append(candidate)
                    seen_in_stream.add(native_id)

        recent = list(dict.fromkeys(_stream_ids(stream_candidates) + list(seen)))[:MAX_RECENT_NATIVE_IDS]
        checkpoint = _checkpoint(now, window_end, recent, {"last_seen_id": ids[0] if ids else None}, None)
        return stream_candidates, [], CheckpointUpdate(stream, previous.get("checkpoint_at") if previous else None, checkpoint)

    def _collect_search(
        self,
        query: Mapping[str, Any],
        config: dict[str, Any],
        streams: Mapping[str, Any],
        budget: int,
        now: str,
        window_start: str | None,
        window_end: str,
    ) -> tuple[list[SourceCandidate], list[dict[str, str]], CheckpointUpdate | None]:
        stream_id = f"search.{query['id']}"
        previous = streams.get(stream_id)
        previous = previous if isinstance(previous, Mapping) else None
        seen = set(previous.get("recent_native_ids", ())) if previous else set()
        fingerprint = query_fingerprint("hackernews", query)
        if previous is not None and previous.get("query_fingerprint") != fingerprint:
            return [], [{
                "stream": stream_id, "status": "schema-drift",
                "message": "Hacker News query fingerprint changed",
            }], None
        try:
            hits = self._search(
                query, config["input"]["algolia_url"], budget, window_start, window_end,
            )
        except AdapterError as exc:
            return [], [{"stream": stream_id, "status": exc.status, "message": exc.args[0]}], None

        stream_candidates: list[SourceCandidate] = []
        for hit in hits:
            candidate = self._map_hit(hit, query, now)
            if (
                candidate is not None
                and candidate.native_id not in seen
                and _in_window(candidate.published_at, window_start, window_end)
            ):
                stream_candidates.append(candidate)
        stream_candidates = self._finalize(stream_candidates, budget, query.get("sort", "date"))
        recent = list(dict.fromkeys(_stream_ids(stream_candidates) + list(seen)))[:MAX_RECENT_NATIVE_IDS]
        checkpoint = _checkpoint(now, window_end, recent, {"window_end": window_end}, fingerprint)
        return stream_candidates, [], CheckpointUpdate(stream_id, previous.get("checkpoint_at") if previous else None, checkpoint)

    def _config(self, source: str) -> dict[str, Any]:
        value = self._resolve(source)
        if type(value) is not dict or value.get("id") != source or value.get("adapter") != "hackernews":
            raise AdapterError("Hacker News source configuration is unavailable", status="skipped-unconfigured")
        inp = value.get("input")
        if type(inp) is not dict or set(inp) != {"firebase_url", "algolia_url", "top_enabled", "new_enabled", "queries"}:
            raise AdapterError("Hacker News source input is invalid", status="schema-drift")
        if inp.get("firebase_url") != _FIREBASE_BASE or inp.get("algolia_url") != _ALGOLIA_BASE:
            raise AdapterError("Hacker News source endpoint is invalid", status="schema-drift")
        if type(value.get("budget")) is not int or not 1 <= value["budget"] <= 1000:
            raise AdapterError("Hacker News source budget is invalid", status="schema-drift")
        if type(inp["top_enabled"]) is not bool or type(inp["new_enabled"]) is not bool or type(inp["queries"]) is not list:
            raise AdapterError("Hacker News source input is invalid", status="schema-drift")
        seen_ids: set[str] = set()
        for query in inp["queries"]:
            try:
                query_fingerprint("hackernews", query)
            except Exception as exc:
                raise AdapterError("Hacker News query is invalid", status="schema-drift") from exc
            if query["id"] in seen_ids:
                raise AdapterError("Hacker News query IDs are not unique", status="schema-drift")
            seen_ids.add(query["id"])
        return value

    def _streams(self, source: str) -> Mapping[str, Any]:
        state = self._checkpoints(source)
        if state is None:
            return {}
        if not isinstance(state, Mapping) or not isinstance(state.get("streams"), Mapping):
            raise AdapterError("Hacker News checkpoint state is invalid", status="schema-drift")
        return state["streams"]

    def _fetch_ids(self, stream: str, base_url: str) -> list[Any]:
        suffix = "topstories.json" if stream == "top" else "newstories.json"
        response = self._http.get(
            f"{base_url}/{suffix}",
            allowed_hosts={_FIREBASE_HOST}, allowed_paths={"/v0"},
        )
        if type(response.body) is not list:
            raise AdapterError("Hacker News ID list drifted", status="schema-drift")
        if any(type(item) is not int or item < 0 for item in response.body):
            raise AdapterError("Hacker News ID list drifted", status="schema-drift")
        return response.body

    def _fetch_item(self, item_id: str, base_url: str) -> Mapping[str, Any]:
        response = self._http.get(
            f"{base_url}/item/{item_id}.json",
            allowed_hosts={_FIREBASE_HOST}, allowed_paths={"/v0"},
        )
        if not isinstance(response.body, Mapping):
            raise AdapterError("Hacker News item drifted", status="schema-drift")
        return response.body

    def _search(
        self,
        query: Mapping[str, Any],
        base_url: str,
        budget: int,
        window_start: str | None,
        window_end: str | None,
    ) -> list[Mapping[str, Any]]:
        filters = query.get("filters")
        filters = filters if isinstance(filters, Mapping) else {}
        tags = filters.get("tags") or ["story"]
        if not isinstance(tags, list) or any(not isinstance(item, str) for item in tags):
            raise AdapterError("Hacker News query tags are invalid", status="schema-drift")
        params = {
            "query": query.get("query", ""),
            "tags": ",".join(tags),
            "hitsPerPage": str(min(budget, 100)),
        }
        numeric_filters: list[str] = []
        min_points = filters.get("min_points")
        if min_points is not None:
            if type(min_points) is not int or min_points < 0:
                raise AdapterError("Hacker News min_points is invalid", status="schema-drift")
            numeric_filters.append(f"points>={min_points}")
        if window_start is not None:
            numeric_filters.append(f"created_at_i>={self._unix_timestamp(window_start)}")
        if window_end is not None:
            numeric_filters.append(f"created_at_i<={self._unix_timestamp(window_end)}")
        if numeric_filters:
            params["numericFilters"] = ",".join(numeric_filters)

        hits: list[Mapping[str, Any]] = []
        seen_hit_ids: set[str] = set()
        page_size = min(budget, 100)
        page_count = max(1, math.ceil(budget / 100))
        for page in range(page_count):
            page_params = dict(params)
            page_params["page"] = str(page)
            response = self._http.get(
                f"{base_url}/search_by_date?{urlencode(page_params)}",
                allowed_hosts={_ALGOLIA_HOST}, allowed_paths={"/api/v1"},
            )
            if not isinstance(response.body, Mapping) or not isinstance(response.body.get("hits"), list):
                raise AdapterError("Hacker News search response drifted", status="schema-drift")
            page_hits = response.body["hits"]
            if any(not isinstance(item, Mapping) for item in page_hits):
                raise AdapterError("Hacker News search response drifted", status="schema-drift")
            for hit in page_hits:
                native_id = str(hit.get("story_id") or hit.get("objectID"))
                if native_id in seen_hit_ids:
                    continue
                seen_hit_ids.add(native_id)
                hits.append(hit)
                if len(hits) >= budget:
                    break
            if len(page_hits) < page_size or len(hits) >= budget:
                break
        return hits

    @staticmethod
    def _unix_timestamp(value: str) -> int:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp())

    def _map_item(
        self, item: Mapping[str, Any], stream: str, fetched_at: str, rank: int,
    ) -> SourceCandidate | None:
        item_id = item.get("id")
        if type(item_id) is not int:
            return None
        if item.get("type") != "story":
            return None
        title = item.get("title")
        if type(title) is not str or not title.strip():
            return None
        published_at = _parse_time(item.get("time"))
        if published_at is None:
            return None
        hn_url = f"https://news.ycombinator.com/item?id={item_id}"
        url = item.get("url") if type(item.get("url")) is str and item["url"] else hn_url
        url = AcquisitionRuntime.canonical_url(url)
        metrics: dict[str, Any] = {}
        if type(item.get("score")) is int and item["score"] >= 0:
            metrics["points"] = item["score"]
        if type(item.get("descendants")) is int and item["descendants"] >= 0:
            metrics["descendants"] = item["descendants"]
        metrics["rank"] = rank
        return SourceCandidate(
            native_id=str(item_id), url=url, source_type="story",
            date_confidence="exact", fetched_at=fetched_at, title=title,
            author=item.get("by") if type(item.get("by")) is str else None,
            published_at=published_at,
            text=item.get("text") if type(item.get("text")) is str else None,
            native_metrics=metrics,
            provenance={"stream": stream, "hacker_news_url": hn_url, "rank": rank},
        )

    def _map_hit(self, hit: Mapping[str, Any], query: Mapping[str, Any], fetched_at: str) -> SourceCandidate | None:
        item_id = hit.get("story_id") or hit.get("objectID")
        if item_id is None:
            return None
        native_id = str(item_id)
        title = hit.get("title")
        if type(title) is not str or not title.strip():
            return None
        url = hit.get("url") if type(hit.get("url")) is str and hit["url"] else f"https://news.ycombinator.com/item?id={native_id}"
        url = AcquisitionRuntime.canonical_url(url)
        published_at = hit.get("created_at")
        if type(published_at) is str:
            try:
                parsed = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                published_at = parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            except ValueError:
                published_at = None
        metrics: dict[str, Any] = {}
        if type(hit.get("points")) is int and hit["points"] >= 0:
            metrics["points"] = hit["points"]
        if type(hit.get("num_comments")) is int and hit["num_comments"] >= 0:
            metrics["descendants"] = hit["num_comments"]
        if type(hit.get("rank")) is int and hit["rank"] >= 0:
            metrics["rank"] = hit["rank"]
        return SourceCandidate(
            native_id=native_id, url=url, source_type="story",
            date_confidence="exact" if published_at else "unknown",
            fetched_at=fetched_at, title=title,
            author=hit.get("author") if type(hit.get("author")) is str else None,
            published_at=published_at, text=None, native_metrics=metrics,
            provenance={
                "stream": f"search.{query['id']}",
                "query_id": query["id"],
                "rank": hit.get("rank") if type(hit.get("rank")) is int else None,
            },
        )

    @staticmethod
    def _finalize(
        values: list[SourceCandidate], budget: int, sort: str = "date",
    ) -> list[SourceCandidate]:
        unique: dict[str, SourceCandidate] = {}
        for value in values:
            unique.setdefault(value.native_id, value)
        result = list(unique.values())
        if sort == "points":
            result.sort(key=lambda item: item.native_id.encode())
            result.sort(key=lambda item: item.published_at or "", reverse=True)
            result.sort(
                key=lambda item: item.native_metrics.get("points", 0)
                if type(item.native_metrics.get("points")) is int else 0,
                reverse=True,
            )
        else:
            result.sort(key=lambda item: item.native_id.encode())
            result.sort(key=lambda item: item.published_at or "", reverse=True)
        return result[:budget]

    @staticmethod
    def _status(failures: list[dict[str, str]], candidates: list[SourceCandidate]) -> tuple[str, str | None, str | None]:
        if not failures:
            return ("ok" if candidates else "no-results"), None, None
        if candidates:
            return "partial", "hackernews-partial", "Hacker News streams partially failed"
        statuses = {failure["status"] for failure in failures}
        status = next(iter(statuses)) if len(statuses) == 1 else "error"
        return status, "hackernews-stream-failed", failures[0]["message"]
