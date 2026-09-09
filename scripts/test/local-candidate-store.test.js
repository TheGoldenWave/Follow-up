import test from 'node:test';
import assert from 'node:assert/strict';
import { updateLocalPool, localInputForRun } from '../lib/local-candidate-store.js';

const candidate = { candidateId: 'a', sourceId: 'blog:a', title: 'Article', firstSeenAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-09-01T00:00:00Z', summarizationContent: 'body' };
const status = { sourceId: 'blog:a', status: 'ok', candidateCount: 1 };
test('local history preserves first discovery across refreshes', () => {
  const first = updateLocalPool(null, { candidates: [candidate], sourceStatuses: [status] }, '2026-09-01T00:00:00Z');
  const next = updateLocalPool(first, { candidates: [{ ...candidate, firstSeenAt: '2026-09-09T00:00:00Z', lastSeenAt: '2026-09-09T00:00:00Z' }], sourceStatuses: [status] }, '2026-09-09T00:00:00Z');
  assert.equal(next.candidates.length, 1);
  assert.equal(next.candidates[0].firstSeenAt, candidate.firstSeenAt);
  assert.equal(next.continuousHistorySince, '2026-09-01T00:00:00.000Z');
});

test('failed source does not replay its retained candidates', () => {
  const pool = updateLocalPool(null, { candidates: [candidate], sourceStatuses: [status] }, '2026-09-01T00:00:00Z');
  const input = localInputForRun(pool, [{ ...status, status: 'error', candidateCount: 0 }]);
  assert.deepEqual(input.candidates, []);
  assert.equal(input.sourceStatuses[0].status, 'error');
});

test('retention removes old metadata and expires unrefreshed text after seven days', () => {
  const old = { schemaVersion: '1.0', continuousHistorySince: '2026-01-01T00:00:00Z', candidates: [
    candidate, { ...candidate, candidateId: 'expired', lastSeenAt: '2026-01-01T00:00:00Z' },
  ] };
  const pool = updateLocalPool(old, { candidates: [], sourceStatuses: [] }, '2026-09-09T00:00:00Z');
  assert.equal(pool.candidates.length, 1);
  assert.equal(pool.candidates[0].summarizationContent, '');
});
