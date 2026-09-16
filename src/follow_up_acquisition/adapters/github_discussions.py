"""One-quantum GitHub Discussions GraphQL state machine."""

from __future__ import annotations

from typing import Any, Mapping

from ..runtime import AdapterError, SourceCandidate
from .github_executor import GitHubExecutor
from .github_mapping import MappingSchemaDrift, MissingNodeIdentity, canonical_public_url, canonical_time
from .github_models import LaneOutcome, Window
from .github_queries import DISCUSSION_TEMPLATE_VERSION, discussion_search_text

_QUERY = """query($query:String!,$first:Int!,$after:String){search(query:$query,type:DISCUSSION,first:$first,after:$after){pageInfo{hasNextPage endCursor}nodes{... on Discussion{id url title bodyText createdAt updatedAt author{login} comments{totalCount} reactions{totalCount} repository{id nameWithOwner}}}}}"""


def graphql_error_status(errors: Any) -> tuple[str, str]:
    if not isinstance(errors, list) or not errors:
        return "error", "global"
    kinds = {item.get("type") if isinstance(item, Mapping) else None for item in errors}
    if kinds & {"RATE_LIMITED", "RATE_LIMITED_BY_IP"}:
        return "rate-limited", "global"
    if "UNAUTHENTICATED" in kinds:
        return "auth-failed", "global"
    if kinds & {"FORBIDDEN", "INSUFFICIENT_SCOPES"}:
        return "auth-failed", "discussion"
    if kinds & {"GRAPHQL_VALIDATION_FAILED", "BAD_USER_INPUT"}:
        return "schema-drift", "lane"
    return "error", "lane"


def _map(item: Mapping[str, Any], query_id: str, fetched_at: str) -> SourceCandidate:
    node = item.get("id")
    if type(node) is not str or not node:
        raise MissingNodeIdentity()
    repo = item.get("repository")
    if not isinstance(repo, Mapping) or type(repo.get("id")) is not str or not repo["id"]:
        raise MappingSchemaDrift()
    created = canonical_time(item.get("createdAt"))
    updated = canonical_time(item.get("updatedAt"))
    author = item.get("author")
    metrics = {"updated_at": updated}
    for key in ("comments", "reactions"):
        value = item.get(key)
        if isinstance(value, Mapping) and type(value.get("totalCount")) is int:
            metrics[key] = value["totalCount"]
    return SourceCandidate(
        native_id=f"github:discussion:{node}", url=canonical_public_url(item.get("url")),
        source_type="discussion", date_confidence="exact", fetched_at=fetched_at,
        title=item.get("title"), text=item.get("bodyText"),
        author=author.get("login") if isinstance(author, Mapping) else None,
        published_at=created, native_metrics=metrics,
        provenance={"query_id": query_id, "endpoint": "discussions", "parent_repository_id": f"github:repository:{repo['id']}"},
    )


