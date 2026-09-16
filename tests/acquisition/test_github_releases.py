from __future__ import annotations

import unittest
from urllib.parse import parse_qs, urlsplit

from follow_up_acquisition.adapters.github_executor import GitHubExecutor
from follow_up_acquisition.adapters.github_models import RequestBudget, Window
from follow_up_acquisition.adapters.github_queries import release_roster_url
from follow_up_acquisition.adapters.github_releases import ReleaseMachine
from follow_up_acquisition.http_client import HttpResponse


class GitHubReleaseTests(unittest.TestCase):
    def test_roster_discovery_has_no_window_or_pushed_qualifier_and_is_top100(self):
        query = {"query": "agentic systems", "sort": "updated", "filters": {"owner": "acme", "topics": ["agents"], "min_stars": 50}}
        params = parse_qs(urlsplit(release_roster_url(query)).query)
        self.assertEqual(params["per_page"], ["100"])
        self.assertEqual(params["page"], ["1"])
        self.assertNotIn("pushed:", params["q"][0])
        self.assertNotIn("updated:", params["q"][0])

    def test_discovery_rejects_roster_values_poll_would_reject(self):
        class Client:
            def get(self, url, **kwargs):
                return HttpResponse(200, url, {"total_count": 1, "incomplete_results": False,
                                                "items": [{"full_name": "é" * 101, "node_id": "N" * 513}]})
        machine = ReleaseMachine(GitHubExecutor(RequestBudget(False), Client()))
        query = {"id": "agents", "query": "agents", "sort": "updated", "filters": {"entities": ["release"]}}
        with self.assertRaises(Exception):
            machine.discover("agents.release-roster", query, Window(None, "2026-09-16T08:00:00Z"), "2026-09-16T08:00:00Z")


if __name__ == "__main__":
    unittest.main()
