import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as blogExtraction from '../blog-extraction.js';
import {
  extractAnthropicArticleContent,
  extractClaudeBlogArticleContent,
} from '../blog-extraction.js';
import { matchesBlogSource } from '../blog-source-config.js';

async function fixture(path) {
  return readFile(new URL(`fixtures/blogs/${path}`, import.meta.url), 'utf8');
}

async function candidateSources() {
  const raw = await readFile(
    new URL('../../config/blog-source-candidates.json', import.meta.url),
    'utf8',
  );
  return JSON.parse(raw).sources;
}

test('every approved source article fixture extracts valid source-matching content', async () => {
  for (const source of await candidateSources()) {
    const html = await fixture(`${source.id}/article.html`);
    const extraction = blogExtraction.extractBlogArticle(html, source.url, source);

    assert.ok(extraction?.title, source.id);
    assert.ok(extraction.content.replace(/\s/g, '').length >= 200, source.id);
    assert.ok(matchesBlogSource(extraction.canonicalUrl, source), source.id);
  }
});

test('characterizes Anthropic Engineering article extraction', async () => {
  const html = await fixture('anthropic-engineering/article.html');

  assert.deepEqual(extractAnthropicArticleContent(html), {
    title: 'Building reliable agents',
    author: 'A. Researcher',
    publishedAt: '2026-08-28T09:00:00Z',
    content: 'First paragraph with an & ampersand.\n\nSecond paragraph.',
  });
});

test('characterizes Claude Blog article extraction', async () => {
  const html = await fixture('claude-blog/article.html');

  assert.deepEqual(extractClaudeBlogArticleContent(html), {
    title: 'Claude for focused work',
    author: 'Claude Team',
    publishedAt: '2026-08-29T10:30:00Z',
    content: 'Start with research & planning. Then write with confidence.',
  });
});

test('preserves Anthropic legacy fallback cleanup and entity behavior', async () => {
  const html = await fixture('anthropic-engineering/fallback-with-boilerplate.html');

  assert.deepEqual(extractAnthropicArticleContent(html), {
    title: 'Anthropic fallback',
    author: '',
    publishedAt: null,
    content: `${`Legacy header text. Legacy navigation text. Legacy aside text. Useful Anthropic fallback content & clear evidence ${'useful fallback content '.repeat(14)}`.trim()}.`,
  });
});

test('preserves Claude legacy broad fallback cleanup and entity behavior', async () => {
  const html = await fixture('claude-blog/fallback-with-boilerplate.html');

  assert.deepEqual(extractClaudeBlogArticleContent(html), {
    title: 'Fallback article',
    author: '',
    publishedAt: null,
    content: `${`Fallback article Related links must not become article content. Useful fallback content & clear evidence ${'useful fallback content '.repeat(14)}`.trim()}.`,
  });
});

test('exports the generic blog article extractor', () => {
  assert.equal(typeof blogExtraction.extractBlogArticle, 'function');
});

const longText = (label = 'Article content') => `${label} ${'useful evidence '.repeat(18)}`.trim();
const genericSource = {
  id: 'example-blog',
  name: 'Example Blog',
  url: 'https://example.com/blog/',
};

function jsonLdHtml(value, body = '') {
  const json = JSON.stringify(value).replace(/<\/script>/gi, '<\\/script>');
  return `<html><head><script type="application/ld+json">${json}</script></head><body>${body}</body></html>`;
}