class DiscussionMachine:
    def __init__(self, executor: GitHubExecutor) -> None:
        self.executor = executor

    def run(self, lane_id: str, query: Mapping[str, Any], window: Window,
            state: Mapping[str, Any] | None, fetched_at: str, *, first: int) -> LaneOutcome:
        if type(first) is not int or not 1 <= first <= 100:
            raise AdapterError("GitHub Discussion page size is invalid", status="schema-drift")
        after = state.get("after") if state else None
        if state:
            if set(state) != {"after", "window", "template", "pages_seen", "counts"}:
                raise AdapterError("GitHub Discussion cursor is invalid", status="schema-drift")
            if type(after) is not str or not after or state["window"] != window.to_dict() or state["template"] != DISCUSSION_TEMPLATE_VERSION:
                raise AdapterError("GitHub Discussion cursor is invalid", status="schema-drift")
            if type(state["pages_seen"]) is not int or not 1 <= state["pages_seen"] <= 10:
                raise AdapterError("GitHub Discussion cursor is invalid", status="schema-drift")
            counts = state["counts"]
            if type(counts) is not dict or set(counts) != {"entries_seen", "node_missing_seen", "valid_seen"} or any(
                type(value) is not int or not 0 <= value <= 1000 for value in counts.values()
            ):
                raise AdapterError("GitHub Discussion counts are invalid", status="schema-drift")
            counts = dict(counts)
            pages_seen = state["pages_seen"]
        else:
            counts = {"entries_seen": 0, "node_missing_seen": 0, "valid_seen": 0}
            pages_seen = 0
        response = self.executor.post_json("https://api.github.com/graphql", {
            "query": _QUERY, "variables": {"query": discussion_search_text(query, window),
                                             "first": min(first, 100), "after": after},
        })
        body = response.body
        if not isinstance(body, Mapping):
            raise AdapterError("GitHub Discussion schema drifted", status="schema-drift")
        if body.get("errors"):
            status, scope = graphql_error_status(body["errors"])
            if scope == "global":
                if status == "auth-failed":
                    self.executor.open_global_auth()
                elif status == "rate-limited":
                    self.executor.breaker.status = status
            elif scope == "discussion":
                self.executor.open_discussion_permission()
            return LaneOutcome(lane_id, status, code="github-discussion-failure")
        search = (body.get("data") or {}).get("search") if isinstance(body.get("data"), Mapping) else None
        if not isinstance(search, Mapping) or set(search) != {"pageInfo", "nodes"} or not isinstance(search["pageInfo"], Mapping):
            raise AdapterError("GitHub Discussion schema drifted", status="schema-drift")
        info, nodes = search["pageInfo"], search["nodes"]
        if set(info) != {"hasNextPage", "endCursor"} or type(info["hasNextPage"]) is not bool or type(nodes) is not list or len(nodes) > first or any(not isinstance(item, Mapping) for item in nodes):
            raise AdapterError("GitHub Discussion pageInfo is invalid", status="schema-drift")
        end = info["endCursor"]
        if info["hasNextPage"] and (type(end) is not str or not end or end == after):
            raise AdapterError("GitHub Discussion cursor is invalid", status="schema-drift")
        if not info["hasNextPage"] and end is not None and (type(end) is not str or not end):
            raise AdapterError("GitHub Discussion cursor is invalid", status="schema-drift")
        candidates = []
        missing = 0
        for item in nodes:
            try:
                candidates.append(_map(item, query["id"], fetched_at))
            except MissingNodeIdentity:
                missing += 1
            except MappingSchemaDrift:
                return LaneOutcome(lane_id, "schema-drift", code="github-item-schema-drift")
        counts["entries_seen"] += len(nodes)
        counts["node_missing_seen"] += missing
        counts["valid_seen"] += len(candidates)
        pages_seen += 1
        if (
            (not info["hasNextPage"] or pages_seen == 10)
            and counts["entries_seen"] and counts["valid_seen"] == 0
            and counts["node_missing_seen"] == counts["entries_seen"]
        ):
            return LaneOutcome(lane_id, "schema-drift", code="github-node-id-missing")
        if info["hasNextPage"]:
            if pages_seen == 10:
                self.executor.mark_validated_success()
                return LaneOutcome(lane_id, "partial", tuple(candidates), code="github-discussion-page-cap",
                                   progressed=True, complete=True, state={"complete": True})
            self.executor.mark_validated_success()
            return LaneOutcome(lane_id, "partial", tuple(candidates), code="github-endpoint-progress",
                               progressed=True, state={"after": end, "window": window.to_dict(),
                                                       "template": DISCUSSION_TEMPLATE_VERSION,
                                                       "pages_seen": pages_seen, "counts": counts})
        self.executor.mark_validated_success()
        return LaneOutcome(lane_id, "ok", tuple(candidates),
                           code="github-node-id-missing" if counts["node_missing_seen"] else None,
                           progressed=True, complete=True, state={"complete": True})
