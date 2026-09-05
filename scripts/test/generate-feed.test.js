import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStatuses, main } from '../generate-feed.js';

function memoryRuntime(initial = {}, { failRenameAt = Infinity } = {}) {
  const files = new Map(Object.entries(initial));
  let renameCount = 0;
  return {
    files,
    fs: {
      async readFile(path) {
        if (!files.has(String(path))) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
        return files.get(String(path));
      },
      async writeFile(path, value) { files.set(String(path), String(value)); },
      async rename(from, to) {
        renameCount += 1;
        if (renameCount === failRenameAt) throw new Error('rename failed');
        files.set(String(to), files.get(String(from)));
        files.delete(String(from));
      },
      async unlink(path) { files.delete(String(path)); },
    },
  };
}

const sources = {
  x_accounts: [], podcasts: [], blogs: [], newsletters: [],
  academic: { sources: [], filters: {} }, zhTech: [],
};

test('ordinary full generation rejects a missing candidate artifact before collection or publication', async () => {
  const runtime = memoryRuntime();
  let collected = false;
  await assert.rejects(main({
    args: [], env: { X_BEARER_TOKEN: 'x', POD2TXT_API_KEY: 'p' },
    fsImpl: runtime.fs, rootDir: '/repo', loadSourcesImpl: async () => sources,
    collectAllImpl: async () => { collected = true; return {}; },
    stderr() {},
  }), /missing.*initialize/i);
  assert.equal(collected, false);
  assert.equal(runtime.files.size, 0);
});

test('--initialize-candidate-feed refuses an existing artifact before collection', async () => {
  const runtime = memoryRuntime({ '/repo/feed-candidates.json': '{}' });
  let collected = false;
  await assert.rejects(main({
    args: ['--initialize-candidate-feed'], env: { X_BEARER_TOKEN: 'x', POD2TXT_API_KEY: 'p' },
    fsImpl: runtime.fs, rootDir: '/repo', loadSourcesImpl: async () => sources,
    collectAllImpl: async () => { collected = true; return {}; }, stderr() {},
  }), /already exists/i);
  assert.equal(collected, false);
});

test('initialization merges the existing six-feed snapshot with the complete current collection', async () => {
  const generatedAt = '2026-09-06T08:00:00.000Z';
  const legacyFeeds = {
    x: { schemaVersion: '1.0', generatedAt, lookbackHours: 24, stats: {}, x: [{
      source: 'x', sourceId: 'x:a', name: 'X A', handle: 'a', tweets: [{
        id: 'snapshot', text: 'Snapshot', createdAt: '2026-09-05T00:00:00.000Z',
        url: 'https://x.com/a/status/snapshot',
      }],
    }] },
    podcasts: { schemaVersion: '1.0', generatedAt, lookbackHours: 336, stats: {}, podcasts: [] },
    blogs: { schemaVersion: '1.0', generatedAt, lookbackHours: 72, stats: {}, blogs: [] },
    newsletters: { schemaVersion: '1.0', generatedAt, lookbackHours: 72, stats: {}, newsletters: [] },
    academic: { schemaVersion: '1.0', generatedAt, lookbackHours: 168, stats: {}, papers: [] },
    'zh-tech': { schemaVersion: '1.0', generatedAt, lookbackHours: 72, stats: {}, articles: [] },
  };
  const initial = Object.fromEntries(Object.entries(legacyFeeds).map(([channel, feed]) => [
    `/repo/${channel === 'x' ? 'feed-x' : channel === 'zh-tech' ? 'feed-zh-tech' : `feed-${channel}`}.json`,
    JSON.stringify(feed),
  ]));
  const runtime = memoryRuntime(initial);
  const currentFeeds = structuredClone(legacyFeeds);
  currentFeeds.x.x[0].tweets = [{
    id: 'current', text: 'Current', createdAt: generatedAt, url: 'https://x.com/a/status/current',
  }];
  await main({
    args: ['--initialize-candidate-feed'], env: { X_BEARER_TOKEN: 'x', POD2TXT_API_KEY: 'p' },
    fsImpl: runtime.fs, rootDir: '/repo',
    loadSourcesImpl: async () => ({ ...sources, x_accounts: [{ id: 'x:a', channel: 'x', name: 'X A', handle: 'a' }] }),
    collectAllImpl: async () => ({
      feeds: currentFeeds, state: { seenTweets: {}, seenVideos: {}, seenArticles: {} },
      statuses: [{ sourceId: 'x:a', channel: 'x', sourceName: 'X A', status: 'ok', candidateCount: 1 }],
    }),
    now: () => Date.parse(generatedAt), stderr() {},
  });
  const candidateFeed = JSON.parse(runtime.files.get('/repo/feed-candidates.json'));
  assert.deepEqual(candidateFeed.candidates.map(({ sourceNativeId }) => sourceNativeId).sort(), ['current', 'snapshot']);
  assert.equal(candidateFeed.continuousHistorySince, generatedAt);
});

