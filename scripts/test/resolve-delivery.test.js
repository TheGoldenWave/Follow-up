import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { reserveOutboxAttempt, readOutboxAttempt } from '../delivery-outbox.js';
import { deriveDeliveryState, readDeliveryLedger } from '../delivery-ledger.js';
import { main, resolveUncertainDelivery } from '../resolve-delivery.js';

const id = (value) => createHash('sha256').update(value).digest('hex');

function pending(overrides = {}) {
  return {
    schemaVersion: '1.0', type: 'pending', occurredAt: '2026-09-06T08:00:00.000Z',
    attemptId: 'attempt-old', digestId: 'digest-1', frequency: 'daily',
    candidateIds: [id('candidate')], eventClusterIds: [id('cluster')],
    destinationType: 'email', messageHash: id('message'), ...overrides,
  };
}

async function paths(t) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-resolve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    ledgerPath: join(root, 'state', 'delivery-ledger.jsonl'),
    outboxDir: join(root, 'state', 'delivery-outbox'),
    transactionDir: join(root, 'state', 'delivery-transactions'),
  };
}

test('delivered closes only an unresolved pending with a user-confirmed receipt', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  const result = await resolveUncertainDelivery('attempt-old', 'delivered', {
    ...options, now: () => '2026-09-06T08:01:00.000Z',
  });
  assert.deepEqual(result, {
    status: 'resolved', action: 'delivered', attemptId: 'attempt-old', digestId: 'digest-1',
  });
  const events = await readDeliveryLedger(options);
  assert.deepEqual(events.map(({ type }) => type), ['pending', 'delivered']);
  assert.deepEqual(events[1].providerReceipt, { type: 'user-confirmed' });
  assert.equal((await readOutboxAttempt('attempt-old', options)).status, 'delivered');
  assert.equal(deriveDeliveryState(events).candidateStates.get(id('candidate')), 'pushed-unseen');
});

test('suppress records assumed-delivered without a provider receipt and keeps candidates excluded', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  const result = await resolveUncertainDelivery('attempt-old', 'suppress', {
    ...options, now: () => '2026-09-06T08:01:00.000Z',
  });
  assert.equal(result.action, 'suppress');
  const events = await readDeliveryLedger(options);
  assert.deepEqual(events.map(({ type }) => type), ['pending', 'assumed-delivered']);
  assert.equal(Object.hasOwn(events[1], 'providerReceipt'), false);
  assert.equal((await readOutboxAttempt('attempt-old', options)).status, 'assumed-delivered');
  assert.equal(deriveDeliveryState(events).candidateStates.get(id('candidate')), 'pushed-unseen');
});

test('retry requires explicit duplicate-risk confirmation and changes no state without it', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  await assert.rejects(resolveUncertainDelivery('attempt-old', 'retry', {
    ...options, replacementAttemptId: 'attempt-new',
    now: () => '2026-09-06T08:01:00.000Z',
  }), /confirm-external-retry|duplicate risk/i);
  assert.deepEqual((await readDeliveryLedger(options)).map(({ type }) => type), ['pending']);
});

test('retry atomically supersedes old pending and creates a matching replacement pending', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  const result = await resolveUncertainDelivery('attempt-old', 'retry', {
    ...options, confirmExternalRetry: true, destinationType: 'stdout',
    replacementAttemptId: 'attempt-new', now: () => '2026-09-06T08:01:00.000Z',
  });
  assert.deepEqual(result, {
    status: 'retry-ready', action: 'retry', attemptId: 'attempt-old',
    replacementAttemptId: 'attempt-new', digestId: 'digest-1', destination: 'stdout',
    duplicateRisk: true,
  });
  const events = await readDeliveryLedger(options);
  assert.deepEqual(events.map(({ type }) => type), ['pending', 'superseded', 'pending']);
  for (const field of ['digestId', 'frequency', 'candidateIds', 'eventClusterIds', 'messageHash']) {
    assert.deepEqual(events[2][field], events[0][field]);
  }
  assert.equal(events[2].destinationType, 'stdout');
  assert.equal((await readOutboxAttempt('attempt-old', options)).status, 'superseded');
  assert.equal((await readOutboxAttempt('attempt-new', options)).status, 'pending');
  assert.equal(deriveDeliveryState(events).candidateStates.get(id('candidate')), 'delivery-uncertain');
});

