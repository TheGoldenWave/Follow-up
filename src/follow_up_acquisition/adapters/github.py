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
_MAX_DEPTH = 10
_DEFAULT_DEPTH = 3
_PAGE_SIZE = 100
_MAX_STREAMS = 128

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
        for query in queries:
            stream_id = f"query.{query['id']}"
            previous = streams.get(stream_id)
            try:
                fingerprint = query_fingerprint("github", query)
                self._verify_fingerprint(previous, fingerprint)
                found, update, missing = self._collect_rest_query(
                    source, query, request, config["budget"], headers, previous, now, fingerprint,
                )
                candidates.extend(found)
                updates.append(update)
                outcomes.append((stream_id, "ok", True))
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
                found, update, missing = self._collect_discussions(
                    source, queries, request, config["budget"], headers, previous, now,
                )
                candidates.extend(found)
                updates.append(update)
                outcomes.append(("discussions", "ok", True))
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
        if failed and len(identity_failures) == len(failed):
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
        self, source: str, query: Mapping[str, Any], request: dict[str, Any], budget: int,
        headers: dict[str, str], previous: Mapping[str, Any] | None, now: str, fingerprint: str,
    ) -> tuple[list[SourceCandidate], CheckpointUpdate, bool]:
        entities = set(query["filters"]["entities"])
        depth = request.get("depth", _DEFAULT_DEPTH)
        previous_cursor = previous.get("cursor", {}) if previous else {}
        if not isinstance(previous_cursor, Mapping):
            raise AdapterError("GitHub checkpoint cursor is invalid", status="schema-drift")
        effective_request = self._effective_request(request, previous, previous_cursor, now)
        repo_start = self._cursor_page(previous_cursor, "repository_page")
        query_headers = dict(headers)
        if previous and entities == {"repository"} and repo_start == 1 and not previous_cursor:
            if isinstance(previous.get("etag"), str):
                query_headers["If-None-Match"] = previous["etag"]
            if isinstance(previous.get("last_modified"), str):
                query_headers["If-Modified-Since"] = previous["last_modified"]
        results: list[SourceCandidate] = []
        repo_nodes: dict[str, str] = {}
        missing = False
        validators: tuple[str | None, str | None] = (None, None)

        # Repository search is both a candidate endpoint and bounded discovery
        # for release parent repositories.
        repo_response, repo_items, repo_next = self._search_pages(
            "/search/repositories", self._search_text(query, "repository", effective_request), depth,
            query_headers, label="repositories", sort=query["sort"], start_page=repo_start,
        )
        validators = (repo_response.etag, repo_response.last_modified)
        if repo_response.status == 304 and entities == {"repository"}:
            return [], self._checkpoint(
                f"query.{query['id']}", previous, now, effective_request,
                previous.get("recent_native_ids", ()) if previous else (),
                previous.get("etag") if previous else None,
                previous.get("last_modified") if previous else None, fingerprint,
                cursor=previous_cursor, complete=not bool(previous_cursor),
            ), False
        cursor: dict[str, Any] = {}
        if repo_next is not None:
            cursor["repository_page"] = repo_next
        mapped_repos: list[SourceCandidate] = []
        for item in repo_items:
            full_name = _text(item.get("full_name")) if isinstance(item, Mapping) else None
            node_id = _text(item.get("node_id")) if isinstance(item, Mapping) else None
            if full_name and node_id and _REPO_NAME_RE.fullmatch(full_name):
                repo_nodes[full_name.lower()] = node_id
            mapped = self._map_rest("repository", item, query, now, repo_nodes)
            if mapped is None:
                missing = True
            elif "repository" in entities:
                mapped_repos.append(mapped)
        if repo_items and not any(_text(item.get("node_id")) for item in repo_items if isinstance(item, Mapping)):
            raise _NodeIdentityMissing("repository endpoint")
        results.extend(mapped_repos)

        if "release" in entities:
            release_pages: dict[str, dict[str, Any]] = {}
            old_release_pages = previous_cursor.get("release_pages", {})
            if not isinstance(old_release_pages, Mapping):
                raise AdapterError("GitHub release cursor is invalid", status="schema-drift")
            release_targets = dict(repo_nodes)
            for full_name, saved in old_release_pages.items():
                if not isinstance(full_name, str) or not isinstance(saved, Mapping):
                    raise AdapterError("GitHub release cursor is invalid", status="schema-drift")
                saved_node = _text(saved.get("repository_node_id"))
                if saved_node:
                    release_targets[full_name] = saved_node
            for full_name in sorted(release_targets, key=lambda value: value.encode("utf-8")):
                saved = old_release_pages.get(full_name, {})
                start_page = saved.get("page", 1) if isinstance(saved, Mapping) else 1
                if type(start_page) is not int or start_page < 1:
                    raise AdapterError("GitHub release cursor is invalid", status="schema-drift")
                items, release_next = self._release_pages(full_name, start_page, depth, headers)
                mapped_count = 0
                for item in items:
                    mapped = self._map_rest("release", item, query, now, release_targets, full_name)
                    if mapped is None:
                        missing = True
                    else:
                        results.append(mapped)
                        mapped_count += 1
                if items and mapped_count == 0:
                    raise _NodeIdentityMissing("release endpoint")
                if release_next is not None:
                    release_pages[full_name] = {
                        "page": release_next,
                        "repository_node_id": release_targets[full_name],
                    }
            if release_pages:
                cursor["release_pages"] = release_pages

        endpoint_entities = (
            ("commit", "/search/commits", "committer-date"),
            ("issue", "/search/issues", "updated"),
            ("pull-request", "/search/issues", "updated"),
        )
        for entity, path, api_sort in endpoint_entities:
            if entity not in entities:
                continue
            cursor_key = entity.replace("-", "_") + "_page"
            start_page = self._cursor_page(previous_cursor, cursor_key)
            _response, items, next_page = self._search_pages(
                path, self._search_text(query, entity, effective_request), depth, headers, label=entity,
                sort=api_sort, start_page=start_page,
            )
            if next_page is not None:
                cursor[cursor_key] = next_page
            mapped_count = 0
            for item in items:
                mapped = self._map_rest(entity, item, query, now, repo_nodes)
                if mapped is None:
                    missing = True
                else:
                    results.append(mapped)
                    mapped_count += 1
            if items and mapped_count == 0:
                raise _NodeIdentityMissing(f"{entity} endpoint")

        results = self._finalize(results, effective_request, MAX_RECENT_NATIVE_IDS)
        native_ids = [item.native_id for item in results]
        if cursor:
            cursor["window"] = dict(effective_request["window"])
        recent = self._merge_recent(previous, native_ids)
        update = self._checkpoint(
            f"query.{query['id']}", previous, now, effective_request, recent,
            validators[0], validators[1], fingerprint, cursor=cursor,
            complete=not cursor,
        )
        return results, update, missing

    def _search_pages(
        self, path: str, query_text: str, depth: int, headers: Mapping[str, str], *,
        label: str, sort: str, start_page: int,
    ) -> tuple[HttpResponse, list[Mapping[str, Any]], int | None]:
        all_items: list[Mapping[str, Any]] = []
        first_response: HttpResponse | None = None
        next_page: int | None = start_page
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
                return response, [], None
            if not isinstance(response.body, Mapping) or type(response.body.get("items")) is not list:
                raise AdapterError(f"{label} response schema drifted", status="schema-drift")
            items = response.body["items"]
            if any(not isinstance(item, Mapping) for item in items):
                raise AdapterError(f"{label} response schema drifted", status="schema-drift")
            all_items.extend(items)
            total = response.body.get("total_count")
            if type(total) is int and total > 1000:
                raise AdapterError("GitHub search exceeds the 1000-result API cap", status="schema-drift")
            complete = not items or len(items) < _PAGE_SIZE
            if type(total) is int and page * _PAGE_SIZE >= total:
                complete = True
            if complete:
                next_page = None
                break
            next_page = page + 1
        assert first_response is not None
        return first_response, all_items, next_page

    def _release_pages(
        self, full_name: str, start_page: int, depth: int, headers: Mapping[str, str],
    ) -> tuple[list[Mapping[str, Any]], int | None]:
        items: list[Mapping[str, Any]] = []
        next_page: int | None = start_page
        for page in range(start_page, start_page + depth):
            url = f"https://api.github.com/repos/{quote(full_name, safe='/')}/releases?" + urlencode({
                "per_page": _PAGE_SIZE, "page": page,
            })
            response = self._http.get(
                url, allowed_hosts=_API_HOSTS, allowed_paths=_REST_PATHS, headers=headers,
            )
            page_items = self._list_body(response, "releases")
            items.extend(page_items)
            if len(page_items) < _PAGE_SIZE:
                next_page = None
                break
            next_page = page + 1
        return items, next_page

    @staticmethod
    def _cursor_page(cursor: Mapping[str, Any], key: str) -> int:
        value = cursor.get(key, 1)
        if type(value) is not int or not 1 <= value <= 10:
            raise AdapterError("GitHub checkpoint cursor is invalid", status="schema-drift")
        return value

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
        if filters.get("language"):
            parts.append(f"language:{filters['language']}")
        if filters.get("owner"):
            parts.append(f"user:{filters['owner']}")
        for topic in filters.get("topics", ()):
            parts.append(f"topic:{topic}")
        if entity == "repository" and filters.get("min_stars") is not None:
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
        cursor: Mapping[str, Any], now: str,
    ) -> Mapping[str, Any]:
        frozen_window = cursor.get("window")
        if frozen_window is not None:
            if not isinstance(frozen_window, Mapping) or set(frozen_window) != {"start", "end"}:
                raise AdapterError("GitHub checkpoint window is invalid", status="schema-drift")
            for value in frozen_window.values():
                if value is not None:
                    _parse_time(value, "checkpoint window")
            return {**request, "window": dict(frozen_window)}
        if isinstance(request.get("window"), Mapping):
            return request
        start = previous.get("successful_window_end") if previous else None
        return {**request, "window": {"start": start, "end": now}}

    def _map_rest(
        self, entity: str, item: Any, query: Mapping[str, Any], fetched_at: str,
        repo_nodes: Mapping[str, str], parent_name: str | None = None,
    ) -> SourceCandidate | None:
        if not isinstance(item, Mapping):
            return None
        parent_id: str | None = None
        if entity == "commit":
            sha = _text(item.get("sha"))
            repository = item.get("repository")
            repo_node = _text(repository.get("node_id")) if isinstance(repository, Mapping) else None
            if not sha or not repo_node:
                return None
            native_id = f"github:commit:{repo_node}:{sha.lower()}"
            parent_id = f"github:repository:{repo_node}"
        else:
            node_id = _text(item.get("node_id"))
            if not node_id:
                return None
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
            return None

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
            updated = _text(committer.get("date")) or _text(author_meta.get("date"))
            published = _text(author_meta.get("date"))
            title = (_text(commit.get("message")) or "").splitlines()[0] or None
            text = _text(commit.get("message"))
            author = _text((item.get("author") or {}).get("login")) if isinstance(item.get("author"), Mapping) else None
            author = author or _text(author_meta.get("name"))
        elif entity == "release":
            updated = _text(item.get("published_at")) or _text(item.get("created_at"))
            published = updated
            title = _text(item.get("name")) or _text(item.get("tag_name"))
            text = _text(item.get("body"))
            author = _text((item.get("author") or {}).get("login")) if isinstance(item.get("author"), Mapping) else None
        elif entity == "repository":
            updated = _text(item.get("updated_at"))
            published = _text(item.get("created_at")) or updated
            title = _text(item.get("full_name")) or _text(item.get("name"))
            text = _text(item.get("description"))
            author = _text((item.get("owner") or {}).get("login")) if isinstance(item.get("owner"), Mapping) else None
        else:
            updated = _text(item.get("updated_at"))
            published = _text(item.get("created_at")) or updated
            title, text = _text(item.get("title")), _text(item.get("body"))
            author = _text((item.get("user") or {}).get("login")) if isinstance(item.get("user"), Mapping) else None
        if updated:
            metrics["updated_at"] = updated
        provenance: dict[str, Any] = {"query_id": query["id"], "endpoint": entity}
        if parent_id:
            provenance["parent_repository_id"] = parent_id
        return SourceCandidate(
            native_id=native_id, url=url, source_type=entity,
            date_confidence="exact" if published else "unknown", fetched_at=fetched_at,
            title=title, text=text, author=author, published_at=published,
            native_metrics=metrics, provenance=provenance,
        )

    def _collect_discussions(
        self, source: str, queries: list[Mapping[str, Any]], request: dict[str, Any], budget: int,
        headers: dict[str, str], previous: Mapping[str, Any] | None, now: str,
    ) -> tuple[list[SourceCandidate], CheckpointUpdate, bool]:
        depth = request.get("depth", _DEFAULT_DEPTH)
        previous_cursor = previous.get("cursor", {}) if previous else {}
        if not isinstance(previous_cursor, Mapping):
            raise AdapterError("GitHub discussions cursor is invalid", status="schema-drift")
        resume_query = previous_cursor.get("query_id")
        resume_after = previous_cursor.get("after")
        if resume_query is not None and resume_query not in {query["id"] for query in queries}:
            raise AdapterError("GitHub discussions cursor is invalid", status="schema-drift")
        if resume_after is not None and not isinstance(resume_after, str):
            raise AdapterError("GitHub discussions cursor is invalid", status="schema-drift")
        effective_request = self._effective_request(request, previous, previous_cursor, now)
        results: list[SourceCandidate] = []
        missing = False
        cursor: dict[str, str] = {}
        etag = last_modified = None
        start_index = 0
        if resume_query is not None:
            start_index = next(index for index, query in enumerate(queries) if query["id"] == resume_query)
        truncated = False
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
                mapped_count = 0
                for item in nodes:
                    mapped = self._map_discussion(item, query, now)
                    if mapped is None:
                        missing = True
                    else:
                        results.append(mapped)
                        mapped_count += 1
                if nodes and mapped_count == 0:
                    raise _NodeIdentityMissing("discussion endpoint")
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
            if truncated:
                break
            resume_after = None
        results = self._finalize(results, effective_request, MAX_RECENT_NATIVE_IDS)
        native_ids = [item.native_id for item in results]
        if cursor:
            cursor["window"] = dict(effective_request["window"])
        update = self._checkpoint(
            "discussions", previous, now, effective_request, self._merge_recent(previous, native_ids),
            etag, last_modified, None, cursor=cursor, complete=not truncated,
        )
        return results, update, missing

    @staticmethod
    def _discussion_search_text(
        query: Mapping[str, Any], request: Mapping[str, Any],
    ) -> str:
        parts = [query["query"]]
        filters = query.get("filters", {})
        if filters.get("owner"):
            parts.append(f"user:{filters['owner']}")
        if filters.get("language"):
            parts.append(f"language:{filters['language']}")
        for topic in filters.get("topics", ()):
            parts.append(f"topic:{topic}")
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
        if isinstance(errors, list):
            types = {
                error.get("type") for error in errors if isinstance(error, Mapping)
            }
            if types & {"RATE_LIMITED", "RATE_LIMITED_BY_IP"}:
                return "rate-limited"
        return "auth-failed"

    def _map_discussion(
        self, item: Any, query: Mapping[str, Any], fetched_at: str,
    ) -> SourceCandidate | None:
        if not isinstance(item, Mapping):
            return None
        node_id = _text(item.get("id"))
        url = self._canonical_public_url(_text(item.get("url")))
        if not node_id or url is None:
            return None
        repository = item.get("repository")
        repo_id = _text(repository.get("id")) if isinstance(repository, Mapping) else None
        updated = _text(item.get("updatedAt"))
        metrics: dict[str, Any] = {}
        for key in ("comments", "reactions"):
            value = item.get(key)
            parsed = _count(value.get("totalCount")) if isinstance(value, Mapping) else None
            if parsed is not None:
                metrics[key] = parsed
        if updated:
            metrics["updated_at"] = updated
        provenance: dict[str, Any] = {"query_id": query["id"], "endpoint": "discussions"}
        if repo_id:
            provenance["parent_repository_id"] = f"github:repository:{repo_id}"
        author = item.get("author")
        return SourceCandidate(
            native_id=f"github:discussion:{node_id}", url=url, source_type="discussion",
            date_confidence="exact" if item.get("createdAt") else "unknown", fetched_at=fetched_at,
            title=_text(item.get("title")), text=_text(item.get("bodyText")),
            author=_text(author.get("login")) if isinstance(author, Mapping) else None,
            published_at=_text(item.get("createdAt")), native_metrics=metrics,
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