test('every partial-only mode updates only its compatible feed and never reads candidate feed', async () => {
  for (const [flag, filename] of [
    ['--tweets-only', 'feed-x.json'], ['--podcasts-only', 'feed-podcasts.json'],
    ['--blogs-only', 'feed-blogs.json'], ['--newsletters-only', 'feed-newsletters.json'],
    ['--academic-only', 'feed-academic.json'], ['--zh-tech-only', 'feed-zh-tech.json'],
    ['--blog-source=blog:a', 'feed-blogs.json'],
  ]) {
    let candidateRead = false;
    const runtime = memoryRuntime();
    const originalRead = runtime.fs.readFile;
    runtime.fs.readFile = async (path, ...args) => {
      if (String(path).endsWith('feed-candidates.json')) candidateRead = true;
      return originalRead(path, ...args);
    };
    await main({
      args: [flag], env: { X_BEARER_TOKEN: 'x', POD2TXT_API_KEY: 'p' },
      fsImpl: runtime.fs, rootDir: '/repo', loadSourcesImpl: async () => sources,
      collectAllImpl: async ({ channels }) => ({
        feeds: Object.fromEntries(channels.map((channel) => [channel, {
          schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z', lookbackHours: 24,
          stats: {}, [channel === 'academic' ? 'papers' : channel === 'zh-tech' ? 'articles' : channel]: [],
        }])),
        state: { seenTweets: {}, seenVideos: {}, seenArticles: {} }, statuses: [], candidates: [],
      }),
      now: () => Date.parse('2026-09-06T08:00:00.000Z'), stderr() {},
    });
    assert.equal(candidateRead, false, flag);
    assert.deepEqual([...runtime.files.keys()].filter((path) => !path.includes('.stage-')), [`/repo/${filename}`], flag);
  }
});

test('publication rollback leaves all prior files unchanged when a staged rename fails', async () => {
  const feeds = {
    x: { schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z', lookbackHours: 24, stats: {}, x: [] },
    podcasts: { schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z', lookbackHours: 336, stats: {}, podcasts: [] },
    blogs: { schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z', lookbackHours: 72, stats: {}, blogs: [] },
    newsletters: { schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z', lookbackHours: 72, stats: {}, newsletters: [] },
    academic: { schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z', lookbackHours: 168, stats: {}, papers: [] },
    'zh-tech': { schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z', lookbackHours: 72, stats: {}, articles: [] },
  };
  const originals = {
    '/repo/feed-x.json': JSON.stringify(feeds.x),
    '/repo/feed-podcasts.json': JSON.stringify(feeds.podcasts),
    '/repo/feed-blogs.json': JSON.stringify(feeds.blogs),
    '/repo/feed-newsletters.json': JSON.stringify(feeds.newsletters),
    '/repo/feed-academic.json': JSON.stringify(feeds.academic),
    '/repo/feed-zh-tech.json': JSON.stringify(feeds['zh-tech']),
    '/repo/state-feed.json': 'old-state',
  };
  const runtime = memoryRuntime(originals, { failRenameAt: 4 });
  await assert.rejects(main({
    args: ['--initialize-candidate-feed'], env: { X_BEARER_TOKEN: 'x', POD2TXT_API_KEY: 'p' },
    fsImpl: runtime.fs, rootDir: '/repo', loadSourcesImpl: async () => sources,
    collectAllImpl: async () => ({ feeds, state: { seenTweets: {}, seenVideos: {}, seenArticles: {} }, statuses: [], candidates: [] }),
    now: () => Date.parse('2026-09-06T08:00:00.000Z'), stderr() {},
  }), /rename failed/);
  for (const [path, value] of Object.entries(originals)) assert.equal(runtime.files.get(path), value, path);
  assert.equal(runtime.files.has('/repo/feed-candidates.json'), false);
});

test('buildStatuses emits exactly one current status per enabled source across all six channels', () => {
  const registry = [
    { id: 'x:a', channel: 'x', name: 'X A', handle: 'a' },
    { id: 'podcast:a', channel: 'podcasts', name: 'Podcast A' },
    { id: 'blog:a', channel: 'blogs', name: 'Blog A' },
    { id: 'newsletter:a', channel: 'newsletters', name: 'Newsletter A', url: 'https://newsletter.example' },
    { id: 'academic:a', channel: 'academic', name: 'Academic A', url: 'https://academic.example' },
    { id: 'zh-tech:a', channel: 'zh-tech', name: 'Chinese A', url: 'https://zh.example' },
  ];
  const feeds = {
    x: { x: [{ sourceId: 'x:a', handle: 'a', tweets: [{ id: '1' }] }] },
    podcasts: { podcasts: [] }, blogs: { blogs: [], errors: ['Blog: Blog A: one candidate failed'] },
    newsletters: { newsletters: [] }, academic: { papers: [] }, 'zh-tech': { articles: [] },
  };
  const statuses = buildStatuses(registry, feeds, ['Blog: Blog A: one candidate failed'], [{
    sourceId: 'blog:a', channel: 'blogs', sourceName: 'Blog A', status: 'partial',
    candidateCount: 1, failedCandidateCount: 1, errorSummary: 'Blog A: one candidate failed',
  }]);

  assert.deepEqual(statuses.map(({ sourceId }) => sourceId), registry.map(({ id }) => id));
  assert.equal(new Set(statuses.map(({ sourceId }) => sourceId)).size, registry.length);
  assert.equal(statuses.find(({ sourceId }) => sourceId === 'x:a').status, 'ok');
  assert.equal(statuses.find(({ sourceId }) => sourceId === 'podcast:a').status, 'no-results');
  assert.equal(statuses.find(({ sourceId }) => sourceId === 'blog:a').status, 'partial');
});
