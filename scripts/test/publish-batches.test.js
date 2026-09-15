import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  publishBatchRun,
  publishLatestPointers,
  validateSignalBatch,
} from '../lib/publish-batches.js';

function validBatch(overrides = {}) {
  return {
    schema_version: '1.0',
    batch_id: 'b1',
    generated_at: '2026-09-08T00:00:00.000Z',
    adapter_id: 'rss',
    adapter_version: '0.3.0',
    source: 'blog:test',
    request: { mode: 'shadow' },
    source_status: { status: 'ok', code: null, message: null, retryable: false },
    items: [],
    ...overrides,
  };
}

test('validateSignalBatch accepts a valid batch', () => {
  const result = validateSignalBatch(validBatch());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateSignalBatch rejects a batch missing required fields', () => {
  const { schema_version, ...missing } = validBatch();
  const result = validateSignalBatch(missing);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('schema_version')));
});

test('publishBatchRun atomically publishes a private manifest-valid whole run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-runs-'));
  try {
    await publishBatchRun({ 'blog:test': validBatch() }, { runsDir: dir, runId: 'r1' });
    const files = await readdir(join(dir, 'r1'));
    assert.deepEqual(files.sort(), ['blog:test.json', 'run.json']);
    assert.ok(files.every((name) => !name.includes('.tmp-')));
    const written = JSON.parse(await readFile(join(dir, 'r1', 'blog:test.json'), 'utf8'));
    assert.equal(written.source, 'blog:test');
    assert.equal((await stat(join(dir, 'r1', 'blog:test.json'))).mode & 0o777, 0o600);
    const manifest = JSON.parse(await readFile(join(dir, 'r1', 'run.json'), 'utf8'));
    assert.equal(manifest.run_id, 'r1');
    assert.equal(manifest.sources['blog:test'].batch_id, 'b1');
    const digest = createHash('sha256').update(await readFile(join(dir, 'r1', 'blog:test.json'))).digest('hex');
    assert.equal(manifest.sources['blog:test'].sha256, digest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishBatchRun rejects collision without changing the existing run', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await publishBatchRun({ 'blog:test': validBatch() }, { runsDir: dir, runId: 'r1' });
  await assert.rejects(() => publishBatchRun({ 'blog:test': validBatch() }, { runsDir: dir, runId: 'r1' }), /exists|collision/);
});

test('publishBatchRun cleans unpredictable staging when final rename fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fsImpl = { ...realFs, rename: async () => { throw new Error('rename fault'); } };
  await assert.rejects(() => publishBatchRun({ 'blog:test': validBatch() }, { runsDir: join(dir, 'runs'), runId: 'r1', fsImpl }), /rename fault/);
  assert.equal((await readdir(dir)).some(name => name.startsWith('.runs-staging-')), false);
  await assert.rejects(() => readFile(join(dir, 'runs', 'r1', 'run.json')), { code: 'ENOENT' });
});

test('publishBatchRun rejects a symlinked runs directory before writing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'outside'));
  await symlink(join(dir, 'outside'), join(dir, 'runs'));
  await assert.rejects(() => publishBatchRun({ 'blog:test': validBatch() }, {
    runsDir: join(dir, 'runs'), runId: 'r1',
  }), /unsafe|symlink/);
  assert.deepEqual(await readdir(join(dir, 'outside')), []);
});

test('publishLatestPointers rejects a tampered published batch hash', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const batches = { 'blog:test': validBatch() };
  await publishBatchRun(batches, { runsDir: join(dir, 'runs'), runId: 'r1' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'runs', 'r1', 'blog:test.json'), '{}');
  await assert.rejects(() => publishLatestPointers(batches, {
    runsDir: join(dir, 'runs'), latestDir: join(dir, 'latest'), runId: 'r1',
  }), /hash mismatch/);
});

test('publishBatchRun rejects an invalid batch before writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-runs-'));
  try {
    const { schema_version, ...invalid } = validBatch();
    await assert.rejects(
      () => publishBatchRun({ 'blog:test': invalid }, { runsDir: dir, runId: 'r1' }),
      /is invalid/,
    );
    await assert.rejects(
      () => readdir(join(dir, 'r1')),
      /ENOENT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishBatchRun rejects a source/filename mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-runs-'));
  try {
    await assert.rejects(
      () => publishBatchRun({ 'blog:other': validBatch() }, { runsDir: dir, runId: 'r1' }),
      /does not match filename/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishLatestPointers writes a pointer per source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-latest-'));
  try {
    await publishBatchRun(
      { 'blog:test': validBatch() },
      { runsDir: join(dir, 'runs'), runId: 'r1' },
    );
    await publishLatestPointers(
      { 'blog:test': validBatch() },
      { runsDir: join(dir, 'runs'), latestDir: join(dir, 'latest'), runId: 'r1' },
    );
    const pointer = JSON.parse(await readFile(join(dir, 'latest', 'blog:test.json'), 'utf8'));
    assert.equal(pointer.run_id, 'r1');
    assert.equal(pointer.batch_id, 'b1');
    assert.ok(pointer.path.includes('runs/r1/blog:test.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
