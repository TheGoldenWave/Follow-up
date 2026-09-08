"""Tests for the acquisition CLI argument handling."""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from follow_up_acquisition import __version__
from follow_up_acquisition.cli import main

REPO_ROOT = Path(__file__).resolve().parents[2]


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

    def test_doctor_missing_registry_returns_one(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["doctor", "--registry", "/nonexistent/sources.json"])
        self.assertEqual(code, 1)
        self.assertIn("failed to load registry", stdout.getvalue())

    def test_run_exits_zero(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["run"])
        self.assertEqual(code, 0)
        self.assertIn("run", stdout.getvalue())

    def test_run_accepts_source_argument(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["run", "--source", "blog:anthropic-engineering"])
        self.assertEqual(code, 0)
        self.assertIn("blog:anthropic-engineering", stdout.getvalue())

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
