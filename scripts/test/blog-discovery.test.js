import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverBlogArticles,
  parseBlogFeed,
  parseBlogIndex,
  parseSitemap,
} from '../blog-discovery.js';

function source(overrides = {}) {
  return {
    id: 'example-blog',
    name: 'Example Blog',
    url: 'https://example.com/blog/',
    discovery: [],
    articleUrlPatterns: ['^https://example\\.com/blog/[^/?]+$'],
    excludeUrlPatterns: ['^https://example\\.com/blog/excluded$'],
    ...overrides,
  };
}

test('parseBlogFeed parses RSS items, CDATA, entities, relative URLs, and descriptions', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item>
        <title><![CDATA[Research & Development]]></title>
        <link>/blog/launch?utm_source=rss#top</link>
        <pubDate>Thu, 03 Sep 2026 08:00:00 GMT</pubDate>
        <description><![CDATA[New <strong>research</strong> &amp; results.]]></description>
      </item>
      <item>
        <title>Second &amp; Better</title>
        <guid isPermaLink="true">https://example.com/blog/second</guid>
        <dc:date>2026-09-02T12:00:00Z</dc:date>
        <content:encoded>Longer details &lt;inside&gt;.</content:encoded>
      </item>
    </channel></rss>`;

  assert.deepEqual(parseBlogFeed(xml, source(), 'https://example.com/feed.xml'), [
    {
      title: 'Research & Development',
      url: 'https://example.com/blog/launch',
      publishedAt: 'Thu, 03 Sep 2026 08:00:00 GMT',
      description: 'New research & results.',
    },
    {
      title: 'Second & Better',
      url: 'https://example.com/blog/second',
      publishedAt: '2026-09-02T12:00:00Z',
      description: 'Longer details <inside>.',
    },
  ]);
});

test('parseBlogFeed parses Atom entries and prefers alternate links', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title type="html">An &amp; B</title>
      <link rel="self" href="/feeds/entry.xml" />
      <link rel="alternate" type="text/html" href="/blog/atom-post" />
      <updated>2026-09-03T09:30:00Z</updated>
      <summary type="html"><![CDATA[Atom <b>summary</b>.]]></summary>
    </entry>
  </feed>`;

  assert.deepEqual(parseBlogFeed(xml, source(), 'https://example.com/feed.atom'), [{
    title: 'An & B',
    url: 'https://example.com/blog/atom-post',
    publishedAt: '2026-09-03T09:30:00Z',
    description: 'Atom summary.',
  }]);
});

test('parseBlogFeed filters non-article URLs and excluded URLs', () => {
  const xml = `<rss><channel>
    <item><title>Valid</title><link>/blog/valid</link></item>
    <item><title>Index</title><link>/blog/</link></item>
    <item><title>Excluded</title><link>/blog/excluded</link></item>
    <item><title>External</title><link>https://attacker.example/blog/post</link></item>
  </channel></rss>`;

  assert.deepEqual(parseBlogFeed(xml, source(), 'https://example.com/feed.xml'), [{
    title: 'Valid',
    url: 'https://example.com/blog/valid',
    publishedAt: null,
    description: '',
  }]);
});

test('parseBlogFeed returns null for malformed dates', () => {
  const xml = `<rss><channel><item>
    <title>Bad date</title><link>/blog/bad-date</link><pubDate>not a date</pubDate>
  </item></channel></rss>`;

  assert.equal(parseBlogFeed(xml, source(), 'https://example.com/feed.xml')[0].publishedAt, null);
});

test('parseBlogFeed rejects malformed XML without throwing', () => {
  const malformed = '<rss><channel><item><title>Broken</title><link>/blog/broken</channel></rss>';

  assert.deepEqual(parseBlogFeed(malformed, source(), 'https://example.com/feed.xml'), []);
  assert.deepEqual(parseBlogFeed('', source(), 'https://example.com/feed.xml'), []);
});

test('parseBlogFeed removes duplicate canonical URLs and caps candidates at 12', () => {
  const items = [
    '<item><title>First</title><link>/blog/post-0?utm_source=feed</link></item>',
    '<item><title>Duplicate</title><link>/blog/post-0#duplicate</link></item>',
    ...Array.from({ length: 15 }, (_, index) => (
      `<item><title>Post ${index + 1}</title><link>/blog/post-${index + 1}</link></item>`
    )),
  ];

  const candidates = parseBlogFeed(
    `<rss><channel>${items.join('')}</channel></rss>`,
    source(),
    'https://example.com/feed.xml',
  );

  assert.equal(candidates.length, 12);
  assert.equal(candidates[0].title, 'First');
  assert.equal(candidates[11].url, 'https://example.com/blog/post-11');
});

