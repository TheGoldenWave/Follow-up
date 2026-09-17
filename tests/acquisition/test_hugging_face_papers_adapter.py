from __future__ import annotations

import copy
import unittest
from datetime import datetime, timezone

from follow_up_acquisition.http_client import HttpResponse
from follow_up_acquisition.runtime import AdapterError, validate_checkpoint_updates

from follow_up_acquisition.adapters.hugging_face_papers import (
    HuggingFacePapersAdapter,
    build_views,
    parse_paper,
)


SOURCE = "academic:hugging-face-papers"
ENDPOINT = "https://huggingface.co/api/daily_papers"
NOW = datetime(2026, 9, 15, 16, 30, tzinfo=timezone.utc)


def source() -> dict:
    return {
        "id": SOURCE,
        "adapter": "hugging-face-papers",
        "budget": 15,
        "input": {
            "structured_endpoint": ENDPOINT,
            "page_base_url": "https://huggingface.co/papers",
            "views": ["daily", "trending", "weekly"],
            "timezone": "Asia/Shanghai",
        },
    }


class FakeClient:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, copy.deepcopy(kwargs)))
        return self.handler(url)


class HuggingFacePapersPureFunctionTests(unittest.TestCase):
    def test_builds_shanghai_daily_and_iso_week_views(self):
        self.assertEqual(
            build_views(NOW, "Asia/Shanghai"),
            (
                ("daily", "https://huggingface.co/api/daily_papers?date=2026-09-16", "https://huggingface.co/papers/date/2026-09-16"),
                ("trending", "https://huggingface.co/api/daily_papers?view=trending", "https://huggingface.co/papers/trending"),
                ("weekly", "https://huggingface.co/api/daily_papers?week=2026-W38", "https://huggingface.co/papers/week/2026-W38"),
            ),
        )

    def test_parses_arxiv_identity_then_hugging_face_fallback(self):
        paper = {
            "id": "reliable-agents",
            "arxivId": "2401.00001v2",
            "title": "Reliable Agents",
            "authors": [{"name": "Ada"}],
            "publishedAt": "2026-09-15T00:00:00Z",
            "summary": "A paper summary",
        }
        parsed = parse_paper(paper, "daily", "https://huggingface.co/papers/date/2026-09-15", "2026-09-15T09:00:00Z")
        self.assertEqual(parsed["native_id"], "arxiv:2401.00001")
        self.assertEqual(parsed["url"], "https://huggingface.co/papers/reliable-agents")
        self.assertEqual(parsed["author"], "Ada")
        fallback = parse_paper({"id": "no-arxiv", "title": "Fallback"}, "daily", "https://example.test", "2026-09-15T09:00:00Z")
        self.assertEqual(fallback["native_id"], "hf:no-arxiv")


class HuggingFacePapersAdapterTests(unittest.TestCase):
    def collect(self, handler):
        client = FakeClient(handler)
        adapter = HuggingFacePapersAdapter(
            resolve_source=lambda source_id: source() if source_id == SOURCE else None,
            http_client=client,
            clock=lambda: NOW,
        )
        return adapter.collect(SOURCE, {"mode": "shadow"}), client

    def test_merges_views_in_fixed_order_and_emits_checkpoints(self):
        paper = {"id": "paper-1", "arxivId": "2401.00001", "title": "Paper One"}

        def handler(url):
            view = "daily" if "date=" in url else "trending" if "view=" in url else "weekly"
            body = {"papers": [{**paper, "rank": {"daily": 2, "trending": 1, "weekly": 3}[view], "upvotes": 10}]}
            return HttpResponse(200, url, body)

        result, client = self.collect(handler)
        self.assertEqual(result.status, "ok")
        self.assertEqual(len(result.candidates), 1)
        candidate = result.candidates[0]
        self.assertEqual(candidate.native_id, "arxiv:2401.00001")
        self.assertEqual([view["kind"] for view in candidate.native_metrics["community_evidence"]["views"]], ["daily", "trending", "weekly"])
        self.assertEqual([update.stream_id for update in result.checkpoint_updates], ["daily", "trending", "weekly"])
        self.assertTrue(all(call[1]["allowed_hosts"] == {"huggingface.co"} for call in client.calls))
        self.assertTrue(all(call[1]["allowed_paths"] == {"/api"} for call in client.calls))
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_reports_partial_without_discarding_successful_views(self):
        paper = {"id": "paper-1", "title": "Paper One"}

        def handler(url):
            if "view=trending" in url:
                raise AdapterError("rate limited", status="rate-limited", retryable=True)
            return HttpResponse(200, url, [paper])

        result, _client = self.collect(handler)
        self.assertEqual((result.status, result.code), ("partial", "hf-view-partial"))
        self.assertEqual(result.message, "daily=ok; trending=rate-limited; weekly=ok")
        self.assertEqual(len(result.candidates), 1)

    def test_reports_no_results_only_when_every_view_succeeds_empty(self):
        result, _client = self.collect(lambda url: HttpResponse(200, url, {"papers": []}))
        self.assertEqual((result.status, result.code, result.message), ("no-results", None, None))


if __name__ == "__main__":
    unittest.main()
