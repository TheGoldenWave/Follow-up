import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { deliverActiveDigest, main, resumeActiveDigestDelivery } from '../deliver.js';
import { replaceOutboxAttempt, reserveOutboxAttempt } from '../delivery-outbox.js';
import { loadActiveDigest } from '../delivery-message.js';
import { compactDeliveryLedger, readDeliveryLedger } from '../delivery-ledger.js';
import { renderDigestMessage } from '../finalize-digest.js';
import { AtomicWriteCommittedError } from '../prepare-digest.js';

const id = (value) => createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);

async function fixture(t, { status = 'ready', items } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-deliver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generation = 'generation-1';
  const outputDir = join(root, 'digest');
  const generationDir = join(outputDir, 'generations', generation);
  await mkdir(generationDir, { recursive: true });
  const selected = items ?? [{ candidateId: id('candidate'), eventClusterId: id('cluster') }];
  const artifact = {
    schemaVersion: '1.0', status, digestId: 'digest-1', requestHash: id('request'),
    frequency: 'daily', generatedAt: '2026-09-06T08:00:00.000Z',
    coverage: {
      frequency: 'daily', status: 'complete', complete: true,
      requestedInterval: { start: '2026-09-05T00:00:00.000Z', end: '2026-09-06T08:00:00.000Z' },
      actualInterval: { start: '2026-09-05T00:00:00.000Z', end: '2026-09-06T08:00:00.000Z' },
      bounds: { startInclusive: true, endInclusive: true }, reasons: [],
    },
    sourceCompleteness: {
      status: 'complete', complete: true, feedFresh: true, expectedSourceCount: 1,
      reportedSourceCount: 1, totalSourceCount: 1, okSourceCount: 1,
      noResultsSourceCount: 0, partialSourceCount: 0, errorSourceCount: 0,
      missingSourceCount: 0,
    },
    incompleteSources: [],
    contentStats: { candidateCount: selected.length, eligibleCount: selected.length, excludedCount: 0, selectedCount: selected.length },
    items: selected.map((item) => ({
      channel: 'blogs', sourceId: 'blog:test', title: 'Important update', author: 'Author',
      publishedAt: '2026-09-06T07:00:00.000Z', link: 'https://example.com/update',
      scores: { impact: 20, relevance: 20, evidence: 20, novelty: 10, corroboration: 0, totalScore: 70 },
      reason: 'Relevant verified update.', corroborating: [], ...item,
    })),
    message: status === 'no-important-updates' ? '今日无重要更新' : '今日重要更新',
  };
  const artifactText = `${JSON.stringify(artifact)}\n`;
  const message = renderDigestMessage(artifact);
  const candidateIds = artifact.items.map(({ candidateId }) => candidateId);
  const eventClusterIds = artifact.items.map(({ eventClusterId }) => eventClusterId);
  const active = {
    schemaVersion: '1.0', generation, digestId: 'digest-1', requestHash: artifact.requestHash,
    candidateIds, eventClusterIds, artifact: 'artifact.json', message: 'message.txt',
  };
  const manifest = {
    schemaVersion: '1.0', generation, digestId: 'digest-1', requestHash: artifact.requestHash,
    candidateIds, eventClusterIds, artifact: 'artifact.json', message: 'message.txt',
    artifactHash: id(artifactText), messageHash: id(message),
  };
  await writeFile(join(outputDir, 'active.json'), `${JSON.stringify(active)}\n`);
  await writeFile(join(generationDir, 'artifact.json'), artifactText);
  await writeFile(join(generationDir, 'message.txt'), message);
  await writeFile(join(generationDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return {
    activePath: join(outputDir, 'active.json'),
    ledgerPath: join(root, 'state', 'delivery-ledger.jsonl'),
    outboxDir: join(root, 'state', 'delivery-outbox'),
  };
}

test('stdout reservation is durable before the first delivery write', async (t) => {
  const paths = await fixture(t);
  let eventsAtWrite;
  const result = await deliverActiveDigest({
    ...paths, destination: { method: 'stdout' }, randomUUID: () => 'attempt-stdout',
    now: () => '2026-09-06T08:01:00.000Z',
    providerStdout: {
      write: async () => { eventsAtWrite = await readDeliveryLedger(paths); },
    },
  });
  assert.equal(eventsAtWrite[0].type, 'pending');
  assert.equal(result.status, 'delivered');
  const events = await readDeliveryLedger(paths);
  assert.deepEqual(events.map(({ type }) => type), ['pending', 'delivered']);
});

test('explicit provider rejection resolves failed and the same candidate becomes eligible again', async (t) => {
  const paths = await fixture(t);
  const first = await deliverActiveDigest({
    ...paths, destination: { method: 'email', email: 'reader@example.com' },
    credentials: { RESEND_API_KEY: 'test-only-key' }, randomUUID: () => 'attempt-failed',
    now: () => '2026-09-06T08:01:00.000Z',
    transport: async () => ({ ok: false, status: 422, json: async () => ({}) }),
  });
  assert.equal(first.status, 'delivery-failed');
  const second = await deliverActiveDigest({
    ...paths, destination: { method: 'stdout' }, randomUUID: () => 'attempt-retry',
    now: () => '2026-09-06T08:02:00.000Z', providerStdout: { write() {} },
  });
  assert.equal(second.status, 'delivered');
});

test('unknown result remains pending and blocks an automatic duplicate', async (t) => {
  const paths = await fixture(t);
  const first = await deliverActiveDigest({
    ...paths, destination: { method: 'email', email: 'reader@example.com' },
    credentials: { RESEND_API_KEY: 'test-only-key' }, randomUUID: () => 'attempt-uncertain',
    now: () => '2026-09-06T08:01:00.000Z',
    transport: async () => { throw new Error('socket closed'); },
  });
  assert.equal(first.status, 'delivery-uncertain');
  await assert.rejects(deliverActiveDigest({
    ...paths, destination: { method: 'stdout' }, randomUUID: () => 'attempt-duplicate',
    now: () => '2026-09-06T08:02:00.000Z', providerStdout: { write() {} },
  }), /already reserved|conflict/i);
});

test('resume handoff validates the active digest and does not create another reservation', async (t) => {
  const paths = await fixture(t);
  const loaded = await loadActiveDigest(paths.activePath);
  const original = {
    schemaVersion: '1.0', type: 'pending', occurredAt: '2026-06-01T08:00:00.000Z',
    attemptId: 'attempt-old', digestId: 'digest-1', frequency: 'daily',
    candidateIds: [id('candidate')], eventClusterIds: [id('cluster')],
    destinationType: 'stdout', messageHash: id(loaded.message),
  };
  await reserveOutboxAttempt(original, paths);
  await replaceOutboxAttempt('attempt-old', {
    ...original, attemptId: 'attempt-new', occurredAt: '2026-06-01T08:01:00.001Z',
  }, { occurredAt: '2026-06-01T08:01:00.000Z' }, paths);
  await compactDeliveryLedger({
    ...paths, now: '2026-09-30T00:00:00.000Z',
  });
  let reserved = false;
  const result = await resumeActiveDigestDelivery({
    ...paths, activePath: paths.activePath, attemptId: 'attempt-new',
    destination: { method: 'stdout' }, providerStdout: { write() {} },
    reserveAttempt: async () => { reserved = true; }, now: () => '2026-09-30T00:01:00.000Z',
  });
  assert.equal(result.status, 'delivered');
  assert.equal(reserved, false);
  assert.deepEqual((await readDeliveryLedger(paths)).map(({ type }) => type), [
    'pending', 'superseded', 'pending', 'handoff-claimed', 'delivered',
  ]);
});

test('resume rejects a mismatched active digest before provider handoff', async (t) => {
  const paths = await fixture(t);
  const loaded = await loadActiveDigest(paths.activePath);
  await reserveOutboxAttempt({
    schemaVersion: '1.0', type: 'pending', occurredAt: '2026-09-06T08:00:00.000Z',
    attemptId: 'attempt-resume', digestId: 'other-digest', frequency: 'daily',
    candidateIds: loaded.candidateIds, eventClusterIds: loaded.eventClusterIds,
    destinationType: 'stdout', messageHash: id(loaded.message),
  }, paths);
  let wrote = false;
  await assert.rejects(resumeActiveDigestDelivery({
    ...paths, activePath: paths.activePath, attemptId: 'attempt-resume',
    destination: { method: 'stdout' }, providerStdout: { write() { wrote = true; } },
  }), /does not match|digest/i);
  assert.equal(wrote, false);
});

test('resume rejects an original pending that was not created by explicit retry', async (t) => {
  const paths = await fixture(t);
  const loaded = await loadActiveDigest(paths.activePath);
  await reserveOutboxAttempt({
    schemaVersion: '1.0', type: 'pending', occurredAt: '2026-09-06T08:00:00.000Z',
    attemptId: 'attempt-original', digestId: loaded.digestId, frequency: loaded.frequency,
    candidateIds: loaded.candidateIds, eventClusterIds: loaded.eventClusterIds,
    destinationType: 'stdout', messageHash: id(loaded.message),
  }, paths);
  let wrote = false;
  await assert.rejects(resumeActiveDigestDelivery({
    ...paths, activePath: paths.activePath, attemptId: 'attempt-original',
    destination: { method: 'stdout' }, providerStdout: { write() { wrote = true; } },
    now: () => '2026-09-06T08:01:00.000Z',
  }), /replacement|superseded/i);
  assert.equal(wrote, false);
});

test('concurrent resume calls atomically claim one provider handoff', async (t) => {
  const paths = await fixture(t);
  const loaded = await loadActiveDigest(paths.activePath);
  const original = {
    schemaVersion: '1.0', type: 'pending', occurredAt: '2026-09-06T08:00:00.000Z',
    attemptId: 'attempt-old', digestId: loaded.digestId, frequency: loaded.frequency,
    candidateIds: loaded.candidateIds, eventClusterIds: loaded.eventClusterIds,
    destinationType: 'stdout', messageHash: id(loaded.message),
  };
  await reserveOutboxAttempt(original, paths);
  await replaceOutboxAttempt('attempt-old', {
    ...original, attemptId: 'attempt-new', occurredAt: '2026-09-06T08:01:00.001Z',
  }, { occurredAt: '2026-09-06T08:01:00.000Z' }, paths);
  let handoffs = 0;
  const resume = () => resumeActiveDigestDelivery({
    ...paths, activePath: paths.activePath, attemptId: 'attempt-new',
    destination: { method: 'stdout' },
    providerStdout: { write() { handoffs += 1; } },
    now: () => '2026-09-06T08:02:00.000Z',
  });
  const outcomes = await Promise.allSettled([resume(), resume()]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(handoffs, 1);
});

test('uncertain claimed resume cannot repeat but can be explicitly superseded by another retry', async (t) => {
  const paths = await fixture(t);
  const loaded = await loadActiveDigest(paths.activePath);
  const original = {
    schemaVersion: '1.0', type: 'pending', occurredAt: '2026-09-06T08:00:00.000Z',
    attemptId: 'attempt-old', digestId: loaded.digestId, frequency: loaded.frequency,
    candidateIds: loaded.candidateIds, eventClusterIds: loaded.eventClusterIds,
    destinationType: 'stdout', messageHash: id(loaded.message),
  };
  await reserveOutboxAttempt(original, paths);
  await replaceOutboxAttempt('attempt-old', {
    ...original, attemptId: 'attempt-new', occurredAt: '2026-09-06T08:01:00.001Z',
  }, { occurredAt: '2026-09-06T08:01:00.000Z' }, paths);
  const uncertain = await resumeActiveDigestDelivery({
    ...paths, activePath: paths.activePath, attemptId: 'attempt-new',
    destination: { method: 'stdout' }, providerStdout: { write() { throw new Error('crash'); } },
    randomUUID: () => 'claim-first', now: () => '2026-09-06T08:02:00.000Z',
  });
  assert.equal(uncertain.status, 'delivery-uncertain');
  await assert.rejects(resumeActiveDigestDelivery({
    ...paths, activePath: paths.activePath, attemptId: 'attempt-new',
    destination: { method: 'stdout' }, providerStdout: { write() {} },
    randomUUID: () => 'claim-second', now: () => '2026-09-06T08:03:00.000Z',
  }), /claimed|claim/i);
  const retried = await (await import('../resolve-delivery.js')).resolveUncertainDelivery(
    'attempt-new', 'retry', {
      ...paths, confirmExternalRetry: true, replacementAttemptId: 'attempt-newer',
      now: () => '2026-09-06T08:04:00.000Z',
    },
  );
  assert.equal(retried.replacementAttemptId, 'attempt-newer');
  assert.equal((await readDeliveryLedger(paths)).at(-1).attemptId, 'attempt-newer');
});

test('a terminal persistence error after provider confirmation reports delivery-uncertain', async (t) => {
  const paths = await fixture(t);
  const result = await deliverActiveDigest({
    ...paths, destination: { method: 'stdout' }, randomUUID: () => 'attempt-terminal-error',
    now: () => '2026-09-06T08:01:00.000Z', providerStdout: { write() {} },
    resolveAttempt: async () => { throw new Error('disk unavailable'); },
  });
  assert.equal(result.status, 'delivery-uncertain');
  assert.deepEqual((await readDeliveryLedger(paths)).map(({ type }) => type), ['pending']);
});

test('reservation uncertainty never starts provider handoff', async (t) => {
  const paths = await fixture(t);
  let wrote = false;
  const result = await deliverActiveDigest({
    ...paths, destination: { method: 'stdout' }, randomUUID: () => 'attempt-reservation-error',
    providerStdout: { write() { wrote = true; } },
    reserveAttempt: async () => {
      throw Object.assign(new Error('outbox commit failed'), {
        code: 'DELIVERY_RESERVATION_UNCERTAIN',
      });
    },
  });
  assert.deepEqual(result, {
    status: 'delivery-uncertain', reason: 'reservation-uncertain', method: 'stdout',
    attemptId: 'attempt-reservation-error', digestId: 'digest-1',
  });
  assert.equal(wrote, false);
});

test('no-update delivery records an empty-ID run without changing candidate state', async (t) => {
  const paths = await fixture(t, { status: 'no-important-updates', items: [] });
  const result = await deliverActiveDigest({
    ...paths, destination: { method: 'stdout' }, randomUUID: () => 'attempt-empty',
    now: () => '2026-09-06T08:01:00.000Z', providerStdout: { write() {} },
  });
  assert.equal(result.status, 'delivered');
  const [pending] = await readDeliveryLedger(paths);
  assert.deepEqual(pending.candidateIds, []);
  assert.deepEqual(pending.eventClusterIds, []);
});

test('CLI is strict, emits one machine JSON result, and never reserves on local config failure', async (t) => {
  const paths = await fixture(t);
  const stdout = { value: '', write(value) { this.value += value; } };
  const stderr = { value: '', write(value) { this.value += value; } };
  assert.equal(await main({ argv: [], stdout, stderr }), 64);
  assert.equal(await main({ argv: ['--active', paths.activePath, '--destination', 'fax'], stdout, stderr }), 64);

  const configPath = join(dirname(paths.ledgerPath), '..', 'config.json');
  await writeFile(configPath, JSON.stringify({ delivery: { method: 'telegram', chatId: '1' } }));
  stdout.value = '';
  const code = await main({
    argv: ['--active', paths.activePath], stdout, stderr,
    configPath, env: {}, ledgerPath: paths.ledgerPath, outboxDir: paths.outboxDir,
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout.value).status, 'delivery-failed');
  await assert.rejects(readFile(paths.ledgerPath), /ENOENT/);
});

test('SKILL routes every destination through the transaction and forbids automatic fallback', async () => {
  const skill = await readFile(new URL('../../SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /deliver\.js --active .*--destination stdout .*--result-out/);
  assert.match(skill, /deliver\.js --active .*--destination (?:telegram\|email|<stdout\|telegram\|email>)/);
  assert.doesNotMatch(skill, /deliver\.js[^\n]*2>\/dev\/null/);
  assert.doesNotMatch(skill, /show the digest in the terminal as fallback/i);
  assert.match(skill, /delivery-uncertain[^]*不得自动.*fallback|delivery-uncertain[^]*禁止自动.*回退/i);
  assert.match(skill, /exit code[^]*exit 0[^]*result|退出码[^]*exit 0[^]*result/i);
  assert.match(skill, /exit[^]*非零[^]*doctor[^]*停止|nonzero[^]*doctor[^]*stop/i);
});

test('real stdout CLI keeps body visible and writes a parseable delivered result separately', async (t) => {
  const paths = await fixture(t);
  const root = dirname(dirname(paths.ledgerPath));
  const home = join(root, 'home');
  const userDir = join(home, '.follow-builders');
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, 'config.json'), JSON.stringify({ delivery: { method: 'stdout' } }));
  const resultPath = join(root, 'delivery-result.json');
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    fileURLToPath(new URL('../deliver.js', import.meta.url)),
    '--active', paths.activePath, '--destination', 'stdout', '--result-out', resultPath,
  ], { env: { ...process.env, HOME: home } });
  assert.match(stdout, /Important update/);
  assert.equal(stderr, '');
  const machineResult = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.deepEqual(
    (({ status, method, digestId }) => ({ status, method, digestId }))(machineResult),
    { status: 'delivered', method: 'stdout', digestId: 'digest-1' },
  );
  assert.equal(Object.hasOwn(machineResult, 'resultPersistence'), false);
  const ledger = await readDeliveryLedger({
    ledgerPath: join(userDir, 'state', 'delivery-ledger.jsonl'),
  });
  assert.deepEqual(ledger.map(({ type }) => type), ['pending', 'delivered']);
});

async function resultFailureFixture(t, outcome, writeResult) {
  const paths = await fixture(t);
  const configPath = join(dirname(paths.ledgerPath), '..', 'config.json');
  const resultPath = join(dirname(configPath), 'result.json');
  await writeFile(configPath, JSON.stringify({ delivery: { method: 'stdout' } }));
  const stdout = { value: '', write(value) { this.value += value; } };
  const stderr = { value: '', write(value) { this.value += value; } };
  const code = await main({
    argv: [
      '--active', paths.activePath, '--destination', 'stdout', '--result-out', resultPath,
    ],
    configPath, env: {}, stdout, stderr,
    deliverImpl: async () => outcome,
    writeResult,
  });
  return { code, stdout: stdout.value, stderr: stderr.value, resultPath };
}

test('precommit result failure preserves a delivered outcome on the fallback machine channel', async (t) => {
  const outcome = {
    status: 'delivered', method: 'stdout', attemptId: 'attempt-delivered', digestId: 'digest-1',
  };
  const result = await resultFailureFixture(t, outcome, async () => {
    throw new Error('rename failed');
  });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), { ...outcome, resultPersistence: 'failed' });
  assert.doesNotMatch(result.stderr, /delivery-not-started/);
});

test('postcommit result fsync uncertainty preserves committed result and delivery outcome', async (t) => {
  const outcome = {
    status: 'delivered', method: 'stdout', attemptId: 'attempt-committed', digestId: 'digest-1',
  };
  const result = await resultFailureFixture(t, outcome, async (path, document) => {
    await writeFile(path, `${JSON.stringify(document)}\n`);
    throw new AtomicWriteCommittedError('delivery result');
  });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(await readFile(result.resultPath, 'utf8')), outcome);
  assert.deepEqual(JSON.parse(result.stderr), {
    ...outcome, resultPersistence: 'committed-but-uncertain',
  });
});

test('result failure does not rewrite failed or uncertain delivery outcomes', async (t) => {
  for (const status of ['delivery-failed', 'delivery-uncertain']) {
    await t.test(status, async (t) => {
      const outcome = {
        status, method: 'email', attemptId: `attempt-${status}`, digestId: 'digest-1',
      };
      const result = await resultFailureFixture(t, outcome, async () => {
        throw new Error('result unavailable');
      });
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stderr), { ...outcome, resultPersistence: 'failed' });
      assert.doesNotMatch(result.stderr, /delivery-not-started/);
    });
  }
});
