import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENABLED_CHANNELS,
  normalizeConfig,
  validateConfig,
} from '../config-contract.js';

test('enabledChannels accepts each stable channel exactly once', () => {
  const config = { enabledChannels: [...ENABLED_CHANNELS] };

  assert.deepEqual(ENABLED_CHANNELS, [
    'x',
    'podcasts',
    'blogs',
    'newsletters',
    'academic',
    'zh-tech',
  ]);
  assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
  assert.deepEqual(normalizeConfig(config), config);
});

test('enabledChannels rejects duplicates, reports, and unknown values', () => {
  for (const enabledChannels of [
    ['x', 'x'],
    ['reports'],
    ['unknown'],
  ]) {
    const result = validateConfig({ enabledChannels });
    assert.equal(result.valid, false, enabledChannels.join(','));
    assert.ok(result.errors.some((error) => error.includes('enabledChannels')));
  }
});

test('an empty enabledChannels array is valid', () => {
  assert.deepEqual(validateConfig({ enabledChannels: [] }), {
    valid: true,
    errors: [],
  });
  assert.deepEqual(normalizeConfig({ enabledChannels: [] }).enabledChannels, []);
});

test('missing enabledChannels defaults to all six live channels at runtime', () => {
  const config = { language: 'zh' };

  assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
  assert.deepEqual(normalizeConfig(config), {
    language: 'zh',
    enabledChannels: [...ENABLED_CHANNELS],
  });
  assert.equal(Object.hasOwn(config, 'enabledChannels'), false);
});

test('v0.2 schema accepts independent schedule and destination approvals', () => {
  const config = {
    onboardingComplete: true,
    enabledChannels: ['blogs'],
    schedule: {
      frequency: 'weekly', time: '08:30', timezone: 'Asia/Shanghai', weeklyDay: 'friday',
      approved: true, approvedAt: '2026-09-06T07:00:00.000Z',
    },
    delivery: {
      method: 'email', email: 'reader@example.com',
      approved: true, approvedAt: '2026-09-06T07:05:00.000Z',
    },
  };
  assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
  assert.deepEqual(normalizeConfig(config).schedule, config.schedule);
});

test('v0.2 schema rejects malformed approval and weekly schedule state', () => {
  for (const config of [
    { schedule: { frequency: 'weekly', time: '08:00', timezone: 'UTC', approved: false } },
    { schedule: { frequency: 'daily', time: '8am', timezone: 'UTC', approved: false } },
    { delivery: { method: 'stdout', approved: true } },
  ]) {
    assert.equal(validateConfig(config).valid, false, JSON.stringify(config));
  }
});
