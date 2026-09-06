#!/usr/bin/env node

import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'dotenv';

import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import { loadActiveDigest } from './delivery-message.js';
import {
  claimReplacementOutboxAttempt,
  DeliveryClaimUncertainError,
  readOutboxAttempt,
  reserveOutboxAttempt,
  resolveOutboxAttempt,
  withDeliveryAttemptLock,
} from './delivery-outbox.js';
import { deliverWithProvider, validateDestination } from './delivery-providers.js';
import { AtomicWriteCommittedError, writeJsonAtomic } from './prepare-digest.js';
import { authorizeDestination, authorizeSchedule } from './schedule-gate.js';

const DEFAULT_USER_DIR = join(homedir(), '.follow-builders');

export async function loadActiveDigestMessage(activePath, options = {}) {
  return (await loadActiveDigest(activePath, options)).message;
}

function parseOptions(argv) {
  return parseCommandLine(argv, {
    options: {
      active: { type: 'string' }, destination: { type: 'string' },
      'result-out': { type: 'string' },
      'resume-attempt': { type: 'string' },
      scheduled: { type: 'boolean' },
      'confirm-destination': { type: 'boolean' },
    },
    validate({ values, positionals }) {
      if (positionals.length) throw new CommandLineUsageError('unexpected positional arguments');
      if (!values.active) throw new CommandLineUsageError('--active is required');
      if (!isAbsolute(values.active)) throw new CommandLineUsageError('--active must be absolute');
      if (values.destination && !['stdout', 'telegram', 'email'].includes(values.destination)) {
        throw new CommandLineUsageError('--destination must be stdout, telegram, or email');
      }
      if (values['result-out'] && !isAbsolute(values['result-out'])) {
        throw new CommandLineUsageError('--result-out must be absolute');
      }
      if (values['resume-attempt']
        && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(values['resume-attempt'])) {
        throw new CommandLineUsageError('--resume-attempt must be a safe identifier');
      }
    },
  }).values;
}

async function loadConfig(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Delivery configuration could not be read');
  }
}

async function loadCredentials(path, inherited) {
  try { return { ...inherited, ...parse(await readFile(path)) }; }
  catch (error) {
    if (error?.code === 'ENOENT') return { ...inherited };
    throw new Error('Delivery credentials could not be read');
  }
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString();
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== 'string' || Number.isNaN(Date.parse(text))
    || new Date(text).toISOString() !== text) {
    throw new Error('Delivery clock is invalid');
  }
  return text;
}

export async function deliverActiveDigest({
  activePath, destination, credentials = process.env,
  config = {}, scheduled = false, confirmDestination = false,
  ledgerPath, outboxDir, transactionDir, fsImpl, transport, providerStdout = process.stderr,
  timeoutMs = 15_000,
  logger = () => {}, randomUUID = systemRandomUUID, now = () => new Date().toISOString(),
  reserveAttempt = reserveOutboxAttempt, resolveAttempt = resolveOutboxAttempt,
} = {}) {
  const gateNow = timestamp(now);
  const gate = scheduled
    ? authorizeSchedule(config, { now: gateNow, destination })
    : authorizeDestination(config, { destination, confirmDestination, now: gateNow });
  if (!gate.authorized) throw new Error(gate.status);
  const loaded = await loadActiveDigest(activePath);
  if (scheduled && !authorizeSchedule(config, {
    now: gateNow, frequency: loaded.frequency, destination,
  }).authorized) {
    throw new Error('schedule-not-authorized');
  }
  if (loaded.message.trim().length === 0) {
    return { status: 'skipped', reason: 'no-content', digestId: loaded.digestId };
  }
  const validated = validateDestination(destination, credentials);
  const attemptId = randomUUID();
  if (typeof attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(attemptId)) {
    throw new Error('Generated delivery attemptId is invalid');
  }
  return withDeliveryAttemptLock(attemptId, async () => {
    const createdAt = timestamp(now);
    const attempt = {
      schemaVersion: '1.0', type: 'pending', occurredAt: createdAt, attemptId,
      digestId: loaded.digestId, frequency: loaded.frequency,
      candidateIds: loaded.candidateIds, eventClusterIds: loaded.eventClusterIds,
      destinationType: validated.method,
      messageHash: createHash('sha256').update(loaded.message).digest('hex'),
    };
    try {
      await reserveAttempt(attempt, { ledgerPath, outboxDir, transactionDir, fsImpl, randomUUID });
    } catch (error) {
      if (error?.code === 'DELIVERY_RESERVATION_UNCERTAIN') {
        return {
          status: 'delivery-uncertain', reason: 'reservation-uncertain',
          method: validated.method, attemptId, digestId: loaded.digestId,
        };
      }
      throw error;
    }
    return handoffReservedDigest(loaded, validated, attemptId, {
      ledgerPath, outboxDir, transactionDir, fsImpl, transport, providerStdout,
      timeoutMs, logger, randomUUID, now, resolveAttempt,
    });
  }, { ledgerPath, outboxDir, transactionDir, fsImpl, randomUUID });
}

