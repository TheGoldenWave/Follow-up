import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config-contract.js';

import { collectAndPrepare, main } from '../collect-and-prepare.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRun, saveMigrationState, loadMigrationState } from '../lib/migration-state.js';

async function writeEmptyIntent(checkpointOut, runId, batches) {
  await writeFile(checkpointOut, JSON.stringify({
    schema_version: '1.0', run_id: runId, generated_at: '2026-09-15T08:00:00Z',
    sources: Object.values(batches).map(value => ({
      source_id: value.source, batch_id: value.batch_id, active_stream_ids: [], updates: [],
    })).sort((left, right) => Buffer.from(left.source_id).compare(Buffer.from(right.source_id))),
  }));
}

test('secret output rolls back a cutover source without persisting leaked text', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'entry-secret-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userDir = join(home, '.follow-builders');
  const acq = join(userDir, 'acquisition');
  await mkdir(acq, { recursive: true });
  await writeFile(join(userDir, 'config.json'), JSON.stringify({ onboardingComplete: true, enabledChannels: ['blogs'], acquisition: { mode: 'local' } }));
  const local = JSON.parse(await readFile(new URL('../../tests/acquisition/fixtures/signal-batch-valid.json', import.meta.url), 'utf8'));
  const state = recordRun(undefined, [local]);
  state.sources[local.source].input = 'local';
  await saveMigrationState(join(acq, 'migration.json'), state);
  local.batch_id = 'unsafe-run';
  local.items[0].text = 'ghp_' + 'a'.repeat(36);
  const code = await main({ userDir, now: '2026-09-09T12:00:00.000Z', argv: ['--request-out', join(home, 'request.json')],
    stdout: { write() {} }, stderr: { write() {} },
    invokeRun: async ({ outputDir, checkpointOut, runId }) => {
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, `${local.source}.json`), JSON.stringify(local));
      await writeEmptyIntent(checkpointOut, runId, { [local.source]: local });
    },
    commitCheckpoints: async () => ({ checkpointStatus: 'committed', report: {} }),
  });
  assert.equal(code, 1);
  const updated = await loadMigrationState(join(acq, 'migration.json'));
  assert.equal(updated.sources[local.source].input, 'central');
  assert.equal(updated.sources[local.source].rollback_reason, 'secret-leak');
  assert.equal(JSON.stringify(updated).includes(local.items[0].text), false);
  assert.equal((await stat(acq)).mode & 0o777, 0o700);
  await assert.rejects(readFile(join(acq, 'latest', `${local.source}.json`)), { code: 'ENOENT' });
});

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
    invokeRun: async ({ outputDir, checkpointOut, runId }) => { calls.push(['run', outputDir, checkpointOut, runId]); },
    loadBatches: async ({ outputDir }) => ({ 'blog:test': batch('blog:test') }),
    loadIntent: async () => ({ run_id: 'run', sources: [] }),
    publishRun: async (batches, opts) => { calls.push(['publish-run', opts.runsDir, opts.runId]); },
    publishPointers: async (batches, opts) => { calls.push(['publish-pointers', opts.latestDir, opts.runId]); },
    commitCheckpoints: async () => { calls.push(['commit']); return { checkpointStatus: 'committed' }; },
  });

  assert.equal(result.collected, true);
  assert.equal(result.mode, 'local');
  assert.equal(result.batchCount, 1);
  assert.equal(result.runId, '2026-09-08T10-00-00-000Z-aaaaaaaa');
  assert.equal(calls[0][0], 'run');
  assert.match(calls[0][1], /acquisition\/staging\/2026-09-08T10-00-00-000Z-aaaaaaaa$/);
  assert.equal(calls[0][2], join(calls[0][1], 'checkpoint-intent.json'));
  assert.equal(calls[0][3], result.runId);
  assert.equal(calls[1][0], 'publish-run');
  assert.equal(calls[2][0], 'publish-pointers');
  assert.equal(calls[3][0], 'commit');
  assert.equal(result.checkpointStatus, 'committed');
});

test('checkpoint commit happens only after run and every pointer publish', async () => {
  const calls = [];
  const common = {
    config: { acquisition: { mode: 'local' } }, userDir: '/tmp/follow-builders',
    invokeRun: async () => calls.push('run'),
    loadBatches: async () => { calls.push('load-batches'); return { 'blog:test': batch('blog:test') }; },
    loadIntent: async () => { calls.push('load-intent'); return { sources: [] }; },
    publishRun: async () => calls.push('publish-run'),
    publishPointers: async () => calls.push('publish-pointers'),
    commitCheckpoints: async () => { calls.push('commit'); return { checkpointStatus: 'committed' }; },
  };
  await collectAndPrepare(common);
  assert.deepEqual(calls, ['run', 'load-batches', 'load-intent', 'publish-run', 'publish-pointers', 'commit']);
  calls.length = 0;
  await assert.rejects(() => collectAndPrepare({ ...common, publishPointers: async () => { calls.push('publish-pointers'); throw new Error('pointer'); } }), /pointer/);
  assert.equal(calls.includes('commit'), false);
});

test('invalid checkpoint intent cannot publish or commit', async () => {
  let published = false;
  let committed = false;
  await assert.rejects(() => collectAndPrepare({
    config: { acquisition: { mode: 'local' } }, userDir: '/tmp/follow-builders',
    invokeRun: async () => {}, loadBatches: async () => ({ 'blog:test': batch('blog:test') }),
    loadIntent: async () => { throw new Error('invalid checkpoint intent'); },
    publishRun: async () => { published = true; }, publishPointers: async () => { published = true; },
    commitCheckpoints: async () => { committed = true; },
  }), /invalid checkpoint intent/);
  assert.equal(published, false);
  assert.equal(committed, false);
});

test('checkpoint conflict preserves published run and continues preparation', async () => {
  let prepared = false;
  const result = await collectAndPrepare({
    config: { acquisition: { mode: 'local' } }, userDir: '/tmp/follow-builders',
    invokeRun: async () => {}, loadBatches: async () => ({ 'blog:test': batch('blog:test') }),
    loadIntent: async () => ({ sources: [] }), publishRun: async () => {}, publishPointers: async () => {},
    commitCheckpoints: async () => ({ checkpointStatus: 'partial', code: 3 }),
    prepare: async () => { prepared = true; return { status: 'request-ready' }; },
  });
  assert.equal(result.checkpointStatus, 'partial');
  assert.equal(prepared, true);
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
    loadIntent: async () => ({ sources: [] }),
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
      invokeRun: async ({ outputDir, checkpointOut, runId }) => {
        acquired++;
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, `${local.source}.json`), JSON.stringify(local));
        await writeEmptyIntent(checkpointOut, runId, { [local.source]: local });
      },
      commitCheckpoints: async () => ({ checkpointStatus: 'committed', report: {} }),
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
