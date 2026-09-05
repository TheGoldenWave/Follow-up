#!/usr/bin/env node

import { randomUUID as systemRandomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import {
  readOutboxAttempt,
  replaceOutboxAttempt,
  resolveOutboxAttempt,
} from './delivery-outbox.js';

const ACTIONS = new Set(['delivered', 'retry', 'suppress']);
const DESTINATIONS = new Set(['stdout', 'telegram', 'email']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function timestamp(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString();
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== 'string' || Number.isNaN(Date.parse(text))
    || new Date(text).toISOString() !== text) {
    throw new Error('Delivery clock is invalid');
  }
  return text;
}

function nextTimestamp(value) {
  return new Date(Date.parse(value) + 1).toISOString();
}

function parseOptions(argv) {
  return parseCommandLine(argv, {
    allowPositionals: true,
    options: {
      'confirm-external-retry': { type: 'boolean' },
      destination: { type: 'string' },
    },
    validate({ values, positionals }) {
      if (positionals.length !== 2) {
        throw new CommandLineUsageError('<attempt-id> and delivered|retry|suppress are required');
      }
      if (!SAFE_ID.test(positionals[0])) throw new CommandLineUsageError('attempt-id is invalid');
      if (!ACTIONS.has(positionals[1])) {
        throw new CommandLineUsageError('action must be delivered, retry, or suppress');
      }
      if (positionals[1] === 'retry' && !values['confirm-external-retry']) {
        throw new CommandLineUsageError('retry requires --confirm-external-retry due to duplicate risk');
      }
      if (positionals[1] !== 'retry'
        && (values['confirm-external-retry'] || values.destination)) {
        throw new CommandLineUsageError('retry options are only valid with retry');
      }
      if (values.destination && !DESTINATIONS.has(values.destination)) {
        throw new CommandLineUsageError('--destination must be stdout, telegram, or email');
      }
    },
  });
}

export async function resolveUncertainDelivery(attemptId, action, {
  confirmExternalRetry = false,
  destinationType,
  replacementAttemptId,
  randomUUID = systemRandomUUID,
  now = () => new Date().toISOString(),
  ...paths
} = {}) {
  if (!SAFE_ID.test(attemptId) || !ACTIONS.has(action)) {
    throw new TypeError('Invalid delivery resolution request');
  }
  const existing = await readOutboxAttempt(attemptId, paths).catch((error) => {
    if (error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT') {
      throw new Error('Delivery attempt was not found');
    }
    throw error;
  });
  if (existing.status !== 'pending') {
    throw new Error('Delivery attempt is already terminal; only unresolved pending attempts can be resolved');
  }
  const occurredAt = timestamp(now);
  if (action === 'delivered') {
    await resolveOutboxAttempt(attemptId, {
      status: 'delivered', occurredAt, receipt: { type: 'user-confirmed' },
    }, paths);
    return {
      status: 'resolved', action, attemptId, digestId: existing.attempt.digestId,
    };
  }
  if (action === 'suppress') {
    await resolveOutboxAttempt(attemptId, {
      status: 'assumed-delivered', occurredAt,
    }, paths);
    return {
      status: 'resolved', action, attemptId, digestId: existing.attempt.digestId,
    };
  }
  if (!confirmExternalRetry) {
    throw new Error('Retry requires --confirm-external-retry because external delivery has duplicate risk');
  }
  const nextAttemptId = replacementAttemptId ?? randomUUID();
  if (typeof nextAttemptId !== 'string' || !SAFE_ID.test(nextAttemptId)
    || nextAttemptId === attemptId) {
    throw new Error('Generated replacement attemptId is invalid');
  }
  const destination = destinationType ?? existing.attempt.destinationType;
  if (!DESTINATIONS.has(destination)) throw new Error('Replacement destination is invalid');
  const replacement = {
    ...existing.attempt,
    occurredAt: nextTimestamp(occurredAt),
    attemptId: nextAttemptId,
    destinationType: destination,
  };
  await replaceOutboxAttempt(attemptId, replacement, { occurredAt }, paths);
  return {
    status: 'retry-ready', action, attemptId, replacementAttemptId: nextAttemptId,
    digestId: existing.attempt.digestId, destination, duplicateRisk: true,
  };
}

export async function main({
  argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr,
  now, randomUUID, ledgerPath, outboxDir, transactionDir, fsImpl,
  resolveImpl = resolveUncertainDelivery,
} = {}) {
  let parsed;
  try {
    parsed = parseOptions(argv);
  } catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return error.exitCode ?? EX_USAGE;
  }
  const [attemptId, action] = parsed.positionals;
  try {
    const result = await resolveImpl(attemptId, action, {
      confirmExternalRetry: parsed.values['confirm-external-retry'] ?? false,
      destinationType: parsed.values.destination,
      now, randomUUID, ledgerPath, outboxDir, transactionDir, fsImpl,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    stderr.write(`${JSON.stringify({ status: 'resolution-failed', action, attemptId })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
