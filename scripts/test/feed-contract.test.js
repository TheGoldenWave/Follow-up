import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CENTRAL_FEED_FILES,
  FEED_SCHEMA_VERSION,
  createFeedEnvelope,
  validateFeed,
  validateFeedFiles,
} from '../feed-contract.js';
import {
  errorsSince,
  fetchRssFeeds,
  loadSources,
  main as runGenerator,
  normalizePublishedAt,
  parseRssFeed,
  pruneState,
} from '../generate-feed.js';
import { validateBlogSources } from '../blog-source-config.js';
import {
  CENTRAL_FEEDS,
  fetchJSON as fetchDigestJSON,
  loadCentralFeedData,
} from '../prepare-digest.js';
import { validateArtifactDirectory } from '../validate-feed-artifact.js';

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

test('RSS parsing keeps valid siblings when one item has a malformed publish date', () => {
  const xml = `<rss><channel>
    <item><title>Malformed date</title><guid>bad-date</guid><link>https://example.com/bad</link><pubDate>not-a-date</pubDate></item>
    <item><title>Valid date</title><guid>good-date</guid><link>https://example.com/good</link><pubDate>Tue, 02 Sep 2026 08:00:00 GMT</pubDate></item>
  </channel></rss>`;

  const items = parseRssFeed(xml);

  assert.equal(items.length, 2);
  assert.equal(items[0].publishedAt, null);
  assert.equal(items[1].publishedAt, '2026-09-02T08:00:00.000Z');
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
  assert.equal(
    typeof state.seenArticles['rss:https://example.com/rss:fresh-1'],
    'number',
  );
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

test('RSS dedupe namespaces identical GUIDs by category and source', async () => {
  const xml = `<rss><channel><item>
    <title>Shared GUID</title><guid>post-1</guid><link>https://example.com/post-1</link>
    <pubDate>Tue, 02 Sep 2026 08:00:00 GMT</pubDate>
  </item></channel></rss>`;
  const state = { seenArticles: {} };
  const result = await fetchRssFeeds(
    [
      { name: 'Source A', rss: 'https://a.example/rss', url: 'https://a.example' },
      { name: 'Source B', rss: 'https://b.example/rss', url: 'https://b.example' },
    ],
    72,
    1,
    state,
    [],
    undefined,
    undefined,
    {
      namespace: 'newsletters',
      now: () => Date.parse('2026-09-02T09:00:00.000Z'),
      fetchImpl: async () => ({ ok: true, text: async () => xml }),
    },
  );

  assert.equal(result.length, 2);
  assert.equal(Object.keys(state.seenArticles).length, 2);
  assert.equal(state.seenArticles['post-1'], undefined);
});

test('RSS dedupe recognizes legacy bare keys while migrating future writes', async () => {
  const state = { seenArticles: { 'legacy-guid': 123 } };
  const xml = `<rss><channel><item>
    <title>Legacy item</title><guid>legacy-guid</guid><link>https://example.com/legacy</link>
    <pubDate>Tue, 02 Sep 2026 08:00:00 GMT</pubDate>
  </item></channel></rss>`;

  const result = await fetchRssFeeds(
    [{ name: 'Legacy Source', rss: 'https://legacy.example/rss', url: 'https://legacy.example' }],
    72,
    1,
    state,
    [],
    undefined,
    undefined,
    {
      namespace: 'academic',
      now: () => Date.parse('2026-09-02T09:00:00.000Z'),
      fetchImpl: async () => ({ ok: true, text: async () => xml }),
    },
  );

  assert.deepEqual(result, []);
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

test('runtime blog configuration contains only sources with implemented collectors', async () => {
  const [config, candidates] = await Promise.all([
    readJson('config/feed-blogs.json'),
    readJson('config/blog-source-candidates.json'),
  ]);

  assert.deepEqual(config.sources.map(({ id, name }) => ({ id, name })), [
    { id: 'blog:anthropic-engineering', name: 'Anthropic Engineering' },
    { id: 'blog:claude-blog', name: 'Claude Blog' },
    { id: 'blog:anthropic-interpretability', name: 'Anthropic Interpretability' },
    { id: 'blog:anthropic-science', name: 'Anthropic Science' },
    { id: 'blog:openai-alignment', name: 'OpenAI Alignment Research Blog' },
    { id: 'blog:google-antigravity', name: 'Google Antigravity Blog' },
    { id: 'blog:google-deepmind', name: 'Google DeepMind Blog' },
    { id: 'blog:google-research', name: 'Google Research Blog' },
    { id: 'blog:microsoft-research', name: 'Microsoft Research Blog' },
    { id: 'blog:amazon-science', name: 'Amazon Science Blog' },
    { id: 'blog:ibm-research', name: 'IBM Research Blog' },
    { id: 'blog:perplexity-research', name: 'Perplexity Research Articles' },
    { id: 'blog:qwen-blog', name: 'Qwen Blog' },
    { id: 'blog:kimi-blog', name: 'Kimi Research & Tech Blog' },
    { id: 'blog:ernie-blog', name: 'ERNIE Blog' },
    { id: 'blog:minimax-blog', name: 'MiniMax Blog' },
    { id: 'blog:apple-ml-research', name: 'Apple Machine Learning Research' },
  ]);
  assert.deepEqual(validateBlogSources(config.sources), { valid: true, errors: [] });
  assert.deepEqual(config, candidates);
});

test('loadSources replaces legacy default blogs with feed-blogs configuration', async () => {
  const [sources, blogConfig] = await Promise.all([
    loadSources(),
    readJson('config/feed-blogs.json'),
  ]);

  assert.deepEqual(sources.blogs, blogConfig.sources);
  assert.equal(sources.blogs.length, 17);
  assert.ok(sources.x_accounts.length > 0);
});

test('blog shadow mode selects one source, emits a valid envelope, and performs no writes', async () => {
  const outputs = [];
  const diagnostics = [];
  const blog = {
    id: 'shadow-blog',
    name: 'Shadow Blog',
    url: 'https://example.com/blog/',
    language: 'en',
    discovery: [{ type: 'rss', url: 'https://example.com/feed.xml' }],
    articleUrlPatterns: ['^https://example\\.com/blog/[^/?]+$'],
    excludeUrlPatterns: [],
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('feed.xml')) return {
      ok: true, status: 200, url, headers: { get: () => null },
      text: async () => '<rss><channel><item><title>Shadow post</title><link>/blog/shadow</link><pubDate>2026-09-03</pubDate></item></channel></rss>',
    };
    return {
      ok: true, status: 200, url, headers: { get: () => null },
      text: async () => `<h1>Shadow post</h1><article>${'Valid shadow content '.repeat(15)}</article>`,
    };
  };

  const result = await runGenerator({
    args: ['--shadow', '--blog-source=shadow-blog'],
    fetchImpl,
    loadSourcesImpl: async () => ({ x_accounts: [], podcasts: [], blogs: [blog] }),
    now: () => Date.parse('2026-09-04T00:00:00Z'),
    stdout: (line) => outputs.push(line),
    stderr: (line) => diagnostics.push(line),
    writeFileImpl: async () => { throw new Error('shadow mode must not write'); },
  });
  const envelope = JSON.parse(outputs.join('\n'));

  assert.deepEqual(result, envelope);
  assert.deepEqual(validateFeed(envelope, 'blogs'), { valid: true, errors: [] });
  assert.equal(envelope.blogs.length, 1);
  assert.equal(envelope.generatedAt, '2026-09-04T00:00:00.000Z');
  assert.ok(diagnostics.some((line) => line.includes('Shadow Blog')));
});

test('checked-in state prevents every published tweet and podcast from republishing', async () => {
  const [state, xFeed, podcastFeed] = await Promise.all([
    readJson('state-feed.json'),
    readJson('feed-x.json'),
    readJson('feed-podcasts.json'),
  ]);

  for (const account of xFeed.x) {
    for (const tweet of account.tweets) {
      assert.equal(typeof state.seenTweets[tweet.id], 'number', tweet.id);
    }
  }
  for (const podcast of podcastFeed.podcasts) {
    assert.equal(typeof state.seenVideos[podcast.guid], 'number', podcast.guid);
  }
});

test('package and generation workflow run the unified test suite before generation', async () => {
  const [packageJson, workflow] = await Promise.all([
    readJson('scripts/package.json'),
    readFile(new URL('.github/workflows/generate-feed.yml', repositoryRoot), 'utf8'),
  ]);

  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
  const testStep = workflow.indexOf('npm test');
  const generateStep = workflow.indexOf('node generate-feed.js');
  assert.ok(testStep >= 0);
  assert.ok(generateStep > testStep);
});

test('generated feed validation covers all six artifacts and rejects an invalid one', async () => {
  assert.deepEqual(CENTRAL_FEED_FILES.map(({ filename }) => filename), feedCases.map(([, filename]) => filename));

  const validErrors = await validateFeedFiles({
    readJson: (filename) => readJson(filename),
  });
  assert.deepEqual(validErrors, []);

  const invalidErrors = await validateFeedFiles({
    readJson: async (filename) => (
      filename === 'feed-academic.json'
        ? { schemaVersion: '2.0', papers: [] }
        : readJson(filename)
    ),
  });
  assert.ok(invalidErrors.some((error) => error.includes('feed-academic.json')));
});

test('generation workflow validates generated feeds before staging them', async () => {
  const [packageJson, workflow] = await Promise.all([
    readJson('scripts/package.json'),
    readFile(new URL('.github/workflows/generate-feed.yml', repositoryRoot), 'utf8'),
  ]);

  assert.equal(packageJson.scripts['validate-feeds'], 'node feed-contract.js');
  const generateStep = workflow.indexOf('node generate-feed.js');
  const validateStep = workflow.indexOf('npm run validate-feeds');
  const stageStep = workflow.indexOf('git add feed-x.json');
  assert.ok(validateStep > generateStep);
  assert.ok(stageStep > validateStep);
});

test('state pruning retains podcast GUIDs for the full fourteen-day lookback', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-09-02T00:00:00.000Z');
  const state = {
    seenTweets: { recent: now - 6 * day, expired: now - 8 * day },
    seenVideos: { day9: now - 9 * day, day15: now - 15 * day },
    seenArticles: { recent: now - 6 * day, expired: now - 8 * day },
  };

  pruneState(state, now);

  assert.deepEqual(Object.keys(state.seenTweets), ['recent']);
  assert.deepEqual(Object.keys(state.seenVideos), ['day9']);
  assert.deepEqual(Object.keys(state.seenArticles), ['recent']);
});

test('digest JSON fetch aborts stalled requests using a bounded timeout', async (t) => {
  const startedAt = Date.now();
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => clearInterval(keepAlive));
  const stalledFetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  await assert.rejects(
    fetchDigestJSON('https://feed.example/data.json', {
      fetchImpl: stalledFetch,
      timeoutMs: 10,
    }),
    (error) => error?.name === 'TimeoutError',
  );
  assert.ok(Date.now() - startedAt < 1000);
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

test('feed artifact gate accepts exactly six feeds plus state and rejects unsafe contents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'follow-up-feeds-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const [, filename] of feedCases) {
    await writeFile(directory + '/' + filename, await readFile(new URL(filename, repositoryRoot)));
  }
  await writeFile(join(directory, 'state-feed.json'), await readFile(new URL('state-feed.json', repositoryRoot)));
  assert.deepEqual(await validateArtifactDirectory(directory), []);

  await writeFile(join(directory, 'unexpected.json'), '{}\n');
  assert.ok((await validateArtifactDirectory(directory)).some((error) => error.includes('unexpected.json')));
  await rm(join(directory, 'unexpected.json'));

  await rm(join(directory, 'feed-x.json'));
  await symlink(join(directory, 'feed-podcasts.json'), join(directory, 'feed-x.json'));
  assert.ok((await validateArtifactDirectory(directory)).some((error) => error.includes('symbolic link')));
});

test('feed workflow pins actions and separates secret generation from publishing', async () => {
  const workflow = await readFile(new URL('.github/workflows/generate-feed.yml', repositoryRoot), 'utf8');
  const pins = [
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0',
  ];
  for (const pin of pins) assert.ok(workflow.includes(pin), pin);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/);
  assert.match(workflow, /concurrency:[\s\S]*cancel-in-progress: false/);

  const generateJob = workflow.slice(workflow.indexOf('  generate:'), workflow.indexOf('  publish:'));
  const publishJob = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(generateJob, /permissions:\s*\n\s+contents: read/);
  assert.match(generateJob, /persist-credentials: false/);
  assert.match(generateJob, /secrets\.X_BEARER_TOKEN/);
  assert.doesNotMatch(generateJob, /contents: write/);
  assert.match(publishJob, /permissions:\s*\n\s+contents: write/);
  assert.doesNotMatch(publishJob, /secrets\.|X_BEARER_TOKEN|POD2TXT_API_KEY|npm (ci|install|test)/);
});

