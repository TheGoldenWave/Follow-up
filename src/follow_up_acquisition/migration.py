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
from datetime import datetime, timedelta, timezone
import re
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

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
    try:
        parts = urlsplit(url.strip())
        if parts.scheme.lower() not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            return ""
        tracking = re.compile(r"^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|vero_id|_hsenc|_hsmi)$", re.I)
        query = sorted(((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not tracking.match(k)), key=lambda pair: pair[0])
        host = parts.hostname.lower()
        if ':' in host:
            host = f'[{host}]'
        if parts.port and (parts.scheme.lower(), parts.port) not in {('http', 80), ('https', 443)}:
            host += f':{parts.port}'
        return urlunsplit((parts.scheme.lower(), host, parts.path.rstrip('/') or '/', urlencode(query), ''))
    except (ValueError, TypeError):
        return ""


def native_id_of(candidate_id: str, source: str) -> str:
    """Extract the native id from a Signal Batch ``candidate_id``."""
    prefix = f"{source}:"
    return candidate_id[len(prefix):] if candidate_id.startswith(prefix) else candidate_id


def overlap_rate(local_items: Iterable[dict[str, Any]], central_items: Iterable[dict[str, Any]], source: str) -> float:
    """Fraction of local items also present centrally (native id or URL)."""
    local = list(local_items)
    if not local:
        return 1.0
    central = list(central_items)
    central_native = {c.get('sourceNativeId') or native_id_of(c.get("candidate_id", ""), source) for c in central}
    central_urls = {canonical_url(c.get('canonicalUrl') or c.get("url", "")) for c in central}
    central_native.discard('')
    central_urls.discard('')
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
    natives: set[str] = set()
    urls: set[str] = set()
    duplicates = 0
    for item in local:
        native = native_id_of(item.get("candidate_id", ""), source)
        url = canonical_url(item.get("url", ""))
        if (native and native in natives) or (url and url in urls):
            duplicates += 1
        if native:
            natives.add(native)
        if url:
            urls.add(url)
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
    """Low-level metric predicate only; source_verdict authorizes persisted evidence."""
    gates = {
        "contracts_ok": bool(contracts_ok),
        "secrets_clean": bool(secrets_clean),
        "duplicates_absent": duplicate_rate_value == 0.0,
        "run_threshold_met": run_count >= 3,
        "relevance_met": relevance is not None and 0.8 <= relevance <= 1.0,
    }
    gates["passed"] = all(gates.values())
    return gates


def source_verdict(source: dict[str, Any], now: str) -> dict[str, Any]:
    """Operational gate/rollback parity with Node's sourceVerdict on saved state.

    Unknown, malformed, stale or future evidence fails closed. This function
    does not write state; the Node migration CLI owns route transactions.
    """
    def timestamp(value: str) -> datetime:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('timezone required')
        return parsed.astimezone(timezone.utc)

    gates = {key: False for key in ('observation_complete', 'run_threshold_met', 'duplicates_absent', 'relevance_met', 'contracts_ok', 'secrets_clean')}
    relevance = None
    rollback = None
    try:
        clock = timestamp(now)
        all_runs = source['runs']
        ids = [run['batchId'] for run in all_runs]
        if len(ids) != len(set(ids)):
            raise ValueError('duplicate batch history')
        times = [timestamp(run['generatedAt']) for run in all_runs]
        if times != sorted(times):
            raise ValueError('unordered history')
        runs = [run for run in all_runs if clock - timedelta(days=90) <= timestamp(run['generatedAt']) <= clock]
        latest = runs[-1] if runs else {}
        checked = [run for run in runs if run['status'] in AUTHORITATIVE_STATUSES and run.get('contractsOk') is True and run.get('secretsClean') is True and run.get('secretsLeaked') is not True]
        review = source.get('review')
        if review and review['batchId'] == latest.get('batchId') and timestamp(latest['generatedAt']) <= timestamp(review['reviewedAt']) <= clock:
            items = review['items']
            sample_ids = [item['candidateId'] for item in items]
            if (isinstance(review.get('reviewer'), str) and review['reviewer'].strip() and items and len(set(sample_ids)) == len(sample_ids) and all(item['candidateId'] in latest.get('candidateIds', []) and type(item['relevant']) is bool for item in items)):
                relevance = sum(item['relevant'] for item in items) / len(items)
        gates.update({
            'observation_complete': bool(checked) and clock >= timestamp(source['observation_until']),
            'run_threshold_met': len(checked) >= 3,
            'duplicates_absent': latest.get('duplicateRate') == 0,
            'relevance_met': relevance is not None and relevance >= 0.8,
            'contracts_ok': latest.get('status') in AUTHORITATIVE_STATUSES and latest.get('contractsOk') is True,
            'secrets_clean': latest.get('secretsClean') is True and not latest.get('secretsLeaked'),
        })
        rollback = evaluate_rollback(statuses=[run['status'] for run in runs], duplicate_rate_value=latest.get('duplicateRate', 0), relevance=relevance, secrets_leaked=latest.get('secretsLeaked') is True)
    except (KeyError, ValueError, TypeError, AttributeError):
        gates = {key: False for key in gates}
    gates['passed'] = all(gates.values())
    return {'cutover': gates, 'rollback': rollback, 'relevance': relevance}


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
