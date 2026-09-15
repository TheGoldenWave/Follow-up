import assert from 'node:assert/strict';
import test from 'node:test';

import { createSourceRegistry, loadSourceRegistry } from '../source-registry.js';

const v03SourceIds = new Set(`
academic:arxiv-cs-ai academic:arxiv-cs-cl academic:arxiv-cs-cr academic:arxiv-cs-cv
academic:arxiv-cs-lg academic:arxiv-cs-ro blog:amazon-science blog:anthropic-engineering
blog:anthropic-interpretability blog:anthropic-science blog:apple-ml-research blog:claude-blog
blog:ernie-blog blog:google-antigravity blog:google-deepmind blog:google-research blog:ibm-research
blog:kimi-blog blog:microsoft-research blog:minimax-blog blog:openai-alignment blog:perplexity-research
blog:qwen-blog newsletter:ai-snake-oil newsletter:algorithmic-bridge newsletter:bens-bites
newsletter:import-ai newsletter:one-useful-thing newsletter:stratechery newsletter:the-batch
newsletter:the-gradient newsletter:tldr-ai podcast:acquired podcast:ai-and-i podcast:cognitive-revolution
podcast:latent-space podcast:lex-fridman podcast:lightcone podcast:mad-podcast podcast:no-priors
podcast:training-data podcast:unsupervised-learning report:a16z-ai-canon report:cbinsights-ai
report:firstmark-mad report:stanford-ai-index report:state-of-ai x:adityaag x:alexalbert
x:amandaaskell x:amasad x:bcherny x:bentossell x:catwu x:claudeai x:danshipper
x:dario-amodei x:garrytan x:googlelabs x:jackclarksf x:joshwoodward x:karpathy x:levie
x:mattturck x:nathanlabenz x:nikunj x:petergyang x:rauchg x:realmadhuguru x:ryolu
x:sama x:steipete x:swyx x:thenanyu x:thsottiaux x:trq212 x:zarazhangrui zh-tech:36kr
zh-tech:aiera zh-tech:jiqizhixin zh-tech:qbitai zh-tech:sspai
`.trim().split(/\s+/));

const v04SourceIds = new Set([
  'community:github', 'community:hacker-news', 'community:techmeme',
  'community:reddit-machinelearning', 'community:reddit-localllama',
  'community:reddit-artificial', 'academic:hugging-face-papers',
]);

test('registry requires an explicit supported scope', async () => {
  await assert.rejects(loadSourceRegistry(), /scope/i);
  await assert.rejects(loadSourceRegistry({ scope: 'default' }), /scope/i);
  assert.throws(() => createSourceRegistry({ schema_version: '1.0', sources: [] }), /scope/i);
});

test('canonical registry has 89 sources, preserves all 82 IDs, and keeps central at 70', async () => {
  const [all, central, local] = await Promise.all([
    loadSourceRegistry({ scope: 'all' }),
    loadSourceRegistry({ scope: 'central-live' }),
    loadSourceRegistry({ scope: 'local-enabled' }),
  ]);
  assert.equal(all.length, 89);
  assert.equal(central.length, 70);
  assert.equal(local.length, all.filter(({ default_enabled: enabled }) => enabled).length);
  assert.deepEqual(new Set(all.filter(({ id }) => !v04SourceIds.has(id)).map(({ id }) => id)), v03SourceIds);
  assert.ok(central.every((source) => source.legacy.feed !== null));
  assert.ok(local.every((source) => source.default_enabled));
  assert.ok([...v04SourceIds].every((id) => all.some((source) => source.id === id)));
});

test('compatibility projection preserves central identity selectors', async () => {
  const registry = await loadSourceRegistry({ scope: 'central-live' });
  const x = registry.find(({ id }) => id === 'x:karpathy');
  const podcast = registry.find(({ id }) => id === 'podcast:latent-space');
  const blog = registry.find(({ id }) => id === 'blog:anthropic-engineering');
  const academic = registry.find(({ id }) => id === 'academic:arxiv-cs-ai');
  assert.equal(x.handle, x.input.handle);
  assert.equal(podcast.rssUrl, podcast.input.rss_url);
  assert.equal(blog.articleUrlPatterns, blog.input.article_url_patterns);
  assert.equal(academic.rss, academic.input.rss_url);
  assert.equal(academic.url, academic.input.url);
  assert.deepEqual(academic.tags, ['academic', 'ai', 'daily']);
  assert.equal(academic.maxArticles, academic.budget);
});

test('registry is deeply frozen and detached from caller input', () => {
  const document = {
    schema_version: '1.0',
    sources: [{ id: 'x:one', name: 'One', channel: 'x', channel_policy: 'fixed', adapter: 'x',
      requires_credentials: true, default_enabled: true, cadence: 'daily', budget: 1,
      input: { handle: 'one' }, legacy: { feed: 'feed-x.json' } }],
  };
  const registry = createSourceRegistry(document, { scope: 'all' });
  document.sources[0].name = 'Mutated';
  document.sources[0].input.handle = 'mutated';
  assert.equal(registry[0].name, 'One');
  assert.equal(registry[0].handle, 'one');
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry[0]));
  assert.ok(Object.isFrozen(registry[0].input));
  assert.ok(Object.isFrozen(registry[0].legacy));
  assert.throws(() => { registry[0].input.handle = 'changed'; }, TypeError);
});

test('createSourceRegistry rejects malformed canonical documents', () => {
  assert.throws(
    () => createSourceRegistry({ schema_version: '1.0', sources: [{ id: 'bad' }] }, { scope: 'all' }),
    /namespaced|source/i,
  );
  assert.throws(
    () => createSourceRegistry({ schema_version: '0.9', sources: [] }, { scope: 'all' }),
    /schema/i,
  );
});

test('source IDs accept 128 characters and reject 129 without echoing the ID', () => {
  const source = (id) => ({
    id, name: 'Boundary', channel: 'x', channel_policy: 'fixed', adapter: 'x',
    requires_credentials: true, default_enabled: false, cadence: 'daily', budget: 1,
    input: { handle: 'boundary' }, legacy: { feed: 'feed-x.json' },
  });
  const accepted = `x:${'a'.repeat(126)}`;
  const rejected = `x:${'a'.repeat(127)}`;
  assert.equal(accepted.length, 128);
  assert.equal(rejected.length, 129);
  assert.equal(createSourceRegistry({ schema_version: '1.0', sources: [source(accepted)] },
    { scope: 'all' })[0].id, accepted);
  assert.throws(
    () => createSourceRegistry({ schema_version: '1.0', sources: [source(rejected)] }, { scope: 'all' }),
    (error) => /source id length/i.test(error.message) && !error.message.includes(rejected),
  );
});
