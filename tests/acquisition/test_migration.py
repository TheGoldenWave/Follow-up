"""Tests for migration metrics, cutover gates, and rollback."""

from __future__ import annotations

import unittest
import json
import subprocess
from pathlib import Path

from follow_up_acquisition.migration import (
    canonical_url,
    classified_error_rate,
    duplicate_rate,
    evaluate_cutover,
    evaluate_rollback,
    native_id_of,
    overlap_rate,
    run_streak,
    source_verdict,
)


def item(source: str, native: str, url: str) -> dict:
    return {"candidate_id": f"{source}:{native}", "source": source, "url": url}


class CanonicalUrlTests(unittest.TestCase):
    def test_preserves_path_case_and_sorts_query_like_node(self):
        self.assertEqual(canonical_url('https://EXAMPLE.com/Case/?z=2&a=1&utm_extra=x'), 'https://example.com/Case?a=1&z=2')

    def test_strips_fragment_tracking_and_trailing_slash(self):
        self.assertEqual(
            canonical_url("https://Example.com/post/?utm_source=x#frag"),
            "https://example.com/post",
        )

    def test_preserves_non_tracking_query(self):
        self.assertEqual(
            canonical_url("https://example.com/post?page=2"),
            "https://example.com/post?page=2",
        )


class IdentityTests(unittest.TestCase):
    def test_native_id_of_strips_source_prefix(self):
        self.assertEqual(native_id_of("blog:a:123", "blog:a"), "123")
        self.assertEqual(native_id_of("raw", "blog:a"), "raw")


class MetricTests(unittest.TestCase):
    def test_duplicates_match_either_identity_independently(self):
        self.assertEqual(duplicate_rate([item('blog:a', '1', 'https://e.com/a'), item('blog:a', '1', 'https://e.com/b')], 'blog:a'), 0.5)
        self.assertEqual(duplicate_rate([item('blog:a', '1', 'https://e.com/a?utm_source=x'), item('blog:a', '2', 'https://e.com/a')], 'blog:a'), 0.5)

    def test_overlap_rate_matches_native_id_and_url(self):
        local = [item("blog:a", "1", "https://example.com/x")]
        central = [item("blog:a", "1", "https://example.com/x")]
        self.assertEqual(overlap_rate(local, central, "blog:a"), 1.0)

    def test_overlap_rate_empty_local_is_trivially_full(self):
        self.assertEqual(overlap_rate([], [item("blog:a", "1", "https://e.com/x")], "blog:a"), 1.0)

    def test_duplicate_rate_counts_repeats(self):
        local = [
            item("blog:a", "1", "https://example.com/x"),
            item("blog:a", "1", "https://example.com/x"),
            item("blog:a", "2", "https://example.com/y"),
        ]
        self.assertAlmostEqual(duplicate_rate(local, "blog:a"), 1 / 3)

    def test_classified_error_rate(self):
        self.assertEqual(classified_error_rate(["ok", "error", "timeout"]), 2 / 3)
        self.assertEqual(classified_error_rate([]), 0.0)

    def test_run_streak_ends_at_first_failure(self):
        self.assertEqual(run_streak(["ok", "ok", "partial"]), 3)
        self.assertEqual(run_streak(["ok", "error", "ok"]), 1)


