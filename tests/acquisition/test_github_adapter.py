from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from follow_up_acquisition.http_client import HttpResponse
from follow_up_acquisition.runtime import (
    AcquisitionRuntime,
    AdapterError,
    validate_checkpoint_updates,
)
from follow_up_acquisition.source_state import query_fingerprint

from follow_up_acquisition.adapters.github import GitHubAdapter


FIXTURES = Path(__file__).parent / "fixtures" / "github"
NOW = "2026-09-15T08:00:00Z"


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def source(*, entities=None, include_discussions=False, budget=20, queries=None, **extra):
    query = {
        "id": "agents",
        "query": "agentic systems",
        "sort": "updated",
        "filters": {"entities": entities or ["repository"]},
    }
    value = {
        "id": "community:github",
        "adapter": "github",
        "budget": budget,
        "input": {
            "rest_api_url": "https://api.github.com",
            "graphql_url": "https://api.github.com/graphql",
            "include_discussions": include_discussions,
            "queries": queries or [query],
        },
    }
    value.update(extra)
    return value


class FakeClient:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, copy.deepcopy(kwargs)))
        return self.handler("GET", url, kwargs)

    def post_json(self, url, payload, **kwargs):
        kwargs["payload"] = payload
        self.calls.append(("POST", url, copy.deepcopy(kwargs)))
        return self.handler("POST", url, kwargs)


def response(url, body, *, status=200, etag=None, last_modified=None):
    if isinstance(body, dict) and "total_count" in body and "incomplete_results" not in body:
        body = {**body, "incomplete_results": False}
    return HttpResponse(status, url, body, etag, last_modified)


