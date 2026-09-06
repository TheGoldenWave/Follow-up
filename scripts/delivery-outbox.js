import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as systemFs from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  appendDeliveryEvent,
  appendDeliveryEvents,
  deriveDeliveryState,
  readDeliveryLedger,
  reservePendingAttempt,
  validateDeliveryEvent,
} from './delivery-ledger.js';
import { resolveRuntimePaths } from './lib/paths.js';
import lockfile from 'proper-lockfile';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OUTBOX_BYTES = 256 * 1024;
const JOURNAL_BYTES = 512 * 1024;
const COMPACTION_BYTES = 64 * 1024 * 1024;
const COMPACTION_MARKER = 'delivery-compaction.json';
const JOURNAL_PHASES = new Set(['prepared', 'appending', 'ledger-appended', 'outbox-committed']);
const OWNED_OUTBOX_TEMP = /^\.delivery-outbox-[A-Za-z0-9._:-]+-[A-Za-z0-9._-]+\.tmp$/u;
const OWNED_JOURNAL_TEMP = /^\.delivery-journal-[A-Za-z0-9._:-]+-[A-Za-z0-9._-]+\.tmp$/u;

export class DeliveryReservationUncertainError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DeliveryReservationUncertainError';
    this.code = 'DELIVERY_RESERVATION_UNCERTAIN';
  }
}

export class DeliveryClaimUncertainError extends Error {
  constructor(attemptId, options) {
    super('Delivery handoff claim requires reconciliation', options);
    this.name = 'DeliveryClaimUncertainError';
    this.code = 'DELIVERY_CLAIM_UNCERTAIN';
    this.attemptId = attemptId;
  }
}

export class DeliveryAttemptBusyError extends Error {
  constructor(attemptId, options) {
    super('Delivery attempt handoff is already in progress', options);
    this.name = 'DeliveryAttemptBusyError';
    this.code = 'DELIVERY_ATTEMPT_BUSY';
    this.attemptId = attemptId;
  }
}

function requireAbsolute(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`${label} must be absolute`);
  return resolve(path);
}

export function resolveDeliveryOutboxDir(options = {}) {
  if (options.outboxDir) return requireAbsolute(options.outboxDir, 'outboxDir');
  if (options.ledgerPath) return join(dirname(requireAbsolute(options.ledgerPath, 'ledgerPath')), 'delivery-outbox');
  return join(resolveRuntimePaths(options).stateDir, 'delivery-outbox');
}

export function resolveDeliveryTransactionDir(options = {}) {
  if (options.transactionDir) return requireAbsolute(options.transactionDir, 'transactionDir');
  return join(dirname(resolveDeliveryOutboxDir(options)), 'delivery-transactions');
}

function requireAttemptId(attemptId) {
  if (typeof attemptId !== 'string' || !SAFE_ID.test(attemptId)) {
    throw new TypeError('Outbox attemptId must be a safe identifier');
  }
}

function requireToken(value) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) {
    throw new Error('Delivery transaction token is invalid');
  }
  return value;
}

async function requireSafePath(path, fsImpl, { allowMissing = false } = {}) {
  const absolute = requireAbsolute(path, 'delivery state path');
  const components = absolute.split(sep).filter(Boolean);
  let current = sep;
  for (const component of components) {
    current = join(current, component);
    try {
      if ((await fsImpl.lstat(current)).isSymbolicLink()) {
        const isMacOsVarAlias = current === '/var'
          && await fsImpl.realpath(current) === '/private/var';
        if (!isMacOsVarAlias) throw new Error('Delivery state path contains a symbolic link');
      }
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return absolute;
      throw error;
    }
  }
  return absolute;
}

async function ensureDirectory(path, fsImpl) {
  await requireSafePath(path, fsImpl, { allowMissing: true });
  await fsImpl.mkdir(path, { recursive: true, mode: 0o700 });
  await requireSafePath(path, fsImpl);
  const metadata = await fsImpl.lstat(path);
  if (!metadata.isDirectory()) throw new Error('Delivery state path must be a directory');
}

