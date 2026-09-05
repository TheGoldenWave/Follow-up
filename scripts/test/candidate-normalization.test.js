import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeLegacyFeeds,
  truncateUtf8,
} from '../candidate-normalization.js';

const seenAt = '2026-09-06T08:00:00.000Z';
const registry = [
  { id: 'x:alice', channel: 'x', name: 'Alice', handle: 'alice' },
  { id: 'podcast:show', channel: 'podcasts', name: 'The Show' },
  { id: 'blog:lab', channel: 'blogs', name: 'Lab Blog' },
  { id: 'newsletter:letter', channel: 'newsletters', name: 'The Letter' },
  { id: 'academic:ai', channel: 'academic', name: 'arXiv cs.AI' },
  { id: 'zh-tech:site', channel: 'zh-tech', name: '科技站' },
];

function legacyFeeds(overrides = {}) {
  return {
    x: {
      x: [{ name: 'Alice', handle: 'alice', tweets: [{
        id: 'tweet-1', text: 'Tweet body', createdAt: '2026-09-05T01:00:00.000Z',
        url: 'https://x.com/alice/status/tweet-1?utm_source=test',
      }] }],
    },
    podcasts: {
      podcasts: [{ source: 'podcast', name: 'The Show', title: 'Episode', guid: 'episode-1',
        url: 'https://pod.example/episode/', publishedAt: null, transcript: 'Transcript' }],
    },
    blogs: {
      blogs: [{ source: 'blog', name: 'Lab Blog', title: 'Post',
        url: 'https://blog.example/post/', publishedAt: '2026-09-04T00:00:00.000Z',
        author: 'Researcher', description: 'Description', content: 'Article body' }],
    },
    newsletters: { newsletters: [{ source: 'The Letter', url: 'https://letter.example', items: [{
      title: 'Issue', url: 'https://letter.example/issue', guid: 'issue-1',
      publishedAt: '2026-09-03T00:00:00.000Z', source: 'The Letter', language: 'en',
      description: 'Issue summary',
    }] }] },
    academic: { papers: [{ source: 'arXiv cs.AI', url: 'https://arxiv.org/list/cs.AI/recent', items: [{
      title: 'Paper', url: 'https://arxiv.org/abs/2609.00001', guid: 'paper-1',
      publishedAt: '2026-09-02T00:00:00.000Z', source: 'arXiv cs.AI', language: 'en',
      summary: 'Abstract',
    }] }] },
    'zh-tech': { articles: [{ source: '科技站', url: 'https://tech.example', items: [{
      title: '中文文章', url: 'https://tech.example/p/1', guid: 'zh-1',
      publishedAt: '2026-09-01T00:00:00.000Z', source: '科技站', language: 'zh',
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
    { channel: 'x', sourceId: 'x:alice', sourceNativeId: 'tweet-1' },
    { channel: 'podcasts', sourceId: 'podcast:show', sourceNativeId: 'episode-1' },
    { channel: 'blogs', sourceId: 'blog:lab', sourceNativeId: undefined },
    { channel: 'newsletters', sourceId: 'newsletter:letter', sourceNativeId: 'issue-1' },
    { channel: 'academic', sourceId: 'academic:ai', sourceNativeId: 'paper-1' },
    { channel: 'zh-tech', sourceId: 'zh-tech:site', sourceNativeId: 'zh-1' },
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
    x: { x: [{ name: 'Alice', handle: 'alice', tweets: [{
      text: 'No native id', createdAt: seenAt, url: 'https://x.com/alice/status/fallback/',
    }] }] },
    podcasts: { podcasts: [] }, blogs: { blogs: [] },
    newsletters: { newsletters: [] }, academic: { papers: [] }, 'zh-tech': { articles: [] },
  }), { registry, seenAt });

  assert.equal(first.sourceNativeId, undefined);
  assert.match(first.candidateId, /^[a-f0-9]{64}$/);
});

test('caps normal content at 24,000 UTF-8 bytes and podcast transcripts at 80,000', () => {
  const normalContent = `${'a'.repeat(23_999)}😀tail`;
  const podcastContent = `${'b'.repeat(79_999)}😀tail`;
  const feeds = legacyFeeds();
  feeds.blogs.blogs[0].content = normalContent;
  feeds.podcasts.podcasts[0].transcript = podcastContent;

  const candidates = normalizeLegacyFeeds(feeds, { registry, seenAt });
  const blog = candidates.find(({ channel }) => channel === 'blogs');
  const podcast = candidates.find(({ channel }) => channel === 'podcasts');

  assert.equal(Buffer.byteLength(blog.summarizationContent), 23_999);
  assert.equal(Buffer.byteLength(podcast.summarizationContent), 79_999);
  assert.equal(blog.contentTruncated, true);
  assert.equal(podcast.contentTruncated, true);
  assert.doesNotMatch(blog.summarizationContent, /\uFFFD/);
  assert.deepEqual(truncateUtf8('a😀b', 5), { content: 'a😀', truncated: true });
});

test('rejects legacy items whose source is absent or ambiguous in the registry', () => {
  assert.throws(
    () => normalizeLegacyFeeds(legacyFeeds(), { registry: registry.slice(1), seenAt }),
    /source registry/i,
  );
  assert.throws(
    () => normalizeLegacyFeeds(legacyFeeds(), {
      registry: [...registry, { id: 'x:other', channel: 'x', name: 'Alice', handle: 'alice' }],
      seenAt,
    }),
    /ambiguous/i,
  );
});

test('an explicit source ID is authoritative and never falls back to display metadata', () => {
  const feeds = legacyFeeds({
    x: { x: [{ sourceId: 'x:alice', name: 'Duplicate Name', handle: 'duplicate', tweets: [{
      id: '1', text: 'Explicit', createdAt: seenAt, url: 'https://x.com/alice/status/1',
    }] }] },
    podcasts: { podcasts: [] }, blogs: { blogs: [] },
    newsletters: { newsletters: [] }, academic: { papers: [] }, 'zh-tech': { articles: [] },
  });
  const candidates = normalizeLegacyFeeds(feeds, {
    registry: [
      { id: 'x:alice', channel: 'x', name: 'Alice', handle: 'alice' },
      { id: 'x:duplicate', channel: 'x', name: 'Duplicate Name', handle: 'duplicate' },
    ],
    seenAt,
  });
  assert.equal(candidates[0].sourceId, 'x:alice');

  feeds.x.x[0].sourceId = 'x:missing';
  assert.throws(
    () => normalizeLegacyFeeds(feeds, { registry, seenAt }),
    /source registry/i,
  );
});
