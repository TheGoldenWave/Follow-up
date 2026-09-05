import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createCandidateId, createContentFingerprint } from '../candidate-identity.js';
import {
  AtomicWriteCommittedError,
  fetchJSON,
  loadPrompts,
  main,
  prepareDigest,
  resolveInstalledPromptsDir,
  writeJsonAtomic,
} from '../prepare-digest.js';

const fixtures = new URL('./fixtures/', import.meta.url);

function candidate(label, channel = 'blogs', sourceId = 'blog:official', content = label) {
  const value = {
    channel, sourceId,
    canonicalUrl: `https://example.com/${label}`,
    title: label, author: 'Author', publishedAt: '2026-09-06T07:00:00.000Z',
    firstSeenAt: '2026-09-06T07:01:00.000Z', lastSeenAt: '2026-09-06T07:01:00.000Z',
    summarizationContent: content, contentTruncated: false,
  };
  value.candidateId = createCandidateId(value);
  value.contentFingerprint = createContentFingerprint(value);
  return value;
}

function feed(candidates, overrides = {}) {
  const sources = [
    { sourceId: 'blog:official', channel: 'blogs', sourceName: 'Official', status: 'ok', candidateCount: candidates.filter(({ sourceId }) => sourceId === 'blog:official').length },
    { sourceId: 'x:builder', channel: 'x', sourceName: 'Builder', status: 'ok', candidateCount: candidates.filter(({ sourceId }) => sourceId === 'x:builder').length },
  ].map((status) => status.candidateCount === 0 ? { ...status, status: 'no-results' } : status);
  return {
    schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z',
    initializedAt: '2026-09-01T00:00:00.000Z', continuousHistorySince: '2026-09-01T00:00:00.000Z',
    retention: { defaultDays: 15, podcastDays: 30, minimumPerSource: 50, maxCandidates: 1000 },
    historyTruncated: false,
    truncation: { affectedSourceIds: [], oldestRetainedAt: null, removedCount: 0 },
    registry: sources, candidates, ...overrides,
  };
}

const registry = [
  { id: 'blog:official', channel: 'blogs', name: 'Official' },
  { id: 'x:builder', channel: 'x', name: 'Builder' },
];

async function fixtureConfig(name) {
  return JSON.parse(await readFile(new URL(`config/${name}.json`, fixtures), 'utf8'));
}

async function createPromptFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-prompts-'));
  const userPromptsDir = join(root, 'user-prompts');
  const localPromptsDir = join(root, 'installed-prompts');
  await mkdir(userPromptsDir);
  await mkdir(localPromptsDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { userPromptsDir, localPromptsDir };
}

test('an explicit user prompt overrides the installed release prompt', async (t) => {
  const paths = await createPromptFixture(t);
  await writeFile(join(paths.userPromptsDir, 'digest-intro.md'), 'custom prompt');
  await writeFile(join(paths.localPromptsDir, 'digest-intro.md'), 'installed prompt');

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['digest-intro.md'],
  });

  assert.deepEqual(result, {
    prompts: { digest_intro: 'custom prompt' },
    errors: [],
  });
});

test('the installed release prompt is used when no user override exists', async (t) => {
  const paths = await createPromptFixture(t);
  await writeFile(join(paths.localPromptsDir, 'summarize-tweets.md'), 'tagged prompt');

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['summarize-tweets.md'],
  });

  assert.deepEqual(result, {
    prompts: { summarize_tweets: 'tagged prompt' },
    errors: [],
  });
});

test('the default installed prompt directory resolves from the module URL', () => {
  const moduleUrl = new URL('file:///C:/Program%20Files/Follow-up/scripts/prepare-digest.js');

  assert.equal(
    resolveInstalledPromptsDir(moduleUrl),
    fileURLToPath(new URL('../prompts/', moduleUrl)),
  );
});

