import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import lockfile from 'proper-lockfile';

import { resolveRuntimePaths } from './lib/paths.js';

export const DELIVERY_LEDGER_SCHEMA_VERSION = '1.0';
export const MIN_LEDGER_RETENTION_DAYS = 90;
export const DEFAULT_LEDGER_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxEvents: 200_000,
  maxCandidateIds: 1_000,
  maxEventClusterIds: 1_000,
  maxProviderReceiptBytes: 512,
});

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

function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LEDGER_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Delivery ledger limit ${name} must be a non-negative integer`);
    }
  }
  return limits;
}

function validateHashIdArray(value, field, maximum) {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || !SHA256.test(entry))
    || new Set(value).size !== value.length) {
    throw new TypeError(
      `Delivery event ${field} must be an array of unique lowercase SHA-256 identifiers`,
    );
  }
  if (value.length > maximum) {
    throw new RangeError(`Delivery event ${field} exceeds the ${maximum}-item limit`);
  }
}

export function validateDeliveryEvent(event, { limits: limitOverrides } = {}) {
  const limits = resolveLimits(limitOverrides);
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
    validateHashIdArray(event.candidateIds, 'candidateIds', limits.maxCandidateIds);
    validateHashIdArray(event.eventClusterIds, 'eventClusterIds', limits.maxEventClusterIds);
    if (!['stdout', 'telegram', 'email'].includes(event.destinationType)) {
      throw new TypeError('Pending delivery event destinationType must be stdout, telegram, or email');
    }
    if (typeof event.messageHash !== 'string' || !SHA256.test(event.messageHash)) {
      throw new TypeError('Pending delivery event messageHash must be a lowercase SHA-256 digest');
    }
  }
  if (event.type === 'delivered') {
    requireString(event.providerReceipt, 'providerReceipt');
    if (/[\u0000-\u001f\u007f]/u.test(event.providerReceipt)
      || Buffer.byteLength(event.providerReceipt, 'utf8') > limits.maxProviderReceiptBytes
      || /\bBearer\s+\S+|\b(?:token|password|secret|api[_ -]?key)\s*[:=]/iu.test(event.providerReceipt)) {
      throw new TypeError('Delivery event providerReceipt must be a bounded opaque string without control characters');
    }
  }
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

function buildAttemptState(events, options = {}) {
  const attempts = new Map();
  for (const [index, event] of events.entries()) {
    validateDeliveryEvent(event, options);
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
    for (const field of ['digestId', 'frequency', 'candidateIds', 'eventClusterIds']) {
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

export function deriveDeliveryState(events, options = {}) {
  if (!Array.isArray(events)) throw new TypeError('Delivery events must be an array');
  const limits = resolveLimits(options.limits);
  if (events.length > limits.maxEvents) {
    throw new RangeError(`Delivery ledger exceeds the ${limits.maxEvents}-event limit`);
  }
  const { attempts, unresolvedReplacementAttempts } = buildAttemptState(events, { limits });
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

async function fsyncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureLedgerFile(ledgerPath) {
  await mkdir(dirname(ledgerPath), { recursive: true });
  try {
    const handle = await open(ledgerPath, 'ax');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(dirname(ledgerPath));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function withLedgerLock(ledgerPath, callback) {
  await ensureLedgerFile(ledgerPath);
  const release = await lockfile.lock(ledgerPath, {
    realpath: false,
    retries: { retries: 20, factor: 1.25, minTimeout: 5, maxTimeout: 250 },
  });
  try {
    return await callback();
  } finally {
    await release();
  }
}

async function readDeliveryLedgerUnlocked(ledgerPath, options = {}) {
  const limits = resolveLimits(options.limits);
  const metadata = await stat(ledgerPath);
  if (metadata.size > limits.maxFileBytes) {
    throw new RangeError(`Delivery ledger file exceeds the ${limits.maxFileBytes}-byte limit`);
  }
  if (metadata.size === 0) return [];
  const handle = await open(ledgerPath, 'r');
  try {
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, metadata.size - 1);
    if (tail[0] !== 0x0a) {
      throw new Error(`Invalid or truncated delivery ledger ${ledgerPath}: missing final newline`);
    }
  } finally {
    await handle.close();
  }

  const events = [];
  let lineNumber = 0;
  let pending = Buffer.alloc(0);
  const parseLine = (lineBuffer) => {
    lineNumber += 1;
    const line = lineBuffer.toString('utf8');
    if (line.trim().length === 0) {
      throw new Error(`Invalid delivery ledger ${ledgerPath} at line ${lineNumber}: blank event`);
    }
    if (events.length >= limits.maxEvents) {
      throw new RangeError(`Delivery ledger exceeds the ${limits.maxEvents}-event limit`);
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid delivery ledger ${ledgerPath} at line ${lineNumber}: ${error.message}`);
    }
  };
  for await (const chunk of createReadStream(ledgerPath)) {
    let offset = 0;
    for (let newline = chunk.indexOf(0x0a, offset);
      newline !== -1;
      newline = chunk.indexOf(0x0a, offset)) {
      const segment = chunk.subarray(offset, newline);
      if (pending.length + segment.length > limits.maxLineBytes) {
        throw new RangeError(`Delivery ledger line ${lineNumber + 1} exceeds the line byte limit`);
      }
      parseLine(pending.length === 0 ? segment : Buffer.concat([pending, segment]));
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    const remainder = chunk.subarray(offset);
    if (pending.length + remainder.length > limits.maxLineBytes) {
      throw new RangeError(`Delivery ledger line ${lineNumber + 1} exceeds the line byte limit`);
    }
    if (remainder.length > 0) {
      pending = pending.length === 0 ? Buffer.from(remainder) : Buffer.concat([pending, remainder]);
    }
  }
  if (pending.length !== 0) throw new Error(`Invalid or truncated delivery ledger ${ledgerPath}`);
  deriveDeliveryState(events, { limits });
  return events;
}

