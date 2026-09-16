from __future__ import annotations

import unittest

from follow_up_acquisition.adapters.github_executor import GitHubExecutor
from follow_up_acquisition.adapters.github_models import RequestBudget, Window
from follow_up_acquisition.adapters.github_rest import RestEndpointMachine, _counts, _validate_pending
from follow_up_acquisition.http_client import HttpResponse


QUERY = {"id": "agents", "query": "agents", "sort": "updated", "filters": {"entities": ["repository"]}}


class Client:
    def __init__(self, bodies):
        self.bodies = iter(bodies)
        self.calls = []
    def get(self, url, **kwargs):
        self.calls.append(url)
        return HttpResponse(200, url, next(self.bodies))


class GitHubRestTests(unittest.TestCase):
    def machine(self, bodies):
        client = Client(bodies)
        return RestEndpointMachine(GitHubExecutor(RequestBudget(False), client)), client

    def test_strict_envelope_poison_fails(self):
        invalid = (
            {"total_count": True, "incomplete_results": False, "items": []},
            {"total_count": 0, "items": []},
            {"total_count": 0, "incomplete_results": "false", "items": []},
        )
        for body in invalid:
            with self.subTest(body=body):
                machine, _client = self.machine([body])
                with self.assertRaises(Exception):
                    machine.run("agents.repository-search", QUERY, "repository",
                                Window(None, "2026-09-16T08:00:00Z"), None,
                                "2026-09-16T08:00:00Z")

    def test_snapshot_total_change_resets_same_window_page_one(self):
        state = {"phase": "search", "window": {"start": None, "end": "2026-09-16T08:00:00Z"},
                 "page": 2, "expected_total_count": 200,
                 "counts": {"entries_seen": 100, "node_missing_seen": 0, "valid_seen": 100}}
        machine, client = self.machine([{"total_count": 201, "incomplete_results": False, "items": []}])
        outcome = machine.run("agents.repository-search", QUERY, "repository",
                              Window(None, "2026-09-16T08:00:00Z"), state,
                              "2026-09-16T08:00:00Z")
        self.assertEqual((outcome.status, outcome.code), ("partial", "github-search-snapshot-changed"))
        self.assertEqual(outcome.state["page"], 1)
        self.assertEqual(len(client.calls), 1)

    def test_issue_page_ten_caps_at_100_not_1000(self):
        item = {
            "node_id": "I_1", "html_url": "https://github.com/acme/repo/issues/1",
            "title": "Issue", "user": {"login": "ada"},
            "created_at": "2026-09-16T07:00:00Z", "updated_at": "2026-09-16T07:00:00Z",
            "comments": 0, "reactions": {"total_count": 0}, "state": "open",
            "repository_url": "https://api.github.com/repos/acme/repo",
        }
        query = {"id": "agents", "query": "agents", "sort": "updated", "filters": {"entities": ["issue"]}}
        state = {"phase": "search", "window": {"start": None, "end": "2026-09-16T08:00:00Z"},
                 "page": 10, "expected_total_count": 101,
                 "counts": {"entries_seen": 90, "node_missing_seen": 0, "valid_seen": 90}}
        machine, _client = self.machine([{"total_count": 101, "incomplete_results": False, "items": [item] * 10}])
        outcome = machine.run("agents.issue-search", query, "issue", Window(None, "2026-09-16T08:00:00Z"), state, "2026-09-16T08:00:00Z")
        self.assertEqual(outcome.code, "github-search-cap")
        self.assertIsNone(outcome.state["next_page"])

    def test_hostile_counter_relationship_and_any_pending_item_fail_before_http(self):
        with self.assertRaises(Exception):
            _counts({"entries_seen": 1, "node_missing_seen": 1, "valid_seen": 1})
        valid = {"node_id": "I_1", "url": "https://github.com/acme/repo/issues/1",
                 "title": "Issue", "author": None, "published_at": "2026-09-16T07:00:00Z",
                 "updated_at": "2026-09-16T07:00:00Z", "comments": 0, "reactions": None,
                 "state": "open", "repository_api_url": "https://api.github.com/repos/acme/repo"}
        invalid = {**valid, "updated_at": "not-a-date"}
        with self.assertRaises(Exception):
            _validate_pending([valid, invalid])


if __name__ == "__main__":
    unittest.main()
