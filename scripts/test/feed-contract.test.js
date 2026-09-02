import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  FEED_SCHEMA_VERSION,
  createFeedEnvelope,
  validateFeed,
} from '../feed-contract.js';
import {
  errorsSince,
  fetchRssFeeds,
  normalizePublishedAt,
  parseRssFeed,
} from '../generate-feed.js';
import { CENTRAL_FEEDS, loadCentralFeedData } from '../prepare-digest.js';

const repositoryRoot = new URL('../../', import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repositoryRoot), 'utf8'));
}

const feedCases = [
  ['x', 'feed-x.json', 'x'],
  ['podcasts', 'feed-podcasts.json', 'podcasts'],
  ['blogs', 'feed-blogs.json', 'blogs'],
  ['newsletters', 'feed-newsletters.json', 'newsletters'],
  ['academic', 'feed-academic.json', 'papers'],
  ['zh-tech', 'feed-zh-tech.json', 'articles'],
];

test('all six checked-in feeds use schemaVersion 1.0 and satisfy their payload contract', async () => {
  assert.equal(FEED_SCHEMA_VERSION, '1.0');

  for (const [category, filename, payloadKey] of feedCases) {
    const feed = await readJson(filename);
    assert.equal(feed.schemaVersion, '1.0', filename);
    assert.ok(Array.isArray(feed[payloadKey]), `${filename} must contain ${payloadKey}`);
    assert.deepEqual(validateFeed(feed, category), { valid: true, errors: [] }, filename);
    assert.doesNotMatch(JSON.stringify(feed), /localhost|we-mp-rss/i, filename);
  }
});

test('feed validation accepts compatible 1.x and rejects missing, malformed, or future-major envelopes', async () => {
  const feed = await readJson('feed-x.json');

  assert.equal(validateFeed({ ...feed, schemaVersion: '1.7' }, 'x').valid, true);
  assert.equal(validateFeed({ ...feed, schemaVersion: undefined }, 'x').valid, false);
  assert.equal(validateFeed({ ...feed, schemaVersion: '2.0' }, 'x').valid, false);
  assert.equal(validateFeed({ ...feed, x: {} }, 'x').valid, false);
  assert.equal(validateFeed(feed, 'podcasts').valid, false);
});

test('generator envelopes always declare schemaVersion 1.0', () => {
  const feed = createFeedEnvelope({
    generatedAt: '2026-09-02T00:00:00.000Z',
    lookbackHours: 72,
    x: [],
    stats: { xBuilders: 0, totalTweets: 0 },
  });

  assert.equal(feed.schemaVersion, '1.0');
  assert.equal(validateFeed(feed, 'x').valid, true);
  assert.equal(createFeedEnvelope({ schemaVersion: '2.0' }).schemaVersion, '1.0');
});

test('generator normalizes parseable source dates to contract-safe timestamps', () => {
  assert.equal(normalizePublishedAt('Aug 26, 2026'), '2026-08-26T00:00:00.000Z');
  assert.equal(normalizePublishedAt(null), null);
  assert.equal(normalizePublishedAt('not a date'), null);
});

const rssFixtures = {
  newsletters: `<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[Agents in practice]]></title>
    <guid>newsletter-1</guid>
    <link>https://newsletter.example/agents</link>
    <pubDate>Tue, 02 Sep 2026 08:00:00 GMT</pubDate>
  </item></channel></rss>`,
  academic: `<?xml version="1.0"?><rss><channel><item>
    <title>Reliable LLM agents with tool-use</title>
    <guid isPermaLink="false">oai:arXiv.org:2609.00001v1</guid>
    <link>https://arxiv.org/abs/2609.00001</link>
    <pubDate>Tue, 02 Sep 2026 07:00:00 GMT</pubDate>
  </item></channel></rss>`,
  zhTech: `<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[中国 AI 应用进入新阶段]]></title>
    <link><![CDATA[https://zh.example/posts/1]]></link>
    <pubDate>Tue, 02 Sep 2026 06:00:00 GMT</pubDate>
  </item></channel></rss>`,
};

test('newsletter, academic, and Chinese RSS fixtures produce the common grouped shape', async () => {
  const cases = [
    ['newsletters', 'Newsletter Example', 'en', undefined],
    ['academic', 'arXiv Example', 'en', ['LLM']],
    ['zhTech', '中文科技', 'zh', undefined],
  ];

  for (const [fixtureName, name, language, filterKeywords] of cases) {
    const errors = [];
    const state = { seenArticles: {} };
    const result = await fetchRssFeeds(
      [{ name, rss: `https://${fixtureName}.example/rss`, url: `https://${fixtureName}.example`, tags: [fixtureName], language }],
      72,
      3,
      state,
      errors,
      filterKeywords,
      [],
      {
        now: () => Date.parse('2026-09-02T09:00:00.000Z'),
        fetchImpl: async () => ({ ok: true, text: async () => rssFixtures[fixtureName] }),
      },
    );

    assert.deepEqual(errors, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, name);
    assert.equal(result[0].items.length, 1);
    assert.equal(result[0].items[0].source, name);
    assert.equal(result[0].items[0].language, language);
  }
});

