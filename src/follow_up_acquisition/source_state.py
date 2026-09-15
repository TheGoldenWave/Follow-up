"""Strict, credential-safe acquisition checkpoints with atomic persistence."""

from __future__ import annotations

import copy
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, Callable, Iterable, Mapping

from .contracts import is_credential_key
from .redaction import redact_text
from .state_store_posix import PosixBackendError, PosixStateBackend, posix_backend_available

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
_FROZEN_UNICODE_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)
_FROZEN_WHITESPACE_RE = re.compile(f"[{re.escape(_FROZEN_UNICODE_WHITESPACE)}]+")
_DISALLOWED_CONTROL_RE = re.compile(
    r"[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]"
)
_HIGH_CONFIDENCE_CREDENTIAL_VALUES = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,255}\b"),
    re.compile(r"\bsk-[A-Za-z0-9]{32,255}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)

_STATE_FIELDS = frozenset({"schema_version", "source_id", "streams", "updated_at"})
_STREAM_FIELDS = frozenset({
    "successful_window_end", "cursor", "etag", "last_modified",
    "recent_native_ids", "query_fingerprint", "inactive_since", "checkpoint_at",
})
_REQUIRED_STREAM_FIELDS = _STREAM_FIELDS - {"query_fingerprint", "inactive_since"}
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


def _validate_archive_cursor(cursor: Any, *, max_dates: int = 14) -> None:
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
    if len(parsed) > max_dates:
        _fail(f"complete_dates must contain at most {max_dates} dates")
    if any(item >= current for item in parsed):
        _fail("every complete date must precede current_processing_date")


def _validate_checkpoint(
    checkpoint: Any, label: str, *, archive: bool = False, archive_max_dates: int = 14,
    allow_inactive: bool = True,
) -> None:
    if not isinstance(checkpoint, dict):
        _fail(f"{label} must be an object")
    fields = frozenset(checkpoint)
    if not _REQUIRED_STREAM_FIELDS.issubset(fields) or not fields.issubset(_STREAM_FIELDS):
        _fail(f"{label} fields are closed")
    _parse_rfc3339_utc(
        checkpoint["successful_window_end"], f"{label}.successful_window_end", nullable=True,
    )
    _parse_rfc3339_utc(checkpoint["checkpoint_at"], f"{label}.checkpoint_at")
    if "inactive_since" in checkpoint:
        if not allow_inactive:
            _fail(f"{label}.inactive_since is store-managed")
        _parse_rfc3339_utc(checkpoint["inactive_since"], f"{label}.inactive_since")
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
        _validate_archive_cursor(checkpoint["cursor"], max_dates=archive_max_dates)


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
        if "inactive_since" in checkpoint and not query_stream:
            _fail(f"streams.{stream_id}.inactive_since is only valid for query streams")
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
    _reject_semantic_controls(value, "query")
    normalized = _FROZEN_WHITESPACE_RE.sub(" ", value).strip(" ")
    if not normalized:
        _fail("query must not be empty after whitespace normalization")
    return normalized


def _reject_semantic_controls(value: str, label: str) -> None:
    if _DISALLOWED_CONTROL_RE.search(value):
        _fail(f"{label} contains a disallowed control character")


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
        _reject_semantic_controls(value, label)
        return value.strip(_FROZEN_UNICODE_WHITESPACE)
    if name in _SET_FILTERS and isinstance(value, (list, tuple, set, frozenset)):
        if any(not isinstance(item, str) for item in value):
            _fail(f"{label} collection must contain strings")
        for item in value:
            _reject_semantic_controls(item, label)
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
        is_archive = merged["source_id"].endswith(":techmeme") and stream_id == "archive"
        _validate_checkpoint(
            replacement, f"updates[{index}].checkpoint",
            archive=is_archive, archive_max_dates=15, allow_inactive=False,
        )
        if is_archive and len(replacement["cursor"]["complete_dates"]) == 15:
            replacement["cursor"]["complete_dates"] = replacement["cursor"]["complete_dates"][-14:]
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
    pruned = copy.deepcopy(state)
    validate_state(pruned)
    now_dt = _parse_rfc3339_utc(now, "now")
    assert now_dt is not None
    active = set(state["streams"]) if active_stream_ids is None else set(active_stream_ids)
    if any(not isinstance(item, str) or _STREAM_ID_RE.fullmatch(item) is None for item in active):
        _fail("active_stream_ids contains an invalid stream ID")
    changed = False
    for stream_id in list(pruned["streams"]):
        is_query = stream_id.startswith("query.") or stream_id.startswith("search.")
        if not is_query:
            continue
        checkpoint = pruned["streams"][stream_id]
        if stream_id in active:
            if "inactive_since" in checkpoint:
                del checkpoint["inactive_since"]
                changed = True
        else:
            inactive_since = checkpoint.get("inactive_since")
            if inactive_since is None:
                checkpoint["inactive_since"] = now
                changed = True
                continue
            inactive_dt = _parse_rfc3339_utc(inactive_since, "inactive_since")
            assert inactive_dt is not None
            if now_dt - inactive_dt >= timedelta(days=7):
                del pruned["streams"][stream_id]
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


def state_store_available(platform_name: str | None = None) -> bool:
    """Return whether secure persistent source state is available."""
    return posix_backend_available(platform_name)


class SourceStateStore:
    """Load and atomically CAS-commit one JSON state file per source."""

    def __init__(
        self, root: str | os.PathLike[str] | None = None,
        *, clock: Callable[[], datetime] | None = None, platform_name: str | None = None,
        backend_hooks: Mapping[str, Callable[[], None]] | None = None,
    ) -> None:
        default = Path.home() / ".follow-builders" / "acquisition" / "source-state"
        try:
            self._backend = PosixStateBackend(
                default if root is None else root,
                platform_name=platform_name,
                hooks=backend_hooks,
            )
        except PosixBackendError as exc:
            raise SourceStateError(str(exc), code=exc.code) from exc
        self.root = self._backend.root
        self._clock = _default_clock if clock is None else clock

    def _validate_source_id(self, source_id: str) -> None:
        if not isinstance(source_id, str) or _SOURCE_ID_RE.fullmatch(source_id) is None:
            _fail("source_id is unsafe")

    def _filename(self, source_id: str) -> str:
        self._validate_source_id(source_id)
        return f"{source_id}.json"

    def _initial(self, source_id: str) -> dict[str, Any]:
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "source_id": source_id,
            "streams": {},
            "updated_at": None,
        }

    def load(self, source_id: str) -> dict[str, Any]:
        """Load validated state; return an empty state only when the file is absent."""
        try:
            payload = self._backend.read(self._filename(source_id), MAX_STATE_BYTES)
        except PosixBackendError as exc:
            raise SourceStateError(str(exc), code=exc.code) from exc
        except OSError as exc:
            raise SourceStateError("state file cannot be opened safely", code="unsafe-state") from exc
        if payload is None:
            initial = self._initial(source_id)
            validate_state(initial, expected_source_id=source_id)
            return initial
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
        filename = self._filename(source_id)
        update_list = list(updates)

        def transform(payload: bytes | None) -> tuple[bytes, dict[str, Any]]:
            if payload is None:
                current = self._initial(source_id)
            else:
                try:
                    current = json.loads(payload.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise SourceStateError("state file is corrupt") from exc
                validate_state(current, expected_source_id=source_id)
            commit_at = _format_utc(self._clock())
            merged = merge_checkpoint_updates(
                current, update_list, updated_at=commit_at,
            )
            if active_stream_ids is not None:
                effective_active = set(active_stream_ids)
                effective_active.update(update["stream_id"] for update in update_list)
                merged = prune_state(
                    merged, active_stream_ids=effective_active,
                    now=commit_at if now is None else now,
                )
            validate_state(merged, expected_source_id=source_id)
            payload = _canonical_bytes(merged)
            if len(payload) > MAX_STATE_BYTES:
                _fail("serialized state exceeds 256 KiB")
            return payload, merged

        try:
            return self._backend.atomic_update(
                filename, f".{source_id}.lock", MAX_STATE_BYTES, transform,
            )
        except PosixBackendError as exc:
            raise SourceStateError(str(exc), code=exc.code) from exc
        except SourceStateError:
            raise
        except OSError as exc:
            raise SourceStateError("state commit failed", code="state-write-failed") from exc
