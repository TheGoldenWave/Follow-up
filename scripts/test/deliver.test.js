import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { deliverActiveDigest, main } from '../deliver.js';
import { readDeliveryLedger } from '../delivery-ledger.js';
import { renderDigestMessage } from '../finalize-digest.js';

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
  assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).status, 'delivered');
  const ledger = await readDeliveryLedger({
    ledgerPath: join(userDir, 'state', 'delivery-ledger.jsonl'),
  });
  assert.deepEqual(ledger.map(({ type }) => type), ['pending', 'delivered']);
});
