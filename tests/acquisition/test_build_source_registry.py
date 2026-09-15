from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class CanonicalRegistryValidatorTests(unittest.TestCase):
    def test_validator_never_rewrites_canonical_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            shutil.copytree(ROOT / "config", checkout / "config")
            (checkout / "scripts").mkdir()
            script = checkout / "scripts" / "build-source-registry.py"
            shutil.copy2(ROOT / "scripts" / "build-source-registry.py", script)
            registry = checkout / "config" / "sources.json"
            before = hashlib.sha256(registry.read_bytes()).digest()
            result = subprocess.run(["python3", str(script)], capture_output=True, text=True, check=False)
            after = hashlib.sha256(registry.read_bytes()).digest()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(after, before)
            self.assertIn("89", result.stdout)
            self.assertIn("70", result.stdout)

    def test_validator_rejects_legacy_metadata_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            shutil.copytree(ROOT / "config", checkout / "config")
            (checkout / "scripts").mkdir()
            script = checkout / "scripts" / "build-source-registry.py"
            shutil.copy2(ROOT / "scripts" / "build-source-registry.py", script)
            blogs_path = checkout / "config" / "feed-blogs.json"
            blogs = json.loads(blogs_path.read_text())
            blogs["sources"][0]["discovery"][0]["url"] = "https://example.com/drift"
            blogs_path.write_text(json.dumps(blogs))
            result = subprocess.run(["python3", str(script)], capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("metadata drift", result.stderr)


if __name__ == "__main__":
    unittest.main()