async function handoffReservedDigest(loaded, validated, attemptId, {
  ledgerPath, outboxDir, transactionDir, fsImpl, transport, providerStdout,
  timeoutMs = 15_000, logger = () => {}, randomUUID = systemRandomUUID,
  now = () => new Date().toISOString(), resolveAttempt = resolveOutboxAttempt,
} = {}) {
  let outcome;
  try {
    outcome = await deliverWithProvider(loaded.message, validated, {
      transport, providerStdout, logger,
      timeoutMs,
    });
  } catch {
    return {
      status: 'delivery-uncertain', method: validated.method,
      attemptId, digestId: loaded.digestId,
    };
  }
  if (outcome.status === 'uncertain') {
    return {
      status: 'delivery-uncertain', method: validated.method,
      attemptId, digestId: loaded.digestId,
    };
  }
  const resolvedAt = timestamp(now);
  if (outcome.status === 'failed') {
    try {
      await resolveAttempt(attemptId, {
        status: 'failed', occurredAt: resolvedAt, reasonCode: outcome.reasonCode,
      }, { ledgerPath, outboxDir, transactionDir, fsImpl, randomUUID });
    } catch {
      return {
        status: 'delivery-uncertain', method: validated.method,
        attemptId, digestId: loaded.digestId,
      };
    }
    return {
      status: 'delivery-failed', method: validated.method,
      attemptId, digestId: loaded.digestId,
    };
  }
  try {
    await resolveAttempt(attemptId, {
      status: 'delivered', occurredAt: resolvedAt, receipt: outcome.receipt,
    }, { ledgerPath, outboxDir, transactionDir, fsImpl, randomUUID });
  } catch {
    return {
      status: 'delivery-uncertain', method: validated.method,
      attemptId, digestId: loaded.digestId,
    };
  }
  return { status: 'delivered', method: validated.method, attemptId, digestId: loaded.digestId };
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function resumeActiveDigestDeliveryUnlocked({
  activePath, attemptId, destination, credentials = process.env,
  config = {}, scheduled = false, confirmDestination = false,
  ledgerPath, outboxDir, transactionDir, fsImpl, transport, providerStdout = process.stderr,
  timeoutMs = 15_000, logger = () => {}, randomUUID = systemRandomUUID,
  now = () => new Date().toISOString(), resolveAttempt = resolveOutboxAttempt,
  claimAttempt = claimReplacementOutboxAttempt,
} = {}) {
  const gateNow = timestamp(now);
  const initialGate = scheduled
    ? authorizeSchedule(config, { now: gateNow, destination })
    : authorizeDestination(config, { destination, confirmDestination, now: gateNow });
  if (!initialGate.authorized) throw new Error(initialGate.status);
  const loaded = await loadActiveDigest(activePath);
  if (scheduled && !authorizeSchedule(config, {
    now: gateNow, frequency: loaded.frequency, destination,
  }).authorized) {
    throw new Error('schedule-not-authorized');
  }
  const validated = validateDestination(destination, credentials);
  const record = await readOutboxAttempt(attemptId, {
    ledgerPath, outboxDir, transactionDir, fsImpl, randomUUID,
  });
  if (record.status !== 'pending') throw new Error('Resume attempt is already terminal');
  const attempt = record.attempt;
  const matches = attempt.digestId === loaded.digestId
    && attempt.frequency === loaded.frequency
    && attempt.destinationType === validated.method
    && attempt.messageHash === createHash('sha256').update(loaded.message).digest('hex')
    && sameValues(attempt.candidateIds, loaded.candidateIds)
    && sameValues(attempt.eventClusterIds, loaded.eventClusterIds);
  if (!matches) throw new Error('Resume attempt does not match the active digest and destination');
  const claimedAt = timestamp(now);
  const claimId = randomUUID();
  if (typeof claimId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(claimId)) {
    throw new Error('Generated delivery claimId is invalid');
  }
  try {
    await claimAttempt(attemptId, { occurredAt: claimedAt, claimId }, {
      ledgerPath, outboxDir, transactionDir, fsImpl, randomUUID,
    });
  } catch (error) {
    if (error instanceof DeliveryClaimUncertainError || error?.code === 'DELIVERY_CLAIM_UNCERTAIN') {
      return {
        status: 'delivery-uncertain', reason: 'claim-uncertain', method: validated.method,
        attemptId, digestId: loaded.digestId,
      };
    }
    throw error;
  }
  return handoffReservedDigest(loaded, validated, attemptId, {
    ledgerPath, outboxDir, transactionDir, fsImpl, transport, providerStdout,
    timeoutMs, logger, randomUUID, now, resolveAttempt,
  });
}

export async function resumeActiveDigestDelivery(options = {}) {
  return withDeliveryAttemptLock(options.attemptId, () => (
    resumeActiveDigestDeliveryUnlocked(options)
  ), options);
}

export async function main({
  argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr,
  configPath = join(DEFAULT_USER_DIR, 'config.json'), envPath = join(DEFAULT_USER_DIR, '.env'),
  env = process.env, ledgerPath, outboxDir, transactionDir, fsImpl,
  transport, providerStdout,
  randomUUID = systemRandomUUID, now,
  deliverImpl = deliverActiveDigest, resumeImpl = resumeActiveDigestDelivery,
  writeResult = writeJsonAtomic,
} = {}) {
  let options;
  try { options = parseOptions(argv); }
  catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return error.exitCode ?? EX_USAGE;
  }
  let outcome;
  try {
    const config = await loadConfig(configPath);
    const destination = {
      ...(config.delivery ?? {}), method: options.destination ?? config.delivery?.method ?? 'stdout',
    };
    if (destination.method === 'stdout' && !options['result-out']) {
      stderr.write('usage: --result-out is required for stdout delivery\n');
      return EX_USAGE;
    }
    const gate = options.scheduled
      ? authorizeSchedule(config, { now: timestamp(now), destination })
      : authorizeDestination(config, {
        destination, confirmDestination: options['confirm-destination'] ?? false,
        now: timestamp(now),
      });
    if (!gate.authorized) {
      outcome = { status: gate.status, reasons: gate.reasons };
    } else {
      const credentials = await loadCredentials(envPath, env);
      const delivery = options['resume-attempt'] ? resumeImpl : deliverImpl;
      outcome = await delivery({
        activePath: options.active,
        attemptId: options['resume-attempt'],
        destination,
        config, scheduled: options.scheduled ?? false,
        confirmDestination: options['confirm-destination'] ?? false,
        credentials,
        ledgerPath, outboxDir, transactionDir, fsImpl,
        transport,
        providerStdout: providerStdout ?? (destination.method === 'stdout' ? stdout : stderr),
        randomUUID, now,
      });
    }
  } catch {
    outcome = { status: 'delivery-failed', reason: 'delivery-not-started' };
  }

  if (options['result-out']) {
    try {
      await writeResult(options['result-out'], outcome, {
        fsImpl, randomUUID, label: 'delivery result',
      });
    } catch (error) {
      const resultPersistence = error instanceof AtomicWriteCommittedError
        ? 'committed-but-uncertain' : 'failed';
      stderr.write(`${JSON.stringify({ ...outcome, resultPersistence })}\n`);
      return 1;
    }
  } else {
    stdout.write(`${JSON.stringify(outcome)}\n`);
  }
  if (outcome.status === 'delivered' || outcome.status === 'skipped') {
    return 0;
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
