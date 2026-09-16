"""One-quantum REST endpoint state machines for GitHub search lanes."""

from __future__ import annotations

import json
from typing import Any, Mapping
from urllib.parse import quote, urlsplit

from ..runtime import AdapterError
from .github_executor import GitHubExecutor
from .github_mapping import (
    MappingSchemaDrift, MissingNodeIdentity, canonical_public_url, canonical_time,
    map_commit, map_issue, map_repository,
)
from .github_models import LaneOutcome, Window
from .github_queries import rest_search_url

_SEARCH_PATHS = frozenset({"/search"})
_CORE_PATHS = frozenset({"/repos"})
_PENDING_FIELDS = {"node_id", "url", "title", "author", "published_at", "updated_at",
                   "comments", "reactions", "state", "repository_api_url"}


def _counts(value: Any = None) -> dict[str, int]:
    if value is None:
        return {"entries_seen": 0, "node_missing_seen": 0, "valid_seen": 0}
    if type(value) is not dict or set(value) != {"entries_seen", "node_missing_seen", "valid_seen"}:
        raise AdapterError("GitHub REST cursor counts are invalid", status="schema-drift")
    if any(type(item) is not int or not 0 <= item <= 1000 for item in value.values()):
        raise AdapterError("GitHub REST cursor counts are invalid", status="schema-drift")
    if value["node_missing_seen"] > value["entries_seen"] or value["valid_seen"] > value["entries_seen"]:
        raise AdapterError("GitHub REST cursor counts are invalid", status="schema-drift")
    if value["node_missing_seen"] + value["valid_seen"] > value["entries_seen"]:
        raise AdapterError("GitHub REST cursor counts are inconsistent", status="schema-drift")
    return dict(value)


def _envelope(body: Any, *, per_page: int) -> tuple[int, list[Mapping[str, Any]], bool]:
    if type(body) is not dict or set(body) != {"total_count", "incomplete_results", "items"}:
        raise AdapterError("GitHub search envelope schema drifted", status="schema-drift")
    total, incomplete, items = body["total_count"], body["incomplete_results"], body["items"]
    if type(total) is not int or not 0 <= total <= 1_000_000_000:
        raise AdapterError("GitHub search total_count is invalid", status="schema-drift")
    if type(incomplete) is not bool or type(items) is not list or len(items) > per_page:
        raise AdapterError("GitHub search envelope schema drifted", status="schema-drift")
    if any(not isinstance(item, Mapping) for item in items):
        raise AdapterError("GitHub search items schema drifted", status="schema-drift")
    return total, items, incomplete


def _pending_projection(item: Mapping[str, Any]) -> dict[str, Any]:
    repository_url = item.get("repository_url")
    node = item.get("node_id")
    if type(node) is not str or not node:
        raise MissingNodeIdentity()
    if type(repository_url) is not str or not repository_url.startswith("https://api.github.com/repos/"):
        raise MappingSchemaDrift()
    title = item.get("title")
    if type(title) is not str or not title:
        raise MappingSchemaDrift()
    author = (item.get("user") or {}).get("login") if isinstance(item.get("user"), Mapping) else None
    if author is not None and type(author) is not str:
        raise MappingSchemaDrift()
    comments = item.get("comments")
    if type(comments) is not int or not 0 <= comments <= 1_000_000_000:
        raise MappingSchemaDrift()
    reactions = item.get("reactions")
    reaction_count = reactions.get("total_count") if isinstance(reactions, Mapping) else None
    if reaction_count is not None and (type(reaction_count) is not int or not 0 <= reaction_count <= 1_000_000_000):
        raise MappingSchemaDrift()
    if item.get("state") not in {"open", "closed"}:
        raise MappingSchemaDrift()
    return {
        "node_id": node, "url": canonical_public_url(item.get("html_url")), "title": title,
        "author": author, "published_at": canonical_time(item.get("created_at")),
        "updated_at": canonical_time(item.get("updated_at")), "comments": comments,
        "reactions": reaction_count,
        "state": item.get("state"), "repository_api_url": repository_url,
    }


