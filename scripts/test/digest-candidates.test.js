import assert from 'node:assert/strict';
import test from 'node:test';

import { ENABLED_CHANNELS } from '../config-contract.js';
import { resolveDigestCandidates } from '../digest-candidates.js';

function candidate(candidateId, channel, sourceId, publishedAt) {
  return { candidateId, channel, sourceId, publishedAt, firstSeenAt: publishedAt };
}

function feed(candidates) {
  return {
    generatedAt: '2026-09-10T08:00:00.000Z',
    continuousHistorySince: '2026-09-01T00:00:00.000Z',
    historyTruncated: false,
    truncation: { affectedSourceIds: [], oldestRetainedAt: null, removedCount: 0 },
    registry: [
      { sourceId: 'x:a', channel: 'x', status: 'ok' },
      { sourceId: 'blog:a', channel: 'blogs', status: 'partial' },
    ],
    candidates,
  };
}

function pending(attemptId, candidateIds, overrides = {}) {
  return {
    schemaVersion: '1.0', type: 'pending', occurredAt: '2026-09-08T00:00:00.000Z',
    attemptId, digestId: `digest-${attemptId}`, frequency: 'daily', candidateIds,
    ...overrides,
  };
}

function resolution(type, attemptId) {
  return {
    schemaVersion: '1.0', type, occurredAt: '2026-09-08T00:01:00.000Z', attemptId,
  };
}

test('an empty enabledChannels array returns no-channels without fetching the candidate Feed', async () => {
  let fetched = false;
  const result = await resolveDigestCandidates({
    config: { enabledChannels: [] }, frequency: 'daily', now: '2026-09-10T08:00:00.000Z',
    loadCandidateFeed: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  assert.equal(fetched, false);
  assert.deepEqual(result, {
    status: 'no-channels',
    coverage: null,
    eligibleCandidates: [],
    sourceStatuses: [],
    excluded: { total: 0, counts: {}, reasons: [] },
    ordering: 'candidate-feed-stable',
  });
});

test('missing enabledChannels defaults to all six configured channel categories', async () => {
  const candidates = ENABLED_CHANNELS.map((channel, index) => candidate(
    `candidate-${channel}`, channel,
    channel === 'podcasts' ? 'podcast:a' : channel === 'blogs' ? 'blog:a'
      : channel === 'newsletters' ? 'newsletter:a' : `${channel}:a`,
    `2026-09-0${index + 2}T00:00:00.000Z`,
  ));
  const candidateFeed = feed(candidates);
  candidateFeed.registry = candidates.map(({ sourceId, channel }) => ({ sourceId, channel, status: 'ok' }));
  const result = await resolveDigestCandidates({
    config: {}, frequency: 'daily', now: '2026-09-10T08:00:00.000Z',
    loadCandidateFeed: async () => candidateFeed,
  });
  assert.deepEqual(result.eligibleCandidates.map(({ channel }) => channel), ENABLED_CHANNELS);
});

test('eligibility preserves Feed order and excludes disabled, pending, delivered, and assumed-delivered candidates', async () => {
  const candidates = [
    candidate('eligible-first', 'x', 'x:a', '2026-09-09T02:00:00.000Z'),
    candidate('disabled', 'blogs', 'blog:a', '2026-09-09T03:00:00.000Z'),
    candidate('pending', 'x', 'x:a', '2026-09-09T04:00:00.000Z'),
    candidate('delivered', 'x', 'x:a', '2026-09-09T05:00:00.000Z'),
    candidate('assumed', 'x', 'x:a', '2026-09-09T06:00:00.000Z'),
    candidate('failed', 'x', 'x:a', '2026-09-09T07:00:00.000Z'),
    candidate('eligible-last', 'x', 'x:a', '2026-09-09T08:00:00.000Z'),
  ];
  const deliveryEvents = [
    pending('p', ['pending']),
    pending('d', ['delivered']), resolution('delivered', 'd'),
    pending('a', ['assumed']), resolution('assumed-delivered', 'a'),
    pending('f', ['failed']), resolution('failed', 'f'),
  ];
  const result = await resolveDigestCandidates({
    config: { enabledChannels: ['x'] }, frequency: 'daily',
    now: '2026-09-10T08:00:00.000Z', deliveryEvents,
    loadCandidateFeed: async () => feed(candidates),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.eligibleCandidates.map(({ candidateId }) => candidateId),
    ['eligible-first', 'failed', 'eligible-last'],
  );
  assert.deepEqual(result.excluded.counts, {
    'channel-disabled': 1,
    'delivery-uncertain': 1,
    'pushed-unseen': 2,
  });
  assert.equal(result.ordering, 'candidate-feed-stable');
  assert.deepEqual(result.sourceStatuses, [{ sourceId: 'x:a', channel: 'x', status: 'ok' }]);
});

test('candidates outside the actual interval are excluded and incomplete history remains explicit', async () => {
  const candidateFeed = feed([
    candidate('too-old', 'x', 'x:a', '2026-09-01T00:00:00.000Z'),
    candidate('inside', 'x', 'x:a', '2026-09-08T00:00:00.000Z'),
  ]);
  candidateFeed.continuousHistorySince = '2026-09-03T01:00:00.000Z';
  const result = await resolveDigestCandidates({
    config: { enabledChannels: ['x'] }, frequency: 'weekly',
    now: '2026-09-10T00:00:00.000Z', deliveryEvents: [],
    loadCandidateFeed: async () => candidateFeed,
  });
  assert.equal(result.status, 'incomplete-history');
  assert.deepEqual(
    result.eligibleCandidates.map(({ candidateId }) => candidateId),
    ['inside'],
  );
  assert.equal(result.excluded.counts['outside-coverage'], 1);
});
