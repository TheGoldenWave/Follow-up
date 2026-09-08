#!/usr/bin/env bash
# Controlled vendor sync for last30days-skill.
#
# Downloads to a temp dir, verifies the pinned commit, copies the approved paths,
# and emits a reviewable diff. It NEVER auto-merges or auto-commits. Requires
# network access to GitHub; run under review when upstream changes.
set -euo pipefail

UPSTREAM="https://github.com/mvanhorn/last30days-skill"
COMMIT="fcebe321c22e5e97e3ef5712e4bc00f2b33bba37"
# Paths approved for import, relative to the upstream repo root. Populate after
# reviewing the upstream layout; leaving this empty is a deliberate stop-gate.
IMPORT_PATHS=()

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENDOR_DIR="$ROOT/vendor/last30days"
TMP_DIR="$(mktemp -d)"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "cloning $UPSTREAM @ $COMMIT" >&2
git clone --quiet "$UPSTREAM" "$TMP_DIR/src"
git -C "$TMP_DIR/src" checkout --quiet "$COMMIT"

ACTUAL="$(git -C "$TMP_DIR/src" rev-parse HEAD)"
if [[ "$ACTUAL" != "$COMMIT" ]]; then
  echo "commit mismatch: expected $COMMIT, got $ACTUAL" >&2
  exit 1
fi

if [[ ${#IMPORT_PATHS[@]} -eq 0 ]]; then
  echo "IMPORT_PATHS is empty; review the upstream layout and populate it before importing." >&2
  exit 1
fi

echo "importing approved paths into $VENDOR_DIR" >&2
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
for path in "${IMPORT_PATHS[@]}"; do
  cp -R "$TMP_DIR/src/$path" "$VENDOR_DIR/"
done

echo "recording file hashes" >&2
find "$VENDOR_DIR" -type f -print0 | sort -z | xargs -0 shasum -a 256 > "$TMP_DIR/manifest.hashes"

echo "done. Review the diff, update vendor/manifest.json (sha256, synced_at, imported_paths), and commit manually." >&2