def _validate_pending(pending: Any) -> list[dict[str, Any]]:
    if type(pending) is not list or not 1 <= len(pending) <= 10:
        raise AdapterError("GitHub pending parent cursor is invalid", status="schema-drift")
    total_size = 2
    for item in pending:
        if type(item) is not dict or set(item) != _PENDING_FIELDS:
            raise AdapterError("GitHub pending parent item is invalid", status="schema-drift")
        encoded = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if len(encoded) > 4096:
            raise AdapterError("GitHub pending parent item is too large", status="schema-drift")
        for field in ("node_id", "url", "title", "published_at", "updated_at", "repository_api_url"):
            if type(item[field]) is not str or not item[field]:
                raise AdapterError("GitHub pending parent item is invalid", status="schema-drift")
        if canonical_public_url(item["url"]) != item["url"]:
            raise AdapterError("GitHub pending parent URL is not canonical", status="schema-drift")
        if canonical_time(item["published_at"]) != item["published_at"] or canonical_time(item["updated_at"]) != item["updated_at"]:
            raise AdapterError("GitHub pending parent timestamp is not canonical", status="schema-drift")
        parsed_repo = urlsplit(item["repository_api_url"])
        if parsed_repo.scheme != "https" or parsed_repo.netloc != "api.github.com" or not parsed_repo.path.startswith("/repos/") or parsed_repo.query or parsed_repo.fragment:
            raise AdapterError("GitHub pending repository URL is invalid", status="schema-drift")
        if item["author"] is not None and type(item["author"]) is not str:
            raise AdapterError("GitHub pending author is invalid", status="schema-drift")
        if type(item["comments"]) is not int or not 0 <= item["comments"] <= 1_000_000_000:
            raise AdapterError("GitHub pending comments are invalid", status="schema-drift")
        if item["reactions"] is not None and (type(item["reactions"]) is not int or not 0 <= item["reactions"] <= 1_000_000_000):
            raise AdapterError("GitHub pending reactions are invalid", status="schema-drift")
        if item["state"] not in {"open", "closed"}:
            raise AdapterError("GitHub pending state is invalid", status="schema-drift")
        total_size += len(encoded) + 1
    if total_size > 40 * 1024:
        raise AdapterError("GitHub pending parent cursor is too large", status="schema-drift")
    return pending


