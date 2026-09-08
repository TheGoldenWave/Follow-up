"""Controlled-vendoring manifest validation.

``vendor/manifest.json`` records the provenance of every upstream snapshot:
repository, version or commit, license, imported paths, hash, local patches, and
sync history. This module enforces that contract so a vendored file can never
silently lose its provenance.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

APPROVED_LICENSES = frozenset({
    "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense",
})

_MANIFEST_SCHEMA_VERSION = "1.0"

_ENTRY_REQUIRED = (
    "id",
    "upstream",
    "ref",
    "commit",
    "license",
    "license_file",
    "imported_paths",
    "sha256",
    "patches",
    "synced_at",
)


class VendorManifestError(ValueError):
    """Raised when a vendor manifest fails validation."""


def _is_hex40(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdefABCDEF" for character in value)
    )


def validate_vendor_manifest(manifest: Any) -> list[dict[str, Any]]:
    """Validate a vendor manifest object and return its entry list."""
    if not isinstance(manifest, dict):
        raise VendorManifestError("manifest must be an object")
    if manifest.get("schema_version") != _MANIFEST_SCHEMA_VERSION:
        raise VendorManifestError(f"manifest.schema_version must be '{_MANIFEST_SCHEMA_VERSION}'")
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise VendorManifestError("manifest.entries must be an array")

    seen_ids: set[str] = set()
    for index, entry in enumerate(entries):
        _validate_entry(entry, index, seen_ids)
    return entries


def _validate_entry(entry: Any, index: int, seen_ids: set[str]) -> None:
    if not isinstance(entry, dict):
        raise VendorManifestError(f"entries[{index}] must be an object")
    for field in _ENTRY_REQUIRED:
        if field not in entry:
            raise VendorManifestError(f"entries[{index}] is missing field: {field}")
    extra = set(entry) - set(_ENTRY_REQUIRED)
    if extra:
        raise VendorManifestError(
            f"entries[{index}] has unknown field(s): {', '.join(sorted(extra))}"
        )

    entry_id = entry["id"]
    if not isinstance(entry_id, str) or not entry_id:
        raise VendorManifestError(f"entries[{index}].id must be a non-empty string")
    if entry_id in seen_ids:
        raise VendorManifestError(f"duplicate vendor id: {entry_id}")
    seen_ids.add(entry_id)

    upstream = entry["upstream"]
    if not isinstance(upstream, str) or not upstream.startswith(("http://", "https://")):
        raise VendorManifestError(f"entries[{index}].upstream must be an http(s) URL")

    if not _is_hex40(entry["commit"]):
        raise VendorManifestError(f"entries[{index}].commit must be a 40-character hex SHA")

    if entry["license"] not in APPROVED_LICENSES:
        raise VendorManifestError(
            f"entries[{index}].license must be one of {sorted(APPROVED_LICENSES)}"
        )

    license_file = entry["license_file"]
    if license_file is not None and (
        not isinstance(license_file, str) or not license_file
    ):
        raise VendorManifestError(
            f"entries[{index}].license_file must be a non-empty string or null"
        )

    if not isinstance(entry["imported_paths"], list):
        raise VendorManifestError(f"entries[{index}].imported_paths must be an array")
    if not isinstance(entry["patches"], list):
        raise VendorManifestError(f"entries[{index}].patches must be an array")

    # A synced entry (has imported files) must also record its hash and time.
    if entry["imported_paths"]:
        if not entry["sha256"] or not entry["synced_at"]:
            raise VendorManifestError(
                f"entries[{index}] is synced and must record sha256 and synced_at"
            )


def load_vendor_manifest(path: str | Path) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as handle:
        return validate_vendor_manifest(json.load(handle))


def _imported_sha256(entry_dir: Path, imported_paths: list[str]) -> str:
    """SHA-256 of the concatenated imported file bytes in sorted path order."""
    digest = hashlib.sha256()
    for relative in sorted(imported_paths):
        digest.update((entry_dir / relative).read_bytes())
    return digest.hexdigest()


def verify_vendor_hashes(manifest: Any, vendor_root: str | Path) -> None:
    """Verify every synced entry's recorded ``sha256`` against the files on disk.

    ``imported_paths`` entries are resolved relative to ``vendor/<entry id>/``.
    Raises :class:`VendorManifestError` when a synced entry has a missing or
    stale hash, so a vendored file can never silently lose or diverge from its
    provenance.
    """
    entries = manifest.get("entries") if isinstance(manifest, dict) else []
    root = Path(vendor_root)
    for entry in entries:
        imported = entry.get("imported_paths") or []
        if not imported:
            continue
        entry_dir = root / entry.get("id", "")
        recorded = entry.get("sha256")
        actual = _imported_sha256(entry_dir, imported)
        if not recorded or actual != recorded:
            raise VendorManifestError(
                f"{entry.get('id')}: sha256 mismatch "
                f"(recorded {recorded!r}, actual {actual!r})"
            )
