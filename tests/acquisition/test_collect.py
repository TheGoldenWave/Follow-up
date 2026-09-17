"""Tests for shadow-mode collection wiring."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from follow_up_acquisition.adapters.rss import RssAdapter
from follow_up_acquisition.adapters.arxiv import ArxivAdapter
from follow_up_acquisition.adapters.techmeme import TechmemeAdapter
from follow_up_acquisition.adapters.web_publication import WebPublicationAdapter
from follow_up_acquisition.collect import (
    CollectionRun,
    SHADOW_REQUEST,
    build_source_pairs,
    collect_run,
    collect_sources,
    derive_active_stream_ids,
)
from follow_up_acquisition.runtime import CheckpointUpdate, FrozenMapping, SourceResult


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

    def test_maps_rss_techmeme_and_web_publication_adapters(self):
        sources = [
            _source("newsletter:x", "rss"),
            _source("community:techmeme", "techmeme"),
            _source("blog:y", "web-publication"),
        ]
        sources[1]["input"] = {
            "front_url": "https://www.techmeme.com/",
            "archive_url_template": "https://www.techmeme.com/{snapshot}",
        }
        pairs = build_source_pairs(sources)
        self.assertEqual(len(pairs), 3)
        self.assertIsInstance(pairs[0][0], RssAdapter)
        self.assertEqual(pairs[0][1], "newsletter:x")
        self.assertIsInstance(pairs[1][0], TechmemeAdapter)
        self.assertEqual(pairs[1][1], "community:techmeme")
        self.assertIsInstance(pairs[2][0], WebPublicationAdapter)
        self.assertEqual(pairs[2][1], "blog:y")

    def test_collects_arxiv_and_skips_unimplemented_adapters(self):
        sources = [
            _source("x:a", "x"),
            _source("podcast:b", "podcast"),
            _source("academic:c", "arxiv"),
            _source("report:d", "report"),
        ]
        pairs = build_source_pairs(sources)
        self.assertEqual(len(pairs), 1)
        self.assertIsInstance(pairs[0][0], ArxivAdapter)
        self.assertEqual(pairs[0][1], "academic:c")


class CollectSourcesTests(unittest.TestCase):
    def test_collect_sources_returns_empty_when_nothing_collectable(self):
        sources = [_source("x:a", "x")]
        self.assertEqual(collect_sources(sources), {})

    def test_collect_run_retains_immutable_checkpoint_updates(self):
        source = _source("newsletter:x", "rss")
        update = CheckpointUpdate("rss", None, FrozenMapping({"cursor": None}))
        fake_result = SourceResult("rss", "1.0", source["id"], "ok", checkpoint_updates=(update,))
        batch = {"source": source["id"], "batch_id": "batch-1"}
        with patch("follow_up_acquisition.collect.AcquisitionRuntime.collect_one", return_value=fake_result), \
             patch("follow_up_acquisition.collect.AcquisitionRuntime.build_batch", return_value=batch):
            result = collect_run([source])
            compatible = collect_sources([source])
        self.assertIsInstance(result, CollectionRun)
        self.assertEqual(result.batches, {source["id"]: batch})
        retained = result.checkpoint_updates[source["id"]][0]
        self.assertIsInstance(retained.checkpoint, FrozenMapping)
        self.assertEqual(compatible, {source["id"]: batch})

    def test_active_stream_ids_are_adapter_defined_and_canonically_sorted(self):
        github = _source("community:github", "github")
        github["input"] = {
            "include_discussions": True,
            "queries": [{"id": "zeta"}, {"id": "alpha"}],
        }
        hn = _source("community:hacker-news", "hackernews")
        hn["input"] = {
            "top_enabled": True, "new_enabled": False,
            "queries": [{"id": "zeta"}, {"id": "alpha"}],
        }
        hf = _source("academic:hugging-face-papers", "hugging-face-papers")
        hf["input"] = {"views": ["weekly", "daily", "trending"]}
        techmeme = _source("community:techmeme", "techmeme")
        techmeme["input"] = {
            "front_url": "https://www.techmeme.com/",
            "archive_url_template": "https://www.techmeme.com/{snapshot}",
        }
        self.assertEqual(
            derive_active_stream_ids(github),
            ("discussions", "query.alpha", "query.zeta"),
        )
        self.assertEqual(
            derive_active_stream_ids(hn),
            ("search.alpha", "search.zeta", "top"),
        )
        self.assertEqual(
            derive_active_stream_ids(hf),
            ("daily", "trending", "weekly"),
        )
        self.assertEqual(
            derive_active_stream_ids(techmeme),
            ("archive", "front"),
        )


if __name__ == "__main__":
    unittest.main()
