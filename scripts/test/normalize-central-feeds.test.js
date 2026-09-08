import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildIdentityIndex,
  resolveSourceId,
  normalizeCentralFeed,
  normalizeCentralFeeds,
  emptyMigrationState,
  loadMigrationState,
  saveMigrationState,
} from '../lib/normalize-central-feeds.js';

const SEEN_AT = '2026-09-08T00:00:00.000Z';

function source(id, channel, extra = {}) {
  const { handle, name, url, rssUrl } = extra;
  return {
    id, name: name ?? id, channel,
    channel_policy: 'fixed', adapter: 'rss', requires_credentials: false,
    default_enabled: true, cadence: 'daily', budget: 3,
    input: {
      ...(handle ? { handle } : {}),
      ...(url ? { url } : {}),
      ...(rssUrl ? { rss_url: rssUrl } : {}),
    },
    legacy: { feed: 'feed.json' },
  };
}

test('buildIdentityIndex maps handle, name, url, and rss_url keys', () => {
  const sources = [
    source('x:brandnew', 'x', { handle: 'BrandNewHandle' }),
    source('blog:brand-new', 'blogs', { name: 'Brand New Blog' }),
    source('newsletter:example', 'newsletters', { url: 'https://example.com/', rssUrl: 'https://example.com/feed' }),
  ];
  const index = buildIdentityIndex(sources);
  assert.equal(index.get('x\0BrandNewHandle'), 'x:brandnew');
  assert.equal(index.get('blogs\0Brand New Blog'), 'blog:brand-new');
  assert.equal(index.get('newsletters\0https://example.com/'), 'newsletter:example');
  assert.equal(index.get('newsletters\0https://example.com/feed'), 'newsletter:example');
});

test('buildIdentityIndex rejects a duplicate identity across two sources', () => {
  const sources = [
    source('newsletter:a', 'newsletters', { url: 'https://example.com/' }),
    source('newsletter:b', 'newsletters', { url: 'https://example.com/' }),
  ];
  assert.throws(() => buildIdentityIndex(sources), /Duplicate central identity/);
});

test('resolveSourceId resolves through the index and returns null for unknown', () => {
  const index = buildIdentityIndex([
    source('x:brandnew', 'x', { handle: 'BrandNewHandle' }),
  ]);
  assert.equal(resolveSourceId(index, 'x', { handle: 'BrandNewHandle' }), 'x:brandnew');
  assert.equal(resolveSourceId(index, 'x', { handle: 'unknown' }), null);
  assert.equal(resolveSourceId(index, 'x', { sourceId: 'x:override' }), 'x:override');
});

test('normalizeCentralFeed resolves source_id from the registry, not the frozen map', () => {
  const sources = [source('x:brandnew', 'x', { handle: 'BrandNewHandle' })];
  const feed = {
    x: [{
      handle: 'BrandNewHandle',
      name: 'Brand New',
      tweets: [{ id: '1', text: 'hello world', url: 'https://x.com/BrandNewHandle/status/1' }],
    }],
  };
  const candidates = normalizeCentralFeed(feed, 'x', { sources, seenAt: SEEN_AT });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceId, 'x:brandnew');
  assert.equal(candidates[0].channel, 'x');
  assert.equal(candidates[0].title, 'hello world');
});

test('normalizeCentralFeed maps newsletter groups by url', () => {
  const sources = [source('newsletter:example', 'newsletters', { url: 'https://example.com/' })];
  const feed = {
    newsletters: [{
      url: 'https://example.com/',
      items: [{ title: 'A post', url: 'https://example.com/post', guid: 'g1' }],
    }],
  };
  const candidates = normalizeCentralFeed(feed, 'newsletters', { sources, seenAt: SEEN_AT });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceId, 'newsletter:example');
  assert.equal(candidates[0].title, 'A post');
});

test('normalizeCentralFeed throws when a central item has no registry match', () => {
  const sources = [source('x:brandnew', 'x', { handle: 'BrandNewHandle' })];
  const feed = { x: [{ handle: 'unknown', tweets: [{ id: '1', text: 'hi', url: 'https://x.com/unknown/status/1' }] }] };
  assert.throws(() => normalizeCentralFeed(feed, 'x', { sources, seenAt: SEEN_AT }), /No source registry entry/);
});

test('normalizeCentralFeeds spans multiple channels', () => {
  const sources = [
    source('x:brandnew', 'x', { handle: 'BrandNewHandle' }),
    source('blog:brand-new', 'blogs', { name: 'Brand New Blog' }),
  ];
  const feeds = {
    x: { x: [{ handle: 'BrandNewHandle', name: 'Brand New', tweets: [{ id: '1', text: 'tweet', url: 'https://x.com/BrandNewHandle/status/1' }] }] },
    blogs: { blogs: [{ name: 'Brand New Blog', title: 'Blog post', url: 'https://example.com/post', content: 'body' }] },
  };
  const candidates = normalizeCentralFeeds(feeds, { sources, seenAt: SEEN_AT });
  const byChannel = Object.groupBy(candidates, (candidate) => candidate.channel);
  assert.equal(byChannel.x.length, 1);
  assert.equal(byChannel.x[0].sourceId, 'x:brandnew');
  assert.equal(byChannel.blogs.length, 1);
  assert.equal(byChannel.blogs[0].sourceId, 'blog:brand-new');
});

test('migration state round-trips through the filesystem', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-migration-'));
  const path = join(dir, 'migration.json');
  try {
    assert.deepEqual(await loadMigrationState({ path }), emptyMigrationState());
    const state = {
      version: 1,
      sources: {
        'newsletter:example': {
          input: { url: 'https://example.com/' },
          cutover_at: null,
          observation_until: '2026-09-22T00:00:00.000Z',
          last_success_at: '2026-09-08T00:00:00.000Z',
          rollback_reason: null,
        },
      },
    };
    await saveMigrationState(state, { path });
    assert.deepEqual(await loadMigrationState({ path }), state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
