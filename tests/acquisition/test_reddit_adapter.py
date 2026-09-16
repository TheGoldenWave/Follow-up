from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

from follow_up_acquisition.http_client import HttpResponse
from follow_up_acquisition.runtime import AdapterError

from follow_up_acquisition.adapters.reddit import RedditAdapter


FIXTURES = Path(__file__).parent / "fixtures" / "reddit"
NOW = "2026-09-15T09:00:00Z"
SOURCE = "community:reddit-artificial"
SUB = "artificial"


def fixture_xml(name: str) -> ET.Element:
    return ET.fromstring((FIXTURES / name).read_bytes())


def fixture_json(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def source(*, budget=8, subreddit=SUB, **extra):
    value = {
        "id": SOURCE,
        "adapter": "reddit",
        "budget": budget,
        "input": {
            "subreddit": subreddit,
            "rss_url": f"https://www.reddit.com/r/{subreddit}/.rss",
            "listing_url": f"https://www.reddit.com/r/{subreddit}/new.json",
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


def response(url, body):
    return HttpResponse(200, url, body, None, None)


class RedditAdapterTests(unittest.TestCase):
    def make_adapter(self, config, handler):
        return RedditAdapter(
            resolve_source=lambda source_id: config if source_id == SOURCE else None,
            http_client=FakeClient(handler),
            clock=lambda: NOW,
        )

    def collect(self, config, handler, request=None):
        return self.make_adapter(config, handler).collect(
            SOURCE, request or {"mode": "shadow"},
        )

    @staticmethod
    def handler_for_fixture(calls, rss="rss.xml", listing="listing.json"):
        def handler(_method, url, kwargs):
            calls.append(("GET", url, copy.deepcopy(kwargs)))
            if url.endswith(".rss"):
                return response(url, fixture_xml(rss))
            if url.endswith("/new.json"):
                return response(url, fixture_json(listing))
            raise AssertionError(f"unexpected Reddit URL: {url}")

        return handler

    def test_rss_primary_maps_candidates_and_does_not_call_listing(self):
        calls = []
        result = self.collect(source(budget=8), self.handler_for_fixture(calls))

        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["t3_abc123", "t3_def456", "t3_ghi789"],
        )
        self.assertEqual(
            result.candidates[0].url,
            "https://www.reddit.com/r/artificial/comments/abc123/first_post",
        )
        self.assertEqual(result.candidates[0].source_type, "post")
        self.assertEqual(result.candidates[0].native_metrics["score"], 42)
        self.assertEqual(result.candidates[0].native_metrics["comments"], 7)
        self.assertEqual(result.candidates[0].native_metrics["upvote_ratio"], 0.91)
        self.assertEqual(result.candidates[0].native_metrics["rank"], 1)
        self.assertEqual(result.candidates[0].provenance["subreddit"], SUB)
        self.assertEqual(result.candidates[0].provenance["entry"], "rss")
        self.assertEqual(result.checkpoint_updates, ())
        self.assertTrue(
            all(
                kwargs["allowed_hosts"] == {"www.reddit.com"}
                for _method, _url, kwargs in calls
            )
        )
        self.assertFalse(any(url.endswith("/new.json") for _method, url, _kwargs in calls))

    def test_atom_feed_is_supported(self):
        result = self.collect(
            source(budget=8),
            self.handler_for_fixture([], rss="atom.xml"),
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["t3_atom1", "t3_atom2"],
        )
        self.assertEqual(result.candidates[0].published_at, "2026-09-15T08:00:00Z")
        self.assertEqual(result.candidates[1].date_confidence, "inferred")

    def test_rss_success_with_missing_metrics_still_produces_candidate(self):
        result = self.collect(source(budget=8), self.handler_for_fixture([]))
        second = result.candidates[1]
        self.assertEqual(second.native_id, "t3_def456")
        self.assertNotIn("score", second.native_metrics)
        self.assertEqual(second.native_metrics["rank"], 2)

    def test_missing_date_is_warning(self):
        result = self.collect(
            source(budget=8),
            self.handler_for_fixture([], rss="rss-missing-date.xml"),
        )
        self.assertEqual(result.status, "ok")
        candidate = result.candidates[0]
        self.assertIsNone(candidate.published_at)
        self.assertEqual(candidate.date_confidence, "unknown")
        self.assertEqual(candidate.item_warnings, [{
            "code": "missing_date",
            "message": "Reddit post has no parseable date",
        }])

    def test_rss_failure_falls_back_to_listing(self):
        calls = []

        def handler(_method, url, _kwargs):
            calls.append(url)
            if url.endswith(".rss"):
                raise AdapterError("RSS unavailable", status="unreachable")
            if url.endswith("/new.json"):
                return response(url, fixture_json("listing.json"))
            raise AssertionError(f"unexpected Reddit URL: {url}")

        result = self.collect(source(budget=8), handler)
        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["t3_abc123", "t3_listing2"],
        )
        self.assertEqual(result.candidates[0].provenance["entry"], "listing")
        self.assertEqual(result.candidates[0].native_metrics["comments"], 12)
        self.assertEqual(result.candidates[0].native_metrics["upvote_ratio"], 0.87)
        self.assertEqual(result.candidates[0].provenance["flair"], "Research")
        self.assertEqual(
            result.candidates[0].url,
            "https://www.reddit.com/r/artificial/comments/abc123/listing_first",
        )
        self.assertEqual(calls[0].rsplit("/", 1)[-1], ".rss")
        self.assertEqual(calls[-1].rsplit("/", 1)[-1], "new.json")

    def test_listing_skips_non_t3_children_and_dedupes(self):
        def handler(_method, url, _kwargs):
            if url.endswith(".rss"):
                raise AdapterError("RSS unavailable", status="unreachable")
            return response(url, fixture_json("listing.json"))

        result = self.collect(source(budget=8), handler)
        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["t3_abc123", "t3_listing2"],
        )

    def test_duplicates_keep_first_and_budget_truncates(self):
        result = self.collect(
            source(budget=2),
            self.handler_for_fixture([], rss="rss-duplicates.xml"),
        )
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["t3_abc123", "t3_def456"],
        )
        self.assertEqual(result.candidates[0].native_metrics["score"], 42)

    def test_time_window_filters_entries(self):
        result = self.collect(
            source(budget=8),
            self.handler_for_fixture([]),
            request={
                "mode": "shadow",
                "window": {
                    "start": "2026-09-15T00:00:00Z",
                    "end": "2026-09-15T10:30:00Z",
                },
            },
        )
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["t3_def456", "t3_ghi789"],
        )

    def test_all_paths_fail_returns_real_reason(self):
        def handler(_method, url, _kwargs):
            raise AdapterError("Reddit is unreachable", status="unreachable")

        result = self.collect(source(budget=8), handler)
        self.assertEqual(result.status, "unreachable")
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.checkpoint_updates, ())
        self.assertTrue(result.retryable)

    def test_rate_limited_returns_rate_limited(self):
        def handler(_method, url, _kwargs):
            raise AdapterError("Reddit rate limited", status="rate-limited")

        result = self.collect(source(budget=8), handler)
        self.assertEqual(result.status, "rate-limited")
        self.assertTrue(result.retryable)

    def test_login_wall_is_not_bypassed(self):
        def handler(_method, url, _kwargs):
            raise AdapterError("Reddit authentication required", status="auth-failed")

        result = self.collect(source(budget=8), handler)
        self.assertEqual(result.status, "auth-failed")
        self.assertFalse(result.retryable)

    def test_validate_request_rejects_bad_mode_window_depth_and_unknown_fields(self):
        adapter = self.make_adapter(source(), lambda _method, _url, _kwargs: None)
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "depth": 0})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "window": {"start": "bad"}})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "unknown": True})

    def test_config_rejects_mismatches_and_drift(self):
        bad_configs = [
            {**source(), "adapter": "hackernews"},
            {**source(), "id": "community:reddit-other"},
            {**source(), "budget": 0},
            {
                **source(),
                "input": {
                    **source()["input"],
                    "rss_url": "https://www.reddit.com/r/other/.rss",
                },
            },
            {
                **source(),
                "input": {
                    **source()["input"],
                    "listing_url": "https://www.reddit.com/r/other/new.json",
                },
            },
            {
                **source(),
                "input": {
                    **source()["input"],
                    "extra": True,
                },
            },
        ]
        for config in bad_configs:
            with self.subTest(config=config):
                with self.assertRaises(AdapterError):
                    self.collect(
                        config,
                        lambda _method, _url, _kwargs: response(
                            "https://www.reddit.com/r/artificial/.rss", fixture_xml("rss.xml")
                        ),
                    )

    def test_availability_probe_is_ok(self):
        self.assertEqual(
            self.make_adapter(source(), lambda _method, _url, _kwargs: None).availability_probe(),
            "ok",
        )


if __name__ == "__main__":
    unittest.main()
