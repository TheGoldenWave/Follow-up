import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRun, recordReview, applyRollbacks, updateMigrationState, switchSource, loadMigrationState, saveMigrationState } from '../lib/migration-state.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as migrationMain } from '../migration.js';

test('migration state persists and corrupt history is not silently reset', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'migration.json');
  const initial = await loadMigrationState(path);
  assert.deepEqual(initial.sources, {});
  const state = recordRun(initial, [{ source: 'blog:a', batch_id: '1', generated_at: '2026-09-09T00:00:00Z', source_status: { status: 'ok' } }]);
  await saveMigrationState(path, state);
  assert.deepEqual(await loadMigrationState(path), state);
  await writeFile(path, 'invalid');
  await assert.rejects(loadMigrationState(path));
});

test('recording the same batch is idempotent and retains source observation start', () => {
  const batch = { source: 'blog:test', batch_id: 'b1', generated_at: '2026-09-01T00:00:00Z', source_status: { status: 'ok' } };
  const first = recordRun(undefined, [batch]);
  const second = recordRun(first, [batch]);
  assert.equal(second.sources['blog:test'].runs.length, 1);
  assert.equal(second.sources['blog:test'].input, 'central');
  assert.equal(second.sources['blog:test'].observation_started_at, batch.generated_at);
});

test('source cutover refuses insufficient observation even with a passed report', () => {
  const state = recordRun(undefined, [{ source: 'blog:test', batch_id: 'b1', generated_at: '2026-09-09T00:00:00Z', source_status: { status: 'ok' } }]);
  assert.throws(() => switchSource(state, 'blog:test', { now: '2026-09-09T12:00:00Z', input: 'local', verdict: { passed: true } }), /observation/);
});

test('source rollback changes only the selected source and retains observation history', () => {
  const batches = ['blog:a', 'blog:b'].map(source => ({ source, batch_id: source, generated_at: '2026-09-01T00:00:00Z', source_status: { status: 'ok' } }));
  const state = recordRun(undefined, batches);
  state.sources['blog:a'].input = 'local';
  state.sources['blog:b'].input = 'local';
  const next = switchSource(state, 'blog:a', { input: 'central', now: '2026-09-20T00:00:00Z', rollbackReason: 'duplicates' });
  assert.equal(next.sources['blog:a'].input, 'central');
  assert.equal(next.sources['blog:a'].rollback_reason, 'duplicates');
  assert.equal(next.sources['blog:a'].runs.length, 1);
  assert.equal(next.sources['blog:b'].input, 'local');
  assert.equal(state.sources['blog:a'].input, 'local');
});

test('a caller supplied passed verdict cannot bypass saved evidence', () => {
  const state = recordRun(undefined, [1, 2, 3].map(index => ({
    source: 'blog:a', batch_id: String(index), generated_at: `2026-09-0${index}T00:00:00Z`, source_status: { status: 'ok' },
  })));
  assert.throws(() => switchSource(state, 'blog:a', { input: 'local', now: '2026-09-20T00:00:00Z', verdict: { passed: true } }), /gates|observation/);
});

test('unsafe source IDs and malformed saved routes fail closed', async () => {
  assert.throws(() => recordRun(undefined, [{ source: '__proto__', batch_id: 'x', generated_at: '2026-09-09T00:00:00Z', source_status: { status: 'ok' } }]), /source/);
});

test('reviewed real runs permit cutover, duplicate publication rolls back only source', () => {
  const batches = [1, 2, 3].map(n => ({ source: 'blog:a', batch_id: String(n), generated_at: `2026-09-0${n}T00:00:00Z`, source_status: { status: 'ok' }, items: [{ candidate_id: `blog:a:${n}`, url: `https://example.com/${n}` }] }));
  let state = recordRun(undefined, batches, { checks: { 'blog:a': { contractsOk: true, secretsClean: true } } });
  assert.throws(() => recordReview(state, 'blog:a', { batchId: '3', reviewer: 'person', reviewedAt: '2026-09-04T00:00:00Z', items: [{ candidateId: 'fake', relevant: true }] }), /evidence/);
  state = recordReview(state, 'blog:a', { batchId: '3', reviewer: 'person', reviewedAt: '2026-09-04T00:00:00Z', items: [{ candidateId: 'blog:a:3', relevant: true }] });
  state = switchSource(state, 'blog:a', { input: 'local', now: '2026-09-20T00:00:00Z' });
  assert.equal(state.sources['blog:a'].input, 'local');
  state = recordRun(state, [{ ...batches[2], batch_id: '4', generated_at: '2026-09-21T00:00:00Z', items: [...batches[2].items, ...batches[2].items] }]);
  assert.equal(applyRollbacks(state, { now: '2026-09-21T00:00:00Z' }).sources['blog:a'].rollback_reason, 'duplicates');
});

