import test from 'node:test';
import assert from 'node:assert/strict';

import { collectAndPrepare } from '../collect-and-prepare.js';

const batch = (sourceId) => ({
  schema_version: '1.0',
  batch_id: 'b1',
  generated_at: '2026-09-08T00:00:00.000Z',
  adapter_id: 'rss',
  adapter_version: '0.3.0',
  source: sourceId,
  request: { mode: 'shadow' },
  source_status: { status: 'ok', retryable: false },
  items: [],
});

test('central mode skips local collection entirely', async () => {
  let invoked = false;
  const result = await collectAndPrepare({
    config: { acquisition: { mode: 'central' } },
    invokeRun: async () => { invoked = true; },
    loadBatches: async () => { throw new Error('should not load'); },
  });
  assert.equal(result.collected, false);
  assert.equal(invoked, false);
});

test('local mode invokes acquisition and publishes atomically', async () => {
  const calls = [];
  const result = await collectAndPrepare({
    config: { acquisition: { mode: 'local' } },
    now: '2026-09-08T10:00:00.000Z',
    randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userDir: '/tmp/follow-builders',
    invokeRun: async ({ outputDir }) => { calls.push(['run', outputDir]); },
    loadBatches: async ({ outputDir }) => ({ 'blog:test': batch('blog:test') }),
    publishRun: async (batches, opts) => { calls.push(['publish-run', opts.runsDir, opts.runId]); },
    publishPointers: async (batches, opts) => { calls.push(['publish-pointers', opts.latestDir, opts.runId]); },
  });

  assert.equal(result.collected, true);
  assert.equal(result.mode, 'local');
  assert.equal(result.batchCount, 1);
  assert.equal(result.runId, '2026-09-08T10-00-00-000Z-aaaaaaaa');
  assert.deepEqual(calls[0], ['run', '/tmp/follow-builders/acquisition']);
  assert.equal(calls[1][0], 'publish-run');
  assert.equal(calls[2][0], 'publish-pointers');
});

test('unknown mode is rejected', async () => {
  await assert.rejects(
    () => collectAndPrepare({ config: { acquisition: { mode: 'bogus' } } }),
    /Unknown acquisition mode/,
  );
});