async function fsyncDirectory(path, fsImpl) {
  const handle = await fsImpl.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function validateTimestamp(value, label) {
  if (typeof value !== 'string' || !STRICT_TIMESTAMP.test(value)
    || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a strict UTC timestamp`);
  }
}

function validateReceipt(receipt) {
  validateDeliveryEvent({
    schemaVersion: '1.0', type: 'delivered', occurredAt: '2000-01-01T00:00:00.000Z',
    attemptId: 'validation', providerReceipt: receipt,
  });
}

export function validateOutboxRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Outbox record must be an object');
  }
  const allowed = record.status === 'delivered'
    ? ['schemaVersion', 'status', 'attempt', 'updatedAt', 'receipt']
    : record.status === 'failed'
      ? ['schemaVersion', 'status', 'attempt', 'updatedAt', 'reasonCode']
      : ['schemaVersion', 'status', 'attempt', 'updatedAt'];
  const hasClaimId = Object.hasOwn(record, 'claimId');
  const hasClaimedAt = Object.hasOwn(record, 'handoffClaimedAt');
  if (hasClaimId !== hasClaimedAt) throw new TypeError('Outbox claim metadata is incomplete');
  if (hasClaimId) allowed.push('claimId', 'handoffClaimedAt');
  if (record.schemaVersion !== '1.0'
    || !['pending', 'delivered', 'failed', 'assumed-delivered', 'superseded'].includes(record.status)
    || Object.keys(record).some((field) => !allowed.includes(field))
    || allowed.some((field) => !Object.hasOwn(record, field))) {
    throw new TypeError('Invalid closed outbox record schema');
  }
  validateDeliveryEvent(record.attempt);
  if (record.attempt.type !== 'pending') throw new TypeError('Outbox attempt must be pending');
  validateTimestamp(record.updatedAt, 'Outbox updatedAt');
  if (hasClaimId) {
    requireAttemptId(record.claimId);
    validateTimestamp(record.handoffClaimedAt, 'Outbox handoffClaimedAt');
    if (Date.parse(record.handoffClaimedAt) < Date.parse(record.attempt.occurredAt)
      || Date.parse(record.updatedAt) < Date.parse(record.handoffClaimedAt)) {
      throw new TypeError('Outbox claim timestamps are invalid');
    }
  }
  if (record.status === 'delivered') validateReceipt(record.receipt);
  if (record.status === 'failed' && !/^[a-z][a-z0-9-]{0,63}$/u.test(record.reasonCode)) {
    throw new TypeError('Outbox failure reasonCode is invalid');
  }
  if (Buffer.byteLength(JSON.stringify(record)) > OUTBOX_BYTES) {
    throw new RangeError('Outbox record exceeds byte limit');
  }
  return record;
}

function validateJournal(journal) {
  const legacyFields = [
    'schemaVersion', 'phase', 'operation', 'attemptId', 'event', 'record',
    'preAppendOffset', 'eventBytes', 'eventHash',
  ];
  const batchFields = [
    'schemaVersion', 'phase', 'operation', 'attemptId', 'events', 'records',
    'preAppendOffset', 'eventBytes', 'eventHash',
  ];
  const fields = Object.hasOwn(journal ?? {}, 'events') ? batchFields : legacyFields;
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || Object.keys(journal).sort().join(',') !== fields.sort().join(',')
    || journal.schemaVersion !== '1.0' || !JOURNAL_PHASES.has(journal.phase)
    || !['reservation', 'resolution', 'replacement', 'claim'].includes(journal.operation)) {
    throw new Error('Invalid closed delivery transaction journal');
  }
  requireAttemptId(journal.attemptId);
  const events = journal.events ?? [journal.event];
  const records = journal.records ?? [journal.record];
  if (!Array.isArray(events) || events.length === 0 || !Array.isArray(records) || records.length === 0) {
    throw new Error('Invalid delivery transaction journal batch');
  }
  events.forEach((event) => validateDeliveryEvent(event));
  records.forEach((record) => validateOutboxRecord(record));
  if (events[0].attemptId !== journal.attemptId
    || records[0].attempt.attemptId !== journal.attemptId) {
    throw new Error('Delivery transaction journal attemptId mismatch');
  }
  if (journal.operation === 'reservation'
    && (events.length !== 1 || events[0].type !== 'pending' || records[0].status !== 'pending')) {
    throw new Error('Invalid reservation journal');
  }
  if (journal.operation === 'resolution'
    && (events.length !== 1 || events[0].type !== records[0].status)) {
    throw new Error('Invalid resolution journal');
  }
  if (journal.operation === 'claim'
    && (events.length !== 1 || events[0].type !== 'handoff-claimed'
      || records[0].status !== 'pending'
      || records[0].claimId !== events[0].claimId
      || records[0].handoffClaimedAt !== events[0].occurredAt)) {
    throw new Error('Invalid handoff claim journal');
  }
  if (journal.operation === 'replacement'
    && (events.length !== 2 || records.length !== 2
      || events[0].type !== 'superseded' || events[1].type !== 'pending'
      || records[0].status !== 'superseded' || records[1].status !== 'pending'
      || events[0].replacementAttemptId !== events[1].attemptId)) {
    throw new Error('Invalid replacement journal');
  }
  if (!Number.isSafeInteger(journal.preAppendOffset) || journal.preAppendOffset < 0
    || typeof journal.eventBytes !== 'string' || journal.eventBytes.length === 0
    || typeof journal.eventHash !== 'string' || !/^[a-f0-9]{64}$/u.test(journal.eventHash)) {
    throw new Error('Invalid delivery journal append authority');
  }
  const expected = Buffer.from(journal.eventBytes, 'base64');
  const serialized = Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  if (expected.length === 0 || expected.length > 1024 * 1024
    || expected.toString('base64') !== journal.eventBytes
    || !expected.equals(serialized)
    || createHash('sha256').update(expected).digest('hex') !== journal.eventHash) {
    throw new Error('Delivery journal event bytes or hash are invalid');
  }
  if (Buffer.byteLength(JSON.stringify(journal)) > JOURNAL_BYTES) {
    throw new RangeError('Delivery transaction journal exceeds byte limit');
  }
  return journal;
}

async function readJsonFile(path, maximum, fsImpl, label) {
  await requireSafePath(path, fsImpl);
  const metadata = await fsImpl.lstat(path);
  if (!metadata.isFile() || metadata.size > maximum) throw new Error(`${label} has invalid size or type`);
  try { return JSON.parse(await fsImpl.readFile(path, 'utf8')); }
  catch (error) { throw new Error(`${label} is invalid`, { cause: error }); }
}

async function writeExclusive(path, value, maximum, fsImpl) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > maximum) throw new RangeError('Delivery state record exceeds byte limit');
  await requireSafePath(path, fsImpl, { allowMissing: true });
  const handle = await fsImpl.open(path, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path, value, maximum, fsImpl, randomUUID, prefix) {
  await requireSafePath(path, fsImpl, { allowMissing: true });
  const token = requireToken(randomUUID());
  const identifier = value.attemptId ?? value.attempt?.attemptId ?? 'state';
  const temporary = join(dirname(path), `.${prefix}-${identifier}-${token}.tmp`);
  try {
    await writeExclusive(temporary, value, maximum, fsImpl);
    await fsImpl.rename(temporary, path);
    await fsyncDirectory(dirname(path), fsImpl);
  } catch (error) {
    await fsImpl.unlink(temporary).catch(() => {});
    throw error;
  }
}

function outboxRecordForAttempt(attempt) {
  const { pending, claim, resolution } = attempt;
  const claimFields = claim ? {
    claimId: claim.claimId, handoffClaimedAt: claim.occurredAt,
  } : {};
  if (!resolution) {
    return {
      schemaVersion: '1.0', status: 'pending', attempt: pending,
      updatedAt: claim?.occurredAt ?? pending.occurredAt, ...claimFields,
    };
  }
  if (resolution.type === 'delivered') {
    return {
      schemaVersion: '1.0', status: 'delivered', attempt: pending,
      updatedAt: resolution.occurredAt, receipt: resolution.providerReceipt,
      ...claimFields,
    };
  }
  if (resolution.type === 'failed') {
    return {
      schemaVersion: '1.0', status: 'failed', attempt: pending,
      updatedAt: resolution.occurredAt, reasonCode: resolution.reasonCode,
      ...claimFields,
    };
  }
  if (resolution.type === 'assumed-delivered' || resolution.type === 'superseded') {
    return {
      schemaVersion: '1.0', status: resolution.type, attempt: pending,
      updatedAt: resolution.occurredAt,
      ...claimFields,
    };
  }
  return null;
}

async function removeOwnedTemps(directory, pattern, fsImpl) {
  for (const entry of await fsImpl.readdir(directory, { withFileTypes: true })) {
    if (pattern.test(entry.name)) {
      if (!entry.isFile()) throw new Error(`Invalid delivery temporary entry ${entry.name}`);
      await requireSafePath(join(directory, entry.name), fsImpl);
      await fsImpl.unlink(join(directory, entry.name));
    }
  }
  await fsyncDirectory(directory, fsImpl);
}

async function readOutboxRaw(attemptId, options) {
  const { fsImpl, outboxDir } = options;
  const path = join(outboxDir, `${attemptId}.json`);
  return validateOutboxRecord(await readJsonFile(path, OUTBOX_BYTES, fsImpl, 'Invalid outbox attempt record'));
}

async function writeOutboxRecord(record, options) {
  validateOutboxRecord(record);
  await writeAtomic(
    join(options.outboxDir, `${record.attempt.attemptId}.json`), record,
    OUTBOX_BYTES, options.fsImpl, options.randomUUID, 'delivery-outbox',
  );
}

async function writeJournal(journal, options) {
  validateJournal(journal);
  await writeAtomic(
    join(options.transactionDir, `${journal.attemptId}.json`), journal,
    JOURNAL_BYTES, options.fsImpl, options.randomUUID, 'delivery-journal',
  );
}

function resolvedOptions(options = {}) {
  return {
    ...options,
    fsImpl: options.fsImpl ?? systemFs,
    randomUUID: options.randomUUID ?? systemRandomUUID,
    outboxDir: resolveDeliveryOutboxDir(options),
    transactionDir: resolveDeliveryTransactionDir(options),
  };
}

export async function withDeliveryAttemptLock(attemptId, callback, rawOptions = {}) {
  requireAttemptId(attemptId);
  const options = resolvedOptions(rawOptions);
  const directory = join(options.transactionDir, 'attempt-locks');
  await ensureDirectory(directory, options.fsImpl);
  const target = join(directory, `${attemptId}.lock`);
  await requireSafePath(target, options.fsImpl, { allowMissing: true });
  try {
    const handle = await options.fsImpl.open(target, 'a', 0o600);
    await handle.close();
  } catch (error) {
    throw new DeliveryAttemptBusyError(attemptId, { cause: error });
  }
  let release;
  try {
    release = await lockfile.lock(target, {
      realpath: false, retries: 0, stale: rawOptions.attemptLockStaleMs ?? 30_000,
    });
  } catch (error) {
    throw new DeliveryAttemptBusyError(attemptId, { cause: error });
  }
  try { return await callback(); } finally { await release(); }
}

async function reconcileUnlocked(events, rawOptions = {}) {
  const options = resolvedOptions(rawOptions);
  await ensureDirectory(options.outboxDir, options.fsImpl);
  await ensureDirectory(options.transactionDir, options.fsImpl);
  await removeOwnedTemps(options.outboxDir, OWNED_OUTBOX_TEMP, options.fsImpl);
  await removeOwnedTemps(options.transactionDir, OWNED_JOURNAL_TEMP, options.fsImpl);

  const journals = new Map();
  let compactionMarker = null;
  for (const entry of await options.fsImpl.readdir(options.transactionDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'attempt-locks') continue;
    if (entry.isFile() && entry.name === COMPACTION_MARKER) {
      compactionMarker = await readJsonFile(
        join(options.transactionDir, entry.name), COMPACTION_BYTES, options.fsImpl,
        'Delivery compaction marker',
      );
      if (compactionMarker?.schemaVersion !== '1.0'
        || Object.keys(compactionMarker).sort().join(',') !== 'removedAttemptIds,schemaVersion'
        || !Array.isArray(compactionMarker.removedAttemptIds)
        || compactionMarker.removedAttemptIds.some((id) => !SAFE_ID.test(id))
        || new Set(compactionMarker.removedAttemptIds).size
          !== compactionMarker.removedAttemptIds.length) {
        throw new Error('Invalid delivery compaction marker');
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Invalid delivery transaction journal entry ${entry.name}`);
    }
    const journal = validateJournal(await readJsonFile(
      join(options.transactionDir, entry.name), JOURNAL_BYTES, options.fsImpl,
      'Delivery transaction journal',
    ));
    if (entry.name !== `${journal.attemptId}.json`) throw new Error('Delivery journal filename mismatch');
    journals.set(journal.attemptId, journal);
  }

  const { attempts } = deriveDeliveryState(events);
  for (const [attemptId, attempt] of attempts) {
    const expected = outboxRecordForAttempt(attempt);
    if (!expected) continue;
    let existing;
    try { existing = await readOutboxRaw(attemptId, options); }
    catch (error) {
      if (error.cause?.code !== 'ENOENT' && error.code !== 'ENOENT') throw error;
    }
    if (!existing || JSON.stringify(existing) !== JSON.stringify(expected)) {
      await writeOutboxRecord(expected, options);
    }
  }

  for (const entry of await options.fsImpl.readdir(options.outboxDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Invalid delivery outbox entry ${entry.name}`);
    }
    const attemptId = entry.name.slice(0, -'.json'.length);
    requireAttemptId(attemptId);
    const record = await readOutboxRaw(attemptId, options);
    if (!attempts.has(attemptId)) {
      if (compactionMarker?.removedAttemptIds.includes(attemptId)
        && record.status !== 'pending') {
        await options.fsImpl.unlink(join(options.outboxDir, entry.name));
        continue;
      }
      throw new Error(`Outbox attempt ${attemptId} has no ledger event`);
    }
  }

  if (compactionMarker) {
    await options.fsImpl.unlink(join(options.transactionDir, COMPACTION_MARKER));
    await fsyncDirectory(options.transactionDir, options.fsImpl);
  }

  for (const [attemptId] of journals) {
    await options.fsImpl.unlink(join(options.transactionDir, `${attemptId}.json`));
  }
  if (journals.size > 0) await fsyncDirectory(options.transactionDir, options.fsImpl);
  return journals.size > 0;
}

export async function prepareDeliveryOutboxCompaction(existingEvents, retainedEvents, rawOptions = {}) {
  const options = resolvedOptions(rawOptions);
  await ensureDirectory(options.outboxDir, options.fsImpl);
  await ensureDirectory(options.transactionDir, options.fsImpl);
  const retained = new Set(retainedEvents.map(({ attemptId }) => attemptId));
  const existing = deriveDeliveryState(existingEvents).attempts;
  const removedAttemptIds = [];
  for (const [attemptId, attempt] of existing) {
    if (retained.has(attemptId) || !attempt.resolution
      || attempt.resolution.type === 'superseded') continue;
    try {
      const record = await readOutboxRaw(attemptId, options);
      if (record.status !== 'pending') removedAttemptIds.push(attemptId);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.cause?.code !== 'ENOENT') throw error;
    }
  }
  const marker = { schemaVersion: '1.0', removedAttemptIds };
  await writeAtomic(
    join(options.transactionDir, COMPACTION_MARKER),
    marker, COMPACTION_BYTES,
    options.fsImpl, options.randomUUID, 'delivery-journal',
  );
  return marker;
}

export async function completeDeliveryOutboxCompaction(retainedEvents, options = {}) {
  return reconcileUnlocked(retainedEvents, options);
}

export async function recoverDeliveryLedgerBeforeRead(ledgerPath, rawOptions = {}) {
  const options = resolvedOptions(rawOptions);
  try { await requireSafePath(options.transactionDir, options.fsImpl); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const appending = [];
  for (const entry of await options.fsImpl.readdir(options.transactionDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'attempt-locks') continue;
    if (entry.isFile() && entry.name === COMPACTION_MARKER) continue;
    if (OWNED_JOURNAL_TEMP.test(entry.name)) continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Invalid delivery transaction journal entry ${entry.name}`);
    }
    const journal = validateJournal(await readJsonFile(
      join(options.transactionDir, entry.name), JOURNAL_BYTES, options.fsImpl,
      'Delivery transaction journal',
    ));
    if (entry.name !== `${journal.attemptId}.json`) throw new Error('Delivery journal filename mismatch');
    if (journal.phase === 'appending') appending.push(journal);
  }
  if (appending.length === 0) return false;
  if (appending.length !== 1) throw new Error('Multiple appending delivery journals are corrupt');
  const journal = appending[0];
  const expected = Buffer.from(journal.eventBytes, 'base64');
  const handle = await options.fsImpl.open(
    ledgerPath,
    fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    const end = journal.preAppendOffset + expected.length;
    if (metadata.size < journal.preAppendOffset || metadata.size > end) {
      throw new Error('Delivery ledger tail does not match appending journal');
    }
    const tailLength = metadata.size - journal.preAppendOffset;
    const tail = Buffer.alloc(tailLength);
    if (tailLength > 0) await handle.read(tail, 0, tailLength, journal.preAppendOffset);
    if (!expected.subarray(0, tailLength).equals(tail)) {
      throw new Error('Delivery ledger tail does not match appending journal');
    }
    if (tailLength !== expected.length) {
      await handle.truncate(journal.preAppendOffset);
      let written = 0;
      while (written < expected.length) {
        const result = await handle.write(
          expected, written, expected.length - written, journal.preAppendOffset + written,
        );
        if (result.bytesWritten <= 0) throw new Error('Delivery ledger recovery made no progress');
        written += result.bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await writeJournal({ ...journal, phase: 'ledger-appended' }, options);
  return true;
}

export async function reconcileDeliveryTransactionsForEvents(events, options = {}) {
  return reconcileUnlocked(events, options);
}

export async function reconcileDeliveryTransactions(options = {}) {
  return readDeliveryLedger({
    ...options,
    reconcileOutbox: false,
    transaction: { reconcile: (events) => reconcileUnlocked(events, options) },
  });
}

function transactionForEvents(events, records, rawOptions) {
  const options = resolvedOptions(rawOptions);
  const operation = events.length === 2
    ? 'replacement'
    : events[0].type === 'pending'
      ? 'reservation'
      : events[0].type === 'handoff-claimed' ? 'claim' : 'resolution';
  const attemptId = events[0].attemptId;
  let journal = {
    schemaVersion: '1.0', phase: 'prepared', operation,
    attemptId,
    ...(events.length === 1 ? { event: events[0], record: records[0] } : { events, records }),
    preAppendOffset: 0, eventBytes: '', eventHash: '0'.repeat(64),
  };
  const transaction = {
    ledgerWasAppended: false,
    ledgerMayBeAppended: false,
    reconcile: (events) => reconcileUnlocked(events, options),
    async prepare(appendPlan) {
      await ensureDirectory(options.outboxDir, options.fsImpl);
      await ensureDirectory(options.transactionDir, options.fsImpl);
      const eventBytes = Buffer.from(appendPlan.serialized);
      journal = {
        ...journal,
        preAppendOffset: appendPlan.preAppendOffset,
        eventBytes: eventBytes.toString('base64'),
        eventHash: createHash('sha256').update(eventBytes).digest('hex'),
      };
      await writeJournal(journal, options);
      return journal;
    },
    async appending() {
      journal = { ...journal, phase: 'appending' };
      await writeJournal(journal, options);
      transaction.ledgerMayBeAppended = true;
    },
    async ledgerAppended() {
      transaction.ledgerWasAppended = true;
      journal = { ...journal, phase: 'ledger-appended' };
      await writeJournal(journal, options);
    },
    async commit() {
      for (const record of records) await writeOutboxRecord(record, options);
      journal = { ...journal, phase: 'outbox-committed' };
      await writeJournal(journal, options);
      await options.fsImpl.unlink(join(options.transactionDir, `${attemptId}.json`));
      await fsyncDirectory(options.transactionDir, options.fsImpl);
    },
    async rollback(_prepared, { ledgerAppended, appendStarted }) {
      if (ledgerAppended || appendStarted) return;
      await options.fsImpl.unlink(join(options.transactionDir, `${attemptId}.json`)).catch(() => {});
      await fsyncDirectory(options.transactionDir, options.fsImpl);
    },
  };
  return transaction;
}

function transactionFor(event, record, rawOptions) {
  return transactionForEvents([event], [record], rawOptions);
}

export async function readOutboxAttempt(attemptId, options = {}) {
  requireAttemptId(attemptId);
  await reconcileDeliveryTransactions(options);
  return readOutboxRaw(attemptId, resolvedOptions(options));
}

export async function readDeliveryOutbox(options = {}) {
  await reconcileDeliveryTransactions(options);
  const resolved = resolvedOptions(options);
  const records = [];
  for (const entry of (await resolved.fsImpl.readdir(resolved.outboxDir, { withFileTypes: true }))
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Invalid delivery outbox entry ${entry.name}`);
    }
    records.push(await readOutboxRaw(entry.name.slice(0, -5), resolved));
  }
  return records;
}

export async function reserveOutboxAttempt(event, options = {}) {
  validateDeliveryEvent(event);
  if (event.type !== 'pending') throw new TypeError('Outbox reservation requires pending attempt');
  const record = {
    schemaVersion: '1.0', status: 'pending', attempt: event, updatedAt: event.occurredAt,
  };
  const transaction = transactionFor(event, record, options);
  try {
    await reservePendingAttempt(event, { ...options, transaction });
  } catch (error) {
    if (transaction.ledgerWasAppended || transaction.ledgerMayBeAppended) {
      throw new DeliveryReservationUncertainError('Delivery reservation requires reconciliation', {
        cause: error,
      });
    }
    throw error;
  }
  return record;
}

export async function resolveOutboxAttempt(attemptId, resolution, options = {}) {
  requireAttemptId(attemptId);
  if (!['delivered', 'failed', 'assumed-delivered'].includes(resolution?.status)) {
    throw new TypeError('Outbox resolution status is invalid');
  }
  const existing = await readOutboxAttempt(attemptId, options);
  if (existing.status !== 'pending') throw new Error('Outbox attempt is already terminal');
  const event = resolution.status === 'delivered'
    ? {
      schemaVersion: '1.0', type: 'delivered', occurredAt: resolution.occurredAt,
      attemptId, providerReceipt: resolution.receipt,
    }
    : resolution.status === 'failed' ? {
      schemaVersion: '1.0', type: 'failed', occurredAt: resolution.occurredAt,
      attemptId, reasonCode: resolution.reasonCode,
    } : {
      schemaVersion: '1.0', type: 'assumed-delivered', occurredAt: resolution.occurredAt,
      attemptId,
    };
  validateDeliveryEvent(event);
  const record = resolution.status === 'delivered'
    ? { ...existing, status: 'delivered', updatedAt: resolution.occurredAt, receipt: resolution.receipt }
    : resolution.status === 'failed'
      ? { ...existing, status: 'failed', updatedAt: resolution.occurredAt, reasonCode: resolution.reasonCode }
      : { ...existing, status: 'assumed-delivered', updatedAt: resolution.occurredAt };
  await appendDeliveryEvent(event, { ...options, transaction: transactionFor(event, record, options) });
  return record;
}

export async function replaceOutboxAttempt(attemptId, replacement, resolution, options = {}) {
  requireAttemptId(attemptId);
  validateDeliveryEvent(replacement);
  if (replacement.type !== 'pending') throw new TypeError('Replacement attempt must be pending');
  const existing = await readOutboxAttempt(attemptId, options);
  if (existing.status !== 'pending') throw new Error('Outbox attempt is already terminal');
  const superseded = {
    schemaVersion: '1.0', type: 'superseded', occurredAt: resolution.occurredAt,
    attemptId, replacementAttemptId: replacement.attemptId,
  };
  validateDeliveryEvent(superseded);
  const records = [
    { ...existing, status: 'superseded', updatedAt: resolution.occurredAt },
    {
      schemaVersion: '1.0', status: 'pending', attempt: replacement,
      updatedAt: replacement.occurredAt,
    },
  ];
  await appendDeliveryEvents([superseded, replacement], {
    ...options,
    transaction: transactionForEvents([superseded, replacement], records, options),
  });
  return records;
}

export async function claimReplacementOutboxAttempt(attemptId, claim, options = {}) {
  requireAttemptId(attemptId);
  const existing = await readOutboxAttempt(attemptId, options);
  if (existing.status !== 'pending') throw new Error('Outbox attempt is already terminal');
  if (existing.claimId) throw new Error('Outbox replacement attempt is already claimed');
  const event = {
    schemaVersion: '1.0', type: 'handoff-claimed', occurredAt: claim.occurredAt,
    attemptId, claimId: claim.claimId,
  };
  validateDeliveryEvent(event);
  const record = {
    ...existing, updatedAt: claim.occurredAt,
    claimId: claim.claimId, handoffClaimedAt: claim.occurredAt,
  };
  const transaction = transactionFor(event, record, options);
  try {
    await appendDeliveryEvent(event, { ...options, transaction });
  } catch (error) {
    if (transaction.ledgerWasAppended || transaction.ledgerMayBeAppended) {
      throw new DeliveryClaimUncertainError(attemptId, { cause: error });
    }
    throw error;
  }
  return record;
}
