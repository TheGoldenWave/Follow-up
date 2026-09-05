import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStatuses, fetchPodcastContent, fetchRssFeeds, main, parseRssFeed } from '../generate-feed.js';

function memoryRuntime(initial = {}, { failRenameAt = Infinity } = {}) {
  const files = new Map(Object.entries(initial));
  let renameCount = 0;
  return {
    files,
    fs: {
      async mkdir() {},
      async open() { return { async sync() {}, async close() {} }; },
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
      async rm(path) {
        const prefix = `${String(path)}/`;
        for (const key of files.keys()) {
          if (key === String(path) || key.startsWith(prefix)) files.delete(key);
        }
      },
    },
  };
}

const sources = {
  x_accounts: [], podcasts: [], blogs: [], newsletters: [],
  academic: { sources: [], filters: {} }, zhTech: [],
};

function rssResponse(items) {
  return {
    ok: true,
    status: 200,
    async text() {
      return `<rss><channel>${items.map(({ guid, title, publishedAt }) => `<item><guid>${guid}</guid><title>${title}</title><pubDate>${publishedAt}</pubDate><link>https://episodes.example/${guid}</link></item>`).join('')}</channel></rss>`;
    },
  };
}

test('podcast collection attempts every enabled source after the first transcript succeeds', async () => {
  const podcasts = [
    { id: 'podcast:first', name: 'First', rssUrl: 'https://rss.example/first', url: 'https://video.example/first' },
    { id: 'podcast:second', name: 'Second', rssUrl: 'https://rss.example/second', url: 'https://video.example/second' },
  ];
  const transcriptCalls = [];
  const statuses = [];
  const results = await fetchPodcastContent(
    podcasts,
    'key',
    { seenVideos: {} },
    [],
    {
      now: () => Date.parse('2026-09-06T08:00:00.000Z'),
      fetchImpl: async (url) => rssResponse([{
        guid: url.endsWith('/first') ? 'first-episode' : 'second-episode',
        title: url.endsWith('/first') ? 'First episode' : 'Second episode',
        publishedAt: 'Sat, 05 Sep 2026 08:00:00 GMT',
      }]),
      fetchTranscriptImpl: async (_rssUrl, guid) => {
        transcriptCalls.push(guid);
        return { transcript: `Transcript for ${guid}` };
      },
      findYouTubeImpl: async () => null,
      statuses,
    },
  );

  assert.deepEqual(transcriptCalls, ['first-episode', 'second-episode']);
  assert.deepEqual(results.map(({ sourceId }) => sourceId), ['podcast:first', 'podcast:second']);
  assert.deepEqual(statuses.map(({ sourceId, status }) => ({ sourceId, status })), [
    { sourceId: 'podcast:first', status: 'ok' },
    { sourceId: 'podcast:second', status: 'ok' },
  ]);
});

test('podcast statuses distinguish partial, error, and proven no-results sources', async () => {
  const podcasts = [
    { id: 'podcast:partial', name: 'Partial', rssUrl: 'https://rss.example/partial', url: 'https://video.example/partial' },
    { id: 'podcast:error', name: 'Error', rssUrl: 'https://rss.example/error', url: 'https://video.example/error' },
    { id: 'podcast:empty', name: 'Empty', rssUrl: 'https://rss.example/empty', url: 'https://video.example/empty' },
  ];
  const statuses = [];
  const errors = [];
  const results = await fetchPodcastContent(
    podcasts,
    'key',
    { seenVideos: {} },
    errors,
    {
      now: () => Date.parse('2026-09-06T08:00:00.000Z'),
      fetchImpl: async (url) => rssResponse(url.endsWith('/empty') ? [] : url.endsWith('/partial') ? [
        { guid: 'partial-bad', title: 'Bad', publishedAt: 'Sat, 05 Sep 2026 09:00:00 GMT' },
        { guid: 'partial-good', title: 'Good', publishedAt: 'Sat, 05 Sep 2026 08:00:00 GMT' },
      ] : [{ guid: 'error-bad', title: 'Only bad', publishedAt: 'Sat, 05 Sep 2026 08:00:00 GMT' }]),
      fetchTranscriptImpl: async (_rssUrl, guid) => guid === 'partial-good'
        ? { transcript: 'usable transcript' }
        : { error: 'transcript unavailable' },
      findYouTubeImpl: async () => null,
      statuses,
    },
  );

  assert.deepEqual(results.map(({ guid }) => guid), ['partial-good']);
  assert.deepEqual(statuses.map(({ sourceId, status, candidateCount, failedCandidateCount }) => ({
    sourceId, status, candidateCount, failedCandidateCount,
  })), [
    { sourceId: 'podcast:partial', status: 'partial', candidateCount: 1, failedCandidateCount: 1 },
    { sourceId: 'podcast:error', status: 'error', candidateCount: 0, failedCandidateCount: 1 },
    { sourceId: 'podcast:empty', status: 'no-results', candidateCount: 0, failedCandidateCount: undefined },
  ]);
});