test('parseSitemap parses namespace-prefixed urlsets, relative URLs, and lastmod newest first', () => {
  const xml = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sm:url><sm:loc>/blog/older?utm_source=map</sm:loc><sm:lastmod>2026-09-01</sm:lastmod></sm:url>
    <sm:url><sm:loc>https://example.com/blog/newest</sm:loc><sm:lastmod>2026-09-03T12:00:00Z</sm:lastmod></sm:url>
    <sm:url><sm:loc>/about</sm:loc><sm:lastmod>2026-09-04</sm:lastmod></sm:url>
    <sm:url><sm:loc>/blog/undated</sm:loc><sm:lastmod>invalid</sm:lastmod></sm:url>
  </sm:urlset>`;

  assert.deepEqual(parseSitemap(xml, source(), 'https://example.com/sitemap.xml'), {
    candidates: [
      {
        title: '',
        url: 'https://example.com/blog/newest',
        publishedAt: '2026-09-03T12:00:00Z',
        description: '',
      },
      {
        title: '',
        url: 'https://example.com/blog/older',
        publishedAt: '2026-09-01',
        description: '',
      },
      {
        title: '',
        url: 'https://example.com/blog/undated',
        publishedAt: null,
        description: '',
      },
    ],
    sitemapUrls: [],
  });
});

test('parseSitemap returns canonical child URLs for a sitemap index', () => {
  const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>/posts-1.xml</loc></sitemap>
    <sitemap><loc>https://example.com/posts-2.xml#fragment</loc></sitemap>
    <sitemap><loc>/posts-1.xml</loc></sitemap>
    <sitemap><loc>javascript:alert(1)</loc></sitemap>
  </sitemapindex>`;

  assert.deepEqual(parseSitemap(xml, source(), 'https://example.com/sitemap.xml'), {
    candidates: [],
    sitemapUrls: [
      'https://example.com/posts-1.xml',
      'https://example.com/posts-2.xml',
    ],
  });
});

test('parseSitemap rejects malformed XML and caps deduplicated candidates at 12', () => {
  assert.deepEqual(
    parseSitemap('<urlset><url><loc>/blog/broken</url></urlset>', source(), 'https://example.com/map.xml'),
    { candidates: [], sitemapUrls: [] },
  );

  const urls = [
    '<url><loc>/blog/post-0?ref=map</loc></url>',
    '<url><loc>/blog/post-0#copy</loc></url>',
    ...Array.from({ length: 15 }, (_, index) => `<url><loc>/blog/post-${index + 1}</loc></url>`),
  ];
  const result = parseSitemap(
    `<urlset>${urls.join('')}</urlset>`,
    source(),
    'https://example.com/map.xml',
  );

  assert.equal(result.candidates.length, 12);
  assert.equal(result.candidates[0].url, 'https://example.com/blog/post-0');
});

test('parseBlogIndex parses quoted and unquoted anchors with nearby title and time metadata', () => {
  const html = `<main>
    <article><h2><a href="/blog/first?utm_campaign=index">First &amp; Foremost</a></h2>
      <time datetime="2026-09-03">September 3</time><p>A useful summary.</p></article>
    <article><a href=/blog/second title='Second article'>Read more</a>
      <time>2026-09-02T08:00:00Z</time></article>
  </main>`;

  assert.deepEqual(parseBlogIndex(html, source(), 'https://example.com/blog/'), [
    {
      title: 'First & Foremost',
      url: 'https://example.com/blog/first',
      publishedAt: '2026-09-03',
      description: 'A useful summary.',
    },
    {
      title: 'Second article',
      url: 'https://example.com/blog/second',
      publishedAt: '2026-09-02T08:00:00Z',
      description: '',
    },
  ]);
});

