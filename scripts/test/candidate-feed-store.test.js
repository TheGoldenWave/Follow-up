import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initializeCandidateFeed,
  loadCandidateFeed,
  mergeCandidateFeed,
} from '../candidate-feed-store.js';
import {
  createCandidateId,
  createContentFingerprint,
} from '../candidate-identity.js';

const DAY = 24 * 60 * 60 * 1000;
const collectionStart = '2026-09-06T08:00:00.000Z';
const registry = [
  { id: 'x:a', channel: 'x', name: 'X A' },
  { id: 'x:b', channel: 'x', name: 'X B' },
  { id: 'podcast:a', channel: 'podcasts', name: 'Podcast A' },
  { id: 'blog:a', channel: 'blogs', name: 'Blog A' },
  { id: 'newsletter:a', channel: 'newsletters', name: 'Newsletter A' },
  { id: 'academic:a', channel: 'academic', name: 'Academic A' },
  { id: 'zh-tech:a', channel: 'zh-tech', name: 'Chinese A' },
];

function status(source, candidateCount = 0) {
  return {
    sourceId: source.id,
    channel: source.channel,
    sourceName: source.name,
    status: candidateCount ? 'ok' : 'no-results',
    candidateCount,
  };
}

function candidate({
  sourceId = 'x:a', channel = 'x', nativeId, url, title = nativeId ?? url,
  publishedAt = collectionStart, firstSeenAt = collectionStart,
  lastSeenAt = collectionStart, content = title,
}) {
  const value = {
    channel,
    sourceId,
    ...(nativeId ? { sourceNativeId: nativeId } : {}),
    canonicalUrl: url ?? `https://example.com/${sourceId}/${nativeId}`,
    title,
    author: 'Author',
    publishedAt,
    firstSeenAt,
    lastSeenAt,
    summarizationContent: content,
    contentTruncated: false,
  };
  value.candidateId = createCandidateId(value);
  value.contentFingerprint = createContentFingerprint(value);
  return value;
}

function prior(candidates = [], overrides = {}) {
  return {
    schemaVersion: '1.0',
    generatedAt: collectionStart,
    initializedAt: '2026-09-01T08:00:00.000Z',
    continuousHistorySince: '2026-09-01T08:00:00.000Z',
    retention: { defaultDays: 15, podcastDays: 30, minimumPerSource: 50, maxCandidates: 1000 },
    historyTruncated: false,
    truncation: { affectedSourceIds: [], oldestRetainedAt: null, removedCount: 0 },
    registry: registry.map((source) => status(source)),
    candidates,
    ...overrides,
  };
}

function emptyFeeds() {
  return {
    x: { schemaVersion: '1.0', generatedAt: collectionStart, lookbackHours: 24, stats: {}, x: [] },
    podcasts: { schemaVersion: '1.0', generatedAt: collectionStart, lookbackHours: 336, stats: {}, podcasts: [] },
    blogs: { schemaVersion: '1.0', generatedAt: collectionStart, lookbackHours: 72, stats: {}, blogs: [] },
    newsletters: { schemaVersion: '1.0', generatedAt: collectionStart, lookbackHours: 72, stats: {}, newsletters: [] },
    academic: { schemaVersion: '1.0', generatedAt: collectionStart, lookbackHours: 168, stats: {}, papers: [] },
    'zh-tech': { schemaVersion: '1.0', generatedAt: collectionStart, lookbackHours: 72, stats: {}, articles: [] },
  };
}

test('loadCandidateFeed rejects missing, invalid, and uninitialized artifacts', async () => {
  await assert.rejects(
    loadCandidateFeed({ readFileImpl: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }, registry }),
    /missing.*initialize/i,
  );
  await assert.rejects(
    loadCandidateFeed({ readFileImpl: async () => '{bad', registry }),
    /invalid JSON/i,
  );
  await assert.rejects(
    loadCandidateFeed({ readFileImpl: async () => JSON.stringify({ schemaVersion: '1.0' }), registry }),
    /invalid candidate Feed/i,
  );
});

test('initialization validates all six legacy feeds and starts history at collection start', () => {
  const feeds = emptyFeeds();
  feeds.x.x.push({ source: 'x', sourceId: 'x:a', name: 'X A', handle: 'a', tweets: [{
    id: 'old-snapshot', text: 'Snapshot', createdAt: '2026-09-05T00:00:00.000Z',
    url: 'https://x.com/a/status/old-snapshot',
  }] });
  const current = candidate({ nativeId: 'current' });
  const feed = initializeCandidateFeed({
    feeds,
    currentCandidates: [current],
    statuses: registry.map((source) => status(source, source.id === 'x:a' ? 2 : 0)),
    registry,
    collectionStart,
  });

  assert.equal(feed.initializedAt, collectionStart);
  assert.equal(feed.continuousHistorySince, collectionStart);
  assert.deepEqual(feed.candidates.map(({ sourceNativeId }) => sourceNativeId).sort(), ['current', 'old-snapshot']);

  const invalidFeeds = emptyFeeds();
  delete invalidFeeds.blogs.blogs;
  assert.throws(() => initializeCandidateFeed({
    feeds: invalidFeeds, currentCandidates: [], statuses: registry.map((source) => status(source)),
    registry, collectionStart,
  }), /feed-blogs\.json/i);
});

