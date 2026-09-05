import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

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
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const LOCAL_LEDGER_LOCKS = new Map();

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

function validateProviderReceipt(receipt, limits) {
  if (typeof receipt === 'string') {
    requireString(receipt, 'providerReceipt');
  } else if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new TypeError('Delivery event providerReceipt must be a legacy string or receipt object');
  } else if (receipt.type === 'stdout') {
    if (Object.keys(receipt).length !== 1) {
      throw new TypeError('stdout providerReceipt contains unsupported fields');
    }
  } else if (receipt.type === 'telegram') {
    const legacyIds = Object.keys(receipt).sort().join(',') === 'messageIds,type'
      && Array.isArray(receipt.messageIds) && receipt.messageIds.length > 0
      && receipt.messageIds.length <= 100
      && receipt.messageIds.every((value) => Number.isSafeInteger(value) && value >= 0);
    const aggregate = Object.keys(receipt).sort().join(',')
        === 'firstMessageId,lastMessageId,messageCount,type'
      && Number.isSafeInteger(receipt.messageCount) && receipt.messageCount > 0
      && Number.isSafeInteger(receipt.firstMessageId) && receipt.firstMessageId >= 0
      && Number.isSafeInteger(receipt.lastMessageId) && receipt.lastMessageId >= 0;
    if (!legacyIds && !aggregate) {
      throw new TypeError('telegram providerReceipt must contain a bounded aggregate receipt');
    }
  } else if (receipt.type === 'resend') {
    if (Object.keys(receipt).sort().join(',') !== 'id,type'
      || typeof receipt.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(receipt.id)) {
      throw new TypeError('resend providerReceipt must contain a safe id');
    }
  } else if (receipt.type === 'user-confirmed') {
    if (Object.keys(receipt).length !== 1) {
      throw new TypeError('user-confirmed providerReceipt contains unsupported fields');
    }
  } else {
    throw new TypeError('Delivery event providerReceipt has an unknown receipt type');
  }
  const serialized = typeof receipt === 'string' ? receipt : JSON.stringify(receipt);
  if (/[\u0000-\u001f\u007f]/u.test(serialized)
    || Buffer.byteLength(serialized, 'utf8') > limits.maxProviderReceiptBytes
    || /\bBearer\s+\S+|\b(?:token|password|secret|api[_ -]?key)\s*[:=]/iu.test(serialized)) {
    throw new TypeError('Delivery event providerReceipt must be bounded and non-secret');
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
    validateProviderReceipt(event.providerReceipt, limits);
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

async function requireSafeLedgerPath(path, { allowMissing = false } = {}) {
  const absolute = resolve(path);
  let current = sep;
  for (const component of absolute.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        const isMacOsVarAlias = current === '/var' && await realpath(current) === '/private/var';
        if (!isMacOsVarAlias) throw new Error('Delivery ledger path contains a symbolic link');
      }
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return absolute;
      throw error;
    }
  }
  return absolute;
}

async function fsyncDirectory(path) {
  await requireSafeLedgerPath(path);
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureLedgerFile(ledgerPath) {
  const absolute = resolve(ledgerPath);
  await requireSafeLedgerPath(dirname(absolute), { allowMissing: true });
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await requireSafeLedgerPath(dirname(absolute));
  await requireSafeLedgerPath(absolute, { allowMissing: true });
  try {
    const handle = await open(
      absolute,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(dirname(absolute));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await requireSafeLedgerPath(absolute);
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) throw new Error('Delivery ledger must be a regular file');
  }
}

async function withLedgerLock(ledgerPath, callback, options = {}) {
  const absolute = resolve(ledgerPath);
  const previous = LOCAL_LEDGER_LOCKS.get(absolute) ?? Promise.resolve();
  let releaseLocal;
  const gate = new Promise((resolveGate) => { releaseLocal = resolveGate; });
  const tail = previous.catch(() => {}).then(() => gate);
  LOCAL_LEDGER_LOCKS.set(absolute, tail);
  await previous.catch(() => {});
  let release;
  try {
    await ensureLedgerFile(absolute);
    await requireSafeLedgerPath(`${absolute}.lock`, { allowMissing: true });
    release = await lockfile.lock(absolute, {
      realpath: false,
      retries: { retries: 20, factor: 1.25, minTimeout: 5, maxTimeout: 250 },
    });
    await requireSafeLedgerPath(absolute);
    await requireSafeLedgerPath(`${absolute}.lock`);
    const { recoverDeliveryLedgerBeforeRead } = await import('./delivery-outbox.js');
    await recoverDeliveryLedgerBeforeRead(absolute, options);
    return await callback();
  } finally {
    if (release) await release();
    releaseLocal();
    if (LOCAL_LEDGER_LOCKS.get(absolute) === tail) LOCAL_LEDGER_LOCKS.delete(absolute);
  }
}

async function readDeliveryLedgerUnlocked(ledgerPath, options = {}) {
  const limits = resolveLimits(options.limits);
  await requireSafeLedgerPath(ledgerPath);
  const handle = await open(ledgerPath, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Delivery ledger must be a regular file');
    if (metadata.size > limits.maxFileBytes) {
      throw new RangeError(`Delivery ledger file exceeds the ${limits.maxFileBytes}-byte limit`);
    }
    if (metadata.size === 0) return [];
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, metadata.size - 1);
    if (tail[0] !== 0x0a) {
      throw new Error(`Invalid or truncated delivery ledger ${ledgerPath}: missing final newline`);
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
      try { events.push(JSON.parse(line)); }
      catch (error) {
        throw new Error(`Invalid delivery ledger ${ledgerPath} at line ${lineNumber}: ${error.message}`);
      }
    };
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
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
  } finally {
    await handle.close();
  }
}