export async function readDeliveryLedger(options = {}) {
  const ledgerPath = resolveDeliveryLedgerPath(options);
  return withLedgerLock(ledgerPath, () => readDeliveryLedgerUnlocked(ledgerPath, options));
}

export async function appendDeliveryEvent(event, options = {}) {
  return appendDeliveryEvents([event], options);
}

function overlappingCandidateIds(first, second) {
  const secondIds = new Set(second);
  return first.filter((candidateId) => secondIds.has(candidateId));
}

function assertPendingReservations(existingEvents, appendedEvents, options = {}) {
  const existing = buildAttemptState(existingEvents, options).attempts;
  const combined = buildAttemptState([...existingEvents, ...appendedEvents], options).attempts;
  const appendedPending = appendedEvents.filter(({ type }) => type === 'pending');

  for (const pendingEvent of appendedPending) {
    for (const [attemptId, prior] of existing) {
      const overlap = overlappingCandidateIds(
        pendingEvent.candidateIds,
        prior.pending.candidateIds,
      );
      if (overlap.length === 0) continue;
      const priorResolution = prior.resolution?.type;
      if (priorResolution === 'failed') continue;
      const finalResolution = combined.get(attemptId)?.resolution;
      const isReplacement = finalResolution?.type === 'superseded'
        && finalResolution.replacementAttemptId === pendingEvent.attemptId;
      if (isReplacement) continue;
      if (priorResolution === 'superseded'
        && combined.has(prior.resolution.replacementAttemptId)) continue;
      throw new Error(
        `Candidate reservation conflict: ${overlap.join(', ')} is already reserved by attempt ${attemptId}`,
      );
    }
  }

  for (let index = 0; index < appendedPending.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < appendedPending.length; otherIndex += 1) {
      const first = appendedPending[index];
      const second = appendedPending[otherIndex];
      const overlap = overlappingCandidateIds(first.candidateIds, second.candidateIds);
      if (overlap.length === 0) continue;
      const firstResolution = combined.get(first.attemptId)?.resolution;
      if (firstResolution?.type === 'superseded'
        && firstResolution.replacementAttemptId === second.attemptId) continue;
      throw new Error(
        `Candidate reservation conflict: ${overlap.join(', ')} occurs in multiple new attempts`,
      );
    }
  }
}