test('merge preserves firstSeenAt, lets current content win, and collapses identities only within a source', () => {
  const original = candidate({ nativeId: 'same', title: 'Old', content: 'Old', firstSeenAt: '2026-09-01T00:00:00.000Z' });
  const refreshed = candidate({ nativeId: 'same', title: 'New', content: 'New' });
  const nativeAlias = candidate({ nativeId: 'same', url: 'https://example.com/alias', title: 'Alias' });
  const urlAlias = candidate({ nativeId: 'other', url: refreshed.canonicalUrl, title: 'URL alias' });
  const crossSource = candidate({ sourceId: 'x:b', nativeId: 'cross', title: 'New', content: 'New' });

  const merged = mergeCandidateFeed(prior([original]), {
    currentCandidates: [refreshed, nativeAlias, urlAlias, crossSource],
    statuses: registry.map((source) => status(source, source.id === 'x:a' ? 1 : source.id === 'x:b' ? 1 : 0)),
    registry,
    collectionStart,
  });

  assert.equal(merged.candidates.length, 2);
  const updated = merged.candidates.find(({ sourceId }) => sourceId === 'x:a');
  assert.equal(updated.firstSeenAt, original.firstSeenAt);
  assert.equal(updated.lastSeenAt, collectionStart);
  assert.equal(updated.title, 'New');
  assert.equal(updated.summarizationContent, 'New');
  assert.equal(merged.candidates.find(({ sourceId }) => sourceId === 'x:b').contentFingerprint, updated.contentFingerprint);
});

test('retains 15 complete days, 30 podcast days, and the newest 50 per source after retention', () => {
  const nowMs = Date.parse(collectionStart);
  const oldX = Array.from({ length: 55 }, (_, index) => candidate({
    nativeId: `x-${index}`,
    publishedAt: new Date(nowMs - (20 * DAY) - index).toISOString(),
    firstSeenAt: new Date(nowMs - (20 * DAY) - index).toISOString(),
  }));
  const oldPodcast = candidate({
    sourceId: 'podcast:a', channel: 'podcasts', nativeId: 'pod-old',
    publishedAt: new Date(nowMs - 29 * DAY).toISOString(),
    firstSeenAt: new Date(nowMs - 29 * DAY).toISOString(),
  });
  const expiredPodcast = candidate({
    sourceId: 'podcast:a', channel: 'podcasts', nativeId: 'pod-expired',
    publishedAt: new Date(nowMs - 31 * DAY).toISOString(),
    firstSeenAt: new Date(nowMs - 31 * DAY).toISOString(),
  });

  const merged = mergeCandidateFeed(prior([...oldX, oldPodcast, expiredPodcast]), {
    currentCandidates: [], statuses: registry.map((source) => status(source)), registry, collectionStart,
  });

  assert.equal(merged.candidates.filter(({ sourceId }) => sourceId === 'x:a').length, 50);
  assert.ok(merged.candidates.some(({ sourceNativeId }) => sourceNativeId === 'pod-old'));
  assert.ok(merged.candidates.some(({ sourceNativeId }) => sourceNativeId === 'pod-expired'));
  assert.equal(merged.historyTruncated, false);
});

test('global cap records only otherwise-retained removals and deterministic truncation metadata', () => {
  const nowMs = Date.parse(collectionStart);
  const candidates = Array.from({ length: 1005 }, (_, index) => candidate({
    sourceId: index % 2 ? 'x:a' : 'x:b',
    nativeId: `cap-${index}`,
    publishedAt: new Date(nowMs - index * 1000).toISOString(),
    firstSeenAt: new Date(nowMs - index * 1000).toISOString(),
  }));
  const merged = mergeCandidateFeed(prior(candidates.slice(0, 1000)), {
    currentCandidates: candidates.slice(1000),
    statuses: registry.map((source) => status(source)), registry, collectionStart,
  });

  assert.equal(merged.candidates.length, 1000);
  assert.equal(merged.historyTruncated, true);
  assert.deepEqual(merged.truncation.affectedSourceIds, ['x:a', 'x:b']);
  assert.equal(merged.truncation.removedCount, 5);
  assert.equal(merged.truncation.oldestRetainedAt, candidates[999].publishedAt);
  assert.deepEqual(merged.truncation.oldestRetainedFirstSeenAtBySource, {
    'x:a': candidates[999].firstSeenAt,
    'x:b': candidates[998].firstSeenAt,
  });
  assert.deepEqual(merged.truncation.oldestRemovedFirstSeenAtBySource, {
    'x:a': candidates[1003].firstSeenAt,
    'x:b': candidates[1004].firstSeenAt,
  });
  assert.deepEqual(merged.truncation.newestRemovedFirstSeenAtBySource, {
    'x:a': candidates[1001].firstSeenAt,
    'x:b': candidates[1000].firstSeenAt,
  });
});

