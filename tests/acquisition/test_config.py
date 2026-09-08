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
        self.assertEqual(len(sources), 82)

    def test_generated_registry_has_expected_live_count(self):
        sources = load_source_registry(REGISTRY_PATH)
        live = [s for s in sources if s["legacy"]["feed"] is not None]
        self.assertEqual(len(live), 70)

    def test_generated_registry_covers_all_channels(self):
        sources = load_source_registry(REGISTRY_PATH)
        self.assertEqual({s["channel"] for s in sources}, set(CHANNEL_IDS))

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
            id="reddit:machinelearning",
            name="r/MachineLearning",
            channel=None,
            channel_policy="core-topic",
            adapter="reddit",
            input={"subreddit": "MachineLearning"},
            legacy={"feed": None},
        )
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