export async function appendDeliveryEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError('Delivery events must be a non-empty array');
  }
  const limits = resolveLimits(options.limits);
  for (const event of events) validateDeliveryEvent(event, { limits });
  const ledgerPath = resolveDeliveryLedgerPath(options);
  return withLedgerLock(ledgerPath, async () => {
    const existingEvents = await readDeliveryLedgerUnlocked(ledgerPath, { limits });
    const combined = [...existingEvents, ...events];
    deriveDeliveryState(combined, { limits });
    assertPendingReservations(existingEvents, events, { limits });
    const serialized = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > limits.maxFileBytes
      || (await stat(ledgerPath)).size + Buffer.byteLength(serialized, 'utf8') > limits.maxFileBytes) {
      throw new RangeError(`Delivery ledger append exceeds the ${limits.maxFileBytes}-byte file limit`);
    }
    for (const [index, line] of serialized.trimEnd().split('\n').entries()) {
      if (Buffer.byteLength(line, 'utf8') > limits.maxLineBytes) {
        throw new RangeError(`Delivery ledger appended line ${index + 1} exceeds the line byte limit`);
      }
    }
    const handle = await open(ledgerPath, 'a');
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return deriveDeliveryState(combined, { limits });
  });
}

export async function reservePendingAttempt(event, options = {}) {
  if (event?.type !== 'pending') {
    throw new TypeError('reservePendingAttempt requires a pending delivery event');
  }
  return appendDeliveryEvent(event, options);
}

export function selectRetainedDeliveryEvents(events, {
  now = new Date().toISOString(),
  retentionDays = MIN_LEDGER_RETENTION_DAYS,
  activeCandidateIds = [],
  limits,
} = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_LEDGER_RETENTION_DAYS) {
    throw new RangeError(`Delivery ledger retention must be at least ${MIN_LEDGER_RETENTION_DAYS} days`);
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid timestamp');
  const { attempts, unresolvedReplacementAttempts } = buildAttemptState(events, { limits });
  const unresolvedAttemptIds = new Set(
    unresolvedReplacementAttempts.map(({ attemptId }) => attemptId),
  );
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const activeIds = new Set(activeCandidateIds);
  const retainedAttempts = new Set();
  const latestAnchors = new Map();
  for (const [attemptId, attempt] of attempts) {
    const resolutionTime = Date.parse(attempt.resolution?.occurredAt ?? attempt.pending.occurredAt);
    if (Date.parse(attempt.pending.occurredAt) >= cutoff || resolutionTime >= cutoff
      || !attempt.resolution || unresolvedAttemptIds.has(attemptId)
      || attempt.pending.candidateIds.some((candidateId) => activeIds.has(candidateId))) {
      retainedAttempts.add(attemptId);
    }
    if (attempt.resolution?.type === 'delivered') {
      const prior = latestAnchors.get(attempt.pending.frequency);
      if (!prior || resolutionTime > prior.time) {
        latestAnchors.set(attempt.pending.frequency, { attemptId, time: resolutionTime });
      }
    }
  }
  for (const { attemptId } of latestAnchors.values()) retainedAttempts.add(attemptId);
  return events.filter((event) => retainedAttempts.has(event.attemptId));
}

export async function compactDeliveryLedger(options = {}) {
  const ledgerPath = resolveDeliveryLedgerPath(options);
  const limits = resolveLimits(options.limits);
  return withLedgerLock(ledgerPath, async () => {
    const events = await readDeliveryLedgerUnlocked(ledgerPath, { limits });
    const retained = selectRetainedDeliveryEvents(events, {
      now: options.now,
      retentionDays: options.retentionDays,
      activeCandidateIds: options.activeCandidateIds,
      limits,
    });
    deriveDeliveryState(retained, { limits });
    const temporaryPath = `${ledgerPath}.compact-${process.pid}-${Date.now()}`;
    const serialized = retained.length === 0
      ? ''
      : `${retained.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const handle = await open(temporaryPath, 'wx');
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, ledgerPath);
      await fsyncDirectory(dirname(ledgerPath));
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    return {
      retainedEvents: retained.length,
      removedEvents: events.length - retained.length,
    };
  });
}
