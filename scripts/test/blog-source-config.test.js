import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  canonicalizeArticleUrl,
  matchesBlogSource,
  validateBlogSources,
} from '../blog-source-config.js';

function validSource(overrides = {}) {
  return {
    id: 'example-blog',
    name: 'Example Blog',
    url: 'https://example.com/blog/',
    language: 'en',
    discovery: [
      { type: 'rss', url: 'https://example.com/blog/feed.xml' },
      { type: 'sitemap', url: 'https://example.com/sitemap.xml' },
      { type: 'html', url: 'https://example.com/blog/' },
    ],
    articleUrlPatterns: ['^https://example\\.com/blog/[^/?]+$'],
    excludeUrlPatterns: ['^https://example\\.com/blog/archive/'],
    ...overrides,
  };
}

function errorFor(result, sourceId, field) {
  return result.errors.find((error) => (
    error.includes(sourceId) && error.includes(field)
  ));
}

const approvedCandidateSources = [
  ['anthropic-engineering', 'Anthropic Engineering'],
  ['claude-blog', 'Claude Blog'],
  ['anthropic-interpretability', 'Anthropic Interpretability'],
  ['anthropic-science', 'Anthropic Science'],
  ['openai-alignment', 'OpenAI Alignment Research Blog'],
  ['google-antigravity', 'Google Antigravity Blog'],
  ['google-deepmind', 'Google DeepMind Blog'],
  ['google-research', 'Google Research Blog'],
  ['microsoft-research', 'Microsoft Research Blog'],
  ['amazon-science', 'Amazon Science Blog'],
  ['ibm-research', 'IBM Research Blog'],
  ['perplexity-research', 'Perplexity Research Articles'],
  ['qwen-blog', 'Qwen Blog'],
  ['kimi-blog', 'Kimi Research & Tech Blog'],
  ['ernie-blog', 'ERNIE Blog'],
  ['minimax-blog', 'MiniMax Blog'],
  ['apple-ml-research', 'Apple Machine Learning Research'],
];

const approvedSourceRoutes = {
  'anthropic-engineering': ['https://www.anthropic.com/engineering', [
    ['sitemap', 'https://www.anthropic.com/sitemap.xml'],
    ['html', 'https://www.anthropic.com/engineering'],
  ]],
  'claude-blog': ['https://claude.com/blog', [['html', 'https://claude.com/blog']]],
  'anthropic-interpretability': ['https://www.anthropic.com/research/team/interpretability', [
    ['html', 'https://www.anthropic.com/research/team/interpretability'],
  ]],
  'anthropic-science': ['https://www.anthropic.com/science', [
    ['html', 'https://www.anthropic.com/science'],
  ]],
  'openai-alignment': ['https://alignment.openai.com/', [
    ['rss', 'https://alignment.openai.com/rss.xml'],
    ['html', 'https://alignment.openai.com/'],
  ]],
  'google-antigravity': ['https://antigravity.google/blog', [
    ['html', 'https://antigravity.google/blog'],
    ['sitemap', 'https://antigravity.google/sitemap.xml'],
  ]],
  'google-deepmind': ['https://deepmind.google/blog/', [
    ['sitemap', 'https://deepmind.google/sitemap.xml'],
    ['html', 'https://deepmind.google/blog/'],
  ]],
  'google-research': ['https://research.google/blog/', [
    ['html', 'https://research.google/blog/'],
    ['sitemap', 'https://research.google/sitemap.xml'],
  ]],
  'microsoft-research': ['https://www.microsoft.com/en-us/research/blog/', [
    ['html', 'https://www.microsoft.com/en-us/research/blog/'],
    ['rss', 'https://www.microsoft.com/en-us/research/feed/'],
  ]],
  'amazon-science': ['https://www.amazon.science/blog/', [
    ['rss', 'https://www.amazon.science/index.rss'],
    ['html', 'https://www.amazon.science/blog/'],
  ]],
  'ibm-research': ['https://research.ibm.com/blog', [
    ['rss', 'https://research.ibm.com/rss'],
    ['html', 'https://research.ibm.com/blog'],
  ]],
  'perplexity-research': ['https://research.perplexity.ai/articles', [
    ['html', 'https://research.perplexity.ai/articles'],
    ['sitemap', 'https://research.perplexity.ai/sitemap.xml'],
  ]],
  'qwen-blog': ['https://qwen.ai/blog/', [['html', 'https://qwen.ai/blog/']]],
  'kimi-blog': ['https://www.kimi.ai/blog/', [
    ['html', 'https://www.kimi.ai/blog/'],
    ['sitemap', 'https://www.kimi.ai/sitemap.xml'],
  ]],
  'ernie-blog': ['https://ernie.baidu.com/blog/zh/', [
    ['rss', 'https://ernie.baidu.com/blog/zh/index.xml'],
    ['html', 'https://ernie.baidu.com/blog/zh/'],
  ]],
  'minimax-blog': ['https://www.minimax.cn/blog', [
    ['sitemap', 'https://www.minimax.cn/sitemap.xml'],
    ['html', 'https://www.minimax.cn/blog'],
  ]],
  'apple-ml-research': ['https://machinelearning.apple.com/', [
    ['rss', 'https://machinelearning.apple.com/rss.xml'],
    ['sitemap', 'https://machinelearning.apple.com/sitemap.xml'],
  ]],
};