export async function readDeliveryLedger(options = {}) {
  const ledgerPath = resolveDeliveryLedgerPath(options);
  return withLedgerLock(ledgerPath, async () => {
    const events = await readDeliveryLedgerUnlocked(ledgerPath, options);
    if (options.transaction?.reconcile) {
      await options.transaction.reconcile(events);
    } else if (options.reconcileOutbox !== false) {
      const { reconcileDeliveryTransactionsForEvents } = await import('./delivery-outbox.js');
      await reconcileDeliveryTransactionsForEvents(events, options);
    }
    return events;
  }, options);
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
    await options.transaction?.reconcile?.(existingEvents);
    deriveDeliveryState([...existingEvents, ...events], { limits });
    assertPendingReservations(existingEvents, events, { limits });
    let prepared;
    let ledgerAppended = false;
    let appendStarted = false;
    try {
      const appendPlan = await createLedgerAppendPlan(ledgerPath, events, limits);
      prepared = await options.transaction?.prepare?.(appendPlan);
      await options.transaction?.appending?.(prepared);
      appendStarted = true;
      const state = await appendDeliveryEventsUnlocked(
        ledgerPath, events, limits, existingEvents, appendPlan, options,
      );
      ledgerAppended = true;
      await options.transaction?.ledgerAppended?.(prepared);
      await options.transaction?.commit?.(prepared);
      return state;
    } catch (error) {
      try {
        await options.transaction?.rollback?.(prepared, { ledgerAppended, appendStarted });
      } catch { /* recovery owns cleanup */ }
      throw error;
    }
  }, options);
}

export async function reservePendingAttempt(event, options = {}) {
  if (event?.type !== 'pending') {
    throw new TypeError('reservePendingAttempt requires a pending delivery event');
  }
  const limits = resolveLimits(options.limits);
  validateDeliveryEvent(event, { limits });
  const ledgerPath = resolveDeliveryLedgerPath(options);
  return withLedgerLock(ledgerPath, async () => {
    let prepared;
    let ledgerAppended = false;
    let appendStarted = false;
    try {
      const existingEvents = await readDeliveryLedgerUnlocked(ledgerPath, { limits });
      await options.transaction?.reconcile?.(existingEvents);
      const combined = [...existingEvents, event];
      deriveDeliveryState(combined, { limits });
      assertPendingReservations(existingEvents, [event], { limits });
      const appendPlan = await createLedgerAppendPlan(ledgerPath, [event], limits);
      prepared = await options.transaction?.prepare?.(appendPlan);
      await options.transaction?.appending?.(prepared);
      appendStarted = true;
      const state = await appendDeliveryEventsUnlocked(
        ledgerPath, [event], limits, existingEvents, appendPlan, options,
      );
      ledgerAppended = true;
      await options.transaction?.ledgerAppended?.(prepared);
      await options.transaction?.commit?.(prepared);
      return state;
    } catch (error) {
      try {
        await options.transaction?.rollback?.(prepared, { ledgerAppended, appendStarted });
      } catch { /* recovery owns cleanup */ }
      throw error;
    }
  }, options);
}

async function createLedgerAppendPlan(ledgerPath, events, limits) {
  const serialized = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  await requireSafeLedgerPath(ledgerPath);
  const metadataHandle = await open(ledgerPath, fsConstants.O_RDONLY | NO_FOLLOW);
  let preAppendOffset;
  try {
    const metadata = await metadataHandle.stat();
    if (!metadata.isFile()) throw new Error('Delivery ledger must be a regular file');
    preAppendOffset = metadata.size;
  } finally {
    await metadataHandle.close();
  }
  if (Buffer.byteLength(serialized, 'utf8') > limits.maxFileBytes
    || preAppendOffset + Buffer.byteLength(serialized, 'utf8') > limits.maxFileBytes) {
    throw new RangeError(`Delivery ledger append exceeds the ${limits.maxFileBytes}-byte file limit`);
  }
  for (const [index, line] of serialized.trimEnd().split('\n').entries()) {
    if (Buffer.byteLength(line, 'utf8') > limits.maxLineBytes) {
      throw new RangeError(`Delivery ledger appended line ${index + 1} exceeds the line byte limit`);
    }
  }
  return { preAppendOffset, serialized };
}

async function appendDeliveryEventsUnlocked(
  ledgerPath, events, limits, existingInput, appendPlanInput, options = {},
) {
  const existingEvents = existingInput
    ?? await readDeliveryLedgerUnlocked(ledgerPath, { limits });
  const combined = [...existingEvents, ...events];
  deriveDeliveryState(combined, { limits });
  assertPendingReservations(existingEvents, events, { limits });
  const appendPlan = appendPlanInput ?? await createLedgerAppendPlan(ledgerPath, events, limits);
  const { serialized } = appendPlan;
  if (options.appendLedgerImpl) {
    if (typeof options.appendLedgerImpl !== 'function') {
      throw new TypeError('appendLedgerImpl must be a function');
    }
    await options.appendLedgerImpl({
      ledgerPath, bytes: Buffer.from(serialized),
      preAppendOffset: appendPlan.preAppendOffset,
    });
    return deriveDeliveryState(combined, { limits });
  }
  const handle = await open(ledgerPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | NO_FOLLOW);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return deriveDeliveryState(combined, { limits });
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
    await requireSafeLedgerPath(temporaryPath, { allowMissing: true });
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await requireSafeLedgerPath(ledgerPath);
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
  }, options);
}
