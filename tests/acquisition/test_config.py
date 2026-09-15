"""Tests for acquisition config: source registry and credential references."""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from follow_up_acquisition.config import (
    CHANNEL_IDS,
    ConfigError,
    load_source_registry,
    validate_acquisition_mode,
    validate_credential_references,
    validate_source_registry,
)

REGISTRY_PATH = Path(__file__).resolve().parents[2] / "config" / "sources.json"

V03_SOURCE_IDS = frozenset("""
academic:arxiv-cs-ai academic:arxiv-cs-cl academic:arxiv-cs-cr academic:arxiv-cs-cv
academic:arxiv-cs-lg academic:arxiv-cs-ro blog:amazon-science blog:anthropic-engineering
blog:anthropic-interpretability blog:anthropic-science blog:apple-ml-research blog:claude-blog
blog:ernie-blog blog:google-antigravity blog:google-deepmind blog:google-research blog:ibm-research
blog:kimi-blog blog:microsoft-research blog:minimax-blog blog:openai-alignment blog:perplexity-research
blog:qwen-blog newsletter:ai-snake-oil newsletter:algorithmic-bridge newsletter:bens-bites
newsletter:import-ai newsletter:one-useful-thing newsletter:stratechery newsletter:the-batch
newsletter:the-gradient newsletter:tldr-ai podcast:acquired podcast:ai-and-i
podcast:cognitive-revolution podcast:latent-space podcast:lex-fridman podcast:lightcone
podcast:mad-podcast podcast:no-priors podcast:training-data podcast:unsupervised-learning
report:a16z-ai-canon report:cbinsights-ai report:firstmark-mad report:stanford-ai-index
report:state-of-ai x:adityaag x:alexalbert x:amandaaskell x:amasad x:bcherny x:bentossell
x:catwu x:claudeai x:danshipper x:dario-amodei x:garrytan x:googlelabs x:jackclarksf
x:joshwoodward x:karpathy x:levie x:mattturck x:nathanlabenz x:nikunj x:petergyang
x:rauchg x:realmadhuguru x:ryolu x:sama x:steipete x:swyx x:thenanyu x:thsottiaux
x:trq212 x:zarazhangrui zh-tech:36kr zh-tech:aiera zh-tech:jiqizhixin zh-tech:qbitai
zh-tech:sspai
""".split())

V04_SOURCE_IDS = frozenset({
    "community:github", "community:hacker-news", "community:techmeme",
    "community:reddit-machinelearning", "community:reddit-localllama",
    "community:reddit-artificial", "academic:hugging-face-papers",
})

VALID_SOURCE = {
    "id": "x:test",
    "name": "Test",
    "channel": "x",
    "channel_policy": "fixed",
    "adapter": "x",
    "requires_credentials": False,
    "default_enabled": True,
    "cadence": "daily",
    "budget": 5,
    "input": {"handle": "test"},
    "legacy": {"feed": "feed-x.json"},
}


def _registry(sources):
    return {"schema_version": "1.0", "sources": sources}


def _mutate(**overrides):
    source = copy.deepcopy(VALID_SOURCE)
    source.update(overrides)
    return source


