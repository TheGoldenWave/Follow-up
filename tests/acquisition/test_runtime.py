"""Tests for the acquisition runtime orchestration and serialization."""

from __future__ import annotations

import unittest

from follow_up_acquisition.contracts import SCHEMA_VERSION
from follow_up_acquisition.runtime import (
    AcquisitionRuntime,
    Adapter,
    AuthFailedError,
    RateLimitedError,
    SchemaDriftError,
    SourceCandidate,
    SourceResult,
)

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

    def test_run_isolates_independent_source_failures(self):
        good = FakeAdapter(result=SourceResult(
            "fake", "1.0.0", "good", "ok", (make_candidate("1", "https://g.com/x"),),
        ))
        broken = FakeAdapter(collect_error=ConnectionError("down"))
        batches = self.runtime.run([(good, "good"), (broken, "broken")], FIXED_REQUEST)
        self.assertEqual(batches["good"]["source_status"]["status"], "ok")
        self.assertEqual(batches["broken"]["source_status"]["status"], "unreachable")

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