test('candidate inventory contains the exact approved source IDs and names', async () => {
  const raw = await readFile(
    new URL('../../config/blog-source-candidates.json', import.meta.url),
    'utf8',
  );
  const config = JSON.parse(raw);

  assert.deepEqual(
    config.sources.map(({ id, name }) => [id, name]),
    approvedCandidateSources,
  );
  assert.equal(config.sources.length, 17);
  assert.deepEqual(validateBlogSources(config.sources), { valid: true, errors: [] });
});

test('candidate inventory pins approved origins and ordered discovery endpoints', async () => {
  const { sources } = JSON.parse(await readFile(
    new URL('../../config/blog-source-candidates.json', import.meta.url),
    'utf8',
  ));

  for (const source of sources) {
    const [url, discovery] = approvedSourceRoutes[source.id];
    assert.equal(source.url, url, source.id);
    assert.deepEqual(
      source.discovery.map(({ type, url: endpoint }) => [type, endpoint]),
      discovery,
      source.id,
    );
  }
});

test('a complete source configuration is valid', () => {
  assert.deepEqual(validateBlogSources([validSource()]), {
    valid: true,
    errors: [],
  });
});

test('the source collection must be an array', () => {
  assert.deepEqual(validateBlogSources(null), {
    valid: false,
    errors: ['sources: must be an array'],
  });
});

for (const field of ['id', 'name', 'language']) {
  test(`source ${field} is required`, () => {
    const source = validSource({ [field]: '' });
    const result = validateBlogSources([source]);

    assert.equal(result.valid, false);
    assert.ok(errorFor(result, field === 'id' ? 'source[0]' : 'example-blog', field));
  });
}

test('source URLs must use HTTPS', () => {
  const result = validateBlogSources([validSource({ url: 'http://example.com/blog/' })]);

  assert.equal(result.valid, false);
  assert.ok(errorFor(result, 'example-blog', 'url'));
});

test('discovery is required and preserves a nonempty ordered strategy list', () => {
  const empty = validateBlogSources([validSource({ discovery: [] })]);
  assert.ok(errorFor(empty, 'example-blog', 'discovery'));

  const source = validSource();
  assert.deepEqual(source.discovery.map(({ type }) => type), ['rss', 'sitemap', 'html']);
  assert.equal(validateBlogSources([source]).valid, true);
});

test('discovery entries require a supported type and HTTPS URL', () => {
  const unsupported = validateBlogSources([validSource({
    discovery: [{ type: 'atom', url: 'https://example.com/feed' }],
  })]);
  const insecure = validateBlogSources([validSource({
    discovery: [{ type: 'rss', url: 'http://example.com/feed' }],
  })]);

  assert.ok(errorFor(unsupported, 'example-blog', 'discovery[0].type'));
  assert.ok(errorFor(insecure, 'example-blog', 'discovery[0].url'));
});

