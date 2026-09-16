"""Bounded frozen-roster Release discovery and one-page polling."""

from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import quote, urlencode

from ..runtime import AdapterError
from .github_executor import GitHubExecutor
from .github_mapping import MappingSchemaDrift, MissingNodeIdentity, map_release
from .github_models import LaneOutcome, Window
from .github_queries import release_roster_fingerprint, release_roster_url

_COUNTER_FIELDS = {"roster_total", "repos_completed", "pages_fetched", "releases_seen",
                   "releases_in_window", "node_missing_seen", "valid_seen"}


class ReleaseMachine:
    def __init__(self, executor: GitHubExecutor) -> None:
        self.executor = executor

    def discover(
        self, lane_id: str, query: Mapping[str, Any], window: Window, fetched_at: str,
    ) -> LaneOutcome:
        response = self.executor.get("search", release_roster_url(query), allowed_paths={"/search"})
        body = response.body
        if type(body) is not dict or set(body) != {"total_count", "incomplete_results", "items"}:
            raise AdapterError("GitHub Release roster schema drifted", status="schema-drift")
        if type(body["total_count"]) is not int or body["total_count"] < 0 or type(body["incomplete_results"]) is not bool:
            raise AdapterError("GitHub Release roster schema drifted", status="schema-drift")
        if body["incomplete_results"]:
            self.executor.mark_validated_success()
            return LaneOutcome(lane_id, "partial", code="github-incomplete-results")
        if type(body["items"]) is not list or len(body["items"]) > 100:
            raise AdapterError("GitHub Release roster schema drifted", status="schema-drift")
        roster = []
        seen_names, seen_nodes = set(), set()
        for item in body["items"]:
            if not isinstance(item, Mapping):
                raise AdapterError("GitHub Release roster schema drifted", status="schema-drift")
            name, node = item.get("full_name"), item.get("node_id")
            if (
                type(name) is not str or not name or len(name.encode("utf-8")) > 201
                or type(node) is not str or not node or len(node.encode("utf-8")) > 512
            ):
                raise AdapterError("GitHub Release roster schema drifted", status="schema-drift")
            normalized = name.lower()
            if normalized in seen_names or node in seen_nodes:
                continue
            seen_names.add(normalized)
            seen_nodes.add(node)
            roster.append({"name_with_owner": name, "node_id": node})
        if not roster:
            self.executor.mark_validated_success()
            return LaneOutcome(lane_id, "ok", progressed=True, complete=True, state={"complete": True})
        state = {
            "phase": "poll", "window": window.to_dict(), "roster": roster,
            "roster_fingerprint": release_roster_fingerprint(roster),
            "repo_index": 0, "release_page": 1,
            "counters": {"roster_total": len(roster), "repos_completed": 0, "pages_fetched": 0,
                         "releases_seen": 0, "releases_in_window": 0,
                         "node_missing_seen": 0, "valid_seen": 0},
        }
        code = "github-release-roster-truncated" if body["total_count"] > 100 else "github-endpoint-progress"
        self.executor.mark_validated_success()
        return LaneOutcome(lane_id, "ok", code=code, progressed=True, state=state)

    def poll(
        self, lane_id: str, query: Mapping[str, Any], window: Window,
        state: Mapping[str, Any], fetched_at: str,
    ) -> LaneOutcome:
        if state.get("phase") != "poll" or not isinstance(state.get("roster"), list):
            raise AdapterError("GitHub Release poll cursor is invalid", status="schema-drift")
        if set(state) != {"phase", "window", "roster", "roster_fingerprint", "repo_index", "release_page", "counters"}:
            raise AdapterError("GitHub Release poll cursor is invalid", status="schema-drift")
        if state.get("window") != window.to_dict():
            raise AdapterError("GitHub Release poll window is invalid", status="schema-drift")
        roster = state["roster"]
        if not 1 <= len(roster) <= 100 or any(
            type(item) is not dict or set(item) != {"name_with_owner", "node_id"}
            or type(item["name_with_owner"]) is not str or not item["name_with_owner"]
            or len(item["name_with_owner"].encode("utf-8")) > 201
            or type(item["node_id"]) is not str or not item["node_id"]
            or len(item["node_id"].encode("utf-8")) > 512
            for item in roster
        ):
            raise AdapterError("GitHub Release roster cursor is invalid", status="schema-drift")
        if release_roster_fingerprint(roster) != state["roster_fingerprint"]:
            raise AdapterError("GitHub Release roster fingerprint changed", status="schema-drift")
        index, page = state.get("repo_index"), state.get("release_page")
        if type(index) is not int or not 0 <= index < len(roster) or type(page) is not int or not 1 <= page <= 100:
            raise AdapterError("GitHub Release poll cursor is invalid", status="schema-drift")
        counters_value = state.get("counters")
        if type(counters_value) is not dict or set(counters_value) != _COUNTER_FIELDS or any(
            type(value) is not int or value < 0 or value > 1_000_000 for value in counters_value.values()
        ):
            raise AdapterError("GitHub Release counters are invalid", status="schema-drift")
        if counters_value["roster_total"] != len(roster) or counters_value["repos_completed"] != index:
            raise AdapterError("GitHub Release counters are inconsistent", status="schema-drift")
        if (
            counters_value["roster_total"] > 100 or counters_value["repos_completed"] > 100
            or counters_value["pages_fetched"] > 10_000
            or counters_value["releases_in_window"] > counters_value["releases_seen"]
            or counters_value["valid_seen"] > counters_value["releases_seen"]
            or counters_value["node_missing_seen"] > counters_value["releases_seen"]
            or counters_value["valid_seen"] + counters_value["node_missing_seen"] > counters_value["releases_seen"]
        ):
            raise AdapterError("GitHub Release counters are inconsistent", status="schema-drift")
        repo = roster[index]
        url = f"https://api.github.com/repos/{quote(repo['name_with_owner'], safe='/')}/releases?" + urlencode({"per_page": 100, "page": page})
        response = self.executor.get("core", url, allowed_paths={"/repos"})
        if type(response.body) is not list or len(response.body) > 100 or any(not isinstance(item, Mapping) for item in response.body):
            raise AdapterError("GitHub Releases response schema drifted", status="schema-drift")
        counters = dict(state["counters"])
        counters["pages_fetched"] += 1
        counters["releases_seen"] += len(response.body)
        candidates = []
        missing = 0
        for item in response.body:
            try:
                candidate = map_release(item, query["id"], fetched_at, repo["node_id"])
                updated = candidate.native_metrics.get("updated_at")
                if (window.start is None or updated >= window.start) and updated <= window.end:
                    candidates.append(candidate)
                    counters["releases_in_window"] += 1
                counters["valid_seen"] += 1
            except MissingNodeIdentity:
                missing += 1
            except MappingSchemaDrift:
                return LaneOutcome(lane_id, "schema-drift", code="github-item-schema-drift")
        counters["node_missing_seen"] += missing
        parent_done = len(response.body) < 100 or page == 100
        next_state = dict(state)
        next_state["counters"] = counters
        if parent_done:
            index += 1
            counters["repos_completed"] = index
            if index == len(roster):
                if counters["releases_seen"] and counters["valid_seen"] == 0 and counters["node_missing_seen"] == counters["releases_seen"]:
                    return LaneOutcome(lane_id, "schema-drift", code="github-node-id-missing")
                self.executor.mark_validated_success()
                code = "github-node-id-missing" if counters["node_missing_seen"] else ("github-release-page-cap" if page == 100 and len(response.body) == 100 else None)
                return LaneOutcome(lane_id, "ok", tuple(candidates), code=code,
                                   progressed=True, complete=True, state={"complete": True})
            next_state["repo_index"] = index
            next_state["release_page"] = 1
        else:
            next_state["release_page"] = page + 1
        self.executor.mark_validated_success()
        return LaneOutcome(lane_id, "partial", tuple(candidates), code="github-endpoint-progress",
                           progressed=True, state=next_state)
