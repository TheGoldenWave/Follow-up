from __future__ import annotations

import copy
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit

from follow_up_acquisition.http_client import HttpResponse
from follow_up_acquisition.runtime import AdapterError, validate_checkpoint_updates

from follow_up_acquisition.adapters.arxiv import (
    ArxivAdapter,
    is_relevant,
    normalize_arxiv_id,
    parse_arxiv_entry,
    sort_and_limit,
)


FIXTURES = Path(__file__).parent / "fixtures" / "arxiv"
NOW = "2026-09-15T09:00:00Z"
SOURCE = "academic:arxiv-cs-ai"
RSS_URL = "https://rss.arxiv.org/rss/cs.AI"
LANDING_URL = "https://arxiv.org/list/cs.AI/recent"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def source(*, budget=10, tags=None):
    return {
        "id": SOURCE,
        "adapter": "arxiv",
        "budget": budget,
        "input": {
            "rss_url": RSS_URL,
            "url": LANDING_URL,
            "tags": tags if tags is not None else ["agentic", "robotics"],
        },
    }


class FakeClient:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, copy.deepcopy(kwargs)))
        return self.handler("GET", url, kwargs)


def response(url, body, *, status=200, etag=None, last_modified=None):
    return HttpResponse(status, url, body, etag, last_modified)


class ArxivPureFunctionTests(unittest.TestCase):
    def test_normalizes_new_and_old_ids_without_versions(self):
        self.assertEqual(normalize_arxiv_id("arXiv:2401.00001v2"), "arxiv:2401.00001")
        self.assertEqual(normalize_arxiv_id("https://arxiv.org/abs/cs.AI/9901001v1"), "arxiv:cs.ai/9901001")
        self.assertEqual(normalize_arxiv_id("not an id"), None)

    def test_parses_feedparser_entry_with_update_metrics(self):
        value = parse_arxiv_entry(
            {
                "id": "https://arxiv.org/abs/2401.00001v2",
                "link": "https://arxiv.org/abs/2401.00001v2",
                "title": "A paper",
                "summary": "An abstract",
                "published_parsed": "2026-09-09T00:00:00Z",
                "updated_parsed": "2026-09-10T01:00:00Z",
                "author_detail": {"name": "Ada Lovelace"},
            },
            fetched_at=NOW,
        )
        self.assertIsNotNone(value)
        assert value is not None
        self.assertEqual(value["native_id"], "arxiv:2401.00001")
        self.assertEqual(value["published_at"], "2026-09-09T00:00:00Z")
        self.assertEqual(value["native_metrics"]["updated_at"], "2026-09-10T01:00:00Z")
        self.assertEqual(value["native_metrics"]["version"], 2)

    def test_parses_real_rss_guid_and_rfc822_date_via_link_fallback(self):
        value = parse_arxiv_entry(
            {
                "guid": "oai:arXiv.org:2609.17560v1",
                "link": "https://arxiv.org/abs/2609.17560",
                "title": "Machine Learning Methods",
                "description": "A machine learning paper.",
                "pubDate": "Thu, 17 Sep 2026 00:00:00 -0400",
                "author": "Ada",
            },
            fetched_at=NOW,
        )
        self.assertIsNotNone(value)
        assert value is not None
        self.assertEqual(value["native_id"], "arxiv:2609.17560")
        self.assertEqual(value["published_at"], "2026-09-17T04:00:00Z")
        self.assertEqual(value["date_confidence"], "exact")
        self.assertEqual(value["native_metrics"]["updated_at"], "2026-09-17T04:00:00Z")
        self.assertEqual(value["native_metrics"]["version"], 1)

    def test_parses_real_rss_xml_item(self):
        item = ET.fromstring("""
            <item>
              <guid>oai:arXiv.org:2609.17560v1</guid>
              <link>https://arxiv.org/abs/2609.17560</link>
              <title>Machine Learning Methods</title>
              <description>A machine learning paper.</description>
              <pubDate>Thu, 17 Sep 2026 00:00:00 -0400</pubDate>
              <author>Ada</author>
            </item>
        """)
        value = parse_arxiv_entry(item, fetched_at=NOW)
        self.assertIsNotNone(value)
        assert value is not None
        self.assertEqual(value["native_id"], "arxiv:2609.17560")
        self.assertEqual(value["published_at"], "2026-09-17T04:00:00Z")
        self.assertEqual(value["native_metrics"], {"updated_at": "2026-09-17T04:00:00Z", "version": 1})

    def test_relevance_ignores_broad_tags_and_matches_semantic_tags(self):
        tags = ["academic", "daily", "agentic"]
        self.assertTrue(is_relevant(tags, "Agentic Planning Papers", "An abstract"))
        self.assertFalse(is_relevant(tags, "Robotics Planning Papers", "An abstract about robots"))
        self.assertTrue(is_relevant(["academic", "daily", "weekly"], "Anything", "Anything"))

    def test_sort_and_limit_is_deterministic(self):
        values = [
            {
                "native_id": "arxiv:2",
                "native_metrics": {"updated_at": "2026-09-09T00:00:00Z"},
            },
            {
                "native_id": "arxiv:1",
                "native_metrics": {"updated_at": "2026-09-10T00:00:00Z"},
            },
            {
                "native_id": "arxiv:3",
                "native_metrics": {"updated_at": "2026-09-10T00:00:00Z"},
            },
        ]
        self.assertEqual(
            [value["native_id"] for value in sort_and_limit(values, 2)],
            ["arxiv:1", "arxiv:3"],
        )


