import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readDeliveryOutbox,
  readOutboxAttempt,
  reserveOutboxAttempt,
  resolveOutboxAttempt,
} from '../delivery-outbox.js';
import { readDeliveryLedger } from '../delivery-ledger.js';

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
    receipt: { type: 'telegram', messageIds: [101, 102] },
  }, options);
  const record = await readOutboxAttempt('attempt-1', options);
  assert.equal(record.status, 'delivered');
  assert.deepEqual(record.receipt, { type: 'telegram', messageIds: [101, 102] });
  assert.doesNotMatch(await readFile(join(options.outboxDir, 'attempt-1.json'), 'utf8'), /token|@example\.com/i);
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
