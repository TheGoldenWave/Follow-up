import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  claimReplacementOutboxAttempt,
  readDeliveryOutbox,
  readOutboxAttempt,
  reconcileDeliveryTransactions,
  replaceOutboxAttempt,
  reserveOutboxAttempt,
  resolveOutboxAttempt,
} from '../delivery-outbox.js';
import { deriveDeliveryState, readDeliveryLedger } from '../delivery-ledger.js';

const id = (value) => createHash('sha256').update(value).digest('hex');

function pending(overrides = {}) {
  return {
    schemaVersion: '1.0', type: 'pending', occurredAt: '2026-09-06T08:00:00.000Z',
    attemptId: 'attempt-1', digestId: 'digest-1', frequency: 'daily',
    candidateIds: [id('candidate')], eventClusterIds: [id('cluster')],
    destinationType: 'stdout', messageHash: id('message'), ...overrides,
  };
}

async function paths(t) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-outbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    ledgerPath: join(root, 'state', 'delivery-ledger.jsonl'),
    outboxDir: join(root, 'state', 'delivery-outbox'),
  };
}

test('reservation durably creates ledger pending and a mode-0600 outbox record', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  assert.deepEqual(await readDeliveryLedger(options), [pending()]);
  assert.deepEqual(await readOutboxAttempt('attempt-1', options), {
    schemaVersion: '1.0', status: 'pending', attempt: pending(), updatedAt: pending().occurredAt,
  });
  assert.equal((await lstat(join(options.outboxDir, 'attempt-1.json'))).mode & 0o777, 0o600);
});

test('outbox rejects corrupted records, unsafe identifiers, and symlinked storage', async (t) => {
  const options = await paths(t);
  await mkdir(options.outboxDir, { recursive: true });
  await writeFile(join(options.outboxDir, 'broken.json'), '{');
  await assert.rejects(readOutboxAttempt('broken', options), /invalid.*outbox|JSON/i);
  await assert.rejects(readOutboxAttempt('../escape', options), /attemptId|safe/i);

  const target = join(options.outboxDir, 'target');
  await mkdir(target);
  await symlink(target, join(options.outboxDir, 'linked'));
  await assert.rejects(
    reserveOutboxAttempt(pending({ attemptId: 'linked' }), {
      ...options, outboxDir: join(options.outboxDir, 'linked'),
    }),
    /symbolic link|symlink/i,
  );
});

test('terminal outbox state stores only bounded structured receipts', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending({ destinationType: 'telegram' }), options);
  await resolveOutboxAttempt('attempt-1', {
    status: 'delivered', occurredAt: '2026-09-06T08:01:00.000Z',
    receipt: { type: 'telegram', messageCount: 2, firstMessageId: 101, lastMessageId: 102 },
  }, options);
  const record = await readOutboxAttempt('attempt-1', options);
  assert.equal(record.status, 'delivered');
  assert.deepEqual(record.receipt, {
    type: 'telegram', messageCount: 2, firstMessageId: 101, lastMessageId: 102,
  });
  assert.doesNotMatch(await readFile(join(options.outboxDir, 'attempt-1.json'), 'utf8'), /token|@example\.com/i);
});

test('outbox resolution rejects unknown terminal statuses without appending', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  await assert.rejects(resolveOutboxAttempt('attempt-1', {
    status: 'mystery', occurredAt: '2026-09-06T08:01:00.000Z',
  }, options), /status|resolution/i);
  assert.deepEqual((await readDeliveryLedger(options)).map(({ type }) => type), ['pending']);
});

test('startup outbox index is deterministic and rejects corrupt or symlinked attempts', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending({
    attemptId: 'attempt-b', candidateIds: [id('candidate-b')],
  }), options);
  await reserveOutboxAttempt(pending({
    attemptId: 'attempt-a', candidateIds: [id('candidate-a')],
  }), options);
  assert.deepEqual((await readDeliveryOutbox(options)).map(({ attempt }) => attempt.attemptId), [
    'attempt-a', 'attempt-b',
  ]);
  await writeFile(join(options.outboxDir, 'corrupt.json'), '{');
  await assert.rejects(readDeliveryOutbox(options), /invalid.*outbox|corrupt/i);
  await rm(join(options.outboxDir, 'corrupt.json'));
  await symlink(join(options.outboxDir, 'attempt-a.json'), join(options.outboxDir, 'linked.json'));
  await assert.rejects(readDeliveryOutbox(options), /symbolic link|symlink|invalid.*outbox/i);
});

test('reconcile restores a pending outbox after a crash following ledger append', async (t) => {
  const options = await paths(t);
  let failed = false;
  const fsImpl = {
    ...(await import('node:fs/promises')),
    async rename(from, to) {
      if (!failed && from.includes('.delivery-outbox-') && to.endsWith('attempt-crash.json')) {
        failed = true;
        throw new Error('simulated crash after ledger append');
      }
      return (await import('node:fs/promises')).rename(from, to);
    },
  };
  await assert.rejects(reserveOutboxAttempt(pending({ attemptId: 'attempt-crash' }), {
    ...options, fsImpl, randomUUID: () => 'reservation-crash',
  }), (error) => error.code === 'DELIVERY_RESERVATION_UNCERTAIN');
  assert.equal((await readDeliveryLedger(options)).length, 1);
  await reconcileDeliveryTransactions(options);
  assert.equal((await readOutboxAttempt('attempt-crash', options)).status, 'pending');
});

