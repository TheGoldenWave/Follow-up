import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidateFeed } from '../candidate-feed-contract.js';

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

test('hybrid cutover failure stays visibly empty and rollback forces central', () => {
  const migrationState = { sources: { 'blog:b': { input: 'local' }, 'blog:a': { input: 'central', rollback_reason: 'duplicates' } } };
  const result = combineAcquisitionInput({ mode: 'hybrid', central, local, migrationState });
  assert.deepEqual(result.candidates.map(c => c.candidateId), ['c1']);
  assert.equal(result.sourceStatuses.find(s => s.sourceId === 'blog:b').status, 'error');
});

test('local mode quarantines rolled back sources without central fallback', () => {
  const result = combineAcquisitionInput({ mode: 'local', central, local, migrationState: { sources: { 'blog:a': { input: 'central', rollback_reason: 'duplicates' } } } });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.sourceStatuses.find(s => s.sourceId === 'blog:a').status, 'error');
  assert.equal(result.sourceStatuses.find(s => s.sourceId === 'blog:a').errorSummary, 'migration-rollback:duplicates');
});

test('missing cutover batch emits a contract-valid failure source record', () => {
  const result = combineAcquisitionInput({ mode: 'hybrid', central: { candidates: [], registry: [{ sourceId: 'blog:a', channel: 'blogs', sourceName: 'Blog A', status: 'ok', candidateCount: 0 }] }, local: {}, migrationState: { sources: { 'blog:a': { input: 'local' } } } });
  const feed = { schemaVersion: '1.0', generatedAt: '2026-09-09T00:00:00Z', initializedAt: '2026-09-09T00:00:00Z', continuousHistorySince: '2026-09-09T00:00:00Z', retention: { defaultDays: 15, podcastDays: 30, minimumPerSource: 50, maxCandidates: 1000 }, historyTruncated: false, truncation: { affectedSourceIds: [], oldestRetainedAt: null, removedCount: 0 }, candidates: result.candidates, registry: result.sourceStatuses };
  const validation = validateCandidateFeed(feed, { expectedRegistry: [{ id: 'blog:a', channel: 'blogs', name: 'Blog A' }] });
  assert.equal(validation.valid, true, validation.errors.join('; '));
});
