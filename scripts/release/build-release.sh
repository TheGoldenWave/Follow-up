#!/bin/sh
set -eu

TREEISH=${1:-HEAD}
OUTPUT=${2:-dist}
ROOT=$(git rev-parse --show-toplevel)
COMMIT=$(git -C "$ROOT" rev-parse --verify "${TREEISH}^{commit}")

if ! git -C "$ROOT" diff --quiet "$COMMIT" --; then
  echo "Tracked working files differ from release commit $COMMIT" >&2
  exit 1
fi

VERSION=$(git -C "$ROOT" show "$COMMIT:VERSION" | tr -d '\r\n')
case "$VERSION" in
  ''|*[!0-9.]*)
    echo "VERSION is not a plain semantic version: $VERSION" >&2
    exit 1
    ;;
esac

mkdir -p "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd -P)
ARCHIVE="Follow-up-v${VERSION}.tar.gz"
CHECKSUMS="Follow-up-v${VERSION}-checksums.txt"
PREFIX="Follow-up-v${VERSION}/"

node "$ROOT/scripts/release/validate-release.js" --treeish "$COMMIT"

TEMP_ARCHIVE="$OUTPUT/.${ARCHIVE}.tmp"
trap 'rm -f "$TEMP_ARCHIVE"' EXIT HUP INT TERM
git -C "$ROOT" archive --format=tar --prefix="$PREFIX" "$COMMIT" | gzip -n > "$TEMP_ARCHIVE"
mv "$TEMP_ARCHIVE" "$OUTPUT/$ARCHIVE"

(
  cd "$OUTPUT"
  shasum -a 256 "$ARCHIVE" > "$CHECKSUMS"
)
git -C "$ROOT" show "$COMMIT:release-manifest.json" > "$OUTPUT/release-manifest.json"

CONTENTS=$(tar -tzf "$OUTPUT/$ARCHIVE")
for forbidden in '.hermes/' 'docker/' '.env' 'node_modules/' 'dist/' 'docs/wechat-integration.md'; do
  if printf '%s\n' "$CONTENTS" | grep -F "$forbidden" >/dev/null; then
    echo "Forbidden release path found: $forbidden" >&2
    exit 1
  fi
done

printf 'Built %s from %s\n' "$OUTPUT/$ARCHIVE" "$COMMIT"
printf 'Checksum: %s\n' "$OUTPUT/$CHECKSUMS"