class RestEndpointMachine:
    def __init__(self, executor: GitHubExecutor) -> None:
        self.executor = executor

    def run(
        self, lane_id: str, query: Mapping[str, Any], entity: str, window: Window,
        state: Mapping[str, Any] | None, fetched_at: str,
    ) -> LaneOutcome:
        current = dict(state or {})
        phase = current.get("phase", "search")
        if phase == "parent-lookup":
            return self._parent_lookup(lane_id, query, entity, window, current, fetched_at)
        if phase != "search":
            raise AdapterError("GitHub REST cursor phase is invalid", status="schema-drift")
        page = current.get("page", 1)
        if type(page) is not int or not 1 <= page <= 10:
            raise AdapterError("GitHub REST cursor page is invalid", status="schema-drift")
        per_page = 10 if entity in {"issue", "pull-request"} else 100
        if current not in ({}, {"complete": False}) and set(current) != {
            "phase", "window", "page", "expected_total_count", "counts"
        }:
            raise AdapterError("GitHub REST search cursor is invalid", status="schema-drift")
        if "expected_total_count" in current and (
            type(current["expected_total_count"]) is not int
            or not 0 <= current["expected_total_count"] <= 1_000_000_000
        ):
            raise AdapterError("GitHub REST expected total is invalid", status="schema-drift")
        if page > 1 and "counts" not in current:
            raise AdapterError("GitHub REST cursor counts are required", status="schema-drift")
        counts = _counts(current.get("counts"))
        if current and current != {"complete": False}:
            if current.get("window") != window.to_dict():
                raise AdapterError("GitHub REST cursor window is invalid", status="schema-drift")
        response = self.executor.get("search", rest_search_url(query, entity, window, page), allowed_paths=_SEARCH_PATHS)
        if response.status == 304:
            self.executor.mark_validated_success()
            return LaneOutcome(lane_id, "ok", progressed=True, complete=True, state={"complete": True})
        total, items, incomplete = _envelope(response.body, per_page=per_page)
        expected = current.get("expected_total_count", total)
        if type(expected) is not int or expected != total:
            self.executor.mark_validated_success()
            return LaneOutcome(lane_id, "partial", code="github-search-snapshot-changed", progressed=True,
                               state={"phase": "search", "window": window.to_dict(), "page": 1,
                                      "expected_total_count": total, "counts": _counts()})
        candidates = []
        pending = []
        missing = 0
        valid_mapped = 0
        for item in items:
            try:
                if entity == "repository":
                    candidate = map_repository(item, query["id"], fetched_at)
                    valid_mapped += 1
                    updated = candidate.native_metrics["updated_at"]
                    if (window.start is None or updated >= window.start) and updated <= window.end:
                        candidates.append(candidate)
                elif entity == "commit":
                    candidate = map_commit(item, query["id"], fetched_at)
                    valid_mapped += 1
                    updated = candidate.native_metrics["updated_at"]
                    if (window.start is None or updated >= window.start) and updated <= window.end:
                        candidates.append(candidate)
                else:
                    projected = _pending_projection(item)
                    valid_mapped += 1
                    if (window.start is None or projected["updated_at"] >= window.start) and projected["updated_at"] <= window.end:
                        pending.append(projected)
            except MissingNodeIdentity:
                missing += 1
            except MappingSchemaDrift:
                return LaneOutcome(
                    lane_id, "partial" if candidates else "schema-drift", tuple(candidates),
                    code="github-item-schema-drift",
                )
        counts["entries_seen"] += len(items)
        counts["node_missing_seen"] += missing
        counts["valid_seen"] += valid_mapped
        if incomplete:
            self.executor.mark_validated_success()
            return LaneOutcome(lane_id, "partial", tuple(candidates), code="github-incomplete-results")
        accessible = min(total, 1000)
        if len(items) < per_page and counts["entries_seen"] < accessible:
            reset = {"phase": "search", "window": window.to_dict(), "page": 1,
                     "expected_total_count": total, "counts": _counts()}
            self.executor.mark_validated_success()
            return LaneOutcome(lane_id, "partial", tuple(candidates), code="github-search-snapshot-changed",
                               progressed=True, state=reset)
        next_page = page + 1 if counts["entries_seen"] < accessible and page < 10 else None
        capped = page == 10 and total > per_page * 10
        if pending:
            _validate_pending(pending)
            next_state = {"phase": "parent-lookup", "window": window.to_dict(), "page": page,
                          "expected_total_count": total, "counts": counts, "pending": pending,
                          "next_page": next_page}
            self.executor.mark_validated_success()
            return LaneOutcome(lane_id, "partial", tuple(candidates), code="github-search-cap" if capped else "github-endpoint-progress",
                               progressed=True, state=next_state)
        complete = next_page is None
        if complete and counts["entries_seen"] and counts["valid_seen"] == 0 and counts["node_missing_seen"] == counts["entries_seen"]:
            return LaneOutcome(lane_id, "schema-drift", code="github-node-id-missing")
        code = "github-search-cap" if capped else (
            "github-endpoint-progress" if not complete else
            "github-node-id-missing" if counts["node_missing_seen"] else None)
        status = "partial" if code == "github-search-cap" or not complete else "ok"
        next_state = {"complete": True} if complete else {
            "phase": "search", "window": window.to_dict(), "page": next_page,
            "expected_total_count": total, "counts": counts,
        }
        self.executor.mark_validated_success()
        return LaneOutcome(lane_id, status, tuple(candidates), code=code, progressed=True,
                           complete=complete, state=next_state)

    def _parent_lookup(
        self, lane_id: str, query: Mapping[str, Any], entity: str, window: Window,
        state: dict[str, Any], fetched_at: str,
    ) -> LaneOutcome:
        if set(state) != {"phase", "window", "page", "expected_total_count", "counts", "pending", "next_page"}:
            raise AdapterError("GitHub pending parent cursor is invalid", status="schema-drift")
        if state.get("window") != window.to_dict():
            raise AdapterError("GitHub pending parent window is invalid", status="schema-drift")
        pending = _validate_pending(state.get("pending"))
        if state["next_page"] is not None and (
            type(state["next_page"]) is not int or not 1 <= state["next_page"] <= 10
        ):
            raise AdapterError("GitHub pending next page is invalid", status="schema-drift")
        item = pending[0]
        for field in ("node_id", "url", "title", "published_at", "updated_at", "repository_api_url"):
            if type(item[field]) is not str or not item[field] or len(item[field].encode("utf-8")) > 4096:
                raise AdapterError("GitHub pending parent item is invalid", status="schema-drift")
        if item["author"] is not None and type(item["author"]) is not str:
            raise AdapterError("GitHub pending parent item is invalid", status="schema-drift")
        if type(item["comments"]) is not int or not 0 <= item["comments"] <= 1_000_000_000:
            raise AdapterError("GitHub pending parent item is invalid", status="schema-drift")
        if item["reactions"] is not None and (type(item["reactions"]) is not int or not 0 <= item["reactions"] <= 1_000_000_000):
            raise AdapterError("GitHub pending parent item is invalid", status="schema-drift")
        if item["state"] not in {"open", "closed"}:
            raise AdapterError("GitHub pending parent item is invalid", status="schema-drift")
        parsed = urlsplit(item["repository_api_url"])
        full_name = parsed.path.removeprefix("/repos/")
        response = self.executor.get(
            "core", f"https://api.github.com/repos/{quote(full_name, safe='/')}",
            allowed_paths=_CORE_PATHS,
        )
        if not isinstance(response.body, Mapping) or type(response.body.get("node_id")) is not str:
            raise AdapterError("GitHub parent repository schema drifted", status="schema-drift")
        projected = {
            "node_id": item["node_id"], "html_url": item["url"], "title": item["title"],
            "body": None, "user": {"login": item["author"]} if item["author"] else None,
            "created_at": item["published_at"], "updated_at": item["updated_at"],
            "comments": item["comments"], "reactions": {"total_count": item["reactions"]} if item["reactions"] is not None else None,
            "state": item["state"], "pull_request": {} if entity == "pull-request" else None,
        }
        candidate = map_issue(projected, query["id"], fetched_at, response.body["node_id"], pull_request=entity == "pull-request")
        self.executor.mark_validated_success()
        remaining = pending[1:]
        if remaining:
            state["pending"] = remaining
            return LaneOutcome(lane_id, "partial", (candidate,), code="github-endpoint-progress", progressed=True, state=state)
        next_page = state.get("next_page")
        if next_page is None:
            capped = state["page"] == 10 and state["expected_total_count"] > (100 if entity in {"issue", "pull-request"} else 1000)
            return LaneOutcome(lane_id, "partial" if capped else "ok", (candidate,),
                               code="github-search-cap" if capped else None,
                               progressed=True, complete=True, state={"complete": True})
        state = {"phase": "search", "window": window.to_dict(), "page": next_page,
                 "expected_total_count": state["expected_total_count"], "counts": state["counts"]}
        return LaneOutcome(lane_id, "partial", (candidate,), code="github-endpoint-progress", progressed=True, state=state)
