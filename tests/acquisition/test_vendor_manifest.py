"""Tests for controlled-vendoring manifest validation."""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from follow_up_acquisition.vendor import (
    APPROVED_LICENSES,
    VendorManifestError,
    load_vendor_manifest,
    validate_vendor_manifest,
)

MANIFEST_PATH = Path(__file__).resolve().parents[2] / "vendor" / "manifest.json"

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
        self.assertTrue(all(e["imported_paths"] == [] for e in entries))

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


if __name__ == "__main__":
    unittest.main()
