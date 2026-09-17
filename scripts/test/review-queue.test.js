import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewQueue } from '../lib/review-queue.js';

test('creates a strict review queue without a channel', () => {
  const queue = createReviewQueue([{
    candidateId: 'a'.repeat(64), sourceId: 'community:github', sourceNativeId: '1',
    title: 'Unclassified', canonicalUrl: 'https://example.com/a',
    firstSeenAt: '2026-09-17T00:00:00.000Z', lastSeenAt: '2026-09-17T00:00:00.000Z',
    channel: 'review',
  }], '2026-09-17T00:00:00.000Z');
  assert.deepEqual(queue.candidates[0], {
    candidateId: 'a'.repeat(64), sourceId: 'community:github', sourceNativeId: '1',
    title: 'Unclassified', canonicalUrl: 'https://example.com/a',
    firstSeenAt: '2026-09-17T00:00:00.000Z', lastSeenAt: '2026-09-17T00:00:00.000Z',
    reason: 'unclassified-core-topic',
  });
});
