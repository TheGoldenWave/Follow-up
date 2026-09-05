import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { finalizeDigest, main } from '../finalize-digest.js';

const fixtures = new URL('./fixtures/', import.meta.url);

async function fixture(path) {
  return JSON.parse(await readFile(new URL(path, fixtures), 'utf8'));
}

function emptyRequest(base, overrides = {}) {
  return {
    ...structuredClone(base), eligibleCandidates: [],
    sourceStatuses: base.sourceStatuses.map((source) => ({
      sourceId: source.sourceId, channel: source.channel, sourceName: source.sourceName,
      status: 'no-results', candidateCount: 0,
    })),
    ...overrides,
  };
}

function emptySelection(request) {
  return {
    schemaVersion: '1.0', digestId: request.digestId,
    generatedAt: '2026-09-06T08:01:00.000Z', clusters: [], selectedEventClusterIds: [],
  };
}

test('finalize renders only deterministically selected items for a ready digest', async () => {
  const request = await fixture('curation/valid-request.json');
  const selection = await fixture('selections/valid-selection.json');
  const result = finalizeDigest(request, selection);
  assert.equal(result.status, 'ready');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Model launch');
  assert.equal(result.items[0].link, 'https://official.example/model-launch');
  assert.equal(result.items[0].scores.totalScore, 80);
  assert.match(result.items[0].reason, /官方发布/);
  assert.equal(result.items.some(({ title }) => title === 'Independent launch report'), false);
  assert.deepEqual(result.contentStats, {
    candidateCount: 2, eligibleCount: 2, excludedCount: 0, selectedCount: 1,
  });
});

test('complete empty daily and weekly runs use localized no-update wording', async () => {
  const base = await fixture('curation/valid-request.json');
  for (const [frequency, message] of [['daily', '今日无重要更新'], ['weekly', '本周无重要更新']]) {
    const request = emptyRequest(base, { frequency });
    request.coverage.frequency = frequency;
    const result = finalizeDigest(request, emptySelection(request));
    assert.equal(result.status, 'no-important-updates');
    assert.equal(result.message, message);
  }
});

test('source incompleteness is partial and history incompleteness has priority', async () => {
  const base = await fixture('curation/valid-request.json');
  const partialRequest = emptyRequest(base);
  partialRequest.sourceCompleteness = { ...partialRequest.sourceCompleteness, status: 'incomplete', complete: false };
  const partial = finalizeDigest(partialRequest, emptySelection(partialRequest));
  assert.equal(partial.status, 'partial');
  assert.match(partial.message, /检查不完整/);
  assert.doesNotMatch(partial.message, /无重要更新/);

  const incompleteRequest = structuredClone(partialRequest);
  incompleteRequest.coverage = {
    ...incompleteRequest.coverage, status: 'incomplete-history', complete: false,
    actualInterval: { ...incompleteRequest.coverage.actualInterval, start: '2026-09-05T00:00:00.000Z' },
    reasons: ['history-starts-after-requested-start'],
  };
  const incomplete = finalizeDigest(incompleteRequest, emptySelection(incompleteRequest));
  assert.equal(incomplete.status, 'incomplete-history');
  assert.match(incomplete.message, /历史覆盖不完整/);
});

test('a partial source can deliver available selected items without claiming completeness', async () => {
  const request = await fixture('curation/valid-request.json');
  const selection = await fixture('selections/valid-selection.json');
  request.sourceCompleteness = { ...request.sourceCompleteness, status: 'incomplete', complete: false };
  const result = finalizeDigest(request, selection);
  assert.equal(result.status, 'partial');
  assert.equal(result.items.length, 1);
});

test('partial artifact names bounded incomplete sources without leaking diagnostic details', async () => {
  const request = await fixture('curation/valid-request.json');
  const selection = await fixture('selections/valid-selection.json');
  request.sourceStatuses[0] = {
    ...request.sourceStatuses[0], status: 'partial', failedCandidateCount: 1,
    errorSummary: 'Official Lab: token=super-secret https://private.example/path',
  };
  request.sourceCompleteness = { ...request.sourceCompleteness, status: 'incomplete', complete: false };
  const result = finalizeDigest(request, selection);
  assert.deepEqual(result.incompleteSources, [{
    sourceId: 'blog:official', channel: 'blogs', sourceName: 'Official Lab', status: 'partial',
  }]);
  assert.match(result.message, /Official Lab/);
  assert.doesNotMatch(JSON.stringify(result), /super-secret|private\.example|errorSummary/);
});

test('finalize CLI failures report preparation-failed and never create or overwrite delivery output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-digest-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const validRequest = await fixture('curation/valid-request.json');
  const validSelection = await fixture('selections/valid-selection.json');
  const requestPath = join(root, 'request.json');
  const selectionPath = join(root, 'selection.json');
  const output = join(root, 'digest.json');
  await writeFile(requestPath, JSON.stringify(validRequest));
  await writeFile(output, 'old-output');

  const cases = [
    ['missing', join(root, 'missing.json')],
    ['invalid-json', selectionPath],
    ['digest-mismatch', selectionPath],
    ['invalid-manifest', selectionPath],
  ];
  for (const [name, path] of cases) {
    if (name === 'invalid-json') await writeFile(path, '{bad');
    if (name === 'digest-mismatch') await writeFile(path, JSON.stringify({ ...validSelection, digestId: 'e'.repeat(64) }));
    if (name === 'invalid-manifest') await writeFile(path, JSON.stringify({ ...validSelection, selectedEventClusterIds: [] }));
    const stderr = { value: '', write(chunk) { this.value += chunk; } };
    const code = await main({
      argv: ['--request', requestPath, '--selection', path, '--output', output], stderr,
    });
    assert.equal(code, 1, name);
    assert.match(stderr.value, /^preparation-failed:/, name);
    assert.equal(await readFile(output, 'utf8'), 'old-output', name);
  }
});

test('finalize output write failure removes its temp file and preserves old output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-digest-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  const output = join(root, 'digest.json');
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  await writeFile(output, 'old-output');
  let closed = false;
  const fsImpl = {
    ...fs,
    async open(path, flags, mode) {
      if (flags !== 'wx') return fs.open(path, flags, mode);
      const handle = await fs.open(path, flags, mode);
      return {
        async writeFile() { throw new Error(`secret ${path}`); },
        async sync() { return handle.sync(); },
        async close() { closed = true; return handle.close(); },
      };
    },
  };
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({
    argv: ['--request', request, '--selection', selection, '--output', output],
    fsImpl, randomUUID: () => 'failed', stderr,
  }), 1);
  assert.equal(closed, true);
  assert.equal(await readFile(output, 'utf8'), 'old-output');
  await assert.rejects(readFile(`${output}.tmp-failed`, 'utf8'), /ENOENT/);
  assert.equal(stderr.value, 'preparation-failed: output could not be written\n');
});

test('finalize CLI requires absolute paths', async () => {
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({ argv: ['--request', 'r', '--selection', 's', '--output', 'o'], stderr }), 64);
  assert.match(stderr.value, /^usage:/);
});
