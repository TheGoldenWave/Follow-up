#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import { validateConfig } from './config-contract.js';

const FREQUENCIES = new Set(['daily', 'weekly']);
const WEEKDAYS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;

function strictTimestamp(value) {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function currentTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  const text = value instanceof Date ? value.toISOString() : value;
  return strictTimestamp(text) ? text : new Date().toISOString();
}

function validTimezone(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizedSchedule(config = {}) {
  if (config.schedule && typeof config.schedule === 'object' && !Array.isArray(config.schedule)) {
    return { ...config.schedule };
  }
  return {
    frequency: config.frequency,
    time: config.deliveryTime ?? config.time,
    timezone: config.timezone,
    weeklyDay: config.weeklyDay,
    approved: config.scheduleApproved,
    approvedAt: config.scheduleApprovedAt,
  };
}

function approvalReasons(prefix, approved, approvedAt, now) {
  const reasons = [];
  if (approved !== true) reasons.push(`${prefix}-not-approved`);
  if (approved === true) {
    if (!strictTimestamp(approvedAt)) reasons.push(`invalid-${prefix}-approval-time`);
    else if (Date.parse(approvedAt) > Date.parse(now)) reasons.push(`future-${prefix}-approval`);
  }
  return reasons;
}

function destinationReasons(delivery = {}) {
  const method = delivery.method ?? 'stdout';
  if (!['stdout', 'telegram', 'email'].includes(method)) return ['invalid-destination'];
  if (method === 'telegram'
      && (typeof delivery.chatId !== 'string' || delivery.chatId.trim().length === 0)) {
    return ['telegram-chat-id-required'];
  }
  if (method === 'email'
      && (typeof delivery.email !== 'string' || !EMAIL.test(delivery.email))) {
    return ['email-destination-required'];
  }
  return [];
}

function sameDestination(configured = {}, requested = {}) {
  const method = requested.method ?? configured.method ?? 'stdout';
  if ((configured.method ?? 'stdout') !== method) return false;
  if (method === 'telegram') return configured.chatId === requested.chatId;
  if (method === 'email') return configured.email === requested.email;
  return true;
}

export function authorizeDestination(config = {}, {
  destination = config.delivery ?? {}, confirmDestination = false,
  now = new Date().toISOString(),
} = {}) {
  const method = destination.method ?? config.delivery?.method ?? 'stdout';
  if (method === 'stdout') return { authorized: true, status: 'authorized', reasons: [] };
  const reasons = destinationReasons({ ...destination, method });
  const current = currentTimestamp(now);
  const configured = config.delivery ?? {};
  const persistentlyApproved = sameDestination(configured, { ...destination, method })
    && configured.approved === true;
  if (!confirmDestination && !persistentlyApproved) reasons.push('destination-not-approved');
  if (!confirmDestination && persistentlyApproved) {
    reasons.push(...approvalReasons('destination', true, configured.approvedAt, current));
  }
  return reasons.length === 0
    ? { authorized: true, status: 'authorized', reasons: [] }
    : { authorized: false, status: 'destination-not-authorized', reasons: [...new Set(reasons)] };
}

export function authorizeSchedule(config = {}, {
  now = new Date().toISOString(), frequency, destination,
} = {}) {
  const current = currentTimestamp(now);
  const schedule = normalizedSchedule(config);
  const delivery = config.delivery ?? {};
  const reasons = [];
  if (!validateConfig(config).valid) reasons.push('invalid-config');
  if (config.onboardingComplete !== true) reasons.push('onboarding-incomplete');
  if (!FREQUENCIES.has(schedule.frequency)) reasons.push('invalid-frequency');
  if (frequency !== undefined && frequency !== schedule.frequency) {
    reasons.push('schedule-frequency-mismatch');
  }
  if (!TIME.test(schedule.time ?? '')) reasons.push('invalid-time');
  if (!validTimezone(schedule.timezone)) reasons.push('invalid-timezone');
  if (schedule.frequency === 'weekly' && !WEEKDAYS.has(schedule.weeklyDay)) {
    reasons.push('weekly-day-required');
  }
  reasons.push(...approvalReasons('schedule', schedule.approved, schedule.approvedAt, current));
  reasons.push(...destinationReasons(delivery));
  if (destination !== undefined && !sameDestination(delivery, destination)) {
    reasons.push('destination-mismatch');
  }
  reasons.push(...approvalReasons('destination', delivery.approved, delivery.approvedAt, current));
  if (reasons.length === 0
      && Array.isArray(config.enabledChannels) && config.enabledChannels.length === 0) {
    return { authorized: false, status: 'no-channels', reasons: ['no-enabled-channels'] };
  }
  return reasons.length === 0
    ? { authorized: true, status: 'authorized', reasons: [] }
    : { authorized: false, status: 'schedule-not-authorized', reasons: [...new Set(reasons)] };
}

function parseOptions(argv) {
  return parseCommandLine(argv, {
    options: { config: { type: 'string' } },
    validate({ values, positionals }) {
      if (positionals.length) throw new CommandLineUsageError('unexpected positional arguments');
      if (!values.config) throw new CommandLineUsageError('--config is required');
      if (!isAbsolute(values.config)) throw new CommandLineUsageError('--config must be absolute');
    },
  }).values;
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try { options = parseOptions(argv); }
  catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return error.exitCode ?? EX_USAGE;
  }
  try {
    const config = JSON.parse(await readFile(options.config, 'utf8'));
    const result = authorizeSchedule(config);
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.authorized ? 0 : 1;
  } catch {
    stdout.write(`${JSON.stringify({
      authorized: false, status: 'schedule-not-authorized', reasons: ['config-unavailable'],
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
