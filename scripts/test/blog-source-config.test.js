import assert from 'node:assert/strict';
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

test('a complete source configuration is valid', () => {
  assert.deepEqual(validateBlogSources([validSource()]), {
    valid: true,
    errors: [],
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