test('podcast rejects HTML and truncated XML but accepts valid empty RSS and Atom', async () => {
  for (const [body, expectedStatus] of [
    ['<html>not rss</html>', 'error'],
    ['<rss><channel><item><guid>broken</guid></item>', 'error'],
    ['<rss version="2.0"><channel></channel></rss>', 'no-results'],
    ['<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', 'no-results'],
  ]) {
    const statuses = [];
    const errors = [];
    const results = await fetchPodcastContent(
      [{ id: 'podcast:test', name: 'Test Podcast', rssUrl: 'https://rss.example/test', url: 'https://video.example/test' }],
      'key', { seenVideos: {} }, errors,
      {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }),
        statuses,
        now: () => Date.parse('2026-09-06T08:00:00.000Z'),
      },
    );
    assert.deepEqual(results, [], body);
    assert.equal(statuses[0].status, expectedStatus, body);
    if (expectedStatus === 'error') assert.match(errors[0], /Test Podcast.*invalid feed/i);
    else assert.deepEqual(errors, []);
  }
});

test('generic RSS sources reject malformed bodies and only valid empty feeds are no-results', async () => {
  for (const [body, expectedStatus] of [
    ['<html>not rss</html>', 'error'],
    ['<rss><channel><item><guid>broken</guid></item>', 'error'],
    ['<rss version="2.0"><channel></channel></rss>', 'no-results'],
    ['<feed xmlns="http://www.w3.org/2005/Atom"></feed>', 'no-results'],
  ]) {
    const statuses = [];
    const errors = [];
    const results = await fetchRssFeeds(
      [{ id: 'newsletter:test', name: 'Test Newsletter', rss: 'https://rss.example/test', url: 'https://newsletter.example' }],
      72, 1, { seenArticles: {} }, errors, undefined, undefined,
      {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }),
        namespace: 'newsletters', channel: 'newsletters', statuses,
        now: () => Date.parse('2026-09-06T08:00:00.000Z'),
      },
    );
    assert.deepEqual(results, [], body);
    assert.equal(statuses[0].status, expectedStatus, body);
    if (expectedStatus === 'error') assert.match(errors[0], /Test Newsletter.*invalid feed/i);
    else assert.deepEqual(errors, []);
  }
});

test('parseRssFeed rejects non-feed and structurally truncated XML', () => {
  assert.throws(() => parseRssFeed('<html>not rss</html>'), /invalid feed/i);
  assert.throws(() => parseRssFeed('<rss><channel><item></item>'), /invalid feed/i);
  assert.deepEqual(parseRssFeed('<rss><channel></channel></rss>'), []);
  assert.deepEqual(parseRssFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), []);
});

