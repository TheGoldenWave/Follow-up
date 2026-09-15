"""Acquisition Runtime: adapter orchestration, normalization, dedupe, serialization.

The runtime is the only component allowed to normalize candidates, assign a
``batch_id``, aggregate a source status, deduplicate across sources, and serialize
Signal Batch envelopes. Adapters return source-native :class:`SourceCandidate`
objects plus one classified :class:`SourceResult`; the runtime turns those into
contract-validated batches.
"""

from __future__ import annotations

import copy
import json
import math
import re
import uuid
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Iterable, Protocol

from .contracts import SCHEMA_VERSION, SignalBatchError, validate_batch
from .source_state import (
    MAX_STATE_BYTES,
    STATE_SCHEMA_VERSION,
    SourceStateError,
    merge_checkpoint_updates,
    validate_state,
)

_TRACKING_PARAMS = frozenset({
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "mc_eid", "mc_cid",
})

# Adapter output is untrusted.  These limits keep validation iterative and
# bounded before persistence's authoritative semantic/state-size checks run.
MAX_CHECKPOINT_DEPTH = 64
MAX_CHECKPOINT_NODES = 10_000
MAX_CHECKPOINT_UPDATES = 128
MAX_CHECKPOINT_UPDATE_BYTES = MAX_STATE_BYTES