test('reconcile makes terminal outbox state agree with the authoritative ledger', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending({ attemptId: 'attempt-terminal' }), options);
  let failed = false;
  const fsImpl = {
    ...(await import('node:fs/promises')),
    async rename(from, to) {
      if (!failed && from.includes('.delivery-outbox-') && to.endsWith('attempt-terminal.json')) {
        failed = true;
        throw new Error('simulated terminal crash');
      }
      return (await import('node:fs/promises')).rename(from, to);
    },
  };
  await assert.rejects(resolveOutboxAttempt('attempt-terminal', {
    status: 'delivered', occurredAt: '2026-09-06T08:01:00.000Z',
    receipt: { type: 'stdout' },
  }, { ...options, fsImpl, randomUUID: () => 'terminal-crash' }), /simulated terminal crash/);
  await reconcileDeliveryTransactions(options);
  assert.equal((await readOutboxAttempt('attempt-terminal', options)).status, 'delivered');
});

test('reconcile safely removes owned orphan temporary files but rejects unknown entries', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending(), options);
  await writeFile(join(options.outboxDir, '.delivery-outbox-attempt-orphan-token.tmp'), 'partial');
  const journalDir = join(dirname(options.outboxDir), 'delivery-transactions');
  await mkdir(journalDir, { recursive: true });
  await writeFile(join(journalDir, '.delivery-journal-attempt-orphan-token.tmp'), 'partial');
  assert.equal((await readDeliveryOutbox(options)).length, 1);
  await writeFile(join(options.outboxDir, 'unknown.tmp'), 'unknown');
  await assert.rejects(readDeliveryOutbox(options), /unknown|invalid.*entry/i);
});

function appendingJournal(event, phase = 'appending') {
  const eventBytes = `${JSON.stringify(event)}\n`;
  return {
    schemaVersion: '1.0', phase, operation: 'reservation', attemptId: event.attemptId,
    event, record: {
      schemaVersion: '1.0', status: 'pending', attempt: event, updatedAt: event.occurredAt,
    },
    preAppendOffset: 0,
    eventBytes: Buffer.from(eventBytes).toString('base64'),
    eventHash: id(eventBytes),
  };
}

test('restart repairs a partial ledger append from the appending journal before JSONL parsing', async (t) => {
  const options = await paths(t);
  const event = pending({ attemptId: 'attempt-partial' });
  const serialized = `${JSON.stringify(event)}\n`;
  const transactionDir = join(dirname(options.outboxDir), 'delivery-transactions');
  await mkdir(transactionDir, { recursive: true });
  await mkdir(dirname(options.ledgerPath), { recursive: true });
  await writeFile(options.ledgerPath, serialized.slice(0, 37));
  await writeFile(join(transactionDir, `${event.attemptId}.json`), `${JSON.stringify(appendingJournal(event))}\n`);

  assert.deepEqual(await readDeliveryLedger(options), [event]);
  assert.equal(await readFile(options.ledgerPath, 'utf8'), serialized);
  assert.equal((await readOutboxAttempt(event.attemptId, options)).status, 'pending');
});

test('restart accepts a fully written event after sync failure without duplicating it', async (t) => {
  const options = await paths(t);
  const event = pending({ attemptId: 'attempt-full-sync' });
  const serialized = `${JSON.stringify(event)}\n`;
  const transactionDir = join(dirname(options.outboxDir), 'delivery-transactions');
  await mkdir(transactionDir, { recursive: true });
  await mkdir(dirname(options.ledgerPath), { recursive: true });
  await writeFile(options.ledgerPath, serialized);
  await writeFile(join(transactionDir, `${event.attemptId}.json`), `${JSON.stringify(appendingJournal(event))}\n`);

  assert.deepEqual(await readDeliveryLedger(options), [event]);
  assert.equal(await readFile(options.ledgerPath, 'utf8'), serialized);
  assert.equal((await readOutboxAttempt(event.attemptId, options)).status, 'pending');
});

test('reservation reports uncertain and recovers after partial write or full write sync failure', async (t) => {
  for (const [name, bytesToWrite] of [['partial', 41], ['full-sync', Infinity]]) {
    await t.test(name, async (t) => {
      const options = await paths(t);
      const event = pending({ attemptId: `attempt-${name}` });
      await assert.rejects(reserveOutboxAttempt(event, {
        ...options,
        appendLedgerImpl: async ({ ledgerPath, bytes, preAppendOffset }) => {
          const handle = await open(ledgerPath, 'r+');
          try {
            const portion = bytes.subarray(0, Math.min(bytes.length, bytesToWrite));
            await handle.write(portion, 0, portion.length, preAppendOffset);
          } finally {
            await handle.close();
          }
          throw new Error(name === 'partial' ? 'partial write' : 'sync failed');
        },
      }), (error) => error.code === 'DELIVERY_RESERVATION_UNCERTAIN');
      assert.deepEqual(await readDeliveryLedger(options), [event]);
      assert.equal((await readOutboxAttempt(event.attemptId, options)).status, 'pending');
    });
  }
});

