import test from 'node:test';
import assert from 'node:assert/strict';

import { computeShadowReport, loadLatestBatches } from '../report-shadow.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordRun } from '../lib/migration-state.js';

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
  assert.equal(report.sources[0].cutover.passed, false);
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

test('duplicates match either native identity or canonical URL independently', () => {
  for (const items of [
    [{ candidate_id: 'blog:a:1', url: 'https://e.com/a' }, { candidate_id: 'blog:a:1', url: 'https://e.com/b' }],
    [{ candidate_id: 'blog:a:1', url: 'https://e.com/a?utm_source=x' }, { candidate_id: 'blog:a:2', url: 'https://e.com/a' }],
  ]) {
    const batch = localBatch('blog:a', items);
    assert.equal(computeShadowReport({ localBatches: { 'blog:a': batch } }).sources[0].metrics.duplicateRate, 0.5);
    assert.equal(recordRun(undefined, [batch]).sources['blog:a'].runs[0].duplicateRate, 0.5);
  }
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

test('cutover requires distinct real history and explicit review evidence', () => {
  const batch = localBatch('blog:a', []);
  const history = { 'blog:a': [
    { batchId: 'old1', status: 'ok' },
    { batchId: 'old2', status: 'no-results' },
    { batchId: 'b1', status: 'ok' },
  ] };
  const evidence = { 'blog:a': { relevance: 0.9, contractsOk: true, secretsClean: true } };
  const report = computeShadowReport({ localBatches: { 'blog:a': batch }, centralFeed: { candidates: [] }, history, evidence });
  assert.equal(report.sources[0].metrics.runCount, 3);
  assert.equal(report.sources[0].cutover.passed, false);
});

test('missing latest files do not hide persisted source failures', () => {
  const state = recordRun(undefined, [1, 2].map(n => ({ ...localBatch('blog:a', []), batch_id: String(n), source_status: { status: 'error' } })));
  const report = computeShadowReport({ localBatches: {}, migrationState: state, now: '2026-09-09T00:00:00Z' });
  assert.equal(report.sources.length, 1);
  assert.equal(report.sources[0].rollback, 'consecutive-failures');
});

test('latest pointer cannot escape run storage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'latest'));
  await mkdir(join(dir, 'runs'));
  await writeFile(join(dir, 'outside.json'), '{}');
  await writeFile(join(dir, 'latest', 'blog:a.json'), JSON.stringify({ path: join(dir, 'outside.json') }));
  await assert.rejects(loadLatestBatches(dir), /path/);
});
