"""Tests for the shared RSS/Atom adapter."""

from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

from follow_up_acquisition.adapters.rss import RssAdapter
from follow_up_acquisition.contracts import validate_batch
from follow_up_acquisition.runtime import AcquisitionRuntime, AdapterError

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "rss"


def _adapter(
    fixture_name: str,
    channel: str = "rss",
    fetch: Any = None,
) -> RssAdapter:
    def resolve(_source: str) -> dict[str, Any]:
        return {
            "channel": channel,
            "input": {"rss_url": "https://example.com/feed"},
        }

    def default_fetch(_url: str) -> bytes:
        return (FIXTURES / fixture_name).read_bytes()

    return RssAdapter(resolve_source=resolve, fetch=fetch or default_fetch)


def _collect(adapter: RssAdapter, source: str = "test:source"):
    return adapter.collect(source, {"mode": "shadow"})


class ParsingTests(unittest.TestCase):
    def test_parses_blog_rss(self):
        result = _collect(_adapter("blog.rss", channel="blogs"), "blog:example")
        self.assertEqual(result.status, "ok")
        self.assertEqual(len(result.candidates), 2)
        candidate = result.candidates[0]
        self.assertEqual(candidate.native_id, "post-001")
        self.assertEqual(candidate.url, "https://example.com/blog/first")
        self.assertEqual(candidate.source_type, "blogs")
        self.assertEqual(candidate.date_confidence, "exact")
        self.assertEqual(candidate.author, "Alice")
        self.assertEqual(candidate.published_at, "2026-09-01T12:00:00+00:00")
        self.assertIn("First post body", candidate.text)

    def test_parses_newsletter_atom(self):
        result = _collect(_adapter("newsletter.atom", channel="newsletters"))
        self.assertEqual(result.status, "ok")
        self.assertEqual(len(result.candidates), 2)
        candidate = result.candidates[0]
        self.assertEqual(candidate.native_id, "tag:example.com,2026:edition-1")
        self.assertEqual(candidate.source_type, "newsletters")
        self.assertEqual(candidate.date_confidence, "inferred")
        self.assertEqual(candidate.author, "Alice Author")
        self.assertIn("Newsletter body", candidate.text)

    def test_parses_podcast_enclosures(self):
        result = _collect(_adapter("podcast.rss", channel="podcasts"))
        candidate = result.candidates[0]
        self.assertEqual(candidate.native_id, "ep-1")
        enclosures = candidate.native_metrics["enclosures"]
        self.assertEqual(len(enclosures), 1)
        self.assertEqual(enclosures[0]["href"], "https://example.com/podcast/ep-1.mp3")
        self.assertEqual(candidate.native_metrics["itunes_duration"], "3600")

    def test_missing_guid_falls_back_to_link_with_warning(self):
        result = _collect(_adapter("zh-tech.rss", channel="zh-tech"), "zh-tech:example")
        candidate = result.candidates[0]
        self.assertEqual(candidate.native_id, "https://example.com/zh/ai-model")
        self.assertEqual(candidate.url, "https://example.com/zh/ai-model")
        self.assertIn("AI 模型发布", candidate.title)
        codes = [w["code"] for w in candidate.item_warnings]
        self.assertIn("missing_guid", codes)

    def test_malformed_and_missing_dates(self):
        result = _collect(_adapter("malformed-date.rss"))
        by_title = {c.title: c for c in result.candidates}
        self.assertEqual(by_title["Good date"].date_confidence, "exact")
        bad = by_title["Bad date"]
        self.assertEqual(bad.date_confidence, "unknown")
        self.assertIsNone(bad.published_at)
        self.assertTrue(any(w["code"] == "missing_date" for w in bad.item_warnings))
        none = by_title["No date"]
        self.assertEqual(none.date_confidence, "unknown")
        self.assertTrue(any(w["code"] == "missing_date" for w in none.item_warnings))

    def test_cdata_body_is_preserved(self):
        result = _collect(_adapter("cdata.rss"))
        candidate = result.candidates[0]
        self.assertIn("<b>bold</b>", candidate.text)
        self.assertIn("< raw >", candidate.text)


class ErrorMappingTests(unittest.TestCase):
    def test_skipped_unconfigured_when_no_rss_url(self):
        adapter = RssAdapter(resolve_source=lambda _s: None, fetch=lambda _u: b"")
        with self.assertRaises(AdapterError) as ctx:
            _collect(adapter)
        self.assertEqual(ctx.exception.status, "skipped-unconfigured")

    def test_unreachable_fetch_maps_to_unreachable(self):
        def fetch(_url: str) -> bytes:
            raise OSError("connection refused")

        with self.assertRaises(AdapterError) as ctx:
            _collect(_adapter("blog.rss", fetch=fetch))
        self.assertEqual(ctx.exception.status, "unreachable")

    def test_timeout_maps_to_timeout(self):
        def fetch(_url: str) -> bytes:
            raise TimeoutError("timed out")

        with self.assertRaises(AdapterError) as ctx:
            _collect(_adapter("blog.rss", fetch=fetch))
        self.assertEqual(ctx.exception.status, "timeout")

    def test_malformed_feed_maps_to_schema_drift(self):
        def fetch(_url: str) -> bytes:
            return b"this is definitely not xml or rss"

        with self.assertRaises(AdapterError) as ctx:
            _collect(_adapter("blog.rss", fetch=fetch))
        self.assertEqual(ctx.exception.status, "schema-drift")


class ProtocolTests(unittest.TestCase):
    def test_availability_probe_ok(self):
        self.assertEqual(RssAdapter().availability_probe(), "ok")

    def test_validate_request_requires_mode(self):
        RssAdapter().validate_request({"mode": "shadow"})
        with self.assertRaises(AdapterError):
            RssAdapter().validate_request({})

    def test_runtime_builds_contract_valid_batch(self):
        runtime = AcquisitionRuntime(now=lambda: "2026-09-08T00:00:00+00:00")
        adapter = _adapter("blog.rss", channel="blogs")
        result = _collect(adapter, "blog:example")
        batch = runtime.build_batch(adapter, "blog:example", {"mode": "shadow"}, result)
        validate_batch(batch)
        self.assertEqual(batch["source_status"]["status"], "ok")
        self.assertEqual(len(batch["items"]), 2)
        self.assertEqual(batch["items"][0]["candidate_id"], "blog:example:post-001")


if __name__ == "__main__":
    unittest.main()