class ArxivAdapterTests(unittest.TestCase):
    def make_adapter(self, config, handler, checkpoint=None, sleeper=None):
        return ArxivAdapter(
            resolve_source=lambda source_id: config if source_id == SOURCE else None,
            http_client=FakeClient(handler),
            clock=lambda: NOW,
            sleeper=sleeper or (lambda _seconds: None),
            checkpoint_resolver=lambda source_id: checkpoint if source_id == SOURCE else None,
        )

    def collect(self, config, handler, request=None, checkpoint=None, sleeper=None):
        return self.make_adapter(config, handler, checkpoint, sleeper).collect(
            SOURCE, request or {"mode": "shadow"},
        )

    def test_complete_rss_does_not_call_metadata(self):
        def handler(_method, url, _kwargs):
            self.assertEqual(url, RSS_URL)
            return response(url, fixture("rss-complete.xml"), etag="rss-v1")

        adapter = self.make_adapter(source(), handler)
        result = adapter.collect(SOURCE, {"mode": "shadow"})
        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["arxiv:2401.00001", "arxiv:2401.00002"],
        )
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"rss"},
        )
        calls = adapter._http.calls
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2]["allowed_hosts"], {"rss.arxiv.org"})
        self.assertEqual(calls[0][2]["allowed_paths"], {"/rss"})
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_incomplete_rss_batches_metadata_and_uses_sleeper(self):
        sleep_calls = []

        def handler(_method, url, _kwargs):
            if urlsplit(url).hostname == "rss.arxiv.org":
                return response(url, fixture("rss-incomplete.xml"))
            self.assertTrue(url.startswith("https://export.arxiv.org/api/query?"))
            self.assertIn("id_list=2401.00001%2C2401.00002", url)
            return response(url, fixture("metadata.xml"))

        def sleeper(seconds):
            sleep_calls.append(seconds)

        adapter = self.make_adapter(source(), handler, sleeper=sleeper)
        result = adapter.collect(SOURCE, {"mode": "shadow"})
        self.assertEqual(result.status, "ok")
        self.assertEqual(sleep_calls, [3.0])
        self.assertEqual(result.candidates[0].author, "Ada Lovelace")
        self.assertEqual(
            result.candidates[0].text,
            "A complete abstract from the metadata API.",
        )
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"rss", "metadata"},
        )
        calls = adapter._http.calls
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[2]["allowed_hosts"] == {"rss.arxiv.org"}
                            for call in calls if urlsplit(call[1]).hostname == "rss.arxiv.org"))
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_metadata_query_is_cached_for_same_source_day(self):
        sleep_calls = []
        metadata_calls = []

        def handler(_method, url, _kwargs):
            if urlsplit(url).hostname == "rss.arxiv.org":
                return response(url, fixture("rss-incomplete.xml"))
            metadata_calls.append(url)
            return response(url, fixture("metadata.xml"))

        adapter = self.make_adapter(
            source(), handler, sleeper=lambda seconds: sleep_calls.append(seconds),
        )
        first = adapter.collect(SOURCE, {"mode": "shadow"})
        second = adapter.collect(SOURCE, {"mode": "shadow"})
        self.assertEqual(first.status, "ok")
        self.assertEqual(second.status, "ok")
        self.assertEqual(len(metadata_calls), 1)
        self.assertEqual(sleep_calls, [3.0])

    def test_304_uses_conditional_headers_and_advances_rss_checkpoint(self):
        calls = []
        checkpoint = {
            "streams": {
                "rss": {
                    "successful_window_end": "2026-09-14T00:00:00Z",
                    "cursor": None,
                    "etag": "old-etag",
                    "last_modified": "old-last-modified",
                    "recent_native_ids": ["arxiv:2401.00001"],
                    "checkpoint_at": "2026-09-14T09:00:00Z",
                }
            }
        }

        def handler(_method, url, kwargs):
            self.assertEqual(kwargs["headers"], {
                "If-None-Match": "old-etag",
                "If-Modified-Since": "old-last-modified",
            })
            return response(url, None, status=304, etag="new-etag", last_modified="new-last-modified")

        result = self.collect(source(), handler, checkpoint=checkpoint)
        self.assertEqual(result.status, "no-results")
        update = result.checkpoint_updates[0]
        self.assertEqual(update.checkpoint["etag"], "new-etag")
        self.assertEqual(update.checkpoint["last_modified"], "new-last-modified")
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_window_uses_updated_at(self):
        result = self.collect(
            source(),
            lambda _method, url, _kwargs: response(url, fixture("rss-complete.xml")),
            request={
                "mode": "shadow",
                "window": {
                    "start": "2026-09-09T00:00:00Z",
                    "end": "2026-09-09T12:00:00Z",
                },
            },
        )
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["arxiv:2401.00002"],
        )

    def test_metadata_failure_is_partial_and_keeps_rss_candidates(self):
        def handler(_method, url, _kwargs):
            if urlsplit(url).hostname == "rss.arxiv.org":
                return response(url, fixture("rss-incomplete.xml"))
            raise AdapterError("metadata rate limited", status="rate-limited")

        result = self.collect(source(), handler)
        self.assertEqual(result.status, "partial")
        self.assertEqual(result.code, "arxiv-partial")
        self.assertEqual(len(result.candidates), 2)
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"rss"},
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_rss_failure_is_classified_without_checkpoints(self):
        def handler(_method, url, _kwargs):
            raise AdapterError("rss unreachable", status="unreachable")

        result = self.collect(source(), handler)
        self.assertEqual(result.status, "unreachable")
        self.assertEqual(result.code, "arxiv-stream-failed")
        self.assertEqual(result.checkpoint_updates, ())

    def test_drifted_rss_is_schema_drift(self):
        result = self.collect(
            source(),
            lambda _method, url, _kwargs: response(url, fixture("drifted.xml")),
        )
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.checkpoint_updates, ())

    def test_empty_successful_rss_is_no_results_and_advances_checkpoint(self):
        result = self.collect(
            source(),
            lambda _method, url, _kwargs: response(url, fixture("empty.xml")),
        )
        self.assertEqual(result.status, "no-results")
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"rss"},
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_config_and_request_validation_reject_drift(self):
        bad_configs = [
            {**source(), "adapter": "hackernews"},
            {**source(), "id": "academic:other"},
            {**source(), "budget": 0},
            {**source(), "input": {**source()["input"], "rss_url": "https://example.com/feed"}},
            {**source(), "input": {**source()["input"], "url": "https://example.com/list"}},
            {**source(), "input": {**source()["input"], "extra": True}},
        ]
        for config in bad_configs:
            with self.subTest(config=config):
                with self.assertRaises(AdapterError):
                    self.collect(config, lambda _method, _url, _kwargs: None)

        adapter = self.make_adapter(source(), lambda _method, _url, _kwargs: None)
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "bad"})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "depth": 1})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "window": {"start": "bad"}})


if __name__ == "__main__":
    unittest.main()
