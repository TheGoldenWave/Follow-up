import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveDigestWindow } from '../digest-window.js';

const DAY = 24 * 60 * 60 * 1000;

function delivered({ frequency = 'weekly', pendingAt, deliveredAt, attemptId = 'attempt-1' }) {
  return [
    {
      schemaVersion: '1.0', type: 'pending', occurredAt: pendingAt, attemptId,
      digestId: `digest-${attemptId}`, frequency, candidateIds: [], eventClusterIds: [],
      destinationType: 'stdout', messageHash: 'a'.repeat(64),
    },
    {
      schemaVersion: '1.0', type: 'delivered', occurredAt: deliveredAt, attemptId,
      providerReceipt: 'receipt-1',
    },
  ];
}

test('daily coverage always describes the complete retained pool instead of cutting off at prior delivery', () => {
  const now = '2026-09-10T08:00:00.000Z';
  const previous = '2026-09-09T08:03:00.000Z';
  const coverage = deriveDigestWindow({
    frequency: 'daily', now, continuousHistorySince: '2026-09-01T00:00:00.000Z',
    deliveryEvents: delivered({ frequency: 'daily', pendingAt: '2026-09-09T08:00:00.000Z', deliveredAt: previous }),
  });

  assert.equal(coverage.status, 'complete');
  assert.deepEqual(coverage.requestedInterval, {
    start: '2026-09-01T00:00:00.000Z', end: now,
  });
  assert.deepEqual(coverage.actualInterval, coverage.requestedInterval);
});

test('first daily coverage discloses the candidate pool continuous-history interval', () => {
  const coverage = deriveDigestWindow({
    frequency: 'daily', now: '2026-09-10T08:00:00.000Z',
    continuousHistorySince: '2026-09-04T12:00:00.000Z', deliveryEvents: [],
  });
  assert.equal(coverage.status, 'complete');
  assert.deepEqual(coverage.actualInterval, {
    start: '2026-09-04T12:00:00.000Z', end: '2026-09-10T08:00:00.000Z',
  });
});

test('first weekly delivery is incomplete at 6d23h and complete after seven full UTC days', () => {
  const now = '2026-09-08T00:00:00.000Z';
  const short = deriveDigestWindow({
    frequency: 'weekly', now,
    continuousHistorySince: new Date(Date.parse(now) - (7 * DAY) + 60 * 60 * 1000).toISOString(),
    deliveryEvents: [],
  });
  assert.equal(short.status, 'incomplete-history');
  assert.ok(short.reasons.includes('continuous-history-starts-after-requested-interval'));
  assert.equal(short.actualInterval.start, '2026-09-01T01:00:00.000Z');

  const complete = deriveDigestWindow({
    frequency: 'weekly', now,
    continuousHistorySince: new Date(Date.parse(now) - 7 * DAY).toISOString(),
    deliveryEvents: [],
  });
  assert.equal(complete.status, 'complete');
  assert.deepEqual(complete.bounds, { startInclusive: true, endInclusive: false });
  assert.deepEqual(complete.actualInterval, {
    start: '2026-09-01T00:00:00.000Z', end: now,
  });
});

test('weekly coverage starts after the previous success but caps gaps at 14 days', () => {
  const now = '2026-09-30T00:00:00.000Z';
  const previous = '2026-09-10T00:00:00.000Z';
  const coverage = deriveDigestWindow({
    frequency: 'weekly', now, continuousHistorySince: '2026-09-01T00:00:00.000Z',
    deliveryEvents: delivered({ pendingAt: previous, deliveredAt: previous }),
  });

  assert.equal(coverage.status, 'incomplete-history');
  assert.equal(coverage.requestedInterval.start, previous);
  assert.equal(coverage.actualInterval.start, '2026-09-16T00:00:00.000Z');
  assert.ok(coverage.reasons.includes('delivery-gap-exceeds-14-days'));
});

test('weekly coverage after a prior success extends through the current run time', () => {
  const now = '2026-09-10T08:30:00.000Z';
  const previous = '2026-09-03T08:00:00.000Z';
  const coverage = deriveDigestWindow({
    frequency: 'weekly', now, continuousHistorySince: '2026-09-01T00:00:00.000Z',
    deliveryEvents: delivered({ pendingAt: previous, deliveredAt: previous }),
  });
  assert.equal(coverage.status, 'complete');
  assert.deepEqual(coverage.bounds, { startInclusive: true, endInclusive: true });
  assert.deepEqual(coverage.actualInterval, { start: previous, end: now });
});

test('assumed-delivered does not advance the weekly successful-delivery anchor', () => {
  const now = '2026-09-10T00:00:00.000Z';
  const events = delivered({
    pendingAt: '2026-09-08T00:00:00.000Z', deliveredAt: '2026-09-08T00:01:00.000Z',
  });
  events[1] = {
    schemaVersion: '1.0', type: 'assumed-delivered',
    occurredAt: '2026-09-08T00:01:00.000Z', attemptId: 'attempt-1',
  };
  const coverage = deriveDigestWindow({
    frequency: 'weekly', now, continuousHistorySince: '2026-09-01T00:00:00.000Z',
    deliveryEvents: events,
  });
  assert.deepEqual(coverage.requestedInterval, {
    start: '2026-09-03T00:00:00.000Z', end: now,
  });
});

