import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeSchedule } from '../schedule-gate.js';

const NOW = '2026-09-06T08:00:00.000Z';

function approvedConfig(overrides = {}) {
  return {
    onboardingComplete: true,
    enabledChannels: ['blogs'],
    schedule: {
      frequency: 'daily', time: '08:00', timezone: 'Asia/Shanghai',
      approved: true, approvedAt: '2026-09-06T07:00:00.000Z',
    },
    delivery: {
      method: 'email', email: 'reader@example.com',
      approved: true, approvedAt: '2026-09-06T07:05:00.000Z',
    },
    ...overrides,
  };
}

test('scheduled authorization requires onboarding, schedule approval, and destination approval', () => {
  assert.deepEqual(authorizeSchedule(approvedConfig(), { now: NOW }), {
    authorized: true, status: 'authorized', reasons: [],
  });

  for (const [label, config, reason] of [
    ['onboarding', approvedConfig({ onboardingComplete: false }), 'onboarding-incomplete'],
    ['schedule', approvedConfig({ schedule: { ...approvedConfig().schedule, approved: false } }), 'schedule-not-approved'],
    ['destination', approvedConfig({ delivery: { ...approvedConfig().delivery, approved: false } }), 'destination-not-approved'],
  ]) {
    const result = authorizeSchedule(config, { now: NOW });
    assert.equal(result.authorized, false, label);
    assert.equal(result.status, 'schedule-not-authorized', label);
    assert.ok(result.reasons.includes(reason), label);
  }
});

test('scheduled authorization validates schedule shape and approval timestamps', () => {
  for (const [config, reason] of [
    [approvedConfig({ schedule: { ...approvedConfig().schedule, timezone: 'Mars/Olympus' } }), 'invalid-timezone'],
    [approvedConfig({ schedule: { ...approvedConfig().schedule, time: '8am' } }), 'invalid-time'],
    [approvedConfig({ schedule: { ...approvedConfig().schedule, frequency: 'weekly' } }), 'weekly-day-required'],
    [approvedConfig({ schedule: { ...approvedConfig().schedule, approvedAt: 'tomorrow' } }), 'invalid-schedule-approval-time'],
    [approvedConfig({ schedule: { ...approvedConfig().schedule, approvedAt: '2026-09-07T00:00:00.000Z' } }), 'future-schedule-approval'],
    [approvedConfig({ delivery: { ...approvedConfig().delivery, approvedAt: '2026-09-07T00:00:00.000Z' } }), 'future-destination-approval'],
  ]) {
    const result = authorizeSchedule(config, { now: NOW });
    assert.equal(result.authorized, false, reason);
    assert.ok(result.reasons.includes(reason), JSON.stringify(result));
  }
});

test('destination details are checked without returning secret configuration', () => {
  const secret = 'secret-token-that-must-not-leak';
  const result = authorizeSchedule(approvedConfig({
    delivery: {
      method: 'telegram', chatId: '', approved: true,
      approvedAt: '2026-09-06T07:05:00.000Z', token: secret,
    },
  }), { now: NOW });
  assert.deepEqual(result, {
    authorized: false,
    status: 'schedule-not-authorized',
    reasons: ['telegram-chat-id-required'],
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('empty channels are an actionable config state, never authorized delivery', () => {
  assert.deepEqual(authorizeSchedule(approvedConfig({ enabledChannels: [] }), { now: NOW }), {
    authorized: false, status: 'no-channels', reasons: ['no-enabled-channels'],
  });
});

test('legacy top-level schedule fields remain readable for migration', () => {
  const config = approvedConfig();
  delete config.schedule;
  Object.assign(config, {
    frequency: 'weekly', deliveryTime: '09:30', timezone: 'Europe/London', weeklyDay: 'monday',
    scheduleApproved: true, scheduleApprovedAt: '2026-09-06T07:00:00.000Z',
  });
  assert.deepEqual(authorizeSchedule(config, { now: NOW }), {
    authorized: true, status: 'authorized', reasons: [],
  });
});

test('scheduled run cannot reuse approval for a different frequency or destination', () => {
  const frequency = authorizeSchedule(approvedConfig(), { now: NOW, frequency: 'weekly' });
  assert.equal(frequency.authorized, false);
  assert.ok(frequency.reasons.includes('schedule-frequency-mismatch'));

  const destination = authorizeSchedule(approvedConfig(), {
    now: NOW, destination: { method: 'email', email: 'other@example.com' },
  });
  assert.equal(destination.authorized, false);
  assert.ok(destination.reasons.includes('destination-mismatch'));
});

test('scheduled authorization rejects schema-invalid configuration without echoing it', () => {
  const config = approvedConfig({ enabledChannels: ['secret-unknown-channel'] });
  const result = authorizeSchedule(config, { now: NOW });
  assert.equal(result.authorized, false);
  assert.ok(result.reasons.includes('invalid-config'));
  assert.equal(JSON.stringify(result).includes('secret-unknown-channel'), false);
});