test('source IDs must be unique', () => {
  const result = validateBlogSources([
    validSource(),
    validSource({ name: 'Duplicate Example' }),
  ]);

  assert.equal(result.valid, false);
  assert.ok(errorFor(result, 'example-blog', 'id'));
});

test('articleUrlPatterns must be a nonempty allow list', () => {
  const result = validateBlogSources([validSource({ articleUrlPatterns: [] })]);

  assert.equal(result.valid, false);
  assert.ok(errorFor(result, 'example-blog', 'articleUrlPatterns'));
});

test('allow and exclude patterns must be valid JavaScript regular expressions', () => {
  const allow = validateBlogSources([validSource({ articleUrlPatterns: ['['] })]);
  const exclude = validateBlogSources([validSource({ excludeUrlPatterns: ['('] })]);

  assert.ok(errorFor(allow, 'example-blog', 'articleUrlPatterns[0]'));
  assert.ok(errorFor(exclude, 'example-blog', 'excludeUrlPatterns[0]'));
});

test('parser names are limited to implemented source parsers', () => {
  for (const parser of ['anthropic-engineering', 'claude-blog']) {
    assert.equal(validateBlogSources([validSource({ parser })]).valid, true, parser);
  }

  const result = validateBlogSources([validSource({ parser: 'made-up-parser' })]);
  assert.ok(errorFor(result, 'example-blog', 'parser'));
});

test('contentSelectors values must be strings', () => {
  const valid = validateBlogSources([validSource({
    contentSelectors: ['article', 'main .post-body'],
  })]);
  const invalid = validateBlogSources([validSource({
    contentSelectors: ['article', 42],
  })]);

  assert.equal(valid.valid, true);
  assert.ok(errorFor(invalid, 'example-blog', 'contentSelectors[1]'));
});

test('exclude URL patterns take precedence over allow patterns', () => {
  const source = validSource({
    articleUrlPatterns: ['^https://example\\.com/blog/'],
    excludeUrlPatterns: ['^https://example\\.com/blog/archive/'],
  });

  assert.equal(matchesBlogSource('https://example.com/blog/new-post', source), true);
  assert.equal(matchesBlogSource('https://example.com/blog/archive/2025', source), false);
});

test('broad allow patterns cannot admit absolute URLs from another origin', () => {
  const source = validSource({ articleUrlPatterns: ['.*'] });

  assert.equal(matchesBlogSource('https://attacker.example/blog/post', source), false);
});

test('broad allow patterns cannot admit protocol-relative URLs from another origin', () => {
  const source = validSource({ articleUrlPatterns: ['.*'] });

  assert.equal(matchesBlogSource('//attacker.example/blog/post', source), false);
});

test('canonical URLs resolve relative values against the source URL', () => {
  assert.equal(
    canonicalizeArticleUrl('../posts/launch', 'https://example.com/blog/index.html'),
    'https://example.com/posts/launch',
  );
});

test('canonical URLs normalize default ports, fragments, and trailing slashes', () => {
  assert.equal(
    canonicalizeArticleUrl('https://EXAMPLE.com:443/posts/launch/#details'),
    'https://example.com/posts/launch',
  );
  assert.equal(
    canonicalizeArticleUrl('http://EXAMPLE.com:80/posts/launch/'),
    'http://example.com/posts/launch',
  );
});

test('canonical URLs remove tracking parameters while preserving business parameters', () => {
  assert.equal(
    canonicalizeArticleUrl(
      'https://example.com/post/?utm_source=news&utm_campaign=launch&ref=home&source=rss&id=42&lang=en',
    ),
    'https://example.com/post?id=42&lang=en',
  );
});

test('canonical URLs reject invalid or unsupported protocols', () => {
  for (const value of ['not a URL', 'ftp://example.com/post', 'javascript:alert(1)']) {
    assert.equal(canonicalizeArticleUrl(value), null, value);
  }
});