test('resolution rejects missing, terminal, repeated, and corrupt state without appending', async (t) => {
  const options = await paths(t);
  await assert.rejects(resolveUncertainDelivery('missing', 'delivered', options), /not found|pending/i);
  await reserveOutboxAttempt(pending(), options);
  await resolveUncertainDelivery('attempt-old', 'suppress', {
    ...options, now: () => '2026-09-06T08:01:00.000Z',
  });
  const before = await readFile(options.ledgerPath, 'utf8');
  await assert.rejects(resolveUncertainDelivery('attempt-old', 'delivered', options), /already terminal|unresolved pending/i);
  assert.equal(await readFile(options.ledgerPath, 'utf8'), before);
  await writeFile(options.ledgerPath, `${before}{`);
  await assert.rejects(resolveUncertainDelivery('attempt-old', 'delivered', options), /truncated|invalid|newline/i);
});

test('concurrent resolutions permit exactly one terminal append', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  const results = await Promise.allSettled([
    resolveUncertainDelivery('attempt-old', 'delivered', {
      ...options, now: () => '2026-09-06T08:01:00.000Z',
    }),
    resolveUncertainDelivery('attempt-old', 'suppress', {
      ...options, now: () => '2026-09-06T08:01:00.000Z',
    }),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal((await readDeliveryLedger(options)).length, 2);
});

test('no-candidate pending can be resolved without creating candidate state', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending({ candidateIds: [], eventClusterIds: [] }), options);
  await resolveUncertainDelivery('attempt-old', 'suppress', {
    ...options, now: () => '2026-09-06T08:01:00.000Z',
  });
  assert.equal(deriveDeliveryState(await readDeliveryLedger(options)).candidateStates.size, 0);
});

test('CLI is strict, emits machine JSON, and redacts internal diagnostics', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  const stdout = { value: '', write(value) { this.value += value; } };
  const stderr = { value: '', write(value) { this.value += value; } };
  assert.equal(await main({ argv: [], stdout, stderr, ...options }), 64);
  assert.equal(await main({ argv: ['attempt-old', 'retry'], stdout, stderr, ...options }), 64);
  assert.equal(await main({ argv: ['attempt-old', 'wat'], stdout, stderr, ...options }), 64);
  stdout.value = '';
  assert.equal(await main({
    argv: ['attempt-old', 'delivered'], stdout, stderr, ...options,
    now: () => '2026-09-06T08:01:00.000Z',
  }), 0);
  assert.equal(JSON.parse(stdout.value).status, 'resolved');
  assert.doesNotMatch(`${stdout.value}${stderr.value}`, /candidate|messageHash|secret|\/tmp\//i);
});

test('package and SKILL expose the guarded manual resolution workflow', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const skill = await readFile(new URL('../../SKILL.md', import.meta.url), 'utf8');
  assert.equal(packageJson.scripts['resolve-delivery'], 'node resolve-delivery.js');
  assert.match(skill, /\/follow-up resolve-delivery <attempt-id> delivered\|retry\|suppress/);
  assert.match(skill, /retry[^]*--confirm-external-retry[^]*duplicate|retry[^]*--confirm-external-retry[^]*重复/i);
  assert.match(skill, /deliver\.js[^\n]*--resume-attempt <replacement-attempt-id>/);
  assert.match(skill, /retry-ready[^]*停止|retry-ready[^]*stop/i);
  assert.match(skill, /resume[^]*claim[^]*一次|resume[^]*一次性[^]*claim/i);
  assert.match(skill, /delivery-uncertain[^]*resolve-delivery[^]*retry/i);
});
