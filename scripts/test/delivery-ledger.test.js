import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  MIN_LEDGER_RETENTION_DAYS,
  appendDeliveryEvent,
  deriveDeliveryState,
  readDeliveryLedger,
  selectRetainedDeliveryEvents,
} from '../delivery-ledger.js';

const DAY = 24 * 60 * 60 * 1000;

function pending(overrides = {}) {
  return {
    schemaVersion: '1.0',
    type: 'pending',
    occurredAt: '2026-09-01T08:00:00.000Z',
    attemptId: 'attempt-1',
    digestId: 'digest-1',
    frequency: 'daily',
    candidateIds: ['candidate-a'],
    ...overrides,
  };
}

function resolution(type, overrides = {}) {
  return {
    schemaVersion: '1.0',
    type,
    occurredAt: '2026-09-01T08:01:00.000Z',
    attemptId: 'attempt-1',
    ...overrides,
  };
}

async function ledgerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'state', 'delivery-ledger.jsonl');
}

test('appendDeliveryEvent creates an append-only JSONL ledger that can be read back', async (t) => {
  const ledgerPath = await ledgerFixture(t);
  await appendDeliveryEvent(pending(), { ledgerPath });
  await appendDeliveryEvent(resolution('delivered'), { ledgerPath });

  assert.deepEqual(await readDeliveryLedger({ ledgerPath }), [pending(), resolution('delivered')]);
  assert.equal((await readFile(ledgerPath, 'utf8')).endsWith('\n'), true);
});

test('readDeliveryLedger rejects corrupted, truncated, and unknown JSONL events', async (t) => {
  const ledgerPath = await ledgerFixture(t);
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(pending())}\n{"type":"pending"`);
  await assert.rejects(readDeliveryLedger({ ledgerPath }), /line 2|truncated|JSON/i);

  await writeFile(ledgerPath, JSON.stringify(pending()));
  await assert.rejects(readDeliveryLedger({ ledgerPath }), /truncated|newline/i);

  await writeFile(ledgerPath, `${JSON.stringify({ ...pending(), type: 'mystery' })}\n`);
  await assert.rejects(readDeliveryLedger({ ledgerPath }), /unknown.*mystery/i);
});

test('delivery state is derived from legal attempt sequences rather than the last ledger line', () => {
  const events = [
    pending({ attemptId: 'uncertain', candidateIds: ['candidate-pending'] }),
    pending({ attemptId: 'delivered', candidateIds: ['candidate-delivered'] }),
    resolution('delivered', { attemptId: 'delivered' }),
    pending({ attemptId: 'suppressed', candidateIds: ['candidate-suppressed'] }),
    resolution('assumed-delivered', { attemptId: 'suppressed' }),
    pending({ attemptId: 'failed', candidateIds: ['candidate-failed'] }),
    resolution('failed', { attemptId: 'failed' }),
    pending({ attemptId: 'old', digestId: 'digest-retry', candidateIds: ['candidate-retry'] }),
    resolution('superseded', { attemptId: 'old' }),
    pending({ attemptId: 'new', digestId: 'digest-retry', candidateIds: ['candidate-retry'] }),
  ];

  const state = deriveDeliveryState(events);
  assert.equal(state.candidateStates.get('candidate-new'), undefined);
  assert.equal(state.candidateStates.get('candidate-pending'), 'delivery-uncertain');
  assert.equal(state.candidateStates.get('candidate-delivered'), 'pushed-unseen');
  assert.equal(state.candidateStates.get('candidate-suppressed'), 'pushed-unseen');
  assert.equal(state.candidateStates.get('candidate-failed'), 'unpushed');
  assert.equal(state.candidateStates.get('candidate-retry'), 'delivery-uncertain');
});

test('deriveDeliveryState rejects illegal attempt transitions', () => {
  assert.throws(
    () => deriveDeliveryState([resolution('delivered')]),
    /pending.*attempt-1|attempt-1.*pending/i,
  );
  assert.throws(
    () => deriveDeliveryState([pending(), resolution('failed'), resolution('delivered')]),
    /already resolved|illegal transition/i,
  );
});

test('retention never accepts less than 90 days and preserves old events that still determine state', () => {
  assert.equal(MIN_LEDGER_RETENTION_DAYS, 90);
  const now = '2026-09-30T00:00:00.000Z';
  const oldPending = pending({
    occurredAt: new Date(Date.parse(now) - 100 * DAY).toISOString(),
    attemptId: 'old-pending',
  });
  const oldFailed = pending({
    occurredAt: new Date(Date.parse(now) - 100 * DAY).toISOString(),
    attemptId: 'old-failed',
  });
  const oldFailure = resolution('failed', {
    occurredAt: new Date(Date.parse(now) - 99 * DAY).toISOString(),
    attemptId: 'old-failed',
  });
  const boundary = pending({
    occurredAt: new Date(Date.parse(now) - 90 * DAY).toISOString(),
    attemptId: 'boundary',
  });

  assert.throws(
    () => selectRetainedDeliveryEvents([], { now, retentionDays: 89 }),
    /at least 90/i,
  );
  assert.deepEqual(
    selectRetainedDeliveryEvents([oldPending, oldFailed, oldFailure, boundary], { now }),
    [oldPending, boundary],
  );
});
