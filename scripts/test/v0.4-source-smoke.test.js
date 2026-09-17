import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSourceSmoke } from '../release/verify-v0.4-source-smoke.js';

const NOW = '2026-09-17T12:00:00.000Z';
const SOURCES = [
  ['github', 'community:github'],
  ['hackernews', 'community:hacker-news'],
  ['reddit', 'community:reddit-machinelearning'],
  ['techmeme', 'community:techmeme'],
  ['arxiv', 'academic:arxiv-cs-ai'],
  ['hugging-face-papers', 'academic:hugging-face-papers'],
];

function evidence() {
  return {
    schemaVersion: '1.0',
    runs: SOURCES.map(([adapterId, sourceId]) => ({
      adapterId, sourceId,
      startedAt: '2026-09-17T11:00:00.000Z', completedAt: '2026-09-17T11:01:00.000Z',
      status: 'ok', rawCandidateCount: 5, uniqueCandidateCount: 5, duplicateRate: 0,
      sampledCandidateCount: 5, relevantCandidateCount: 4, relevanceRate: 0.8,
      reviewedBy: 'maintainer', notes: 'manual relevance review completed',
    })),
  };
}

test('accepts exactly six fresh, reviewed, secret-free successful source runs', () => {
  assert.deepEqual(validateSourceSmoke(evidence(), { now: NOW }), []);
});

test('accepts another canonical source for multi-source adapters', () => {
  const value = evidence();
  value.runs.find(({ adapterId }) => adapterId === 'arxiv').sourceId = 'academic:arxiv-cs-lg';
  value.runs.find(({ adapterId }) => adapterId === 'reddit').sourceId = 'community:reddit-localllama';
  assert.deepEqual(validateSourceSmoke(value, { now: NOW }), []);
});

test('rejects duplicate adapters, stale or reversed times, failed status, and invalid metrics', () => {
  for (const mutate of [
    value => { value.runs[1].adapterId = 'github'; },
    value => { value.runs[0].completedAt = '2026-09-10T11:00:00.000Z'; },
    value => { value.runs[0].startedAt = '2026-09-17T11:02:00.000Z'; },
    value => { value.runs[0].status = 'partial'; },
    value => { value.runs[0].duplicateRate = 0.1; },
    value => { value.runs[0].sampledCandidateCount = 4; },
    value => { value.runs[0].relevanceRate = 0.6; },
    value => { value.runs[0].notes = 'github_pat_abcdefghijklmnopqrstuvwxyz_123456789'; },
  ]) {
    const value = evidence();
    mutate(value);
    assert.notEqual(validateSourceSmoke(value, { now: NOW }).length, 0);
  }
});

test('reports only field paths and never notes content', () => {
  const value = evidence();
  value.runs[0].notes = 'private note body should not be echoed';
  value.runs[0].status = 'partial';
  const errors = validateSourceSmoke(value, { now: NOW });
  assert.ok(errors.some(error => error.startsWith('/runs/0/status')));
  assert.doesNotMatch(errors.join('\n'), /private note body/);
});
