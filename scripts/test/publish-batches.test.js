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

function injectedWriteFs(stage, runsDir) {
  let batchWrites = 0;
  return { ...realFs, open: async (path, flags, mode) => {
    const handle = await realFs.open(path, flags, mode);
    const name = String(path);
    const isManifest = name.endsWith('/run.json');
    const isBatch = name.endsWith('.json') && !isManifest;
    const isStagingDir = name.includes('/.runs-staging-') && flags === 'r';
    const isRunsDir = name === runsDir && flags === 'r';
    return {
      writeFile: async payload => {
        if (isBatch) batchWrites += 1;
        if (stage === 'batch-write' && isBatch && batchWrites === 1) {
          await handle.writeFile(payload.subarray(0, 5));
          throw new Error('injected batch write');
        }
        if (stage === 'mid-run-write' && isBatch && batchWrites === 2) throw new Error('injected mid run');
        if (stage === 'manifest-write' && isManifest) throw new Error('injected manifest write');
        return handle.writeFile(payload);
      },
      sync: async () => {
        if (stage === 'batch-fsync' && isBatch) throw new Error('injected batch fsync');
        if (stage === 'manifest-fsync' && isManifest) throw new Error('injected manifest fsync');
        if (stage === 'staging-dir-fsync' && isStagingDir) throw new Error('injected staging fsync');
        if (stage === 'runs-dir-fsync' && isRunsDir) throw new Error('injected runs fsync');
        return handle.sync();
      },
      close: () => handle.close(),
    };
  } };
}

test('publishBatchRun fault matrix never exposes pre-rename partial runs', async (t) => {
  for (const stage of ['batch-write', 'batch-fsync', 'mid-run-write', 'manifest-write', 'manifest-fsync', 'staging-dir-fsync']) {
    const dir = await mkdtemp(join(tmpdir(), `publish-${stage}-`));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const runsDir = join(dir, 'runs');
    const batches = {
      'blog:a': validBatch({ source: 'blog:a', batch_id: 'a' }),
      'blog:b': validBatch({ source: 'blog:b', batch_id: 'b' }),
    };
    await assert.rejects(() => publishBatchRun(batches, {
      runsDir, runId: 'r1', fsImpl: injectedWriteFs(stage, runsDir),
    }));
    await assert.rejects(() => readFile(join(runsDir, 'r1', 'run.json')), { code: 'ENOENT' });
    assert.equal((await readdir(dir)).some(name => name.startsWith('.runs-staging-')), false);
  }
});

test('runs directory fsync uncertainty preserves complete run but is not publish-success', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'publish-runs-fsync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, 'runs');
  await assert.rejects(() => publishBatchRun({ 'blog:test': validBatch() }, {
    runsDir, runId: 'r1', fsImpl: injectedWriteFs('runs-dir-fsync', runsDir),
  }), error => error.code === 'run-durability-uncertain');
  assert.equal(JSON.parse(await readFile(join(runsDir, 'r1', 'run.json'), 'utf8')).run_id, 'r1');
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
