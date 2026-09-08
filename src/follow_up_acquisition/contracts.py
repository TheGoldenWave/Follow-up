"""Versioned Signal Batch contract: validation and status taxonomy.

The Python side validates batches with the standard library only, so the
acquisition foundation stays install-free and can be exercised offline. The
canonical machine-readable contract lives in
``contracts/signal-batch.schema.json`` (JSON Schema 2020-12) for the Node.js
consumer; ``SOURCE_STATUSES`` here must stay in sync with that schema.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "1.0"

SOURCE_STATUSES = frozenset({
    "ok",
    "no-results",
    "partial",
    "rate-limited",
    "auth-failed",
    "unreachable",
    "timeout",
    "schema-drift",
    "skipped-unconfigured",
    "error",
})

# Every status that must never be reported as "the source has no updates".
# Only ``no-results`` means the source ran successfully and found nothing.
FAILURE_STATUSES = frozenset({
    "partial",
    "rate-limited",
    "auth-failed",
    "unreachable",
    "timeout",
    "schema-drift",
    "error",
})

DATE_CONFIDENCES = frozenset({"exact", "inferred", "unknown"})

_ENVELOPE_REQUIRED = (
    "schema_version",
    "batch_id",
    "generated_at",
    "adapter_id",
    "adapter_version",
    "source",
    "request",
    "source_status",
    "items",
)

_ITEM_REQUIRED = (
    "candidate_id",
    "source",
    "source_type",
    "url",
    "date_confidence",
    "fetched_at",
)

_ITEM_FIELDS = _ITEM_REQUIRED + (
    "author",
    "published_at",
    "title",
    "text",
    "native_metrics",
    "provenance",
    "item_warnings",
)

_REQUEST_FIELDS = ("mode", "topic", "subject", "window", "depth")

_SOURCE_STATUS_FIELDS = ("status", "code", "message", "retryable")

# Credential-shaped key names rejected anywhere inside a batch. Keys are compared
# case-insensitively after removing ``-`` and ``_``, so ``api-key``, ``api_key``,
# ``apiKey`` and ``API_KEY`` all collide on ``apikey``.
_FORBIDDEN_CREDENTIAL_KEYS = frozenset({
    "authorization",
    "cookie",
    "token",
    "apikey",
    "secret",
    "password",
    "passwd",
    "bearer",
    "credential",
    "qr",
    "qrcode",
    "qrsession",
    "phone",
})


class SignalBatchError(ValueError):
    """Raised when a Signal Batch fails contract validation."""


def _normalize_key(key: str) -> str:
    return key.lower().replace("-", "").replace("_", "")


def _is_credential_key(key: str) -> bool:
    return _normalize_key(key) in _FORBIDDEN_CREDENTIAL_KEYS


def _iter_credential_keys(value: Any, path: str = "$"):
    """Yield ``(path, key)`` for every object key shaped like a credential."""
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if _is_credential_key(key):
                yield child_path, key
            yield from _iter_credential_keys(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_credential_keys(child, f"{path}[{index}]")


def _is_iso_datetime(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _require_non_empty_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise SignalBatchError(f"{label} must be a non-empty string")


def _reject_unknown_fields(fields: set[str], allowed: set[str], label: str) -> None:
    extra = fields - allowed
    if extra:
        raise SignalBatchError(
            f"{label} has unknown field(s): {', '.join(sorted(extra))}"
        )


def _validate_request(request: Any) -> None:
    if not isinstance(request, dict):
        raise SignalBatchError("request must be an object")
    if not isinstance(request.get("mode"), str) or not request["mode"]:
        raise SignalBatchError("request.mode must be a non-empty string")
    _reject_unknown_fields(set(request), set(_REQUEST_FIELDS), "request")
    depth = request.get("depth")
    if depth is not None and (not isinstance(depth, int) or isinstance(depth, bool) or depth < 0):
        raise SignalBatchError("request.depth must be a non-negative integer or null")
    window = request.get("window")
    if window is not None:
        if not isinstance(window, dict):
            raise SignalBatchError("request.window must be an object or null")
        _reject_unknown_fields(set(window), {"start", "end"}, "request.window")
        for field in ("start", "end"):
            value = window.get(field)
            if value is not None and not _is_iso_datetime(value):
                raise SignalBatchError(
                    f"request.window.{field} must be an ISO-8601 date-time string or null"
                )


def _validate_source_status(status: Any) -> None:
    if not isinstance(status, dict):
        raise SignalBatchError("source_status must be an object")
    _reject_unknown_fields(
        set(status), set(_SOURCE_STATUS_FIELDS), "source_status"
    )
    if status.get("status") not in SOURCE_STATUSES:
        raise SignalBatchError(
            "source_status.status must be one of: " + ", ".join(sorted(SOURCE_STATUSES))
        )
    if not isinstance(status.get("retryable"), bool):
        raise SignalBatchError("source_status.retryable must be a boolean")


def _validate_item(item: Any, index: int) -> None:
    if not isinstance(item, dict):
        raise SignalBatchError(f"items[{index}] must be an object")
    for field in _ITEM_REQUIRED:
        if field not in item:
            raise SignalBatchError(f"items[{index}] is missing required field: {field}")
    _reject_unknown_fields(set(item), set(_ITEM_FIELDS), f"items[{index}]")
    for field in ("candidate_id", "source", "source_type", "url"):
        _require_non_empty_string(item[field], f"items[{index}].{field}")
    if item["date_confidence"] not in DATE_CONFIDENCES:
        raise SignalBatchError(
            f"items[{index}].date_confidence must be one of: "
            + ", ".join(sorted(DATE_CONFIDENCES))
        )
    if not _is_iso_datetime(item["fetched_at"]):
        raise SignalBatchError(
            f"items[{index}].fetched_at must be an ISO-8601 date-time string"
        )
    published_at = item.get("published_at")
    if published_at is not None and not _is_iso_datetime(published_at):
        raise SignalBatchError(
            f"items[{index}].published_at must be an ISO-8601 date-time string or null"
        )
    warnings = item.get("item_warnings")
    if warnings is not None:
        if not isinstance(warnings, list):
            raise SignalBatchError(f"items[{index}].item_warnings must be an array")
        for warning in warnings:
            if not isinstance(warning, dict) or "code" not in warning or "message" not in warning:
                raise SignalBatchError(
                    f"items[{index}].item_warnings entries require code and message"
                )


def reject_embedded_credentials(batch: Any) -> None:
    """Reject a batch that embeds any credential-shaped key."""
    hits = list(_iter_credential_keys(batch))
    if hits:
        paths = ", ".join(path for path, _key in hits)
        raise SignalBatchError(f"batch embeds credential-shaped key(s): {paths}")


def validate_batch(batch: Any) -> None:
    """Validate a Signal Batch against schema version ``1.0``.

    Raises :class:`SignalBatchError` with a structured message on the first
    violation; returns ``None`` on success.
    """
    if not isinstance(batch, dict):
        raise SignalBatchError("batch must be an object")

    for field in _ENVELOPE_REQUIRED:
        if field not in batch:
            raise SignalBatchError(f"batch is missing required field: {field}")
    _reject_unknown_fields(set(batch), set(_ENVELOPE_REQUIRED), "batch")

    if batch["schema_version"] != SCHEMA_VERSION:
        raise SignalBatchError(
            f"unsupported schema_version {batch['schema_version']!r} "
            f"(expected {SCHEMA_VERSION!r})"
        )

    for field in ("batch_id", "adapter_id", "adapter_version", "source"):
        _require_non_empty_string(batch[field], field)

    if not _is_iso_datetime(batch["generated_at"]):
        raise SignalBatchError("generated_at must be an ISO-8601 date-time string")

    _validate_request(batch["request"])
    _validate_source_status(batch["source_status"])

    items = batch["items"]
    if not isinstance(items, list):
        raise SignalBatchError("items must be an array")
    for index, item in enumerate(items):
        _validate_item(item, index)

    reject_embedded_credentials(batch)


def load_batch(path: str | Path) -> Any:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def validate_batch_file(path: str | Path) -> dict:
    """Load and validate a Signal Batch JSON file, returning the parsed object."""
    batch = load_batch(path)
    validate_batch(batch)
    return batch