test('retry transaction recovers both superseded and replacement outbox records after a crash', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending({ attemptId: 'attempt-old' }), options);
  let failed = false;
  const fsImpl = {
    ...(await import('node:fs/promises')),
    async rename(from, to) {
      if (!failed && from.includes('.delivery-outbox-') && to.endsWith('attempt-new.json')) {
        failed = true;
        throw new Error('simulated replacement outbox crash');
      }
      return (await import('node:fs/promises')).rename(from, to);
    },
  };
  await assert.rejects(replaceOutboxAttempt('attempt-old', pending({
    attemptId: 'attempt-new', occurredAt: '2026-09-06T08:01:00.001Z',
    destinationType: 'stdout',
  }), {
    occurredAt: '2026-09-06T08:01:00.000Z',
  }, { ...options, fsImpl, randomUUID: () => 'retry-crash' }), /simulated replacement outbox crash/);
  await reconcileDeliveryTransactions(options);
  assert.equal((await readOutboxAttempt('attempt-old', options)).status, 'superseded');
  assert.equal((await readOutboxAttempt('attempt-new', options)).status, 'pending');
  assert.deepEqual((await readDeliveryLedger(options)).map(({ type }) => type), [
    'pending', 'superseded', 'pending',
  ]);
});

test('handoff claim is append-only, recoverable, and only valid for an unclaimed replacement', async (t) => {
  const options = await paths(t);
  await reserveOutboxAttempt(pending({ attemptId: 'attempt-old' }), options);
  await assert.rejects(claimReplacementOutboxAttempt('attempt-old', {
    occurredAt: '2026-09-06T08:00:30.000Z', claimId: 'claim-original',
  }, options), /replacement|superseded/i);
  const replacement = pending({
    attemptId: 'attempt-new', occurredAt: '2026-09-06T08:01:00.001Z',
  });
  await replaceOutboxAttempt('attempt-old', replacement, {
    occurredAt: '2026-09-06T08:01:00.000Z',
  }, options);
  await claimReplacementOutboxAttempt('attempt-new', {
    occurredAt: '2026-09-06T08:02:00.000Z', claimId: 'claim-1',
  }, options);
  assert.deepEqual((await readDeliveryLedger(options)).map(({ type }) => type), [
    'pending', 'superseded', 'pending', 'handoff-claimed',
  ]);
  assert.equal(
    deriveDeliveryState(await readDeliveryLedger(options)).candidateStates.get(id('candidate')),
    'delivery-uncertain',
  );
  await writeFile(join(options.outboxDir, 'attempt-new.json'), `${JSON.stringify({
    schemaVersion: '1.0', status: 'pending', attempt: replacement,
    updatedAt: replacement.occurredAt,
  })}\n`);
  assert.deepEqual(
    (({ status, claimId, handoffClaimedAt }) => ({ status, claimId, handoffClaimedAt }))(
      await readOutboxAttempt('attempt-new', options),
    ),
    {
      status: 'pending', claimId: 'claim-1',
      handoffClaimedAt: '2026-09-06T08:02:00.000Z',
    },
  );
  await assert.rejects(claimReplacementOutboxAttempt('attempt-new', {
    occurredAt: '2026-09-06T08:03:00.000Z', claimId: 'claim-2',
  }, options), /claimed|claim/i);
});

test('claim reports uncertainty after append starts and reconcile preserves the claim', async (t) => {
  const options = await paths(t);
  const original = pending({ attemptId: 'claim-old' });
  const replacement = pending({
    attemptId: 'claim-new', occurredAt: '2026-09-06T08:01:00.001Z',
  });
  await reserveOutboxAttempt(original, options);
  await replaceOutboxAttempt('claim-old', replacement, {
    occurredAt: '2026-09-06T08:01:00.000Z',
  }, options);
  await assert.rejects(claimReplacementOutboxAttempt('claim-new', {
    occurredAt: '2026-09-06T08:02:00.000Z', claimId: 'claim-uncertain',
  }, {
    ...options,
    appendLedgerImpl: async ({ ledgerPath, bytes, preAppendOffset }) => {
      const handle = await open(ledgerPath, 'r+');
      try { await handle.write(bytes.subarray(0, 10), 0, 10, preAppendOffset); }
      finally { await handle.close(); }
      throw new Error('claim append interrupted');
    },
  }), (error) => error.code === 'DELIVERY_CLAIM_UNCERTAIN' && error.attemptId === 'claim-new');
  assert.equal((await readOutboxAttempt('claim-new', options)).claimId, 'claim-uncertain');
});
