#!/usr/bin/env node

import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'dotenv';

import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import { loadActiveDigest } from './delivery-message.js';
import { reserveOutboxAttempt, resolveOutboxAttempt } from './delivery-outbox.js';
import { deliverWithProvider, validateDestination } from './delivery-providers.js';

const DEFAULT_USER_DIR = join(homedir(), '.follow-builders');

export async function loadActiveDigestMessage(activePath, options = {}) {
  return (await loadActiveDigest(activePath, options)).message;
}

function parseOptions(argv) {
  return parseCommandLine(argv, {
    options: { active: { type: 'string' }, destination: { type: 'string' } },
    validate({ values, positionals }) {
      if (positionals.length) throw new CommandLineUsageError('unexpected positional arguments');
      if (!values.active) throw new CommandLineUsageError('--active is required');
      if (!isAbsolute(values.active)) throw new CommandLineUsageError('--active must be absolute');
      if (values.destination && !['stdout', 'telegram', 'email'].includes(values.destination)) {
        throw new CommandLineUsageError('--destination must be stdout, telegram, or email');
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
  ledgerPath, outboxDir, transactionDir, fsImpl, transport, providerStdout = process.stderr,
  timeoutMs = 15_000,
  logger = () => {}, randomUUID = systemRandomUUID, now = () => new Date().toISOString(),
  reserveAttempt = reserveOutboxAttempt, resolveAttempt = resolveOutboxAttempt,
} = {}) {
  const loaded = await loadActiveDigest(activePath);
  if (loaded.message.trim().length === 0) {
    return { status: 'skipped', reason: 'no-content', digestId: loaded.digestId };
  }
  const validated = validateDestination(destination, credentials);
  const attemptId = randomUUID();
  if (typeof attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(attemptId)) {
    throw new Error('Generated delivery attemptId is invalid');
  }
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

export async function main({
  argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr,
  configPath = join(DEFAULT_USER_DIR, 'config.json'), envPath = join(DEFAULT_USER_DIR, '.env'),
  env = process.env, ledgerPath, outboxDir, transactionDir, fsImpl,
  transport, providerStdout = stderr,
  randomUUID = systemRandomUUID, now,
} = {}) {
  let options;
  try { options = parseOptions(argv); }
  catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return error.exitCode ?? EX_USAGE;
  }
  try {
    const config = await loadConfig(configPath);
    const credentials = await loadCredentials(envPath, env);
    const result = await deliverActiveDigest({
      activePath: options.active,
      destination: { ...(config.delivery ?? {}), method: options.destination ?? config.delivery?.method ?? 'stdout' },
      credentials,
      ledgerPath, outboxDir, transactionDir, fsImpl,
      transport, providerStdout, randomUUID, now,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'delivered' || result.status === 'skipped' ? 0 : 1;
  } catch {
    stdout.write(`${JSON.stringify({ status: 'delivery-failed', reason: 'delivery-not-started' })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
