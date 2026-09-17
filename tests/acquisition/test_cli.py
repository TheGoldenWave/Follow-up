"""Tests for the acquisition CLI argument handling."""

from __future__ import annotations

import contextlib
import io
import json
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from follow_up_acquisition import __version__
from follow_up_acquisition.cli import main
from follow_up_acquisition.collect import CollectionRun
from follow_up_acquisition.runtime import CheckpointUpdate, FrozenMapping

REPO_ROOT = Path(__file__).resolve().parents[2]


def _checkpoint(at: str = "2026-09-15T08:00:00Z") -> FrozenMapping:
    return FrozenMapping({
        "successful_window_end": at,
        "cursor": None,
        "etag": None,
        "last_modified": None,
        "recent_native_ids": ["native-1"],
        "checkpoint_at": at,
    })


def _intent() -> dict:
    return {
        "schema_version": "1.0",
        "run_id": "run-1",
        "generated_at": "2026-09-15T08:00:00Z",
        "sources": [{
            "source_id": "newsletter:test",
            "batch_id": "batch-1",
            "active_stream_ids": ["rss"],
            "updates": [{
                "stream_id": "rss",
                "previous_checkpoint_at": None,
                "checkpoint": dict(_checkpoint()),
            }],
        }],
    }


def _commit_args(intent_path: Path, state_root: Path, *, digest: str | None = None, run_id: str | None = None) -> list[str]:
    payload = intent_path.resolve().read_bytes()
    value = json.loads(payload)
    return ["commit-state", "--intent", str(intent_path), "--state-root", str(state_root),
        "--expected-sha256", digest or hashlib.sha256(payload).hexdigest(),
        "--expected-run-id", run_id or value["run_id"]]