test('prompt loading uses the default installed prompt directory', async (t) => {
  const { userPromptsDir } = await createPromptFixture(t);

  const result = await loadPrompts({
    userPromptsDir,
    promptFiles: ['digest-intro.md'],
  });

  assert.match(result.prompts.digest_intro, /digest/i);
  assert.deepEqual(result.errors, []);
});

test('prompt loading does not make a mutable-branch network request', async (t) => {
  const paths = await createPromptFixture(t);
  await writeFile(join(paths.localPromptsDir, 'translate.md'), 'local only');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.fail('prompt loading must not use the network');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['translate.md'],
  });

  assert.equal(result.prompts.translate, 'local only');
  assert.deepEqual(result.errors, []);
});

test('a missing user and installed prompt returns an actionable error', async (t) => {
  const paths = await createPromptFixture(t);

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['digest-intro.md'],
  });

  assert.deepEqual(result.prompts, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /~\/\.follow-builders\/prompts\/digest-intro\.md/);
  assert.match(result.errors[0], /prompts\/digest-intro\.md/);
  assert.match(result.errors[0], /custom prompt|reinstall/i);
  assert.doesNotMatch(result.errors[0], new RegExp(paths.userPromptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.errors[0], new RegExp(paths.localPromptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('an unreadable user override reports a sanitized error and falls back locally', async (t) => {
  const paths = await createPromptFixture(t);
  await mkdir(join(paths.userPromptsDir, 'digest-intro.md'));
  await writeFile(join(paths.localPromptsDir, 'digest-intro.md'), 'installed fallback');

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['digest-intro.md'],
  });

  assert.equal(result.prompts.digest_intro, 'installed fallback');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /~\/\.follow-builders\/prompts\/digest-intro\.md/);
  assert.match(result.errors[0], /installed prompt/i);
  assert.doesNotMatch(result.errors[0], new RegExp(paths.userPromptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a broken installed prompt is non-fatal and later prompts still load', async (t) => {
  const paths = await createPromptFixture(t);
  await mkdir(join(paths.localPromptsDir, 'digest-intro.md'));
  await writeFile(join(paths.localPromptsDir, 'translate.md'), 'translate prompt');

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['digest-intro.md', 'translate.md'],
  });

  assert.deepEqual(result.prompts, { translate: 'translate prompt' });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /prompts\/digest-intro\.md/);
  assert.match(result.errors[0], /reinstall/i);
  assert.doesNotMatch(result.errors[0], new RegExp(paths.localPromptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('legacy config enables all channels while explicit selection excludes disabled channels', async () => {
  const candidates = [
    candidate('blog-item'),
    candidate('x-item', 'x', 'x:builder'),
  ];
  const common = {
    frequency: 'daily', now: '2026-09-06T08:00:00.000Z', registry,
    deliveryEvents: [], loadCandidateFeed: async () => feed(candidates),
    loadCurationPrompt: async () => 'curate', randomUUID: () => '11111111-1111-4111-8111-111111111111',
  };
  const legacy = await prepareDigest({ ...common, config: await fixtureConfig('legacy-all-channels') });
  const selected = await prepareDigest({ ...common, config: await fixtureConfig('selected-channels') });

  assert.deepEqual(legacy.request.eligibleCandidates.map(({ channel }) => channel), ['blogs', 'x']);
  assert.deepEqual(selected.request.eligibleCandidates.map(({ channel }) => channel), ['blogs']);
  assert.deepEqual(selected.request.sourceStatuses.map(({ channel }) => channel), ['blogs']);
  assert.equal(selected.prompt, 'curate');
  assert.equal(JSON.stringify(selected.request).includes('x-item'), false);
});

test('empty enabledChannels returns no-channels without loading the rolling Feed', async () => {
  let fetched = false;
  const result = await prepareDigest({
    config: { enabledChannels: [] }, frequency: 'daily', registry,
    loadCandidateFeed: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  assert.equal(fetched, false);
  assert.deepEqual(result, {
    status: 'no-channels',
    message: '未启用任何内容渠道，请在设置中至少启用一个渠道。',
    contentStats: { candidateCount: 0, eligibleCount: 0, excludedCount: 0, selectedCount: 0 },
  });
});

test('missing expected source status becomes a synthetic error while valid candidates continue', async () => {
  const incompleteFeed = feed([candidate('blog-item')], {
    registry: [{
      sourceId: 'blog:official', channel: 'blogs', sourceName: 'Official',
      status: 'ok', candidateCount: 1,
    }],
  });
  const result = await prepareDigest({
    config: { enabledChannels: ['blogs', 'x'] }, frequency: 'daily',
    now: '2026-09-06T08:00:00.000Z', registry, deliveryEvents: [],
    loadCandidateFeed: async () => incompleteFeed,
    loadCurationPrompt: async () => 'curate',
    randomUUID: () => '77777777-7777-4777-8777-777777777777',
  });
  assert.equal(result.contextStatus, 'partial');
  assert.deepEqual(result.request.eligibleCandidates.map(({ title }) => title), ['blog-item']);
  assert.deepEqual(result.request.sourceStatuses[1], {
    sourceId: 'x:builder', channel: 'x', sourceName: 'Builder', status: 'error',
    candidateCount: 0, errorSummary: 'Source status was not reported.',
  });
  assert.deepEqual(result.request.sourceCompleteness, {
    status: 'incomplete', complete: false, feedFresh: true,
    expectedSourceCount: 2, reportedSourceCount: 1, totalSourceCount: 2,
    okSourceCount: 1, noResultsSourceCount: 0, partialSourceCount: 0,
    errorSourceCount: 0, missingSourceCount: 1,
  });
  assert.deepEqual(result.contentStats, {
    candidateCount: 1, eligibleCount: 1, excludedCount: 0, selectedCount: 0,
  });
});

test('unknown source status remains structural corruption and stops preparation', async () => {
  const corrupt = feed([candidate('blog-item')]);
  corrupt.registry.push({
    sourceId: 'x:unknown', channel: 'x', sourceName: 'Unknown',
    status: 'no-results', candidateCount: 0,
  });
  await assert.rejects(prepareDigest({
    config: { enabledChannels: ['blogs'] }, frequency: 'daily',
    now: '2026-09-06T08:00:00.000Z', registry, deliveryEvents: [],
    loadCandidateFeed: async () => corrupt,
  }), /candidate Feed is invalid/);
});

test('prepare creates a schema-valid bounded request from only the rolling candidate Feed', async () => {
  const oversized = candidate('podcast', 'podcasts', 'podcast:show', '文'.repeat(80_000));
  const podcastRegistry = [{ id: 'podcast:show', channel: 'podcasts', name: 'Show' }];
  const podcastFeed = feed([oversized], {
    registry: [{ sourceId: 'podcast:show', channel: 'podcasts', sourceName: 'Show', status: 'ok', candidateCount: 1 }],
  });
  let feedLoads = 0;
  const result = await prepareDigest({
    config: { enabledChannels: ['podcasts'], interests: ['agents'] }, frequency: 'daily',
    now: '2026-09-06T08:00:00.000Z', registry: podcastRegistry, deliveryEvents: [],
    loadCandidateFeed: async () => { feedLoads += 1; return podcastFeed; },
    loadCurationPrompt: async () => 'curation instructions',
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(feedLoads, 1);
  assert.equal(result.status, 'request-ready');
  assert.equal(Array.from(result.request.eligibleCandidates[0].summarizationContent).length, 12_000);
  assert.equal(result.request.eligibleCandidates[0].contentTruncated, true);
  assert.deepEqual(result.request.interests, ['agents']);
  assert.equal(result.prompt, 'curation instructions');
  assert.equal(Object.hasOwn(result.request, 'podcasts'), false);
});

test('stale and incomplete sources produce partial context while incomplete history remains requestable', async () => {
  const stale = await prepareDigest({
    config: { enabledChannels: ['blogs'] }, frequency: 'daily',
    now: '2026-09-09T08:00:00.001Z', registry, deliveryEvents: [],
    loadCandidateFeed: async () => feed([candidate('blog-item')]),
    loadCurationPrompt: async () => 'curate', randomUUID: () => '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(stale.request.sourceCompleteness.complete, false);
  assert.equal(stale.contextStatus, 'partial');

  const incompleteFeed = feed([candidate('blog-item')], {
    continuousHistorySince: '2026-09-05T08:00:00.000Z',
  });
  const incomplete = await prepareDigest({
    config: { enabledChannels: ['blogs'] }, frequency: 'weekly',
    now: '2026-09-06T08:00:00.000Z', registry, deliveryEvents: [],
    loadCandidateFeed: async () => incompleteFeed,
    loadCurationPrompt: async () => 'curate', randomUUID: () => '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(incomplete.status, 'request-ready');
  assert.equal(incomplete.contextStatus, 'incomplete-history');
  assert.equal(incomplete.request.coverage.complete, false);
});

test('prepare CLI atomically writes the request and cleans failed temporary output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-digest-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'request.json');
  const common = {
    argv: ['--request-out', output], config: { enabledChannels: ['blogs'] }, registry,
    now: '2026-09-06T08:00:00.000Z', deliveryEvents: [],
    loadCandidateFeed: async () => feed([candidate('blog-item')]),
    loadCurationPrompt: async () => 'curate', randomUUID: () => '55555555-5555-4555-8555-555555555555',
  };
  assert.equal(await main({ ...common, stdout: { write() {} } }), 0);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).digestId, '55555555-5555-4555-8555-555555555555');

  await writeFile(output, 'old-output');
  await writeFile(`${output}.tmp-collision`, 'occupied');
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  const randomValues = ['66666666-6666-4666-8666-666666666666', 'collision'];
  assert.equal(await main({
    ...common, randomUUID: () => randomValues.shift(), stderr, stdout: { write() {} },
  }), 1);
  assert.equal(await readFile(output, 'utf8'), 'old-output');
  assert.equal(stderr.value, 'preparation-failed: request output could not be written\n');
});

test('prepare CLI requires an absolute request output path', async () => {
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  assert.equal(await main({ argv: ['--request-out', 'relative.json'], stderr }), 64);
  assert.match(stderr.value, /^usage:/);
});

test('scheduled preparation defaults to deny unless authorization explicitly returns true', async () => {
  let fetched = false;
  await assert.rejects(prepareDigest({
    config: { enabledChannels: ['blogs'] }, scheduled: true, registry,
    loadCandidateFeed: async () => { fetched = true; return feed([]); },
  }), /schedule-not-authorized/);
  assert.equal(fetched, false);
});

test('scheduled CLI denial is explicit, nonzero, and creates no request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-scheduled-denied-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'request.json');
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  const code = await main({
    argv: ['--request-out', output, '--scheduled'],
    config: { enabledChannels: ['blogs'] }, registry, deliveryEvents: [],
    loadCandidateFeed: async () => assert.fail('denied run must not fetch'),
    stderr, stdout: { write() {} },
  });
  assert.equal(code, 1);
  assert.equal(stderr.value, 'preparation-failed: schedule-not-authorized\n');
  await assert.rejects(readFile(output), /ENOENT/);
});

test('remote candidate Feed fetch rejects insecure redirects, loops, and oversized bodies', async () => {
  await assert.rejects(fetchJSON('http://example.com/feed.json', {
    fetchImpl: async () => assert.fail('must not fetch HTTP'),
  }), /secure source/);

  await assert.rejects(fetchJSON('https://raw.githubusercontent.com/a/feed.json', {
    fetchImpl: async () => new Response(null, {
      status: 302, headers: { location: 'https://evil.example/feed.json' },
    }),
  }), /redirect origin/);

  await assert.rejects(fetchJSON('https://raw.githubusercontent.com/a/feed.json', {
    maxRedirects: 1,
    fetchImpl: async (url) => new Response(null, {
      status: 302, headers: { location: url },
    }),
  }), /redirect limit/);

  await assert.rejects(fetchJSON('https://raw.githubusercontent.com/a/feed.json', {
    maxBytes: 4,
    fetchImpl: async () => new Response('12345', { status: 200 }),
  }), /byte limit/);
});

test('remote candidate Feed timeout remains active while streaming the body', async () => {
  const stalled = new ReadableStream({ start() {} });
  await assert.rejects(fetchJSON('https://raw.githubusercontent.com/a/feed.json', {
    timeoutMs: 10,
    fetchImpl: async () => new Response(stalled, { status: 200 }),
  }), (error) => error?.name === 'TimeoutError');
});

test('future candidate Feed timestamps beyond clock skew stop preparation', async () => {
  await assert.rejects(prepareDigest({
    config: { enabledChannels: ['blogs'] }, frequency: 'daily',
    now: '2026-09-06T08:00:00.000Z', registry, deliveryEvents: [],
    loadCandidateFeed: async () => feed([], { generatedAt: '2026-09-06T08:05:00.001Z' }),
  }), /future/i);
});

test('atomic output retries temp collisions and reports post-rename durability uncertainty', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-atomic-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'out.json');
  await writeFile(`${output}.tmp-first`, 'occupied');
  const tokens = ['first', 'second'];
  await writeJsonAtomic(output, { value: 'new' }, { randomUUID: () => tokens.shift() });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { value: 'new' });

  let renamed = false;
  const fsImpl = {
    ...(await import('node:fs/promises')),
    async rename(...args) { renamed = true; return (await import('node:fs/promises')).rename(...args); },
    async open(path, flags, mode) {
      const realFs = await import('node:fs/promises');
      const handle = await realFs.open(path, flags, mode);
      if (renamed && path === root && flags === 'r') {
        return {
          async sync() { throw new Error('disk detail'); },
          async close() { return handle.close(); },
        };
      }
      return handle;
    },
  };
  await assert.rejects(
    writeJsonAtomic(output, { value: 'committed' }, {
      fsImpl, randomUUID: () => 'third', label: 'output',
    }),
    (error) => error instanceof AtomicWriteCommittedError && error.committed === true,
  );
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { value: 'committed' });
});

test('prepare CLI reports committed-but-uncertain after post-rename fsync failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-commit-uncertain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'request.json');
  const realFs = await import('node:fs/promises');
  let renamed = false;
  const fsImpl = {
    ...realFs,
    async rename(...args) { renamed = true; return realFs.rename(...args); },
    async open(path, flags, mode) {
      const handle = await realFs.open(path, flags, mode);
      if (renamed && path === root && flags === 'r') {
        return {
          async sync() { throw new Error('sensitive disk path'); },
          async close() { return handle.close(); },
        };
      }
      return handle;
    },
  };
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  const values = ['88888888-8888-4888-8888-888888888888', 'write-token'];
  const code = await main({
    argv: ['--request-out', output], config: { enabledChannels: ['blogs'] }, registry,
    now: '2026-09-06T08:00:00.000Z', deliveryEvents: [],
    loadCandidateFeed: async () => feed([candidate('blog-item')]),
    loadCurationPrompt: async () => 'curate', randomUUID: () => values.shift(),
    fsImpl, stderr, stdout: { write() {} },
  });
  assert.equal(code, 1);
  assert.equal(stderr.value, 'committed-but-uncertain: request output committed but durability could not be confirmed\n');
  assert.equal(JSON.parse(await readFile(output, 'utf8')).digestId, '88888888-8888-4888-8888-888888888888');
});