test('parseBlogIndex deduplicates, filters URLs, and caps candidates at 12', () => {
  const anchors = [
    '<a href="/blog/post-0?source=index">First</a>',
    '<a href="/blog/post-0#duplicate">Duplicate</a>',
    '<a href="/blog/excluded">Excluded</a>',
    '<a href="https://other.example/blog/external">External</a>',
    ...Array.from({ length: 15 }, (_, index) => `<a href="/blog/post-${index + 1}">Post ${index + 1}</a>`),
  ];

  const candidates = parseBlogIndex(anchors.join('\n'), source(), 'https://example.com/blog/');

  assert.equal(candidates.length, 12);
  assert.equal(candidates[0].title, 'First');
  assert.equal(candidates[11].url, 'https://example.com/blog/post-11');
});

test('parseBlogIndex keeps Anthropic Interpretability and Science membership page-local', () => {
  const anthropic = source({
    url: 'https://www.anthropic.com/',
    articleUrlPatterns: ['^https://www\\.anthropic\\.com/research/[^/?]+$'],
    excludeUrlPatterns: [],
  });
  const interpretabilityHtml = '<a href="/research/natural-language-autoencoders">Autoencoders</a>';
  const scienceHtml = '<a href="/research/riemann-zeta">Riemann zeta</a>';

  assert.deepEqual(
    parseBlogIndex(interpretabilityHtml, anthropic, 'https://www.anthropic.com/research/team/interpretability')
      .map(({ url }) => url),
    ['https://www.anthropic.com/research/natural-language-autoencoders'],
  );
  assert.deepEqual(
    parseBlogIndex(scienceHtml, anthropic, 'https://www.anthropic.com/science').map(({ url }) => url),
    ['https://www.anthropic.com/research/riemann-zeta'],
  );
});

test('parseBlogIndex handles malformed or non-string HTML without throwing', () => {
  assert.deepEqual(parseBlogIndex(null, source(), 'https://example.com/blog/'), []);
  assert.deepEqual(parseBlogIndex('<a href="/blog/incomplete"', source(), 'https://example.com/blog/'), []);
});

function response(body, overrides = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    ...overrides,
  };
}

test('discoverBlogArticles passes a timeout AbortSignal and applies option defaults', async () => {
  let receivedSignal;
  const options = {
    fetchImpl: async (_url, init) => {
      receivedSignal = init.signal;
      return response('<rss><channel></channel></rss>');
    },
  };

  await discoverBlogArticles(source({
    discovery: [{ type: 'rss', url: 'https://example.com/feed.xml' }],
  }), options);

  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, false);
  assert.equal(options.errors.length, 0);
  assert.equal(options.shadow, false);
  assert.equal(options.timeoutMs, 15000);
  assert.equal(options.now, Date.now);
});

test('discoverBlogArticles honors a custom timeout', async () => {
  let receivedSignal;
  const errors = [];
  const startedAt = Date.now();
  const candidates = await discoverBlogArticles(source({
    discovery: [{ type: 'rss', url: 'https://example.com/feed.xml' }],
  }), {
    timeoutMs: 10,
    errors,
    fetchImpl: async (_url, init) => {
      receivedSignal = init.signal;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });

  assert.deepEqual(candidates, []);
  assert.equal(receivedSignal.aborted, true);
  assert.ok(Date.now() - startedAt >= 5);
  assert.equal(errors.length, 1);
});

test('discoverBlogArticles records exact sanitized errors and isolates default error arrays', async () => {
  const firstOptions = {
    fetchImpl: async () => { throw new Error('socket closed\nunexpectedly'); },
  };
  const secondOptions = {
    fetchImpl: async () => response('', { ok: false, status: 503 }),
  };
  const configuredSource = source({
    discovery: [{ type: 'rss', url: 'https://example.com/feed.xml' }],
  });

  await discoverBlogArticles(configuredSource, firstOptions);
  await discoverBlogArticles(configuredSource, secondOptions);

  assert.notEqual(firstOptions.errors, secondOptions.errors);
  assert.deepEqual(firstOptions.errors, [
    'Blog: Example Blog: discovery-rss: socket closed unexpectedly',
  ]);
  assert.deepEqual(secondOptions.errors, [
    'Blog: Example Blog: discovery-rss: HTTP 503',
  ]);
});

test('discoverBlogArticles falls back after a failed request', async () => {
  const requested = [];
  const errors = [];
  const candidates = await discoverBlogArticles(source({
    discovery: [
      { type: 'rss', url: 'https://example.com/feed.xml' },
      { type: 'html', url: 'https://example.com/blog/' },
    ],
  }), {
    errors,
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.endsWith('feed.xml')) return response('', { ok: false, status: 502 });
      return response('<a href="/blog/fallback">Fallback</a>');
    },
  });

  assert.deepEqual(requested, ['https://example.com/feed.xml', 'https://example.com/blog/']);
  assert.equal(candidates[0].url, 'https://example.com/blog/fallback');
  assert.deepEqual(errors, ['Blog: Example Blog: discovery-rss: HTTP 502']);
});