class CliTests(unittest.TestCase):
    def test_doctor_exits_zero(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["doctor"])
        self.assertEqual(code, 0)
        self.assertIn("doctor", stdout.getvalue())

    def test_doctor_reports_registry_summary(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["doctor"])
        self.assertEqual(code, 0)
        out = stdout.getvalue()
        self.assertIn("sources:", out)
        self.assertIn("channels:", out)

    def test_doctor_json_emits_machine_readable_summary(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["doctor", "--json"])
        self.assertEqual(code, 0)
        summary = json.loads(stdout.getvalue())
        self.assertTrue(summary["ok"])
        self.assertIn("totals", summary)
        self.assertIn("channels", summary)
        self.assertGreater(summary["channels"]["core-topic"], 0)

    def test_doctor_keeps_registry_usable_when_local_state_backend_is_unsupported(self):
        stdout = io.StringIO()
        with patch("follow_up_acquisition.source_state.state_store_available", return_value=False), \
             contextlib.redirect_stdout(stdout):
            code = main(["doctor", "--json"])
        summary = json.loads(stdout.getvalue())
        self.assertEqual(code, 0)
        self.assertTrue(summary["central_registry_usable"])
        self.assertEqual(summary["state_backend"], "unsupported")

    def test_doctor_missing_registry_returns_one(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["doctor", "--registry", "/nonexistent/sources.json"])
        self.assertEqual(code, 1)
        self.assertIn("failed to load registry", stdout.getvalue())

    def test_run_no_collectable_sources_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = os.path.join(tmp, "sources.json")
            source = {
                "id": "x:test", "name": "Test", "channel": "x",
                "channel_policy": "fixed", "adapter": "x",
                "requires_credentials": False, "default_enabled": True,
                "cadence": "daily", "budget": 3, "input": {"handle": "test"},
                "legacy": {"feed": None},
            }
            with open(registry, "w", encoding="utf-8") as handle:
                json.dump({"schema_version": "1.0", "sources": [source]}, handle)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = main(["run", "--registry", registry])
        self.assertEqual(code, 0)
        self.assertEqual(stdout.getvalue(), "run: no collectable sources\n")

    def test_handshake_run_with_no_batches_still_writes_empty_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            registry = root / "sources.json"
            source = {
                "id": "x:test", "name": "Test", "channel": "x",
                "channel_policy": "fixed", "adapter": "x",
                "requires_credentials": False, "default_enabled": True,
                "cadence": "daily", "budget": 3, "input": {"handle": "test"},
                "legacy": {"feed": None},
            }
            registry.write_text(json.dumps({"schema_version": "1.0", "sources": [source]}))
            output = root / "staging"
            output.mkdir(mode=0o700)
            checkpoint_out = output / "checkpoint-intent.json"
            code = main([
                "run", "--registry", str(registry), "--run-id", "run-empty",
                "--output", str(output), "--checkpoint-out", str(checkpoint_out),
            ])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(checkpoint_out.read_text())["sources"], [])

    def test_run_unknown_source_returns_one(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["run", "--source", "bogus:nonexistent"])
        self.assertEqual(code, 1)
        self.assertIn("unknown source_id", stdout.getvalue())

    def test_run_writes_batches_and_checkpoint_intent_without_committing_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "staging"
            output.mkdir(mode=0o700)
            checkpoint_out = output / "checkpoint-intent.json"
            run = CollectionRun(
                {"newsletter:test": {"source": "newsletter:test", "batch_id": "batch-1", "source_status": {"status": "ok"}}},
                {"newsletter:test": (CheckpointUpdate("rss", None, _checkpoint()),)},
                {"newsletter:test": ("rss",)},
            )
            with patch("follow_up_acquisition.collect.collect_run", return_value=run):
                code = main([
                    "run", "--source", "newsletter:ai-snake-oil",
                    "--run-id", "run-1", "--output", str(output),
                    "--checkpoint-out", str(checkpoint_out),
                ])
            self.assertEqual(code, 0)
            intent = json.loads(checkpoint_out.read_text())
            self.assertEqual(intent["run_id"], "run-1")
            self.assertEqual(intent["sources"][0]["updates"][0]["stream_id"], "rss")
            self.assertEqual(checkpoint_out.stat().st_mode & 0o777, 0o600)
            self.assertTrue((output / "newsletter:test.json").is_file())

    def test_run_sorts_checkpoint_updates_canonically(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "staging"
            output.mkdir(mode=0o700)
            checkpoint_out = output / "checkpoint-intent.json"
            run = CollectionRun(
                {"community:test": {"source": "community:test", "batch_id": "batch-1", "source_status": {"status": "ok"}}},
                {"community:test": (
                    CheckpointUpdate("zeta", None, _checkpoint()),
                    CheckpointUpdate("alpha", None, _checkpoint()),
                )},
                {"community:test": ("alpha", "zeta")},
            )
            with patch("follow_up_acquisition.collect.collect_run", return_value=run):
                code = main(["run", "--source", "newsletter:ai-snake-oil", "--run-id", "run-order",
                    "--output", str(output), "--checkpoint-out", str(checkpoint_out)])
            self.assertEqual(code, 0)
            updates = json.loads(checkpoint_out.read_text())["sources"][0]["updates"]
            self.assertEqual([update["stream_id"] for update in updates], ["alpha", "zeta"])

    def test_run_with_updates_fails_closed_without_checkpoint_handshake(self):
        run = CollectionRun(
            {"newsletter:test": {"source": "newsletter:test", "batch_id": "batch-1"}},
            {"newsletter:test": (CheckpointUpdate("rss", None, _checkpoint()),)},
            {"newsletter:test": ("rss",)},
        )
        stdout = io.StringIO()
        with patch("follow_up_acquisition.collect.collect_run", return_value=run), \
             contextlib.redirect_stdout(stdout):
            code = main(["run", "--source", "newsletter:ai-snake-oil"])
        self.assertEqual(code, 1)
        self.assertIn("checkpoint handshake required", stdout.getvalue())

    def test_stateful_run_without_updates_still_requires_checkpoint_handshake(self):
        run = CollectionRun(
            {"community:test": {"source": "community:test", "batch_id": "batch-1", "source_status": {"status": "partial"}}},
            {"community:test": ()},
            {"community:test": ("top",)},
        )
        stdout = io.StringIO()
        with patch("follow_up_acquisition.collect.collect_run", return_value=run), contextlib.redirect_stdout(stdout):
            code = main(["run", "--source", "newsletter:ai-snake-oil"])
        self.assertEqual(code, 1)
        self.assertIn("checkpoint handshake required", stdout.getvalue())

    def test_stateful_adapter_identity_requires_handshake_even_without_a_batch(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["run", "--source", "community:github"])
        self.assertEqual(code, 1)
        self.assertIn("checkpoint handshake required", stdout.getvalue())

    def test_run_requires_absolute_co_located_staging_paths(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main([
                "run", "--run-id", "run-1", "--output", "relative",
                "--checkpoint-out", "/tmp/checkpoint-intent.json",
            ])
        self.assertEqual(code, 1)
        self.assertIn("absolute", stdout.getvalue())

    def test_run_rejects_checkpoint_intent_larger_than_one_mib(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "staging"
            output.mkdir(mode=0o700)
            checkpoint_out = output / "checkpoint-intent.json"
            large = FrozenMapping({**dict(_checkpoint()), "cursor": "x" * 220_000})
            batches = {}
            updates = {}
            active = {}
            for index in range(5):
                source = f"blog:test-{index}"
                batches[source] = {"source": source, "batch_id": f"b-{index}", "source_status": {"status": "ok"}}
                updates[source] = (CheckpointUpdate("rss", None, large),)
                active[source] = ("rss",)
            stdout = io.StringIO()
            with patch("follow_up_acquisition.collect.collect_run", return_value=CollectionRun(batches, updates, active)), \
                 contextlib.redirect_stdout(stdout):
                code = main(["run", "--source", "newsletter:ai-snake-oil", "--run-id", "run-large",
                    "--output", str(output), "--checkpoint-out", str(checkpoint_out)])
            self.assertEqual(code, 1)
            self.assertFalse(checkpoint_out.exists())
            self.assertIn("size limit", stdout.getvalue())

    def test_commit_state_revalidates_intent_and_commits_each_source_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp) / "acquisition"
            parent.mkdir(mode=0o700)
            intent_path = Path(tmp) / "checkpoint-intent.json"
            intent_path.write_text(json.dumps(_intent()))
            calls = []

            class Store:
                def __init__(self, root):
                    self.root = root

                def commit(self, source, updates, *, active_stream_ids, now=None):
                    calls.append((source, updates, tuple(active_stream_ids), now))
                    return {"source_id": source}

            stdout = io.StringIO()
            with patch("follow_up_acquisition.source_state.SourceStateStore", Store), \
                 contextlib.redirect_stdout(stdout):
                code = main(_commit_args(intent_path, parent / "source-state"))
            self.assertEqual(code, 0)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], "newsletter:test")
            self.assertEqual(json.loads(stdout.getvalue())["status"], "committed")

    def test_commit_state_rejects_symlink_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target.json"
            target.write_text(json.dumps(_intent()))
            link = Path(tmp) / "intent.json"
            link.symlink_to(target)
            parent = Path(tmp) / "acquisition"
            parent.mkdir(mode=0o700)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = main(_commit_args(link, parent / "source-state"))
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(stdout.getvalue())["status"], "partial")

    def test_commit_state_rejects_secret_bearing_intent_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            value = _intent()
            value["sources"][0]["batch_id"] = "ghp_" + "a" * 36
            intent_path = Path(tmp) / "intent.json"
            intent_path.write_text(json.dumps(value))
            parent = Path(tmp) / "acquisition"
            parent.mkdir(mode=0o700)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = main(_commit_args(intent_path, parent / "source-state"))
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(stdout.getvalue())["status"], "partial")

    def test_commit_state_reports_conflict_without_retry(self):
        from follow_up_acquisition.source_state import StateConflictError
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp) / "acquisition"
            parent.mkdir(mode=0o700)
            intent_path = Path(tmp) / "intent.json"
            intent_path.write_text(json.dumps(_intent()))
            attempts = []

            class Store:
                def __init__(self, root): pass
                def commit(self, *args, **kwargs):
                    attempts.append(1)
                    raise StateConflictError("stale")

            stdout = io.StringIO()
            with patch("follow_up_acquisition.source_state.SourceStateStore", Store), contextlib.redirect_stdout(stdout):
                code = main(_commit_args(intent_path, parent / "source-state"))
            self.assertEqual(code, 3)
            self.assertEqual(len(attempts), 1)
            self.assertEqual(json.loads(stdout.getvalue())["sources"][0]["status"], "conflict")

    def test_commit_state_rereads_once_after_durability_uncertainty(self):
        from follow_up_acquisition.source_state import SourceStateError
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp) / "acquisition"
            parent.mkdir(mode=0o700)
            intent_path = Path(tmp) / "intent.json"
            intent_path.write_text(json.dumps(_intent()))
            calls = {"commit": 0, "load": 0}

            class Store:
                def __init__(self, root): pass
                def commit(self, *args, **kwargs):
                    calls["commit"] += 1
                    raise SourceStateError("uncertain", code="state-durability-uncertain")
                def load(self, source):
                    calls["load"] += 1
                    return {"streams": {"rss": dict(_checkpoint())}}

            stdout = io.StringIO()
            with patch("follow_up_acquisition.source_state.SourceStateStore", Store), contextlib.redirect_stdout(stdout):
                code = main(_commit_args(intent_path, parent / "source-state"))
            self.assertEqual(code, 3)
            self.assertEqual(calls, {"commit": 1, "load": 1})
            report = json.loads(stdout.getvalue())
            self.assertEqual(report["status"], "uncertain")
            self.assertEqual(report["sources"][0]["status"], "uncertain")

    def test_commit_state_reports_store_setup_failure_as_safe_json(self):
        from follow_up_acquisition.source_state import SourceStateError
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp) / "acquisition"
            parent.mkdir(mode=0o700)
            intent_path = Path(tmp) / "intent.json"
            intent_path.write_text(json.dumps(_intent()))
            stdout = io.StringIO()
            with patch("follow_up_acquisition.source_state.SourceStateStore", side_effect=SourceStateError("/secret/path")), \
                 contextlib.redirect_stdout(stdout):
                code = main(_commit_args(intent_path, parent / "source-state"))
            self.assertEqual(code, 1)
            report = json.loads(stdout.getvalue())
            self.assertEqual(report["status"], "partial")
            self.assertEqual(report["sources"][0]["status"], "error")

    def test_commit_state_rejects_digest_or_run_mismatch_before_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp) / "acquisition"
            parent.mkdir(mode=0o700)
            intent_path = Path(tmp) / "intent.json"
            intent_path.write_text(json.dumps(_intent()))
            for args in (
                _commit_args(intent_path, parent / "source-state", digest="0" * 64),
                _commit_args(intent_path, parent / "source-state", run_id="wrong-run"),
            ):
                stdout = io.StringIO()
                with patch("follow_up_acquisition.source_state.SourceStateStore") as store, contextlib.redirect_stdout(stdout):
                    code = main(args)
                self.assertEqual(code, 1)
                store.assert_not_called()
                report = json.loads(stdout.getvalue())
                self.assertEqual(set(report), {"schema_version", "run_id", "status", "source_count", "sources"})
                self.assertEqual(report["status"], "partial")

    def test_no_command_prints_help_to_stderr_and_exits_two(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = main([])
        self.assertEqual(code, 2)
        self.assertIn("usage", stderr.getvalue())

    def test_module_entrypoint_reports_version(self):
        env = {**os.environ, "PYTHONPATH": str(REPO_ROOT / "src")}
        result = subprocess.run(
            [sys.executable, "-m", "follow_up_acquisition", "--version"],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(__version__, result.stdout)


if __name__ == "__main__":
    unittest.main()
