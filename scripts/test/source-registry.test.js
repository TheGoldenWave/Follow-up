import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createSourceRegistry,
  loadSourceRegistry,
} from '../source-registry.js';

const repositoryRoot = new URL('../../', import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repositoryRoot), 'utf8'));
}

test('all running sources have globally unique explicit namespaced IDs', async () => {
  const registry = await loadSourceRegistry();
  const ids = registry.map(({ id }) => id);

  assert.ok(ids.includes('x:karpathy'));
  assert.ok(ids.includes('podcast:latent-space'));
  assert.ok(ids.includes('blog:anthropic-engineering'));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(registry.every(({ id, channel }) => {
    const namespace = channel === 'podcasts' ? 'podcast' : channel === 'blogs'
      ? 'blog' : channel === 'newsletters' ? 'newsletter' : channel;
    return id.startsWith(`${namespace}:`);
  }));
  assert.ok(Object.isFrozen(registry));
  assert.ok(registry.every(Object.isFrozen));
});

test('registry rejects missing, mismatched, and duplicate source IDs', () => {
  const base = {
    defaultSources: {
      x_accounts: [{ id: 'x:one', name: 'Display Name', handle: 'one' }],
      podcasts: [],
    },
    blogs: { sources: [] },
    newsletters: { sources: [] },
    academic: { sources: [] },
    zhTech: { sources: [] },
  };

  assert.throws(
    () => createSourceRegistry({
      ...base,
      defaultSources: { ...base.defaultSources, x_accounts: [{ name: 'One', handle: 'one' }] },
    }),
    /explicit.*id/i,
  );
  assert.throws(
    () => createSourceRegistry({
      ...base,
      defaultSources: { ...base.defaultSources, x_accounts: [{ id: 'blog:one', name: 'One', handle: 'one' }] },
    }),
    /namespace/i,
  );
  assert.throws(
    () => createSourceRegistry({
      ...base,
      defaultSources: {
        ...base.defaultSources,
        x_accounts: [
          { id: 'x:one', name: 'One', handle: 'one' },
          { id: 'x:one', name: 'Renamed Display', handle: 'other' },
        ],
      },
    }),
    /duplicate/i,
  );
});

test('registry uses the checked-in runtime configuration sets', async () => {
  const [registry, defaults, blogs, newsletters, academic, zhTech] = await Promise.all([
    loadSourceRegistry(),
    readJson('config/default-sources.json'),
    readJson('config/feed-blogs.json'),
    readJson('config/feed-newsletters.json'),
    readJson('config/feed-academic.json'),
    readJson('config/feed-zh-tech.json'),
  ]);
  const expectedCount = defaults.x_accounts.length
    + defaults.podcasts.length
    + blogs.sources.length
    + newsletters.sources.length
    + academic.sources.length
    + zhTech.sources.length;

  assert.equal(registry.length, expectedCount);
});