test('extractBlogArticle finds every approved article type in JSON-LD objects, arrays, and @graph', () => {
  const cases = [
    ['BlogPosting', (article) => article],
    ['Article', (article) => [{ '@type': 'WebSite', name: 'Site' }, article]],
    ['NewsArticle', (article) => ({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization' }, article] })],
    ['TechArticle', (article) => ({ '@graph': [article] })],
  ];

  for (const [type, wrap] of cases) {
    const articleBody = longText(`${type} body`);
    const html = jsonLdHtml(wrap({
      '@type': type,
      headline: `${type} headline`,
      datePublished: '2026-09-03T08:00:00Z',
      author: [{ name: 'First Author' }, { name: 'Second Author' }],
      description: `${type} description`,
      url: `/blog/${type.toLowerCase()}?utm_source=fixture#section`,
      articleBody,
    }));

    assert.deepEqual(blogExtraction.extractBlogArticle(
      html,
      `https://example.com/blog/fallback-${type.toLowerCase()}`,
      genericSource,
    ), {
      title: `${type} headline`,
      canonicalUrl: `https://example.com/blog/${type.toLowerCase()}`,
      publishedAt: '2026-09-03T08:00:00Z',
      author: 'First Author, Second Author',
      description: `${type} description`,
      content: articleBody,
    });
  }
});

test('JSON-LD metadata wins over Open Graph and semantic metadata', () => {
  const body = longText('Structured body');
  const html = `<!doctype html><html><head>
    <link rel="canonical" href="/blog/link-canonical?ref=header#top">
    <meta property="og:title" content="Open Graph title">
    <meta property="article:published_time" content="2025-01-01">
    <meta name="author" content="Meta Author">
    <meta name="description" content="Meta description">
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Article',
      headline: 'Structured title',
      datePublished: '2026-09-03',
      author: { '@type': 'Person', name: 'Structured Author' },
      description: 'Structured description',
      articleBody: body,
    })}</script>
  </head><body><h1>Semantic title</h1><time datetime="2024-01-01"></time></body></html>`;

  assert.deepEqual(blogExtraction.extractBlogArticle(
    html,
    'https://example.com/blog/original?utm_campaign=test',
    genericSource,
  ), {
    title: 'Structured title',
    canonicalUrl: 'https://example.com/blog/link-canonical',
    publishedAt: '2026-09-03',
    author: 'Structured Author',
    description: 'Structured description',
    content: body,
  });
});

test('invalid or non-scalar publish dates from JSON-LD, meta, and time become null', () => {
  const body = longText('Date validation body');
  const cases = [
    jsonLdHtml({
      '@type': 'Article',
      headline: 'Structured invalid date',
      datePublished: { value: '2026-09-03' },
      articleBody: body,
    }),
    `<html><head><meta name="date" content="not-a-date"></head><body><h1>Meta invalid date</h1><article>${body}</article></body></html>`,
    `<html><body><h1>Time invalid date</h1><time datetime="not-a-date"></time><article>${body}</article></body></html>`,
  ];

  for (const [index, html] of cases.entries()) {
    assert.equal(blogExtraction.extractBlogArticle(
      html,
      `https://example.com/blog/invalid-date-${index}`,
      genericSource,
    )?.publishedAt, null);
  }
});

test('a valid scalar publish date remains raw and parseable', () => {
  const rawDate = 'Sep 3, 2026';
  const result = blogExtraction.extractBlogArticle(jsonLdHtml({
    '@type': 'Article',
    headline: 'Raw valid date',
    datePublished: rawDate,
    articleBody: longText('Raw date body'),
  }), 'https://example.com/blog/raw-date', genericSource);

  assert.equal(result.publishedAt, rawDate);
  assert.equal(Number.isNaN(Date.parse(result.publishedAt)), false);
});

test('Open Graph and standard meta values provide metadata fallbacks', () => {
  const body = longText('Meta fallback body');
  const html = `<html><head>
    <meta property='og:title' content='Open &amp; Useful'>
    <meta property='og:url' content='/blog/meta?source=share'>
    <meta property='article:published_time' content='2026-09-02T12:00:00Z'>
    <meta name='author' content='Meta &amp; Team'>
    <meta property='og:description' content='A &quot;clear&quot; summary'>
  </head><body><main>${body}</main></body></html>`;

  assert.deepEqual(blogExtraction.extractBlogArticle(
    html,
    'https://example.com/blog/fallback',
    genericSource,
  ), {
    title: 'Open & Useful',
    canonicalUrl: 'https://example.com/blog/meta',
    publishedAt: '2026-09-02T12:00:00Z',
    author: 'Meta & Team',
    description: 'A "clear" summary',
    content: body,
  });
});

test('semantic h1, time, article, and main elements are fallbacks', () => {
  const articleBody = longText('Article element wins');
  const mainBody = longText('Main element loses');
  const html = `<html><body>
    <h1>Semantic &amp; accessible title</h1>
    <time datetime="2026-09-01T07:30:00Z">September 1</time>
    <article><p>${articleBody}</p></article>
    <main><p>${mainBody}</p></main>
  </body></html>`;

  assert.deepEqual(blogExtraction.extractBlogArticle(
    html,
    'https://example.com/blog/semantic#intro',
    genericSource,
  ), {
    title: 'Semantic & accessible title',
    canonicalUrl: 'https://example.com/blog/semantic',
    publishedAt: '2026-09-01T07:30:00Z',
    author: '',
    description: '',
    content: articleBody,
  });
});

test('configured content selectors support tag, class, id, tag.class, and descendant last segments', () => {
  const cases = [
    ['section', '<section>SELECTED</section>'],
    ['.post-body', '<div class="layout post-body wide">SELECTED</div>'],
    ['#story', '<div id="story">SELECTED</div>'],
    ['div.prose', '<div class="prose">SELECTED</div>'],
    ['main .copy', '<main><div class="copy">SELECTED</div></main>'],
  ];

  for (const [selector, markup] of cases) {
    const selected = longText(`Selected by ${selector}`);
    const html = `<html><body><h1>Selector article</h1>${markup.replace('SELECTED', selected)}</body></html>`;
    const result = blogExtraction.extractBlogArticle(html, 'https://example.com/blog/selectors', {
      ...genericSource,
      contentSelectors: [selector],
    });
    assert.equal(result?.content, selected, selector);
  }
});

test('configured descendant selectors reject an earlier match outside the requested ancestor', () => {
  const outside = longText('Outside copy');
  const wrongAncestor = longText('Inside wrong ancestor');
  const inside = longText('Inside main copy');
  const html = `<html><body>
    <h1>Scoped selector article</h1>
    <div class="copy">${outside}</div>
    <div class="article-shell">
      <div><div class="copy">${wrongAncestor}</div></div>
      <section><div class="copy">${inside}</div></section>
    </div>
  </body></html>`;

  assert.equal(blogExtraction.extractBlogArticle(
    html,
    'https://example.com/blog/scoped-selector',
    { ...genericSource, contentSelectors: ['.article-shell section .copy'] },
  )?.content, inside);
});

test('configured content selectors outrank a related-post article in the IBM page shell', () => {
  const selected = longText('IBM main blog body');
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Article',
    headline: 'IBM article title',
    url: 'https://research.ibm.com/blog/future-of-computing',
  })}</script></head><body>
    <main data-testid="blog-post"><div class="FTOMS"><div class="nEgU0"><p>${selected}</p></div></div>
      <section><h2>Related posts</h2><article><h3>Related card</h3></article></section>
    </main>
  </body></html>`;

  assert.equal(blogExtraction.extractBlogArticle(
    html,
    'https://research.ibm.com/blog/future-of-computing',
    {
      ...genericSource,
      url: 'https://research.ibm.com/blog',
      contentSelectors: ['main .FTOMS'],
      contentSelectorPriority: true,
    },
  )?.content, selected);
});

test('semantic article content outranks configured selectors by default', () => {
  const semantic = longText('Semantic article content');
  const selected = longText('Configured selector content');
  const html = `<html><body><h1>Default precedence</h1>
    <article>${semantic}</article><main><div class="copy">${selected}</div></main>
  </body></html>`;

  assert.equal(blogExtraction.extractBlogArticle(
    html,
    'https://example.com/blog/default-precedence',
    { ...genericSource, contentSelectors: ['main .copy'] },
  )?.content, semantic);
});

test('Qwen parser extracts an official article API response', () => {
  const content = longText('Qwen API article body');
  const response = JSON.stringify({ data: {
    path: 'qwen3.8',
    title: 'Qwen3.8-Max: A New Bar for Coding and Cowork',
    content: `<p>${content}</p>`,
    extra: {
      date: '2026-08-03T10:00:00+08:00',
      author: 'Qwen Team',
      description: 'Official Qwen article.',
    },
  } });

  assert.deepEqual(blogExtraction.extractBlogArticle(
    response,
    'https://qwen.ai/blog?id=qwen3.8',
    {
      ...genericSource,
      url: 'https://qwen.ai/blog/',
      parser: 'qwen-blog',
    },
  ), {
    title: 'Qwen3.8-Max: A New Bar for Coding and Cowork',
    canonicalUrl: 'https://qwen.ai/blog?id=qwen3.8',
    publishedAt: '2026-08-03T10:00:00+08:00',
    author: 'Qwen Team',
    description: 'Official Qwen article.',
    content,
  });
});

test('Qwen parser ignores embedded metadata from other articles in a retrieval response', () => {
  const requestedContent = longText('Requested Qwen article');
  const response = JSON.stringify({ data: { articles: [
    {
      path: 'other-post',
      title: 'Other post',
      content: '<link rel="canonical" href="https://qwenlm.github.io/blog/other-post"><h1>Other</h1>',
      extra: {},
    },
    {
      path: 'qwen3.8',
      title: 'Requested Qwen post',
      content: `<p>${requestedContent}</p>`,
      extra: { date: '2026-08-03', author: 'Qwen Team' },
    },
  ] } });

  const result = blogExtraction.extractBlogArticle(
    response,
    'https://qwen.ai/blog?id=qwen3.8',
    { ...genericSource, url: 'https://qwen.ai/blog/', parser: 'qwen-blog' },
  );

  assert.equal(result?.title, 'Requested Qwen post');
  assert.equal(result?.canonicalUrl, 'https://qwen.ai/blog?id=qwen3.8');
  assert.equal(result?.content, requestedContent);
});

test('a configured site parser runs before semantic and configured selector fallbacks', () => {
  const preferred = longText('Portable text from the site parser');
  const semantic = longText('Semantic fallback');
  const html = `<html><body>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { post: {
        title: 'Site parser title',
        author: { name: 'Site Author' },
        publishedAt: '2026-08-31',
        body: [{ _type: 'block', children: [{ text: preferred }] }],
      } } },
    })}</script>
    <article>${semantic}</article>
  </body></html>`;

  assert.equal(blogExtraction.extractBlogArticle(html, 'https://example.com/blog/site', {
    ...genericSource,
    parser: 'anthropic-engineering',
    contentSelectors: ['article'],
  })?.content, preferred);
});

test('site-parser broad fallback removes boilerplate before generic validation', async () => {
  const html = await fixture('claude-blog/fallback-with-boilerplate.html');
  const result = blogExtraction.extractBlogArticle(
    html,
    'https://example.com/blog/fallback-cleaning',
    { ...genericSource, parser: 'claude-blog' },
  );

  assert.match(result.content, /Useful fallback content/);
  assert.doesNotMatch(result.content, /Header|Navigation|Related links|Footer/);
});

test('generic Anthropic site parsing removes boilerplate without changing the legacy export', async () => {
  const html = await fixture('anthropic-engineering/fallback-with-boilerplate.html');
  const result = blogExtraction.extractBlogArticle(
    html,
    'https://example.com/blog/anthropic-fallback-cleaning',
    { ...genericSource, parser: 'anthropic-engineering' },
  );

  assert.match(result.content, /Useful Anthropic fallback content & clear evidence/);
  assert.doesNotMatch(result.content, /Legacy header|Legacy navigation|Legacy aside/);
});

test('content extraction decodes entities and removes non-content elements', () => {
  const visible = `Research &amp; development &#8212; ${'meaningful text '.repeat(18)}`;
  const html = `<html><body><h1>Clean article</h1><article>
    <script>const secret = '${'script noise '.repeat(30)}';</script>
    <style>.hidden { content: '${'style noise '.repeat(30)}'; }</style>
    <nav>${'navigation noise '.repeat(30)}</nav>
    <aside>${'aside noise '.repeat(30)}</aside>
    <p>${visible}</p>
    <footer>${'footer noise '.repeat(30)}</footer>
  </article></body></html>`;

  const result = blogExtraction.extractBlogArticle(
    html,
    'https://example.com/blog/clean',
    genericSource,
  );
  assert.equal(result?.content, `Research & development \u2014 ${'meaningful text '.repeat(18)}`.trim());
  assert.doesNotMatch(result.content, /noise|secret|hidden/);
});

