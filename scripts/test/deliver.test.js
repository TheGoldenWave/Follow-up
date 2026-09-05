import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { deliverActiveDigest, main } from '../deliver.js';
import { readDeliveryLedger } from '../delivery-ledger.js';

const id = (value) => createHash('sha256').update(value).digest('hex');

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
    contentStats: { candidateCount: selected.length, eligibleCount: selected.length, excludedCount: 0, selectedCount: selected.length },
    items: selected,
  };
  const candidateIds = selected.map(({ candidateId }) => candidateId);
  const eventClusterIds = selected.map(({ eventClusterId }) => eventClusterId);
  const active = {
    schemaVersion: '1.0', generation, digestId: 'digest-1', requestHash: artifact.requestHash,
    candidateIds, eventClusterIds, artifact: 'artifact.json', message: 'message.txt',
  };
  const manifest = {
    schemaVersion: '1.0', generation, digestId: 'digest-1', requestHash: artifact.requestHash,
    candidateIds, eventClusterIds, artifact: 'artifact.json', message: 'message.txt',
  };
  await writeFile(join(outputDir, 'active.json'), `${JSON.stringify(active)}\n`);
  await writeFile(join(generationDir, 'artifact.json'), `${JSON.stringify(artifact)}\n`);
  await writeFile(join(generationDir, 'message.txt'), status === 'no-important-updates' ? '今日无重要更新\n' : 'digest body\n');
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

test('an empty rendered message is skipped without reserving an attempt', async (t) => {
  const paths = await fixture(t);
  const generationDir = join(paths.activePath.slice(0, -'active.json'.length), 'generations', 'generation-1');
  await writeFile(join(generationDir, 'message.txt'), '   \n');
  const result = await deliverActiveDigest({
    ...paths, destination: { method: 'stdout' }, randomUUID: () => 'unused-attempt',
    providerStdout: { write() { throw new Error('must not write'); } },
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'no-content', digestId: 'digest-1' });
  await assert.rejects(readFile(paths.ledgerPath), /ENOENT/);
});

test('CLI is strict, emits one machine JSON result, and never reserves on local config failure', async (t) => {
  const paths = await fixture(t);
  const stdout = { value: '', write(value) { this.value += value; } };
  const stderr = { value: '', write(value) { this.value += value; } };
  assert.equal(await main({ argv: [], stdout, stderr }), 64);

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
