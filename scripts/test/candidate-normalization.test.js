import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_CONTENT_CHARACTER_LIMIT,
  LEGACY_SOURCE_ID_MAP,
  normalizeLegacyFeeds,
  PODCAST_CONTENT_CHARACTER_LIMIT,
  truncateUnicode,
} from '../candidate-normalization.js';
import { loadSourceRegistry } from '../source-registry.js';

const seenAt = '2026-09-06T08:00:00.000Z';
const registry = [
  { id: 'x:karpathy', channel: 'x', name: 'Renamed X', handle: 'new-handle' },
  { id: 'podcast:latent-space', channel: 'podcasts', name: 'Renamed Podcast' },
  { id: 'blog:anthropic-engineering', channel: 'blogs', name: 'Renamed Blog' },
  { id: 'newsletter:stratechery', channel: 'newsletters', name: 'Renamed Newsletter' },
  { id: 'academic:arxiv-cs-ai', channel: 'academic', name: 'Renamed Academic' },
  { id: 'zh-tech:36kr', channel: 'zh-tech', name: 'Renamed Chinese' },
];

function legacyFeeds(overrides = {}) {
  return {
    x: {
      x: [{ name: 'Old X Name', handle: 'karpathy', tweets: [{
        id: 'tweet-1', text: 'Tweet body', createdAt: '2026-09-05T01:00:00.000Z',
        url: 'https://x.com/alice/status/tweet-1?utm_source=test',
      }] }],
    },
    podcasts: {
      podcasts: [{ source: 'podcast', name: 'Latent Space', title: 'Episode', guid: 'episode-1',
        url: 'https://pod.example/episode/', publishedAt: null, transcript: 'Transcript' }],
    },
    blogs: {
      blogs: [{ source: 'blog', name: 'Anthropic Engineering', title: 'Post',
        url: 'https://blog.example/post/', publishedAt: '2026-09-04T00:00:00.000Z',
        author: 'Researcher', description: 'Description', content: 'Article body' }],
    },
    newsletters: { newsletters: [{ source: 'Old Newsletter Name', url: 'https://stratechery.com/', items: [{
      title: 'Issue', url: 'https://stratechery.com/issue', guid: 'issue-1',
      publishedAt: '2026-09-03T00:00:00.000Z', source: 'Old Newsletter Name', language: 'en',
      description: 'Issue summary',
    }] }] },
    academic: { papers: [{ source: 'Old Academic Name', url: 'https://arxiv.org/list/cs.AI/recent', items: [{
      title: 'Paper', url: 'https://arxiv.org/abs/2609.00001', guid: 'paper-1',
      publishedAt: '2026-09-02T00:00:00.000Z', source: 'arXiv cs.AI', language: 'en',
      summary: 'Abstract',
    }] }] },
    'zh-tech': { articles: [{ source: '旧中文名', url: 'https://36kr.com/', items: [{
      title: '中文文章', url: 'https://36kr.com/p/1', guid: 'zh-1',
      publishedAt: '2026-09-01T00:00:00.000Z', source: '旧中文名', language: 'zh',
      content: '正文',
    }] }] },
    ...overrides,
  };
}

test('normalizes all six legacy feeds into the unified candidate shape', () => {
  const candidates = normalizeLegacyFeeds(legacyFeeds(), { registry, seenAt });

  assert.deepEqual(candidates.map(({ channel, sourceId, sourceNativeId }) => ({
    channel, sourceId, sourceNativeId,
  })), [
    { channel: 'x', sourceId: 'x:karpathy', sourceNativeId: 'tweet-1' },
    { channel: 'podcasts', sourceId: 'podcast:latent-space', sourceNativeId: 'episode-1' },
    { channel: 'blogs', sourceId: 'blog:anthropic-engineering', sourceNativeId: undefined },
    { channel: 'newsletters', sourceId: 'newsletter:stratechery', sourceNativeId: 'issue-1' },
    { channel: 'academic', sourceId: 'academic:arxiv-cs-ai', sourceNativeId: 'paper-1' },
    { channel: 'zh-tech', sourceId: 'zh-tech:36kr', sourceNativeId: 'zh-1' },
  ]);
  assert.ok(candidates.every((candidate) => (
    /^[a-f0-9]{64}$/.test(candidate.candidateId)
      && /^[a-f0-9]{64}$/.test(candidate.contentFingerprint)
      && candidate.firstSeenAt === seenAt
      && candidate.lastSeenAt === seenAt
      && candidate.contentTruncated === false
  )));
  assert.equal(candidates[0].canonicalUrl, 'https://x.com/alice/status/tweet-1');
  assert.equal(candidates[2].author, 'Researcher');
  assert.equal(candidates[4].summarizationContent, 'Abstract');
});

test('falls back to canonical URL identity when a legacy item has no native ID', () => {
  const [first] = normalizeLegacyFeeds(legacyFeeds({
    x: { x: [{ name: 'Old X Name', handle: 'karpathy', tweets: [{
      text: 'No native id', createdAt: seenAt, url: 'https://x.com/karpathy/status/fallback/',
    }] }] },
    podcasts: { podcasts: [] }, blogs: { blogs: [] },
    newsletters: { newsletters: [] }, academic: { papers: [] }, 'zh-tech': { articles: [] },
  }), { registry, seenAt });

  assert.equal(first.sourceNativeId, undefined);
  assert.match(first.candidateId, /^[a-f0-9]{64}$/);
});