test('feed workflow transfers and publishes only the exact seven generated files', async () => {
  const workflow = await readFile(new URL('.github/workflows/generate-feed.yml', repositoryRoot), 'utf8');
  const expectedFiles = [...feedCases.map(([, filename]) => filename), 'state-feed.json'];
  const uploadStart = workflow.indexOf('actions/upload-artifact@');
  const publishStart = workflow.indexOf('  publish:');
  const uploadBlock = workflow.slice(uploadStart, publishStart);
  for (const filename of expectedFiles) assert.match(uploadBlock, new RegExp(`^\\s+${filename.replace('.', '\\.')}\\s*$`, 'm'));
  assert.equal((uploadBlock.match(/^\s+feed-[^\s]+\.json\s*$/gm) || []).length, 6);
  assert.match(uploadBlock, /if-no-files-found: error/);

  const publishJob = workflow.slice(publishStart);
  const checkout = publishJob.indexOf('actions/checkout@');
  const download = publishJob.indexOf('actions/download-artifact@');
  const validate = publishJob.indexOf('validate-feed-artifact.js');
  const stage = publishJob.indexOf('git add feed-x.json');
  const push = publishJob.indexOf('git push origin HEAD:main');
  assert.ok(checkout >= 0 && download > checkout && validate > download && stage > validate && push > stage);
  assert.match(publishJob, /ref: main/);
  assert.match(publishJob, /git fetch origin main/);
  assert.match(publishJob, /git rebase origin\/main/);
});