test('cap truncation records first-seen boundaries even when publication dates are old', () => {
  const nowMs = Date.parse(collectionStart);
  const candidates = Array.from({ length: 1005 }, (_, index) => candidate({
    sourceId: index % 2 ? 'x:a' : 'x:b', nativeId: `first-seen-cap-${index}`,
    publishedAt: '2026-09-01T00:00:00.000Z',
    firstSeenAt: new Date(nowMs - index * 1000).toISOString(),
  }));
  const merged = mergeCandidateFeed(prior(candidates.slice(0, 1000)), {
    currentCandidates: candidates.slice(1000),
    statuses: registry.map((source) => status(source)), registry, collectionStart,
  });
  assert.equal(merged.historyTruncated, true);
  assert.equal(
    merged.truncation.oldestRetainedFirstSeenAtBySource['x:a'],
    candidates[999].firstSeenAt,
  );
});

test('first-seen truncation boundary includes a newly discovered old publication removed by the cap', () => {
  const nowMs = Date.parse(collectionStart);
  const retained = Array.from({ length: 1000 }, (_, index) => candidate({
    sourceId: index % 2 ? 'x:a' : 'x:b', nativeId: `newer-publication-${index}`,
    publishedAt: new Date(nowMs - index * 1000).toISOString(),
    firstSeenAt: '2026-09-01T00:00:00.000Z',
  }));
  const removed = candidate({
    sourceId: 'x:a', nativeId: 'old-publication-newly-discovered',
    publishedAt: '2026-09-01T00:00:00.000Z',
    firstSeenAt: '2026-09-06T07:59:00.000Z',
  });
  const merged = mergeCandidateFeed(prior(retained), {
    currentCandidates: [removed],
    statuses: registry.map((source) => status(source)), registry, collectionStart,
  });
  assert.equal(
    merged.truncation.oldestRetainedFirstSeenAtBySource['x:a'],
    removed.firstSeenAt,
  );
});

test('keeps prior cap truncation visible while the missing interval remains in retention', () => {
  const nowMs = Date.parse(collectionStart);
  const candidates = Array.from({ length: 1000 }, (_, index) => candidate({
    sourceId: index % 2 ? 'x:a' : 'x:b', nativeId: `kept-${index}`,
    publishedAt: new Date(nowMs - index * 1000).toISOString(),
    firstSeenAt: new Date(nowMs - index * 1000).toISOString(),
  }));
  const previous = prior(candidates, {
    historyTruncated: true,
    truncation: {
      affectedSourceIds: ['x:a'],
      oldestRetainedAt: candidates[999].publishedAt,
      removedCount: 5,
    },
  });

  const merged = mergeCandidateFeed(previous, {
    currentCandidates: [], statuses: registry.map((source) => status(source)), registry, collectionStart,
  });
  assert.equal(merged.historyTruncated, true);
  assert.deepEqual(merged.truncation, previous.truncation);
});

test('keeps prior truncation while an affected first-seen boundary remains recent', () => {
  const nextCollection = '2026-09-20T08:00:00.000Z';
  const current = candidate({
    nativeId: 'current', publishedAt: '2026-09-19T07:00:00.000Z',
    firstSeenAt: '2026-09-19T07:00:00.000Z', lastSeenAt: '2026-09-19T08:00:00.000Z',
  });
  const previous = prior([current], {
    generatedAt: '2026-09-19T08:00:00.000Z',
    historyTruncated: true,
    truncation: {
      affectedSourceIds: ['x:a'],
      oldestRetainedAt: '2026-08-01T00:00:00.000Z',
      oldestRetainedFirstSeenAtBySource: { 'x:a': '2026-09-19T00:00:00.000Z' },
      oldestRemovedFirstSeenAtBySource: { 'x:a': '2026-09-18T00:00:00.000Z' },
      newestRemovedFirstSeenAtBySource: { 'x:a': '2026-09-19T00:00:00.000Z' },
      removedCount: 1,
    },
  });
  const merged = mergeCandidateFeed(previous, {
    currentCandidates: [], statuses: registry.map((source) => status(source)), registry,
    collectionStart: nextCollection,
  });
  assert.equal(merged.historyTruncated, true);
  assert.deepEqual(merged.truncation, previous.truncation);
});

