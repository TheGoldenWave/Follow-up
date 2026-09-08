import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

test('publishBatchRun writes each batch atomically and leaves no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-runs-'));
  try {
    await publishBatchRun({ 'blog:test': validBatch() }, { runsDir: dir, runId: 'r1' });
    const files = await readdir(join(dir, 'r1'));
    assert.deepEqual(files, ['blog:test.json']);
    assert.ok(files.every((name) => !name.includes('.tmp-')));
    const written = JSON.parse(await readFile(join(dir, 'r1', 'blog:test.json'), 'utf8'));
    assert.equal(written.source, 'blog:test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
