from __future__ import annotations

import unittest
from urllib.parse import urlsplit

from follow_up_acquisition.adapters.github import GitHubAdapter
from follow_up_acquisition.http_client import HttpResponse
from follow_up_acquisition.adapters.github_models import (
    BudgetExhausted,
    CredentialResolution,
    RequestBudget,
    Window,
)
from follow_up_acquisition.runtime import AdapterError
from follow_up_acquisition.runtime import validate_checkpoint_updates


class GitHubBudgetTests(unittest.TestCase):
    def test_anonymous_and_token_hard_buckets(self):
        for authenticated, limits in ((False, (24, 9, 15, 0)), (True, (64, 27, 31, 6))):
            budget = RequestBudget(authenticated=authenticated)
            self.assertEqual((budget.total_limit, budget.search_limit, budget.core_limit, budget.graphql_limit), limits)
            for kind, count in (("search", limits[1]), ("core", limits[2]), ("graphql", limits[3])):
                for _ in range(count):
                    if budget.total_used == limits[0]:
                        break
                    budget.consume(kind)
                with self.assertRaises(BudgetExhausted):
                    budget.consume(kind)

    def test_credential_resolution_is_exact_tagged_tristate(self):
        self.assertFalse(CredentialResolution.parse({"status": "absent"}).authenticated)
        resolved = CredentialResolution.parse({"status": "resolved", "token": "secret"})
        self.assertTrue(resolved.authenticated)
        self.assertEqual(resolved.token, "secret")
        self.assertEqual(CredentialResolution.parse({"status": "resolution-error"}).status, "resolution-error")
        for value in (None, "token", {}, {"status": "absent", "token": "x"}, {"status": "resolved"}, {"status": "resolved", "token": " bad"}):
            with self.subTest(value=value), self.assertRaises(AdapterError):
                CredentialResolution.parse(value)

    def test_window_matrix_normalizes_offsets_and_freezes_now(self):
        now = "2026-09-16T08:00:00Z"
        self.assertEqual(Window.from_request(None, previous_end="2026-09-15T08:00:00Z", now=now).to_dict(), {"start": "2026-09-15T08:00:00Z", "end": now})
        self.assertEqual(Window.from_request({"start": "2026-09-15T16:00:00+08:00", "end": None}, previous_end=None, now=now).to_dict(), {"start": "2026-09-15T08:00:00Z", "end": now})
        for value in ({}, {"start": None}, {"end": None}, {"start": now, "end": "2026-09-15T08:00:00Z"}):
            with self.subTest(value=value), self.assertRaises(AdapterError):
                Window.from_request(value, previous_end=None, now=now)

    def test_shipped_lanes_obey_anonymous_search_and_total_caps(self):
        queries = [
            {"id": name, "query": name, "sort": "updated", "filters": {"entities": ["repository", "release", "commit", "issue", "pull-request"]}}
            for name in ("agents", "infra", "safety")
        ]
        source = {"id": "community:github", "adapter": "github", "budget": 10, "input": {
            "rest_api_url": "https://api.github.com", "graphql_url": "https://api.github.com/graphql",
            "include_discussions": False, "queries": queries,
        }}

        class Client:
            def __init__(self):
                self.calls = []
            def get(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return HttpResponse(200, url, {"total_count": 0, "incomplete_results": False, "items": []})

        client = Client()
        result = GitHubAdapter(
            lambda _source: source, client, lambda: "2026-09-16T08:00:00Z",
            lambda _source: {"status": "absent"}, lambda _source: None,
        ).collect("community:github", {"mode": "shadow"})
        search_calls = [item for item in client.calls if urlsplit(item[0]).path.startswith("/search/")]
        self.assertLessEqual(len(client.calls), 24)
        self.assertEqual(len(search_calls), 9)
        self.assertEqual((result.status, result.code), ("partial", "github-request-budget-exhausted"))
        self.assertIn("scheduler", {update.stream_id for update in result.checkpoint_updates})
        self.assertEqual(len(validate_checkpoint_updates("community:github", result.checkpoint_updates)), len(result.checkpoint_updates))

    def test_optional_token_is_resolved_once_and_used_without_discussions(self):
        query = {"id": "agents", "query": "agents", "sort": "updated", "filters": {"entities": ["repository"]}}
        source = {"id": "community:github", "adapter": "github", "budget": 10, "input": {
            "rest_api_url": "https://api.github.com", "graphql_url": "https://api.github.com/graphql",
            "include_discussions": False, "queries": [query],
        }}
        resolved = []
        headers = []
        class Client:
            def get(self, url, **kwargs):
                headers.append(kwargs["headers"])
                return HttpResponse(200, url, {"total_count": 0, "incomplete_results": False, "items": []})
        GitHubAdapter(
            lambda _source: source, Client(), lambda: "2026-09-16T08:00:00Z",
            lambda source_id: resolved.append(source_id) or {"status": "resolved", "token": "token"},
            lambda _source: None,
        ).collect("community:github", {"mode": "shadow"})
        self.assertEqual(resolved, ["community:github"])
        self.assertTrue(headers and all(item["Authorization"] == "Bearer token" for item in headers))


if __name__ == "__main__":
    unittest.main()