test('merging prior truncation conservatively expands each source removed first-seen range', () => {
  const nowMs = Date.parse(collectionStart);
  const candidates = Array.from({ length: 1005 }, (_, index) => candidate({
    sourceId: index % 2 ? 'x:a' : 'x:b', nativeId: `range-${index}`,
    publishedAt: new Date(nowMs - index * 1000).toISOString(),
    firstSeenAt: new Date(nowMs - index * 1000).toISOString(),
  }));
  const previous = prior(candidates.slice(0, 1000), {
    historyTruncated: true,
    truncation: {
      affectedSourceIds: ['x:a'],
      oldestRetainedAt: '2026-09-01T00:00:00.000Z',
      oldestRetainedFirstSeenAtBySource: { 'x:a': '2026-09-02T00:00:00.000Z' },
      oldestRemovedFirstSeenAtBySource: { 'x:a': '2026-09-01T00:00:00.000Z' },
      newestRemovedFirstSeenAtBySource: { 'x:a': '2026-09-06T07:59:30.000Z' },
      removedCount: 2,
    },
  });
  const merged = mergeCandidateFeed(previous, {
    currentCandidates: candidates.slice(1000),
    statuses: registry.map((source) => status(source)), registry, collectionStart,
  });
  assert.equal(merged.truncation.oldestRemovedFirstSeenAtBySource['x:a'], '2026-09-01T00:00:00.000Z');
  assert.equal(
    merged.truncation.newestRemovedFirstSeenAtBySource['x:a'],
    '2026-09-06T07:59:30.000Z',
  );
  assert.equal(
    merged.truncation.oldestRemovedFirstSeenAtBySource['x:b'],
    candidates[1004].firstSeenAt,
  );
});

test('retention uses complete UTC calendar days rather than elapsed local or DST hours', () => {
  const utcCollection = '2026-09-16T23:59:59.000Z';
  const recent = Array.from({ length: 50 }, (_, index) => candidate({
    nativeId: `recent-${index}`,
    publishedAt: new Date(Date.parse(utcCollection) - index * 1000).toISOString(),
    firstSeenAt: new Date(Date.parse(utcCollection) - index * 1000).toISOString(),
    lastSeenAt: utcCollection,
  }));
  const boundary = candidate({
    nativeId: 'utc-boundary', publishedAt: '2026-09-01T00:00:00.000Z',
    firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: utcCollection,
  });
  const expired = candidate({
    nativeId: 'before-utc-boundary', publishedAt: '2026-08-31T23:59:59.999Z',
    firstSeenAt: '2026-08-31T23:59:59.999Z', lastSeenAt: utcCollection,
  });
  const podcastBoundary = candidate({
    sourceId: 'podcast:a', channel: 'podcasts', nativeId: 'podcast-boundary',
    publishedAt: '2026-08-17T00:00:00.000Z', firstSeenAt: '2026-08-17T00:00:00.000Z',
    lastSeenAt: utcCollection,
  });
  const recentPodcasts = Array.from({ length: 50 }, (_, index) => candidate({
    sourceId: 'podcast:a', channel: 'podcasts', nativeId: `recent-podcast-${index}`,
    publishedAt: new Date(Date.parse(utcCollection) - index * 1000).toISOString(),
    firstSeenAt: new Date(Date.parse(utcCollection) - index * 1000).toISOString(),
    lastSeenAt: utcCollection,
  }));
  const expiredPodcast = candidate({
    sourceId: 'podcast:a', channel: 'podcasts', nativeId: 'before-podcast-boundary',
    publishedAt: '2026-08-16T23:59:59.999Z', firstSeenAt: '2026-08-16T23:59:59.999Z',
    lastSeenAt: utcCollection,
  });

  const merged = mergeCandidateFeed(prior([
    ...recent, boundary, expired, ...recentPodcasts, podcastBoundary, expiredPodcast,
  ], {
    generatedAt: utcCollection,
  }), {
    currentCandidates: [], statuses: registry.map((source) => status(source)), registry,
    collectionStart: utcCollection,
  });
  assert.ok(merged.candidates.some(({ sourceNativeId }) => sourceNativeId === 'utc-boundary'));
  assert.ok(!merged.candidates.some(({ sourceNativeId }) => sourceNativeId === 'before-utc-boundary'));
  assert.ok(merged.candidates.some(({ sourceNativeId }) => sourceNativeId === 'podcast-boundary'));
  assert.ok(!merged.candidates.some(({ sourceNativeId }) => sourceNativeId === 'before-podcast-boundary'));
});
