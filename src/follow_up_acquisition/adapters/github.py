"""Bounded GitHub acquisition facade over one-quantum endpoint machines."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Callable

from ..http_client import HttpClient
from ..runtime import AdapterError, CheckpointUpdate, SourceCandidate, SourceResult
from ..source_state import MAX_RECENT_NATIVE_IDS, SourceStateError, query_fingerprint
from .github_discussions import DiscussionMachine, graphql_error_status
from .github_executor import GitHubExecutor
from .github_models import BreakerOpen, BudgetExhausted, CredentialResolution, LaneOutcome, RequestBudget, Window
from .github_queries import discussion_query_set_fingerprint
from .github_releases import ReleaseMachine
from .github_rest import RestEndpointMachine
from .github_scheduler import LaneScheduler, LaneSetChanged, build_lane_ids

_MODES = {"central", "shadow", "hybrid", "local"}
_ENTITIES = {"repository", "release", "commit", "issue", "pull-request"}
_LANE_ENTITY = {"repository-search": "repository", "commit-search": "commit",
                "issue-search": "issue", "pull-request-search": "pull-request"}


def _clock_iso(clock: Callable[[], Any]) -> str:
    value = clock()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return Window.from_request({"start": None, "end": value}, previous_end=None, now=value).end


class GitHubAdapter:
    adapter_id = "github"
    adapter_version = "0.4.0"

    def __init__(self, resolve_source: Callable[[str], Any], http_client: HttpClient | None = None,
                 clock: Callable[[], Any] | None = None,
                 credential_resolver: Callable[[str], Any] | None = None,
                 checkpoint_resolver: Callable[[str], Mapping[str, Any] | None] | None = None) -> None:
        self._resolve = resolve_source
        self._http = http_client or HttpClient()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._credentials = credential_resolver or (lambda _source: {"status": "absent"})
        self._checkpoints = checkpoint_resolver or (lambda _source: None)

    def availability_probe(self) -> str:
        return "ok"

    @staticmethod
    def _graphql_error_status(errors: Any) -> str:
        return graphql_error_status(errors)[0]

    def validate_request(self, request: dict[str, Any]) -> None:
        if type(request) is not dict or request.get("mode") not in _MODES:
            raise AdapterError("request.mode is invalid", status="error")
        if set(request) - {"mode", "topic", "subject", "window", "depth"}:
            raise AdapterError("request contains unsupported fields", status="error")
        if request.get("depth") is not None and (type(request["depth"]) is not int or not 1 <= request["depth"] <= 10):
            raise AdapterError("request.depth is invalid", status="error")
        if request.get("window") is not None and (
            type(request["window"]) is not dict or set(request["window"]) != {"start", "end"}
        ):
            raise AdapterError("request.window is invalid", status="error")
        window = request.get("window")
        if isinstance(window, dict):
            parsed = {}
            for field in ("start", "end"):
                value = window[field]
                if value is None:
                    continue
                if type(value) is not str:
                    raise AdapterError("request.window is invalid", status="error")
                try:
                    instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
                except ValueError as exc:
                    raise AdapterError("request.window is invalid", status="error") from exc
                if instant.tzinfo is None:
                    raise AdapterError("request.window is invalid", status="error")
                parsed[field] = instant
            if "start" in parsed and "end" in parsed and parsed["start"] > parsed["end"]:
                raise AdapterError("request.window is invalid", status="error")

    def collect(self, source: str, request: dict[str, Any]) -> SourceResult:
        self.validate_request(request)
        config = self._config(source)
        now = _clock_iso(self._clock)
        try:
            credential = CredentialResolution.parse(self._credentials(source))
        except Exception:
            return self._result(source, request, "auth-failed", code="github-credential-resolution-failed",
                                message="GitHub credential resolution failed")
        if credential.status == "resolution-error":
            return self._result(source, request, "auth-failed", code="github-credential-resolution-failed",
                                message="GitHub credential resolution failed")
        headers = {"Accept": "application/vnd.github+json"}
        if credential.token:
            headers["Authorization"] = f"Bearer {credential.token}"
        executor = GitHubExecutor(RequestBudget(credential.authenticated), self._http, headers)
        queries = tuple(sorted(config["input"]["queries"], key=lambda value: value["id"].encode()))
        by_query = {query["id"]: query for query in queries}
        streams = self._streams(source)
        lanes = build_lane_ids(queries, include_discussions=config["input"]["include_discussions"])
        scheduler_previous = streams.get("scheduler")
        scheduler_reset = False
        try:
            scheduler = LaneScheduler(lanes, scheduler_previous.get("cursor") if isinstance(scheduler_previous, Mapping) else None)
        except LaneSetChanged:
            scheduler, scheduler_reset = LaneScheduler(lanes), True
        except AdapterError:
            return self._result(source, request, "schema-drift", code="github-scheduler-cursor-invalid",
                                message="GitHub scheduler cursor is invalid")

        states: dict[str, dict[str, Any]] = {}
        windows: dict[str, Window] = {}
        previous_queries: dict[str, Mapping[str, Any] | None] = {}
        recent: dict[str, list[str]] = {}
        outcome_map: dict[str, LaneOutcome] = {}
        blocked_queries: set[str] = set()
        for query in queries:
            previous = streams.get(f"query.{query['id']}")
            previous = previous if isinstance(previous, Mapping) else None
            previous_queries[query["id"]] = previous
            fingerprint = query_fingerprint("github", query)
            if previous is not None and previous.get("query_fingerprint") != fingerprint:
                blocked_queries.add(query["id"])
                outcome_map[f"{query['id']}.fingerprint"] = LaneOutcome(f"{query['id']}.fingerprint", "schema-drift", code="github-query-fingerprint-changed")
            cursor = previous.get("cursor", {}) if previous else {}
            endpoint_states = cursor.get("endpoints", {}) if isinstance(cursor, Mapping) else {}
            enabled = set(query["filters"]["entities"])
            if cursor and (
                not isinstance(cursor, Mapping) or set(cursor) != {"window", "endpoints"}
                or not isinstance(endpoint_states, Mapping) or set(endpoint_states) != enabled
            ):
                blocked_queries.add(query["id"])
                outcome_map[f"{query['id']}.cursor"] = LaneOutcome(f"{query['id']}.cursor", "schema-drift", code="github-query-cursor-invalid")
                endpoint_states = {}
            states[query["id"]] = {key: dict(value) for key, value in endpoint_states.items()} if isinstance(endpoint_states, Mapping) else {}
            for entity in enabled:
                states[query["id"]].setdefault(entity, {"complete": False})
            frozen = cursor.get("window") if isinstance(cursor, Mapping) and cursor else request.get("window")
            try:
                windows[query["id"]] = Window.from_request(frozen, previous_end=previous.get("successful_window_end") if previous else None, now=now)
            except AdapterError:
                blocked_queries.add(query["id"])
                outcome_map[f"{query['id']}.window"] = LaneOutcome(f"{query['id']}.window", "schema-drift", code="github-query-window-invalid")
                windows[query["id"]] = Window.from_request(None, previous_end=None, now=now)
            recent[query["id"]] = list(previous.get("recent_native_ids", ())) if previous else []

        discussion_previous = streams.get("discussions")
        discussion_fp = discussion_query_set_fingerprint(queries)
        discussion_states: dict[str, dict[str, Any]] = {}
        discussion_blocked = False
        discussion_cursor: Mapping[str, Any] = {}
        if isinstance(discussion_previous, Mapping):
            if discussion_previous.get("query_fingerprint") != discussion_fp:
                discussion_blocked = True
                outcome_map["discussions.fingerprint"] = LaneOutcome("discussions.fingerprint", "schema-drift", code="github-discussion-fingerprint-changed")
            dcursor = discussion_previous.get("cursor", {})
            discussion_cursor = dcursor if isinstance(dcursor, Mapping) else {}
            if dcursor and (
                not isinstance(dcursor, Mapping)
                or dcursor.get("query_set_fingerprint") != discussion_fp
                or not isinstance(dcursor.get("window"), Mapping)
            ):
                discussion_blocked = True
                outcome_map["discussions.cursor"] = LaneOutcome("discussions.cursor", "schema-drift", code="github-discussion-cursor-invalid")
            if isinstance(dcursor, Mapping) and isinstance(dcursor.get("queries"), Mapping):
                discussion_states = {key: dict(value) for key, value in dcursor["queries"].items()}
        try:
            discussion_window = Window.from_request(
                discussion_cursor.get("window") if discussion_cursor else request.get("window"),
                previous_end=discussion_previous.get("successful_window_end") if isinstance(discussion_previous, Mapping) else None,
                now=now,
            )
        except AdapterError:
            discussion_window = Window.from_request(None, previous_end=None, now=now)
            discussion_blocked = True
            outcome_map["discussions.window"] = LaneOutcome("discussions.window", "schema-drift", code="github-discussion-window-invalid")
        if config["input"]["include_discussions"] and not credential.authenticated:
            discussion_blocked = True
            outcome_map["discussions.credential"] = LaneOutcome("discussions.credential", "auth-failed", code="github-discussion-credential-missing")

        rest, releases, discussions = RestEndpointMachine(executor), ReleaseMachine(executor), DiscussionMachine(executor)
        changed: set[str] = set()
        for query in queries:
            enabled = set(query["filters"]["entities"])
            if enabled and all(states[query["id"]].get(entity, {}).get("complete") is True for entity in enabled):
                changed.add(query["id"])
        discussion_changed = False
        candidates: list[SourceCandidate] = []
        exhausted = False
        idle = 0
        failed_lanes: set[str] = set()
        lane_calls: dict[str, int] = {}
        lane_depth = request.get("depth", 3)
        # At most two complete sweeps without a request; network calls themselves
        # are bounded authoritatively by the executor.
        while idle < len(lanes) * 2:
            lane = scheduler.next_lane()
            query_id, kind = lane.split(".", 1)
            query, outcome = by_query[query_id], None
            if query_id in blocked_queries or lane in failed_lanes or lane_calls.get(lane, 0) >= lane_depth:
                idle += 1
                continue
            try:
                if kind in _LANE_ENTITY:
                    entity = _LANE_ENTITY[kind]
                    current = states[query_id].get(entity)
                    if isinstance(current, Mapping) and current.get("complete") is True:
                        idle += 1
                        continue
                    outcome = rest.run(lane, query, entity, windows[query_id], current, now)
                    if outcome.progressed:
                        states[query_id][entity] = dict(outcome.state or {})
                        changed.add(query_id)
                elif kind == "release-roster":
                    current = states[query_id].get("release")
                    if isinstance(current, Mapping) and (current.get("phase") == "poll" or current.get("complete") is True):
                        idle += 1
                        continue
                    if current not in (None, {"complete": False}) and not (
                        isinstance(current, Mapping) and set(current) == {"phase", "window"}
                        and current.get("phase") == "discover" and current.get("window") == windows[query_id].to_dict()
                    ):
                        outcome = LaneOutcome(lane, "schema-drift", code="github-release-cursor-invalid")
                        failed_lanes.add(lane)
                        outcome_map[lane] = outcome
                        idle = 0
                        continue
                    outcome = releases.discover(lane, query, windows[query_id], now)
                    if outcome.progressed:
                        states[query_id]["release"] = dict(outcome.state or {})
                        changed.add(query_id)
                elif kind == "release-poll":
                    current = states[query_id].get("release")
                    if not isinstance(current, Mapping) or current.get("phase") != "poll":
                        idle += 1
                        continue
                    outcome = releases.poll(lane, query, windows[query_id], current, now)
                    if outcome.progressed:
                        states[query_id]["release"] = dict(outcome.state or {})
                        changed.add(query_id)
                elif kind == "discussion-search":
                    current = discussion_states.get(query_id)
                    if discussion_blocked or (isinstance(current, Mapping) and current.get("complete") is True):
                        idle += 1
                        continue
                    outcome = discussions.run(lane, query, discussion_window, current, now, first=min(config["budget"], 100))
                    if outcome.progressed:
                        discussion_states[query_id] = dict(outcome.state or {})
                        discussion_changed = True
                else:
                    idle += 1
                    continue
            except BudgetExhausted:
                exhausted = True
                break
            except BreakerOpen:
                break
            except AdapterError as exc:
                outcome = LaneOutcome(lane, exc.status, code="github-lane-failure")
            lane_calls[lane] = lane_calls.get(lane, 0) + 1
            idle = 0
            if outcome:
                outcome_map[lane] = outcome
                candidates.extend(outcome.candidates)
                if not outcome.progressed and outcome.status not in {"ok", "no-results"}:
                    failed_lanes.add(lane)
            if executor.breaker.status:
                break

        collected_candidates = list(candidates)
        seen_before = {native_id for values in recent.values() for native_id in values}
        if isinstance(discussion_previous, Mapping):
            seen_before.update(discussion_previous.get("recent_native_ids", ()))
        candidates = self._finalize([item for item in candidates if item.native_id not in seen_before], config["budget"])
        updates: list[CheckpointUpdate] = []
        for query in queries:
            query_id = query["id"]
            if query_id not in changed:
                continue
            enabled = set(query["filters"]["entities"])
            complete = all(states[query_id].get(entity, {}).get("complete") is True for entity in enabled)
            query_items = [item.native_id for item in collected_candidates if item.provenance.get("query_id") == query_id]
            checkpoint = self._checkpoint(now, windows[query_id], self._merge(recent[query_id], query_items),
                                          {} if complete else {"window": windows[query_id].to_dict(), "endpoints": states[query_id]},
                                          query_fingerprint("github", query), complete)
            previous = previous_queries[query_id]
            updates.append(CheckpointUpdate(f"query.{query_id}", previous.get("checkpoint_at") if previous else None, checkpoint))

        if discussion_changed:
            dwindow = discussion_window
            complete = all(discussion_states.get(query["id"], {}).get("complete") is True for query in queries)
            ditems = [item.native_id for item in collected_candidates if item.source_type == "discussion"]
            checkpoint = self._checkpoint(now, dwindow,
                                          self._merge(list(discussion_previous.get("recent_native_ids", ())) if isinstance(discussion_previous, Mapping) else [], ditems),
                                          {} if complete else {"window": dwindow.to_dict(),
                                                               "query_set_fingerprint": discussion_fp,
                                                               "queries": discussion_states}, discussion_fp, complete)
            updates.append(CheckpointUpdate("discussions", discussion_previous.get("checkpoint_at") if isinstance(discussion_previous, Mapping) else None, checkpoint))

        if (executor.budget.total_used or exhausted or scheduler_reset) and not (executor.breaker.status and not executor.successful_calls):
            scheduler_checkpoint = self._checkpoint(now, Window(None, now), [], scheduler.cursor(), None, False)
            updates.append(CheckpointUpdate("scheduler", scheduler_previous.get("checkpoint_at") if isinstance(scheduler_previous, Mapping) else None, scheduler_checkpoint))

        outcomes = []
        for lane_id, outcome in outcome_map.items():
            if outcome.code == "github-endpoint-progress" and "." in lane_id:
                query_id, kind = lane_id.split(".", 1)
                entity = _LANE_ENTITY.get(kind, "release" if kind.startswith("release-") else None)
                if entity and states.get(query_id, {}).get(entity, {}).get("complete") is True:
                    continue
                if kind == "discussion-search" and discussion_states.get(query_id, {}).get("complete") is True:
                    continue
            outcomes.append(outcome)
        status, code, message = self._status(outcomes, candidates, executor, exhausted)
        if code is None:
            warning = next((item for item in outcomes if item.code), None)
            if warning is not None:
                code, message = warning.code, "GitHub lane completed with a warning"
        if scheduler_reset and code is None:
            code, message = "github-scheduler-reset", "GitHub scheduler lane set reset"
        return self._result(source, request, status, tuple(candidates), tuple(updates), code, message)

    def _config(self, source: str) -> dict[str, Any]:
        value = self._resolve(source)
        if type(value) is not dict or value.get("id") != source or value.get("adapter") != "github":
            raise AdapterError("GitHub source configuration is unavailable", status="skipped-unconfigured")
        inp = value.get("input")
        if type(inp) is not dict or set(inp) != {"rest_api_url", "graphql_url", "include_discussions", "queries"}:
            raise AdapterError("GitHub source input is invalid", status="schema-drift")
        if type(value.get("budget")) is not int or not 1 <= value["budget"] <= 1000 or type(inp["queries"]) is not list or not inp["queries"]:
            raise AdapterError("GitHub source input is invalid", status="schema-drift")
        if inp.get("rest_api_url") != "https://api.github.com" or inp.get("graphql_url") != "https://api.github.com/graphql":
            raise AdapterError("GitHub source endpoint is invalid", status="schema-drift")
        if type(inp.get("include_discussions")) is not bool:
            raise AdapterError("GitHub source input is invalid", status="schema-drift")
        seen_ids: set[str] = set()
        for query in inp["queries"]:
            try:
                query_fingerprint("github", query)
            except SourceStateError as exc:
                raise AdapterError("GitHub query is invalid", status="schema-drift") from exc
            entities = query.get("filters", {}).get("entities")
            if type(entities) is not list or not entities or set(entities) - _ENTITIES:
                raise AdapterError("GitHub query entities are invalid", status="schema-drift")
            if query["id"] in seen_ids:
                raise AdapterError("GitHub query IDs are not unique", status="schema-drift")
            seen_ids.add(query["id"])
        if len(build_lane_ids(inp["queries"], include_discussions=inp["include_discussions"])) > 128:
            raise AdapterError("GitHub source has too many lanes", status="schema-drift")
        return value

    def _streams(self, source: str) -> Mapping[str, Any]:
        state = self._checkpoints(source)
        if state is None:
            return {}
        if not isinstance(state, Mapping) or not isinstance(state.get("streams"), Mapping):
            raise AdapterError("GitHub checkpoint state is invalid", status="schema-drift")
        return state["streams"]

    @staticmethod
    def _checkpoint(now: str, window: Window, recent: list[str], cursor: Mapping[str, Any],
                    fingerprint: str | None, complete: bool) -> dict[str, Any]:
        value = {"successful_window_end": window.end if complete else None, "cursor": dict(cursor),
                 "etag": None, "last_modified": None, "recent_native_ids": recent[:MAX_RECENT_NATIVE_IDS],
                 "checkpoint_at": now}
        if fingerprint:
            value["query_fingerprint"] = fingerprint
        return value

    @staticmethod
    def _merge(previous: list[str], current: list[str]) -> list[str]:
        return list(dict.fromkeys(current + previous))[:MAX_RECENT_NATIVE_IDS]

    @staticmethod
    def _finalize(values: list[SourceCandidate], budget: int) -> list[SourceCandidate]:
        unique = {item.native_id: item for item in values}
        result = list(unique.values())
        result.sort(key=lambda item: item.native_id.encode())
        result.sort(key=lambda item: item.native_metrics.get("updated_at") or item.published_at or "", reverse=True)
        return result[:budget]

    @staticmethod
    def _status(outcomes: list[LaneOutcome], candidates: list[SourceCandidate], executor: GitHubExecutor,
                exhausted: bool) -> tuple[str, str | None, str | None]:
        if exhausted:
            return "partial", "github-request-budget-exhausted", "GitHub request budget exhausted"
        if executor.breaker.status:
            status = "partial" if executor.successful_calls else executor.breaker.status
            return status, f"github-{executor.breaker.status}", f"GitHub {executor.breaker.status}"
        failures = [value for value in outcomes if value.status not in {"ok", "no-results"}]
        successes = [value for value in outcomes if value.status == "ok"]
        if failures and successes:
            return "partial", failures[0].code or "github-lane-failure", "GitHub lane partially failed"
        if failures:
            kinds = {value.status for value in failures}
            status = next(iter(kinds)) if len(kinds) == 1 else "error"
            message = "GitHub lane failed"
            if status == "schema-drift" and "." in failures[0].lane_id:
                message = f"query.{failures[0].lane_id.split('.', 1)[0]}: schema-drift"
            return status, failures[0].code, message
        return ("ok" if candidates else "no-results"), None, None

    def _result(self, source: str, request: dict[str, Any], status: str,
                candidates: tuple[SourceCandidate, ...] = (), updates: tuple[CheckpointUpdate, ...] = (),
                code: str | None = None, message: str | None = None) -> SourceResult:
        return SourceResult(self.adapter_id, self.adapter_version, source, status, candidates=candidates,
                            code=code, message=message, retryable=status in {"partial", "rate-limited", "timeout", "unreachable"},
                            request=request, checkpoint_updates=updates)


__all__ = ["CredentialResolution", "GitHubAdapter"]