class GitHubAdapterTests(unittest.TestCase):
    def make_adapter(
        self, config, handler, credential_resolver=lambda _source_id: None,
        checkpoint=None,
    ):
        def tagged(source_id):
            value = credential_resolver(source_id)
            if isinstance(value, dict):
                return value
            if value is None:
                return {"status": "absent"}
            return {"status": "resolved", "token": value}

        return GitHubAdapter(
            resolve_source=lambda source_id: config if source_id == "community:github" else None,
            http_client=FakeClient(handler),
            clock=lambda: NOW,
            credential_resolver=tagged,
            checkpoint_resolver=lambda source_id: checkpoint if source_id == "community:github" else None,
        )

    def test_maps_all_rest_entity_fixtures_to_stable_public_candidates(self):
        data = fixture("entities.json")

        def handler(_method, url, _kwargs):
            path = urlsplit(url).path
            query = parse_qs(urlsplit(url).query).get("q", [""])[0]
            if path == "/search/repositories":
                return response(url, {"total_count": 1, "items": [data["repository"]]})
            if path == "/repos/acme/agent/releases":
                return response(url, [data["release"]])
            if path == "/repos/acme/agent":
                return response(url, data["repository"])
            if path == "/search/commits":
                return response(url, {"total_count": 1, "items": [data["commit"]]})
            if path == "/search/issues" and "type:pr" in query:
                return response(url, {"total_count": 1, "items": [data["pull-request"]]})
            if path == "/search/issues":
                return response(url, {"total_count": 1, "items": [data["issue"]]})
            self.fail(f"unexpected fixture URL path {path}")

        config = source(entities=["repository", "release", "commit", "issue", "pull-request"])
        adapter = self.make_adapter(config, handler)
        result = adapter.collect("community:github", {"mode": "shadow"})

        self.assertEqual(result.status, "ok")
        self.assertEqual(
            {item.native_id for item in result.candidates},
            {
                "github:repository:R_repo", "github:release:RE_release",
                "github:commit:R_repo:abcdef1234", "github:issue:I_issue",
                "github:pull-request:PR_pull",
            },
        )
        self.assertTrue(all(item.url.startswith("https://github.com/") for item in result.candidates))
        repo = next(item for item in result.candidates if item.source_type == "repository")
        self.assertEqual(repo.native_metrics, {
            "stars": 120, "forks": 12, "watchers": 40,
            "updated_at": "2026-09-15T07:00:00Z",
        })
        self.assertEqual(repo.provenance["query_id"], "agents")
        self.assertNotIn("token", json.dumps(result, default=lambda obj: obj.__dict__).lower())

    def test_discussion_is_explicit_authenticated_post_stream(self):
        data = fixture("discussion.json")
        resolved = []

        def handler(method, url, kwargs):
            if method == "POST":
                self.assertEqual(url, "https://api.github.com/graphql")
                self.assertEqual(kwargs["headers"]["Authorization"], "Bearer top-secret")
                return response(url, data)
            return response(url, {"total_count": 0, "items": []})

        config = source(include_discussions=True)
        adapter = self.make_adapter(config, handler, lambda source_id: resolved.append(source_id) or "top-secret")
        result = adapter.collect("community:github", {"mode": "shadow"})

        self.assertEqual(resolved, ["community:github"])
        discussion = next(item for item in result.candidates if item.source_type == "discussion")
        self.assertEqual(discussion.native_id, "github:discussion:D_discussion")
        self.assertEqual(discussion.provenance["parent_repository_id"], "github:repository:R_repo")
        self.assertEqual({u.stream_id for u in result.checkpoint_updates}, {"query.agents", "discussions", "scheduler"})

    def test_discussion_depth_cursor_resumes_and_does_not_advance_window_early(self):
        calls = []
        pages = [
            {"data": {"search": {"nodes": [], "pageInfo": {"hasNextPage": True, "endCursor": "next"}}}},
            {"data": {"search": {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": "done"}}}},
        ]

        def first_handler(method, url, kwargs):
            if method == "POST":
                calls.append(kwargs["payload"]["variables"])
                return response(url, pages[0])
            return response(url, {"total_count": 0, "items": []})

        first = self.make_adapter(
            source(include_discussions=True), first_handler, lambda _source_id: "token",
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        discussion_update = next(u for u in first.checkpoint_updates if u.stream_id == "discussions")
        cursor = discussion_update.checkpoint["cursor"]
        self.assertEqual(cursor["window"], {"start": None, "end": NOW})
        self.assertEqual(cursor["queries"]["agents"]["after"], "next")
        self.assertEqual(cursor["queries"]["agents"]["counts"], {
            "entries_seen": 0, "node_missing_seen": 0, "valid_seen": 0,
        })
        self.assertIsNone(discussion_update.checkpoint["successful_window_end"])

        previous = dict(discussion_update.checkpoint)
        previous["checkpoint_at"] = "2026-09-15T07:00:00Z"

        def second_handler(method, url, kwargs):
            if method == "POST":
                calls.append(kwargs["payload"]["variables"])
                self.assertIn("updated:<=2026-09-15T08:00:00Z", kwargs["payload"]["variables"]["query"])
                self.assertNotIn("2026-09-16", kwargs["payload"]["variables"]["query"])
                return response(url, pages[1])
            return response(url, {"total_count": 0, "items": []})

        second = GitHubAdapter(
            resolve_source=lambda _source_id: source(include_discussions=True),
            http_client=FakeClient(second_handler), clock=lambda: "2026-09-16T08:00:00Z",
            credential_resolver=lambda _source_id: {"status": "resolved", "token": "token"},
            checkpoint_resolver=lambda _source_id: {"streams": {"discussions": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual(calls[-1]["after"], "next")
        completed = next(u for u in second.checkpoint_updates if u.stream_id == "discussions")
        self.assertEqual(completed.checkpoint["cursor"], {})
        self.assertEqual(completed.checkpoint["successful_window_end"], NOW)

    def test_discussion_payload_uses_raw_registry_text_and_request_window_only(self):
        query = {
            "id": "filtered", "query": "agent systems", "sort": "updated",
            "filters": {
                "entities": ["repository"], "owner": "acme", "language": "Python",
                "topics": ["agents"],
            },
        }

        def handler(method, url, kwargs):
            if method == "POST":
                search = kwargs["payload"]["variables"]["query"]
                self.assertEqual(
                    search,
                    "agent systems user:acme sort:updated-desc "
                    "updated:2026-09-14T00:00:00Z..2026-09-15T08:00:00Z",
                )
                return response(url, {
                    "data": {"search": {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": None}}}
                })
            return response(url, {"total_count": 0, "items": []})

        self.make_adapter(
            source(queries=[query], include_discussions=True), handler,
            lambda _source_id: "token",
        ).collect(
            "community:github",
            {"mode": "shadow", "window": {"start": "2026-09-14T00:00:00Z", "end": NOW}},
        )

    def test_discussions_disabled_still_resolves_optional_rest_credential_but_never_graphql(self):
        resolved = []
        def optional(source_id):
            resolved.append(source_id)
            return None

        adapter = self.make_adapter(
            source(include_discussions=False),
            lambda _m, url, _k: response(url, {"total_count": 0, "items": []}),
            optional,
        )
        result = adapter.collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "no-results")
        self.assertEqual(resolved, ["community:github"])
        self.assertEqual([u.stream_id for u in result.checkpoint_updates], ["query.agents", "scheduler"])

    def test_missing_discussion_credential_is_auth_failed_without_rest_requests(self):
        client = FakeClient(lambda method, url, _kwargs: response(url, {"total_count": 0, "items": []}) if method == "GET" else self.fail("missing token must not call GraphQL"))
        adapter = GitHubAdapter(
            resolve_source=lambda _s: source(include_discussions=True), http_client=client,
            clock=lambda: NOW, credential_resolver=lambda _source_id: {"status": "absent"},
            checkpoint_resolver=lambda _source_id: None,
        )
        result = adapter.collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "partial")
        self.assertEqual(result.code, "github-discussion-credential-missing")

    def test_configured_token_is_used_for_rest_and_never_falls_back_anonymous(self):
        calls = []

        def handler(_method, url, kwargs):
            calls.append(kwargs["headers"])
            raise AdapterError("secret response", status="auth-failed", retryable=False)

        adapter = self.make_adapter(
            source(include_discussions=True), handler,
            lambda _ref: "github_pat_super-secret-material-1234567890",
        )
        result = adapter.collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "auth-failed")
        self.assertGreaterEqual(len(calls), 1)
        self.assertTrue(all("Authorization" in headers for headers in calls))
        self.assertNotIn("secret", (result.message or "").lower())

    def test_missing_node_ids_are_dropped_and_all_missing_is_schema_drift(self):
        item = fixture("entities.json")["repository"]
        missing = {**item, "id": 123}
        missing.pop("node_id")
        adapter = self.make_adapter(
            source(), lambda _m, url, _k: response(url, {"total_count": 1, "items": [missing]}),
        )
        result = adapter.collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.code, "github-node-id-missing")
        self.assertEqual(result.candidates, ())

    def test_candidate_url_is_canonical_public_github_page(self):
        item = {
            **fixture("entities.json")["repository"],
            "html_url": "https://github.com/acme/agent/?utm_source=fixture#readme",
        }
        result = self.make_adapter(
            source(), lambda _m, url, _k: response(url, {"total_count": 1, "items": [item]}),
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.candidates[0].url, "https://github.com/acme/agent")

    def test_successful_streams_checkpoint_and_failed_stream_does_not(self):
        queries = [
            {"id": "alpha", "query": "alpha", "sort": "updated", "filters": {"entities": ["repository"]}},
            {"id": "beta", "query": "beta", "sort": "updated", "filters": {"entities": ["repository"]}},
        ]
        state = {
            "streams": {
                "query.alpha": {
                    "checkpoint_at": "2026-09-14T08:00:00Z",
                    "cursor": {
                        "window": {"start": "2026-09-14T00:00:00Z", "end": NOW},
                        "endpoints": {"repository": {
                            "phase": "search", "window": {"start": "2026-09-14T00:00:00Z", "end": NOW},
                            "page": 2, "expected_total_count": 100,
                            "counts": {"entries_seen": 100, "node_missing_seen": 0, "valid_seen": 100},
                        }},
                    }, "etag": '"old"', "last_modified": None,
                    "recent_native_ids": ["github:repository:R_old"],
                    "successful_window_end": "2026-09-14T08:00:00Z",
                    "query_fingerprint": query_fingerprint("github", queries[0]),
                }
            }
        }
        config = source(queries=queries)

        def handler(_method, url, _kwargs):
            q = parse_qs(urlsplit(url).query)["q"][0]
            if q.startswith("beta"):
                raise AdapterError("rate details", status="rate-limited", retryable=True)
            return response(url, {"total_count": 100, "items": []}, etag='"new"')

        result = self.make_adapter(config, handler, checkpoint=state).collect(
            "community:github",
            {"mode": "shadow", "window": {"start": "2026-09-14T00:00:00Z", "end": NOW}},
        )
        self.assertEqual(result.status, "partial")
        self.assertEqual([u.stream_id for u in result.checkpoint_updates], ["query.alpha", "scheduler"])
        update = result.checkpoint_updates[0]
        self.assertEqual(update.previous_checkpoint_at, "2026-09-14T08:00:00Z")
        self.assertEqual(update.checkpoint["query_fingerprint"], query_fingerprint("github", queries[0]))
        self.assertEqual(update.checkpoint["successful_window_end"], NOW)

    def test_304_is_complete_empty_and_keeps_stream_active(self):
        query = {"id": "agents", "query": "agent", "sort": "updated", "filters": {"entities": ["repository"]}}
        old = {
            "checkpoint_at": "2026-09-14T08:00:00Z", "cursor": {},
            "etag": '"etag"', "last_modified": "Mon, 14 Sep 2026 08:00:00 GMT",
            "recent_native_ids": ["github:repository:R_old"],
            "successful_window_end": "2026-09-14T08:00:00Z",
            "query_fingerprint": query_fingerprint("github", query),
        }
        config = source(queries=[query])

        def handler(_method, url, kwargs):
            return response(url, None, status=304, etag='"etag"')

        result = self.make_adapter(
            config, handler, checkpoint={"streams": {"query.agents": old}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "no-results")
        self.assertEqual(result.checkpoint_updates[0].checkpoint["recent_native_ids"], ["github:repository:R_old"])

    def test_prior_successful_window_is_used_for_incremental_collection(self):
        query = {"id": "agents", "query": "agent", "sort": "updated", "filters": {"entities": ["repository"]}}
        previous = {
            "checkpoint_at": "2026-09-14T08:00:00Z", "cursor": {}, "etag": None,
            "last_modified": None, "recent_native_ids": [],
            "successful_window_end": "2026-09-14T08:00:00Z",
            "query_fingerprint": query_fingerprint("github", query),
        }
        old = {**fixture("entities.json")["repository"], "node_id": "R_old", "updated_at": "2026-09-13T08:00:00Z"}

        def handler(_method, url, _kwargs):
            self.assertIn("pushed:>=2026-09-14", parse_qs(urlsplit(url).query)["q"][0])
            return response(url, {"total_count": 1, "items": [old]})

        result = self.make_adapter(
            source(queries=[query]), handler,
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.status, "no-results")

    def test_filter_dedupe_utf8_sort_then_global_budget_and_query_reorder(self):
        queries = [
            {"id": "zeta", "query": "x", "sort": "updated", "filters": {"entities": ["repository"]}},
            {"id": "alpha", "query": "x", "sort": "updated", "filters": {"entities": ["repository"]}},
        ]
        base = fixture("entities.json")["repository"]
        items = [
            {**base, "node_id": "é", "html_url": "https://github.com/acme/e", "updated_at": "2026-09-15T07:00:00Z"},
            {**base, "node_id": "z", "html_url": "https://github.com/acme/z", "updated_at": "2026-09-15T07:00:00Z"},
            {**base, "node_id": "old", "html_url": "https://github.com/acme/old", "updated_at": "2026-09-13T07:00:00Z"},
        ]
        adapter = self.make_adapter(
            source(queries=list(reversed(queries)), budget=1),
            lambda _m, url, _k: response(url, {"total_count": len(items), "items": items}),
        )
        result = adapter.collect(
            "community:github",
            {"mode": "shadow", "window": {"start": "2026-09-14T00:00:00Z", "end": NOW}, "depth": 1},
        )
        self.assertEqual([item.native_id for item in result.candidates], ["github:repository:z"])
        self.assertEqual([u.stream_id for u in result.checkpoint_updates], ["query.alpha", "query.zeta", "scheduler"])

    def test_pagination_is_bounded_by_depth(self):
        pages = []

        def handler(_method, url, _kwargs):
            page = int(parse_qs(urlsplit(url).query)["page"][0])
            pages.append(page)
            return response(url, {"total_count": 500, "items": [fixture("entities.json")["repository"]] * 100})

        result = self.make_adapter(source(), handler).collect(
            "community:github", {"mode": "shadow", "depth": 2},
        )
        self.assertEqual(pages, [1, 2])
        self.assertEqual(len(result.candidates), 1)
        self.assertEqual(
            result.checkpoint_updates[0].checkpoint["cursor"]["endpoints"]["repository"]["page"], 3,
        )
        self.assertIsNone(result.checkpoint_updates[0].checkpoint["successful_window_end"])

    def test_rest_pagination_resumes_from_checkpoint_cursor(self):
        query = {"id": "agents", "query": "agent", "sort": "updated", "filters": {"entities": ["repository"]}}
        previous = {
            "checkpoint_at": "2026-09-14T08:00:00Z",
            "cursor": {
                "window": {"start": None, "end": NOW},
                "endpoints": {"repository": {
                    "phase": "search", "window": {"start": None, "end": NOW},
                    "page": 2, "expected_total_count": 101,
                    "counts": {"entries_seen": 100, "node_missing_seen": 0, "valid_seen": 100},
                }},
            },
            "etag": None, "last_modified": None, "recent_native_ids": [],
            "successful_window_end": None, "query_fingerprint": query_fingerprint("github", query),
        }
        pages = []

        def handler(_method, url, _kwargs):
            pages.append(int(parse_qs(urlsplit(url).query)["page"][0]))
            return response(url, {"total_count": 101, "items": [fixture("entities.json")["repository"]]})

        result = self.make_adapter(
            source(queries=[query]), handler,
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual(pages, [2])
        self.assertEqual(result.checkpoint_updates[0].checkpoint["cursor"], {})
        self.assertEqual(result.checkpoint_updates[0].checkpoint["successful_window_end"], NOW)

    def test_search_never_requests_or_persists_page_beyond_github_1000_cap(self):
        query = {"id": "agents", "query": "agent", "sort": "updated", "filters": {"entities": ["repository"]}}
        previous = {
            "checkpoint_at": "2026-09-14T08:00:00Z",
            "cursor": {
                "window": {"start": None, "end": NOW},
                "endpoints": {"repository": {
                    "phase": "search", "window": {"start": None, "end": NOW},
                    "page": 10, "expected_total_count": 1500,
                    "counts": {"entries_seen": 900, "node_missing_seen": 0, "valid_seen": 900},
                }},
            },
            "etag": None, "last_modified": None, "recent_native_ids": [],
            "successful_window_end": None, "query_fingerprint": query_fingerprint("github", query),
        }
        pages = []

        def handler(_method, url, _kwargs):
            pages.append(int(parse_qs(urlsplit(url).query)["page"][0]))
            return response(url, {
                "total_count": 1500,
                "items": [fixture("entities.json")["repository"]] * 100,
            })

        result = self.make_adapter(
            source(queries=[query]), handler,
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 2})
        self.assertEqual(pages, [10])
        self.assertEqual(result.status, "partial")
        self.assertEqual(result.code, "github-search-cap")
        self.assertEqual(result.checkpoint_updates[0].checkpoint["cursor"], {})
        self.assertEqual(result.checkpoint_updates[0].checkpoint["successful_window_end"], NOW)

    def test_repository_304_does_not_skip_other_enabled_entities(self):
        data = fixture("entities.json")

        def handler(_method, url, _kwargs):
            if urlsplit(url).path == "/search/repositories":
                return response(url, None, status=304)
            if urlsplit(url).path == "/repos/acme/agent":
                return response(url, data["repository"])
            return response(url, {"total_count": 1, "items": [data["issue"]]})

        result = self.make_adapter(source(entities=["repository", "issue"]), handler).collect(
            "community:github", {"mode": "shadow"},
        )
        self.assertEqual([item.source_type for item in result.candidates], ["issue"])

    def test_release_discovery_is_not_truncated_by_candidate_budget(self):
        data = fixture("entities.json")
        repos = [
            data["repository"],
            {**data["repository"], "node_id": "R_second", "full_name": "acme/second", "html_url": "https://github.com/acme/second"},
        ]
        release = {**data["release"], "node_id": "RE_second", "html_url": "https://github.com/acme/second/releases/tag/v1"}

        def handler(_method, url, _kwargs):
            path = urlsplit(url).path
            if path == "/search/repositories":
                return response(url, {"total_count": 2, "items": repos})
            return response(url, [release] if path.startswith("/repos/acme/second/") else [])

        result = self.make_adapter(source(entities=["release"], budget=1), handler).collect(
            "community:github", {"mode": "shadow"},
        )
        self.assertEqual([item.native_id for item in result.candidates], ["github:release:RE_second"])

    def test_query_params_are_built_only_from_registry_filters_and_incremental_window(self):
        seen = []
        query = {
            "id": "filtered", "query": "agent systems", "sort": "stars",
            "filters": {
                "entities": ["repository"], "language": "Python", "owner": "acme",
                "topics": ["agents", "llm"], "min_stars": 50,
            },
        }

        def handler(_method, url, _kwargs):
            seen.append(parse_qs(urlsplit(url).query))
            return response(url, {"total_count": 0, "items": []})

        self.make_adapter(source(queries=[query]), handler).collect(
            "community:github",
            {
                "mode": "shadow", "topic": "must not enter URL",
                "window": {"start": "2026-09-14T01:02:03Z", "end": NOW},
            },
        )
        params = seen[0]
        self.assertEqual(params["sort"], ["stars"])
        query_text = params["q"][0]
        for qualifier in (
            "agent systems", "language:Python", "user:acme", "topic:agents",
            "topic:llm", "stars:>=50", "pushed:>=2026-09-14",
            "pushed:<=2026-09-15",
        ):
            self.assertIn(qualifier, query_text)
        self.assertNotIn("must not enter URL", query_text)

    def test_exact_status_matrix(self):
        cases = [
            ("rate-limited", "rate-limited"),
            ("auth-failed", "error"),
            ("timeout", "timeout"),
            ("unreachable", "unreachable"),
            ("schema-drift", "schema-drift"),
        ]
        for failure, expected in cases:
            with self.subTest(failure=failure):
                def handler(_m, _u, _k, status=failure):
                    raise AdapterError("unsafe https://api.github.com/path?token=secret", status=status, retryable=True)
                result = self.make_adapter(source(), handler).collect("community:github", {"mode": "shadow"})
                self.assertEqual(result.status, expected)
                self.assertNotIn("http", result.message or "")
                self.assertNotIn("secret", result.message or "")

    def test_rest_success_and_discussion_permission_failure_is_partial(self):
        def handler(method, url, _kwargs):
            if method == "POST":
                return response(url, {"errors": [{"type": "FORBIDDEN", "message": "private detail"}]})
            return response(url, {"total_count": 0, "items": []})

        result = self.make_adapter(
            source(include_discussions=True), handler, lambda _source_id: "top-secret",
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "partial")
        self.assertEqual([update.stream_id for update in result.checkpoint_updates], ["query.agents", "scheduler"])
        self.assertEqual(result.code, "github-discussion-failure")

    def test_anonymous_limit_is_rate_limited_after_resolving_absent_credential(self):
        resolved = []
        def credentials(_source_id):
            resolved.append(_source_id)
            return None

        def handler(_method, _url, _kwargs):
            raise AdapterError("limit response detail", status="rate-limited", retryable=True)

        result = self.make_adapter(source(), handler, credentials).collect(
            "community:github", {"mode": "shadow"},
        )
        self.assertEqual(result.status, "rate-limited")
        self.assertEqual(result.checkpoint_updates, ())
        self.assertEqual(resolved, ["community:github"])

    def test_resolver_failures_are_safely_classified_without_secret_repr(self):
        def credentials(_source_id):
            raise RuntimeError("github_pat_secret-must-not-leak")

        result = self.make_adapter(
            source(include_discussions=True), lambda *_args: self.fail("must not fetch"), credentials,
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "auth-failed")
        self.assertEqual(result.message, "GitHub credential resolution failed")
        self.assertNotIn("secret", json.dumps(result, default=lambda obj: obj.__dict__).lower())

    def test_checkpoint_updates_validate_and_batch_never_serializes_token_or_state(self):
        discussion_empty = {
            "data": {"search": {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": None}}}
        }

        def handler(method, url, _kwargs):
            if method == "POST":
                return response(url, discussion_empty)
            return response(url, {"total_count": 0, "items": []})

        adapter = self.make_adapter(
            source(include_discussions=True), handler,
            lambda _source_id: "github" + "_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        )
        request = {"mode": "shadow"}
        result = adapter.collect("community:github", request)
        validated = validate_checkpoint_updates("community:github", result.checkpoint_updates)
        batch = AcquisitionRuntime(now=lambda: NOW).build_batch(
            adapter, "community:github", request, result,
        )
        serialized = json.dumps(batch, sort_keys=True)
        self.assertEqual(len(validated), 3)
        self.assertNotIn("github_pat_", serialized)
        self.assertNotIn("checkpoint", serialized)

    def test_query_fingerprint_mismatch_fails_before_http_and_does_not_advance(self):
        previous = {
            "checkpoint_at": "2026-09-14T08:00:00Z", "cursor": {}, "etag": None,
            "last_modified": None, "recent_native_ids": [],
            "successful_window_end": "2026-09-14T08:00:00Z", "query_fingerprint": "a" * 64,
        }
        result = self.make_adapter(
            source(), lambda *_args: self.fail("must not fetch mismatched query"),
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.checkpoint_updates, ())

    def test_request_and_source_config_fail_closed(self):
        adapter = GitHubAdapter(
            resolve_source=lambda _s: None, http_client=FakeClient(lambda *_: None),
            clock=lambda: NOW, credential_resolver=lambda _source_id: {"status": "absent"},
            checkpoint_resolver=lambda _source_id: None,
        )
        with self.assertRaises(AdapterError):
            adapter.collect("community:github", {"mode": "shadow"})
        configured = self.make_adapter(source(), lambda _m, url, _k: response(url, {"items": []}))
        for request in ({}, {"mode": "unsafe"}, {"mode": "shadow", "depth": 0},
                        {"mode": "shadow", "window": {"start": NOW, "end": "bad"}}):
            with self.subTest(request=request), self.assertRaises(AdapterError):
                configured.validate_request(request)

    def test_query_count_is_bounded_by_checkpoint_update_limit(self):
        queries = [
            {"id": f"q{index}", "query": "agent", "sort": "updated", "filters": {"entities": ["repository"]}}
            for index in range(128)
        ]
        adapter = self.make_adapter(
            source(queries=queries, include_discussions=True),
            lambda *_args: self.fail("invalid source must not fetch"),
            lambda _source_id: "token",
        )
        with self.assertRaises(AdapterError):
            adapter.collect("community:github", {"mode": "shadow"})

    def test_later_endpoint_failure_preserves_earlier_candidate_and_progress(self):
        data = fixture("entities.json")

        def handler(_method, url, _kwargs):
            if urlsplit(url).path == "/search/repositories":
                return response(url, {"total_count": 1, "items": [data["repository"]]})
            raise AdapterError("unsafe detail", status="timeout", retryable=True)

        result = self.make_adapter(source(entities=["repository", "commit"]), handler).collect(
            "community:github", {"mode": "shadow"},
        )
        self.assertEqual(result.status, "partial")
        self.assertEqual([item.native_id for item in result.candidates], ["github:repository:R_repo"])
        self.assertEqual(len(result.checkpoint_updates), 2)
        checkpoint = result.checkpoint_updates[0].checkpoint
        self.assertTrue(checkpoint["cursor"]["endpoints"]["repository"]["complete"])
        self.assertFalse(checkpoint["cursor"]["endpoints"]["commit"]["complete"])
        self.assertIsNone(checkpoint["successful_window_end"])
        self.assertEqual(
            len(validate_checkpoint_updates("community:github", result.checkpoint_updates)), 2,
        )

    def test_search_cap_returns_candidates_partial_checkpoint_and_restarts_without_replay(self):
        data = fixture("entities.json")["repository"]
        pages = []

        def handler(_method, url, _kwargs):
            pages.append(int(parse_qs(urlsplit(url).query)["page"][0]))
            return response(url, {"total_count": 1500, "items": [data] * 100})

        first = self.make_adapter(source(), handler).collect(
            "community:github", {"mode": "shadow", "depth": 10},
        )
        self.assertEqual(pages, list(range(1, 10)))
        self.assertEqual(first.status, "partial")
        self.assertEqual(first.code, "github-request-budget-exhausted")
        self.assertEqual(len(first.candidates), 1)
        update = first.checkpoint_updates[0]
        self.assertIsNone(update.checkpoint["successful_window_end"])
        self.assertEqual(len(validate_checkpoint_updates("community:github", first.checkpoint_updates)), 2)
        endpoint = update.checkpoint["cursor"]["endpoints"]["repository"]
        self.assertEqual(endpoint["page"], 10)
        self.assertEqual(endpoint["counts"]["valid_seen"], 900)

        previous = copy.deepcopy(update.checkpoint)
        previous["checkpoint_at"] = "2026-09-15T07:00:00Z"
        pages.clear()
        second = self.make_adapter(
            source(), handler, checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 10})
        self.assertEqual(pages, [10])
        self.assertEqual(second.candidates, ())
        self.assertEqual(second.status, "partial")

    def test_shipped_query_uses_only_endpoint_supported_qualifiers(self):
        seen = {}
        query = {
            "id": "shipping", "query": "agent systems", "sort": "updated",
            "filters": {
                "entities": ["repository", "commit", "issue", "pull-request"],
                "owner": "acme", "language": "Python", "topics": ["agents"],
                "min_stars": 50,
            },
        }

        def handler(_method, url, _kwargs):
            path = urlsplit(url).path
            q = parse_qs(urlsplit(url).query)["q"][0]
            label = "pull-request" if "type:pr" in q else "issue" if "type:issue" in q else "commit" if path.endswith("commits") else "repository"
            seen[label] = q
            return response(url, {"total_count": 0, "items": []})

        self.make_adapter(source(queries=[query]), handler).collect(
            "community:github", {"mode": "shadow", "window": {"start": "2026-09-14T00:00:00Z", "end": NOW}},
        )
        for qualifier in ("language:Python", "topic:agents", "stars:>=50"):
            self.assertIn(qualifier, seen["repository"])
            self.assertNotIn(qualifier, seen["commit"])
            self.assertNotIn(qualifier, seen["issue"])
            self.assertNotIn(qualifier, seen["pull-request"])
        self.assertIn("committer-date:>=", seen["commit"])
        self.assertIn("type:issue", seen["issue"])
        self.assertIn("type:pr", seen["pull-request"])

    def test_issue_and_pr_parent_repo_node_is_resolved_once_from_repository_url(self):
        data = fixture("entities.json")
        lookups = []

        def handler(_method, url, _kwargs):
            path = urlsplit(url).path
            q = parse_qs(urlsplit(url).query).get("q", [""])[0]
            if path == "/search/repositories":
                return response(url, {"total_count": 0, "items": []})
            if path == "/repos/acme/agent":
                lookups.append(path)
                return response(url, data["repository"])
            item = data["pull-request"] if "type:pr" in q else data["issue"]
            return response(url, {"total_count": 1, "items": [item]})

        result = self.make_adapter(source(entities=["issue", "pull-request"]), handler).collect(
            "community:github", {"mode": "shadow"},
        )
        self.assertEqual(lookups, ["/repos/acme/agent"])
        self.assertEqual(
            {item.provenance["parent_repository_id"] for item in result.candidates},
            {"github:repository:R_repo"},
        )

    def test_invalid_candidate_url_is_schema_drift_not_no_results_or_missing_node(self):
        bad = {**fixture("entities.json")["repository"], "html_url": "https://evil.example/repo"}
        result = self.make_adapter(
            source(), lambda _m, url, _k: response(url, {"total_count": 1, "items": [bad]}),
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.code, "github-item-schema-drift")
        self.assertNotEqual(result.code, "github-node-id-missing")

    def test_completed_endpoint_skips_on_resume_and_recent_ids_suppress_replay(self):
        data = fixture("entities.json")

        def first_handler(_method, url, _kwargs):
            if urlsplit(url).path == "/search/repositories":
                return response(url, {"total_count": 1, "items": [data["repository"]]})
            raise AdapterError("temporary", status="timeout", retryable=True)

        first = self.make_adapter(source(entities=["repository", "commit"]), first_handler).collect(
            "community:github", {"mode": "shadow"},
        )
        previous = copy.deepcopy(first.checkpoint_updates[0].checkpoint)
        previous["checkpoint_at"] = "2026-09-15T07:00:00Z"
        paths = []

        def second_handler(_method, url, _kwargs):
            path = urlsplit(url).path
            paths.append(path)
            self.assertEqual(path, "/search/commits")
            return response(url, {"total_count": 1, "items": [data["commit"]]})

        second = GitHubAdapter(
            resolve_source=lambda _source_id: source(entities=["repository", "commit"]),
            http_client=FakeClient(second_handler), clock=lambda: "2026-09-16T08:00:00Z",
            credential_resolver=lambda _source_id: {"status": "absent"},
            checkpoint_resolver=lambda _source_id: {"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(paths, ["/search/commits"])
        self.assertEqual([item.source_type for item in second.candidates], ["commit"])
        update = second.checkpoint_updates[0].checkpoint
        self.assertEqual(update["cursor"], {})
        self.assertEqual(update["successful_window_end"], NOW)

    def test_mixed_missing_rest_node_drops_bad_item_warns_and_completes_endpoint(self):
        valid = fixture("entities.json")["repository"]
        missing = {**valid, "html_url": "https://github.com/acme/missing"}
        missing.pop("node_id")
        result = self.make_adapter(
            source(), lambda _m, url, _k: response(url, {"total_count": 2, "items": [valid, missing]}),
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.code, "github-node-id-missing")
        self.assertEqual([item.native_id for item in result.candidates], ["github:repository:R_repo"])
        self.assertEqual(result.checkpoint_updates[0].checkpoint["cursor"], {})
        self.assertEqual(result.checkpoint_updates[0].checkpoint["successful_window_end"], NOW)

    def test_release_mixed_missing_node_completes_but_all_missing_fails_without_update(self):
        data = fixture("entities.json")
        missing = {**data["release"], "html_url": "https://github.com/acme/agent/releases/tag/missing"}
        missing.pop("node_id")

        def collect(releases):
            def handler(_method, url, _kwargs):
                if urlsplit(url).path == "/search/repositories":
                    return response(url, {"total_count": 1, "items": [data["repository"]]})
                return response(url, releases)
            return self.make_adapter(source(entities=["release"]), handler).collect(
                "community:github", {"mode": "shadow"},
            )

        mixed = collect([data["release"], missing])
        self.assertEqual((mixed.status, mixed.code), ("ok", "github-node-id-missing"))
        self.assertEqual(mixed.checkpoint_updates[0].checkpoint["cursor"], {})
        all_missing = collect([missing])
        self.assertEqual((all_missing.status, all_missing.code), ("partial", "github-node-id-missing"))
        self.assertEqual([update.stream_id for update in all_missing.checkpoint_updates], ["query.agents", "scheduler"])

    def test_retry_with_recent_valid_and_missing_node_still_completes_without_replay(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["repository"]}}
        valid = fixture("entities.json")["repository"]
        missing = {**valid, "html_url": "https://github.com/acme/missing"}
        missing.pop("node_id")
        previous = {
            "checkpoint_at": "2026-09-14T08:00:00Z", "cursor": {
                "window": {"start": None, "end": NOW},
                "endpoints": {"repository": {"complete": False}},
            }, "etag": None, "last_modified": None,
            "recent_native_ids": ["github:repository:R_repo"],
            "successful_window_end": None, "query_fingerprint": query_fingerprint("github", query),
        }
        result = self.make_adapter(
            source(queries=[query]),
            lambda _m, url, _k: response(url, {"total_count": 2, "items": [valid, missing]}),
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "no-results")
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.checkpoint_updates[0].checkpoint["cursor"], {})
        self.assertEqual(result.checkpoint_updates[0].checkpoint["successful_window_end"], NOW)

    def test_malformed_rest_timestamp_is_schema_drift_and_mixed_keeps_valid_candidate(self):
        valid = fixture("entities.json")["repository"]
        malformed = {**valid, "node_id": "R_bad_date", "html_url": "https://github.com/acme/bad", "updated_at": "not-a-date"}
        all_bad = self.make_adapter(
            source(), lambda _m, url, _k: response(url, {"total_count": 1, "items": [malformed]}),
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual((all_bad.status, all_bad.code), ("schema-drift", "github-item-schema-drift"))
        self.assertEqual([update.stream_id for update in all_bad.checkpoint_updates], ["scheduler"])

        mixed = self.make_adapter(
            source(), lambda _m, url, _k: response(url, {"total_count": 2, "items": [valid, malformed]}),
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual((mixed.status, mixed.code), ("partial", "github-item-schema-drift"))
        self.assertEqual([item.native_id for item in mixed.candidates], ["github:repository:R_repo"])
        self.assertEqual([update.stream_id for update in mixed.checkpoint_updates], ["scheduler"])

    def test_full_all_missing_rest_page_persists_progress_until_endpoint_finishes(self):
        missing = {**fixture("entities.json")["repository"]}
        missing.pop("node_id")

        def handler(_method, url, _kwargs):
            if urlsplit(url).path == "/search/repositories":
                return response(url, {"total_count": 200, "items": [missing] * 100})
            return response(url, {"total_count": 0, "items": []})

        result = self.make_adapter(
            source(entities=["repository", "commit"]), handler,
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual((result.status, result.code), ("partial", "github-endpoint-progress"))
        endpoints = result.checkpoint_updates[0].checkpoint["cursor"]["endpoints"]
        self.assertEqual(endpoints["repository"]["page"], 2)
        self.assertEqual(endpoints["repository"]["counts"], {
            "entries_seen": 100, "node_missing_seen": 100, "valid_seen": 0,
        })
        self.assertEqual(endpoints["commit"], {"complete": True})

    def test_full_all_missing_release_page_persists_progress_until_parent_finishes(self):
        data = fixture("entities.json")
        missing = {**data["release"]}
        missing.pop("node_id")

        def handler(_method, url, _kwargs):
            path = urlsplit(url).path
            if path == "/search/repositories":
                return response(url, {"total_count": 1, "items": [data["repository"]]})
            if path.endswith("/releases"):
                return response(url, [missing] * 100)
            return response(url, {"total_count": 0, "items": []})

        result = self.make_adapter(
            source(entities=["release", "commit"]), handler,
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual((result.status, result.code), ("partial", "github-endpoint-progress"))
        endpoints = result.checkpoint_updates[0].checkpoint["cursor"]["endpoints"]
        self.assertEqual(endpoints["release"]["counters"]["node_missing_seen"], 100)
        self.assertEqual(endpoints["release"]["release_page"], 2)
        self.assertEqual(endpoints["commit"], {"complete": True})

    def test_discussion_mixed_missing_id_warns_but_completes_and_requires_parent_repo(self):
        valid = fixture("discussion.json")["data"]["search"]["nodes"][0]
        missing = {**valid, "url": "https://github.com/acme/agent/discussions/10"}
        missing.pop("id")
        body = {"data": {"search": {"nodes": [valid, missing], "pageInfo": {"hasNextPage": False, "endCursor": None}}}}

        def handler(method, url, _kwargs):
            return response(url, body) if method == "POST" else response(url, {"total_count": 0, "items": []})

        result = self.make_adapter(
            source(include_discussions=True), handler, lambda _source_id: "token",
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.code, "github-node-id-missing")
        discussion = next(item for item in result.candidates if item.source_type == "discussion")
        self.assertEqual(discussion.provenance["parent_repository_id"], "github:repository:R_repo")
        self.assertIn("discussions", {update.stream_id for update in result.checkpoint_updates})

        only_missing_body = {"data": {"search": {"nodes": [missing], "pageInfo": {"hasNextPage": False, "endCursor": None}}}}
        only_missing = self.make_adapter(
            source(include_discussions=True),
            lambda method, url, _kwargs: response(url, only_missing_body) if method == "POST" else response(url, {"total_count": 0, "items": []}),
            lambda _source_id: "token",
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual((only_missing.status, only_missing.code), ("partial", "github-node-id-missing"))
        self.assertNotIn("discussions", {update.stream_id for update in only_missing.checkpoint_updates})

        invalid_repo = copy.deepcopy(valid)
        invalid_repo["repository"] = {"nameWithOwner": "acme/agent"}
        bad_body = {"data": {"search": {"nodes": [invalid_repo], "pageInfo": {"hasNextPage": False, "endCursor": None}}}}
        bad = self.make_adapter(
            source(include_discussions=True),
            lambda method, url, _kwargs: response(url, bad_body) if method == "POST" else response(url, {"total_count": 0, "items": []}),
            lambda _source_id: "token",
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual((bad.status, bad.code), ("partial", "github-item-schema-drift"))
        self.assertNotIn("discussions", {update.stream_id for update in bad.checkpoint_updates})

    def test_discussion_invalid_date_is_item_schema_drift_and_payload_omits_repo_only_filters(self):
        node = copy.deepcopy(fixture("discussion.json")["data"]["search"]["nodes"][0])
        node["updatedAt"] = "yesterday-ish"
        query = {
            "id": "filtered", "query": "agent systems", "sort": "updated",
            "filters": {"entities": ["repository"], "owner": "acme", "language": "Python", "topics": ["agents"], "min_stars": 50},
        }

        def handler(method, url, kwargs):
            if method == "POST":
                search = kwargs["payload"]["variables"]["query"]
                self.assertEqual(
                    search,
                    "agent systems user:acme sort:updated-desc "
                    "updated:2026-09-14T00:00:00Z..2026-09-15T08:00:00Z",
                )
                for forbidden in ("language:", "topic:", "stars:"):
                    self.assertNotIn(forbidden, search)
                return response(url, {"data": {"search": {"nodes": [node], "pageInfo": {"hasNextPage": False, "endCursor": None}}}})
            return response(url, {"total_count": 0, "items": []})

        result = self.make_adapter(
            source(queries=[query], include_discussions=True), handler, lambda _source_id: "token",
        ).collect("community:github", {"mode": "shadow", "window": {"start": "2026-09-14T00:00:00Z", "end": NOW}})
        self.assertEqual((result.status, result.code), ("partial", "github-item-schema-drift"))
        self.assertNotIn("discussions", {update.stream_id for update in result.checkpoint_updates})

    def test_search_incomplete_results_is_partial_and_missing_or_wrong_type_is_schema_drift(self):
        data = fixture("entities.json")

        def incomplete_handler(_method, url, _kwargs):
            if urlsplit(url).path == "/search/repositories":
                return HttpResponse(200, url, {
                    "total_count": 1, "incomplete_results": True,
                    "items": [data["repository"]],
                })
            return response(url, {"total_count": 0, "items": []})

        incomplete = self.make_adapter(
            source(entities=["repository", "commit"]), incomplete_handler,
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual((incomplete.status, incomplete.code), ("partial", "github-incomplete-results"))
        self.assertEqual([item.native_id for item in incomplete.candidates], ["github:repository:R_repo"])
        endpoints = incomplete.checkpoint_updates[0].checkpoint["cursor"]["endpoints"]
        self.assertEqual(endpoints["repository"], {"complete": False})
        self.assertEqual(endpoints["commit"], {"complete": True})

        for value in (None, "false", 0):
            with self.subTest(value=value):
                body = {"total_count": 0, "items": []}
                if value is not None:
                    body["incomplete_results"] = value
                invalid = self.make_adapter(
                    source(), lambda _m, url, _k, body=body: HttpResponse(200, url, body),
                ).collect("community:github", {"mode": "shadow"})
                self.assertEqual(invalid.status, "schema-drift")
                self.assertNotEqual(invalid.status, "no-results")
                self.assertEqual([update.stream_id for update in invalid.checkpoint_updates], ["scheduler"])

    def test_node_identity_is_aggregated_across_all_search_pages(self):
        data = fixture("entities.json")["repository"]
        missing = {**data}
        missing.pop("node_id")

        def handler(_method, url, _kwargs):
            page = int(parse_qs(urlsplit(url).query)["page"][0])
            items = [missing] * 100 if page == 1 else [data]
            return response(url, {"total_count": 101, "items": items})

        result = self.make_adapter(source(), handler).collect(
            "community:github", {"mode": "shadow", "depth": 2},
        )
        self.assertEqual((result.status, result.code), ("ok", "github-node-id-missing"))
        self.assertEqual([item.native_id for item in result.candidates], ["github:repository:R_repo"])
        self.assertEqual(result.checkpoint_updates[0].checkpoint["cursor"], {})

    def test_node_identity_is_aggregated_across_release_endpoint(self):
        data = fixture("entities.json")
        repos = [
            data["repository"],
            {**data["repository"], "node_id": "R_second", "full_name": "acme/second", "html_url": "https://github.com/acme/second"},
        ]
        missing = {**data["release"]}
        missing.pop("node_id")
        valid = {**data["release"], "node_id": "RE_second", "html_url": "https://github.com/acme/second/releases/tag/v2"}

        def handler(_method, url, _kwargs):
            path = urlsplit(url).path
            if path == "/search/repositories":
                return response(url, {"total_count": 2, "items": repos})
            return response(url, [missing] if path.startswith("/repos/acme/agent/") else [valid])

        result = self.make_adapter(source(entities=["release"]), handler).collect(
            "community:github", {"mode": "shadow"},
        )
        self.assertEqual((result.status, result.code), ("ok", "github-node-id-missing"))
        self.assertEqual([item.native_id for item in result.candidates], ["github:release:RE_second"])

    def test_graphql_error_types_have_deterministic_safe_precedence(self):
        classify = GitHubAdapter._graphql_error_status
        self.assertEqual(classify([{"type": "RATE_LIMITED"}]), "rate-limited")
        self.assertEqual(classify([{"type": "FORBIDDEN"}]), "auth-failed")
        self.assertEqual(classify([{"type": "GRAPHQL_VALIDATION_FAILED"}]), "schema-drift")
        self.assertEqual(classify([{"type": "BAD_USER_INPUT"}]), "schema-drift")
        self.assertEqual(classify([{"type": "INTERNAL"}]), "error")
        self.assertEqual(classify([{"type": "MYSTERY"}, {"type": "RATE_LIMITED"}]), "rate-limited")
        self.assertEqual(classify([{"type": "FORBIDDEN"}, {"type": "RATE_LIMITED"}]), "rate-limited")
        self.assertEqual(classify([{"type": "FORBIDDEN"}, {"type": "BAD_USER_INPUT"}]), "auth-failed")

    def test_discussion_payload_owner_and_sort_follow_fingerprinted_semantics(self):
        query = {
            "id": "owned", "query": "agent systems", "sort": "updated",
            "filters": {"entities": ["repository"], "owner": "acme", "language": "Python", "topics": ["agents"], "min_stars": 50},
        }
        changed = copy.deepcopy(query)
        changed["filters"]["owner"] = "other"
        self.assertNotEqual(query_fingerprint("github", query), query_fingerprint("github", changed))

        def handler(method, url, kwargs):
            if method == "POST":
                self.assertEqual(
                    kwargs["payload"]["variables"]["query"],
                    "agent systems user:acme sort:updated-desc updated:<=2026-09-15T08:00:00Z",
                )
                return response(url, {"data": {"search": {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": None}}}})
            return response(url, {"total_count": 0, "items": []})

        self.make_adapter(
            source(queries=[query], include_discussions=True), handler, lambda _source_id: "token",
        ).collect("community:github", {"mode": "shadow"})

    def test_rest_identity_counts_resume_then_mixed_page_completes_with_warning(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["repository"]}}
        valid = fixture("entities.json")["repository"]
        missing = {**valid}
        missing.pop("node_id")

        def first_handler(_method, url, _kwargs):
            self.assertEqual(int(parse_qs(urlsplit(url).query)["page"][0]), 1)
            return response(url, {"total_count": 101, "items": [missing] * 100})

        first = self.make_adapter(source(queries=[query]), first_handler).collect(
            "community:github", {"mode": "shadow", "depth": 1},
        )
        self.assertEqual(first.status, "partial")
        update = first.checkpoint_updates[0]
        endpoint = update.checkpoint["cursor"]["endpoints"]["repository"]
        self.assertEqual(endpoint["phase"], "search")
        self.assertEqual(endpoint["page"], 2)
        self.assertEqual(endpoint["counts"], {
            "entries_seen": 100, "node_missing_seen": 100, "valid_seen": 0,
        })
        self.assertIsNone(update.checkpoint["successful_window_end"])
        self.assertEqual(len(validate_checkpoint_updates("community:github", first.checkpoint_updates)), 2)

        previous = copy.deepcopy(update.checkpoint)
        previous["checkpoint_at"] = "2026-09-15T07:00:00Z"

        def second_handler(_method, url, _kwargs):
            self.assertEqual(int(parse_qs(urlsplit(url).query)["page"][0]), 2)
            return response(url, {"total_count": 101, "items": [valid]})

        second = GitHubAdapter(
            resolve_source=lambda _source_id: source(queries=[query]),
            http_client=FakeClient(second_handler), clock=lambda: "2026-09-16T08:00:00Z",
            credential_resolver=lambda _source_id: {"status": "absent"},
            checkpoint_resolver=lambda _source_id: {"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual((second.status, second.code), ("ok", "github-node-id-missing"))
        self.assertEqual([item.native_id for item in second.candidates], ["github:repository:R_repo"])
        self.assertEqual(second.checkpoint_updates[0].checkpoint["cursor"], {})

    def test_rest_all_missing_becomes_fatal_only_when_resumed_pagination_completes(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["repository"]}}
        item = fixture("entities.json")["repository"]
        missing = {**item}
        missing.pop("node_id")
        first = self.make_adapter(
            source(queries=[query]),
            lambda _m, url, _k: response(url, {"total_count": 101, "items": [missing] * 100}),
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual(first.status, "partial")
        previous = copy.deepcopy(first.checkpoint_updates[0].checkpoint)
        previous["checkpoint_at"] = "2026-09-15T07:00:00Z"
        second = self.make_adapter(
            source(queries=[query]),
            lambda _m, url, _k: response(url, {"total_count": 101, "items": [missing]}),
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual((second.status, second.code), ("schema-drift", "github-node-id-missing"))
        self.assertEqual([update.stream_id for update in second.checkpoint_updates], ["scheduler"])

    def test_release_identity_counts_resume_per_parent_without_replaying_repo_search(self):
        data = fixture("entities.json")
        missing = {**data["release"]}
        missing.pop("node_id")

        def first_handler(_method, url, _kwargs):
            if urlsplit(url).path == "/search/repositories":
                return response(url, {"total_count": 1, "items": [data["repository"]]})
            return response(url, [missing] * 100)

        first = self.make_adapter(source(entities=["release"]), first_handler).collect(
            "community:github", {"mode": "shadow", "depth": 1},
        )
        self.assertEqual(first.status, "partial")
        endpoint = first.checkpoint_updates[0].checkpoint["cursor"]["endpoints"]["release"]
        self.assertEqual(endpoint["phase"], "poll")
        self.assertGreater(endpoint["release_page"], 1)
        self.assertEqual(
            endpoint["counters"]["node_missing_seen"],
            (endpoint["release_page"] - 1) * 100,
        )
        previous = copy.deepcopy(first.checkpoint_updates[0].checkpoint)
        previous["checkpoint_at"] = "2026-09-15T07:00:00Z"

        def second_handler(_method, url, _kwargs):
            self.assertEqual(urlsplit(url).path, "/repos/acme/agent/releases")
            return response(url, [data["release"]])

        second = self.make_adapter(
            source(entities=["release"]), second_handler,
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual((second.status, second.code), ("ok", "github-node-id-missing"))
        self.assertEqual(second.checkpoint_updates[0].checkpoint["cursor"], {})

    def test_discussion_identity_counts_resume_before_all_missing_decision(self):
        valid = fixture("discussion.json")["data"]["search"]["nodes"][0]
        missing = {**valid}
        missing.pop("id")
        page_one = {"data": {"search": {"nodes": [missing], "pageInfo": {"hasNextPage": True, "endCursor": "next"}}}}
        page_two_valid = {"data": {"search": {"nodes": [valid], "pageInfo": {"hasNextPage": False, "endCursor": "done"}}}}

        def handler_for(body):
            return lambda method, url, _kwargs: response(url, body) if method == "POST" else response(url, {"total_count": 0, "items": []})

        first = self.make_adapter(
            source(include_discussions=True), handler_for(page_one), lambda _source_id: "token",
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual(first.status, "partial")
        discussion = next(update for update in first.checkpoint_updates if update.stream_id == "discussions")
        self.assertEqual(discussion.checkpoint["cursor"]["queries"]["agents"]["counts"], {
            "entries_seen": 1, "node_missing_seen": 1, "valid_seen": 0,
        })
        previous = copy.deepcopy(discussion.checkpoint)
        previous["checkpoint_at"] = "2026-09-15T07:00:00Z"
        second = self.make_adapter(
            source(include_discussions=True), handler_for(page_two_valid), lambda _source_id: "token",
            checkpoint={"streams": {"discussions": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual((second.status, second.code), ("ok", "github-node-id-missing"))
        completed = next(update for update in second.checkpoint_updates if update.stream_id == "discussions")
        self.assertEqual(completed.checkpoint["cursor"], {})

        page_two_missing = {"data": {"search": {"nodes": [missing], "pageInfo": {"hasNextPage": False, "endCursor": "done"}}}}
        fatal = self.make_adapter(
            source(include_discussions=True), handler_for(page_two_missing), lambda _source_id: "token",
            checkpoint={"streams": {"discussions": previous}},
        ).collect("community:github", {"mode": "shadow", "depth": 1})
        self.assertEqual((fatal.status, fatal.code), ("partial", "github-node-id-missing"))
        self.assertNotIn("discussions", {update.stream_id for update in fatal.checkpoint_updates})

    def test_hostile_endpoint_counter_checkpoint_fails_closed_before_http(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["repository"]}}
        base = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": None,
            "query_fingerprint": query_fingerprint("github", query),
        }
        for counts in (
            None,
            "omit",
            {"total_entries_seen": True, "node_missing_seen": 0, "valid_seen": 0, "mapping_errors_seen": 0},
            {"total_entries_seen": 1, "node_missing_seen": -1, "valid_seen": 2, "mapping_errors_seen": 0},
            {"total_entries_seen": 10**30, "node_missing_seen": 0, "valid_seen": 0, "mapping_errors_seen": 0},
            {"total_entries_seen": 1, "node_missing_seen": 0, "valid_seen": 0, "mapping_errors_seen": 0, "extra": 1},
        ):
            with self.subTest(counts=counts):
                endpoint = {"complete": False, "page": 2}
                if counts != "omit":
                    endpoint["counts"] = counts
                previous = {**base, "cursor": {
                    "window": {"start": None, "end": NOW},
                    "endpoints": {"repository": endpoint},
                }}
                result = self.make_adapter(
                    source(queries=[query]), lambda *_args: self.fail("invalid counters must not fetch"),
                    checkpoint={"streams": {"query.agents": previous}},
                ).collect("community:github", {"mode": "shadow", "depth": 1})
                self.assertEqual(result.status, "schema-drift")
                self.assertEqual(result.checkpoint_updates, ())

    def test_resumed_release_and_discussion_require_exact_counters_before_their_http(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["release"]}}
        base = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": None,
            "query_fingerprint": query_fingerprint("github", query),
        }
        release_previous = {**base, "cursor": {
            "window": {"start": None, "end": NOW},
            "endpoints": {"release": {
                "complete": False, "repository_complete": True,
                "release_pages": {"acme/agent": {"page": 2, "repository_node_id": "R_repo"}},
            }},
        }}
        release = self.make_adapter(
            source(queries=[query]), lambda *_args: self.fail("release counters must validate before HTTP"),
            checkpoint={"streams": {"query.agents": release_previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(release.status, "schema-drift")
        self.assertEqual(release.checkpoint_updates, ())

        discussion_previous = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": None,
            "cursor": {"query_id": "agents", "after": "next", "window": {"start": None, "end": NOW}},
        }
        methods = []

        def discussion_handler(method, url, _kwargs):
            methods.append(method)
            if method == "POST":
                self.fail("discussion counters must validate before GraphQL HTTP")
            return response(url, {"total_count": 0, "items": []})

        discussion = self.make_adapter(
            source(include_discussions=True), discussion_handler, lambda _source_id: "token",
            checkpoint={"streams": {"discussions": discussion_previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(discussion.status, "partial")
        self.assertNotIn("POST", methods)

    def test_rest_resume_requires_frozen_window_and_rejects_endpoint_window_mismatch(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["repository"]}}
        counts = {"total_entries_seen": 100, "node_missing_seen": 0, "valid_seen": 100, "mapping_errors_seen": 0}
        base = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": None,
            "query_fingerprint": query_fingerprint("github", query),
        }
        endpoint = {"complete": False, "page": 2, "counts": counts}
        cursors = (
            {"endpoints": {"repository": endpoint}},
            {"window": None, "endpoints": {"repository": endpoint}},
            {"window": {"start": None, "end": "bad"}, "endpoints": {"repository": endpoint}},
            {
                "window": {"start": None, "end": NOW},
                "endpoints": {"repository": {**endpoint, "window": {"start": None, "end": "2026-09-14T08:00:00Z"}}},
            },
        )
        for cursor in cursors:
            with self.subTest(cursor=cursor):
                result = self.make_adapter(
                    source(queries=[query]), lambda *_args: self.fail("resume window must validate before HTTP"),
                    checkpoint={"streams": {"query.agents": {**base, "cursor": cursor}}},
                ).collect("community:github", {"mode": "shadow", "depth": 1})
                self.assertEqual(result.status, "schema-drift")
                self.assertEqual(result.message, "query.agents: schema-drift")
                self.assertEqual(result.checkpoint_updates, ())

    def test_release_resume_requires_frozen_window_before_http(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["release"]}}
        counts = {"total_entries_seen": 1, "node_missing_seen": 0, "valid_seen": 1, "mapping_errors_seen": 0}
        previous = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": None,
            "query_fingerprint": query_fingerprint("github", query),
            "cursor": {"endpoints": {"release": {
                "complete": False, "repository_complete": True,
                "repository_counts": counts, "release_counts": counts,
                "release_pages": {"acme/agent": {"page": 2, "repository_node_id": "R_repo"}},
            }}},
        }
        result = self.make_adapter(
            source(queries=[query]), lambda *_args: self.fail("release frozen window must validate before HTTP"),
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.checkpoint_updates, ())

    def test_discussion_resume_marker_is_exact_pair_with_frozen_window(self):
        counts = {"total_entries_seen": 1, "node_missing_seen": 1, "valid_seen": 0, "mapping_errors_seen": 0}
        cursors = (
            {"query_id": "agents", "counts": counts, "window": {"start": None, "end": NOW}},
            {"after": "next", "counts": counts, "window": {"start": None, "end": NOW}},
            {"query_id": "", "after": "next", "counts": counts, "window": {"start": None, "end": NOW}},
            {"query_id": "agents", "after": "", "counts": counts, "window": {"start": None, "end": NOW}},
            {"query_id": "agents", "after": "next", "counts": counts},
            {"query_id": "agents", "after": "next", "counts": counts, "window": None},
        )
        methods = []

        def handler(method, url, _kwargs):
            methods.append(method)
            if method == "POST":
                self.fail("discussion resume must validate before GraphQL HTTP")
            return response(url, {"total_count": 0, "items": []})

        for cursor in cursors:
            with self.subTest(cursor=cursor):
                previous = {
                    "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None,
                    "last_modified": None, "recent_native_ids": [],
                    "successful_window_end": None, "cursor": cursor,
                }
                result = self.make_adapter(
                    source(include_discussions=True), handler, lambda _source_id: "token",
                    checkpoint={"streams": {"discussions": previous}},
                ).collect("community:github", {"mode": "shadow"})
                self.assertEqual(result.status, "partial")
        self.assertNotIn("POST", methods)

    def test_exact_false_endpoint_requires_frozen_window_but_valid_window_resumes(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["repository"]}}
        base = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": None,
            "query_fingerprint": query_fingerprint("github", query),
        }
        missing_window = {**base, "cursor": {"endpoints": {"repository": {"complete": False}}}}
        invalid = self.make_adapter(
            source(queries=[query]), lambda *_args: self.fail("false endpoint needs frozen window before HTTP"),
            checkpoint={"streams": {"query.agents": missing_window}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(invalid.status, "schema-drift")
        self.assertEqual(invalid.message, "query.agents: schema-drift")
        self.assertEqual(invalid.checkpoint_updates, ())

        seen = []
        frozen = {"start": "2026-09-14T08:00:00Z", "end": NOW}
        valid_previous = {**base, "cursor": {
            "window": frozen, "endpoints": {"repository": {"complete": False}},
        }}

        def handler(_method, url, _kwargs):
            seen.append(parse_qs(urlsplit(url).query)["q"][0])
            return response(url, {"total_count": 0, "items": []})

        valid = GitHubAdapter(
            resolve_source=lambda _source_id: source(queries=[query]),
            http_client=FakeClient(handler), clock=lambda: "2026-09-16T08:00:00Z",
            credential_resolver=lambda _source_id: {"status": "absent"},
            checkpoint_resolver=lambda _source_id: {"streams": {"query.agents": valid_previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(valid.status, "no-results")
        self.assertIn(f"pushed:>={frozen['start']}", seen[0])
        self.assertIn(f"pushed:<={frozen['end']}", seen[0])
        self.assertNotIn("2026-09-16", seen[0])
        self.assertEqual(valid.checkpoint_updates[0].checkpoint["successful_window_end"], NOW)

    def test_nonempty_complete_only_query_cursor_requires_frozen_window(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["repository"]}}
        previous = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": "2026-09-14T08:00:00Z",
            "query_fingerprint": query_fingerprint("github", query),
            "cursor": {"endpoints": {"repository": {"complete": True}}},
        }
        result = self.make_adapter(
            source(queries=[query]), lambda *_args: self.fail("complete-only cursor must validate before skip/HTTP"),
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.message, "query.agents: schema-drift")
        self.assertEqual(result.checkpoint_updates, ())

    def test_in_progress_endpoint_keys_must_exactly_match_enabled_entities(self):
        query = {
            "id": "agents", "query": "agentic systems", "sort": "updated",
            "filters": {"entities": ["repository", "commit"]},
        }
        base = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": None,
            "query_fingerprint": query_fingerprint("github", query),
        }
        frozen = {"start": None, "end": NOW}
        endpoint_sets = (
            {"repository": {"complete": False}},
            {
                "repository": {"complete": False}, "commit": {"complete": False},
                "issue": {"complete": True},
            },
        )
        for endpoints in endpoint_sets:
            with self.subTest(endpoints=endpoints):
                previous = {**base, "cursor": {"window": frozen, "endpoints": endpoints}}
                result = self.make_adapter(
                    source(queries=[query]), lambda *_args: self.fail("endpoint set must validate before HTTP"),
                    checkpoint={"streams": {"query.agents": previous}},
                ).collect("community:github", {"mode": "shadow"})
                self.assertEqual(result.status, "schema-drift")
                self.assertEqual(result.checkpoint_updates, ())

    def test_all_complete_cursor_resets_then_next_run_computes_new_window(self):
        query = {"id": "agents", "query": "agentic systems", "sort": "updated", "filters": {"entities": ["repository"]}}
        frozen = {"start": "2026-09-14T08:00:00Z", "end": NOW}
        previous = {
            "checkpoint_at": "2026-09-15T07:00:00Z", "etag": None, "last_modified": None,
            "recent_native_ids": [], "successful_window_end": None,
            "query_fingerprint": query_fingerprint("github", query),
            "cursor": {"window": frozen, "endpoints": {"repository": {"complete": True}}},
        }
        reset = self.make_adapter(
            source(queries=[query]), lambda *_args: self.fail("complete endpoint is skipped"),
            checkpoint={"streams": {"query.agents": previous}},
        ).collect("community:github", {"mode": "shadow"})
        reset_checkpoint = reset.checkpoint_updates[0].checkpoint
        self.assertEqual(reset_checkpoint["cursor"], {})
        self.assertEqual(reset_checkpoint["successful_window_end"], NOW)

        next_previous = copy.deepcopy(reset_checkpoint)
        next_previous["checkpoint_at"] = "2026-09-15T09:00:00Z"
        seen = []

        def handler(_method, url, _kwargs):
            seen.append(parse_qs(urlsplit(url).query)["q"][0])
            return response(url, {"total_count": 0, "items": []})

        next_run = GitHubAdapter(
            resolve_source=lambda _source_id: source(queries=[query]),
            http_client=FakeClient(handler), clock=lambda: "2026-09-16T08:00:00Z",
            credential_resolver=lambda _source_id: {"status": "absent"},
            checkpoint_resolver=lambda _source_id: {"streams": {"query.agents": next_previous}},
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(next_run.status, "no-results")
        self.assertIn(f"pushed:>={NOW}", seen[0])
        self.assertIn("pushed:<=2026-09-16T08:00:00Z", seen[0])


if __name__ == "__main__":
    unittest.main()
