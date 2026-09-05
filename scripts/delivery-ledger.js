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
const COMMON_FIELDS = Object.freeze(['schemaVersion', 'type', 'occurredAt', 'attemptId']);
const EVENT_FIELDS = Object.freeze({
  pending: Object.freeze([
    ...COMMON_FIELDS,
    'digestId',
    'frequency',
    'candidateIds',
    'eventClusterIds',
    'destinationType',
    'messageHash',
  ]),
  delivered: Object.freeze([...COMMON_FIELDS, 'providerReceipt']),
  failed: Object.freeze([...COMMON_FIELDS, 'reasonCode']),
  'assumed-delivered': COMMON_FIELDS,
  superseded: Object.freeze([...COMMON_FIELDS, 'replacementAttemptId']),
});
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function resolveDeliveryLedgerPath(options = {}) {
  return options.ledgerPath
    ?? join(resolveRuntimePaths(options).stateDir, 'delivery-ledger.jsonl');
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Delivery event ${field} must be a non-empty string`);
  }
}

function requireId(value, field) {
  requireString(value, field);
  if (!SAFE_ID.test(value)) {
    throw new TypeError(`Delivery event ${field} must be a safe identifier`);
  }
}

function validateTimestamp(value) {
  requireString(value, 'occurredAt');
  const parsed = Date.parse(value);
  if (!STRICT_TIMESTAMP.test(value) || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value) {
    throw new TypeError('Delivery event occurredAt must be a strict UTC timestamp');
  }
}

function validateHashIdArray(value, field) {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || !SHA256.test(entry))
    || new Set(value).size !== value.length) {
    throw new TypeError(
      `Delivery event ${field} must be an array of unique lowercase SHA-256 identifiers`,
    );
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
  const allowedFields = new Set(EVENT_FIELDS[event.type]);
  for (const field of Object.keys(event)) {
    if (!allowedFields.has(field)) {
      throw new TypeError(`Delivery event ${event.type} contains unsupported field ${field}`);
    }
  }
  for (const field of allowedFields) {
    if (!Object.hasOwn(event, field) || event[field] === undefined) {
      throw new TypeError(`Delivery event ${event.type} requires field ${field}`);
    }
  }
  requireId(event.attemptId, 'attemptId');
  validateTimestamp(event.occurredAt);

  if (event.type === 'pending') {
    requireId(event.digestId, 'digestId');
    if (!['daily', 'weekly'].includes(event.frequency)) {
      throw new TypeError('Pending delivery event frequency must be daily or weekly');
    }
    validateHashIdArray(event.candidateIds, 'candidateIds');
    validateHashIdArray(event.eventClusterIds, 'eventClusterIds');
    if (!['stdout', 'telegram', 'email'].includes(event.destinationType)) {
      throw new TypeError('Pending delivery event destinationType must be stdout, telegram, or email');
    }
    if (typeof event.messageHash !== 'string' || !SHA256.test(event.messageHash)) {
      throw new TypeError('Pending delivery event messageHash must be a lowercase SHA-256 digest');
    }
  }
  if (event.type === 'delivered') requireId(event.providerReceipt, 'providerReceipt');
  if (event.type === 'failed' && !REASON_CODE.test(event.reasonCode)) {
    throw new TypeError('Failed delivery event reasonCode must be a safe machine-readable code');
  }
  if (event.type === 'superseded') {
    requireId(event.replacementAttemptId, 'replacementAttemptId');
    if (event.replacementAttemptId === event.attemptId) {
      throw new TypeError('Superseded delivery event replacementAttemptId must be different');
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
      attempts.set(event.attemptId, {
        pending: event,
        pendingIndex: index,
        resolution: null,
        resolutionIndex: null,
      });
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
    existing.resolutionIndex = index;
  }

  const unresolvedReplacementAttempts = [];
  for (const [attemptId, attempt] of attempts) {
    if (attempt.resolution?.type !== 'superseded') continue;
    const replacementAttemptId = attempt.resolution.replacementAttemptId;
    const replacement = attempts.get(replacementAttemptId);
    if (!replacement) {
      unresolvedReplacementAttempts.push({ attemptId, replacementAttemptId });
      continue;
    }
    if (replacement.pendingIndex <= attempt.resolutionIndex
      || Date.parse(replacement.pending.occurredAt) <= Date.parse(attempt.resolution.occurredAt)) {
      throw new Error(
        `Illegal replacement for attempt ${attemptId}: ${replacementAttemptId} must be a subsequent later pending attempt and cannot form a cycle`,
      );
    }
    for (const field of ['digestId', 'candidateIds', 'eventClusterIds']) {
      const original = attempt.pending[field];
      const next = replacement.pending[field];
      const matches = Array.isArray(original)
        ? original.length === next.length && original.every((value, index) => value === next[index])
        : original === next;
      if (!matches) {
        throw new Error(
          `Illegal replacement for attempt ${attemptId}: replacement ${field} must match`,
        );
      }
    }
  }
  return { attempts, unresolvedReplacementAttempts };
}

export function deriveDeliveryState(events) {
  if (!Array.isArray(events)) throw new TypeError('Delivery events must be an array');
  const { attempts, unresolvedReplacementAttempts } = buildAttemptState(events);
  const unresolvedAttemptIds = new Set(
    unresolvedReplacementAttempts.map(({ attemptId }) => attemptId),
  );
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
    if (!resolution || unresolvedAttemptIds.has(pending.attemptId)) {
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
  return {
    attempts,
    candidateStates,
    successfulDeliveries,
    unresolvedReplacementAttempts,
  };
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
  return appendDeliveryEvents([event], options);
}

export async function appendDeliveryEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError('Delivery events must be a non-empty array');
  }
  for (const event of events) validateDeliveryEvent(event);
  const ledgerPath = resolveDeliveryLedgerPath(options);
  await mkdir(dirname(ledgerPath), { recursive: true });
  const initial = await open(ledgerPath, 'a');
  await initial.close();
  const release = await lockfile.lock(ledgerPath, {
    realpath: false,
    retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
  });
  try {
    const existingEvents = await readDeliveryLedger({ ledgerPath });
    deriveDeliveryState([...existingEvents, ...events]);
    const handle = await open(ledgerPath, 'a');
    try {
      await handle.writeFile(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
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
  const { attempts, unresolvedReplacementAttempts } = buildAttemptState(events);
  const unresolvedAttemptIds = new Set(
    unresolvedReplacementAttempts.map(({ attemptId }) => attemptId),
  );
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const removableAttempts = new Set();
  for (const [attemptId, attempt] of attempts) {
    if (unresolvedAttemptIds.has(attemptId)) continue;
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
