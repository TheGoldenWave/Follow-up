"""Tests for the acquisition runtime orchestration and serialization."""

from __future__ import annotations

import dataclasses
import json
import unittest
from collections.abc import Iterator, Mapping
from unittest import mock

import follow_up_acquisition.runtime as runtime_module

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
    MAX_CHECKPOINT_DEPTH,
    MAX_CHECKPOINT_NODES,
    MAX_CHECKPOINT_UPDATES,
    thaw_checkpoint_update,
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

    def test_source_result_rejects_custom_and_subclassed_update_iterables_without_iteration(self):
        class HostileIterator:
            iterated = False

            def __iter__(self):
                type(self).iterated = True
                raise RuntimeError("secret-iterator-detail")

        class HostileList(list):
            iterated = False

            def __iter__(self):
                type(self).iterated = True
                raise RuntimeError("secret-list-detail")

        for updates in (HostileIterator(), HostileList()):
            with self.assertRaises(SourceStateError) as ctx:
                SourceResult(
                    "fake", "1.0.0", "community:other", "ok",
                    checkpoint_updates=updates,  # type: ignore[arg-type]
                )
            self.assertNotIn("secret", str(ctx.exception))
        self.assertFalse(HostileIterator.iterated)
        self.assertFalse(HostileList.iterated)

    def test_source_result_rejects_update_count_before_tuple_conversion(self):
        update = CheckpointUpdate("top", None, make_checkpoint())
        oversized = [update] * (MAX_CHECKPOINT_UPDATES + 1)
        with self.assertRaises(SourceStateError):
            SourceResult(
                "fake", "1.0.0", "community:other", "ok",
                checkpoint_updates=oversized,
            )

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
        with self.assertRaises(TypeError):
            validated[0].checkpoint["cursor"]["page"] = 3
        with self.assertRaises(TypeError):
            validated[0].checkpoint["recent_native_ids"][0] = "changed"

    def test_thaw_checkpoint_update_returns_fresh_mutable_json(self):
        validated = validate_checkpoint_updates("community:other", (
            CheckpointUpdate("top", None, make_checkpoint(cursor={"pages": [1, 2]})),
        ))[0]

        first = thaw_checkpoint_update(validated)
        second = thaw_checkpoint_update(validated)
        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        first["checkpoint"]["cursor"]["pages"].append(3)
        first["checkpoint"]["recent_native_ids"][0] = "changed"
        self.assertEqual(validated.checkpoint["cursor"]["pages"], (1, 2))
        self.assertEqual(validated.checkpoint["recent_native_ids"], ("native-1",))

    def test_validate_checkpoint_updates_rejects_cycles_and_excessive_depth(self):
        cyclic_dict = make_checkpoint()
        cyclic_dict["cursor"] = cyclic_dict
        cyclic_list: list[object] = []
        cyclic_list.append(cyclic_list)
        too_deep: object = "leaf"
        for _ in range(MAX_CHECKPOINT_DEPTH + 1):
            too_deep = [too_deep]

        for cursor in (cyclic_dict, cyclic_list, too_deep):
            checkpoint = cyclic_dict if cursor is cyclic_dict else make_checkpoint(cursor=cursor)
            with self.assertRaises(SourceStateError):
                validate_checkpoint_updates("community:other", (
                    CheckpointUpdate("top", None, checkpoint),
                ))

    def test_validate_checkpoint_updates_rejects_excessive_nodes_and_nonfinite_numbers(self):
        cases = (
            make_checkpoint(cursor=[None] * MAX_CHECKPOINT_NODES),
            make_checkpoint(cursor=float("nan")),
            make_checkpoint(cursor=float("inf")),
        )
        for checkpoint in cases:
            with self.assertRaises(SourceStateError):
                validate_checkpoint_updates("community:other", (
                    CheckpointUpdate("top", None, checkpoint),
                ))

    def test_validate_checkpoint_updates_rejects_hostile_objects_without_invoking_them(self):
        class HostileObject:
            deepcopy_called = False

            def __deepcopy__(self, memo):
                type(self).deepcopy_called = True
                raise RuntimeError("secret-from-deepcopy")

            def __repr__(self):
                raise RuntimeError("secret-from-repr")

        class HostileMapping(Mapping):
            iter_called = False

            def __getitem__(self, key):
                raise RuntimeError("secret-from-getitem")

            def __iter__(self) -> Iterator[str]:
                type(self).iter_called = True
                raise RuntimeError("secret-from-iter")

            def __len__(self):
                raise RuntimeError("secret-from-len")

        for cursor in (HostileObject(), HostileMapping()):
            with self.assertRaises(SourceStateError) as ctx:
                validate_checkpoint_updates("community:other", (
                    CheckpointUpdate("top", None, make_checkpoint(cursor=cursor)),
                ))
            self.assertNotIn("secret", str(ctx.exception))
        self.assertFalse(HostileObject.deepcopy_called)
        self.assertFalse(HostileMapping.iter_called)

    def test_validate_checkpoint_updates_stops_at_explicit_update_limit(self):
        consumed = 0

        def updates():
            nonlocal consumed
            for index in range(MAX_CHECKPOINT_UPDATES + 2):
                consumed += 1
                yield CheckpointUpdate(f"stream-{index}", None, make_checkpoint())

        with self.assertRaises(SourceStateError):
            validate_checkpoint_updates("community:other", updates())
        self.assertEqual(consumed, MAX_CHECKPOINT_UPDATES + 1)

    def test_validate_checkpoint_updates_rejects_hostile_subclass_without_field_access(self):
        class HostileUpdate(CheckpointUpdate):
            accessed = False

            def __getattribute__(self, name):
                if name not in {"accessed", "__class__"}:
                    type(self).accessed = True
                    raise RuntimeError("secret-field-detail")
                return object.__getattribute__(self, name)

        hostile = object.__new__(HostileUpdate)
        with self.assertRaises(SourceStateError) as ctx:
            validate_checkpoint_updates("community:other", (hostile,))
        self.assertNotIn("secret", str(ctx.exception))
        self.assertFalse(HostileUpdate.accessed)

    def test_oversize_strings_are_rejected_before_json_serialization(self):
        cases = (
            "a" * (MAX_STATE_BYTES + 1),
            "界" * (MAX_STATE_BYTES // 3 + 1),
            '"\\\n' * (MAX_STATE_BYTES // 6 + 1),
        )
        for cursor in cases:
            with mock.patch.object(
                runtime_module, "_canonical_json_copy",
                side_effect=AssertionError("serializer must not run"),
            ) as serializer:
                with self.assertRaises(SourceStateError):
                    validate_checkpoint_updates("community:other", (
                        CheckpointUpdate("top", None, make_checkpoint(cursor=cursor)),
                    ))
            serializer.assert_not_called()

    def test_canonical_utf8_budget_accepts_exact_boundary_and_rejects_one_byte_less(self):
        update = CheckpointUpdate(
            "top", None, make_checkpoint(cursor={
                '界"\\\n': ["😀", True, False, None, 42, -7, 1.25],
            }),
        )
        canonical = json.dumps(
            [{
                "stream_id": update.stream_id,
                "previous_checkpoint_at": update.previous_checkpoint_at,
                "checkpoint": update.checkpoint,
            }],
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        with mock.patch.object(
            runtime_module, "MAX_CHECKPOINT_UPDATE_BYTES", len(canonical),
        ):
            validated = validate_checkpoint_updates("community:other", (update,))
        self.assertEqual(thaw_checkpoint_update(validated[0])["checkpoint"], update.checkpoint)

        with mock.patch.object(
            runtime_module, "MAX_CHECKPOINT_UPDATE_BYTES", len(canonical) - 1,
        ):
            with self.assertRaises(SourceStateError):
                validate_checkpoint_updates("community:other", (update,))

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

    def test_collect_one_maps_source_result_update_shape_failure_to_fixed_diagnostic(self):
        class HostileUpdates:
            iterated = False

            def __iter__(self):
                type(self).iterated = True
                raise RuntimeError("secret-iterator-detail")

        class ConstructingAdapter(FakeAdapter):
            def collect(self, source, request):
                return SourceResult(
                    self.adapter_id, self.adapter_version, source, "ok",
                    (make_candidate("bad", "https://bad.example/item"),),
                    checkpoint_updates=HostileUpdates(),  # type: ignore[arg-type]
                )

        result = self.runtime.collect_one(
            ConstructingAdapter(), "community:other", FIXED_REQUEST,
        )
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.checkpoint_updates, ())
        self.assertEqual(result.code, "invalid-checkpoint-update")
        self.assertEqual(result.message, "adapter returned invalid checkpoint updates")
        self.assertNotIn("secret", json.dumps(dataclasses.asdict(result)))
        self.assertFalse(HostileUpdates.iterated)

    def test_collect_one_maps_oversized_source_result_updates_to_fixed_diagnostic(self):
        class ConstructingAdapter(FakeAdapter):
            def collect(self, source, request):
                update = CheckpointUpdate("top", None, make_checkpoint())
                return SourceResult(
                    self.adapter_id, self.adapter_version, source, "ok",
                    (make_candidate("bad", "https://bad.example/item"),),
                    checkpoint_updates=[update] * (MAX_CHECKPOINT_UPDATES + 1),
                )

        result = self.runtime.collect_one(
            ConstructingAdapter(), "community:other", FIXED_REQUEST,
        )
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.checkpoint_updates, ())
        self.assertEqual(result.code, "invalid-checkpoint-update")
        self.assertEqual(result.message, "adapter returned invalid checkpoint updates")

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

    def test_collect_one_maps_unexpected_checkpoint_validator_exception_safely(self):
        adapter = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "bad", "ok",
            (make_candidate("bad", "https://bad.example/item"),),
        ))
        with mock.patch(
            "follow_up_acquisition.runtime.validate_checkpoint_updates",
            side_effect=RuntimeError("secret-validator-detail"),
        ):
            result = self.runtime.collect_one(adapter, "bad", FIXED_REQUEST)
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.checkpoint_updates, ())
        self.assertEqual(result.code, "invalid-checkpoint-update")
        self.assertEqual(result.message, "adapter returned invalid checkpoint updates")

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

    def test_run_isolates_hostile_and_recursive_checkpoints_without_detail_leaks(self):
        class Hostile:
            def __deepcopy__(self, memo):
                raise RuntimeError("secret-deepcopy-detail")

            def __repr__(self):
                raise RuntimeError("secret-repr-detail")

        class HostileMapping(Mapping):
            def __getitem__(self, key):
                raise RuntimeError("secret-getitem-detail")

            def __iter__(self) -> Iterator[str]:
                raise RuntimeError("secret-iter-detail")

            def __len__(self):
                raise RuntimeError("secret-len-detail")

        recursive_dict = make_checkpoint()
        recursive_dict["cursor"] = recursive_dict
        recursive_list: list[object] = []
        recursive_list.append(recursive_list)
        too_deep: object = "leaf"
        for _ in range(MAX_CHECKPOINT_DEPTH + 1):
            too_deep = [too_deep]
        cases = (
            recursive_dict,
            make_checkpoint(cursor=recursive_list),
            make_checkpoint(cursor=too_deep),
            make_checkpoint(cursor=Hostile()),
            make_checkpoint(cursor=HostileMapping()),
        )
        for index, checkpoint in enumerate(cases):
            malformed = FakeAdapter(result=SourceResult(
                "fake", "1.0.0", f"malformed-{index}", "ok",
                (make_candidate("bad", "https://bad.com/item"),),
                checkpoint_updates=(CheckpointUpdate("top", None, checkpoint),),
            ))
            independent = FakeAdapter(result=SourceResult(
                "fake", "1.0.0", f"independent-{index}", "ok",
                (make_candidate("good", "https://good.com/item"),),
            ))
            batches = self.runtime.run(
                [(malformed, f"malformed-{index}"),
                 (independent, f"independent-{index}")],
                FIXED_REQUEST,
            )
            malformed_batch = batches[f"malformed-{index}"]
            self.assertEqual(malformed_batch["source_status"], {
                "status": "schema-drift",
                "code": "invalid-checkpoint-update",
                "message": "adapter returned invalid checkpoint updates",
                "retryable": False,
            })
            self.assertEqual(malformed_batch["items"], [])
            self.assertNotIn("secret", json.dumps(malformed_batch))
            self.assertEqual(
                batches[f"independent-{index}"]["source_status"]["status"], "ok",
            )

    def test_run_isolates_infinite_checkpoint_update_iterable_without_iteration(self):
        class InfiniteUpdates:
            iterated = False

            def __iter__(self):
                type(self).iterated = True
                return self

            def __next__(self):
                type(self).iterated = True
                return CheckpointUpdate("top", None, make_checkpoint())

        class ConstructingAdapter(FakeAdapter):
            def collect(self, source, request):
                return SourceResult(
                    self.adapter_id, self.adapter_version, source, "ok",
                    (make_candidate("bad", "https://bad.example/item"),),
                    checkpoint_updates=InfiniteUpdates(),  # type: ignore[arg-type]
                )

        healthy = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "healthy", "ok",
            (make_candidate("good", "https://good.example/item"),),
        ))
        batches = self.runtime.run(
            [(ConstructingAdapter(), "hostile"), (healthy, "healthy")], FIXED_REQUEST,
        )
        self.assertEqual(batches["hostile"]["source_status"], {
            "status": "schema-drift",
            "code": "invalid-checkpoint-update",
            "message": "adapter returned invalid checkpoint updates",
            "retryable": False,
        })
        self.assertEqual(batches["hostile"]["items"], [])
        self.assertEqual(batches["healthy"]["source_status"]["status"], "ok")
        self.assertFalse(InfiniteUpdates.iterated)

    def test_run_isolates_hostile_checkpoint_update_subclass_without_field_access(self):
        class HostileUpdate(CheckpointUpdate):
            accessed = False

            def __getattribute__(self, name):
                if name not in {"accessed", "__class__"}:
                    type(self).accessed = True
                    raise RuntimeError("secret-field-detail")
                return object.__getattribute__(self, name)

        hostile = object.__new__(HostileUpdate)
        malformed = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "malformed", "ok",
            (make_candidate("bad", "https://bad.example/item"),),
            checkpoint_updates=(hostile,),
        ))
        healthy = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "healthy", "ok",
            (make_candidate("good", "https://good.example/item"),),
        ))
        batches = self.runtime.run(
            [(malformed, "malformed"), (healthy, "healthy")], FIXED_REQUEST,
        )
        self.assertEqual(batches["malformed"]["source_status"], {
            "status": "schema-drift",
            "code": "invalid-checkpoint-update",
            "message": "adapter returned invalid checkpoint updates",
            "retryable": False,
        })
        self.assertEqual(batches["malformed"]["items"], [])
        self.assertEqual(batches["healthy"]["source_status"]["status"], "ok")
        self.assertFalse(HostileUpdate.accessed)

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
