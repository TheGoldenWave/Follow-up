"""Acquisition Runtime: adapter orchestration, normalization, dedupe, serialization.

The runtime is the only component allowed to normalize candidates, assign a
``batch_id``, aggregate a source status, deduplicate across sources, and serialize
Signal Batch envelopes. Adapters return source-native :class:`SourceCandidate`
objects plus one classified :class:`SourceResult`; the runtime turns those into
contract-validated batches.
"""

from __future__ import annotations

import copy
import re
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Iterable, Protocol

from .contracts import SCHEMA_VERSION, SignalBatchError, validate_batch
from .source_state import (
    STATE_SCHEMA_VERSION,
    SourceStateError,
    merge_checkpoint_updates,
    validate_state,
)

_TRACKING_PARAMS = frozenset({
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "mc_eid", "mc_cid",
})


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
    checkpoint: dict[str, Any]


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
        update_list = tuple(updates)
    except TypeError as exc:
        raise SourceStateError("checkpoint updates must be iterable") from exc

    detached: list[CheckpointUpdate] = []
    validation_time = "9999-12-31T23:59:59Z"
    for index, update in enumerate(update_list):
        if not isinstance(update, CheckpointUpdate):
            raise SourceStateError(f"checkpoint_updates[{index}] must be a CheckpointUpdate")
        checkpoint = copy.deepcopy(update.checkpoint)
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
    return tuple(detached)


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
        if isinstance(exc, AdapterError):
            return exc.status, exc.retryable
        # TimeoutError subclasses OSError; check it first.
        if isinstance(exc, TimeoutError):
            return "timeout", True
        if isinstance(exc, (ConnectionError, OSError)):
            return "unreachable", True
        return "error", False

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
        except SourceStateError:
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