test('RSS parsing uses a CDATA link as the stable fallback when GUID is missing', () => {
  const [item] = parseRssFeed(rssFixtures.zhTech);

  assert.equal(item.guid, 'https://zh.example/posts/1');
  assert.equal(item.link, 'https://zh.example/posts/1');
});

test('RSS fetching filters old and previously seen items before applying the source limit', async () => {
  const xml = `<rss><channel>
    <item><title>Seen item</title><guid>seen-1</guid><link>https://example.com/seen</link><pubDate>Tue, 02 Sep 2026 08:30:00 GMT</pubDate></item>
    <item><title>Old item</title><guid>old-1</guid><link>https://example.com/old</link><pubDate>Mon, 31 Aug 2026 08:30:00 GMT</pubDate></item>
    <item><title>Fresh item</title><guid>fresh-1</guid><link>https://example.com/fresh</link><pubDate>Tue, 02 Sep 2026 08:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const state = { seenArticles: { 'seen-1': 1 } };
  const errors = [];

  const result = await fetchRssFeeds(
    [{ name: 'Fixture Source', rss: 'https://example.com/rss', url: 'https://example.com' }],
    24,
    1,
    state,
    errors,
    undefined,
    undefined,
    {
      now: () => Date.parse('2026-09-02T09:00:00.000Z'),
      fetchImpl: async () => ({ ok: true, text: async () => xml }),
    },
  );

  assert.deepEqual(result[0].items.map((item) => item.guid), ['fresh-1']);
  assert.equal(typeof state.seenArticles['fresh-1'], 'number');
  assert.equal(state.seenArticles['old-1'], undefined);
  assert.deepEqual(errors, []);
});

test('RSS fetching reports actionable source-specific HTTP errors', async () => {
  const errors = [];
  const result = await fetchRssFeeds(
    [{ name: 'Broken Newsletter', rss: 'https://broken.example/rss', url: 'https://broken.example' }],
    72,
    1,
    { seenArticles: {} },
    errors,
    undefined,
    undefined,
    { fetchImpl: async () => ({ ok: false, status: 503 }) },
  );

  assert.deepEqual(result, []);
  assert.deepEqual(errors, ['RSS: Failed to fetch Broken Newsletter: HTTP 503']);
});

test('category feed errors exclude failures recorded by earlier collectors', () => {
  const errors = [
    'RSS: Failed to fetch Newsletter A: HTTP 503',
    'RSS: Failed to fetch arXiv cs.AI: HTTP 502',
  ];

  assert.deepEqual(errorsSince(errors, 1), [
    'RSS: Failed to fetch arXiv cs.AI: HTTP 502',
  ]);
});

test('digest feed loader uses canonical URLs and replaces each invalid feed with an empty payload', async () => {
  assert.equal(CENTRAL_FEEDS.length, 6);
  assert.ok(CENTRAL_FEEDS.every(({ url }) => url.startsWith(
    'https://raw.githubusercontent.com/TheGoldenWave/Follow-up/main/',
  )));

  const feedsByUrl = new Map();
  for (const [category, filename] of feedCases) {
    const spec = CENTRAL_FEEDS.find((candidate) => candidate.category === category);
    feedsByUrl.set(spec.url, await readJson(filename));
  }
  const academicSpec = CENTRAL_FEEDS.find(({ category }) => category === 'academic');
  feedsByUrl.set(academicSpec.url, { schemaVersion: '2.0', papers: [] });

  const result = await loadCentralFeedData({
    fetchJson: async (url) => feedsByUrl.get(url),
  });

  assert.deepEqual(result.data.academic, []);
  assert.ok(result.data.x.length > 0);
  assert.ok(result.errors.some((error) => (
    error.includes('Academic feed is invalid')
    && error.includes('compatible schema 1.x')
  )));
});

test('released RSS source configurations contain only public HTTPS sources', async () => {
  for (const filename of [
    'config/feed-newsletters.json',
    'config/feed-academic.json',
    'config/feed-zh-tech.json',
  ]) {
    const config = await readJson(filename);
    assert.ok(config.sources.length > 0, filename);
    assert.ok(config.sources.every(({ rss }) => (
      typeof rss === 'string' && rss.startsWith('https://')
    )), filename);
    assert.ok(config.sources.every(({ rss, url }) => (
      !`${rss} ${url}`.includes('localhost')
    )), filename);
  }
});

test('workflow dispatch and generated-file tracking cover exactly the six live categories', async () => {
  const workflow = await readFile(new URL('.github/workflows/generate-feed.yml', repositoryRoot), 'utf8');

  for (const mode of ['tweets', 'podcasts', 'blogs', 'newsletters', 'academic', 'zh-tech']) {
    assert.match(workflow, new RegExp(`- ${mode}-only`));
  }
  for (const [, filename] of feedCases) {
    assert.match(workflow, new RegExp(filename.replace('.', '\\.')));
  }
  assert.doesNotMatch(workflow, /reports-only|feed-reports\.json/);
});