test('podcast and generic RSS mark a mixed valid and identity-less feed partial', async () => {
  const body = `<rss><channel>
    <item><title>Valid</title><guid>valid</guid><link>https://example.com/valid</link></item>
    <item><title>Missing identity</title></item>
  </channel></rss>`;
  const podcastStatuses = [];
  const podcastResults = await fetchPodcastContent(
    [{ id: 'podcast:mixed', name: 'Mixed Podcast', rssUrl: 'https://rss.example/mixed', url: 'https://video.example/mixed' }],
    'key', { seenVideos: {} }, [], {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }),
      fetchTranscriptImpl: async () => ({ transcript: 'Transcript' }),
      findYouTubeImpl: async () => null,
      statuses: podcastStatuses,
      now: () => Date.parse('2026-09-06T08:00:00.000Z'),
    },
  );
  assert.equal(podcastResults.length, 1);
  assert.equal(podcastStatuses[0].status, 'partial');
  assert.equal(podcastStatuses[0].failedCandidateCount, 1);

  const rssStatuses = [];
  const rssResults = await fetchRssFeeds(
    [{ id: 'newsletter:mixed', name: 'Mixed Newsletter', rss: 'https://rss.example/mixed', url: 'https://newsletter.example' }],
    72, 2, { seenArticles: {} }, [], undefined, undefined, {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }),
      namespace: 'newsletters', channel: 'newsletters', statuses: rssStatuses,
      now: () => Date.parse('2026-09-06T08:00:00.000Z'),
    },
  );
  assert.equal(rssResults[0].items.length, 1);
  assert.equal(rssStatuses[0].status, 'partial');
  assert.equal(rssStatuses[0].failedCandidateCount, 1);
});

test('podcast and generic RSS sanitize source-specific upstream diagnostics', async () => {
  const podcastErrors = [];
  await fetchPodcastContent(
    [{ id: 'podcast:safe', name: 'Safe Podcast', rssUrl: 'https://rss.example/safe', url: 'https://video.example/safe' }],
    'key', { seenVideos: {} }, podcastErrors, {
      fetchImpl: async () => rssResponse([{ guid: 'safe', title: 'Safe', publishedAt: 'Sat, 05 Sep 2026 08:00:00 GMT' }]),
      fetchTranscriptImpl: async () => ({ error: 'token=secret https://private.example/path' }),
      statuses: [], now: () => Date.parse('2026-09-06T08:00:00.000Z'),
    },
  );
  assert.match(podcastErrors[0], /Safe Podcast/);
  assert.doesNotMatch(podcastErrors[0], /secret|private\.example/);

  const rssErrors = [];
  await fetchRssFeeds(
    [{ id: 'newsletter:safe', name: 'Safe Newsletter', rss: 'https://rss.example/safe', url: 'https://newsletter.example' }],
    72, 1, { seenArticles: {} }, rssErrors, undefined, undefined, {
      fetchImpl: async () => { throw new Error('api_key=secret https://private.example/path'); },
      namespace: 'newsletters', channel: 'newsletters', statuses: [],
    },
  );
  assert.match(rssErrors[0], /Safe Newsletter/);
  assert.doesNotMatch(rssErrors[0], /secret|private\.example/);
});

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

test('generation acquires the publication lock and recovers before reading or collecting', async () => {
  const events = [];
  const runtime = memoryRuntime();
  const originalRead = runtime.fs.readFile;
  runtime.fs.readFile = async (...args) => {
    events.push('read');
    return originalRead(...args);
  };
  await main({
    args: ['--tweets-only'], env: { X_BEARER_TOKEN: 'x' }, fsImpl: runtime.fs, rootDir: '/repo',
    loadSourcesImpl: async () => sources,
    withPublicationLockImpl: async (_root, operation) => {
      events.push('lock');
      return operation();
    },
    recoverPublicationImpl: async () => { events.push('recover'); },
    collectAllImpl: async () => {
      events.push('collect');
      return {
        feeds: { x: { schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z', lookbackHours: 24, stats: {}, x: [] } },
        state: { seenTweets: {}, seenVideos: {}, seenArticles: {} },
      };
    },
    publishTransactionImpl: async () => {},
    now: () => Date.parse('2026-09-06T08:00:00.000Z'), stderr() {},
  });
  assert.deepEqual(events.slice(0, 2), ['lock', 'recover']);
  assert.ok(events.indexOf('recover') < events.indexOf('read'));
  assert.ok(events.indexOf('recover') < events.indexOf('collect'));
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
