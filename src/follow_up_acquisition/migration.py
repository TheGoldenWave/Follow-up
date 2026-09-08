"""Migration metrics, cutover gates, and rollback for local acquisition.

The metrics compare local Signal Batch runs against the central candidate Feed
per source, and the gate/rollback functions encode the source-level cutover
policy: cutover is blocked until contracts and Fixtures pass, secret scans are
clean, duplicates are absent, run thresholds are met, and reviewed relevance is
at least 80%; a source rolls back on secret leaks, two consecutive unclassified
failures, duplicate rates above 5%, or relevance below 80%.
"""

from __future__ import annotations

from typing import Any, Iterable

FAILURE_STATUSES = frozenset({
    "rate-limited", "auth-failed", "unreachable", "timeout",
    "schema-drift", "skipped-unconfigured", "error",
})
AUTHORITATIVE_STATUSES = frozenset({"ok", "no-results", "partial"})

_TRACKING_PARAMS = frozenset({
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "mc_eid", "mc_cid",
})


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


def native_id_of(candidate_id: str, source: str) -> str:
    """Extract the native id from a Signal Batch ``candidate_id``."""
    prefix = f"{source}:"
    return candidate_id[len(prefix):] if candidate_id.startswith(prefix) else candidate_id


def overlap_rate(local_items: Iterable[dict[str, Any]], central_items: Iterable[dict[str, Any]], source: str) -> float:
    """Fraction of local items also present centrally (native id or URL)."""
    local = list(local_items)
    if not local:
        return 1.0
    central_native = {native_id_of(c["candidate_id"], source) for c in central_items}
    central_urls = {canonical_url(c["url"]) for c in central_items}
    matched = sum(
        1 for item in local
        if native_id_of(item["candidate_id"], source) in central_native
        or canonical_url(item["url"]) in central_urls
    )
    return matched / len(local)


def duplicate_rate(local_items: Iterable[dict[str, Any]], source: str) -> float:
    """Fraction of local items that are duplicates of an earlier item."""
    local = list(local_items)
    if not local:
        return 0.0
    seen: set[tuple[str, str]] = set()
    duplicates = 0
    for item in local:
        key = (native_id_of(item["candidate_id"], source), canonical_url(item["url"]))
        if key in seen:
            duplicates += 1
        seen.add(key)
    return duplicates / len(local)


def classified_error_rate(statuses: Iterable[str]) -> float:
    """Fraction of run statuses classified as a failure."""
    values = list(statuses)
    if not values:
        return 0.0
    return sum(1 for status in values if status in FAILURE_STATUSES) / len(values)


def run_streak(statuses: Iterable[str]) -> int:
    """Number of consecutive authoritative statuses ending the run history."""
    streak = 0
    for status in reversed(list(statuses)):
        if status in AUTHORITATIVE_STATUSES:
            streak += 1
        else:
            break
    return streak


def evaluate_cutover(
    *,
    run_count: int,
    duplicate_rate_value: float,
    relevance: float | None,
    contracts_ok: bool,
    secrets_clean: bool,
) -> dict[str, Any]:
    """Return per-gate results plus an overall ``passed`` boolean."""
    gates = {
        "contracts_ok": bool(contracts_ok),
        "secrets_clean": bool(secrets_clean),
        "duplicates_absent": duplicate_rate_value == 0.0,
        "run_threshold_met": run_count >= 3,
        "relevance_met": relevance is None or relevance >= 0.8,
    }
    gates["passed"] = all(gates.values())
    return gates


def evaluate_rollback(
    *,
    statuses: Iterable[str],
    duplicate_rate_value: float,
    relevance: float | None,
    secrets_leaked: bool = False,
) -> str | None:
    """Return the rollback trigger, or ``None`` when no rollback is required."""
    values = list(statuses)
    if secrets_leaked:
        return "secret-leak"
    if len(values) >= 2 and values[-1] in FAILURE_STATUSES and values[-2] in FAILURE_STATUSES:
        return "consecutive-failures"
    if duplicate_rate_value > 0.05:
        return "duplicates"
    if relevance is not None and relevance < 0.8:
        return "relevance"
    return None
