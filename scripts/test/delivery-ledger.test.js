import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  MIN_LEDGER_RETENTION_DAYS,
  appendDeliveryEvent,
  appendDeliveryEvents,
  compactDeliveryLedger,
  deriveDeliveryState,
  readDeliveryLedger,
  reservePendingAttempt,
  selectRetainedDeliveryEvents,
} from '../delivery-ledger.js';

const DAY = 24 * 60 * 60 * 1000;

function hashId(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pending(overrides = {}) {
  return {
    schemaVersion: '1.0',
    type: 'pending',
    occurredAt: '2026-09-01T08:00:00.000Z',
    attemptId: 'attempt-1',
    digestId: 'digest-1',
    frequency: 'daily',
    candidateIds: [hashId('candidate-a')],
    eventClusterIds: [hashId('cluster-a')],
    destinationType: 'stdout',
    messageHash: 'a'.repeat(64),
    ...overrides,
  };
}

function resolution(type, overrides = {}) {
  const details = {
    delivered: { providerReceipt: 'receipt-1' },
    failed: { reasonCode: 'provider-rejected' },
    superseded: { replacementAttemptId: 'replacement-attempt' },
    'assumed-delivered': {},
  }[type];
  return {
    schemaVersion: '1.0',
    type,
    occurredAt: '2026-09-01T08:01:00.000Z',
    attemptId: 'attempt-1',
    ...details,
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

test('concurrent reservations for the same candidate allow exactly one winner', async (t) => {
  const ledgerPath = await ledgerFixture(t);
  const candidateId = hashId('contended-candidate');
  const attempts = ['attempt-a', 'attempt-b'].map((attemptId) => pending({
    attemptId,
    digestId: `digest-${attemptId}`,
    candidateIds: [candidateId],
  }));
  const results = await Promise.allSettled(attempts.map((event) => (
    reservePendingAttempt(event, { ledgerPath })
  )));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.match(results.find(({ status }) => status === 'rejected').reason.message, /already reserved|conflict/i);
  assert.equal((await readDeliveryLedger({ ledgerPath })).length, 1);
});

test('ordinary pending append enforces the same candidate reservation conflict', async (t) => {
  const ledgerPath = await ledgerFixture(t);
  const candidateId = hashId('duplicate-candidate');
  await appendDeliveryEvent(pending({ attemptId: 'first', candidateIds: [candidateId] }), { ledgerPath });
  await assert.rejects(
    appendDeliveryEvent(pending({ attemptId: 'second', candidateIds: [candidateId] }), { ledgerPath }),
    /already reserved|conflict/i,
  );

  await appendDeliveryEvent(resolution('assumed-delivered', { attemptId: 'first' }), { ledgerPath });
  await assert.rejects(
    reservePendingAttempt(pending({ attemptId: 'third', candidateIds: [candidateId] }), { ledgerPath }),
    /already reserved|conflict/i,
  );
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
    pending({ attemptId: 'uncertain', candidateIds: [hashId('candidate-pending')] }),
    pending({ attemptId: 'delivered', candidateIds: [hashId('candidate-delivered')] }),
    resolution('delivered', { attemptId: 'delivered' }),
    pending({ attemptId: 'suppressed', candidateIds: [hashId('candidate-suppressed')] }),
    resolution('assumed-delivered', { attemptId: 'suppressed' }),
    pending({ attemptId: 'failed', candidateIds: [hashId('candidate-failed')] }),
    resolution('failed', { attemptId: 'failed' }),
    pending({ attemptId: 'old', digestId: 'digest-retry', candidateIds: [hashId('candidate-retry')] }),
    resolution('superseded', { attemptId: 'old', replacementAttemptId: 'new' }),
    pending({
      attemptId: 'new', digestId: 'digest-retry', candidateIds: [hashId('candidate-retry')],
      occurredAt: '2026-09-01T08:02:00.000Z',
    }),
  ];

  const state = deriveDeliveryState(events);
  assert.equal(state.candidateStates.get(hashId('candidate-new')), undefined);
  assert.equal(state.candidateStates.get(hashId('candidate-pending')), 'delivery-uncertain');
  assert.equal(state.candidateStates.get(hashId('candidate-delivered')), 'pushed-unseen');
  assert.equal(state.candidateStates.get(hashId('candidate-suppressed')), 'pushed-unseen');
  assert.equal(state.candidateStates.get(hashId('candidate-failed')), 'unpushed');
  assert.equal(state.candidateStates.get(hashId('candidate-retry')), 'delivery-uncertain');
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

test('each delivery event type uses a closed non-secret field contract', () => {
  assert.throws(
    () => deriveDeliveryState([{ ...pending(), token: 'secret' }]),
    /unsupported field.*token/i,
  );
  assert.throws(
    () => deriveDeliveryState([{ ...pending(), messageHash: undefined }]),
    /messageHash/i,
  );
  assert.throws(
    () => deriveDeliveryState([{ ...pending(), candidateIds: [123] }]),
    /candidateIds/i,
  );
  assert.throws(
    () => deriveDeliveryState([{ ...pending(), eventClusterIds: [null] }]),
    /eventClusterIds/i,
  );
  assert.throws(
    () => deriveDeliveryState([{ ...pending(), candidateIds: ['candidate-a'] }]),
    /candidateIds.*SHA-256|SHA-256.*candidateIds/i,
  );
  assert.throws(
    () => deriveDeliveryState([{ ...pending(), eventClusterIds: ['cluster-a'] }]),
    /eventClusterIds.*SHA-256|SHA-256.*eventClusterIds/i,
  );
  assert.doesNotThrow(() => deriveDeliveryState([pending()]));
  assert.doesNotThrow(() => deriveDeliveryState([
    pending(), resolution('delivered', { providerReceipt: '<message.123@example.com>' }),
  ]));
  assert.doesNotThrow(() => deriveDeliveryState([
    pending(), resolution('delivered', { providerReceipt: 'telegram:1234567890' }),
  ]));
  assert.throws(
    () => deriveDeliveryState([
      pending(), resolution('delivered', { providerReceipt: `receipt\nsecret` }),
    ]),
    /providerReceipt/i,
  );
  assert.throws(
    () => deriveDeliveryState([
      pending(), resolution('delivered', { providerReceipt: 'x'.repeat(513) }),
    ]),
    /providerReceipt/i,
  );
  assert.throws(
    () => deriveDeliveryState([
      pending(), resolution('delivered', { providerReceipt: 'Bearer secret-value' }),
    ]),
    /providerReceipt/i,
  );
  assert.throws(
    () => deriveDeliveryState([pending(), { ...resolution('delivered'), candidateIds: [] }]),
    /unsupported field.*candidateIds/i,
  );
  assert.throws(
    () => deriveDeliveryState([pending(), resolution('failed', { reasonCode: undefined })]),
    /reasonCode/i,
  );
  assert.throws(
    () => deriveDeliveryState([pending(), resolution('superseded', { replacementAttemptId: undefined })]),
    /replacementAttemptId/i,
  );
  assert.throws(
    () => deriveDeliveryState([pending(), { ...resolution('assumed-delivered'), providerReceipt: 'receipt' }]),
    /unsupported field.*providerReceipt/i,
  );
  assert.throws(
    () => deriveDeliveryState([{ ...pending(), occurredAt: 'September 1, 2026' }]),
    /occurredAt/i,
  );
});

test('an unresolved superseded replacement remains uncertain and reports a diagnostic', () => {
  const candidateId = hashId('retry-candidate');
  const state = deriveDeliveryState([
    pending({ attemptId: 'old', candidateIds: [candidateId] }),
    resolution('superseded', { attemptId: 'old', replacementAttemptId: 'new' }),
  ]);
  assert.equal(state.candidateStates.get(candidateId), 'delivery-uncertain');
  assert.deepEqual(state.unresolvedReplacementAttempts, [{
    attemptId: 'old', replacementAttemptId: 'new',
  }]);
});

test('a replacement pending must be later and preserve digest, candidate, and cluster identity', () => {
  const old = pending({ attemptId: 'old' });
  const superseded = resolution('superseded', {
    attemptId: 'old', replacementAttemptId: 'new',
  });
  const replacement = pending({
    attemptId: 'new', occurredAt: '2026-09-01T08:02:00.000Z',
  });
  assert.doesNotThrow(() => deriveDeliveryState([old, superseded, {
    ...replacement, destinationType: 'email',
  }]));
  assert.throws(
    () => deriveDeliveryState([old, superseded, { ...replacement, digestId: 'other-digest' }]),
    /digestId.*match|match.*digestId/i,
  );
  assert.throws(
    () => deriveDeliveryState([old, superseded, {
      ...replacement, candidateIds: [hashId('other-candidate')],
    }]),
    /candidateIds.*match|match.*candidateIds/i,
  );
  assert.throws(
    () => deriveDeliveryState([old, superseded, {
      ...replacement, eventClusterIds: [hashId('other-cluster')],
    }]),
    /eventClusterIds.*match|match.*eventClusterIds/i,
  );
  assert.throws(
    () => deriveDeliveryState([old, superseded, {
      ...replacement, frequency: 'weekly',
    }]),
    /frequency.*match|match.*frequency/i,
  );
  assert.throws(
    () => deriveDeliveryState([replacement, old, superseded]),
    /subsequent|later/i,
  );
  assert.throws(
    () => deriveDeliveryState([old, resolution('superseded', {
      attemptId: 'old', replacementAttemptId: 'old',
    })]),
    /different|itself|cycle/i,
  );
});

test('appendDeliveryEvents appends a retry pair together under the ledger lock', async (t) => {
  const ledgerPath = await ledgerFixture(t);
  const old = pending({ attemptId: 'old' });
  await appendDeliveryEvent(old, { ledgerPath });
  const retryEvents = [
    resolution('superseded', {
      attemptId: 'old', replacementAttemptId: 'new',
    }),
    pending({
      attemptId: 'new', occurredAt: '2026-09-01T08:02:00.000Z',
    }),
  ];
  await appendDeliveryEvents(retryEvents, { ledgerPath });
  assert.deepEqual(await readDeliveryLedger({ ledgerPath }), [old, ...retryEvents]);
});

test('readers share the ledger lock and never misclassify a concurrent append as truncation', async (t) => {
  const ledgerPath = await ledgerFixture(t);
  const event = pending();
  const reads = Array.from({ length: 12 }, () => readDeliveryLedger({ ledgerPath }));
  const results = await Promise.allSettled([
    ...reads,
    appendDeliveryEvent(event, { ledgerPath }),
  ]);
  assert.equal(results.every(({ status }) => status === 'fulfilled'), true);
  for (const result of results.slice(0, reads.length)) {
    assert.ok(result.value.length === 0 || result.value.length === 1);
  }
  assert.deepEqual(await readDeliveryLedger({ ledgerPath }), [event]);
});

test('streaming ledger reads enforce byte, line, event, and ID-array limits', async (t) => {
  const ledgerPath = await ledgerFixture(t);
  await appendDeliveryEvent(pending(), { ledgerPath });
  await assert.rejects(
    readDeliveryLedger({ ledgerPath, limits: { maxFileBytes: 8 } }),
    /file.*limit|bytes/i,
  );
  await assert.rejects(
    readDeliveryLedger({ ledgerPath, limits: { maxLineBytes: 8 } }),
    /line.*limit|bytes/i,
  );
  await assert.rejects(
    readDeliveryLedger({ ledgerPath, limits: { maxEvents: 0 } }),
    /event.*limit/i,
  );
  assert.throws(
    () => deriveDeliveryState([pending({
      candidateIds: [hashId('one'), hashId('two')],
    })], { limits: { maxCandidateIds: 1 } }),
    /candidateIds.*limit/i,
  );
  assert.throws(
    () => deriveDeliveryState([pending({
      eventClusterIds: [hashId('one'), hashId('two')],
    })], { limits: { maxEventClusterIds: 1 } }),
    /eventClusterIds.*limit/i,
  );
});

test('compact retains unresolved attempts, active candidate state, and latest successful anchors', async (t) => {
  const ledgerPath = await ledgerFixture(t);
  const now = '2026-09-30T00:00:00.000Z';
  const old = '2026-06-01T00:00:00.000Z';
  const events = [
    pending({ attemptId: 'uncertain', occurredAt: old, candidateIds: [hashId('uncertain')] }),
    pending({ attemptId: 'active-delivered', occurredAt: old, candidateIds: [hashId('active')] }),
    resolution('delivered', {
      attemptId: 'active-delivered', occurredAt: '2026-06-01T00:01:00.000Z',
    }),
    pending({ attemptId: 'daily-anchor', occurredAt: '2026-06-02T00:00:00.000Z', candidateIds: [] }),
    resolution('delivered', {
      attemptId: 'daily-anchor', occurredAt: '2026-06-02T00:01:00.000Z',
    }),
    pending({
      attemptId: 'weekly-anchor', frequency: 'weekly', occurredAt: '2026-06-03T00:00:00.000Z',
      candidateIds: [],
    }),
    resolution('delivered', {
      attemptId: 'weekly-anchor', occurredAt: '2026-06-03T00:01:00.000Z',
    }),
    pending({ attemptId: 'obsolete-failed', occurredAt: old, candidateIds: [hashId('obsolete')] }),
    resolution('failed', {
      attemptId: 'obsolete-failed', occurredAt: '2026-06-01T00:01:00.000Z',
    }),
  ];
  await appendDeliveryEvents(events, { ledgerPath });
  const result = await compactDeliveryLedger({
    ledgerPath,
    now,
    activeCandidateIds: [hashId('active')],
  });
  assert.equal(result.removedEvents, 2);
  const retained = await readDeliveryLedger({ ledgerPath });
  assert.deepEqual(
    [...new Set(retained.map(({ attemptId }) => attemptId))].sort(),
    ['active-delivered', 'daily-anchor', 'uncertain', 'weekly-anchor'],
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
