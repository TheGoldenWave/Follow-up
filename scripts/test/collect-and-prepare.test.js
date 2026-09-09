import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config-contract.js';

import { collectAndPrepare, main } from '../collect-and-prepare.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('command enforces onboarding before launching local acquisition', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'follow-entry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.follow-builders'));
  await writeFile(join(home, '.follow-builders/config.json'), JSON.stringify({
    onboardingComplete: false, acquisition: { mode: 'local' },
  }));
  await assert.rejects(promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../collect-and-prepare.js', import.meta.url)), '--request-out', join(home, 'request.json'),
  ], { env: { ...process.env, HOME: home } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /collection-failed: onboarding-required/);
    return true;
  });
});

test('configuration rejects unknown acquisition modes before collection', () => {
  assert.equal(validateConfig({ acquisition: { mode: 'bogus' } }).valid, false);
  for (const mode of ['central', 'shadow', 'hybrid', 'local']) {
    assert.equal(validateConfig({ acquisition: { mode } }).valid, true);
  }
});

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
  assert.equal(calls[0][0], 'run');
  assert.match(calls[0][1], /acquisition\/staging\/2026-09-08T10-00-00-000Z-aaaaaaaa$/);
  assert.equal(calls[1][0], 'publish-run');
  assert.equal(calls[2][0], 'publish-pointers');
});

test('unknown mode is rejected', async () => {
  await assert.rejects(
    () => collectAndPrepare({ config: { acquisition: { mode: 'bogus' } } }),
    /Unknown acquisition mode/,
  );
});

test('central collection hands off to preparation without acquiring', async () => {
  let prepared = false;
  const result = await collectAndPrepare({
    config: { acquisition: { mode: 'central' } },
    prepare: async ({ mode, batches }) => {
      prepared = true;
      assert.equal(mode, 'central');
      assert.deepEqual(batches, {});
      return { status: 'request-ready' };
    },
    invokeRun: async () => { throw new Error('must not collect'); },
  });
  assert.equal(prepared, true);
  assert.equal(result.prepared.status, 'request-ready');
});

test('a failed collection is never prepared as a successful empty local run', async () => {
  let prepared = false;
  await assert.rejects(collectAndPrepare({
    config: { acquisition: { mode: 'local' } },
    invokeRun: async () => { throw new Error('runtime unavailable'); },
    prepare: async () => { prepared = true; },
  }), /runtime unavailable/);
  assert.equal(prepared, false);
});

test('semantic validation failure cannot publish a latest pointer', async () => {
  let published = false;
  await assert.rejects(collectAndPrepare({
    config: { acquisition: { mode: 'local' } },
    invokeRun: async () => {}, loadBatches: async () => ({ 'blog:a': batch('blog:a') }),
    validateBatches: () => { throw new Error('item source mismatch'); },
    publishRun: async () => { published = true; },
    publishPointers: async () => { published = true; },
  }), /item source mismatch/);
  assert.equal(published, false);
});

for (const mode of ['central', 'shadow', 'hybrid', 'local']) {
  test(`${mode} unified entry produces a real curation request`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'entry-e2e-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const userDir = join(home, '.follow-builders');
    await mkdir(userDir);
    await writeFile(join(userDir, 'config.json'), JSON.stringify({ onboardingComplete: true, enabledChannels: ['blogs'], acquisition: { mode } }));
    const local = JSON.parse(await readFile(new URL('../../tests/acquisition/fixtures/signal-batch-valid.json', import.meta.url), 'utf8'));
    const central = JSON.parse(await readFile(new URL('../../feed-candidates.json', import.meta.url), 'utf8'));
    const now = '2026-09-09T12:00:00.000Z';
    central.generatedAt = now;
    let acquired = 0;
    let fetched = 0;
    const errors = [];
    const output = join(home, 'request.json');
    const code = await main({ userDir, now, argv: ['--request-out', output],
      stdout: { write() {} }, stderr: { write(message) { errors.push(message); } },
      invokeRun: async ({ outputDir }) => {
        acquired++;
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, `${local.source}.json`), JSON.stringify(local));
      },
      preparation: { deliveryEvents: [], loadCurationPrompt: async () => 'curate', loadCandidateFeed: async () => {
        fetched++;
        if (mode === 'local') throw new Error('central forbidden');
        return central;
      } },
    });
    assert.equal(code, 0, errors.join(''));
    const request = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(acquired, mode === 'central' ? 0 : 1);
    assert.equal(fetched, mode === 'local' ? 0 : 1);
    assert.equal(request.eligibleCandidates.some(item => item.title === 'Example engineering post'), ['hybrid', 'local'].includes(mode));
  });
}