test('JSON-LD articleBody uses shared entity and boilerplate cleaning', () => {
  const visible = `Structured &amp; clean ${'meaningful paragraph '.repeat(16)}`.trim();
  const articleBody = `<nav>${'navigation noise '.repeat(30)}</nav><script>${'script noise '.repeat(30)}</script><p>${visible}</p>`;
  const result = blogExtraction.extractBlogArticle(jsonLdHtml({
    '@type': 'Article',
    headline: 'Clean structured body',
    articleBody,
  }), 'https://example.com/blog/clean-structured-body', genericSource);

  assert.equal(result.content, `Structured & clean ${'meaningful paragraph '.repeat(16)}`.trim());
  assert.doesNotMatch(result.content, /navigation|script/);
});

test('JSON-LD articleBody length threshold counts only cleaned content', () => {
  const articleBody = `<nav>${'navigation noise '.repeat(40)}</nav><script>${'script noise '.repeat(40)}</script><p>${'x '.repeat(199)}</p>`;

  assert.equal(blogExtraction.extractBlogArticle(jsonLdHtml({
    '@type': 'Article',
    headline: 'Short structured body',
    articleBody,
  }), 'https://example.com/blog/short-structured-body', genericSource), null);
});

test('rejects extracted content below 200 non-whitespace characters', () => {
  const shortContent = 'x '.repeat(199);
  const sufficientContent = 'x '.repeat(200);

  assert.equal(blogExtraction.extractBlogArticle(
    `<html><body><h1>Short</h1><article>${shortContent}</article></body></html>`,
    'https://example.com/blog/short',
    genericSource,
  ), null);
  assert.equal(blogExtraction.extractBlogArticle(
    `<html><body><h1>Long enough</h1><article>${sufficientContent}</article></body></html>`,
    'https://example.com/blog/long',
    genericSource,
  )?.content, sufficientContent.trim());
});
