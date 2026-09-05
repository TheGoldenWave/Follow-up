import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { createRequestHash } from '../digest-selection-contract.js';
import { loadActiveDigestMessage } from '../deliver.js';
import { finalizeDigest, main, renderDigestMessage } from '../finalize-digest.js';

const fixtures = new URL('./fixtures/', import.meta.url);

async function fixture(path) {
  return JSON.parse(await readFile(new URL(path, fixtures), 'utf8'));
}

function emptyRequest(base, overrides = {}) {
  const value = {
    ...structuredClone(base), eligibleCandidates: [],
    sourceStatuses: base.sourceStatuses.map((source) => ({
      sourceId: source.sourceId, channel: source.channel, sourceName: source.sourceName,
      status: 'no-results', candidateCount: 0,
    })),
    ...overrides,
  };
  value.contentStats = {
    candidateCount: 0, eligibleCount: 0, excludedCount: 0, selectedCount: 0,
  };
  value.sourceCompleteness = {
    ...value.sourceCompleteness,
    okSourceCount: 0,
    noResultsSourceCount: value.sourceStatuses.length,
  };
  value.requestHash = createRequestHash(value);
  return value;
}

function emptySelection(request) {
  return {
    schemaVersion: '1.0', digestId: request.digestId, requestHash: request.requestHash,
    generatedAt: '2026-09-06T08:01:00.000Z', clusters: [], selectedEventClusterIds: [],
  };
}

async function readActive(outputDir) {
  const active = JSON.parse(await readFile(join(outputDir, 'active.json'), 'utf8'));
  const generationDir = join(outputDir, 'generations', active.generation);
  return {
    active,
    artifact: JSON.parse(await readFile(join(generationDir, 'artifact.json'), 'utf8')),
    message: await readFile(join(generationDir, 'message.txt'), 'utf8'),
    manifest: JSON.parse(await readFile(join(generationDir, 'manifest.json'), 'utf8')),
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
    request.requestHash = createRequestHash(request);
    const result = finalizeDigest(request, emptySelection(request));
    assert.equal(result.status, 'no-important-updates');
    assert.equal(result.message, message);
  }
});

test('source incompleteness is partial and history incompleteness has priority', async () => {
  const base = await fixture('curation/valid-request.json');
  const partialRequest = emptyRequest(base);
  partialRequest.sourceCompleteness = { ...partialRequest.sourceCompleteness, status: 'incomplete', complete: false };
  partialRequest.sourceCompleteness.feedFresh = false;
  partialRequest.requestHash = createRequestHash(partialRequest);
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
  incompleteRequest.requestHash = createRequestHash(incompleteRequest);
  const incomplete = finalizeDigest(incompleteRequest, emptySelection(incompleteRequest));
  assert.equal(incomplete.status, 'incomplete-history');
  assert.match(incomplete.message, /历史覆盖不完整/);
});

test('a partial source can deliver available selected items without claiming completeness', async () => {
  const request = await fixture('curation/valid-request.json');
  const selection = await fixture('selections/valid-selection.json');
  request.sourceCompleteness = { ...request.sourceCompleteness, status: 'incomplete', complete: false };
  request.sourceCompleteness.feedFresh = false;
  request.requestHash = createRequestHash(request);
  selection.requestHash = request.requestHash;
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
  request.sourceCompleteness.partialSourceCount = 1;
  request.sourceCompleteness.okSourceCount = 1;
  request.requestHash = createRequestHash(request);
  selection.requestHash = request.requestHash;
  const result = finalizeDigest(request, selection);
  assert.deepEqual(result.incompleteSources, [{
    sourceId: 'blog:official', channel: 'blogs', sourceName: 'Official Lab', status: 'partial',
  }]);
  assert.match(result.message, /Official Lab/);
  assert.doesNotMatch(JSON.stringify(result), /super-secret|private\.example|errorSummary/);
});

