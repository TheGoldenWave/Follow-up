import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import lockfile from 'proper-lockfile';

import { resolveRuntimePaths } from './lib/paths.js';

export const DELIVERY_LEDGER_SCHEMA_VERSION = '1.0';
export const MIN_LEDGER_RETENTION_DAYS = 90;

const EVENT_TYPES = new Set([
  'pending',
  'delivered',
  'failed',
  'assumed-delivered',
  'superseded',
]);
const SUCCESS_TYPES = new Set(['delivered', 'assumed-delivered']);

export function resolveDeliveryLedgerPath(options = {}) {
  return options.ledgerPath
    ?? join(resolveRuntimePaths(options).stateDir, 'delivery-ledger.jsonl');
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Delivery event ${field} must be a non-empty string`);
  }
}

function validateTimestamp(value) {
  requireString(value, 'occurredAt');
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError('Delivery event occurredAt must be a valid timestamp');
  }
}

export function validateDeliveryEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Delivery event must be an object');
  }
  if (event.schemaVersion !== DELIVERY_LEDGER_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported delivery event schemaVersion: ${event.schemaVersion}`);
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw new TypeError(`Unknown delivery event type: ${event.type}`);
  }
  requireString(event.attemptId, 'attemptId');
  validateTimestamp(event.occurredAt);

  if (event.type === 'pending') {
    requireString(event.digestId, 'digestId');
    if (!['daily', 'weekly'].includes(event.frequency)) {
      throw new TypeError('Pending delivery event frequency must be daily or weekly');
    }
    if (!Array.isArray(event.candidateIds)
      || event.candidateIds.some((candidateId) => typeof candidateId !== 'string' || candidateId.length === 0)
      || new Set(event.candidateIds).size !== event.candidateIds.length) {
      throw new TypeError('Pending delivery event candidateIds must be unique non-empty strings');
    }
  }
  return event;
}

function buildAttemptState(events) {
  const attempts = new Map();
  for (const [index, event] of events.entries()) {
    validateDeliveryEvent(event);
    const existing = attempts.get(event.attemptId);
    if (event.type === 'pending') {
      if (existing) {
        throw new Error(`Illegal transition at event ${index + 1}: attempt ${event.attemptId} already exists`);
      }
      attempts.set(event.attemptId, { pending: event, resolution: null });
      continue;
    }
    if (!existing) {
      throw new Error(`Illegal transition at event ${index + 1}: attempt ${event.attemptId} has no pending event`);
    }
    if (existing.resolution) {
      throw new Error(`Illegal transition at event ${index + 1}: attempt ${event.attemptId} is already resolved`);
    }
    if (Date.parse(event.occurredAt) < Date.parse(existing.pending.occurredAt)) {
      throw new Error(`Illegal transition at event ${index + 1}: resolution predates pending attempt ${event.attemptId}`);
    }
    existing.resolution = event;
  }
  return attempts;
}

export function deriveDeliveryState(events) {
  if (!Array.isArray(events)) throw new TypeError('Delivery events must be an array');
  const attempts = buildAttemptState(events);
  const candidateStates = new Map();
  const successfulDeliveries = [];

  for (const { pending, resolution } of attempts.values()) {
    const type = resolution?.type;
    if (SUCCESS_TYPES.has(type)) {
      successfulDeliveries.push({
        attemptId: pending.attemptId,
        digestId: pending.digestId,
        frequency: pending.frequency,
        deliveredAt: resolution.occurredAt,
        type,
      });
      for (const candidateId of pending.candidateIds) {
        candidateStates.set(candidateId, 'pushed-unseen');
      }
      continue;
    }
    if (!resolution) {
      for (const candidateId of pending.candidateIds) {
        if (candidateStates.get(candidateId) !== 'pushed-unseen') {
          candidateStates.set(candidateId, 'delivery-uncertain');
        }
      }
      continue;
    }
    for (const candidateId of pending.candidateIds) {
      if (!candidateStates.has(candidateId)) candidateStates.set(candidateId, 'unpushed');
    }
  }
  successfulDeliveries.sort((left, right) => (
    Date.parse(left.deliveredAt) - Date.parse(right.deliveredAt)
  ));
  return { attempts, candidateStates, successfulDeliveries };
}

function parseLedger(content, ledgerPath) {
  if (content.length === 0) return [];
  if (!content.endsWith('\n')) {
    throw new Error(`Invalid or truncated delivery ledger ${ledgerPath}: missing final newline`);
  }
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = lines.map((line, index) => {
    if (line.trim().length === 0) {
      throw new Error(`Invalid delivery ledger ${ledgerPath} at line ${index + 1}: blank event`);
    }
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid or truncated delivery ledger ${ledgerPath} at line ${index + 1}: ${error.message}`);
    }
  });
  deriveDeliveryState(events);
  return events;
}

export async function readDeliveryLedger(options = {}) {
  const ledgerPath = resolveDeliveryLedgerPath(options);
  try {
    return parseLedger(await readFile(ledgerPath, 'utf8'), ledgerPath);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendDeliveryEvent(event, options = {}) {
  validateDeliveryEvent(event);
  const ledgerPath = resolveDeliveryLedgerPath(options);
  await mkdir(dirname(ledgerPath), { recursive: true });
  const initial = await open(ledgerPath, 'a');
  await initial.close();
  const release = await lockfile.lock(ledgerPath, {
    realpath: false,
    retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
  });
  try {
    const events = await readDeliveryLedger({ ledgerPath });
    deriveDeliveryState([...events, event]);
    const handle = await open(ledgerPath, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await release();
  }
}

export function selectRetainedDeliveryEvents(events, {
  now = new Date().toISOString(),
  retentionDays = MIN_LEDGER_RETENTION_DAYS,
} = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_LEDGER_RETENTION_DAYS) {
    throw new RangeError(`Delivery ledger retention must be at least ${MIN_LEDGER_RETENTION_DAYS} days`);
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid timestamp');
  const attempts = buildAttemptState(events);
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const removableAttempts = new Set();
  for (const [attemptId, attempt] of attempts) {
    if (!['failed', 'superseded'].includes(attempt.resolution?.type)) continue;
    if (Date.parse(attempt.pending.occurredAt) < cutoff
      && Date.parse(attempt.resolution.occurredAt) < cutoff) {
      removableAttempts.add(attemptId);
    }
  }
  return events.filter((event) => (
    Date.parse(event.occurredAt) >= cutoff || !removableAttempts.has(event.attemptId)
  ));
}