test('caps content by Unicode code points without splitting surrogate pairs', () => {
  const normalContent = `${'中'.repeat(24_000)}😀tail`;
  const podcastContent = `${'播'.repeat(80_000)}😀tail`;
  const feeds = legacyFeeds();
  feeds.blogs.blogs[0].content = normalContent;
  feeds.podcasts.podcasts[0].transcript = podcastContent;

  const candidates = normalizeLegacyFeeds(feeds, { registry, seenAt });
  const blog = candidates.find(({ channel }) => channel === 'blogs');
  const podcast = candidates.find(({ channel }) => channel === 'podcasts');

  assert.equal(Array.from(blog.summarizationContent).length, DEFAULT_CONTENT_CHARACTER_LIMIT);
  assert.equal(Array.from(podcast.summarizationContent).length, PODCAST_CONTENT_CHARACTER_LIMIT);
  assert.equal(blog.contentTruncated, true);
  assert.equal(podcast.contentTruncated, true);
  assert.doesNotMatch(blog.summarizationContent, /\uFFFD/);
  assert.deepEqual(truncateUnicode('a😀b', 2), { content: 'a😀', truncated: true });
  assert.deepEqual(truncateUnicode('中'.repeat(24_000), 24_000), {
    content: '中'.repeat(24_000), truncated: false,
  });
  assert.equal(Array.from(truncateUnicode('中'.repeat(24_001), 24_000).content).length, 24_000);
});

test('rejects legacy items whose source is absent or ambiguous in the registry', () => {
  assert.throws(
    () => normalizeLegacyFeeds(legacyFeeds(), { registry: registry.slice(1), seenAt }),
    /source registry/i,
  );
  assert.throws(
    () => normalizeLegacyFeeds(legacyFeeds(), {
      registry: [...registry, { id: 'x:karpathy', channel: 'x', name: 'Duplicate ID' }],
      seenAt,
    }),
    /ambiguous/i,
  );
  const unknown = legacyFeeds();
  unknown.x.x[0].handle = 'unmapped-handle';
  assert.throws(
    () => normalizeLegacyFeeds(unknown, { registry, seenAt }),
    /frozen legacy source mapping/i,
  );
});

test('an explicit source ID is authoritative and never falls back to display metadata', () => {
  const feeds = legacyFeeds({
    x: { x: [{ sourceId: 'x:karpathy', name: 'Changed Display Name', handle: 'changed', tweets: [{
      id: '1', text: 'Explicit', createdAt: seenAt, url: 'https://x.com/karpathy/status/1',
    }] }] },
    podcasts: { podcasts: [] }, blogs: { blogs: [] },
    newsletters: { newsletters: [] }, academic: { papers: [] }, 'zh-tech': { articles: [] },
  });
  const candidates = normalizeLegacyFeeds(feeds, {
    registry: [
      { id: 'x:karpathy', channel: 'x', name: 'Another Current Name', handle: 'another' },
      { id: 'x:other', channel: 'x', name: 'Changed Display Name', handle: 'changed' },
    ],
    seenAt,
  });
  assert.equal(candidates[0].sourceId, 'x:karpathy');

  feeds.x.x[0].sourceId = 'x:missing';
  assert.throws(
    () => normalizeLegacyFeeds(feeds, { registry, seenAt }),
    /source registry/i,
  );
});

test('legacy migration keys are frozen literals independent of current display metadata', () => {
  assert.ok(Object.isFrozen(LEGACY_SOURCE_ID_MAP));
  assert.ok(Object.values(LEGACY_SOURCE_ID_MAP).every(Object.isFrozen));
  assert.equal(LEGACY_SOURCE_ID_MAP.x.karpathy, 'x:karpathy');
  assert.equal(LEGACY_SOURCE_ID_MAP.podcasts['Latent Space'], 'podcast:latent-space');
  assert.equal(LEGACY_SOURCE_ID_MAP.blogs['Anthropic Engineering'], 'blog:anthropic-engineering');
  assert.equal(LEGACY_SOURCE_ID_MAP.newsletters['https://stratechery.com/'], 'newsletter:stratechery');

  const renamedRegistry = registry.map((source) => ({ ...source, name: `new-${source.id}` }));
  const candidates = normalizeLegacyFeeds(legacyFeeds(), { registry: renamedRegistry, seenAt });
  assert.deepEqual(candidates.map(({ sourceId }) => sourceId), registry.map(({ id }) => id));
});

test('rejects conflicting legacy keys and invalid explicit source IDs', () => {
  const conflicting = legacyFeeds();
  conflicting.newsletters.newsletters[0].rss = 'https://stratechery.com/feed/';
  conflicting.newsletters.newsletters[0].url = 'https://oneusefulthing.org/';
  assert.throws(
    () => normalizeLegacyFeeds(conflicting, { registry, seenAt }),
    /ambiguous/i,
  );

  const explicitEmpty = legacyFeeds();
  explicitEmpty.x.x[0].sourceId = '';
  assert.throws(
    () => normalizeLegacyFeeds(explicitEmpty, { registry, seenAt }),
    /sourceId/i,
  );
});

test('frozen legacy mapping matches the independently audited 70-source fixture', async () => {
  const expected = JSON.parse(await readFile(
    new URL('./fixtures/candidates/legacy-source-mapping.json', import.meta.url),
    'utf8',
  ));
  assert.equal(expected.length, 70);
  const fixtureIds = expected.map(({ sourceId }) => sourceId);
  assert.equal(new Set(fixtureIds).size, fixtureIds.length);
  const registryIds = (await loadSourceRegistry()).map(({ id }) => id);
  assert.deepEqual([...fixtureIds].sort(), [...registryIds].sort());
  for (const { channel, legacyKey, sourceId } of expected) {
    assert.equal(LEGACY_SOURCE_ID_MAP[channel]?.[legacyKey], sourceId, `${channel}: ${legacyKey}`);
  }
});