class FrozenMapping(Mapping[str, Any]):
    """A recursively immutable, read-only JSON object."""

    __slots__ = ("_data",)

    def __init__(self, values: dict[str, Any]) -> None:
        self._data = MappingProxyType(values)

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, FrozenMapping):
            return self._data == other._data
        if type(other) is dict:
            return _thaw_json(self) == other
        return False

    def __repr__(self) -> str:
        return f"FrozenMapping({self._data!r})"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class AdapterError(Exception):
    """Classified adapter failure carrying a source-status taxonomy value."""

    def __init__(self, message: str, *, status: str = "error", retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class RateLimitedError(AdapterError):
    def __init__(self, message: str = "rate limited"):
        super().__init__(message, status="rate-limited", retryable=True)


class AuthFailedError(AdapterError):
    def __init__(self, message: str = "authentication failed"):
        super().__init__(message, status="auth-failed", retryable=False)


class SchemaDriftError(AdapterError):
    def __init__(self, message: str = "adapter output drifted from the expected schema"):
        super().__init__(message, status="schema-drift", retryable=False)


@dataclass(frozen=True)
class CheckpointUpdate:
    """Validated pending state for one completely collected source stream."""

    stream_id: str
    previous_checkpoint_at: str | None
    checkpoint: Mapping[str, Any]


def _validate_json_shape(value: Any) -> None:
    """Reject non-JSON, cyclic, excessively deep, or excessively large trees."""
    stack: list[tuple[str, Any, int]] = [("node", value, 0)]
    active: set[int] = set()
    nodes = 0
    while stack:
        kind, item, depth = stack.pop()
        if kind == "exit":
            active.remove(item)
            continue
        if kind in {"dict-items", "list-items"}:
            try:
                child = next(item)
            except StopIteration:
                continue
            stack.append((kind, item, depth))
            if kind == "dict-items":
                key, child = child
                if type(key) is not str:
                    raise SourceStateError("checkpoint object keys must be strings")
            stack.append(("node", child, depth))
            continue
        nodes += 1
        if nodes > MAX_CHECKPOINT_NODES:
            raise SourceStateError("checkpoint exceeds structural limits")
        if depth > MAX_CHECKPOINT_DEPTH:
            raise SourceStateError("checkpoint exceeds structural limits")
        item_type = type(item)
        if item_type is dict:
            item_id = id(item)
            if item_id in active:
                raise SourceStateError("checkpoint must not contain cycles")
            active.add(item_id)
            stack.append(("exit", item_id, depth))
            stack.append(("dict-items", iter(item.items()), depth + 1))
        elif item_type is list:
            item_id = id(item)
            if item_id in active:
                raise SourceStateError("checkpoint must not contain cycles")
            active.add(item_id)
            stack.append(("exit", item_id, depth))
            stack.append(("list-items", iter(item), depth + 1))
        elif item_type is float:
            if not math.isfinite(item):
                raise SourceStateError("checkpoint numbers must be finite")
        elif item_type not in {str, int, bool, type(None)}:
            raise SourceStateError("checkpoint contains a non-JSON value")


def _bounded_json_string_size(value: str, limit: int) -> int:
    """Return exact ensure_ascii=False JSON string bytes, stopping above limit."""
    size = 2  # surrounding quotation marks
    if size > limit:
        raise SourceStateError("checkpoint updates exceed aggregate size limit")
    for character in value:
        codepoint = ord(character)
        if character in {'"', "\\", "\b", "\f", "\n", "\r", "\t"}:
            width = 2
        elif codepoint < 0x20:
            width = 6
        elif codepoint <= 0x7F:
            width = 1
        elif codepoint <= 0x7FF:
            width = 2
        elif 0xD800 <= codepoint <= 0xDFFF:
            raise SourceStateError("checkpoint contains invalid Unicode")
        elif codepoint <= 0xFFFF:
            width = 3
        else:
            width = 4
        size += width
        if size > limit:
            raise SourceStateError("checkpoint updates exceed aggregate size limit")
    return size


def _bounded_json_number_size(value: int | float, limit: int) -> int:
    if type(value) is int:
        # Four bits encode at most one decimal digit.  This cheap lower bound
        # rejects enormous integers before attempting a decimal conversion.
        if value.bit_length() > max(limit, 0) * 4 + 4:
            raise SourceStateError("checkpoint updates exceed aggregate size limit")
        try:
            encoded = str(value)
        except ValueError as exc:
            raise SourceStateError("checkpoint integer cannot be encoded") from exc
    else:
        encoded = repr(value)
    if len(encoded) > limit:
        raise SourceStateError("checkpoint updates exceed aggregate size limit")
    return len(encoded)


def _bounded_canonical_json_size(value: Any, limit: int) -> int:
    """Compute exact compact canonical JSON UTF-8 bytes without serializing it."""
    size = 0
    stack: list[tuple[str, Any, bool]] = [("node", value, True)]

    def add(width: int) -> None:
        nonlocal size
        size += width
        if size > limit:
            raise SourceStateError("checkpoint updates exceed aggregate size limit")

    while stack:
        kind, item, first = stack.pop()
        if kind == "dict-items":
            try:
                key, child = next(item)
            except StopIteration:
                continue
            if not first:
                add(1)
            add(_bounded_json_string_size(key, limit - size))
            add(1)  # colon
            stack.append((kind, item, False))
            stack.append(("node", child, True))
            continue
        if kind == "list-items":
            try:
                child = next(item)
            except StopIteration:
                continue
            if not first:
                add(1)
            stack.append((kind, item, False))
            stack.append(("node", child, True))
            continue

        item_type = type(item)
        if item_type is dict:
            add(2)  # braces
            stack.append(("dict-items", iter(item.items()), True))
        elif item_type is list:
            add(2)  # brackets
            stack.append(("list-items", iter(item), True))
        elif item_type is str:
            add(_bounded_json_string_size(item, limit - size))
        elif item_type in {int, float}:
            add(_bounded_json_number_size(item, limit - size))
        elif item_type is bool:
            add(4 if item else 5)
        elif item is None:
            add(4)
        else:  # Shape validation should make this unreachable.
            raise SourceStateError("checkpoint contains a non-JSON value")
    return size


def _bounded_checkpoint_update_size(update: CheckpointUpdate, limit: int) -> int:
    if type(update.stream_id) is not str:
        raise SourceStateError("checkpoint stream_id must be a string")
    if update.previous_checkpoint_at is not None and type(update.previous_checkpoint_at) is not str:
        raise SourceStateError("previous_checkpoint_at must be a string or null")

    # Exact compact JSON object framing for checkpoint/previous_checkpoint_at/stream_id.
    size = 2 + 2 + 3  # braces, commas, colons
    for key in ("checkpoint", "previous_checkpoint_at", "stream_id"):
        size += _bounded_json_string_size(key, limit - size)
    size += _bounded_json_string_size(update.stream_id, limit - size)
    if update.previous_checkpoint_at is None:
        size += 4
    else:
        size += _bounded_json_string_size(update.previous_checkpoint_at, limit - size)
    if size > limit:
        raise SourceStateError("checkpoint updates exceed aggregate size limit")
    size += _bounded_canonical_json_size(update.checkpoint, limit - size)
    if size > limit:
        raise SourceStateError("checkpoint updates exceed aggregate size limit")
    return size


def _canonical_json_copy(value: dict[str, Any]) -> tuple[dict[str, Any], int]:
    try:
        encoded = json.dumps(
            value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True,
        ).encode("utf-8")
        return json.loads(encoded), len(encoded)
    except Exception as exc:  # JSON/string/integer encoding is still an untrusted boundary.
        raise SourceStateError("checkpoint cannot be encoded as canonical JSON") from exc


def _freeze_json(value: Any) -> Any:
    if type(value) is dict:
        return FrozenMapping({key: _freeze_json(child) for key, child in value.items()})
    if type(value) is list:
        return tuple(_freeze_json(child) for child in value)
    return value


def _thaw_json(value: Any) -> Any:
    if isinstance(value, FrozenMapping):
        return {key: _thaw_json(child) for key, child in value.items()}
    if type(value) is dict:
        return {key: _thaw_json(child) for key, child in value.items()}
    if type(value) is tuple:
        return [_thaw_json(child) for child in value]
    if type(value) is list:
        return [_thaw_json(child) for child in value]
    return value


def thaw_checkpoint_update(update: CheckpointUpdate) -> dict[str, Any]:
    """Return a fresh JSON object suitable for persistence/serialization."""
    return {
        "stream_id": update.stream_id,
        "previous_checkpoint_at": update.previous_checkpoint_at,
        "checkpoint": _thaw_json(update.checkpoint),
    }


def _empty_source_state(source: str) -> dict[str, Any]:
    state = {
        "schema_version": STATE_SCHEMA_VERSION,
        "source_id": source,
        "streams": {},
        "updated_at": None,
    }
    validate_state(state, expected_source_id=source)
    return state


def validate_checkpoint_updates(
    source: str,
    updates: Iterable[CheckpointUpdate],
) -> tuple[CheckpointUpdate, ...]:
    """Validate and detach adapter-produced pending checkpoint updates.

    Persistence owns the checkpoint schema and security contract.  The runtime
    exercises that authoritative validator against synthetic state, first per
    update and then as one aggregate, without changing caller-owned values.
    """
    _empty_source_state(source)
    try:
        update_iterator = iter(updates)
    except Exception as exc:
        raise SourceStateError("checkpoint updates must be iterable") from exc

    detached: list[CheckpointUpdate] = []
    retained_bytes = 2  # JSON array brackets around the pending update sequence.
    validation_time = "9999-12-31T23:59:59Z"
    index = 0
    while True:
        try:
            update = next(update_iterator)
        except StopIteration:
            break
        except Exception as exc:
            raise SourceStateError("checkpoint updates cannot be read safely") from exc
        if index >= MAX_CHECKPOINT_UPDATES:
            raise SourceStateError("too many checkpoint updates")
        if not isinstance(update, CheckpointUpdate):
            raise SourceStateError(f"checkpoint_updates[{index}] must be a CheckpointUpdate")
        if type(update.checkpoint) is not dict:
            raise SourceStateError(f"checkpoint_updates[{index}].checkpoint must be an object")
        _validate_json_shape(update.checkpoint)
        separator_bytes = 1 if detached else 0
        remaining_bytes = MAX_CHECKPOINT_UPDATE_BYTES - retained_bytes - separator_bytes
        update_bytes = _bounded_checkpoint_update_size(update, remaining_bytes)
        checkpoint, _ = _canonical_json_copy(update.checkpoint)
        retained_bytes += separator_bytes + update_bytes
        detached_update = CheckpointUpdate(
            update.stream_id, update.previous_checkpoint_at, checkpoint,
        )

        current_streams: dict[str, Any] = {}
        if update.previous_checkpoint_at is not None:
            current = copy.deepcopy(checkpoint)
            current.pop("inactive_since", None)
            current["checkpoint_at"] = update.previous_checkpoint_at
            if source.endswith(":techmeme") and update.stream_id == "archive":
                cursor = current.get("cursor")
                if isinstance(cursor, dict) and isinstance(cursor.get("complete_dates"), list):
                    cursor["complete_dates"] = cursor["complete_dates"][-14:]
            current_streams[update.stream_id] = current
        current_state = {
            "schema_version": STATE_SCHEMA_VERSION,
            "source_id": source,
            "streams": current_streams,
            "updated_at": validation_time if current_streams else None,
        }
        merge_checkpoint_updates(
            current_state,
            [{
                "stream_id": detached_update.stream_id,
                "previous_checkpoint_at": detached_update.previous_checkpoint_at,
                "checkpoint": detached_update.checkpoint,
            }],
            updated_at=validation_time,
        )
        detached.append(detached_update)
        index += 1

    # A second pass makes duplicate streams and the combined payload subject to
    # the same closed, maximum-size source-state validation as persistence.
    merge_checkpoint_updates(
        _empty_source_state(source),
        [{
            "stream_id": update.stream_id,
            "previous_checkpoint_at": None,
            "checkpoint": update.checkpoint,
        } for update in detached],
        updated_at=validation_time,
    )
    return tuple(CheckpointUpdate(
        update.stream_id,
        update.previous_checkpoint_at,
        _freeze_json(update.checkpoint),
    ) for update in detached)


@dataclass(frozen=True)
class SourceCandidate:
    """Source-native parsed candidate.

    Deliberately contains no ``batch_id``, channel assignment, canonical dedupe
    key, or batch status: those are runtime responsibilities.
    """

    native_id: str
    url: str
    source_type: str
    date_confidence: str
    fetched_at: str
    title: str | None = None
    author: str | None = None
    published_at: str | None = None
    text: str | None = None
    native_metrics: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)
    item_warnings: list[dict[str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class SourceResult:
    """One adapter outcome: candidates plus a classified source status."""

    adapter_id: str
    adapter_version: str
    source: str
    status: str
    candidates: tuple[SourceCandidate, ...] = ()
    code: str | None = None
    message: str | None = None
    retryable: bool = False
    request: dict[str, Any] = field(default_factory=dict)
    checkpoint_updates: tuple[CheckpointUpdate, ...] = ()

    def __post_init__(self) -> None:
        if type(self.checkpoint_updates) not in {list, tuple}:
            raise SourceStateError("checkpoint_updates must be a list or tuple")
        if len(self.checkpoint_updates) > MAX_CHECKPOINT_UPDATES:
            raise SourceStateError("too many checkpoint updates")
        object.__setattr__(self, "checkpoint_updates", tuple(self.checkpoint_updates))


class Adapter(Protocol):
    adapter_id: str
    adapter_version: str

    def availability_probe(self) -> str:
        """Return ``"ok"`` or a classified failure status for this adapter."""
        ...

    def validate_request(self, request: dict[str, Any]) -> None:
        """Raise :class:`AdapterError` or ``ValueError`` on an invalid request."""
        ...

    def collect(self, source: str, request: dict[str, Any]) -> SourceResult:
        """Collect candidates for ``source`` and classify the outcome."""
        ...


class AcquisitionRuntime:
    def __init__(self, now: Any = None) -> None:
        self._now = now if now is not None else utc_now_iso

    # ---- normalization ----

    @staticmethod
    def normalize_status(status: str, candidates: Any) -> str:
        """``ok`` with zero candidates becomes ``no-results``."""
        if status == "ok" and not candidates:
            return "no-results"
        return status

    @staticmethod
    def canonical_url(url: str) -> str:
        """Lowercase, strip fragment and tracking params, drop trailing slash."""
        if not url:
            return ""
        value = url.strip().lower()
        if "#" in value:
            value = value.split("#", 1)[0]
        if "?" in value:
            base, _, query = value.partition("?")
            kept = [
                pair for pair in query.split("&")
                if pair and pair.split("=", 1)[0] not in _TRACKING_PARAMS
            ]
            value = base + ("?" + "&".join(kept) if kept else "")
        return value.rstrip("/")

    @staticmethod
    def dedupe(candidates: list[SourceCandidate], source: str) -> list[SourceCandidate]:
        """Dedupe by ``(source, native_id)`` first, then by canonical URL.

        The first occurrence wins; both keys are recorded only when present.
        """
        seen_native: set[tuple[str, str]] = set()
        seen_urls: set[str] = set()
        out: list[SourceCandidate] = []
        for candidate in candidates:
            native_key = (source, candidate.native_id) if candidate.native_id else None
            if native_key is not None and native_key in seen_native:
                continue
            url = AcquisitionRuntime.canonical_url(candidate.url)
            if url and url in seen_urls:
                continue
            if native_key is not None:
                seen_native.add(native_key)
            if url:
                seen_urls.add(url)
            out.append(candidate)
        return out

    def normalize_item(self, candidate: SourceCandidate, source: str) -> dict[str, Any]:
        """Convert a :class:`SourceCandidate` into a Signal Batch item."""
        return {
            "candidate_id": f"{source}:{candidate.native_id}",
            "source": source,
            "source_type": candidate.source_type,
            "url": candidate.url,
            "author": candidate.author,
            "published_at": candidate.published_at,
            "date_confidence": candidate.date_confidence,
            "title": candidate.title,
            "text": candidate.text,
            "native_metrics": candidate.native_metrics,
            "provenance": candidate.provenance,
            "fetched_at": candidate.fetched_at,
            "item_warnings": candidate.item_warnings,
        }

    # ---- orchestration ----

    @staticmethod
    def classify_exception(exc: Exception) -> tuple[str, bool]:
        if isinstance(exc, SourceStateError):
            return "schema-drift", False
        if isinstance(exc, AdapterError):
            return exc.status, exc.retryable
        # TimeoutError subclasses OSError; check it first.
        if isinstance(exc, TimeoutError):
            return "timeout", True
        if isinstance(exc, (ConnectionError, OSError)):
            return "unreachable", True
        return "error", False

    @staticmethod
    def invalid_checkpoint_result(
        adapter: Adapter, source: str, request: dict[str, Any],
    ) -> SourceResult:
        return SourceResult(
            adapter.adapter_id,
            adapter.adapter_version,
            source,
            "schema-drift",
            code="invalid-checkpoint-update",
            message="adapter returned invalid checkpoint updates",
            retryable=False,
            request=request,
        )

    def collect_one(
        self,
        adapter: Adapter,
        source: str,
        request: dict[str, Any],
    ) -> SourceResult:
        """Run one adapter/source pair and classify any failure. Never raises."""
        try:
            probe = adapter.availability_probe()
        except Exception as exc:  # noqa: BLE001 - classify and continue
            status, retryable = self.classify_exception(exc)
            return SourceResult(
                adapter.adapter_id, adapter.adapter_version, source, status,
                message=str(exc), retryable=retryable, request=request,
            )
        if probe != "ok":
            return SourceResult(
                adapter.adapter_id, adapter.adapter_version, source, probe, request=request,
            )

        try:
            adapter.validate_request(request)
        except Exception as exc:  # noqa: BLE001
            status, retryable = self.classify_exception(exc)
            return SourceResult(
                adapter.adapter_id, adapter.adapter_version, source, status,
                message=str(exc), retryable=retryable, request=request,
            )

        try:
            result = adapter.collect(source, request)
        except SourceStateError:
            return self.invalid_checkpoint_result(adapter, source, request)
        except Exception as exc:  # noqa: BLE001
            status, retryable = self.classify_exception(exc)
            return SourceResult(
                adapter.adapter_id, adapter.adapter_version, source, status,
                message=str(exc), retryable=retryable, request=request,
            )
        try:
            updates = validate_checkpoint_updates(source, result.checkpoint_updates)
            if updates and result.status not in {"ok", "no-results", "partial"}:
                raise SourceStateError(
                    "only successful source streams may advance checkpoints"
                )
            return replace(result, checkpoint_updates=updates)
        except Exception:  # noqa: BLE001 - adapter state is an untrusted boundary
            return self.invalid_checkpoint_result(adapter, source, request)

    def run(
        self,
        source_specs: list[tuple[Adapter, str]],
        request: dict[str, Any],
        *,
        source_ids: set[str] | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Run independent adapter/source pairs, returning ``{source: batch}``.

        One source failing never blocks another.
        """
        batches: dict[str, dict[str, Any]] = {}
        for adapter, source in source_specs:
            if source_ids is not None and source not in source_ids:
                continue
            result = self.collect_one(adapter, source, request)
            batches[source] = self.build_batch(adapter, source, request, result)
        return batches

    # ---- serialization ----

    def build_batch(
        self,
        adapter: Adapter,
        source: str,
        request: dict[str, Any],
        result: SourceResult,
        *,
        batch_id: str | None = None,
    ) -> dict[str, Any]:
        """Build a contract-validated Signal Batch envelope; never raises."""
        status = self.normalize_status(result.status, result.candidates)
        try:
            items = [
                self.normalize_item(candidate, source)
                for candidate in self.dedupe(list(result.candidates), source)
            ]
            batch = self._envelope(adapter, source, request, status, result, items, batch_id)
            validate_batch(batch)
            return batch
        except SignalBatchError as exc:
            fallback = self._envelope(
                adapter, source, {"mode": "unknown"}, "schema-drift", result, [], batch_id,
            )
            fallback["source_status"]["message"] = str(exc)
            fallback["source_status"]["retryable"] = False
            return fallback

    def _envelope(
        self,
        adapter: Adapter,
        source: str,
        request: dict[str, Any],
        status: str,
        result: SourceResult,
        items: list[dict[str, Any]],
        batch_id: str | None,
    ) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "batch_id": batch_id or uuid.uuid4().hex,
            "generated_at": self._now(),
            "adapter_id": adapter.adapter_id,
            "adapter_version": adapter.adapter_version,
            "source": source,
            "request": request,
            "source_status": {
                "status": status,
                "code": result.code,
                "message": result.message,
                "retryable": result.retryable,
            },
            "items": items,
        }