class CutoverTests(unittest.TestCase):
    def test_operational_source_verdict_requires_current_real_review(self):
        source = {'observation_until': '2026-09-15T00:00:00Z', 'runs': [
            {'batchId': str(n), 'generatedAt': f'2026-09-0{n}T00:00:00Z', 'status': 'ok', 'contractsOk': True, 'secretsClean': True, 'secretsLeaked': False, 'duplicateRate': 0, 'candidateIds': [f'blog:a:{n}']} for n in [1, 2, 3]
        ], 'review': {'batchId': '3', 'reviewer': 'person', 'reviewedAt': '2026-09-04T00:00:00Z', 'items': [{'candidateId': 'blog:a:3', 'relevant': True}]}}
        self.assertTrue(source_verdict(source, '2026-09-20T00:00:00Z')['cutover']['passed'])
        self.assertFalse(source_verdict(source, '2026-09-05T00:00:00Z')['cutover']['passed'])
        source['review']['batchId'] = '2'
        self.assertFalse(source_verdict(source, '2026-09-20T00:00:00Z')['cutover']['passed'])

    def test_operational_verdict_matches_node_for_saved_evidence(self):
        source = {'observation_until': '2026-09-15T00:00:00Z', 'runs': [
            {'batchId': str(n), 'generatedAt': f'2026-09-0{n}T00:00:00Z', 'status': 'ok', 'contractsOk': True, 'secretsClean': True, 'secretsLeaked': False, 'duplicateRate': 0, 'candidateIds': [f'blog:a:{n}']} for n in [1, 2, 3]
        ], 'review': {'batchId': '3', 'reviewer': 'person', 'reviewedAt': '2026-09-04T00:00:00Z', 'items': [{'candidateId': 'blog:a:3', 'relevant': True}]}}
        cases = [(source, clock) for clock in ['2026-09-05T00:00:00Z', '2026-09-20T00:00:00Z', '2027-01-01T00:00:00Z']]
        for relevance in [False, True]:
            changed = json.loads(json.dumps(source))
            changed['review']['items'][0]['relevant'] = relevance
            cases.append((changed, '2026-09-20T00:00:00Z'))
        for status in ['error', 'timeout']:
            changed = json.loads(json.dumps(source))
            for run in changed['runs'][-2:]:
                run['status'] = status
            cases.append((changed, '2026-09-20T00:00:00Z'))
        script = "import {sourceVerdict} from './scripts/lib/migration-state.js'; let input=''; for await(const c of process.stdin) input+=c; console.log(JSON.stringify(JSON.parse(input).map(([s,n])=>sourceVerdict(s,n))));"
        result = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(cases), text=True, capture_output=True, check=True, cwd=Path(__file__).resolve().parents[2])
        self.assertEqual(json.loads(result.stdout), [source_verdict(s, n) for s, n in cases])

    def test_missing_review_blocks_cutover(self):
        gates = evaluate_cutover(
            run_count=3, duplicate_rate_value=0.0, relevance=None,
            contracts_ok=True, secrets_clean=True,
        )
        self.assertFalse(gates["passed"])

    def test_all_gates_pass_allows_cutover(self):
        gates = evaluate_cutover(
            run_count=3, duplicate_rate_value=0.0, relevance=0.9,
            contracts_ok=True, secrets_clean=True,
        )
        self.assertTrue(gates["passed"])

    def test_duplicates_block_cutover(self):
        gates = evaluate_cutover(
            run_count=3, duplicate_rate_value=0.01, relevance=0.9,
            contracts_ok=True, secrets_clean=True,
        )
        self.assertFalse(gates["duplicates_absent"])
        self.assertFalse(gates["passed"])

    def test_low_relevance_blocks_cutover(self):
        gates = evaluate_cutover(
            run_count=3, duplicate_rate_value=0.0, relevance=0.6,
            contracts_ok=True, secrets_clean=True,
        )
        self.assertFalse(gates["relevance_met"])
        self.assertFalse(gates["passed"])


class RollbackTests(unittest.TestCase):
    def test_secret_leak_triggers_rollback(self):
        self.assertEqual(
            evaluate_rollback(statuses=["ok"], duplicate_rate_value=0.0, relevance=0.9, secrets_leaked=True),
            "secret-leak",
        )

    def test_two_consecutive_failures_triggers_rollback(self):
        self.assertEqual(
            evaluate_rollback(statuses=["ok", "error", "error"], duplicate_rate_value=0.0, relevance=0.9),
            "consecutive-failures",
        )

    def test_duplicates_above_threshold_trigger_rollback(self):
        self.assertEqual(
            evaluate_rollback(statuses=["ok"], duplicate_rate_value=0.06, relevance=0.9),
            "duplicates",
        )

    def test_low_relevance_triggers_rollback(self):
        self.assertEqual(
            evaluate_rollback(statuses=["ok"], duplicate_rate_value=0.0, relevance=0.7),
            "relevance",
        )

    def test_clean_state_does_not_roll_back(self):
        self.assertIsNone(
            evaluate_rollback(statuses=["ok", "ok"], duplicate_rate_value=0.0, relevance=0.9),
        )


if __name__ == "__main__":
    unittest.main()
