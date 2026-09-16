from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from follow_up_acquisition.http_client import HttpResponse
from follow_up_acquisition.runtime import AdapterError, validate_checkpoint_updates
from follow_up_acquisition.source_state import query_fingerprint

from follow_up_acquisition.adapters.hackernews import HackerNewsAdapter


FIXTURES = Path(__file__).parent / "fixtures" / "hackernews"
NOW = "2026-09-15T09:00:00Z"
WINDOW_START = "2026-09-15T00:00:00Z"
SOURCE = "community:hacker-news"


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def source(*, budget=8, top_enabled=True, new_enabled=True, queries=None, **extra):
    query = {
        "id": "ai-agents",
        "query": "AI agents",
        "sort": "date",
        "filters": {"tags": ["story"], "min_points": 0},
    }
    value = {
        "id": SOURCE,
        "adapter": "hackernews",
        "budget": budget,
        "input": {
            "firebase_url": "https://hacker-news.firebaseio.com/v0",
            "algolia_url": "https://hn.algolia.com/api/v1",
            "top_enabled": top_enabled,
            "new_enabled": new_enabled,
            "queries": [query] if queries is None else queries,
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


class HackerNewsAdapterTests(unittest.TestCase):
    def make_adapter(self, config, handler, checkpoint=None):
        return HackerNewsAdapter(
            resolve_source=lambda source_id: config if source_id == SOURCE else None,
            http_client=FakeClient(handler),
            clock=lambda: NOW,
            checkpoint_resolver=lambda source_id: checkpoint if source_id == SOURCE else None,
        )

    def collect(self, config, handler, request=None, checkpoint=None):
        return self.make_adapter(config, handler, checkpoint).collect(
            SOURCE, request or {"mode": "shadow"},
        )

    def windowed_collect(self, config, handler, checkpoint=None):
        return self.collect(
            config, handler,
            request={"mode": "shadow", "window": {"start": WINDOW_START, "end": NOW}},
            checkpoint=checkpoint,
        )

    @staticmethod
    def handler_for_fixture(calls):
        items = fixture("items.json")
        algolia = fixture("algolia.json")

        def handler(_method, url, _kwargs):
            calls.append(("GET", url, copy.deepcopy(_kwargs)))
            path = urlsplit(url).path
            query = parse_qs(urlsplit(url).query)
            if path.endswith("/topstories.json"):
                return response(url, fixture("topstories.json"))
            if path.endswith("/newstories.json"):
                return response(url, fixture("newstories.json"))
            if "/item/" in path:
                item_id = path.split("/item/", 1)[1].removesuffix(".json")
                return response(url, items[item_id])
            if path.endswith("/search_by_date"):
                page = query.get("page", ["0"])[0]
                key = "page0" if page == "0" else "page1"
                return response(url, algolia[key])
            calls.append(("unexpected", url, _kwargs))
            raise AssertionError(f"unexpected HN URL: {url}")

        return handler

    def test_maps_item_and_algolia_streams_within_window_and_dedupes(self):
        calls = []
        result = self.windowed_collect(source(budget=8), self.handler_for_fixture(calls))

        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["201", "302", "102", "301", "101"],
        )
        self.assertTrue(all(candidate.source_type == "story" for candidate in result.candidates))
        self.assertNotIn("103", [candidate.native_id for candidate in result.candidates])
        self.assertNotIn("202", [candidate.native_id for candidate in result.candidates])
        self.assertNotIn("104", [candidate.native_id for candidate in result.candidates])

        top = next(candidate for candidate in result.candidates if candidate.native_id == "101")
        self.assertEqual(top.native_metrics["points"], 120)
        self.assertEqual(top.native_metrics["descendants"], 20)
        self.assertEqual(top.native_metrics["rank"], 1)
        self.assertEqual(top.provenance["stream"], "top")
        self.assertEqual(top.url, "https://example.com/agent-memory")

        search = next(candidate for candidate in result.candidates if candidate.native_id == "301")
        self.assertEqual(search.provenance["stream"], "search.ai-agents")
        self.assertEqual(search.provenance["query_id"], "ai-agents")

        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"top", "new", "search.ai-agents"},
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)
        self.assertTrue(all(
            kwargs["allowed_hosts"] == {"hacker-news.firebaseio.com"}
            or kwargs["allowed_hosts"] == {"hn.algolia.com"}
            for _method, _url, kwargs in calls
        ))
        algolia_calls = [
            parse_qs(urlsplit(url).query)
            for _method, url, _kwargs in calls
            if "search_by_date" in url
        ]
        self.assertTrue(algolia_calls)
        self.assertTrue(all(call["tags"] == ["story"] for call in algolia_calls))
        self.assertTrue(all(
            any("points>=0" in value for value in call.get("numericFilters", []))
            for call in algolia_calls
        ))

    def test_final_budget_is_applied_after_global_dedupe(self):
        result = self.windowed_collect(
            source(budget=3), self.handler_for_fixture([]),
        )
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["201", "302", "102"],
        )

    def test_failed_stream_does_not_advance_checkpoint(self):
        previous = {
            "successful_window_end": "2026-09-15T07:00:00Z",
            "cursor": {"last_seen_id": 99},
            "etag": None,
            "last_modified": None,
            "recent_native_ids": ["99"],
            "checkpoint_at": "2026-09-15T07:00:00Z",
        }
        query = source()["input"]["queries"][0]
        search_previous = dict(previous)
        search_previous["query_fingerprint"] = query_fingerprint("hackernews", query)
        state = {
            "streams": {
                "top": dict(previous),
                "new": dict(previous),
                "search.ai-agents": search_previous,
            }
        }

        def handler(_method, url, _kwargs):
            if "/newstories.json" in url:
                raise AdapterError("new stream unavailable", status="unreachable")
            return self.handler_for_fixture([])(_method, url, _kwargs)

        result = self.windowed_collect(source(), handler, checkpoint=state)
        self.assertEqual(result.status, "partial")
        self.assertEqual(result.code, "hackernews-partial")
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"top", "search.ai-agents"},
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_all_empty_streams_is_no_results_and_advances_each_stream(self):
        def handler(_method, url, _kwargs):
            if "/topstories.json" in url or "/newstories.json" in url:
                return response(url, [])
            return response(url, {"hits": []})

        result = self.collect(source(), handler)
        self.assertEqual(result.status, "no-results")
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"top", "new", "search.ai-agents"},
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_all_enabled_streams_fail_returns_reason_without_checkpoints(self):
        def handler(_method, url, _kwargs):
            raise AdapterError("public source unavailable", status="unreachable")

        result = self.collect(source(), handler)
        self.assertEqual(result.status, "unreachable")
        self.assertEqual(result.code, "hackernews-stream-failed")
        self.assertEqual(result.checkpoint_updates, ())

    def test_query_fingerprint_change_fails_closed_without_network(self):
        query = source()["input"]["queries"][0]
        changed_fingerprint = "0" * 64
        self.assertNotEqual(query_fingerprint("hackernews", query), changed_fingerprint)
        previous = {
            "successful_window_end": "2026-09-15T07:00:00Z",
            "cursor": {"window_end": "2026-09-15T07:00:00Z"},
            "etag": None,
            "last_modified": None,
            "recent_native_ids": ["99"],
            "checkpoint_at": "2026-09-15T07:00:00Z",
            "query_fingerprint": changed_fingerprint,
        }

        def handler(_method, url, _kwargs):
            raise AssertionError(f"fingerprint mismatch must not call HN: {url}")

        result = self.collect(
            source(top_enabled=False, new_enabled=False), handler,
            checkpoint={"streams": {"search.ai-agents": previous}},
        )
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.code, "hackernews-stream-failed")
        self.assertEqual(result.checkpoint_updates, ())

    def test_algolia_pagination_uses_stable_window_and_min_points_filters(self):
        calls = []

        def hit(index):
            return {
                "story_id": 4000 + index,
                "objectID": str(4000 + index),
                "title": f"paged story {index}",
                "url": f"https://example.com/paged/{index}",
                "author": "tester",
                "points": 10 + index,
                "num_comments": 0,
                "created_at": NOW,
            }

        def handler(_method, url, kwargs):
            calls.append((url, copy.deepcopy(kwargs)))
            query = parse_qs(urlsplit(url).query)
            if query.get("page", ["0"])[0] == "0":
                return response(url, {"hits": [hit(index) for index in range(100)]})
            return response(url, {"hits": [{
                "story_id": 303,
                "objectID": "303",
                "title": "final page story",
                "url": "https://example.com/final-page",
                "author": "tester",
                "points": 500,
                "num_comments": 1,
                "created_at": NOW,
            }]})

        query = {
            "id": "agents",
            "query": "AI agents",
            "sort": "date",
            "filters": {"tags": ["story", "ask_hn"], "min_points": 10},
        }
        result = self.collect(
            source(budget=101, top_enabled=False, new_enabled=False, queries=[query]),
            handler,
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(len(result.candidates), 101)
        self.assertEqual(result.candidates[0].native_id, "303")
        self.assertEqual(calls[0][1]["allowed_hosts"], {"hn.algolia.com"})
        self.assertEqual(calls[0][1]["allowed_paths"], {"/api/v1"})
        first = parse_qs(urlsplit(calls[0][0]).query)
        self.assertEqual(first["tags"], ["story,ask_hn"])
        self.assertEqual(first["hitsPerPage"], ["100"])
        self.assertIn("points>=10", first["numericFilters"][0])
        self.assertIn("created_at_i<=", first["numericFilters"][0])
        self.assertEqual(
            [parse_qs(urlsplit(url).query)["page"][0] for url, _kwargs in calls],
            ["0", "1"],
        )

    def test_malformed_firebase_item_is_schema_drift_without_checkpoint(self):
        def handler(_method, url, _kwargs):
            if "/topstories.json" in url:
                return response(url, [101])
            if "/item/101.json" in url:
                return response(url, [])
            if "/newstories.json" in url:
                return response(url, [])
            return response(url, {"hits": []})

        result = self.collect(
            source(top_enabled=True, new_enabled=False, queries=[]), handler,
        )
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.code, "hackernews-stream-failed")
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.checkpoint_updates, ())

    def test_validate_request_rejects_bad_window_and_depth(self):
        adapter = self.make_adapter(source(), lambda _method, _url, _kwargs: None)
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "depth": 0})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "window": {"start": "bad"}})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "unknown": True})


if __name__ == "__main__":
    unittest.main()
