import { randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  appendDeliveryEvent,
  reservePendingAttempt,
  validateDeliveryEvent,
} from './delivery-ledger.js';
import { resolveRuntimePaths } from './lib/paths.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_OUTBOX_BYTES = 256 * 1024;
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function resolveDeliveryOutboxDir(options = {}) {
  return resolve(options.outboxDir ?? join(resolveRuntimePaths(options).stateDir, 'delivery-outbox'));
}

function requireAttemptId(attemptId) {
  if (typeof attemptId !== 'string' || !SAFE_ID.test(attemptId)) {
    throw new TypeError('Outbox attemptId must be a safe identifier');
  }
}

async function rejectSymlink(path, fsImpl, allowMissing = false) {
  try {
    if ((await fsImpl.lstat(path)).isSymbolicLink()) throw new Error('unsafe symbolic link in outbox path');
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return;
    throw error;
  }
}

async function fsyncDirectory(path, fsImpl) {
  const handle = await fsImpl.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureOutboxDir(outboxDir, fsImpl) {
  await rejectSymlink(dirname(outboxDir), fsImpl, true);
  await fsImpl.mkdir(dirname(outboxDir), { recursive: true, mode: 0o700 });
  await rejectSymlink(dirname(outboxDir), fsImpl);
  await rejectSymlink(outboxDir, fsImpl, true);
  await fsImpl.mkdir(outboxDir, { recursive: true, mode: 0o700 });
  await rejectSymlink(outboxDir, fsImpl);
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
  if (typeof record.updatedAt !== 'string' || !STRICT_TIMESTAMP.test(record.updatedAt)
    || Number.isNaN(Date.parse(record.updatedAt))
    || new Date(record.updatedAt).toISOString() !== record.updatedAt) {
    throw new TypeError('Outbox updatedAt must be a timestamp');
  }
  if (record.status === 'delivered') validateReceipt(record.receipt);
  if (record.status === 'failed' && !/^[a-z][a-z0-9-]{0,63}$/u.test(record.reasonCode)) {
    throw new TypeError('Outbox failure reasonCode is invalid');
  }
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_OUTBOX_BYTES) {
    throw new RangeError('Outbox record exceeds byte limit');
  }
  return record;
}

async function writeExclusive(path, value, fsImpl) {
  const serialized = `${JSON.stringify(validateOutboxRecord(value))}\n`;
  const handle = await fsImpl.open(path, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path, value, fsImpl, randomUUID) {
  await rejectSymlink(path, fsImpl);
  const temporary = join(dirname(path), `.outbox-${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, value, fsImpl);
    await fsImpl.rename(temporary, path);
    await fsyncDirectory(dirname(path), fsImpl);
  } catch (error) {
    await fsImpl.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readOutboxAttempt(attemptId, options = {}) {
  requireAttemptId(attemptId);
  const fsImpl = options.fsImpl ?? systemFs;
  const outboxDir = resolveDeliveryOutboxDir(options);
  await rejectSymlink(outboxDir, fsImpl);
  const path = join(outboxDir, `${attemptId}.json`);
  await rejectSymlink(path, fsImpl);
  try {
    const metadata = await fsImpl.stat(path);
    if (!metadata.isFile() || metadata.size > MAX_OUTBOX_BYTES) throw new Error('invalid size or type');
    return validateOutboxRecord(JSON.parse(await fsImpl.readFile(path, 'utf8')));
  } catch (error) {
    throw new Error('Invalid outbox attempt record', { cause: error });
  }
}

export async function readDeliveryOutbox(options = {}) {
  const fsImpl = options.fsImpl ?? systemFs;
  const outboxDir = resolveDeliveryOutboxDir(options);
  try {
    await rejectSymlink(outboxDir, fsImpl);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('Invalid delivery outbox', { cause: error });
  }
  const entries = await fsImpl.readdir(outboxDir, { withFileTypes: true });
  const records = [];
  for (const entry of entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Invalid delivery outbox entry ${entry.name}`);
    }
    const attemptId = entry.name.slice(0, -'.json'.length);
    records.push(await readOutboxAttempt(attemptId, options));
  }
  return records;
}

export async function reserveOutboxAttempt(event, options = {}) {
  const fsImpl = options.fsImpl ?? systemFs;
  const randomUUID = options.randomUUID ?? systemRandomUUID;
  const outboxDir = resolveDeliveryOutboxDir(options);
  requireAttemptId(event?.attemptId);
  validateDeliveryEvent(event);
  if (event.type !== 'pending') throw new TypeError('Outbox reservation requires pending attempt');
  await ensureOutboxDir(outboxDir, fsImpl);
  const finalPath = join(outboxDir, `${event.attemptId}.json`);
  await rejectSymlink(finalPath, fsImpl, true);
  const record = { schemaVersion: '1.0', status: 'pending', attempt: event, updatedAt: event.occurredAt };
  let temporaryPath;
  await reservePendingAttempt(event, {
    ...options,
    transaction: {
      async prepare() {
        try {
          await fsImpl.lstat(finalPath);
          throw new Error('Outbox attempt already exists');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        temporaryPath = join(outboxDir, `.pending-${randomUUID()}.tmp`);
        await writeExclusive(temporaryPath, record, fsImpl);
        return temporaryPath;
      },
      async commit() {
        await fsImpl.rename(temporaryPath, finalPath);
        await fsyncDirectory(outboxDir, fsImpl);
      },
      async rollback() {
        if (temporaryPath) await fsImpl.unlink(temporaryPath).catch(() => {});
      },
    },
  });
  return record;
}

export async function resolveOutboxAttempt(attemptId, resolution, options = {}) {
  requireAttemptId(attemptId);
  const fsImpl = options.fsImpl ?? systemFs;
  const randomUUID = options.randomUUID ?? systemRandomUUID;
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
  await appendDeliveryEvent(event, options);
  const record = resolution.status === 'delivered'
    ? { ...existing, status: 'delivered', updatedAt: resolution.occurredAt, receipt: resolution.receipt }
    : { ...existing, status: 'failed', updatedAt: resolution.occurredAt, reasonCode: resolution.reasonCode };
  await writeAtomic(join(resolveDeliveryOutboxDir(options), `${attemptId}.json`), record, fsImpl, randomUUID);
  return record;
}
