"""Credential-safe GitHub community acquisition adapter.

The adapter consumes only registry-owned queries. Public discovery uses the
GitHub REST API; Discussions are a separate, explicitly enabled GraphQL stream.
Secrets and source checkpoints enter through constructor-only resolvers and are
never copied into candidates, statuses, or checkpoint updates.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import quote, urlencode, urlsplit

from ..http_client import HttpClient, HttpResponse
from ..runtime import AdapterError, CheckpointUpdate, SourceCandidate, SourceResult
from ..source_state import MAX_RECENT_NATIVE_IDS, SourceStateError, query_fingerprint


_API_HOSTS = frozenset({"api.github.com"})
_REST_PATHS = frozenset({"/search", "/repos"})
_GRAPHQL_PATHS = frozenset({"/graphql"})
_MODES = frozenset({"central", "shadow", "hybrid", "local"})
_ENTITIES = frozenset({"repository", "release", "commit", "issue", "pull-request"})
_REPO_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
_SHA_RE = re.compile(r"^[0-9A-Fa-f]{7,64}$")
_MAX_DEPTH = 10
_DEFAULT_DEPTH = 3
_PAGE_SIZE = 100
_MAX_STREAMS = 128
_COUNT_FIELDS = frozenset({
    "total_entries_seen", "node_missing_seen", "valid_seen", "mapping_errors_seen",
})
_MAX_IDENTITY_COUNT = 1_000_000

_DISCUSSION_QUERY = """query($query:String!,$first:Int!,$after:String){
  search(query:$query,type:DISCUSSION,first:$first,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{... on Discussion{id url title bodyText createdAt updatedAt
      author{login} comments{totalCount} reactions{totalCount}
      repository{id nameWithOwner}}}
  }
}"""


class _NodeIdentityMissing(AdapterError):
    def __init__(self, endpoint: str) -> None:
        super().__init__(f"{endpoint} omitted node identities", status="schema-drift")


class _ItemSchemaDrift(AdapterError):
    def __init__(self, endpoint: str) -> None:
        super().__init__(f"{endpoint} item schema drifted", status="schema-drift")


def _now_iso(clock: Callable[[], Any]) -> str:
    value = clock()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    if not isinstance(value, str):
        raise AdapterError("GitHub clock returned an invalid value", status="schema-drift")
    _parse_time(value, "clock")
    return value


def _parse_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise AdapterError(f"{label} must be an ISO-8601 timestamp", status="error")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AdapterError(f"{label} must be an ISO-8601 timestamp", status="error") from exc
    if parsed.tzinfo is None:
        raise AdapterError(f"{label} must include a timezone", status="error")
    return parsed.astimezone(timezone.utc)


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _canonical_timestamp(value: Any, endpoint: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise _ItemSchemaDrift(endpoint)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _ItemSchemaDrift(endpoint) from exc
    if parsed.tzinfo is None:
        raise _ItemSchemaDrift(endpoint)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _empty_counts() -> dict[str, int]:
    return {
        "total_entries_seen": 0, "node_missing_seen": 0,
        "valid_seen": 0, "mapping_errors_seen": 0,
    }


def _read_counts(
    container: Mapping[str, Any], field: str = "counts", *, required: bool = False,
) -> dict[str, int]:
    if field not in container:
        if required:
            raise AdapterError("GitHub checkpoint counters are required", status="schema-drift")
        return _empty_counts()
    value = container[field]
    if not isinstance(value, Mapping) or frozenset(value) != _COUNT_FIELDS:
        raise AdapterError("GitHub checkpoint counters are invalid", status="schema-drift")
    counts = dict(value)
    if any(type(item) is not int or not 0 <= item <= _MAX_IDENTITY_COUNT for item in counts.values()):
        raise AdapterError("GitHub checkpoint counters are invalid", status="schema-drift")
    if sum(counts[name] for name in _COUNT_FIELDS if name != "total_entries_seen") != counts["total_entries_seen"]:
        raise AdapterError("GitHub checkpoint counters are inconsistent", status="schema-drift")
    return counts


def _merge_counts(left: Mapping[str, int], right: Mapping[str, int]) -> dict[str, int]:
    merged = {name: left[name] + right[name] for name in _COUNT_FIELDS}
    if any(value > _MAX_IDENTITY_COUNT for value in merged.values()):
        raise AdapterError("GitHub checkpoint counters exceed their limit", status="schema-drift")
    return merged


class GitHubAdapter:
    adapter_id = "github"
    adapter_version = "0.4.0"

    def __init__(
        self,
        resolve_source: Callable[[str], Any],
        http_client: HttpClient | None = None,
        clock: Callable[[], Any] | None = None,
        credential_resolver: Callable[[str], str | None] | None = None,
        checkpoint_resolver: Callable[[str], Mapping[str, Any] | None] | None = None,
    ) -> None:
        self._resolve_source = resolve_source
        self._http = http_client or HttpClient()
        self._clock = clock or (
            lambda: datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        )
        self._credential_resolver = credential_resolver or (lambda _source: None)
        self._checkpoint_resolver = checkpoint_resolver or (lambda _source: None)

    def availability_probe(self) -> str:
        return "ok"

    def validate_request(self, request: dict[str, Any]) -> None:
        if type(request) is not dict:
            raise AdapterError("request must be an object", status="error")
        if request.get("mode") not in _MODES:
            raise AdapterError("request.mode is invalid", status="error")
        if set(request) - {"mode", "topic", "subject", "window", "depth"}:
            raise AdapterError("request contains unsupported fields", status="error")
        depth = request.get("depth")
        if depth is not None and (type(depth) is not int or not 1 <= depth <= _MAX_DEPTH):
            raise AdapterError("request.depth is invalid", status="error")
        window = request.get("window")
        if window is not None:
            if type(window) is not dict or set(window) - {"start", "end"}:
                raise AdapterError("request.window is invalid", status="error")
            parsed: dict[str, datetime] = {}
            for field in ("start", "end"):
                if window.get(field) is not None:
                    parsed[field] = _parse_time(window[field], f"request.window.{field}")
            if "start" in parsed and "end" in parsed and parsed["start"] > parsed["end"]:
                raise AdapterError("request.window is invalid", status="error")

    def collect(self, source: str, request: dict[str, Any]) -> SourceResult:
        self.validate_request(request)
        config = self._source_config(source)
        inp = config["input"]
        queries = sorted(inp["queries"], key=lambda item: item["id"].encode("utf-8"))
        checkpoint_state = self._checkpoint_resolver(source)
        streams = self._checkpoint_streams(checkpoint_state)
        now = _now_iso(self._clock)
        token: str | None = None
        if inp["include_discussions"]:
            try:
                token = self._credential_resolver(source)
            except Exception:
                token = None
            if not isinstance(token, str) or not token:
                return self._result(
                    source, request, "auth-failed", (), (),
                    "github-discussion-credential-missing",
                    "discussions: credential unavailable",
                )

        headers = {"Accept": "application/vnd.github+json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"

        candidates: list[SourceCandidate] = []
        updates: list[CheckpointUpdate] = []
        outcomes: list[tuple[str, str, bool]] = []
        warnings: list[str] = []
        identity_failures: list[str] = []
        stream_codes: dict[str, str] = {}
        for query in queries:
            stream_id = f"query.{query['id']}"
            previous = streams.get(stream_id)
            try:
                fingerprint = query_fingerprint("github", query)
                self._verify_fingerprint(previous, fingerprint)
                found, update, missing, query_status, query_code = self._collect_rest_query(
                    query, request, headers, previous, now, fingerprint,
                )
                candidates.extend(found)
                if update is not None:
                    updates.append(update)
                outcomes.append((stream_id, query_status, query_status == "ok"))
                if query_code:
                    stream_codes[stream_id] = query_code
                if missing:
                    warnings.append(stream_id)
            except (AdapterError, SourceStateError) as exc:
                status = exc.status if isinstance(exc, AdapterError) else "schema-drift"
                outcomes.append((stream_id, status, False))
                if isinstance(exc, _NodeIdentityMissing):
                    identity_failures.append(stream_id)

        if inp["include_discussions"]:
            previous = streams.get("discussions")
            try:
                found, update, missing, discussion_status, discussion_code = self._collect_discussions(
                    source, queries, request, config["budget"], headers, previous, now,
                )
                candidates.extend(found)
                if update is not None:
                    updates.append(update)
                outcomes.append(("discussions", discussion_status, discussion_status == "ok"))
                if discussion_code:
                    stream_codes["discussions"] = discussion_code
                if missing:
                    warnings.append("discussions")
            except (AdapterError, SourceStateError) as exc:
                status = exc.status if isinstance(exc, AdapterError) else "schema-drift"
                outcomes.append(("discussions", status, False))
                if isinstance(exc, _NodeIdentityMissing):
                    identity_failures.append("discussions")

        candidates = self._finalize(candidates, request, config["budget"])
        status = self._aggregate_status(outcomes, bool(candidates))
        failed = [(stream, state) for stream, state, success in outcomes if not success]
        if "github-search-cap" in stream_codes.values():
            code = "github-search-cap"
            message = "; ".join(f"{stream}: search result cap reached" for stream in stream_codes if stream_codes[stream] == code)
        elif "github-incomplete-results" in stream_codes.values():
            code = "github-incomplete-results"
            message = "; ".join(f"{stream}: search results incomplete" for stream in stream_codes if stream_codes[stream] == code)
        elif "github-endpoint-progress" in stream_codes.values():
            code = "github-endpoint-progress"
            message = "; ".join(f"{stream}: endpoint pagination in progress" for stream in stream_codes if stream_codes[stream] == code)
        elif "github-item-schema-drift" in stream_codes.values():
            code = "github-item-schema-drift"
            message = "; ".join(f"{stream}: item schema drifted" for stream in stream_codes if stream_codes[stream] == code)
        elif "github-node-id-missing" in stream_codes.values():
            code = "github-node-id-missing"
            message = "; ".join(f"{stream}: item missing node identity" for stream in stream_codes if stream_codes[stream] == code)
        elif failed and len(identity_failures) == len(failed):
            code = "github-node-id-missing"
            message = "; ".join(f"{stream}: item missing node identity" for stream in identity_failures)
        elif failed:
            code = "github-stream-failure"
            message = "; ".join(f"{stream}: {state}" for stream, state in failed)
        elif warnings:
            code = "github-node-id-missing"
            message = "; ".join(f"{stream}: item missing node identity" for stream in warnings)
        else:
            code = message = None
        return self._result(source, request, status, tuple(candidates), tuple(updates), code, message)

    def _source_config(self, source: str) -> dict[str, Any]:
        config = self._resolve_source(source)
        if type(config) is not dict or config.get("id") != source or config.get("adapter") != "github":
            raise AdapterError("GitHub source configuration is unavailable", status="skipped-unconfigured")
        if type(config.get("budget")) is not int or not 1 <= config["budget"] <= 1000:
            raise AdapterError("GitHub source budget is invalid", status="schema-drift")
        inp = config.get("input")
        if type(inp) is not dict or set(inp) != {
            "rest_api_url", "graphql_url", "include_discussions", "queries"
        }:
            raise AdapterError("GitHub source input is invalid", status="schema-drift")
        if inp["rest_api_url"] != "https://api.github.com" or inp["graphql_url"] != "https://api.github.com/graphql":
            raise AdapterError("GitHub source endpoint is invalid", status="schema-drift")
        if type(inp["include_discussions"]) is not bool or type(inp["queries"]) is not list or not inp["queries"]:
            raise AdapterError("GitHub source input is invalid", status="schema-drift")
        stream_count = len(inp["queries"]) + int(inp["include_discussions"])
        if stream_count > _MAX_STREAMS:
            raise AdapterError("GitHub source has too many streams", status="schema-drift")
        seen: set[str] = set()
        for query in inp["queries"]:
            try:
                query_fingerprint("github", query)
            except SourceStateError as exc:
                raise AdapterError("GitHub query is invalid", status="schema-drift") from exc
            entities = query.get("filters", {}).get("entities")
            if type(entities) is not list or not entities or set(entities) - _ENTITIES:
                raise AdapterError("GitHub query entities are invalid", status="schema-drift")
            if query["id"] in seen:
                raise AdapterError("GitHub query IDs are not unique", status="schema-drift")
            seen.add(query["id"])
        return config

    @staticmethod
    def _checkpoint_streams(state: Any) -> Mapping[str, Any]:
        if state is None:
            return {}
        if not isinstance(state, Mapping) or not isinstance(state.get("streams"), Mapping):
            raise AdapterError("GitHub checkpoint state is invalid", status="schema-drift")
        return state["streams"]

    @staticmethod
    def _verify_fingerprint(previous: Any, fingerprint: str) -> None:
        if previous is None:
            return
        if not isinstance(previous, Mapping) or previous.get("query_fingerprint") != fingerprint:
            raise AdapterError("GitHub query fingerprint changed", status="schema-drift")

    def _collect_rest_query(
        self, query: Mapping[str, Any], request: dict[str, Any],
        headers: dict[str, str], previous: Mapping[str, Any] | None, now: str, fingerprint: str,
    ) -> tuple[list[SourceCandidate], CheckpointUpdate | None, bool, str, str | None]:
        entities = [item for item in ("repository", "release", "commit", "issue", "pull-request")
                    if item in set(query["filters"]["entities"])]
        depth = request.get("depth", _DEFAULT_DEPTH)
        previous_cursor = previous.get("cursor", {}) if previous else {}
        if not isinstance(previous_cursor, Mapping):
            raise AdapterError("GitHub checkpoint cursor is invalid", status="schema-drift")
        old_endpoints = previous_cursor.get("endpoints", {})
        if not isinstance(old_endpoints, Mapping):
            raise AdapterError("GitHub checkpoint cursor is invalid", status="schema-drift")
        resume_required = False
        for state in old_endpoints.values():
            if not isinstance(state, Mapping):
                raise AdapterError("GitHub endpoint checkpoint is invalid", status="schema-drift")
            if state.get("complete") is not True:
                resume_required = True
        effective_request = self._effective_request(
            request, previous, previous_cursor, now, require_frozen=resume_required,
        )
        frozen_window = effective_request["window"]
        for state in old_endpoints.values():
            if "window" in state and state["window"] != frozen_window:
                raise AdapterError("GitHub endpoint window does not match cursor window", status="schema-drift")
        endpoint_states: dict[str, dict[str, Any]] = {}
        results: list[SourceCandidate] = []
        repo_cache: dict[str, str | None] = {}
        failures: list[tuple[str, str]] = []
        missing = False
        changed = False
        cap_hit = False
        incomplete_hit = False
        progress_hit = False
        successful_endpoints = 0
        etag = previous.get("etag") if previous else None
        last_modified = previous.get("last_modified") if previous else None

        for entity in entities:
            old_state = old_endpoints.get(entity, {})
            if not isinstance(old_state, Mapping):
                raise AdapterError("GitHub endpoint checkpoint is invalid", status="schema-drift")
            if old_state.get("complete") is True:
                endpoint_states[entity] = dict(old_state)
                continue
            try:
                if entity == "release":
                    found, state, capped, problem_code, problem_status = self._collect_release_endpoint(
                        query, effective_request, depth, headers, old_state, now,
                    )
                    response_etag = response_modified = None
                else:
                    endpoint_headers = dict(headers)
                    if (
                        entity == "repository" and previous and not previous_cursor
                        and not old_state
                    ):
                        if isinstance(previous.get("etag"), str):
                            endpoint_headers["If-None-Match"] = previous["etag"]
                        if isinstance(previous.get("last_modified"), str):
                            endpoint_headers["If-Modified-Since"] = previous["last_modified"]
                    found, state, capped, problem_code, problem_status, response_etag, response_modified = (
                        self._collect_search_endpoint(
                            entity, query, effective_request, depth, endpoint_headers, old_state,
                            now, repo_cache,
                        )
                    )
                results.extend(found)
                endpoint_states[entity] = (
                    (dict(old_state) or {"complete": False}) if problem_status else state
                )
                changed = changed or capped or problem_status is None or bool(found)
                cap_hit = cap_hit or capped
                incomplete_hit = incomplete_hit or problem_code == "incomplete"
                progress_hit = progress_hit or problem_code == "progress"
                missing = missing or problem_code in {"node", "node-warning"}
                if entity == "repository":
                    etag = response_etag or etag
                    last_modified = response_modified or last_modified
                if capped:
                    failures.append((entity, "partial"))
                elif problem_code == "progress":
                    failures.append((entity, "partial"))
                elif problem_status:
                    failures.append((entity, problem_status))
                else:
                    successful_endpoints += 1
            except _NodeIdentityMissing:
                endpoint_states[entity] = dict(old_state) or {"complete": False}
                failures.append((entity, "schema-drift"))
                missing = True
            except _ItemSchemaDrift:
                endpoint_states[entity] = dict(old_state) or {"complete": False}
                failures.append((entity, "schema-drift"))
            except AdapterError as exc:
                endpoint_states[entity] = dict(old_state) or {"complete": False}
                failures.append((entity, exc.status))

        results = self._finalize(results, effective_request, MAX_RECENT_NATIVE_IDS)
        previous_ids = set(previous.get("recent_native_ids", ())) if previous else set()
        emitted = [item for item in results if item.native_id not in previous_ids]
        recent = self._merge_recent(previous, [item.native_id for item in results])
        all_complete = all(endpoint_states.get(entity, {}).get("complete") is True for entity in entities)
        cursor: dict[str, Any] = {}
        if not all_complete:
            cursor = {
                "window": dict(effective_request["window"]),
                "endpoints": endpoint_states,
            }
        update = self._checkpoint(
            f"query.{query['id']}", previous, now, effective_request, recent,
            etag, last_modified, fingerprint, cursor=cursor, complete=all_complete,
        )
        if failures:
            status = "partial" if successful_endpoints or cap_hit or emitted else failures[0][1]
            code = "github-search-cap" if cap_hit else (
                "github-incomplete-results" if incomplete_hit else
                "github-endpoint-progress" if progress_hit else
                "github-node-id-missing" if missing else
                "github-item-schema-drift" if any(state == "schema-drift" for _entity, state in failures)
                else "github-endpoint-failure"
            )
        else:
            status, code = "ok", None
        # Even an all-failed query may only emit an update when it preserves
        # concrete progress from this run.
        if not changed:
            update = None
        return emitted, update, missing, status, code

    def _collect_search_endpoint(
        self, entity: str, query: Mapping[str, Any], request: Mapping[str, Any],
        depth: int, headers: Mapping[str, str], old_state: Mapping[str, Any],
        now: str, repo_cache: dict[str, str | None],
    ) -> tuple[list[SourceCandidate], dict[str, Any], bool, str | None, str | None, str | None, str | None]:
        path = "/search/repositories" if entity == "repository" else (
            "/search/commits" if entity == "commit" else "/search/issues"
        )
        api_sort = query["sort"] if entity == "repository" else (
            "committer-date" if entity == "commit" else "updated"
        )
        start_page = old_state.get("page", 1)
        counters_required = old_state.get("capped") is True or (
            type(start_page) is int and start_page > 1
        )
        validated_old_counts = _read_counts(old_state, required=counters_required)
        if old_state.get("capped") is True:
            start_page = 1
            old_counts = _empty_counts()
        else:
            old_counts = validated_old_counts
        if type(start_page) is not int or not 1 <= start_page <= 10:
            raise AdapterError("GitHub endpoint cursor is invalid", status="schema-drift")
        response, pages, next_page, capped, incomplete = self._search_pages(
            path, self._search_text(query, entity, request), depth, headers,
            label=entity, sort=api_sort, start_page=start_page,
        )
        if response.status == 304:
            return [], {"complete": True}, False, None, None, response.etag, response.last_modified
        results: list[SourceCandidate] = []
        total_entries = 0
        node_missing = 0
        mapping_errors = 0
        other_failure: AdapterError | None = None
        for items in pages:
            total_entries += len(items)
            page_schema = 0
            for item in items:
                try:
                    if entity == "repository":
                        full_name = _text(item.get("full_name"))
                        node_id = _text(item.get("node_id"))
                        if not node_id:
                            raise _NodeIdentityMissing("repository")
                        if not full_name or _REPO_NAME_RE.fullmatch(full_name) is None:
                            raise _ItemSchemaDrift("repository")
                        repo_cache[full_name.lower()] = node_id
                    elif entity in {"issue", "pull-request"}:
                        self._resolve_parent_repository(item, headers, repo_cache)
                    results.append(self._map_rest(entity, item, query, now, repo_cache))
                except _NodeIdentityMissing:
                    node_missing += 1
                except _ItemSchemaDrift:
                    page_schema += 1
                except AdapterError as exc:
                    page_schema += 1
                    other_failure = other_failure or exc
            mapping_errors += page_schema
        current_counts = {
            "total_entries_seen": total_entries,
            "node_missing_seen": node_missing,
            "valid_seen": len(results),
            "mapping_errors_seen": mapping_errors,
        }
        counts = _merge_counts(old_counts, current_counts)
        if other_failure is not None:
            problem_code, problem_status = "parent", other_failure.status
        elif mapping_errors:
            problem_code, problem_status = "schema", "schema-drift"
        elif incomplete:
            problem_code, problem_status = "incomplete", "partial"
        elif capped:
            problem_code = problem_status = None
        elif next_page is not None:
            problem_code, problem_status = "progress", None
        elif counts["total_entries_seen"] > 0 and counts["valid_seen"] == 0 and counts["node_missing_seen"] == counts["total_entries_seen"]:
            problem_code, problem_status = "node", "schema-drift"
        elif counts["node_missing_seen"]:
            problem_code, problem_status = "node-warning", None
        else:
            problem_code = problem_status = None
        if capped:
            state = {"complete": False, "capped": True, "counts": counts}
        elif next_page is not None:
            state = {"complete": False, "page": next_page, "counts": counts}
        elif problem_status:
            state = {"complete": False}
        else:
            state = {"complete": True}
        return (
            results, state, capped, problem_code, problem_status,
            response.etag, response.last_modified,
        )

    def _collect_release_endpoint(
        self, query: Mapping[str, Any], request: Mapping[str, Any], depth: int,
        headers: Mapping[str, str], old_state: Mapping[str, Any], now: str,
    ) -> tuple[list[SourceCandidate], dict[str, Any], bool, str | None, str | None]:
        repo_page = old_state.get("repository_page", 1)
        release_pages_marker = old_state.get("release_pages", {})
        has_progress = (
            old_state.get("capped") is True
            or (type(repo_page) is int and repo_page > 1)
            or old_state.get("repository_complete") is True
            or bool(release_pages_marker)
        )
        validated_repo_counts = _read_counts(
            old_state, "repository_counts", required=has_progress,
        )
        validated_release_counts = _read_counts(
            old_state, "release_counts", required=has_progress,
        )
        if old_state.get("capped") is True:
            repo_page = 1
            old_repo_counts = _empty_counts()
            old_release_counts = _empty_counts()
        else:
            old_repo_counts = validated_repo_counts
            old_release_counts = validated_release_counts
        if type(repo_page) is not int or not 1 <= repo_page <= 10:
            raise AdapterError("GitHub release repository cursor is invalid", status="schema-drift")
        repository_complete = old_state.get("repository_complete", False)
        if type(repository_complete) is not bool:
            raise AdapterError("GitHub release repository cursor is invalid", status="schema-drift")
        if repository_complete:
            repo_pages: list[list[Mapping[str, Any]]] = []
            repo_next = None
            capped = incomplete = False
        else:
            _response, repo_pages, repo_next, capped, incomplete = self._search_pages(
                "/search/repositories", self._search_text(query, "repository", request),
                depth, headers, label="release repositories", sort=query["sort"],
                start_page=repo_page,
            )
        targets: dict[str, str] = {}
        repo_total = 0
        repo_missing = 0
        repo_mapping_errors = 0
        for repo_items in repo_pages:
            repo_total += len(repo_items)
            page_schema = 0
            for item in repo_items:
                full_name = _text(item.get("full_name"))
                node_id = _text(item.get("node_id"))
                if not node_id:
                    repo_missing += 1
                    continue
                if not full_name or _REPO_NAME_RE.fullmatch(full_name) is None:
                    page_schema += 1
                    continue
                targets[full_name.lower()] = node_id
            repo_mapping_errors += page_schema
        repo_current_counts = {
            "total_entries_seen": repo_total, "node_missing_seen": repo_missing,
            "valid_seen": repo_total - repo_missing - repo_mapping_errors,
            "mapping_errors_seen": repo_mapping_errors,
        }
        repo_counts = _merge_counts(old_repo_counts, repo_current_counts)
        old_pages = release_pages_marker
        if not isinstance(old_pages, Mapping):
            raise AdapterError("GitHub release cursor is invalid", status="schema-drift")
        for full_name, saved in old_pages.items():
            if not isinstance(full_name, str) or not isinstance(saved, Mapping):
                raise AdapterError("GitHub release cursor is invalid", status="schema-drift")
            node_id = _text(saved.get("repository_node_id"))
            if not node_id:
                raise AdapterError("GitHub release cursor is invalid", status="schema-drift")
            targets[full_name] = node_id
        results: list[SourceCandidate] = []
        next_releases: dict[str, dict[str, Any]] = {}
        release_total = 0
        release_missing = 0
        release_mapping_errors = 0
        for full_name in sorted(targets, key=lambda value: value.encode("utf-8")):
            saved = old_pages.get(full_name, {})
            start = saved.get("page", 1) if isinstance(saved, Mapping) else 1
            if type(start) is not int or start < 1:
                raise AdapterError("GitHub release cursor is invalid", status="schema-drift")
            release_pages, next_page = self._release_pages(full_name, start, depth, headers)
            for items in release_pages:
                release_total += len(items)
                page_schema = 0
                for item in items:
                    try:
                        results.append(self._map_rest("release", item, query, now, targets, full_name))
                    except _NodeIdentityMissing:
                        release_missing += 1
                    except _ItemSchemaDrift:
                        page_schema += 1
                release_mapping_errors += page_schema
            if next_page is not None:
                next_releases[full_name] = {
                    "page": next_page, "repository_node_id": targets[full_name],
                }
        release_current_counts = {
            "total_entries_seen": release_total, "node_missing_seen": release_missing,
            "valid_seen": len(results), "mapping_errors_seen": release_mapping_errors,
        }
        release_counts = _merge_counts(old_release_counts, release_current_counts)
        endpoint_complete = (repository_complete or repo_next is None) and not next_releases
        if repo_mapping_errors or release_mapping_errors:
            problem_code, problem_status = "schema", "schema-drift"
        elif incomplete:
            problem_code, problem_status = "incomplete", "partial"
        elif capped:
            problem_code = problem_status = None
        elif not endpoint_complete:
            problem_code, problem_status = "progress", None
        elif (
            (repo_counts["total_entries_seen"] > 0 and repo_counts["valid_seen"] == 0
             and repo_counts["node_missing_seen"] == repo_counts["total_entries_seen"])
            or (release_counts["total_entries_seen"] > 0 and release_counts["valid_seen"] == 0
                and release_counts["node_missing_seen"] == release_counts["total_entries_seen"])
        ):
            problem_code, problem_status = "node", "schema-drift"
        elif repo_counts["node_missing_seen"] or release_counts["node_missing_seen"]:
            problem_code, problem_status = "node-warning", None
        else:
            problem_code = problem_status = None
        if capped:
            state: dict[str, Any] = {
                "complete": False, "capped": True,
                "repository_counts": repo_counts,
                "release_counts": release_counts,
            }
            if next_releases:
                state["release_pages"] = next_releases
        elif repo_next is not None or next_releases or problem_status:
            state = {
                "complete": False,
                "repository_complete": repo_next is None,
                "repository_counts": repo_counts,
                "release_counts": release_counts,
            }
            if repo_next is not None:
                state["repository_page"] = repo_next
            if next_releases:
                state["release_pages"] = next_releases
        else:
            state = {"complete": True}
        return results, state, capped, problem_code, problem_status

    def _resolve_parent_repository(
        self, item: Mapping[str, Any], headers: Mapping[str, str],
        repo_cache: dict[str, str | None],
    ) -> str:
        repository_url = _text(item.get("repository_url"))
        if not repository_url:
            raise _ItemSchemaDrift("issue parent repository")
        parsed = urlsplit(repository_url)
        raw_full_name = parsed.path.removeprefix("/repos/")
        full_name = raw_full_name.lower()
        if (
            parsed.scheme != "https" or parsed.hostname != "api.github.com"
            or parsed.netloc != "api.github.com" or parsed.query or parsed.fragment
            or not parsed.path.startswith("/repos/")
            or _REPO_NAME_RE.fullmatch(raw_full_name) is None
        ):
            raise _ItemSchemaDrift("issue parent repository")
        if full_name not in repo_cache:
            response = self._http.get(
                f"https://api.github.com/repos/{quote(full_name, safe='/')}",
                allowed_hosts=_API_HOSTS, allowed_paths=_REST_PATHS, headers=headers,
            )
            if not isinstance(response.body, Mapping):
                raise AdapterError("parent repository response schema drifted", status="schema-drift")
            repo_cache[full_name] = _text(response.body.get("node_id"))
        node_id = repo_cache.get(full_name)
        if not node_id:
            raise _NodeIdentityMissing("parent repository")
        return node_id

    def _search_pages(
        self, path: str, query_text: str, depth: int, headers: Mapping[str, str], *,
        label: str, sort: str, start_page: int,
    ) -> tuple[HttpResponse, list[list[Mapping[str, Any]]], int | None, bool, bool]:
        pages: list[list[Mapping[str, Any]]] = []
        first_response: HttpResponse | None = None
        next_page: int | None = start_page
        capped = False
        incomplete = False
        for page in range(start_page, start_page + depth):
            if page > 10:
                raise AdapterError("GitHub search exceeds the 1000-result API cap", status="schema-drift")
            url = "https://api.github.com" + path + "?" + urlencode({
                "q": query_text, "sort": sort, "order": "desc",
                "per_page": _PAGE_SIZE, "page": page,
            })
            response = self._http.get(
                url, allowed_hosts=_API_HOSTS, allowed_paths=_REST_PATHS, headers=headers,
            )
            if first_response is None:
                first_response = response
            if response.status == 304:
                return response, [], None, False, False
            if not isinstance(response.body, Mapping) or type(response.body.get("items")) is not list:
                raise AdapterError(f"{label} response schema drifted", status="schema-drift")
            items = response.body["items"]
            incomplete_value = response.body.get("incomplete_results")
            if type(incomplete_value) is not bool:
                raise _ItemSchemaDrift("search response")
            if any(not isinstance(item, Mapping) for item in items):
                raise AdapterError(f"{label} response schema drifted", status="schema-drift")
            pages.append(items)
            if incomplete_value:
                incomplete = True
                next_page = None
                break
            total = response.body.get("total_count")
            complete = not items or len(items) < _PAGE_SIZE
            accessible_total = min(total, 1000) if type(total) is int else None
            if accessible_total is not None and page * _PAGE_SIZE >= accessible_total:
                complete = True
                capped = total > 1000
            if complete:
                next_page = None
                break
            next_page = page + 1
        assert first_response is not None
        return first_response, pages, next_page, capped, incomplete

    def _release_pages(
        self, full_name: str, start_page: int, depth: int, headers: Mapping[str, str],
    ) -> tuple[list[list[Mapping[str, Any]]], int | None]:
        pages: list[list[Mapping[str, Any]]] = []
        next_page: int | None = start_page
        for page in range(start_page, start_page + depth):
            url = f"https://api.github.com/repos/{quote(full_name, safe='/')}/releases?" + urlencode({
                "per_page": _PAGE_SIZE, "page": page,
            })
            response = self._http.get(
                url, allowed_hosts=_API_HOSTS, allowed_paths=_REST_PATHS, headers=headers,
            )
            page_items = self._list_body(response, "releases")
            pages.append(page_items)
            if len(page_items) < _PAGE_SIZE:
                next_page = None
                break
            next_page = page + 1
        return pages, next_page

    @staticmethod
    def _list_body(response: HttpResponse, label: str) -> list[Mapping[str, Any]]:
        if response.status == 304:
            return []
        if type(response.body) is not list or any(not isinstance(item, Mapping) for item in response.body):
            raise AdapterError(f"{label} response schema drifted", status="schema-drift")
        return response.body

    @staticmethod
    def _search_text(
        query: Mapping[str, Any], entity: str, request: Mapping[str, Any],
    ) -> str:
        parts = [query["query"]]
        filters = query.get("filters", {})
        if entity == "repository" and filters.get("language"):
            parts.append(f"language:{filters['language']}")
        if filters.get("owner"):
            parts.append(f"user:{filters['owner']}")
        if entity == "repository":
            for topic in filters.get("topics", ()):
                parts.append(f"topic:{topic}")
            if filters.get("min_stars") is not None:
                parts.append(f"stars:>={filters['min_stars']}")
        if entity == "issue":
            parts.append("type:issue")
        elif entity == "pull-request":
            parts.append("type:pr")
        window = request.get("window")
        if isinstance(window, Mapping):
            qualifier = (
                "pushed" if entity == "repository"
                else "committer-date" if entity == "commit"
                else "updated"
            )
            if window.get("start"):
                parts.append(f"{qualifier}:>={window['start']}")
            if window.get("end"):
                parts.append(f"{qualifier}:<={window['end']}")
        return " ".join(parts)

    @staticmethod
    def _effective_request(
        request: Mapping[str, Any], previous: Mapping[str, Any] | None,
        cursor: Mapping[str, Any], now: str, *, require_frozen: bool = False,
    ) -> Mapping[str, Any]:
        if "window" in cursor:
            frozen_window = cursor["window"]
            if not isinstance(frozen_window, Mapping) or set(frozen_window) != {"start", "end"}:
                raise AdapterError("GitHub checkpoint window is invalid", status="schema-drift")
            start, end = frozen_window["start"], frozen_window["end"]
            if start is not None and not isinstance(start, str):
                raise AdapterError("GitHub checkpoint window is invalid", status="schema-drift")
            if not isinstance(end, str) or not end:
                raise AdapterError("GitHub checkpoint window is invalid", status="schema-drift")
            try:
                parsed_start = _parse_time(start, "checkpoint window") if start is not None else None
                parsed_end = _parse_time(end, "checkpoint window")
            except AdapterError as exc:
                raise AdapterError("GitHub checkpoint window is invalid", status="schema-drift") from exc
            if parsed_start is not None and parsed_start > parsed_end:
                raise AdapterError("GitHub checkpoint window is invalid", status="schema-drift")
            return {**request, "window": dict(frozen_window)}
        if require_frozen:
            raise AdapterError("GitHub resume cursor requires a frozen window", status="schema-drift")
        if isinstance(request.get("window"), Mapping):
            return request
        start = previous.get("successful_window_end") if previous else None
        return {**request, "window": {"start": start, "end": now}}

    def _map_rest(
        self, entity: str, item: Any, query: Mapping[str, Any], fetched_at: str,
        repo_nodes: Mapping[str, str], parent_name: str | None = None,
    ) -> SourceCandidate:
        if not isinstance(item, Mapping):
            raise _ItemSchemaDrift(entity)
        parent_id: str | None = None
        if entity == "commit":
            sha = _text(item.get("sha"))
            repository = item.get("repository")
            repo_node = _text(repository.get("node_id")) if isinstance(repository, Mapping) else None
            if not repo_node:
                raise _NodeIdentityMissing(entity)
            if not sha or _SHA_RE.fullmatch(sha) is None:
                raise _ItemSchemaDrift(entity)
            native_id = f"github:commit:{repo_node}:{sha.lower()}"
            parent_id = f"github:repository:{repo_node}"
        else:
            node_id = _text(item.get("node_id"))
            if not node_id:
                raise _NodeIdentityMissing(entity)
            if entity == "pull-request" and not isinstance(item.get("pull_request"), Mapping):
                raise _ItemSchemaDrift(entity)
            native_id = f"github:{entity}:{node_id}"
            if entity == "release" and parent_name:
                repo_node = repo_nodes.get(parent_name.lower())
                if repo_node:
                    parent_id = f"github:repository:{repo_node}"
            elif entity in {"issue", "pull-request"}:
                repo_url = _text(item.get("repository_url"))
                if repo_url:
                    parts = urlsplit(repo_url).path.removeprefix("/repos/").lower()
                    repo_node = repo_nodes.get(parts)
                    if repo_node:
                        parent_id = f"github:repository:{repo_node}"
        url = self._canonical_public_url(_text(item.get("html_url")))
        if url is None:
            raise _ItemSchemaDrift(entity)

        metrics: dict[str, Any] = {}
        aliases = {
            "stars": item.get("stargazers_count"), "forks": item.get("forks_count"),
            "watchers": item.get("watchers_count"), "comments": item.get("comments"),
        }
        for key, value in aliases.items():
            parsed = _count(value)
            if parsed is not None:
                metrics[key] = parsed
        reactions = item.get("reactions")
        reaction_count = _count(reactions.get("total_count")) if isinstance(reactions, Mapping) else None
        if reaction_count is not None:
            metrics["reactions"] = reaction_count
        if item.get("state") in {"open", "closed"}:
            metrics["state"] = item["state"]

        if entity == "commit":
            commit = item.get("commit") if isinstance(item.get("commit"), Mapping) else {}
            committer = commit.get("committer") if isinstance(commit.get("committer"), Mapping) else {}
            author_meta = commit.get("author") if isinstance(commit.get("author"), Mapping) else {}
            committer_date = _canonical_timestamp(committer.get("date"), entity)
            author_date = _canonical_timestamp(author_meta.get("date"), entity)
            updated = committer_date or author_date
            published = author_date or updated
            confidence = "exact" if author_date else "inferred"
            title = (_text(commit.get("message")) or "").splitlines()[0] or None
            text = _text(commit.get("message"))
            author = _text((item.get("author") or {}).get("login")) if isinstance(item.get("author"), Mapping) else None
            author = author or _text(author_meta.get("name"))
        elif entity == "release":
            published_date = _canonical_timestamp(item.get("published_at"), entity)
            created_date = _canonical_timestamp(item.get("created_at"), entity)
            updated = published_date or created_date
            published = updated
            confidence = "exact" if published_date else "inferred"
            title = _text(item.get("name")) or _text(item.get("tag_name"))
            text = _text(item.get("body"))
            author = _text((item.get("author") or {}).get("login")) if isinstance(item.get("author"), Mapping) else None
        elif entity == "repository":
            updated = _canonical_timestamp(item.get("updated_at"), entity)
            created = _canonical_timestamp(item.get("created_at"), entity)
            published = created or updated
            confidence = "exact" if created else "inferred"
            title = _text(item.get("full_name")) or _text(item.get("name"))
            text = _text(item.get("description"))
            author = _text((item.get("owner") or {}).get("login")) if isinstance(item.get("owner"), Mapping) else None
        else:
            updated = _canonical_timestamp(item.get("updated_at"), entity)
            created = _canonical_timestamp(item.get("created_at"), entity)
            published = created or updated
            confidence = "exact" if created else "inferred"
            title, text = _text(item.get("title")), _text(item.get("body"))
            author = _text((item.get("user") or {}).get("login")) if isinstance(item.get("user"), Mapping) else None
        if updated is None:
            raise _ItemSchemaDrift(entity)
        if updated:
            metrics["updated_at"] = updated
        provenance: dict[str, Any] = {"query_id": query["id"], "endpoint": entity}
        if parent_id:
            provenance["parent_repository_id"] = parent_id
        return SourceCandidate(
            native_id=native_id, url=url, source_type=entity,
            date_confidence=confidence if published else "unknown", fetched_at=fetched_at,
            title=title, text=text, author=author, published_at=published,
            native_metrics=metrics, provenance=provenance,
        )

    def _collect_discussions(
        self, source: str, queries: list[Mapping[str, Any]], request: dict[str, Any], budget: int,
        headers: dict[str, str], previous: Mapping[str, Any] | None, now: str,
    ) -> tuple[list[SourceCandidate], CheckpointUpdate | None, bool, str, str | None]:
        depth = request.get("depth", _DEFAULT_DEPTH)
        previous_cursor = previous.get("cursor", {}) if previous else {}
        if not isinstance(previous_cursor, Mapping):
            raise AdapterError("GitHub discussions cursor is invalid", status="schema-drift")
        if previous_cursor:
            if set(previous_cursor) != {"query_id", "after", "window", "counts"}:
                raise AdapterError("GitHub discussions resume cursor is invalid", status="schema-drift")
        resume_query = previous_cursor.get("query_id")
        resume_after = previous_cursor.get("after")
        if previous_cursor and (
            type(resume_query) is not str or not resume_query
            or type(resume_after) is not str or not resume_after
        ):
            raise AdapterError("GitHub discussions resume cursor is invalid", status="schema-drift")
        old_counts = _read_counts(
            previous_cursor, required=resume_query is not None or resume_after is not None,
        )
        if resume_query is not None and resume_query not in {query["id"] for query in queries}:
            raise AdapterError("GitHub discussions cursor is invalid", status="schema-drift")
        effective_request = self._effective_request(
            request, previous, previous_cursor, now, require_frozen=bool(previous_cursor),
        )
        results: list[SourceCandidate] = []
        missing = False
        cursor: dict[str, Any] = {}
        etag = last_modified = None
        start_index = 0
        if resume_query is not None:
            start_index = next(index for index, query in enumerate(queries) if query["id"] == resume_query)
        truncated = False
        fatal_code: str | None = None
        total_entries = 0
        node_missing = 0
        mapping_errors = 0
        for query_index, query in enumerate(queries[start_index:], start=start_index):
            after: str | None = resume_after if query["id"] == resume_query else None
            for page_index in range(depth):
                response = self._http.post_json(
                    "https://api.github.com/graphql",
                    {"query": _DISCUSSION_QUERY, "variables": {
                        "query": self._discussion_search_text(query, effective_request),
                        "first": min(_PAGE_SIZE, budget), "after": after,
                    }},
                    allowed_hosts=_API_HOSTS, allowed_paths=_GRAPHQL_PATHS, headers=headers,
                )
                etag, last_modified = response.etag, response.last_modified
                body = response.body
                if not isinstance(body, Mapping):
                    raise AdapterError("discussions response schema drifted", status="schema-drift")
                errors = body.get("errors")
                if errors:
                    status = self._graphql_error_status(errors)
                    raise AdapterError("discussions request failed", status=status, retryable=status == "rate-limited")
                data = body.get("data")
                search = data.get("search") if isinstance(data, Mapping) else None
                if not isinstance(search, Mapping) or type(search.get("nodes")) is not list:
                    raise AdapterError("discussions response schema drifted", status="schema-drift")
                nodes = search["nodes"]
                total_entries += len(nodes)
                page_missing = 0
                page_schema = 0
                for item in nodes:
                    try:
                        results.append(self._map_discussion(item, query, now))
                    except _NodeIdentityMissing:
                        page_missing += 1
                        missing = True
                    except _ItemSchemaDrift:
                        page_schema += 1
                if page_schema:
                    mapping_errors += page_schema
                    fatal_code = "github-item-schema-drift"
                    break
                node_missing += page_missing
                page_info = search.get("pageInfo")
                if not isinstance(page_info, Mapping):
                    raise AdapterError("discussions response schema drifted", status="schema-drift")
                end_cursor = _text(page_info.get("endCursor"))
                if page_info.get("hasNextPage") is not True:
                    break
                if not end_cursor:
                    raise AdapterError("discussions cursor is invalid", status="schema-drift")
                after = end_cursor
                if page_index == depth - 1:
                    cursor = {"query_id": query["id"], "after": end_cursor}
                    truncated = True
            if fatal_code:
                break
            if truncated:
                break
            resume_after = None
        valid_mapped = len(results)
        results = self._finalize(results, effective_request, MAX_RECENT_NATIVE_IDS)
        native_ids = [item.native_id for item in results]
        counts = _merge_counts(old_counts, {
            "total_entries_seen": total_entries,
            "node_missing_seen": node_missing,
            "valid_seen": valid_mapped,
            "mapping_errors_seen": mapping_errors,
        })
        previous_ids = set(previous.get("recent_native_ids", ())) if previous else set()
        emitted = [item for item in results if item.native_id not in previous_ids]
        if fatal_code:
            return emitted, None, missing, "schema-drift", fatal_code
        if not truncated and counts["total_entries_seen"] > 0 and counts["valid_seen"] == 0 and counts["node_missing_seen"] == counts["total_entries_seen"]:
            return emitted, None, True, "schema-drift", "github-node-id-missing"
        if cursor:
            cursor["window"] = dict(effective_request["window"])
            cursor["counts"] = counts
        update = self._checkpoint(
            "discussions", previous, now, effective_request, self._merge_recent(previous, native_ids),
            etag, last_modified, None, cursor=cursor, complete=not truncated,
        )
        if truncated:
            return emitted, update, missing, "partial", "github-endpoint-progress"
        return emitted, update, counts["node_missing_seen"] > 0, "ok", None

    @staticmethod
    def _discussion_search_text(
        query: Mapping[str, Any], request: Mapping[str, Any],
    ) -> str:
        parts = [query["query"]]
        owner = query.get("filters", {}).get("owner")
        if owner:
            parts.append(f"user:{owner}")
        if query.get("sort") == "updated":
            parts.append("sort:updated-desc")
        window = request.get("window")
        if isinstance(window, Mapping):
            start = window.get("start") or ""
            end = window.get("end") or ""
            if start and end:
                parts.append(f"updated:{start}..{end}")
            elif start:
                parts.append(f"updated:>={start}")
            elif end:
                parts.append(f"updated:<={end}")
        return " ".join(parts)

    @staticmethod
    def _graphql_error_status(errors: Any) -> str:
        if not isinstance(errors, list) or not errors:
            return "error"
        values = [
            error.get("type") if isinstance(error, Mapping) else None
            for error in errors
        ]
        rate = {"RATE_LIMITED", "RATE_LIMITED_BY_IP"}
        auth = {"UNAUTHENTICATED", "UNAUTHORIZED", "FORBIDDEN", "INSUFFICIENT_SCOPES"}
        schema = {"GRAPHQL_VALIDATION_FAILED", "BAD_USER_INPUT"}
        known = rate | auth | schema
        if any(value not in known for value in values):
            return "error"
        if any(value in schema for value in values):
            return "schema-drift"
        if any(value in auth for value in values):
            return "auth-failed"
        return "rate-limited"

    def _map_discussion(
        self, item: Any, query: Mapping[str, Any], fetched_at: str,
    ) -> SourceCandidate:
        if not isinstance(item, Mapping):
            raise _ItemSchemaDrift("discussion")
        node_id = _text(item.get("id"))
        if not node_id:
            raise _NodeIdentityMissing("discussion")
        url = self._canonical_public_url(_text(item.get("url")))
        if url is None:
            raise _ItemSchemaDrift("discussion")
        repository = item.get("repository")
        repo_id = _text(repository.get("id")) if isinstance(repository, Mapping) else None
        if (
            not repo_id or len(repo_id) > 512
            or any(character.isspace() or ord(character) < 0x20 for character in repo_id)
        ):
            raise _ItemSchemaDrift("discussion repository")
        created = _canonical_timestamp(item.get("createdAt"), "discussion")
        updated = _canonical_timestamp(item.get("updatedAt"), "discussion") or created
        if created is None or updated is None:
            raise _ItemSchemaDrift("discussion")
        metrics: dict[str, Any] = {}
        for key in ("comments", "reactions"):
            value = item.get(key)
            parsed = _count(value.get("totalCount")) if isinstance(value, Mapping) else None
            if parsed is not None:
                metrics[key] = parsed
        if updated:
            metrics["updated_at"] = updated
        provenance: dict[str, Any] = {
            "query_id": query["id"], "endpoint": "discussions",
            "parent_repository_id": f"github:repository:{repo_id}",
        }
        author = item.get("author")
        return SourceCandidate(
            native_id=f"github:discussion:{node_id}", url=url, source_type="discussion",
            date_confidence="exact", fetched_at=fetched_at,
            title=_text(item.get("title")), text=_text(item.get("bodyText")),
            author=_text(author.get("login")) if isinstance(author, Mapping) else None,
            published_at=created, native_metrics=metrics,
            provenance=provenance,
        )

    def _checkpoint(
        self, stream_id: str, previous: Mapping[str, Any] | None, now: str,
        request: Mapping[str, Any], recent: Any, etag: str | None, last_modified: str | None,
        fingerprint: str | None, *, cursor: Any, complete: bool = True,
    ) -> CheckpointUpdate:
        previous_at = previous.get("checkpoint_at") if isinstance(previous, Mapping) else None
        window = request.get("window")
        successful_end = window.get("end") if isinstance(window, Mapping) else None
        successful_end = successful_end or now
        if not complete:
            successful_end = previous.get("successful_window_end") if previous else None
        checkpoint = {
            "successful_window_end": successful_end,
            "cursor": cursor,
            "etag": etag,
            "last_modified": last_modified,
            "recent_native_ids": list(recent)[:MAX_RECENT_NATIVE_IDS],
            "checkpoint_at": now,
        }
        if fingerprint is not None:
            checkpoint["query_fingerprint"] = fingerprint
        return CheckpointUpdate(stream_id, previous_at, checkpoint)

    @staticmethod
    def _merge_recent(previous: Mapping[str, Any] | None, native_ids: list[str]) -> list[str]:
        values = list(native_ids)
        if isinstance(previous, Mapping) and isinstance(previous.get("recent_native_ids"), (list, tuple)):
            values.extend(item for item in previous["recent_native_ids"] if isinstance(item, str))
        return list(dict.fromkeys(values))[:MAX_RECENT_NATIVE_IDS]

    @staticmethod
    def _canonical_public_url(url: str | None) -> str | None:
        if not url:
            return None
        try:
            parsed = urlsplit(url)
            valid = (
                parsed.scheme == "https" and parsed.hostname == "github.com"
                and parsed.port in (None, 443) and parsed.username is None
                and parsed.password is None and parsed.path.startswith("/")
            )
            if not valid or "\\" in parsed.path:
                return None
            path = parsed.path.rstrip("/") or "/"
            return f"https://github.com{path}"
        except ValueError:
            return None

    @classmethod
    def _finalize(
        cls, candidates: list[SourceCandidate], request: Mapping[str, Any], budget: int,
    ) -> list[SourceCandidate]:
        window = request.get("window")
        start = _parse_time(window["start"], "window.start") if isinstance(window, Mapping) and window.get("start") else None
        end = _parse_time(window["end"], "window.end") if isinstance(window, Mapping) and window.get("end") else None
        filtered: list[SourceCandidate] = []
        seen_ids: set[str] = set()
        seen_urls: set[str] = set()
        for candidate in candidates:
            updated = candidate.native_metrics.get("updated_at") or candidate.published_at
            if start or end:
                if not updated:
                    continue
                try:
                    instant = _parse_time(updated, "candidate date")
                except AdapterError:
                    continue
                if start and instant < start or end and instant > end:
                    continue
            canonical_url = candidate.url.lower().rstrip("/")
            if candidate.native_id in seen_ids or canonical_url in seen_urls:
                continue
            seen_ids.add(candidate.native_id)
            seen_urls.add(canonical_url)
            filtered.append(candidate)

        def timestamp(candidate: SourceCandidate) -> float:
            value = candidate.native_metrics.get("updated_at") or candidate.published_at
            try:
                return _parse_time(value, "candidate date").timestamp() if value else float("-inf")
            except AdapterError:
                return float("-inf")

        filtered.sort(key=lambda item: item.native_id.encode("utf-8"))
        filtered.sort(key=timestamp, reverse=True)
        return filtered[:budget]

    @staticmethod
    def _aggregate_status(outcomes: list[tuple[str, str, bool]], has_candidates: bool) -> str:
        successes = sum(1 for _stream, _status, success in outcomes if success)
        failures = [status for _stream, status, success in outcomes if not success]
        if successes and failures:
            return "partial"
        if successes:
            return "ok" if has_candidates else "no-results"
        if failures and all(status == "auth-failed" for status in failures):
            return "auth-failed"
        if failures and all(status == "rate-limited" for status in failures):
            return "rate-limited"
        if len(set(failures)) == 1:
            return failures[0]
        return "error"

    def _result(
        self, source: str, request: dict[str, Any], status: str,
        candidates: tuple[SourceCandidate, ...], updates: tuple[CheckpointUpdate, ...],
        code: str | None, message: str | None,
    ) -> SourceResult:
        return SourceResult(
            self.adapter_id, self.adapter_version, source, status,
            candidates=candidates, code=code, message=message,
            retryable=status in {"partial", "rate-limited", "timeout", "unreachable"},
            request=request, checkpoint_updates=updates,
        )