test('finalize CLI failures report preparation-failed and never change active generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-digest-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const validRequest = await fixture('curation/valid-request.json');
  const validSelection = await fixture('selections/valid-selection.json');
  const requestPath = join(root, 'request.json');
  const selectionPath = join(root, `${validRequest.digestId}.json`);
  const outputDir = join(root, 'outputs');
  await mkdir(outputDir);
  await writeFile(join(outputDir, 'active.json'), '{"generation":"old"}\n');
  await writeFile(requestPath, JSON.stringify(validRequest));

  const cases = [
    ['missing', selectionPath],
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
      argv: ['--request', requestPath, '--selection', path, '--output-dir', outputDir], stderr,
    });
    assert.equal(code, 1, name);
    assert.match(stderr.value, /^preparation-failed:/, name);
    assert.equal(await readFile(join(outputDir, 'active.json'), 'utf8'), '{"generation":"old"}\n', name);
  }
});

test('artifact or message staging failure preserves old active and exposes no generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-digest-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const requestDocument = await fixture('curation/valid-request.json');
  const selection = join(root, `${requestDocument.digestId}.json`);
  const outputDir = join(root, 'outputs');
  await mkdir(outputDir);
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  await writeFile(join(outputDir, 'active.json'), '{"generation":"old"}\n');
  for (const failedName of ['artifact.json', 'message.txt']) {
    const fsImpl = {
      ...fs,
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode);
        if (path.endsWith(failedName)) return {
          async writeFile() { throw new Error(`secret ${path}`); },
          async sync() { return handle.sync(); },
          async close() { return handle.close(); },
        };
        return handle;
      },
    };
    const stderr = { value: '', write(chunk) { this.value += chunk; } };
    assert.equal(await main({
      argv: ['--request', request, '--selection', selection, '--output-dir', outputDir],
      fsImpl, randomUUID: () => `failed-${failedName.replace('.', '-')}`, stderr,
    }), 1);
    assert.equal(await readFile(join(outputDir, 'active.json'), 'utf8'), '{"generation":"old"}\n');
    await assert.rejects(readFile(join(outputDir, 'generations', `${requestDocument.digestId}-failed-${failedName.replace('.', '-')}`, 'artifact.json')), /ENOENT/);
    assert.equal(stderr.value, 'preparation-failed: digest generation could not be activated\n');
  }
});

test('finalize CLI requires absolute paths', async () => {
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({ argv: ['--request', 'r', '--selection', 's', '--output-dir', 'o'], stderr }), 64);
  assert.match(stderr.value, /^usage:/);
});

test('finalize rejects a selection filename that is not the digest ID', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-selection-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'wrong.json');
  const outputDir = join(root, 'outputs');
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({
    argv: ['--request', request, '--selection', selection, '--output-dir', outputDir], stderr,
  }), 1);
  assert.equal(stderr.value, 'preparation-failed: selection filename must match digestId\n');
  await assert.rejects(readFile(join(outputDir, 'active.json')), /ENOENT/);
});

test('finalize writes a plain-text user message rather than delivering artifact JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-message-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestDocument = await fixture('curation/valid-request.json');
  const request = join(root, 'request.json');
  const selection = join(root, `${requestDocument.digestId}.json`);
  const outputDir = join(root, 'outputs');
  await writeFile(request, JSON.stringify(requestDocument));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({
    argv: ['--request', request, '--selection', selection, '--output-dir', outputDir],
    stderr, stdout: { write() {} }, randomUUID: () => 'generation',
  }), 0, stderr.value);
  const active = await readActive(outputDir);
  const text = active.message;
  assert.equal(text.trimStart().startsWith('{'), false);
  assert.match(text, /Model launch/);
  assert.match(text, /https:\/\/official\.example\/model-launch/);
  assert.equal(active.artifact.digestId, requestDocument.digestId);
  assert.equal(active.active.generation, `${requestDocument.digestId}-generation`);
  assert.deepEqual(active.manifest, {
    schemaVersion: '1.0', generation: `${requestDocument.digestId}-generation`,
    digestId: requestDocument.digestId, requestHash: requestDocument.requestHash,
    artifact: 'artifact.json', message: 'message.txt',
  });
  assert.equal(await loadActiveDigestMessage(join(outputDir, 'active.json')), text);
  assert.equal(basename(selection), `${requestDocument.digestId}.json`);
});

