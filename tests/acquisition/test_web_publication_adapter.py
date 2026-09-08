"""Tests for the official-blog discovery + extraction adapter."""

from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

from follow_up_acquisition.adapters.web_publication import WebPublicationAdapter
from follow_up_acquisition.contracts import validate_batch
from follow_up_acquisition.runtime import AcquisitionRuntime, AdapterError

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "blogs"
ARTICLE_PATTERN = r"/engineering/[^/?#]+/?$"


def _fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _adapter(
    discovery: list[dict[str, Any]],
    *,
    patterns: list[str] | None = None,
    excludes: list[str] | None = None,
    routes: dict[str, bytes] | None = None,
    extract: Any = None,
) -> WebPublicationAdapter:
    routes = routes or {}

    def fetch(url: str) -> bytes:
        if url in routes:
            return routes[url]
        raise OSError(f"no fixture routed for {url}")

    def resolve(_source: str) -> dict[str, Any]:
        return {
            "channel": "blogs",
            "input": {
                "url": "https://example.com/engineering",
                "discovery": discovery,
                "article_url_patterns": patterns or [],
                "exclude_url_patterns": excludes or [],
            },
        }

    def default_extract(_html: bytes, url: str) -> dict[str, Any]:
        return {
            "title": f"Article at {url}",
            "author": "Alice Author",
            "date": "2026-09-01",
            "text": f"Body text for {url}",
        }

    return WebPublicationAdapter(
        resolve_source=resolve, fetch=fetch, extract=extract or default_extract
    )


def _article_routes(urls: list[str], body: bytes = b"<article></article>") -> dict[str, bytes]:
    return {url: body for url in urls}


class DiscoveryTests(unittest.TestCase):
    def test_rss_discovery(self):
        urls = [
            "https://example.com/engineering/rss-1",
            "https://example.com/engineering/rss-2",
        ]
        adapter = _adapter(
            [{"type": "rss", "url": "https://example.com/engineering/rss.xml"}],
            routes={"https://example.com/engineering/rss.xml": _fixture("rss.xml"), **_article_routes(urls)},
        )
        result = adapter.collect("blog:example", {"mode": "shadow"})
        self.assertEqual(result.status, "ok")
        self.assertEqual([c.url for c in result.candidates], urls)

    def test_sitemap_discovery_filters_article_urls(self):
        urls = [
            "https://example.com/engineering/article-1",
            "https://example.com/engineering/article-2",
        ]
        adapter = _adapter(
            [{"type": "sitemap", "url": "https://example.com/sitemap.xml"}],
            patterns=[ARTICLE_PATTERN],
            routes={"https://example.com/sitemap.xml": _fixture("sitemap.xml"), **_article_routes(urls)},
        )
        result = adapter.collect("blog:example", {"mode": "shadow"})
        # /about and the bare /engineering index are excluded by the pattern.
        self.assertEqual([c.url for c in result.candidates], urls)

    def test_html_discovery(self):
        urls = [
            "https://example.com/engineering/article-1",
            "https://example.com/engineering/article-2",
            "https://example.com/engineering/article-3",
        ]
        adapter = _adapter(
            [{"type": "html", "url": "https://example.com/engineering"}],
            patterns=[ARTICLE_PATTERN],
            routes={"https://example.com/engineering": _fixture("index.html"), **_article_routes(urls)},
        )
        result = adapter.collect("blog:example", {"mode": "shadow"})
        self.assertEqual(len(result.candidates), 3)

    def test_discovery_order_prefers_rss(self):
        rss_urls = [
            "https://example.com/engineering/rss-1",
            "https://example.com/engineering/rss-2",
        ]
        adapter = _adapter(
            [
                {"type": "rss", "url": "https://example.com/engineering/rss.xml"},
                {"type": "html", "url": "https://example.com/engineering"},
            ],
            patterns=[ARTICLE_PATTERN],
            routes={
                "https://example.com/engineering/rss.xml": _fixture("rss.xml"),
                "https://example.com/engineering": _fixture("index.html"),
                **_article_routes(rss_urls),
            },
        )
        result = adapter.collect("blog:example", {"mode": "shadow"})
        # RSS won, so the html index was never consulted for discovery.
        self.assertEqual([c.url for c in result.candidates], rss_urls)

    def test_exclude_patterns(self):
        urls = ["https://example.com/engineering/article-1"]
        adapter = _adapter(
            [{"type": "sitemap", "url": "https://example.com/sitemap.xml"}],
            patterns=[ARTICLE_PATTERN],
            excludes=[r"article-1"],
            routes={"https://example.com/sitemap.xml": _fixture("sitemap.xml"), **_article_routes(urls)},
        )
        result = adapter.collect("blog:example", {"mode": "shadow"})
        self.assertEqual([c.url for c in result.candidates], ["https://example.com/engineering/article-2"])


