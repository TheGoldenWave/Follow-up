import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACQUISITION_MODES,
  combineAcquisitionInput,
  normalizeAcquisitionMode,
} from '../lib/resolve-acquisition-input.js';

const central = {
  candidates: [
    { candidateId: 'c1', sourceId: 'blog:a', channel: 'blogs' },
    { candidateId: 'c2', sourceId: 'blog:b', channel: 'blogs' },
  ],
  registry: [
    { sourceId: 'blog:a', channel: 'blogs', status: 'ok' },
    { sourceId: 'blog:b', channel: 'blogs', status: 'ok' },
  ],
};

const local = {
  candidates: [{ candidateId: 'l1', sourceId: 'blog:a', channel: 'blogs' }],
  sourceStatuses: [
    { sourceId: 'blog:a', channel: 'blogs', status: 'ok' },
    { sourceId: 'blog:b', channel: 'blogs', status: 'error' },
  ],
};

test('normalizeAcquisitionMode defaults to central and validates', () => {
  assert.equal(normalizeAcquisitionMode(undefined), 'central');
  assert.equal(normalizeAcquisitionMode(''), 'central');
  assert.equal(normalizeAcquisitionMode('hybrid'), 'hybrid');
  assert.throws(() => normalizeAcquisitionMode('bogus'), /Unknown acquisition mode/);
});

test('ACQUISITION_MODES is the frozen four-mode set', () => {
  assert.deepEqual(ACQUISITION_MODES, ['central', 'shadow', 'hybrid', 'local']);
});

test('central mode returns central candidates and statuses unchanged', () => {
  const result = combineAcquisitionInput({ mode: 'central', central, local });
  assert.deepEqual(result.candidates, central.candidates);
  assert.deepEqual(result.sourceStatuses, central.registry);
  assert.equal(result.shadow, undefined);
});

test('local mode returns only local candidates and statuses', () => {
  const result = combineAcquisitionInput({ mode: 'local', central, local });
  assert.deepEqual(result.candidates, local.candidates);
  assert.deepEqual(result.sourceStatuses, local.sourceStatuses);
});

test('shadow mode delivers central only and attaches local for metrics', () => {
  const result = combineAcquisitionInput({ mode: 'shadow', central, local });
  assert.deepEqual(result.candidates, central.candidates);
  assert.deepEqual(result.sourceStatuses, central.registry);
  assert.deepEqual(result.shadow, local);
});

test('hybrid mode uses local when ok and falls back to central on failure', () => {
  const result = combineAcquisitionInput({ mode: 'hybrid', central, local });
  // blog:a local ok -> local candidate; blog:b local error -> central candidate.
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.sourceId),
    ['blog:a', 'blog:b'],
  );
  assert.equal(result.candidates[0].candidateId, 'l1');
  assert.equal(result.candidates[1].candidateId, 'c2');
  assert.equal(result.sourceStatuses.find((s) => s.sourceId === 'blog:a').status, 'ok');
  assert.equal(result.sourceStatuses.find((s) => s.sourceId === 'blog:b').status, 'ok');
});

test('hybrid mode treats local no-results as authoritative (no central fallback)', () => {
  const noResults = {
    candidates: [],
    sourceStatuses: [{ sourceId: 'blog:a', channel: 'blogs', status: 'no-results' }],
  };
  const result = combineAcquisitionInput({ mode: 'hybrid', central, local: noResults });
  assert.deepEqual(result.candidates, central.candidates.filter((c) => c.sourceId !== 'blog:a'));
  assert.equal(result.sourceStatuses.find((s) => s.sourceId === 'blog:a').status, 'no-results');
});