test('generation creation retries collisions and rejects symlinked targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-generation-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestDocument = await fixture('curation/valid-request.json');
  const request = join(root, 'request.json');
  const selection = join(root, `${requestDocument.digestId}.json`);
  const outputDir = join(root, 'outputs');
  const generations = join(outputDir, 'generations');
  await mkdir(generations, { recursive: true });
  await mkdir(join(generations, `.staging-${requestDocument.digestId}-collision`));
  await writeFile(request, JSON.stringify(requestDocument));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  const tokens = ['collision', 'fresh', 'active'];
  assert.equal(await main({
    argv: ['--request', request, '--selection', selection, '--output-dir', outputDir],
    randomUUID: () => tokens.shift(), stderr: { write() {} }, stdout: { write() {} },
  }), 0);
  assert.equal((await readActive(outputDir)).active.generation, `${requestDocument.digestId}-fresh`);

  const linkedRoot = join(root, 'linked-output');
  await fs.symlink(outputDir, linkedRoot);
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({
    argv: ['--request', request, '--selection', selection, '--output-dir', linkedRoot],
    randomUUID: () => 'linked', stderr, stdout: { write() {} },
  }), 1);
  assert.equal((await readActive(outputDir)).active.generation, `${requestDocument.digestId}-fresh`);
});

test('activation failure preserves old active and removes the unactivated generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-activation-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestDocument = await fixture('curation/valid-request.json');
  const request = join(root, 'request.json');
  const selection = join(root, `${requestDocument.digestId}.json`);
  const outputDir = join(root, 'outputs');
  await mkdir(outputDir);
  await writeFile(join(outputDir, 'active.json'), '{"generation":"old"}\n');
  await writeFile(request, JSON.stringify(requestDocument));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  const fsImpl = { ...fs, async rename(from, to) {
    if (to.endsWith('active.json')) throw new Error('activation failed');
    return fs.rename(from, to);
  } };
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({
    argv: ['--request', request, '--selection', selection, '--output-dir', outputDir],
    fsImpl, randomUUID: () => 'activation', stderr,
  }), 1);
  assert.equal(await readFile(join(outputDir, 'active.json'), 'utf8'), '{"generation":"old"}\n');
  await assert.rejects(readFile(join(outputDir, 'generations', `${requestDocument.digestId}-activation`, 'message.txt')), /ENOENT/);
});

test('active commit fsync uncertainty leaves one complete readable generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'finalize-active-uncertain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestDocument = await fixture('curation/valid-request.json');
  const request = join(root, 'request.json');
  const selection = join(root, `${requestDocument.digestId}.json`);
  const outputDir = join(root, 'outputs');
  await writeFile(request, JSON.stringify(requestDocument));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  let activeRenamed = false;
  const fsImpl = {
    ...fs,
    async rename(from, to) {
      const result = await fs.rename(from, to);
      if (to.endsWith('active.json')) activeRenamed = true;
      return result;
    },
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (activeRenamed && path === outputDir && flags === 'r') return {
        async sync() { throw new Error('uncertain'); }, async close() { return handle.close(); },
      };
      return handle;
    },
  };
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({
    argv: ['--request', request, '--selection', selection, '--output-dir', outputDir],
    fsImpl, randomUUID: () => 'uncertain', stderr,
  }), 1);
  assert.match(stderr.value, /^committed-but-uncertain:/);
  const active = await readActive(outputDir);
  assert.equal(active.artifact.digestId, requestDocument.digestId);
  assert.match(active.message, /Model launch/);
});

test('plain-text renderer neutralizes Markdown links, mentions, and control characters', () => {
  const text = renderDigestMessage({
    status: 'ready', message: 'Digest', items: [{
      title: '[@all](https://evil.example)\u0007', sourceId: 'blog:test',
      reason: '*important* @channel', link: 'https://safe.example/item',
      scores: { totalScore: 80 },
    }],
  });
  assert.doesNotMatch(text, /\[@all\]\(https:\/\/evil\.example\)|@channel|\u0007/);
  assert.match(text, /https:\/\/safe\.example\/item/);
});