test('truncation only makes coverage incomplete for affected requested sources and intervals', () => {
  const base = {
    frequency: 'daily', now: '2026-09-10T00:00:00.000Z',
    continuousHistorySince: '2026-09-01T00:00:00.000Z', deliveryEvents: [],
    truncation: {
      affectedSourceIds: ['blog:a'], oldestRetainedAt: '2026-09-05T00:00:00.000Z', removedCount: 2,
      oldestRetainedFirstSeenAtBySource: { 'blog:a': '2026-09-05T00:00:00.000Z' },
      oldestRemovedFirstSeenAtBySource: { 'blog:a': '2026-09-04T00:00:00.000Z' },
      newestRemovedFirstSeenAtBySource: { 'blog:a': '2026-09-05T00:00:00.000Z' },
    },
  };
  assert.equal(deriveDigestWindow({ ...base, enabledSourceIds: ['x:a'] }).status, 'complete');
  const affected = deriveDigestWindow({ ...base, enabledSourceIds: ['blog:a'] });
  assert.equal(affected.status, 'incomplete-history');
  assert.ok(affected.reasons.includes('history-truncated'));

  const outside = deriveDigestWindow({
    ...base,
    frequency: 'weekly',
    deliveryEvents: delivered({
      frequency: 'weekly', pendingAt: '2026-09-06T00:00:00.000Z',
      deliveredAt: '2026-09-06T00:00:00.000Z',
    }),
    enabledSourceIds: ['blog:a'],
  });
  assert.equal(outside.status, 'complete');

  const equalBoundary = deriveDigestWindow({
    ...base,
    frequency: 'weekly',
    deliveryEvents: delivered({
      frequency: 'weekly', pendingAt: '2026-09-05T00:00:00.000Z',
      deliveredAt: '2026-09-05T00:00:00.000Z',
    }),
    enabledSourceIds: ['blog:a'],
  });
  assert.equal(equalBoundary.status, 'incomplete-history');
});

test('weekly truncation completeness uses the affected source firstSeenAt boundary', () => {
  const coverage = deriveDigestWindow({
    frequency: 'weekly', now: '2026-09-10T00:00:00.000Z',
    continuousHistorySince: '2026-09-01T00:00:00.000Z', deliveryEvents: [],
    enabledSourceIds: ['blog:a'],
    truncation: {
      affectedSourceIds: ['blog:a'],
      oldestRetainedAt: '2025-01-01T00:00:00.000Z',
      oldestRetainedFirstSeenAtBySource: { 'blog:a': '2026-09-08T00:00:00.000Z' },
      oldestRemovedFirstSeenAtBySource: { 'blog:a': '2026-09-07T00:00:00.000Z' },
      newestRemovedFirstSeenAtBySource: { 'blog:a': '2026-09-08T00:00:00.000Z' },
      removedCount: 1,
    },
  });
  assert.equal(coverage.status, 'incomplete-history');
  assert.equal(coverage.actualInterval.start, '2026-09-08T00:00:00.000Z');
});

test('weekly truncation intersects any removed first-seen point and respects bootstrap half-open end', () => {
  const base = {
    frequency: 'weekly', now: '2026-09-10T08:00:00.000Z',
    continuousHistorySince: '2026-09-01T00:00:00.000Z', deliveryEvents: [],
    enabledSourceIds: ['blog:a'],
  };
  const affected = deriveDigestWindow({
    ...base,
    truncation: {
      affectedSourceIds: ['blog:a'], oldestRetainedAt: '2025-01-01T00:00:00.000Z',
      oldestRemovedFirstSeenAtBySource: { 'blog:a': '2026-09-09T00:00:00.000Z' },
      newestRemovedFirstSeenAtBySource: { 'blog:a': '2026-09-10T08:00:00.000Z' },
      removedCount: 2,
    },
  });
  assert.equal(affected.status, 'incomplete-history');
  assert.deepEqual(affected.actualInterval, {
    start: '2026-09-10T00:00:00.000Z',
    end: '2026-09-10T00:00:00.000Z',
  });

  const atExclusiveEnd = deriveDigestWindow({
    ...base,
    truncation: {
      affectedSourceIds: ['blog:a'], oldestRetainedAt: '2025-01-01T00:00:00.000Z',
      oldestRemovedFirstSeenAtBySource: { 'blog:a': '2026-09-10T00:00:00.000Z' },
      newestRemovedFirstSeenAtBySource: { 'blog:a': '2026-09-10T00:00:00.000Z' },
      removedCount: 1,
    },
  });
  assert.equal(atExclusiveEnd.status, 'complete');
});
