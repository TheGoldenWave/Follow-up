from __future__ import annotations

import copy
import unittest

from follow_up_acquisition.adapters.github_discussions import DiscussionMachine
from follow_up_acquisition.adapters.github_executor import GitHubExecutor
from follow_up_acquisition.adapters.github_models import RequestBudget, Window
from follow_up_acquisition.adapters.github_queries import discussion_query_set_fingerprint
from follow_up_acquisition.http_client import HttpResponse


class GitHubDiscussionTests(unittest.TestCase):
    def test_query_set_fingerprint_is_reorder_stable_and_semantic(self):
        queries = [
            {"id": "a", "query": "agents", "sort": "updated", "filters": {"entities": ["repository"]}},
            {"id": "b", "query": "safety", "sort": "updated", "filters": {"entities": ["issue"]}},
        ]
        self.assertEqual(discussion_query_set_fingerprint(queries), discussion_query_set_fingerprint(reversed(queries)))
        changed = copy.deepcopy(queries)
        changed[0]["query"] = "changed"
        self.assertNotEqual(discussion_query_set_fingerprint(queries), discussion_query_set_fingerprint(changed))

    def test_page_ten_with_more_results_completes_bounded_coverage(self):
        class Client:
            def post_json(self, url, payload, **kwargs):
                return HttpResponse(200, url, {"data": {"search": {
                    "nodes": [], "pageInfo": {"hasNextPage": True, "endCursor": "page-11"},
                }}})
        executor = GitHubExecutor(RequestBudget(True), Client())
        machine = DiscussionMachine(executor)
        query = {"id": "agents", "query": "agents", "sort": "updated", "filters": {"entities": ["repository"]}}
        state = {"after": "page-9", "window": {"start": None, "end": "2026-09-16T08:00:00Z"},
                 "template": "github-discussions-template-v1", "pages_seen": 9,
                 "counts": {"entries_seen": 900, "node_missing_seen": 0, "valid_seen": 900}}
        outcome = machine.run("agents.discussion-search", query, Window(None, "2026-09-16T08:00:00Z"), state, "2026-09-16T08:00:00Z", first=100)
        self.assertEqual((outcome.status, outcome.code), ("partial", "github-discussion-page-cap"))
        self.assertTrue(outcome.progressed)
        self.assertTrue(outcome.complete)
        self.assertEqual(outcome.state, {"complete": True})

    def test_page_ten_all_missing_identity_is_schema_drift_before_coverage_cap(self):
        missing = {"url": "https://github.com/acme/repo/discussions/1", "title": "x",
                   "bodyText": "x", "createdAt": "2026-09-16T07:00:00Z",
                   "updatedAt": "2026-09-16T07:00:00Z", "author": None,
                   "comments": {"totalCount": 0}, "reactions": {"totalCount": 0},
                   "repository": {"id": "R_1", "nameWithOwner": "acme/repo"}}
        class Client:
            def post_json(self, url, payload, **kwargs):
                return HttpResponse(200, url, {"data": {"search": {
                    "nodes": [missing] * 100, "pageInfo": {"hasNextPage": True, "endCursor": "page-11"},
                }}})
        machine = DiscussionMachine(GitHubExecutor(RequestBudget(True), Client()))
        query = {"id": "agents", "query": "agents", "sort": "updated", "filters": {"entities": ["repository"]}}
        state = {"after": "page-9", "window": {"start": None, "end": "2026-09-16T08:00:00Z"},
                 "template": "github-discussions-template-v1", "pages_seen": 9,
                 "counts": {"entries_seen": 900, "node_missing_seen": 900, "valid_seen": 0}}
        outcome = machine.run("agents.discussion-search", query, Window(None, "2026-09-16T08:00:00Z"), state, "2026-09-16T08:00:00Z", first=100)
        self.assertEqual((outcome.status, outcome.code), ("schema-drift", "github-node-id-missing"))


if __name__ == "__main__":
    unittest.main()
