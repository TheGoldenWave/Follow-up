"""Tests for the acquisition runtime orchestration and serialization."""

from __future__ import annotations

import dataclasses
import json
import unittest

from follow_up_acquisition.contracts import SCHEMA_VERSION
from follow_up_acquisition.runtime import (
    AcquisitionRuntime,
    Adapter,
    AuthFailedError,
    CheckpointUpdate,
    RateLimitedError,
    SchemaDriftError,
    SourceCandidate,
    SourceResult,
    validate_checkpoint_updates,
)
from follow_up_acquisition.source_state import MAX_STATE_BYTES, SourceStateError

FIXED_NOW = "2026-09-08T12:00:00+00:00"
FIXED_REQUEST = {"mode": "shadow", "depth": 3}


def make_candidate(native_id: str, url: str, **kwargs) -> SourceCandidate:
    defaults = {
        "native_id": native_id,
        "url": url,
        "source_type": "rss",
        "date_confidence": "exact",
        "fetched_at": FIXED_NOW,
    }
    defaults.update(kwargs)
    return SourceCandidate(**defaults)


def make_checkpoint(**overrides) -> dict:
    value = {
        "successful_window_end": "2026-09-15T07:00:00Z",
        "cursor": "page-2",
        "etag": '"abc"',
        "last_modified": "Mon, 15 Sep 2026 07:00:00 GMT",
        "recent_native_ids": ["native-1"],
        "checkpoint_at": "2026-09-15T08:00:00Z",
    }
    value.update(overrides)
    return value