class ErrorMappingTests(unittest.TestCase):
    def test_index_layout_drift_maps_to_schema_drift(self):
        adapter = _adapter(
            [{"type": "html", "url": "https://example.com/engineering"}],
            patterns=[ARTICLE_PATTERN],
            routes={"https://example.com/engineering": _fixture("drifted-index.html")},
        )
        with self.assertRaises(AdapterError) as ctx:
            adapter.collect("blog:example", {"mode": "shadow"})
        self.assertEqual(ctx.exception.status, "schema-drift")

    def test_unreachable_maps_to_unreachable(self):
        adapter = _adapter(
            [{"type": "html", "url": "https://example.com/engineering"}],
            patterns=[ARTICLE_PATTERN],
        )
        with self.assertRaises(AdapterError) as ctx:
            adapter.collect("blog:example", {"mode": "shadow"})
        self.assertEqual(ctx.exception.status, "unreachable")

    def test_no_discovery_methods_returns_ok_empty(self):
        adapter = _adapter([])
        result = adapter.collect("blog:example", {"mode": "shadow"})
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.candidates, ())


class ExtractionTests(unittest.TestCase):
    def test_extraction_maps_metadata_to_candidate(self):
        urls = ["https://example.com/engineering/rss-1"]
        adapter = _adapter(
            [{"type": "rss", "url": "https://example.com/engineering/rss.xml"}],
            routes={"https://example.com/engineering/rss.xml": _fixture("rss.xml"), **_article_routes(urls)},
        )
        result = adapter.collect("blog:example", {"mode": "shadow"})
        candidate = result.candidates[0]
        self.assertEqual(candidate.native_id, urls[0])
        self.assertEqual(candidate.source_type, "blogs")
        self.assertEqual(candidate.author, "Alice Author")
        self.assertEqual(candidate.published_at, "2026-09-01T00:00:00+00:00")
        self.assertEqual(candidate.date_confidence, "inferred")
        self.assertIn("Body text", candidate.text)

    def test_single_article_extraction_failure_becomes_warning(self):
        urls = ["https://example.com/engineering/rss-1"]

        def extract(_html: bytes, url: str) -> dict[str, Any] | None:
            if url == urls[0]:
                return None
            return {"title": "ok", "date": "2026-09-01", "text": "body"}

        adapter = _adapter(
            [{"type": "rss", "url": "https://example.com/engineering/rss.xml"}],
            routes={"https://example.com/engineering/rss.xml": _fixture("rss.xml"), **_article_routes(urls)},
            extract=extract,
        )
        result = adapter.collect("blog:example", {"mode": "shadow"})
        candidate = result.candidates[0]
        self.assertEqual(candidate.date_confidence, "unknown")
        self.assertTrue(any(w["code"] == "extraction_failed" for w in candidate.item_warnings))


class ProtocolTests(unittest.TestCase):
    def test_availability_probe_ok(self):
        self.assertEqual(WebPublicationAdapter().availability_probe(), "ok")

    def test_runtime_builds_contract_valid_batch(self):
        runtime = AcquisitionRuntime(now=lambda: "2026-09-08T00:00:00+00:00")
        urls = ["https://example.com/engineering/rss-1", "https://example.com/engineering/rss-2"]
        adapter = _adapter(
            [{"type": "rss", "url": "https://example.com/engineering/rss.xml"}],
            routes={"https://example.com/engineering/rss.xml": _fixture("rss.xml"), **_article_routes(urls)},
        )
        result = adapter.collect("blog:example", {"mode": "shadow"})
        batch = runtime.build_batch(adapter, "blog:example", {"mode": "shadow"}, result)
        validate_batch(batch)
        self.assertEqual(batch["source_status"]["status"], "ok")
        self.assertEqual(len(batch["items"]), 2)
        self.assertEqual(batch["items"][0]["candidate_id"], "blog:example:" + urls[0])


if __name__ == "__main__":
    unittest.main()
