"""Tests for shadow-mode collection wiring."""

from __future__ import annotations

import unittest

from follow_up_acquisition.adapters.rss import RssAdapter
from follow_up_acquisition.adapters.web_publication import WebPublicationAdapter
from follow_up_acquisition.collect import (
    SHADOW_REQUEST,
    build_source_pairs,
    collect_sources,
)


def _source(source_id: str, adapter: str) -> dict:
    return {
        "id": source_id,
        "name": source_id,
        "channel": "blogs",
        "channel_policy": "fixed",
        "adapter": adapter,
        "requires_credentials": False,
        "default_enabled": True,
        "cadence": "daily",
        "budget": 3,
        "input": {"url": "https://example.com", "rss_url": "https://example.com/feed"},
        "legacy": {"feed": None},
    }


class BuildSourcePairsTests(unittest.TestCase):
    def test_shadow_request_mode(self):
        self.assertEqual(SHADOW_REQUEST, {"mode": "shadow"})

    def test_maps_rss_and_web_publication_adapters(self):
        sources = [
            _source("newsletter:x", "rss"),
            _source("blog:y", "web-publication"),
        ]
        pairs = build_source_pairs(sources)
        self.assertEqual(len(pairs), 2)
        self.assertIsInstance(pairs[0][0], RssAdapter)
        self.assertEqual(pairs[0][1], "newsletter:x")
        self.assertIsInstance(pairs[1][0], WebPublicationAdapter)
        self.assertEqual(pairs[1][1], "blog:y")

    def test_skips_unimplemented_adapters(self):
        sources = [
            _source("x:a", "x"),
            _source("podcast:b", "podcast"),
            _source("academic:c", "arxiv"),
            _source("report:d", "report"),
        ]
        self.assertEqual(build_source_pairs(sources), [])


class CollectSourcesTests(unittest.TestCase):
    def test_collect_sources_returns_empty_when_nothing_collectable(self):
        sources = [_source("x:a", "x")]
        self.assertEqual(collect_sources(sources), {})


if __name__ == "__main__":
    unittest.main()
