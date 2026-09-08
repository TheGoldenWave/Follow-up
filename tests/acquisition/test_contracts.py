"""Tests for the versioned Signal Batch contract."""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from follow_up_acquisition.contracts import (
    SCHEMA_VERSION,
    SOURCE_STATUSES,
    SignalBatchError,
    validate_batch,
    validate_batch_file,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "signal-batch-valid.json"


def _load_fixture() -> dict:
    with open(FIXTURE, encoding="utf-8") as handle:
        return json.load(handle)


class SignalBatchContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.batch = _load_fixture()

    def test_valid_fixture_passes(self) -> None:
        validate_batch(self.batch)

    def test_valid_fixture_file_passes(self) -> None:
        self.assertEqual(validate_batch_file(FIXTURE)["schema_version"], SCHEMA_VERSION)

    def test_rejects_non_object(self) -> None:
        for value in (None, [], "batch", 42):
            with self.assertRaises(SignalBatchError):
                validate_batch(value)

    def test_rejects_missing_envelope_field(self) -> None:
        for field in (
            "batch_id",
            "generated_at",
            "adapter_id",
            "adapter_version",
            "source",
            "request",
            "source_status",
            "items",
        ):
            bad = copy.deepcopy(self.batch)
            del bad[field]
            with self.assertRaises(SignalBatchError):
                validate_batch(bad)

    def test_rejects_unknown_envelope_field(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["bogus"] = "x"
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_rejects_wrong_schema_version(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["schema_version"] = "0.9"
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_accepts_empty_items(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["items"] = []
        validate_batch(bad)

    def test_rejects_items_not_array(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["items"] = {}
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_rejects_unknown_source_status(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["source_status"]["status"] = "down"
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_accepts_every_declared_source_status(self) -> None:
        for status in SOURCE_STATUSES:
            bad = copy.deepcopy(self.batch)
            bad["source_status"]["status"] = status
            validate_batch(bad)

    def test_rejects_missing_retryable(self) -> None:
        bad = copy.deepcopy(self.batch)
        del bad["source_status"]["retryable"]
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_rejects_malformed_generated_at(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["generated_at"] = "not-a-date"
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_rejects_unknown_request_field(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["request"]["bogus"] = "x"
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_rejects_malformed_item(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["items"] = [{"candidate_id": "x"}]
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_rejects_invalid_date_confidence(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["items"][0]["date_confidence"] = "maybe"
        with self.assertRaises(SignalBatchError):
            validate_batch(bad)

    def test_rejects_embedded_credentials(self) -> None:
        for key in (
            "authorization",
            "cookie",
            "token",
            "api_key",
            "api-key",
            "password",
            "phone",
            "qr_code",
        ):
            bad = copy.deepcopy(self.batch)
            bad["items"][0]["native_metrics"][key] = "secret-value"
            with self.assertRaises(SignalBatchError) as ctx:
                validate_batch(bad)
            self.assertIn("credential", str(ctx.exception))

    def test_accepts_metrics_without_credentials(self) -> None:
        bad = copy.deepcopy(self.batch)
        bad["items"][0]["native_metrics"] = {"likes": 10, "shares": 3}
        validate_batch(bad)

    def test_source_statuses_and_schema_enum_match(self) -> None:
        # Keep the stdlib validator and the JSON Schema contract in sync.
        schema_path = Path(__file__).resolve().parents[2] / "contracts" / "signal-batch.schema.json"
        with open(schema_path, encoding="utf-8") as handle:
            schema = json.load(handle)
        schema_enum = set(schema["$defs"]["sourceStatus"]["properties"]["status"]["enum"])
        self.assertEqual(schema_enum, set(SOURCE_STATUSES))


if __name__ == "__main__":
    unittest.main()
