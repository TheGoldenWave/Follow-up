"""Tests for strict, atomic per-source acquisition checkpoints."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

from follow_up_acquisition.source_state import (
    MAX_STATE_BYTES,
    SchemaDriftError,
    SourceStateError,
    SourceStateStore,
    StateConflictError,
    merge_checkpoint_updates,
    prune_state,
    query_fingerprint,
    validate_state,
)


NOW = "2026-09-15T08:00:00Z"


def checkpoint(*, at: str = NOW, fingerprint: str | None = None) -> dict:
    value = {
        "successful_window_end": "2026-09-15T07:00:00Z",
        "cursor": "page-2",
        "etag": '"abc"',
        "last_modified": "Mon, 15 Sep 2026 07:00:00 GMT",
        "recent_native_ids": ["native-1"],
        "checkpoint_at": at,
    }
    if fingerprint is not None:
        value["query_fingerprint"] = fingerprint
    return value


def state(*, source_id: str = "community:github", streams: dict | None = None) -> dict:
    return {
        "schema_version": "1.0",
        "source_id": source_id,
        "streams": {} if streams is None else streams,
        "updated_at": NOW,
    }


class QueryFingerprintTests(unittest.TestCase):
    def test_uses_utf8_byte_length_framing_and_unicode_whitespace_collapse(self) -> None:
        query = {
            "id": "builders",
            "query": "  你\u2003好   agent  ",
            "sort": "updated",
            "filters": {
                "topics": {"agents", "ai"}, "language": " Python ", "min_stars": 10,
            },
            "label": "not semantic",
            "comments": "also excluded",
        }
        fields = [
            "query-v1", "github", "builders", "你 好 agent", "updated",
            '0:6:Python2:100:15:["agents","ai"]',
        ]
        framed = b"".join(
            str(len(item.encode("utf-8"))).encode("ascii") + b":" + item.encode("utf-8")
            for item in fields
        )
        self.assertEqual(query_fingerprint("github", query), hashlib.sha256(framed).hexdigest())

    def test_is_stable_across_filter_mapping_and_set_order(self) -> None:
        first = {"id": "ai", "query": "AI", "sort": "date", "filters": {
            "min_points": 20, "tags": ["story", "show_hn"],
        }}
        second = {"id": "ai", "query": "AI", "sort": "date", "filters": {
            "tags": ["show_hn", "story"], "min_points": 20,
        }}
        self.assertEqual(
            query_fingerprint("hackernews", first),
            query_fingerprint("hackernews", second),
        )

    def test_is_stable_across_json_key_and_set_array_reordering(self) -> None:
        first = {"id": "agents", "query": "agent", "sort": "stars", "filters": {
            "entities": ["repository", "issue"], "owner": " openai ", "min_stars": 1,
        }}
        second = {"id": "agents", "query": "agent", "sort": "stars", "filters": {
            "min_stars": 1, "owner": "openai", "entities": ["issue", "repository"],
        }}
        self.assertEqual(query_fingerprint("github", first), query_fingerprint("github", second))

    def test_rejects_unknown_filters_and_sort_values(self) -> None:
        with self.assertRaises(SourceStateError):
            query_fingerprint("github", {
                "id": "ai", "query": "ai", "sort": "updated", "filters": {"stars": 1},
            })
        with self.assertRaises(SourceStateError):
            query_fingerprint("hackernews", {
                "id": "ai", "query": "ai", "sort": "popular", "filters": {},
            })

    def test_rejects_non_query_adapter_and_invalid_query_shape(self) -> None:
        with self.assertRaises(SourceStateError):
            query_fingerprint("reddit", {"id": "x", "query": "ai", "filters": {}})
        with self.assertRaises(SourceStateError):
            query_fingerprint("github", {"id": "BAD", "query": "ai", "filters": {}})


class ValidateStateTests(unittest.TestCase):
    def test_accepts_exact_closed_shape_and_optional_fingerprint(self) -> None:
        value = state(streams={"query.builders": checkpoint(fingerprint="a" * 64)})
        self.assertIs(validate_state(value), value)

    def test_rejects_unknown_top_level_and_stream_fields(self) -> None:
        value = state()
        value["unexpected"] = True
        with self.assertRaises(SourceStateError):
            validate_state(value)
        value = state(streams={"top": checkpoint()})
        value["streams"]["top"]["status"] = "ok"
        with self.assertRaises(SourceStateError):
            validate_state(value)

    def test_rejects_invalid_stream_ids(self) -> None:
        for stream_id in ("Upper", "1start", "has/slash", "a" * 65):
            with self.subTest(stream_id=stream_id), self.assertRaises(SourceStateError):
                validate_state(state(streams={stream_id: checkpoint()}))

    def test_rejects_more_than_500_recent_native_ids(self) -> None:
        value = checkpoint()
        value["recent_native_ids"] = [str(index) for index in range(501)]
        with self.assertRaises(SourceStateError):
            validate_state(state(streams={"top": value}))

    def test_github_and_hn_query_streams_require_fingerprint(self) -> None:
        for source_id, stream_id in (
            ("community:github", "query.ai"),
            ("community:hacker-news", "search.ai"),
        ):
            with self.subTest(source_id=source_id), self.assertRaises(SourceStateError):
                validate_state(state(source_id=source_id, streams={stream_id: checkpoint()}))

    def test_rejects_credential_shaped_keys_and_values(self) -> None:
        for cursor in ({"api_key": "raw"}, "Authorization: Bearer secret-value"):
            value = checkpoint()
            value["cursor"] = cursor
            with self.subTest(cursor=cursor), self.assertRaises(SourceStateError):
                validate_state(state(streams={"top": value}))

    def test_rejects_standalone_high_confidence_credential_values(self) -> None:
        credential_values = (
            "gh" + "p_" + "a" * 36,
            "s" + "k-" + "A" * 32,
            "AK" + "IA" + "A" * 16,
            "-----BEGIN " + "PRIVATE KEY-----",
        )
        for cursor in credential_values:
            value = checkpoint()
            value["cursor"] = cursor
            with self.subTest(cursor=cursor[:8]), self.assertRaises(SourceStateError):
                validate_state(state(streams={"top": value}))

    def test_allows_benign_hashes_and_urls(self) -> None:
        for cursor in ("a" * 64, "https://api.github.com/search/issues?page=2"):
            value = checkpoint()
            value["cursor"] = cursor
            self.assertIs(validate_state(state(streams={"top": value}))["streams"]["top"], value)

    def test_rejects_noncanonical_dates_and_times(self) -> None:
        for field, invalid in (
            ("checkpoint_at", "2026-09-15 08:00:00"),
            ("successful_window_end", "2026-09-15T08:00:00"),
        ):
            value = checkpoint()
            value[field] = invalid
            with self.subTest(field=field), self.assertRaises(SourceStateError):
                validate_state(state(streams={"top": value}))
        value = state()
        value["updated_at"] = "yesterday"
        with self.assertRaises(SourceStateError):
            validate_state(value)

    def test_rejects_state_larger_than_256_kib(self) -> None:
        value = checkpoint()
        value["cursor"] = "x" * MAX_STATE_BYTES
        with self.assertRaises(SourceStateError):
            validate_state(state(streams={"top": value}))

    def test_rejects_invalid_techmeme_archive_date_sets(self) -> None:
        cases = (
            [f"2026-09-{day:02d}" for day in range(1, 16)],
            ["2026-09-14", "2026-09-15"],
            ["2026-09-14", "2026-09-16"],
        )
        for complete_dates in cases:
            archive = checkpoint()
            archive["cursor"] = {
                "current_processing_date": "2026-09-15",
                "complete_dates": complete_dates,
            }
            with self.subTest(complete_dates=complete_dates), self.assertRaises(SourceStateError):
                validate_state(state(source_id="community:techmeme", streams={"archive": archive}))


class MergeAndPruneTests(unittest.TestCase):
    def test_empty_updates_do_not_advance_failed_stream(self) -> None:
        original = state(streams={"top": checkpoint(at="2026-09-15T06:00:00Z")})
        merged = merge_checkpoint_updates(original, [], updated_at=NOW)
        self.assertEqual(merged, original)

    def test_merges_complete_stream_update_without_mutating_input(self) -> None:
        original = state(streams={"top": checkpoint(at="2026-09-15T06:00:00Z")})
        replacement = checkpoint(at=NOW)
        merged = merge_checkpoint_updates(original, [{
            "stream_id": "top",
            "previous_checkpoint_at": "2026-09-15T06:00:00Z",
            "checkpoint": replacement,
        }], updated_at=NOW)
        self.assertEqual(merged["streams"]["top"], replacement)
        self.assertEqual(original["streams"]["top"]["checkpoint_at"], "2026-09-15T06:00:00Z")

    def test_rejects_failure_shaped_or_incomplete_updates(self) -> None:
        with self.assertRaises(SourceStateError):
            merge_checkpoint_updates(state(), [{
                "stream_id": "top", "previous_checkpoint_at": None,
                "checkpoint": checkpoint(), "status": "failed",
            }], updated_at=NOW)

    def test_rejects_checkpoint_compare_and_swap_mismatch(self) -> None:
        original = state(streams={"top": checkpoint(at=NOW)})
        with self.assertRaises(StateConflictError):
            merge_checkpoint_updates(original, [{
                "stream_id": "top", "previous_checkpoint_at": "2026-09-15T07:00:00Z",
                "checkpoint": checkpoint(at="2026-09-15T09:00:00Z"),
            }], updated_at="2026-09-15T09:00:00Z")

    def test_rejects_checkpoint_time_regression(self) -> None:
        original = state(streams={"top": checkpoint(at=NOW)})
        with self.assertRaises(StateConflictError):
            merge_checkpoint_updates(original, [{
                "stream_id": "top", "previous_checkpoint_at": NOW,
                "checkpoint": checkpoint(at="2026-09-15T07:00:00Z"),
            }], updated_at="2026-09-15T09:00:00Z")

    def test_rejects_query_id_reuse_with_changed_fingerprint(self) -> None:
        original = state(streams={"query.ai": checkpoint(fingerprint="a" * 64)})
        with self.assertRaises(SchemaDriftError):
            merge_checkpoint_updates(original, [{
                "stream_id": "query.ai", "previous_checkpoint_at": NOW,
                "checkpoint": checkpoint(at="2026-09-15T09:00:00Z", fingerprint="b" * 64),
            }], updated_at="2026-09-15T09:00:00Z")

    def test_prunes_archive_to_current_and_14_complete_dates(self) -> None:
        archive = checkpoint()
        archive["cursor"] = {
            "current_processing_date": "2026-09-16",
            "complete_dates": [f"2026-09-{day:02d}" for day in range(1, 16)],
        }
        pruned = prune_state(
            state(source_id="community:techmeme", streams={"archive": archive}),
            active_stream_ids={"archive"}, now=NOW,
        )
        self.assertEqual(pruned["streams"]["archive"]["cursor"]["current_processing_date"], "2026-09-16")
        self.assertEqual(
            pruned["streams"]["archive"]["cursor"]["complete_dates"],
            [f"2026-09-{day:02d}" for day in range(2, 16)],
        )

    def test_merge_rejects_overlong_techmeme_archive_update(self) -> None:
        archive = checkpoint()
        archive["cursor"] = {
            "current_processing_date": "2026-09-16",
            "complete_dates": [f"2026-09-{day:02d}" for day in range(1, 16)],
        }
        with self.assertRaises(SourceStateError):
            merge_checkpoint_updates(
                state(source_id="community:techmeme"),
                [{"stream_id": "archive", "previous_checkpoint_at": None, "checkpoint": archive}],
                updated_at=NOW,
            )

    def test_merge_validates_every_archive_date_before_rejecting_overflow(self) -> None:
        valid = [f"2026-09-{day:02d}" for day in range(1, 15)]
        cases = (
            valid + ["not-a-date"],
            [None] + valid,
            ["2026-09-01"] + valid,
            ["2027-01-01"] + valid,
        )
        for complete_dates in cases:
            archive = checkpoint()
            archive["cursor"] = {
                "current_processing_date": "2026-09-16",
                "complete_dates": complete_dates,
            }
            with self.subTest(complete_dates=complete_dates), self.assertRaises(SourceStateError):
                merge_checkpoint_updates(
                    state(source_id="community:techmeme"),
                    [{"stream_id": "archive", "previous_checkpoint_at": None,
                      "checkpoint": archive}],
                    updated_at=NOW,
                )

    def test_removed_query_stream_is_retained_for_7_days_then_pruned(self) -> None:
        streams = {
            "query.recent": checkpoint(at="2026-09-08T08:00:01Z", fingerprint="a" * 64),
            "query.expired": checkpoint(at="2026-09-08T08:00:00Z", fingerprint="b" * 64),
            "top": checkpoint(at="2020-01-01T00:00:00Z"),
        }
        pruned = prune_state(state(streams=streams), active_stream_ids={"top"}, now=NOW)
        self.assertIn("query.recent", pruned["streams"])
        self.assertNotIn("query.expired", pruned["streams"])
        self.assertIn("top", pruned["streams"])


class SourceStateStoreTests(unittest.TestCase):
    def test_missing_state_load_returns_initial_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = SourceStateStore(Path(temp_dir), clock=lambda: datetime(2026, 9, 15, 8, tzinfo=timezone.utc))
            self.assertEqual(store.load("community:github"), {
                "schema_version": "1.0", "source_id": "community:github",
                "streams": {}, "updated_at": None,
            })

    def test_commit_writes_atomic_state_with_private_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "source-state"
            store = SourceStateStore(root, clock=lambda: datetime(2026, 9, 15, 8, tzinfo=timezone.utc))
            written = store.commit("community:github", [{
                "stream_id": "query.ai", "previous_checkpoint_at": None,
                "checkpoint": checkpoint(fingerprint="a" * 64),
            }])
            self.assertEqual(store.load("community:github"), written)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / "community:github.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_commit_enforces_compare_and_swap_against_disk(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = SourceStateStore(Path(temp_dir))
            store.commit("community:github", [{
                "stream_id": "top", "previous_checkpoint_at": None,
                "checkpoint": checkpoint(at=NOW),
            }])
            with self.assertRaises(StateConflictError) as ctx:
                store.commit("community:github", [{
                    "stream_id": "top", "previous_checkpoint_at": None,
                    "checkpoint": checkpoint(at="2026-09-15T09:00:00Z"),
                }])
            self.assertEqual(ctx.exception.code, "state-conflict")

    def test_commit_atomically_persists_query_pruning(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = SourceStateStore(
                Path(temp_dir), clock=lambda: datetime(2026, 9, 15, 8, tzinfo=timezone.utc),
            )
            store.commit("community:github", [
                {"stream_id": "query.expired", "previous_checkpoint_at": None,
                 "checkpoint": checkpoint(at="2026-09-08T08:00:00Z", fingerprint="a" * 64)},
                {"stream_id": "query.recent", "previous_checkpoint_at": None,
                 "checkpoint": checkpoint(at="2026-09-08T08:00:01Z", fingerprint="b" * 64)},
                {"stream_id": "top", "previous_checkpoint_at": None, "checkpoint": checkpoint()},
            ])
            store.commit(
                "community:github", [], active_stream_ids={"top"}, now=NOW,
            )
            persisted = store.load("community:github")
            self.assertNotIn("query.expired", persisted["streams"])
            self.assertIn("query.recent", persisted["streams"])

    def test_pruning_does_not_delete_a_concurrently_advanced_stream(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = SourceStateStore(
                Path(temp_dir), clock=lambda: datetime(2026, 9, 15, 8, tzinfo=timezone.utc),
            )
            old_at = "2026-09-01T00:00:00Z"
            store.commit("community:github", [{
                "stream_id": "query.ai", "previous_checkpoint_at": None,
                "checkpoint": checkpoint(at=old_at, fingerprint="a" * 64),
            }])
            store.commit("community:github", [{
                "stream_id": "query.ai", "previous_checkpoint_at": old_at,
                "checkpoint": checkpoint(at=NOW, fingerprint="a" * 64),
            }])
            store.commit("community:github", [], active_stream_ids=set(), now=NOW)
            self.assertIn("query.ai", store.load("community:github")["streams"])

    def test_corrupt_oversized_and_symlink_state_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            target = root / "community:github.json"
            target.write_text("not json", encoding="utf-8")
            store = SourceStateStore(root)
            with self.assertRaises(SourceStateError):
                store.load("community:github")
            target.write_bytes(b"{" + b"x" * MAX_STATE_BYTES)
            with self.assertRaises(SourceStateError):
                store.load("community:github")
            target.unlink()
            real = root / "real.json"
            real.write_text(json.dumps(state()), encoding="utf-8")
            target.symlink_to(real)
            with self.assertRaises(SourceStateError):
                store.load("community:github")

    def test_symlink_parent_and_unsafe_source_id_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            real = base / "real"
            real.mkdir()
            link = base / "linked"
            link.symlink_to(real, target_is_directory=True)
            with self.assertRaises(SourceStateError):
                SourceStateStore(link).load("community:github")
            with self.assertRaises(SourceStateError):
                SourceStateStore(real).load("../escape")

    def test_load_rejects_overly_permissive_root_and_file_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            root.mkdir(mode=0o700)
            store = SourceStateStore(root)
            path = root / "community:github.json"
            path.write_text(json.dumps(state()), encoding="utf-8")
            path.chmod(0o644)
            with self.assertRaises(SourceStateError):
                store.load("community:github")
            path.chmod(0o600)
            root.chmod(0o755)
            with self.assertRaises(SourceStateError):
                store.load("community:github")


if __name__ == "__main__":
    unittest.main()
