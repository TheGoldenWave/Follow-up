import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSourceRegistry,
  loadSourceRegistry,
} from '../source-registry.js';

const expectedSourceIds = {
  x: [
    'x:karpathy',
    'x:swyx',
    'x:joshwoodward',
    'x:bcherny',
    'x:thsottiaux',
    'x:petergyang',
    'x:thenanyu',
    'x:realmadhuguru',
    'x:amandaaskell',
    'x:catwu',
    'x:trq212',
    'x:googlelabs',
    'x:amasad',
    'x:rauchg',
    'x:alexalbert',
    'x:levie',
    'x:ryolu',
    'x:garrytan',
    'x:mattturck',
    'x:zarazhangrui',
    'x:nikunj',
    'x:steipete',
    'x:danshipper',
    'x:adityaag',
    'x:sama',
    'x:claudeai',
    'x:dario-amodei',
    'x:nathanlabenz',
    'x:jackclarksf',
    'x:bentossell',
  ],
  podcasts: [
    'podcast:latent-space',
    'podcast:training-data',
    'podcast:no-priors',
    'podcast:unsupervised-learning',
    'podcast:mad-podcast',
    'podcast:ai-and-i',
    'podcast:lex-fridman',
    'podcast:cognitive-revolution',
    'podcast:lightcone',
    'podcast:acquired',
  ],
  blogs: [
    'blog:anthropic-engineering',
    'blog:claude-blog',
    'blog:anthropic-interpretability',
    'blog:anthropic-science',
    'blog:openai-alignment',
    'blog:google-antigravity',
    'blog:google-deepmind',
    'blog:google-research',
    'blog:microsoft-research',
    'blog:amazon-science',
    'blog:ibm-research',
    'blog:perplexity-research',
    'blog:qwen-blog',
    'blog:kimi-blog',
    'blog:ernie-blog',
    'blog:minimax-blog',
    'blog:apple-ml-research',
  ],
  newsletters: [
    'newsletter:stratechery',
    'newsletter:one-useful-thing',
    'newsletter:algorithmic-bridge',
    'newsletter:ai-snake-oil',
  ],
  academic: [
    'academic:arxiv-cs-ai',
    'academic:arxiv-cs-cl',
    'academic:arxiv-cs-cv',
    'academic:arxiv-cs-lg',
    'academic:arxiv-cs-ro',
    'academic:arxiv-cs-cr',
  ],
  'zh-tech': [
    'zh-tech:36kr',
    'zh-tech:sspai',
    'zh-tech:qbitai',
  ],
};

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

test('registry freezes the complete v0.2 source identity set by channel', async () => {
  const registry = await loadSourceRegistry();
  const actualSourceIds = Object.fromEntries(Object.keys(expectedSourceIds).map((channel) => [
    channel,
    registry.filter((source) => source.channel === channel).map((source) => source.id),
  ]));

  assert.deepEqual(actualSourceIds, expectedSourceIds);
});

test('changing a display name does not change or regenerate its explicit ID', () => {
  const configs = {
    defaultSources: {
      x_accounts: [{ id: 'x:stable-id', name: 'Original Name', handle: 'stable' }],
      podcasts: [],
    },
    blogs: { sources: [] },
    newsletters: { sources: [] },
    academic: { sources: [] },
    zhTech: { sources: [] },
  };

  const original = createSourceRegistry(configs);
  const renamed = createSourceRegistry({
    ...configs,
    defaultSources: {
      ...configs.defaultSources,
      x_accounts: [{ ...configs.defaultSources.x_accounts[0], name: 'Renamed Display' }],
    },
  });

  assert.equal(original[0].id, 'x:stable-id');
  assert.equal(renamed[0].id, 'x:stable-id');
});