class GeneratedRegistryTests(unittest.TestCase):
    def test_generated_registry_is_valid(self):
        sources = load_source_registry(REGISTRY_PATH)
        self.assertEqual(len(sources), 89)

    def test_v03_source_id_set_is_preserved_exactly(self):
        ids = {source["id"] for source in load_source_registry(REGISTRY_PATH)}
        self.assertEqual(len(V03_SOURCE_IDS), 82)
        self.assertEqual(ids - V04_SOURCE_IDS, V03_SOURCE_IDS)

    def test_v04_sources_have_frozen_policy_and_budget(self):
        sources = {source["id"]: source for source in load_source_registry(REGISTRY_PATH)}
        self.assertEqual(V04_SOURCE_IDS, V04_SOURCE_IDS & sources.keys())
        for source_id in V04_SOURCE_IDS - {"academic:hugging-face-papers"}:
            source = sources[source_id]
            self.assertEqual((source["channel_policy"], source["channel"]), ("core-topic", None))
            self.assertTrue(source["default_enabled"])
            self.assertEqual(source["cadence"], "daily")
            self.assertIsNone(source["legacy"]["feed"])
        self.assertEqual(sources["community:github"]["budget"], 10)
        self.assertEqual(sources["community:hacker-news"]["budget"], 10)
        self.assertEqual(sources["community:techmeme"]["budget"], 10)
        for source_id in V04_SOURCE_IDS & {sid for sid in sources if "reddit-" in sid}:
            self.assertEqual(sources[source_id]["budget"], 5)
        hf = sources["academic:hugging-face-papers"]
        self.assertEqual((hf["adapter"], hf["channel_policy"], hf["channel"]),
                         ("hugging-face-papers", "fixed", "academic"))
        self.assertEqual(hf["budget"], 15)

    def test_v04_query_ids_and_semantics_are_stable(self):
        sources = {source["id"]: source for source in load_source_registry(REGISTRY_PATH)}
        expected = {
            "community:github": ["agentic-systems", "llm-infrastructure", "ai-safety"],
            "community:hacker-news": ["ai-agents", "language-models", "ai-safety"],
        }
        for source_id, expected_ids in expected.items():
            queries = sources[source_id]["input"]["queries"]
            self.assertEqual([query["id"] for query in queries], expected_ids)
            self.assertEqual(len({query["id"] for query in queries}), len(queries))
        github = sources["community:github"]["input"]
        self.assertFalse(github["include_discussions"])
        self.assertTrue(github["rest_api_url"].startswith("https://"))
        self.assertTrue(github["graphql_url"].startswith("https://"))
        hn = sources["community:hacker-news"]["input"]
        self.assertEqual((hn["top_enabled"], hn["new_enabled"]), (True, True))
        self.assertTrue(hn["firebase_url"].startswith("https://"))
        self.assertTrue(hn["algolia_url"].startswith("https://"))

    def test_v04_fixed_public_inputs(self):
        sources = {source["id"]: source for source in load_source_registry(REGISTRY_PATH)}
        expected_subreddits = {
            "community:reddit-machinelearning": "MachineLearning",
            "community:reddit-localllama": "LocalLLaMA",
            "community:reddit-artificial": "artificial",
        }
        for source_id, subreddit in expected_subreddits.items():
            source_input = sources[source_id]["input"]
            self.assertEqual(source_input["subreddit"], subreddit)
            self.assertIn(f"/r/{subreddit}/", source_input["rss_url"])
            self.assertIn(f"/r/{subreddit}/", source_input["listing_url"])
        hf = sources["academic:hugging-face-papers"]["input"]
        self.assertEqual(hf["views"], ["daily", "trending", "weekly"])
        self.assertEqual(hf["timezone"], "Asia/Shanghai")

    def test_generated_registry_has_expected_live_count(self):
        sources = load_source_registry(REGISTRY_PATH)
        live = [s for s in sources if s["legacy"]["feed"] is not None]
        self.assertEqual(len(live), 70)

    def test_generated_registry_covers_all_channels(self):
        sources = load_source_registry(REGISTRY_PATH)
        self.assertEqual({s["channel"] for s in sources if s["channel"] is not None}, set(CHANNEL_IDS))

    def test_generated_registry_ids_are_unique_and_namespaced(self):
        sources = load_source_registry(REGISTRY_PATH)
        ids = [s["id"] for s in sources]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(":" in sid for sid in ids))