test('migration transaction refuses concurrent writer and releases lock after failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'migration.json');
  await updateMigrationState(path, async state => {
    await assert.rejects(updateMigrationState(path, next => next), /locked/);
    return state;
  });
  await assert.rejects(updateMigrationState(path, () => { throw new Error('stop'); }), /stop/);
  await updateMigrationState(path, state => state);
});

test('CLI persists review and cutover, rejects unknown samples, reset returns central', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'acquisition', 'migration.json');
  const batches = [1, 2, 3].map(n => ({ source: 'blog:a', batch_id: String(n), generated_at: `2026-09-0${n}T00:00:00Z`, source_status: { status: 'ok' }, items: [{ candidate_id: `blog:a:${n}`, url: `https://e.com/${n}` }] }));
  await saveMigrationState(path, recordRun(undefined, batches, { checks: { 'blog:a': { contractsOk: true, secretsClean: true } } }));
  const options = { userDir: dir, now: '2026-09-20T00:00:00Z', stdout: { write() {} } };
  await assert.rejects(migrationMain({ ...options, argv: ['cutover', 'blog:a'] }), /gates/);
  const reviewPath = join(dir, 'review.json');
  await writeFile(reviewPath, JSON.stringify({ batchId: '3', reviewer: 'reviewer', reviewedAt: options.now, items: [{ candidateId: 'blog:a:3', relevant: true }] }));
  await migrationMain({ ...options, argv: ['review', 'blog:a', reviewPath] });
  await migrationMain({ ...options, argv: ['cutover', 'blog:a'] });
  assert.equal((await loadMigrationState(path)).sources['blog:a'].input, 'local');
  await migrationMain({ ...options, argv: ['reset', 'blog:a'] });
  assert.equal((await loadMigrationState(path)).sources['blog:a'].input, 'central');
});

test('prunes history older than 90 days without stale review authorizing cutover', () => {
  const state = recordRun(undefined, [
    { source: 'blog:a', batch_id: 'old', generated_at: '2026-01-01T00:00:00Z', source_status: { status: 'ok' } },
    { source: 'blog:a', batch_id: 'new', generated_at: '2026-09-09T00:00:00Z', source_status: { status: 'ok' } },
  ]);
  assert.deepEqual(state.sources['blog:a'].runs.map(r => r.batchId), ['new']);
});

test('cutover cannot count archived runs after 90 days without new collection', () => {
  let state = recordRun(undefined, [1, 2, 3].map(n => ({ source: 'blog:a', batch_id: String(n), generated_at: `2026-01-0${n}T00:00:00Z`, source_status: { status: 'ok' }, items: [{ candidate_id: `blog:a:${n}` }] })), { checks: { 'blog:a': { contractsOk: true, secretsClean: true } } });
  state = recordReview(state, 'blog:a', { batchId: '3', reviewer: 'reviewer', reviewedAt: '2026-01-04T00:00:00Z', items: [{ candidateId: 'blog:a:3', relevant: true }] });
  assert.throws(() => switchSource(state, 'blog:a', { input: 'local', now: '2026-09-09T00:00:00Z' }), /gates|observation/);
});

test('saved history must be chronological and routes well typed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'migration.json');
  const state = recordRun(undefined, [1, 2].map(n => ({ source: 'blog:a', batch_id: String(n), generated_at: `2026-09-0${n}T00:00:00Z`, source_status: { status: 'ok' } })));
  state.sources['blog:a'].runs.reverse();
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(loadMigrationState(path), /chronological/);
});

test('failure and unchecked runs do not start the checked-success observation clock', () => {
  let state = recordRun(undefined, [{ source: 'blog:a', batch_id: 'failed', generated_at: '2026-08-01T00:00:00Z', source_status: { status: 'error' } }]);
  state = recordRun(state, [{ source: 'blog:a', batch_id: 'real', generated_at: '2026-09-09T00:00:00Z', source_status: { status: 'ok' } }], { checks: { 'blog:a': { contractsOk: true, secretsClean: true } } });
  assert.equal(state.sources['blog:a'].observation_started_at, '2026-09-09T00:00:00Z');
  assert.throws(() => switchSource(state, 'blog:a', { input: 'local', now: '2026-09-15T00:00:00Z' }), /observation/);
});
