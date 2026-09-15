import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadCheckpointIntent, validateCheckpointIntent } from '../lib/checkpoint-intent.js';

const checkpoint = {
  successful_window_end: '2026-09-15T08:00:00Z', cursor: null,
  etag: null, last_modified: null, recent_native_ids: ['n1'],
  checkpoint_at: '2026-09-15T08:00:00Z',
};

const intent = (overrides = {}) => ({
  schema_version: '1.0', run_id: 'run-1', generated_at: '2026-09-15T08:00:00Z',
  sources: [{ source_id: 'blog:test', batch_id: 'b1', active_stream_ids: ['rss'],
    updates: [{ stream_id: 'rss', previous_checkpoint_at: null, checkpoint }] }],
  ...overrides,
});

const batches = { 'blog:test': { source: 'blog:test', batch_id: 'b1' } };

test('checkpoint intent validates schema and exact batch cross-links', () => {
  assert.deepEqual(validateCheckpointIntent(intent(), { batches, runId: 'run-1' }), { valid: true, errors: [] });
  const wrong = intent({ sources: [{ ...intent().sources[0], batch_id: 'wrong' }] });
  const result = validateCheckpointIntent(wrong, { batches, runId: 'run-1' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('/sources/0/batch_id')));
});

test('checkpoint intent rejects missing extra duplicate and secret-bearing sources', () => {
  for (const value of [
    intent({ sources: [] }),
    intent({ sources: [...intent().sources, { ...intent().sources[0], source_id: 'blog:extra' }] }),
    intent({ sources: [...intent().sources, intent().sources[0]] }),
    intent({ sources: [{ ...intent().sources[0], updates: [{ ...intent().sources[0].updates[0], checkpoint: { ...checkpoint, cursor: 'ghp_' + 'a'.repeat(36) } }] }] }),
    intent({ sources: [{ ...intent().sources[0], updates: [{ ...intent().sources[0].updates[0], checkpoint: { ...checkpoint, cursor: { api_token: 'short' } } }] }] }),
    intent({ sources: [{ batch_id: 'b1', active_stream_ids: [], updates: [] }] }),
  ]) {
    assert.doesNotThrow(() => validateCheckpointIntent(value, { batches, runId: 'run-1' }));
    assert.equal(validateCheckpointIntent(value, { batches, runId: 'run-1' }).valid, false);
  }
});

test('checkpoint intent requires canonical unique active streams and updates', () => {
  const base = intent().sources[0];
  const second = { ...base.updates[0], stream_id: 'second' };
  for (const source of [
    { ...base, active_stream_ids: ['rss', 'alpha'] },
    { ...base, active_stream_ids: ['rss', 'rss'] },
    { ...base, active_stream_ids: ['rss', 'second'], updates: [second, base.updates[0]] },
    { ...base, active_stream_ids: ['rss'], updates: [base.updates[0], base.updates[0]] },
    { ...base, active_stream_ids: ['rss'], updates: [second] },
  ]) {
    assert.equal(validateCheckpointIntent(intent({ sources: [source] }), { batches, runId: 'run-1' }).valid, false);
  }
});

test('loadCheckpointIntent only opens a bounded regular file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'checkpoint-intent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint-intent.json');
  await writeFile(path, JSON.stringify(intent()));
  assert.equal((await loadCheckpointIntent({ path, batches, runId: 'run-1' })).run_id, 'run-1');
  const link = join(dir, 'link.json');
  const { symlink } = await import('node:fs/promises');
  await symlink(path, link);
  await assert.rejects(() => loadCheckpointIntent({ path: link, batches, runId: 'run-1' }), /regular|symlink|unsafe/);
});
