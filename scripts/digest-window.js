import { deriveDeliveryState } from './delivery-ledger.js';

const DAY = 24 * 60 * 60 * 1000;
const WEEKLY_BOOTSTRAP_DAYS = 7;
const WEEKLY_MAX_DAYS = 14;

function timestamp(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid timestamp`);
  return parsed;
}

function iso(value) {
  return new Date(value).toISOString();
}

function startOfUtcDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function previousSuccess(deliveryEvents, frequency, endMs) {
  return deriveDeliveryState(deliveryEvents).successfulDeliveries
    .filter((delivery) => delivery.type === 'delivered'
      && delivery.frequency === frequency
      && Date.parse(delivery.deliveredAt) <= endMs)
    .at(-1);
}

export function deriveDigestWindow({
  frequency,
  now = new Date().toISOString(),
  continuousHistorySince,
  deliveryEvents = [],
  enabledSourceIds = [],
  truncation = null,
}) {
  if (!['daily', 'weekly'].includes(frequency)) {
    throw new TypeError('frequency must be daily or weekly');
  }
  const nowMs = timestamp(now, 'now');
  const historyStartMs = timestamp(continuousHistorySince, 'continuousHistorySince');
  const prior = frequency === 'weekly'
    ? previousSuccess(deliveryEvents, frequency, nowMs)
    : null;
  const endInclusive = frequency !== 'weekly' || Boolean(prior);
  const endMs = frequency === 'weekly' && !prior ? startOfUtcDay(nowMs) : nowMs;
  if (historyStartMs > endMs) {
    throw new RangeError('continuousHistorySince must not be later than the coverage end');
  }
  let requestedStartMs;
  const reasons = [];

  if (frequency === 'daily') {
    requestedStartMs = historyStartMs;
  } else if (prior) {
    requestedStartMs = timestamp(prior.deliveredAt, 'previous delivery');
  } else {
    requestedStartMs = endMs - WEEKLY_BOOTSTRAP_DAYS * DAY;
  }

  let actualStartMs = Math.max(requestedStartMs, historyStartMs);
  if (historyStartMs > requestedStartMs) {
    reasons.push('continuous-history-starts-after-requested-interval');
  }
  if (frequency === 'weekly' && prior && endMs - requestedStartMs > WEEKLY_MAX_DAYS * DAY) {
    actualStartMs = Math.max(actualStartMs, endMs - WEEKLY_MAX_DAYS * DAY);
    reasons.push('delivery-gap-exceeds-14-days');
  }

  if (truncation?.oldestRetainedAt && Array.isArray(truncation.affectedSourceIds)) {
    const intersectingRanges = truncation.affectedSourceIds
      .filter((sourceId) => enabledSourceIds.includes(sourceId))
      .map((sourceId) => ({
        oldest: timestamp(
          truncation.oldestRemovedFirstSeenAtBySource?.[sourceId]
            ?? truncation.oldestRetainedFirstSeenAtBySource?.[sourceId]
            ?? truncation.oldestRetainedAt,
          'truncation oldest removed firstSeenAt',
        ),
        newest: timestamp(
          truncation.newestRemovedFirstSeenAtBySource?.[sourceId]
            ?? truncation.oldestRetainedFirstSeenAtBySource?.[sourceId]
            ?? truncation.oldestRetainedAt,
          'truncation newest removed firstSeenAt',
        ),
      }))
      .filter(({ oldest, newest }) => (
        newest >= requestedStartMs
        && (endInclusive ? oldest <= endMs : oldest < endMs)
      ));
    if (intersectingRanges.length > 0) {
      reasons.push('history-truncated');
      actualStartMs = Math.max(
        actualStartMs,
        ...intersectingRanges.map(({ newest }) => newest),
      );
    }
  }
  actualStartMs = Math.min(actualStartMs, endMs);

  return {
    frequency,
    status: reasons.length === 0 ? 'complete' : 'incomplete-history',
    complete: reasons.length === 0,
    requestedInterval: { start: iso(requestedStartMs), end: iso(endMs) },
    actualInterval: { start: iso(actualStartMs), end: iso(endMs) },
    bounds: { startInclusive: true, endInclusive },
    reasons,
  };
}
