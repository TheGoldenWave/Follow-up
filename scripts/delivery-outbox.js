import { randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  appendDeliveryEvent,
  deriveDeliveryState,
  readDeliveryLedger,
  reservePendingAttempt,
  validateDeliveryEvent,
} from './delivery-ledger.js';
import { resolveRuntimePaths } from './lib/paths.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OUTBOX_BYTES = 256 * 1024;
const JOURNAL_BYTES = 512 * 1024;
const JOURNAL_PHASES = new Set(['prepared', 'ledger-appended', 'outbox-committed']);
const OWNED_OUTBOX_TEMP = /^\.delivery-outbox-[A-Za-z0-9._:-]+-[A-Za-z0-9._-]+\.tmp$/u;
const OWNED_JOURNAL_TEMP = /^\.delivery-journal-[A-Za-z0-9._:-]+-[A-Za-z0-9._-]+\.tmp$/u;

export class DeliveryReservationUncertainError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DeliveryReservationUncertainError';
    this.code = 'DELIVERY_RESERVATION_UNCERTAIN';
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
  if (record.schemaVersion !== '1.0' || !['pending', 'delivered', 'failed'].includes(record.status)
    || Object.keys(record).some((field) => !allowed.includes(field))
    || allowed.some((field) => !Object.hasOwn(record, field))) {
    throw new TypeError('Invalid closed outbox record schema');
  }
  validateDeliveryEvent(record.attempt);
  if (record.attempt.type !== 'pending') throw new TypeError('Outbox attempt must be pending');
  validateTimestamp(record.updatedAt, 'Outbox updatedAt');
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
  const fields = ['schemaVersion', 'phase', 'operation', 'attemptId', 'event', 'record'];
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || Object.keys(journal).sort().join(',') !== fields.sort().join(',')
    || journal.schemaVersion !== '1.0' || !JOURNAL_PHASES.has(journal.phase)
    || !['reservation', 'resolution'].includes(journal.operation)) {
    throw new Error('Invalid closed delivery transaction journal');
  }
  requireAttemptId(journal.attemptId);
  validateDeliveryEvent(journal.event);
  validateOutboxRecord(journal.record);
  if (journal.event.attemptId !== journal.attemptId
    || journal.record.attempt.attemptId !== journal.attemptId) {
    throw new Error('Delivery transaction journal attemptId mismatch');
  }
  if (journal.operation === 'reservation'
    && (journal.event.type !== 'pending' || journal.record.status !== 'pending')) {
    throw new Error('Invalid reservation journal');
  }
  if (journal.operation === 'resolution'
    && journal.event.type !== journal.record.status) {
    throw new Error('Invalid resolution journal');
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
  const temporary = join(dirname(path), `.${prefix}-${value.attemptId ?? value.attempt?.attemptId}-${token}.tmp`);
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
  const { pending, resolution } = attempt;
  if (!resolution) {
    return { schemaVersion: '1.0', status: 'pending', attempt: pending, updatedAt: pending.occurredAt };
  }
  if (resolution.type === 'delivered') {
    return {
      schemaVersion: '1.0', status: 'delivered', attempt: pending,
      updatedAt: resolution.occurredAt, receipt: resolution.providerReceipt,
    };
  }
  if (resolution.type === 'failed') {
    return {
      schemaVersion: '1.0', status: 'failed', attempt: pending,
      updatedAt: resolution.occurredAt, reasonCode: resolution.reasonCode,
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

async function reconcileUnlocked(events, rawOptions = {}) {
  const options = resolvedOptions(rawOptions);
  await ensureDirectory(options.outboxDir, options.fsImpl);
  await ensureDirectory(options.transactionDir, options.fsImpl);
  await removeOwnedTemps(options.outboxDir, OWNED_OUTBOX_TEMP, options.fsImpl);
  await removeOwnedTemps(options.transactionDir, OWNED_JOURNAL_TEMP, options.fsImpl);

  const journals = new Map();
  for (const entry of await options.fsImpl.readdir(options.transactionDir, { withFileTypes: true })) {
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
    await readOutboxRaw(attemptId, options);
    if (!attempts.has(attemptId)) throw new Error(`Outbox attempt ${attemptId} has no ledger event`);
  }

  for (const [attemptId] of journals) {
    await options.fsImpl.unlink(join(options.transactionDir, `${attemptId}.json`));
  }
  if (journals.size > 0) await fsyncDirectory(options.transactionDir, options.fsImpl);
  return journals.size > 0;
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

function transactionFor(event, record, rawOptions) {
  const options = resolvedOptions(rawOptions);
  const operation = event.type === 'pending' ? 'reservation' : 'resolution';
  let journal = {
    schemaVersion: '1.0', phase: 'prepared', operation,
    attemptId: event.attemptId, event, record,
  };
  const transaction = {
    ledgerWasAppended: false,
    reconcile: (events) => reconcileUnlocked(events, options),
    async prepare() {
      await ensureDirectory(options.outboxDir, options.fsImpl);
      await ensureDirectory(options.transactionDir, options.fsImpl);
      await writeJournal(journal, options);
      return journal;
    },
    async ledgerAppended() {
      transaction.ledgerWasAppended = true;
      journal = { ...journal, phase: 'ledger-appended' };
      await writeJournal(journal, options);
    },
    async commit() {
      await writeOutboxRecord(record, options);
      journal = { ...journal, phase: 'outbox-committed' };
      await writeJournal(journal, options);
      await options.fsImpl.unlink(join(options.transactionDir, `${event.attemptId}.json`));
      await fsyncDirectory(options.transactionDir, options.fsImpl);
    },
    async rollback(_prepared, { ledgerAppended }) {
      if (ledgerAppended) return;
      await options.fsImpl.unlink(join(options.transactionDir, `${event.attemptId}.json`)).catch(() => {});
      await fsyncDirectory(options.transactionDir, options.fsImpl);
    },
  };
  return transaction;
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
    if (transaction.ledgerWasAppended) {
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
  const existing = await readOutboxAttempt(attemptId, options);
  if (existing.status !== 'pending') throw new Error('Outbox attempt is already terminal');
  const event = resolution.status === 'delivered'
    ? {
      schemaVersion: '1.0', type: 'delivered', occurredAt: resolution.occurredAt,
      attemptId, providerReceipt: resolution.receipt,
    }
    : {
      schemaVersion: '1.0', type: 'failed', occurredAt: resolution.occurredAt,
      attemptId, reasonCode: resolution.reasonCode,
    };
  validateDeliveryEvent(event);
  const record = resolution.status === 'delivered'
    ? { ...existing, status: 'delivered', updatedAt: resolution.occurredAt, receipt: resolution.receipt }
    : { ...existing, status: 'failed', updatedAt: resolution.occurredAt, reasonCode: resolution.reasonCode };
  await appendDeliveryEvent(event, { ...options, transaction: transactionFor(event, record, options) });
  return record;
}