test('discoverBlogArticles falls back after zero valid candidates', async () => {
  const requested = [];
  const errors = [];
  const candidates = await discoverBlogArticles(source({
    discovery: [
      { type: 'rss', url: 'https://example.com/feed.xml' },
      { type: 'html', url: 'https://example.com/blog/' },
    ],
  }), {
    errors,
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.endsWith('feed.xml')) {
        return response('<rss><channel><item><title>About</title><link>/about</link></item></channel></rss>');
      }
      return response('<a href="/blog/from-html">From HTML</a>');
    },
  });

  assert.equal(candidates[0].url, 'https://example.com/blog/from-html');
  assert.equal(requested.length, 2);
  assert.deepEqual(errors, []);
});

test('discoverBlogArticles stops after the first strategy with valid candidates', async () => {
  const requested = [];
  const candidates = await discoverBlogArticles(source({
    discovery: [
      { type: 'rss', url: 'https://example.com/feed.xml' },
      { type: 'html', url: 'https://example.com/blog/' },
    ],
  }), {
    fetchImpl: async (url) => {
      requested.push(url);
      return response('<rss><channel><item><title>Feed post</title><link>/blog/feed-post</link></item></channel></rss>');
    },
  });

  assert.equal(candidates[0].url, 'https://example.com/blog/feed-post');
  assert.deepEqual(requested, ['https://example.com/feed.xml']);
});

test('discoverBlogArticles distinguishes successful empty discovery from all strategies failing', async () => {
  const configuredSource = source({
    discovery: [{ type: 'html', url: 'https://example.com/blog/' }],
  });
  const emptyErrors = [];
  const failureErrors = [];

  const empty = await discoverBlogArticles(configuredSource, {
    errors: emptyErrors,
    fetchImpl: async () => response('<nav><a href="/about">About</a></nav>'),
  });
  const failed = await discoverBlogArticles(configuredSource, {
    errors: failureErrors,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  assert.deepEqual(empty, []);
  assert.deepEqual(emptyErrors, []);
  assert.deepEqual(failed, []);
  assert.deepEqual(failureErrors, ['Blog: Example Blog: discovery-html: offline']);
});

test('discoverBlogArticles fetches sitemap index children one level only', async () => {
  const requested = [];
  const errors = [];
  const bodies = new Map([
    ['https://example.com/sitemap.xml', `<sitemapindex>
      <sitemap><loc>/child-a.xml</loc></sitemap><sitemap><loc>/child-b.xml</loc></sitemap>
    </sitemapindex>`],
    ['https://example.com/child-a.xml', `<urlset>
      <url><loc>/blog/older</loc><lastmod>2026-09-01</lastmod></url>
      <url><loc>/blog/newest</loc><lastmod>2026-09-03</lastmod></url>
    </urlset>`],
    ['https://example.com/child-b.xml', '<sitemapindex><sitemap><loc>/grandchild.xml</loc></sitemap></sitemapindex>'],
    ['https://example.com/grandchild.xml', '<urlset><url><loc>/blog/grandchild</loc></url></urlset>'],
  ]);

  const candidates = await discoverBlogArticles(source({
    discovery: [{ type: 'sitemap', url: 'https://example.com/sitemap.xml' }],
  }), {
    errors,
    fetchImpl: async (url) => {
      requested.push(url);
      return response(bodies.get(url));
    },
  });

  assert.deepEqual(requested, [
    'https://example.com/sitemap.xml',
    'https://example.com/child-a.xml',
    'https://example.com/child-b.xml',
  ]);
  assert.deepEqual(candidates.map(({ url }) => url), [
    'https://example.com/blog/newest',
    'https://example.com/blog/older',
  ]);
  assert.deepEqual(errors, []);
});
