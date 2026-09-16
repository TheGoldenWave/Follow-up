"""Pure payload-to-candidate mapping for GitHub entities."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping
from urllib.parse import urlsplit

from ..runtime import AdapterError, SourceCandidate


class MissingNodeIdentity(AdapterError):
    def __init__(self) -> None:
        super().__init__("GitHub item omitted node identity", status="schema-drift")


class MappingSchemaDrift(AdapterError):
    def __init__(self) -> None:
        super().__init__("GitHub item schema drifted", status="schema-drift")


def canonical_time(value: Any, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if type(value) is not str or not value:
        raise MappingSchemaDrift()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MappingSchemaDrift() from exc
    if parsed.tzinfo is None:
        raise MappingSchemaDrift()
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_public_url(value: Any) -> str:
    if type(value) is not str:
        raise MappingSchemaDrift()
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise MappingSchemaDrift() from exc
    if parsed.scheme != "https" or parsed.netloc != "github.com" or not parsed.path.startswith("/") or "\\" in parsed.path:
        raise MappingSchemaDrift()
    return "https://github.com" + (parsed.path.rstrip("/") or "/")


def map_repository(item: Mapping[str, Any], query_id: str, fetched_at: str) -> SourceCandidate:
    node = item.get("node_id")
    if type(node) is not str or not node:
        raise MissingNodeIdentity()
    updated = canonical_time(item.get("updated_at"))
    created = canonical_time(item.get("created_at"), optional=True) or updated
    metrics = {"updated_at": updated}
    for source, target in (("stargazers_count", "stars"), ("forks_count", "forks"), ("watchers_count", "watchers")):
        value = item.get(source)
        if type(value) is int and value >= 0:
            metrics[target] = value
    owner = item.get("owner")
    return SourceCandidate(
        native_id=f"github:repository:{node}", url=canonical_public_url(item.get("html_url")),
        source_type="repository", date_confidence="exact", fetched_at=fetched_at,
        title=item.get("full_name") if type(item.get("full_name")) is str else item.get("name"),
        text=item.get("description") if type(item.get("description")) is str else None,
        author=owner.get("login") if isinstance(owner, Mapping) and type(owner.get("login")) is str else None,
        published_at=created, native_metrics=metrics,
        provenance={"query_id": query_id, "endpoint": "repository"},
    )


def map_release(item: Mapping[str, Any], query_id: str, fetched_at: str, repository_node_id: str) -> SourceCandidate:
    node = item.get("node_id")
    if type(node) is not str or not node:
        raise MissingNodeIdentity()
    published = canonical_time(item.get("published_at"), optional=True) or canonical_time(item.get("created_at"))
    author = item.get("author")
    return SourceCandidate(
        native_id=f"github:release:{node}", url=canonical_public_url(item.get("html_url")),
        source_type="release", date_confidence="exact", fetched_at=fetched_at,
        title=item.get("name") or item.get("tag_name"), text=item.get("body") if type(item.get("body")) is str else None,
        author=author.get("login") if isinstance(author, Mapping) and type(author.get("login")) is str else None,
        published_at=published, native_metrics={"updated_at": published},
        provenance={"query_id": query_id, "endpoint": "release", "parent_repository_id": f"github:repository:{repository_node_id}"},
    )


def map_commit(item: Mapping[str, Any], query_id: str, fetched_at: str) -> SourceCandidate:
    repository = item.get("repository")
    repo_node = repository.get("node_id") if isinstance(repository, Mapping) else None
    sha = item.get("sha")
    if type(repo_node) is not str or not repo_node:
        raise MissingNodeIdentity()
    if type(sha) is not str or not 7 <= len(sha) <= 64 or any(ch not in "0123456789abcdefABCDEF" for ch in sha):
        raise MappingSchemaDrift()
    commit = item.get("commit")
    if not isinstance(commit, Mapping):
        raise MappingSchemaDrift()
    author_data = commit.get("author") if isinstance(commit.get("author"), Mapping) else {}
    committer = commit.get("committer") if isinstance(commit.get("committer"), Mapping) else {}
    published = canonical_time(author_data.get("date"), optional=True)
    updated = canonical_time(committer.get("date"), optional=True) or published
    if updated is None:
        raise MappingSchemaDrift()
    author = item.get("author")
    message = commit.get("message") if type(commit.get("message")) is str else None
    return SourceCandidate(
        native_id=f"github:commit:{repo_node}:{sha.lower()}",
        url=canonical_public_url(item.get("html_url")), source_type="commit",
        date_confidence="exact" if published else "inferred", fetched_at=fetched_at,
        title=message.splitlines()[0] if message else None, text=message,
        author=author.get("login") if isinstance(author, Mapping) and type(author.get("login")) is str else author_data.get("name"),
        published_at=published or updated, native_metrics={"updated_at": updated},
        provenance={"query_id": query_id, "endpoint": "commit", "parent_repository_id": f"github:repository:{repo_node}"},
    )


def map_issue(
    item: Mapping[str, Any], query_id: str, fetched_at: str,
    repository_node_id: str, *, pull_request: bool,
) -> SourceCandidate:
    node = item.get("node_id")
    if type(node) is not str or not node:
        raise MissingNodeIdentity()
    if pull_request and not isinstance(item.get("pull_request"), Mapping):
        raise MappingSchemaDrift()
    created = canonical_time(item.get("created_at"))
    updated = canonical_time(item.get("updated_at"))
    user = item.get("user")
    entity = "pull-request" if pull_request else "issue"
    metrics: dict[str, Any] = {"updated_at": updated}
    for key in ("comments",):
        if type(item.get(key)) is int and item[key] >= 0:
            metrics[key] = item[key]
    reactions = item.get("reactions")
    if isinstance(reactions, Mapping) and type(reactions.get("total_count")) is int and reactions["total_count"] >= 0:
        metrics["reactions"] = reactions["total_count"]
    if item.get("state") in {"open", "closed"}:
        metrics["state"] = item["state"]
    return SourceCandidate(
        native_id=f"github:{entity}:{node}", url=canonical_public_url(item.get("html_url")),
        source_type=entity, date_confidence="exact", fetched_at=fetched_at,
        title=item.get("title"), text=item.get("body") if type(item.get("body")) is str else None,
        author=user.get("login") if isinstance(user, Mapping) and type(user.get("login")) is str else None,
        published_at=created, native_metrics=metrics,
        provenance={"query_id": query_id, "endpoint": entity, "parent_repository_id": f"github:repository:{repository_node_id}"},
    )
