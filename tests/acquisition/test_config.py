"""Tests for acquisition config: source registry and credential references."""

from __future__ import annotations

import copy
from collections.abc import Mapping
import json
import re
import unittest
from pathlib import Path

from follow_up_acquisition.config import (
    ADAPTER_IDS,
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


VALID_ADAPTER_INPUTS = {
    "x": {"handle": "example"},
    "rss": {"rss_url": "https://example.com/feed", "url": "https://example.com/", "language": "en"},
    "newsletter": {"rss_url": "https://example.com/feed"},
    "podcast": {"rss_url": "https://example.com/podcast.xml"},
    "web-publication": {
        "url": "https://example.com/blog", "language": "en",
        "discovery": [{"type": "rss", "url": "https://example.com/feed"}],
        "article_url_patterns": [r"^https://example\.com/posts/[^/]+$"],
        "exclude_url_patterns": [], "parser": None,
    },
    "arxiv": {"rss_url": "https://rss.arxiv.org/rss/cs.AI", "url": "https://arxiv.org/list/cs.AI/recent"},
    "github": {
        "rest_api_url": "https://api.github.com", "graphql_url": "https://api.github.com/graphql",
        "include_discussions": False,
        "queries": [{"id": "agents", "query": "agentic systems", "sort": "updated",
                     "filters": {"entities": ["repository"], "min_stars": 1}}],
    },
    "hackernews": {
        "firebase_url": "https://hacker-news.firebaseio.com/v0",
        "algolia_url": "https://hn.algolia.com/api/v1", "top_enabled": True, "new_enabled": True,
        "queries": [{"id": "agents", "query": "AI agents", "sort": "date",
                     "filters": {"tags": ["story"], "min_points": 0}}],
    },
    "reddit": {"subreddit": "MachineLearning",
               "rss_url": "https://www.reddit.com/r/MachineLearning/.rss",
               "listing_url": "https://www.reddit.com/r/MachineLearning/new.json"},
    "techmeme": {"front_url": "https://www.techmeme.com/",
                 "archive_url_template": "https://www.techmeme.com/{date}"},
    "hugging-face-papers": {"structured_endpoint": "https://huggingface.co/api/daily_papers",
                            "page_base_url": "https://huggingface.co/papers",
                            "views": ["daily", "trending", "weekly"], "timezone": "Asia/Shanghai"},
    "report": {"url": "https://example.com/report"},
    "youtube": {}, "digg": {}, "xiaohongshu": {}, "wechat": {},
}


def _source_for_adapter(adapter, input_value=None):
    if adapter == "x":
        identity = {"id": "x:test", "channel": "x", "channel_policy": "fixed"}
    elif adapter == "podcast":
        identity = {"id": "podcast:test", "channel": "podcasts", "channel_policy": "fixed"}
    elif adapter in {"rss", "newsletter"}:
        identity = {"id": "newsletter:test", "channel": "newsletters", "channel_policy": "fixed"}
    elif adapter == "web-publication":
        identity = {"id": "blog:test", "channel": "blogs", "channel_policy": "fixed"}
    elif adapter in {"arxiv", "hugging-face-papers"}:
        identity = {"id": "academic:test", "channel": "academic", "channel_policy": "fixed"}
    elif adapter == "report":
        identity = {"id": "report:test", "channel": "reports", "channel_policy": "fixed"}
    else:
        identity = {"id": f"community:{adapter}", "channel": None, "channel_policy": "core-topic"}
    return _mutate(adapter=adapter, input=copy.deepcopy(
        VALID_ADAPTER_INPUTS[adapter] if input_value is None else input_value
    ), legacy={"feed": None}, **identity)


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
        for budget in (0, -1, "3", True, 1001):
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


class AdapterInputAdversarialTests(unittest.TestCase):
    def test_registry_schema_string_requires_exact_builtin_type(self):
        class StringSubclass(str):
            pass

        registry = _registry([VALID_SOURCE])
        registry["schema_version"] = StringSubclass("1.0")
        with self.assertRaisesRegex(ConfigError, "schema_version"):
            validate_source_registry(registry)

    def test_every_allowed_adapter_has_an_explicit_valid_input_schema(self):
        self.assertEqual(set(VALID_ADAPTER_INPUTS), set(ADAPTER_IDS))
        for adapter in sorted(ADAPTER_IDS):
            with self.subTest(adapter=adapter):
                validate_source_registry(_registry([_source_for_adapter(adapter)]))

    def test_every_allowed_adapter_rejects_arbitrary_input_fields(self):
        for adapter in sorted(ADAPTER_IDS):
            with self.subTest(adapter=adapter):
                value = copy.deepcopy(VALID_ADAPTER_INPUTS[adapter])
                value["unexpected"] = "must-not-pass"
                with self.assertRaisesRegex(ConfigError, r"sources\[0\].*input"):
                    validate_source_registry(_registry([_source_for_adapter(adapter, value)]))

    def test_exact_builtin_containers_are_required_before_reflection(self):
        class DictSubclass(dict):
            pass

        class ListSubclass(list):
            pass

        cases = [
            _source_for_adapter("x", DictSubclass(handle="safe")),
            _source_for_adapter("github", {
                **VALID_ADAPTER_INPUTS["github"],
                "queries": ListSubclass(VALID_ADAPTER_INPUTS["github"]["queries"]),
            }),
            _source_for_adapter("web-publication", {
                **VALID_ADAPTER_INPUTS["web-publication"],
                "discovery": [DictSubclass(type="rss", url="https://example.com/feed")],
            }),
        ]
        for source in cases:
            with self.subTest(adapter=source["adapter"]), self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))

    def test_strings_are_exact_nonempty_and_control_free(self):
        class StringSubclass(str):
            pass

        cases = [
            _source_for_adapter("x", {"handle": StringSubclass("example")}),
            _source_for_adapter("x", {"handle": ""}),
            _source_for_adapter("x", {"handle": "safe\x00unsafe"}),
            _source_for_adapter("github", {
                **VALID_ADAPTER_INPUTS["github"],
                "queries": [{**VALID_ADAPTER_INPUTS["github"]["queries"][0], "query": "AI\x7fagents"}],
            }),
            _source_for_adapter("github", {
                **VALID_ADAPTER_INPUTS["github"],
                "queries": [{**VALID_ADAPTER_INPUTS["github"]["queries"][0],
                             "filters": {"entities": ["repository"], "owner": "bad\x85owner"}}],
            }),
        ]
        for source in cases:
            with self.subTest(adapter=source["adapter"]), self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))

    def test_urls_require_exact_https_strings_without_echoing_values(self):
        class StringSubclass(str):
            pass

        hostile_values = [StringSubclass("https://example.com/feed"), 7, "http://example.com/feed",
                          "https://example.com/\x1fsecret"]
        for value in hostile_values:
            source = _source_for_adapter("rss", {"rss_url": value})
            with self.subTest(value_type=type(value).__name__), self.assertRaises(ConfigError) as caught:
                validate_source_registry(_registry([source]))
            self.assertNotIn(str(value), str(caught.exception))

    def test_https_authority_rejects_malformed_ports_hosts_and_userinfo(self):
        invalid_urls = (
            "https://example.com:abc/feed", "https://example.com:/feed",
            "https://example.com:0/feed", "https://example.com:65536/feed", "https://example.com:-1/feed",
            "https://example.com:+443/feed", "https://user@example.com/feed",
            "https://user:pass@example.com/feed", "https:// example.com/feed",
            "https://example .com/feed", "https://example\u00a0.com/feed",
            "https://foo..example.com/feed", "https://.example.com/feed",
            "https://example.com./feed", f"https://{'a' * 64}.example/feed",
            "https://-bad.example/feed", "https://bad-.example/feed",
            "https://bad_host.example/feed", "https://999.1.1.1/feed",
            "https://1.2.3/feed", "https://[gggg::1]/feed", "https://2001:db8::1/feed",
            "https://[2001:db8::1]suffix/feed", "https://[2001:db8::1]:443:444/feed",
        )
        for url in invalid_urls:
            with self.subTest(url=url):
                with self.assertRaises(ConfigError) as caught:
                    validate_source_registry(_registry([_source_for_adapter("rss", {"rss_url": url})]))
                self.assertNotIn(url, str(caught.exception))

    def test_https_authority_accepts_valid_dns_idna_ipv4_ipv6_and_ports(self):
        valid_urls = (
            "https://example.com/feed", "https://sub.example.com:8443/feed",
            "https://127.0.0.1:443/feed", "https://[2001:db8::1]/feed",
            "https://[2001:db8::1]:8443/feed", "https://例子.测试/feed",
        )
        for url in valid_urls:
            with self.subTest(url=url):
                validate_source_registry(_registry([_source_for_adapter("rss", {"rss_url": url})]))

    def test_boolean_and_integer_fields_reject_coercible_or_unbounded_values(self):
        boolean_cases = [1, 0, "false", None]
        for value in boolean_cases:
            source = _source_for_adapter("github", {
                **VALID_ADAPTER_INPUTS["github"], "include_discussions": value,
            })
            with self.subTest(value=value), self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))
        for value in (True, -1, 1_000_000_001):
            query = copy.deepcopy(VALID_ADAPTER_INPUTS["hackernews"]["queries"][0])
            query["filters"]["min_points"] = value
            source = _source_for_adapter("hackernews", {
                **VALID_ADAPTER_INPUTS["hackernews"], "queries": [query],
            })
            with self.subTest(value=value), self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))

    def test_arrays_require_exact_lists_typed_items_and_no_set_duplicates(self):
        cases = [
            _source_for_adapter("web-publication", {
                **VALID_ADAPTER_INPUTS["web-publication"], "article_url_patterns": (".*",),
            }),
            _source_for_adapter("web-publication", {
                **VALID_ADAPTER_INPUTS["web-publication"], "exclude_url_patterns": [1],
            }),
            _source_for_adapter("github", {
                **VALID_ADAPTER_INPUTS["github"],
                "queries": [{**VALID_ADAPTER_INPUTS["github"]["queries"][0],
                             "filters": {"entities": ["repository", "repository"]}}],
            }),
            _source_for_adapter("hugging-face-papers", {
                **VALID_ADAPTER_INPUTS["hugging-face-papers"], "views": ("daily", "trending", "weekly"),
            }),
        ]
        for source in cases:
            with self.subTest(adapter=source["adapter"]), self.assertRaises(ConfigError):
                validate_source_registry(_registry([source]))

    def test_web_publication_nested_objects_are_closed_and_regexes_compile(self):
        cases = [
            {**VALID_ADAPTER_INPUTS["web-publication"],
             "discovery": [{"type": "rss", "url": "https://example.com/feed", "extra": True}]},
            {**VALID_ADAPTER_INPUTS["web-publication"], "article_url_patterns": ["["]},
            {**VALID_ADAPTER_INPUTS["web-publication"], "parser": 7},
            {**VALID_ADAPTER_INPUTS["web-publication"], "content_selectors": [],
             "content_selector_priority": True},
            {**VALID_ADAPTER_INPUTS["web-publication"],
             "discovery": [VALID_ADAPTER_INPUTS["web-publication"]["discovery"][0]] * 2},
            {**VALID_ADAPTER_INPUTS["web-publication"],
             "discovery": [{"type": "json", "url": "https://example.com/api",
                            "publicUrl": "https://example.com/{path}",
                            "detailUrl": "https://example.com/api"}]},
            {**VALID_ADAPTER_INPUTS["web-publication"],
             "discovery": [{"type": "json", "url": "https://example.com/api",
                            "publicUrl": "https://evil.example/{path}",
                            "detailUrl": "https://example.com/api/{path}"}],
             "fetch_url_patterns": [r"^https://example\.com/api/[^/]+$"]},
        ]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ConfigError):
                validate_source_registry(_registry([_source_for_adapter("web-publication", value)]))


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

    def test_rejects_root_and_nested_container_subclasses_at_their_paths(self):
        class DictSubclass(dict):
            pass

        class ListSubclass(list):
            pass

        cases = (
            (DictSubclass(mode="central"), "$"),
            ({"delivery": DictSubclass(mode="central")}, "$.delivery"),
            ({"delivery": ListSubclass([{"mode": "central"}])}, "$.delivery"),
            ({"api_key": DictSubclass(ref="env.X_API_KEY")}, "$.api_key"),
        )
        for config, path in cases:
            with self.subTest(path=path), self.assertRaisesRegex(ConfigError, re.escape(path)):
                validate_credential_references(config)

    def test_rejects_hostile_mapping_without_iterating_or_rendering_it(self):
        class HostileMapping(Mapping):
            iterated = False
            rendered = False

            def __getitem__(self, key):
                raise AssertionError("must not index hostile mapping")

            def __iter__(self):
                type(self).iterated = True
                raise AssertionError("must not iterate hostile mapping")

            def __len__(self):
                raise AssertionError("must not size hostile mapping")

            def __repr__(self):
                type(self).rendered = True
                raise AssertionError("must not render hostile mapping")

        hostile = HostileMapping()
        for config, path in ((hostile, "$"), ({"nested": hostile}, "$.nested")):
            with self.subTest(path=path), self.assertRaisesRegex(ConfigError, re.escape(path)):
                validate_credential_references(config)
        self.assertFalse(HostileMapping.iterated)
        self.assertFalse(HostileMapping.rendered)

    def test_credential_reference_requires_exact_safe_ref_and_no_raw_sibling(self):
        class StringSubclass(str):
            pass

        invalid = (
            {"api_key": {"ref": StringSubclass("env.X_API_KEY")}},
            {"api_key": {"ref": ""}},
            {"api_key": {"ref": "env.X\x00_API_KEY"}},
            {"api_key": {"ref": "env.X_API_KEY", "token": "raw"}},
        )
        for config in invalid:
            with self.subTest(), self.assertRaises(ConfigError):
                validate_credential_references(config)

    def test_allows_safe_nested_exact_builtin_credential_tree(self):
        validate_credential_references({
            "delivery": [{"provider": "example", "api_key": {"ref": "env.X_API_KEY"}}],
        })


class AcquisitionModeTests(unittest.TestCase):
    def test_accepts_known_modes(self):
        for mode in ("central", "shadow", "hybrid", "local"):
            validate_acquisition_mode(mode)

    def test_rejects_unknown_mode(self):
        with self.assertRaises(ConfigError):
            validate_acquisition_mode("cloud")


if __name__ == "__main__":
    unittest.main()
