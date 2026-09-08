"""Tests for controlled-vendoring manifest validation."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from follow_up_acquisition.vendor import (
    APPROVED_LICENSES,
    VendorManifestError,
    load_vendor_manifest,
    validate_vendor_manifest,
    verify_vendor_hashes,
)

MANIFEST_PATH = Path(__file__).resolve().parents[2] / "vendor" / "manifest.json"
VENDOR_ROOT = MANIFEST_PATH.parent

VALID_ENTRY = {
    "id": "upstream",
    "upstream": "https://github.com/example/repo",
    "ref": "1.0.0",
    "commit": "f" * 40,
    "license": "MIT",
    "license_file": "vendor/licenses/upstream-MIT.txt",
    "imported_paths": [],
    "sha256": None,
    "patches": [],
    "synced_at": None,
}


def _manifest(entries):
    return {"schema_version": "1.0", "entries": entries}


def _entry(**overrides):
    entry = copy.deepcopy(VALID_ENTRY)
    entry.update(overrides)
    return entry


class VendorManifestTests(unittest.TestCase):
    def test_real_manifest_is_valid(self):
        entries = load_vendor_manifest(MANIFEST_PATH)
        self.assertEqual(len(entries), 3)
        synced = {entry["id"] for entry in entries if entry["imported_paths"]}
        self.assertEqual(synced, {"last30days"})

    def test_valid_unsynced_entry_passes(self):
        validate_vendor_manifest(_manifest([VALID_ENTRY]))

    def test_rejects_duplicate_id(self):
        with self.assertRaises(VendorManifestError):
            validate_vendor_manifest(_manifest([VALID_ENTRY, VALID_ENTRY]))

    def test_rejects_invalid_commit(self):
        for commit in ("f" * 39, "g" * 40, "short", None):
            with self.assertRaises(VendorManifestError):
                validate_vendor_manifest(_manifest([_entry(commit=commit)]))

    def test_rejects_unapproved_license(self):
        with self.assertRaises(VendorManifestError):
            validate_vendor_manifest(_manifest([_entry(license="WTFPL")]))

    def test_rejects_non_url_upstream(self):
        with self.assertRaises(VendorManifestError):
            validate_vendor_manifest(_manifest([_entry(upstream="not-a-url")]))

    def test_rejects_missing_required_field(self):
        entry = copy.deepcopy(VALID_ENTRY)
        del entry["sha256"]
        with self.assertRaises(VendorManifestError):
            validate_vendor_manifest(_manifest([entry]))

    def test_synced_entry_requires_hash_and_timestamp(self):
        with self.assertRaises(VendorManifestError):
            validate_vendor_manifest(_manifest([_entry(imported_paths=["core.py"])]))

    def test_synced_entry_with_provenance_passes(self):
        entry = _entry(
            imported_paths=["core.py"],
            sha256="a" * 64,
            synced_at="2026-09-08T12:00:00Z",
        )
        validate_vendor_manifest(_manifest([entry]))

    def test_approved_licenses_are_known(self):
        self.assertIn("MIT", APPROVED_LICENSES)
        self.assertIn("Apache-2.0", APPROVED_LICENSES)


class VendorHashTests(unittest.TestCase):
    def test_real_manifest_hashes_match_files(self):
        manifest = json.loads(MANIFEST_PATH.read_text())
        verify_vendor_hashes(manifest, VENDOR_ROOT)

    def test_matching_hash_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            content = b"def f(): pass"
            (root / "upstream").mkdir()
            (root / "upstream" / "cjk.py").write_bytes(content)
            entry = _entry(
                imported_paths=["cjk.py"],
                sha256=hashlib.sha256(content).hexdigest(),
                synced_at="2026-09-08T00:00:00Z",
            )
            verify_vendor_hashes(_manifest([entry]), root)

    def test_stale_hash_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "upstream").mkdir()
            (root / "upstream" / "cjk.py").write_bytes(b"def f(): pass")
            entry = _entry(
                imported_paths=["cjk.py"],
                sha256="0" * 64,
                synced_at="2026-09-08T00:00:00Z",
            )
            with self.assertRaises(VendorManifestError):
                verify_vendor_hashes(_manifest([entry]), root)

    def test_synced_entry_without_hash_fails_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "upstream").mkdir()
            (root / "upstream" / "cjk.py").write_bytes(b"def f(): pass")
            entry = _entry(
                imported_paths=["cjk.py"],
                sha256=None,
                synced_at="2026-09-08T00:00:00Z",
            )
            with self.assertRaises(VendorManifestError):
                verify_vendor_hashes(_manifest([entry]), root)


class VendoredModuleTests(unittest.TestCase):
    def test_vendored_cjk_segments_chinese_text(self):
        spec = importlib.util.spec_from_file_location(
            "vendored_cjk", str(VENDOR_ROOT / "last30days" / "cjk.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertTrue(module.has_cjk("大模型"))
        self.assertFalse(module.has_cjk("hello world"))
        tokens = module.segment("大模型")
        self.assertIn("大模", tokens)
        self.assertIn("模型", tokens)


if __name__ == "__main__":
    unittest.main()
