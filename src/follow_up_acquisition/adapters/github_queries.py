"""Pure GitHub URL/query and fingerprint construction."""

from __future__ import annotations

import hashlib
from typing import Any, Iterable, Mapping
from urllib.parse import urlencode

from ..source_state import query_fingerprint
from .github_models import Window

DISCUSSION_TEMPLATE_VERSION = "github-discussions-template-v1"


def _frame(fields: Iterable[str]) -> bytes:
    out: list[bytes] = []
    for field in fields:
        encoded = field.encode("utf-8")
        out.extend((str(len(encoded)).encode("ascii"), b":", encoded))
    return b"".join(out)


def rest_search_text(query: Mapping[str, Any], entity: str, window: Window | None) -> str:
    filters = query.get("filters", {})
    parts = [query["query"]]
    if filters.get("owner"):
        parts.append(f"user:{filters['owner']}")
    if entity == "repository":
        if filters.get("language"):
            parts.append(f"language:{filters['language']}")
        parts.extend(f"topic:{value}" for value in filters.get("topics", ()))
        if filters.get("min_stars") is not None:
            parts.append(f"stars:>={filters['min_stars']}")
    if entity == "issue":
        parts.append("type:issue")
    elif entity == "pull-request":
        parts.append("type:pr")
    if window is not None:
        qualifier = "pushed" if entity == "repository" else "committer-date" if entity == "commit" else "updated"
        if window.start:
            parts.append(f"{qualifier}:>={window.start}")
        parts.append(f"{qualifier}:<={window.end}")
    return " ".join(parts)


def rest_search_url(query: Mapping[str, Any], entity: str, window: Window, page: int) -> str:
    path = "/search/repositories" if entity == "repository" else "/search/commits" if entity == "commit" else "/search/issues"
    per_page = 10 if entity in {"issue", "pull-request"} else 100
    sort = query["sort"] if entity == "repository" else "committer-date" if entity == "commit" else "updated"
    return "https://api.github.com" + path + "?" + urlencode({
        "q": rest_search_text(query, entity, window), "sort": sort,
        "order": "desc", "per_page": per_page, "page": page,
    })


def release_roster_url(query: Mapping[str, Any]) -> str:
    return "https://api.github.com/search/repositories?" + urlencode({
        "q": rest_search_text(query, "repository", None), "sort": query["sort"],
        "order": "desc", "per_page": 100, "page": 1,
    })


def release_roster_fingerprint(roster: Iterable[Mapping[str, str]]) -> str:
    items = tuple(roster)
    fields = ["github-release-roster-v1", str(len(items))]
    for item in items:
        fields.extend((item["name_with_owner"], item["node_id"]))
    return hashlib.sha256(_frame(fields)).hexdigest()


def discussion_search_text(query: Mapping[str, Any], window: Window) -> str:
    parts = [query["query"]]
    owner = query.get("filters", {}).get("owner")
    if owner:
        parts.append(f"user:{owner}")
    if query.get("sort") == "updated":
        parts.append("sort:updated-desc")
    if window.start:
        parts.append(f"updated:{window.start}..{window.end}")
    else:
        parts.append(f"updated:<={window.end}")
    return " ".join(parts)


def discussion_query_set_fingerprint(queries: Iterable[Mapping[str, Any]]) -> str:
    ordered = tuple(sorted(queries, key=lambda item: item["id"].encode("utf-8")))
    fields = ["github-discussions-v1", DISCUSSION_TEMPLATE_VERSION, str(len(ordered))]
    for query in ordered:
        fields.extend((query["id"], query_fingerprint("github", query)))
    return hashlib.sha256(_frame(fields)).hexdigest()
