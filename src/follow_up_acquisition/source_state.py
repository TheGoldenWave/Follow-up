"""Strict, credential-safe acquisition checkpoints with atomic persistence."""

from __future__ import annotations

import copy
from datetime import date, datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from typing import Any, Callable, Iterable, Mapping

from .contracts import is_credential_key
from .redaction import redact_text

STATE_SCHEMA_VERSION = "1.0"
MAX_STATE_BYTES = 256 * 1024
MAX_RECENT_NATIVE_IDS = 500

_STREAM_ID_RE = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_QUERY_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$")
_RFC3339_UTC_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")
_HIGH_CONFIDENCE_CREDENTIAL_VALUES = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
    re.compile(r"\bsk-[A-Za-z0-9]{32,255}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)

_STATE_FIELDS = frozenset({"schema_version", "source_id", "streams", "updated_at"})
_STREAM_FIELDS = frozenset({
    "successful_window_end", "cursor", "etag", "last_modified",
    "recent_native_ids", "query_fingerprint", "checkpoint_at",
})
_REQUIRED_STREAM_FIELDS = _STREAM_FIELDS - {"query_fingerprint"}
_UPDATE_FIELDS = frozenset({"stream_id", "previous_checkpoint_at", "checkpoint"})

# The order is part of the fingerprint contract. Aliases cover the bounded
# registry shapes used by the two query adapters; absent fields encode as "".
_FILTER_FIELDS = {
    "github": ("entities", "language", "min_stars", "owner", "topics"),
    "hackernews": ("tags", "min_points"),
}
_SET_FILTERS = frozenset({"entities", "topics", "tags"})
_TEXT_FILTERS = frozenset({"language", "owner"})
_INTEGER_FILTERS = frozenset({"min_stars", "min_points"})
_SORT_VALUES = {
    "github": frozenset({"updated", "stars"}),
    "hackernews": frozenset({"date", "points"}),
}
_QUERY_FIELDS = frozenset({
    "id", "query", "sort", "filters", "label", "display_label", "comment", "comments", "index",
})


class SourceStateError(ValueError):
    """Raised when state is invalid or cannot be accessed safely."""

    code = "invalid-state"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class StateConflictError(SourceStateError):
    """Raised when a per-stream compare-and-swap check fails."""

    code = "state-conflict"


class SchemaDriftError(SourceStateError):
    """Raised when a stable query ID is reused for changed semantics."""

    code = "schema-drift"


def _fail(message: str) -> None:
    raise SourceStateError(message)


def _require_exact_fields(value: Mapping[str, Any], expected: frozenset[str], label: str) -> None:
    actual = frozenset(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        _fail(f"{label} fields are closed (missing={missing}, extra={extra})")


def _parse_rfc3339_utc(value: Any, label: str, *, nullable: bool = False) -> datetime | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or _RFC3339_UTC_RE.fullmatch(value) is None:
        _fail(f"{label} must be a canonical UTC RFC3339 timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise SourceStateError(f"{label} must be a real timestamp") from exc
    return parsed


def _parse_date(value: Any, label: str) -> date:
    if not isinstance(value, str) or _DATE_RE.fullmatch(value) is None:
        _fail(f"{label} must be YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise SourceStateError(f"{label} must be a real date") from exc


def _iter_values(value: Any, path: str = "$"):
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                _fail(f"{path} contains a non-string object key")
            child_path = f"{path}.{key}"
            if is_credential_key(key):
                _fail(f"state embeds credential-shaped key: {child_path}")
            yield from _iter_values(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_values(child, f"{path}[{index}]")
    else:
        if isinstance(value, str) and redact_text(value) != value:
            _fail(f"state embeds credential-shaped value: {path}")
        if isinstance(value, str) and any(
            pattern.search(value) for pattern in _HIGH_CONFIDENCE_CREDENTIAL_VALUES
        ):
            _fail(f"state embeds high-confidence credential value: {path}")
        if not isinstance(value, (str, int, float, bool, type(None))):
            _fail(f"{path} is not JSON-compatible")
        yield value


def _canonical_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise SourceStateError("state must be finite JSON data") from exc


def _validate_archive_cursor(cursor: Any, *, allow_overflow: bool = False) -> None:
    if not isinstance(cursor, dict):
        _fail("Techmeme archive cursor must be an object")
    _require_exact_fields(
        cursor, frozenset({"current_processing_date", "complete_dates"}),
        "Techmeme archive cursor",
    )
    current = _parse_date(cursor["current_processing_date"], "current_processing_date")
    dates = cursor["complete_dates"]
    if not isinstance(dates, list):
        _fail("complete_dates must be an array")
    parsed = [_parse_date(item, "complete_dates item") for item in dates]
    if parsed != sorted(set(parsed)):
        _fail("complete_dates must be an ascending ordered set")
    if len(parsed) > 14 and not allow_overflow:
        _fail("complete_dates must contain at most 14 dates")
    if any(item >= current for item in parsed):
        _fail("every complete date must precede current_processing_date")


def _bound_archive_dates(state: dict[str, Any]) -> bool:
    """Bound an archive cursor before strict validation; return whether changed."""
    if not isinstance(state, dict) or not str(state.get("source_id", "")).endswith(":techmeme"):
        return False
    streams = state.get("streams")
    if not isinstance(streams, dict):
        return False
    archive = streams.get("archive")
    if not isinstance(archive, dict):
        return False
    cursor = archive.get("cursor")
    if not isinstance(cursor, dict):
        return False
    complete_dates = cursor.get("complete_dates")
    if not isinstance(complete_dates, list) or len(complete_dates) <= 14:
        return False
    cursor["complete_dates"] = complete_dates[-14:]
    return True


def _validate_checkpoint(checkpoint: Any, label: str, *, archive: bool = False) -> None:
    if not isinstance(checkpoint, dict):
        _fail(f"{label} must be an object")
    fields = frozenset(checkpoint)
    if not _REQUIRED_STREAM_FIELDS.issubset(fields) or not fields.issubset(_STREAM_FIELDS):
        _fail(f"{label} fields are closed")
    _parse_rfc3339_utc(
        checkpoint["successful_window_end"], f"{label}.successful_window_end", nullable=True,
    )
    _parse_rfc3339_utc(checkpoint["checkpoint_at"], f"{label}.checkpoint_at")
    for field in ("etag", "last_modified"):
        if checkpoint[field] is not None and not isinstance(checkpoint[field], str):
            _fail(f"{label}.{field} must be a string or null")
    native_ids = checkpoint["recent_native_ids"]
    if not isinstance(native_ids, list) or len(native_ids) > MAX_RECENT_NATIVE_IDS:
        _fail(f"{label}.recent_native_ids must contain at most 500 items")
    if any(not isinstance(item, str) or not item for item in native_ids):
        _fail(f"{label}.recent_native_ids items must be non-empty strings")
    if len(native_ids) != len(set(native_ids)):
        _fail(f"{label}.recent_native_ids must not contain duplicates")
    fingerprint = checkpoint.get("query_fingerprint")
    if fingerprint is not None and (
        not isinstance(fingerprint, str) or _FINGERPRINT_RE.fullmatch(fingerprint) is None
    ):
        _fail(f"{label}.query_fingerprint must be a lowercase SHA-256 hex digest")
    list(_iter_values(checkpoint["cursor"], f"{label}.cursor"))
    if archive:
        _validate_archive_cursor(checkpoint["cursor"])


def validate_state(value: Any, *, expected_source_id: str | None = None) -> Any:
    """Validate a closed source-state object and return it unchanged."""
    if not isinstance(value, dict):
        _fail("state must be an object")
    _require_exact_fields(value, _STATE_FIELDS, "state")
    if value["schema_version"] != STATE_SCHEMA_VERSION:
        _fail(f"schema_version must be {STATE_SCHEMA_VERSION!r}")
    source_id = value["source_id"]
    if not isinstance(source_id, str) or _SOURCE_ID_RE.fullmatch(source_id) is None:
        _fail("source_id is unsafe")
    if expected_source_id is not None and source_id != expected_source_id:
        _fail("state source_id does not match its filename")
    streams = value["streams"]
    if not isinstance(streams, dict):
        _fail("streams must be an object")
    for stream_id, checkpoint in streams.items():
        if not isinstance(stream_id, str) or _STREAM_ID_RE.fullmatch(stream_id) is None:
            _fail(f"invalid stream ID: {stream_id!r}")
        _validate_checkpoint(
            checkpoint, f"streams.{stream_id}",
            archive=source_id.endswith(":techmeme") and stream_id == "archive",
        )
        query_source = source_id.endswith(":github") or source_id.endswith(":hacker-news")
        query_stream = stream_id.startswith("query.") or stream_id.startswith("search.")
        if query_source and query_stream and "query_fingerprint" not in checkpoint:
            _fail(f"streams.{stream_id}.query_fingerprint is required")
    _parse_rfc3339_utc(value["updated_at"], "updated_at", nullable=True)
    list(_iter_values(value))
    if len(_canonical_bytes(value)) > MAX_STATE_BYTES:
        _fail("serialized state exceeds 256 KiB")
    return value


def _normalize_query_text(value: Any) -> str:
    if not isinstance(value, str):
        _fail("query must be a string")
    return " ".join(value.split())


def _normalize_filter_value(name: str, value: Any, label: str) -> str:
    if value is None:
        return ""
    if name in _INTEGER_FILTERS:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            _fail(f"{label} must be a non-negative integer")
        return str(value)
    if name in _TEXT_FILTERS:
        if not isinstance(value, str):
            _fail(f"{label} must be a string")
        return value.strip()
    if name in _SET_FILTERS and isinstance(value, (list, tuple, set, frozenset)):
        if any(not isinstance(item, str) for item in value):
            _fail(f"{label} collection must contain strings")
        items = sorted(set(value), key=lambda item: item.encode("utf-8"))
        return json.dumps(items, ensure_ascii=False, separators=(",", ":"))
    _fail(f"{label} has an unsupported value")
    raise AssertionError("unreachable")


def _frame_fields(fields: Iterable[str]) -> bytes:
    chunks: list[bytes] = []
    for field in fields:
        encoded = field.encode("utf-8")
        chunks.extend((str(len(encoded)).encode("ascii"), b":", encoded))
    return b"".join(chunks)


def query_fingerprint(adapter_id: str, query: Mapping[str, Any]) -> str:
    """Return the versioned semantic fingerprint for a GitHub or HN query."""
    if adapter_id not in _FILTER_FIELDS:
        _fail("query fingerprints only support github and hackernews adapters")
    if not isinstance(query, Mapping):
        _fail("query must be an object")
    extra = frozenset(query) - _QUERY_FIELDS
    if extra:
        _fail(f"query contains unsupported fields: {sorted(extra)}")
    query_id = query.get("id")
    if not isinstance(query_id, str) or _QUERY_ID_RE.fullmatch(query_id) is None:
        _fail("query.id is invalid")
    sort_value = query.get("sort")
    if sort_value not in _SORT_VALUES[adapter_id]:
        _fail(f"query.sort must be one of {sorted(_SORT_VALUES[adapter_id])}")
    filters = query.get("filters", {})
    if not isinstance(filters, Mapping):
        _fail("query.filters must be an object")
    field_order = _FILTER_FIELDS[adapter_id]
    unknown = frozenset(filters) - frozenset(field_order)
    if unknown:
        _fail(f"query.filters contains unsupported fields: {sorted(unknown)}")
    # Nested framing makes every absent value an explicit 0: while preserving
    # unambiguous boundaries inside the outer normalized-filters field.
    normalized_filters = _frame_fields(
        _normalize_filter_value(name, filters.get(name), f"query.filters.{name}")
        for name in field_order
    ).decode("utf-8")
    fields = (
        "query-v1", adapter_id, query_id, _normalize_query_text(query.get("query")),
        sort_value, normalized_filters,
    )
    return hashlib.sha256(_frame_fields(fields)).hexdigest()


def merge_checkpoint_updates(
    state: Mapping[str, Any], updates: Iterable[Mapping[str, Any]], *, updated_at: str,
) -> dict[str, Any]:
    """CAS-merge successful stream updates into a validated state copy."""
    validate_state(state)
    _parse_rfc3339_utc(updated_at, "updated_at")
    merged = copy.deepcopy(state)
    update_list = list(updates)
    if not update_list:
        return merged
    seen: set[str] = set()
    for index, update in enumerate(update_list):
        if not isinstance(update, Mapping):
            _fail(f"updates[{index}] must be an object")
        _require_exact_fields(update, _UPDATE_FIELDS, f"updates[{index}]")
        stream_id = update["stream_id"]
        if not isinstance(stream_id, str) or _STREAM_ID_RE.fullmatch(stream_id) is None:
            _fail(f"updates[{index}].stream_id is invalid")
        if stream_id in seen:
            _fail(f"duplicate update for stream {stream_id!r}")
        seen.add(stream_id)
        previous = update["previous_checkpoint_at"]
        _parse_rfc3339_utc(previous, f"updates[{index}].previous_checkpoint_at", nullable=True)
        current = merged["streams"].get(stream_id)
        current_at = None if current is None else current["checkpoint_at"]
        if current_at != previous:
            raise StateConflictError(
                f"stream {stream_id!r} checkpoint changed (expected {previous!r}, found {current_at!r})"
            )
        replacement = copy.deepcopy(update["checkpoint"])
        _validate_checkpoint(
            replacement, f"updates[{index}].checkpoint",
            archive=merged["source_id"].endswith(":techmeme") and stream_id == "archive",
        )
        replacement_at = _parse_rfc3339_utc(
            replacement["checkpoint_at"], f"updates[{index}].checkpoint.checkpoint_at",
        )
        previous_at = _parse_rfc3339_utc(
            previous, f"updates[{index}].previous_checkpoint_at", nullable=True,
        )
        if previous_at is not None and replacement_at is not None and replacement_at <= previous_at:
            raise StateConflictError(f"stream {stream_id!r} checkpoint time did not advance")
        if current is not None:
            old_fingerprint = current.get("query_fingerprint")
            new_fingerprint = replacement.get("query_fingerprint")
            if old_fingerprint is not None and old_fingerprint != new_fingerprint:
                raise SchemaDriftError(f"query fingerprint changed for stable stream {stream_id!r}")
        merged["streams"][stream_id] = replacement
    merged["updated_at"] = updated_at
    validate_state(merged)
    return merged


def prune_state(
    state: Mapping[str, Any], active_stream_ids: Iterable[str] | None = None, *, now: str,
) -> dict[str, Any]:
    """Prune expired removed queries and bound Techmeme archive date history."""
    if isinstance(state, Mapping) and str(state.get("source_id", "")).endswith(":techmeme"):
        raw_streams = state.get("streams")
        if isinstance(raw_streams, Mapping) and "archive" in raw_streams:
            raw_archive = raw_streams["archive"]
            if isinstance(raw_archive, Mapping):
                _validate_archive_cursor(raw_archive.get("cursor"), allow_overflow=True)
    pruned = copy.deepcopy(state)
    archive_bounded = _bound_archive_dates(pruned)
    validate_state(pruned)
    now_dt = _parse_rfc3339_utc(now, "now")
    assert now_dt is not None
    active = set(state["streams"]) if active_stream_ids is None else set(active_stream_ids)
    if any(not isinstance(item, str) or _STREAM_ID_RE.fullmatch(item) is None for item in active):
        _fail("active_stream_ids contains an invalid stream ID")
    changed = archive_bounded
    for stream_id in list(pruned["streams"]):
        is_query = stream_id.startswith("query.") or stream_id.startswith("search.")
        if is_query and stream_id not in active:
            checkpoint_dt = _parse_rfc3339_utc(
                pruned["streams"][stream_id]["checkpoint_at"], "checkpoint_at",
            )
            assert checkpoint_dt is not None
            if now_dt - checkpoint_dt >= timedelta(days=7):
                del pruned["streams"][stream_id]
                changed = True
    archive = pruned["streams"].get("archive")
    if pruned["source_id"].endswith(":techmeme") and archive is not None:
        cursor = archive["cursor"]
        bounded = sorted(set(cursor["complete_dates"]))[-14:]
        if bounded != cursor["complete_dates"]:
            cursor["complete_dates"] = bounded
            changed = True
    if changed:
        pruned["updated_at"] = now
    validate_state(pruned)
    return pruned


def _format_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    if value.microsecond:
        return value.isoformat(timespec="microseconds").replace("+00:00", "Z")
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _default_clock() -> datetime:
    return datetime.now(timezone.utc)


class SourceStateStore:
    """Load and atomically CAS-commit one JSON state file per source."""

    def __init__(
        self, root: str | os.PathLike[str] | None = None,
        *, clock: Callable[[], datetime] | None = None,
    ) -> None:
        default = Path.home() / ".follow-builders" / "acquisition" / "source-state"
        absolute_root = os.path.abspath(os.fspath(default if root is None else root))
        # macOS exposes its temporary tree through the system-owned /var and
        # /tmp compatibility symlinks. Canonicalize only those mount aliases;
        # user-controlled symlink components below them remain visible and are
        # rejected by _reject_symlink_path.
        if absolute_root == "/var" or absolute_root.startswith("/var/"):
            absolute_root = "/private" + absolute_root
        elif absolute_root == "/tmp" or absolute_root.startswith("/tmp/"):
            absolute_root = "/private" + absolute_root
        self.root = Path(absolute_root)
        self._clock = _default_clock if clock is None else clock

    def _validate_source_id(self, source_id: str) -> None:
        if not isinstance(source_id, str) or _SOURCE_ID_RE.fullmatch(source_id) is None:
            _fail("source_id is unsafe")

    def _reject_symlink_path(self) -> None:
        current = Path(self.root.anchor)
        for part in self.root.parts[1:]:
            current = current / part
            try:
                mode = current.lstat().st_mode
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(mode):
                raise SourceStateError(f"state path contains symlink: {current}", code="unsafe-state")

    def _ensure_root(self) -> None:
        self._reject_symlink_path()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._reject_symlink_path()
        if not self.root.is_dir():
            raise SourceStateError("state root is not a directory", code="unsafe-state")
        os.chmod(self.root, 0o700)

    def _path(self, source_id: str) -> Path:
        self._validate_source_id(source_id)
        return self.root / f"{source_id}.json"

    def _initial(self, source_id: str) -> dict[str, Any]:
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "source_id": source_id,
            "streams": {},
            "updated_at": None,
        }

    def load(self, source_id: str) -> dict[str, Any]:
        """Load validated state; return an empty state only when the file is absent."""
        path = self._path(source_id)
        self._reject_symlink_path()
        try:
            root_info = self.root.lstat()
        except FileNotFoundError:
            root_info = None
        if root_info is not None:
            if not stat.S_ISDIR(root_info.st_mode):
                raise SourceStateError("state root is not a directory", code="unsafe-state")
            if stat.S_IMODE(root_info.st_mode) & 0o077:
                raise SourceStateError("state root permissions exceed 0700", code="unsafe-state")
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags)
        except FileNotFoundError:
            initial = self._initial(source_id)
            validate_state(initial, expected_source_id=source_id)
            return initial
        except OSError as exc:
            raise SourceStateError("state file cannot be opened safely", code="unsafe-state") from exc
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise SourceStateError("state target is not a regular file", code="unsafe-state")
            if stat.S_IMODE(info.st_mode) & 0o077:
                raise SourceStateError("state file permissions exceed 0600", code="unsafe-state")
            with os.fdopen(descriptor, "rb", closefd=False) as handle:
                payload = handle.read(MAX_STATE_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(payload) > MAX_STATE_BYTES:
            _fail("state file exceeds 256 KiB")
        try:
            value = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SourceStateError("state file is corrupt") from exc
        validate_state(value, expected_source_id=source_id)
        return value

    def commit(
        self, source_id: str, updates: Iterable[Mapping[str, Any]], *,
        active_stream_ids: Iterable[str] | None = None, now: str | None = None,
    ) -> dict[str, Any]:
        """Lock, CAS-merge, fsync, and atomically replace one source state."""
        self._validate_source_id(source_id)
        self._ensure_root()
        lock_path = self.root / f".{source_id}.lock"
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        try:
            lock_fd = os.open(lock_path, flags, 0o600)
        except OSError as exc:
            raise SourceStateError("state lock cannot be opened safely", code="unsafe-state") from exc
        temp_path: str | None = None
        try:
            os.fchmod(lock_fd, 0o600)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            current = self.load(source_id)
            commit_at = _format_utc(self._clock())
            merged = merge_checkpoint_updates(
                current, updates, updated_at=commit_at,
            )
            if active_stream_ids is not None:
                merged = prune_state(
                    merged, active_stream_ids=active_stream_ids,
                    now=commit_at if now is None else now,
                )
            validate_state(merged, expected_source_id=source_id)
            payload = _canonical_bytes(merged) + b"\n"
            if len(payload) > MAX_STATE_BYTES:
                _fail("serialized state exceeds 256 KiB")
            temp_fd, temp_path = tempfile.mkstemp(
                prefix=f".{source_id}.json.", suffix=".tmp", dir=self.root,
            )
            try:
                os.fchmod(temp_fd, 0o600)
                with os.fdopen(temp_fd, "wb", closefd=True) as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_path, self._path(source_id))
                temp_path = None
                directory_fd = os.open(self.root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            finally:
                if temp_path is not None:
                    try:
                        os.unlink(temp_path)
                    except FileNotFoundError:
                        pass
            return merged
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