class CheckpointContractTests(unittest.TestCase):
    def test_source_result_tupleizes_checkpoint_updates_and_defaults_empty(self):
        update = CheckpointUpdate("top", None, make_checkpoint())
        result = SourceResult(
            "fake", "1.0.0", "community:other", "ok", checkpoint_updates=[update],
        )
        self.assertEqual(result.checkpoint_updates, (update,))
        self.assertEqual(
            SourceResult("fake", "1.0.0", "community:other", "ok").checkpoint_updates,
            (),
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            update.stream_id = "changed"

    def test_source_result_positional_construction_remains_backward_compatible(self):
        result = SourceResult(
            "fake", "1.0.0", "community:other", "ok", (), None, None, False,
            FIXED_REQUEST,
        )
        self.assertIs(result.request, FIXED_REQUEST)
        self.assertEqual(result.checkpoint_updates, ())

    def test_validate_checkpoint_updates_returns_detached_immutable_tuple(self):
        checkpoint = make_checkpoint(cursor={"page": 2})
        updates = [CheckpointUpdate("top", None, checkpoint)]
        validated = validate_checkpoint_updates("community:other", updates)
        self.assertIsInstance(validated, tuple)
        self.assertEqual(validated, tuple(updates))
        self.assertIsNot(validated[0], updates[0])
        self.assertIsNot(validated[0].checkpoint, checkpoint)
        checkpoint["cursor"]["page"] = 99
        self.assertEqual(validated[0].checkpoint["cursor"]["page"], 2)

    def test_validate_checkpoint_updates_accepts_canonical_previous_timestamp(self):
        validated = validate_checkpoint_updates("community:other", (
            CheckpointUpdate(
                "top", "2026-09-15T07:00:00Z",
                make_checkpoint(checkpoint_at="2026-09-15T08:00:00Z"),
            ),
        ))
        self.assertEqual(validated[0].previous_checkpoint_at, "2026-09-15T07:00:00Z")

    def test_validate_checkpoint_updates_rejects_invalid_source_stream_previous_and_duplicates(self):
        valid = make_checkpoint()
        cases = (
            ("unsafe/source", (CheckpointUpdate("top", None, valid),)),
            ("community:other", (CheckpointUpdate("Upper", None, valid),)),
            ("community:other", (CheckpointUpdate("top", "2026-09-15 07:00:00", valid),)),
            ("community:other", (CheckpointUpdate("top", "null", valid),)),
            ("community:other", (
                CheckpointUpdate("top", None, valid),
                CheckpointUpdate("top", None, valid),
            )),
        )
        for source, updates in cases:
            with self.subTest(source=source, updates=updates), self.assertRaises(SourceStateError):
                validate_checkpoint_updates(source, updates)

    def test_validate_checkpoint_updates_rejects_closed_shape_and_store_managed_field(self):
        for field, value in (("unknown", True), ("inactive_since", "2026-09-15T08:00:00Z")):
            checkpoint = make_checkpoint()
            checkpoint[field] = value
            with self.subTest(field=field), self.assertRaises(SourceStateError):
                validate_checkpoint_updates(
                    "community:other", (CheckpointUpdate("top", None, checkpoint),),
                )

    def test_validate_checkpoint_updates_rejects_non_object_with_previous_checkpoint(self):
        update = CheckpointUpdate(
            "top", "2026-09-15T07:00:00Z", [],  # type: ignore[arg-type]
        )
        with self.assertRaises(SourceStateError):
            validate_checkpoint_updates("community:other", (update,))

    def test_validate_checkpoint_updates_rejects_credentials(self):
        credentials = (
            {"api_key": "secret"},
            "github_" + "pat_" + "A" * 70,
        )
        for cursor in credentials:
            with self.subTest(cursor=str(cursor)[:16]), self.assertRaises(SourceStateError):
                validate_checkpoint_updates("community:other", (
                    CheckpointUpdate("top", None, make_checkpoint(cursor=cursor)),
                ))

    def test_validate_checkpoint_updates_rejects_invalid_checkpoint_semantics(self):
        invalid_checkpoints = (
            make_checkpoint(checkpoint_at="2026-09-15 08:00:00"),
            make_checkpoint(successful_window_end="2026-09-31T07:00:00Z"),
            make_checkpoint(cursor={"page": object()}),
            make_checkpoint(recent_native_ids=["duplicate", "duplicate"]),
            make_checkpoint(query_fingerprint="A" * 64),
        )
        for checkpoint in invalid_checkpoints:
            with self.subTest(checkpoint=checkpoint), self.assertRaises(SourceStateError):
                validate_checkpoint_updates("community:other", (
                    CheckpointUpdate("top", None, checkpoint),
                ))

    def test_validate_checkpoint_updates_rejects_invalid_archive_shape(self):
        checkpoint = make_checkpoint(cursor={
            "current_processing_date": "2026-09-15",
            "complete_dates": ["2026-09-14", "2026-09-14"],
        })
        with self.assertRaises(SourceStateError):
            validate_checkpoint_updates("community:techmeme", (
                CheckpointUpdate("archive", None, checkpoint),
            ))

    def test_validate_checkpoint_updates_rejects_individual_and_aggregate_oversize(self):
        individual = CheckpointUpdate(
            "top", None, make_checkpoint(cursor="x" * MAX_STATE_BYTES),
        )
        with self.assertRaises(SourceStateError):
            validate_checkpoint_updates("community:other", (individual,))

        aggregate = tuple(
            CheckpointUpdate(
                stream_id, None, make_checkpoint(cursor="x" * (MAX_STATE_BYTES // 2)),
            )
            for stream_id in ("first", "second")
        )
        with self.assertRaises(SourceStateError):
            validate_checkpoint_updates("community:other", aggregate)


class FakeAdapter:
    adapter_id = "fake"
    adapter_version = "1.0.0"

    def __init__(self, *, probe="ok", validate_error=None, collect_error=None, result=None):
        self._probe = probe
        self._validate_error = validate_error
        self._collect_error = collect_error
        self._result = result

    def availability_probe(self):
        if isinstance(self._probe, Exception):
            raise self._probe
        return self._probe

    def validate_request(self, request):
        if self._validate_error is not None:
            raise self._validate_error

    def collect(self, source, request):
        if self._collect_error is not None:
            raise self._collect_error
        if self._result is not None:
            return self._result
        return SourceResult(self.adapter_id, self.adapter_version, source, "ok", ())


class NormalizationTests(unittest.TestCase):
    def setUp(self):
        self.runtime = AcquisitionRuntime(now=lambda: FIXED_NOW)

    def test_normalize_status_ok_empty_becomes_no_results(self):
        self.assertEqual(self.runtime.normalize_status("ok", ()), "no-results")
        self.assertEqual(self.runtime.normalize_status("ok", [make_candidate("1", "https://a")]), "ok")
        self.assertEqual(self.runtime.normalize_status("partial", ()), "partial")

    def test_canonical_url_normalizes(self):
        self.assertEqual(
            self.runtime.canonical_url("HTTPS://Example.com/Path/"),
            "https://example.com/path",
        )
        self.assertEqual(
            self.runtime.canonical_url("https://a.com/x?utm_source=foo&id=1"),
            "https://a.com/x?id=1",
        )
        self.assertEqual(self.runtime.canonical_url("https://a.com/x#frag"), "https://a.com/x")
        self.assertEqual(self.runtime.canonical_url(""), "")

    def test_dedupe_by_native_id_and_canonical_url(self):
        a = make_candidate("1", "https://a.com/post")
        b = make_candidate("1", "https://a.com/post-2")  # dup native id
        c = make_candidate("2", "https://A.com/Post/")  # dup canonical url
        d = make_candidate("3", "https://b.com/other")
        self.assertEqual(
            self.runtime.dedupe([a, b, c, d], "src:a"),
            [a, d],
        )


class SerializationTests(unittest.TestCase):
    def setUp(self):
        self.runtime = AcquisitionRuntime(now=lambda: FIXED_NOW)

    def test_normalize_item_shapes_contract_fields(self):
        candidate = make_candidate("42", "https://a.com/x", title="Hi")
        item = self.runtime.normalize_item(candidate, "src:a")
        self.assertEqual(item["candidate_id"], "src:a:42")
        self.assertEqual(item["source"], "src:a")
        self.assertEqual(item["url"], "https://a.com/x")
        self.assertEqual(item["title"], "Hi")

    def test_build_batch_ok_with_candidates_is_valid(self):
        adapter = FakeAdapter()
        candidate = make_candidate("42", "https://a.com/x", title="Hi")
        result = SourceResult("fake", "1.0.0", "src:a", "ok", (candidate,))
        batch = self.runtime.build_batch(adapter, "src:a", FIXED_REQUEST, result, batch_id="b1")
        self.assertEqual(batch["schema_version"], SCHEMA_VERSION)
        self.assertEqual(batch["batch_id"], "b1")
        self.assertEqual(batch["source_status"]["status"], "ok")
        self.assertEqual(len(batch["items"]), 1)

    def test_build_batch_ok_empty_becomes_no_results(self):
        adapter = FakeAdapter()
        result = SourceResult("fake", "1.0.0", "src:a", "ok", ())
        batch = self.runtime.build_batch(adapter, "src:a", FIXED_REQUEST, result)
        self.assertEqual(batch["source_status"]["status"], "no-results")
        self.assertEqual(batch["items"], [])

    def test_build_batch_deduplicates_items(self):
        adapter = FakeAdapter()
        a = make_candidate("1", "https://a.com/post")
        b = make_candidate("1", "https://a.com/post-2")
        result = SourceResult("fake", "1.0.0", "src:a", "ok", (a, b))
        batch = self.runtime.build_batch(adapter, "src:a", FIXED_REQUEST, result)
        self.assertEqual(len(batch["items"]), 1)

    def test_build_batch_falls_back_to_schema_drift_on_invalid_output(self):
        adapter = FakeAdapter()
        # A candidate with an empty URL cannot be represented under the contract.
        bad = make_candidate("1", "")
        result = SourceResult("fake", "1.0.0", "src:a", "ok", (bad,))
        batch = self.runtime.build_batch(adapter, "src:a", FIXED_REQUEST, result)
        self.assertEqual(batch["source_status"]["status"], "schema-drift")
        self.assertEqual(batch["items"], [])

    def test_build_batch_never_serializes_checkpoint_updates(self):
        adapter = FakeAdapter()
        result = SourceResult(
            "fake", "1.0.0", "community:other", "ok", (),
            checkpoint_updates=(CheckpointUpdate("top", None, make_checkpoint()),),
        )
        batch = self.runtime.build_batch(
            adapter, "community:other", FIXED_REQUEST, result, batch_id="b1",
        )
        self.assertNotIn("checkpoint_updates", batch)
        self.assertNotIn("checkpoint_at", json.dumps(batch, sort_keys=True))


class ClassificationTests(unittest.TestCase):
    def test_classify_exception_maps_common_failures(self):
        runtime = AcquisitionRuntime()
        self.assertEqual(runtime.classify_exception(TimeoutError()), ("timeout", True))
        self.assertEqual(runtime.classify_exception(ConnectionError()), ("unreachable", True))
        self.assertEqual(runtime.classify_exception(AuthFailedError()), ("auth-failed", False))
        self.assertEqual(runtime.classify_exception(RateLimitedError()), ("rate-limited", True))
        self.assertEqual(runtime.classify_exception(SchemaDriftError()), ("schema-drift", False))
        self.assertEqual(runtime.classify_exception(RuntimeError("x")), ("error", False))


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.runtime = AcquisitionRuntime(now=lambda: FIXED_NOW)

    def test_collect_one_maps_collect_exception(self):
        adapter = FakeAdapter(collect_error=TimeoutError("slow"))
        result = self.runtime.collect_one(adapter, "src:a", FIXED_REQUEST)
        self.assertEqual(result.status, "timeout")
        self.assertTrue(result.retryable)

    def test_collect_one_honors_availability_probe(self):
        adapter = FakeAdapter(probe="skipped-unconfigured")
        result = self.runtime.collect_one(adapter, "src:a", FIXED_REQUEST)
        self.assertEqual(result.status, "skipped-unconfigured")

    def test_collect_one_maps_validate_request_failure(self):
        adapter = FakeAdapter(validate_error=ValueError("bad request"))
        result = self.runtime.collect_one(adapter, "src:a", FIXED_REQUEST)
        self.assertEqual(result.status, "error")

    def test_collect_one_preserves_valid_checkpoint_updates(self):
        update = CheckpointUpdate("top", None, make_checkpoint())
        adapter = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "community:other", "ok", (),
            checkpoint_updates=(update,),
        ))
        result = self.runtime.collect_one(adapter, "community:other", FIXED_REQUEST)
        self.assertEqual(result.checkpoint_updates, (update,))

    def test_collect_one_invalid_checkpoint_is_safe_schema_drift(self):
        adapter = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "bad", "ok",
            (make_candidate("bad", "https://bad.example/item"),),
            checkpoint_updates=(CheckpointUpdate("Upper", None, make_checkpoint()),),
        ))
        result = self.runtime.collect_one(adapter, "bad", FIXED_REQUEST)
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.checkpoint_updates, ())
        self.assertEqual(result.code, "invalid-checkpoint-update")
        self.assertEqual(result.message, "adapter returned invalid checkpoint updates")
        self.assertFalse(result.retryable)

    def test_collect_one_rejects_updates_from_unsuccessful_source_result(self):
        adapter = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "bad", "timeout", (), retryable=True,
            checkpoint_updates=(CheckpointUpdate("top", None, make_checkpoint()),),
        ))
        result = self.runtime.collect_one(adapter, "bad", FIXED_REQUEST)
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.checkpoint_updates, ())
        self.assertEqual(result.code, "invalid-checkpoint-update")

    def test_run_isolates_independent_source_failures(self):
        good = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "good", "ok", (make_candidate("1", "https://g.com/x"),),
        ))
        broken = FakeAdapter(collect_error=ConnectionError("down"))
        batches = self.runtime.run([(good, "good"), (broken, "broken")], FIXED_REQUEST)
        self.assertEqual(batches["good"]["source_status"]["status"], "ok")
        self.assertEqual(batches["broken"]["source_status"]["status"], "unreachable")

    def test_run_isolates_invalid_checkpoint_updates_from_other_sources(self):
        good = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "good", "ok", (make_candidate("1", "https://g.com/x"),),
            checkpoint_updates=(CheckpointUpdate("top", None, make_checkpoint()),),
        ))
        invalid = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "invalid", "ok",
            (make_candidate("2", "https://bad.com/x"),),
            checkpoint_updates=(CheckpointUpdate("Upper", None, make_checkpoint()),),
        ))
        batches = self.runtime.run([(good, "good"), (invalid, "invalid")], FIXED_REQUEST)
        self.assertEqual(batches["good"]["source_status"]["status"], "ok")
        self.assertEqual(batches["invalid"]["source_status"], {
            "status": "schema-drift",
            "code": "invalid-checkpoint-update",
            "message": "adapter returned invalid checkpoint updates",
            "retryable": False,
        })
        self.assertEqual(batches["invalid"]["items"], [])

    def test_run_isolates_non_object_checkpoint_from_independent_source(self):
        malformed = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "malformed", "ok",
            (make_candidate("bad", "https://bad.com/item"),),
            checkpoint_updates=(CheckpointUpdate(
                "top", "2026-09-15T07:00:00Z", [],  # type: ignore[arg-type]
            ),),
        ))
        independent = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "independent", "ok",
            (make_candidate("good", "https://good.com/item"),),
        ))
        batches = self.runtime.run(
            [(malformed, "malformed"), (independent, "independent")], FIXED_REQUEST,
        )
        self.assertEqual(batches["malformed"]["source_status"], {
            "status": "schema-drift",
            "code": "invalid-checkpoint-update",
            "message": "adapter returned invalid checkpoint updates",
            "retryable": False,
        })
        self.assertEqual(batches["malformed"]["items"], [])
        self.assertEqual(batches["independent"]["source_status"]["status"], "ok")
        self.assertEqual(len(batches["independent"]["items"]), 1)

    def test_run_filters_by_source_ids(self):
        adapter = FakeAdapter()
        batches = self.runtime.run(
            [(adapter, "a"), (adapter, "b")],
            FIXED_REQUEST,
            source_ids={"b"},
        )
        self.assertEqual(set(batches), {"b"})


class ProtocolConformanceTests(unittest.TestCase):
    def test_adapter_protocol_is_structural(self):
        # A minimal object satisfying the protocol shape is usable by the runtime.
        class Minimal(Adapter):
            adapter_id = "m"
            adapter_version = "0.1"

            def availability_probe(self):
                return "ok"

            def validate_request(self, request):
                if "mode" not in request:
                    raise ValueError("missing mode")

            def collect(self, source, request):
                return SourceResult("m", "0.1", source, "ok", ())

        runtime = AcquisitionRuntime(now=lambda: FIXED_NOW)
        batch = runtime.run([(Minimal(), "src:m")], FIXED_REQUEST)["src:m"]
        self.assertEqual(batch["source_status"]["status"], "no-results")


if __name__ == "__main__":
    unittest.main()