class SourceRegistryValidationTests(unittest.TestCase):
    def test_valid_source_passes(self):
        self.assertEqual(len(validate_source_registry(_registry([VALID_SOURCE]))), 1)

    def test_rejects_wrong_schema_version(self):
        registry = _registry([VALID_SOURCE])
        registry["schema_version"] = "0.9"
        with self.assertRaises(ConfigError):
            validate_source_registry(registry)

    def test_rejects_duplicate_id(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([VALID_SOURCE, VALID_SOURCE]))

    def test_rejects_non_namespaced_id(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(id="karpathy")]))

    def test_rejects_missing_required_field(self):
        source = copy.deepcopy(VALID_SOURCE)
        del source["budget"]
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([source]))

    def test_rejects_unknown_field(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(bogus="x")]))

    def test_rejects_invalid_channel_policy(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(channel_policy="floating")]))

    def test_rejects_invalid_fixed_channel(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(channel="nonexistent")]))

    def test_core_topic_requires_null_channel(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(channel_policy="core-topic")]))

    def test_accepts_valid_core_topic_source(self):
        source = _mutate(
            id="community:reddit-machinelearning",
            name="r/MachineLearning",
            channel=None,
            channel_policy="core-topic",
            adapter="reddit",
            input={"subreddit": "MachineLearning",
                   "rss_url": "https://www.reddit.com/r/MachineLearning/.rss",
                   "listing_url": "https://www.reddit.com/r/MachineLearning/new.json"},
            legacy={"feed": None},
        )
        validate_source_registry(_registry([source]))

    def test_core_topic_requires_community_namespace(self):
        source = _mutate(id="reddit:machinelearning", channel=None,
                         channel_policy="core-topic", adapter="reddit",
                         input={"subreddit": "MachineLearning",
                                "rss_url": "https://www.reddit.com/r/MachineLearning/.rss",
                                "listing_url": "https://www.reddit.com/r/MachineLearning/new.json"},
                         legacy={"feed": None})
        with self.assertRaisesRegex(ConfigError, "community"):
            validate_source_registry(_registry([source]))

    def test_rejects_unknown_adapter(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(adapter="telepathy")]))

    def test_rejects_invalid_cadence(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(cadence="hourly")]))

    def test_rejects_invalid_budget(self):
        for budget in (0, -1, "3", True):
            with self.assertRaises(ConfigError):
                validate_source_registry(_registry([_mutate(budget=budget)]))

    def test_rejects_credential_key_in_input(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(input={"cookie": "abc"})]))

    def test_rejects_legacy_without_feed(self):
        with self.assertRaises(ConfigError):
            validate_source_registry(_registry([_mutate(legacy={})]))

    def test_rejects_unknown_adapter_input_fields(self):
        source = _mutate(input={"handle": "test", "unexpected": True})
        with self.assertRaisesRegex(ConfigError, "unknown input field"):
            validate_source_registry(_registry([source]))

    def test_rejects_invalid_or_missing_https_urls(self):
        for input_value in ({"rss_url": "http://example.com/feed", "url": "https://example.com"},
                            {"url": "https://example.com"}):
            source = _mutate(id="academic:test", channel="academic", adapter="arxiv", input=input_value)
            with self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))

    def test_rejects_invalid_duplicate_and_semantically_invalid_queries(self):
        base = {
            "rest_api_url": "https://api.github.com", "graphql_url": "https://api.github.com/graphql",
            "include_discussions": False,
            "queries": [{"id": "valid-id", "query": "agentic systems", "sort": "updated",
                         "filters": {"entities": ["repository"]}}],
        }
        for queries in (
            [{**base["queries"][0], "id": "Not Stable"}],
            [base["queries"][0], base["queries"][0]],
            [{**base["queries"][0], "sort": "date"}],
            [{**base["queries"][0], "filters": {"bogus": True}}],
            [{**base["queries"][0], "filters": {"entities": ["discussion"]}}],
        ):
            source = _mutate(id="community:test", channel=None, channel_policy="core-topic",
                             adapter="github", input={**base, "queries": queries}, legacy={"feed": None})
            with self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))

    def test_rejects_hackernews_unknown_tags_and_filters(self):
        base = {
            "firebase_url": "https://hacker-news.firebaseio.com/v0",
            "algolia_url": "https://hn.algolia.com/api/v1",
            "top_enabled": True, "new_enabled": True,
        }
        for filters in ({"tags": ["comment"]}, {"unknown": 1}):
            source = _mutate(
                id="community:test", channel=None, channel_policy="core-topic", adapter="hackernews",
                input={**base, "queries": [{"id": "ai", "query": "AI", "sort": "date", "filters": filters}]},
                legacy={"feed": None},
            )
            with self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))

    def test_rejects_reddit_subreddit_url_mismatch(self):
        source = _mutate(
            id="community:reddit-test", channel=None, channel_policy="core-topic", adapter="reddit",
            input={"subreddit": "MachineLearning", "rss_url": "https://www.reddit.com/r/artificial/.rss",
                   "listing_url": "https://www.reddit.com/r/MachineLearning/new.json"}, legacy={"feed": None},
        )
        with self.assertRaisesRegex(ConfigError, "subreddit"):
            validate_source_registry(_registry([source]))

    def test_rejects_hugging_face_view_order_or_timezone_shape(self):
        base = {"structured_endpoint": "https://huggingface.co/api/papers",
                "page_base_url": "https://huggingface.co/papers", "timezone": "Asia/Shanghai",
                "views": ["daily", "trending", "weekly"]}
        for changes in ({"views": ["trending", "daily", "weekly"]}, {"timezone": "UTC"}):
            source = _mutate(id="academic:hf", channel="academic", adapter="hugging-face-papers",
                             input={**base, **changes}, legacy={"feed": None})
            with self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))


class CredentialReferenceTests(unittest.TestCase):
    def test_accepts_credential_reference(self):
        validate_credential_references({"api_key": {"ref": "env.X_API_KEY"}})

    def test_rejects_raw_credential_value(self):
        for key, value in (
            ("api_key", "sk-raw"),
            ("token", "raw-token"),
            ("cookie", "session=abc"),
            ("secret", "hunter2"),
            ("password", "hunter2"),
        ):
            with self.assertRaises(ConfigError):
                validate_credential_references({key: value})

    def test_rejects_nested_raw_credential(self):
        with self.assertRaises(ConfigError):
            validate_credential_references({"delivery": {"telegram": {"token": "raw"}}})

    def test_ignores_benign_keys(self):
        validate_credential_references({"mode": "central", "depth": 3, "enabled": True})


class AcquisitionModeTests(unittest.TestCase):
    def test_accepts_known_modes(self):
        for mode in ("central", "shadow", "hybrid", "local"):
            validate_acquisition_mode(mode)

    def test_rejects_unknown_mode(self):
        with self.assertRaises(ConfigError):
            validate_acquisition_mode("cloud")


if __name__ == "__main__":
    unittest.main()
