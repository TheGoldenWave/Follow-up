import test from 'node:test';
import assert from 'node:assert/strict';

import { computeShadowReport } from '../report-shadow.js';

function localBatch(source, items) {
  return {
    schema_version: '1.0',
    batch_id: 'b1',
    generated_at: '2026-09-08T00:00:00.000Z',
    adapter_id: 'rss',
    adapter_version: '0.3.0',
    source,
    request: { mode: 'shadow' },
    source_status: { status: 'ok', retryable: false },
    items,
  };
}

test('reports full overlap and no duplicates for a clean source', () => {
  const batch = localBatch('blog:a', [
    { candidate_id: 'blog:a:1', source: 'blog:a', url: 'https://example.com/x' },
  ]);
  const centralFeed = {
    candidates: [
      { candidateId: 'h1', sourceId: 'blog:a', sourceNativeId: '1', canonicalUrl: 'https://example.com/x' },
    ],
  };
  const report = computeShadowReport({ localBatches: { 'blog:a': batch }, centralFeed });
  assert.equal(report.sources.length, 1);
  assert.equal(report.sources[0].metrics.overlapRate, 1);
  assert.equal(report.sources[0].metrics.duplicateRate, 0);
  assert.equal(report.sources[0].cutover.passed, true);
  assert.equal(report.sources[0].rollback, null);
});

test('reports duplicates and a rollback verdict above 5%', () => {
  const batch = localBatch('blog:a', [
    { candidate_id: 'blog:a:1', source: 'blog:a', url: 'https://example.com/x' },
    { candidate_id: 'blog:a:1', source: 'blog:a', url: 'https://example.com/x' },
  ]);
  const report = computeShadowReport({ localBatches: { 'blog:a': batch }, centralFeed: { candidates: [] } });
  assert.equal(report.sources[0].metrics.duplicateRate, 0.5);
  assert.equal(report.sources[0].cutover.duplicates_absent, false);
  assert.equal(report.sources[0].cutover.passed, false);
  assert.equal(report.sources[0].rollback, 'duplicates');
});

test('reports zero overlap when central has no matching source', () => {
  const batch = localBatch('blog:a', [
    { candidate_id: 'blog:a:1', source: 'blog:a', url: 'https://example.com/x' },
  ]);
  const report = computeShadowReport({ localBatches: { 'blog:a': batch }, centralFeed: { candidates: [] } });
  assert.equal(report.sources[0].metrics.overlapRate, 0);
});

test('reports an empty comparison when there are no local batches', () => {
  const report = computeShadowReport({ localBatches: {}, centralFeed: { candidates: [] } });
  assert.deepEqual(report.sources, []);
});
