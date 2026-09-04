import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchBlogArticle, fetchBlogContent } from '../blog-collector.js';

function source(overrides = {}) {
  return {
    id: 'example-blog',
    name: 'Example Blog',
    url: 'https://example.com/blog/',
    language: 'en',
    discovery: [{ type: 'rss', url: 'https://example.com/feed.xml' }],
    articleUrlPatterns: ['^https://example\\.com/blog/[^/?]+$'],
    excludeUrlPatterns: [],
    ...overrides,
  };
}

function response(body, { status = 200, url = '', location } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => name.toLowerCase() === 'location' ? location ?? null : null },
    text: async () => body,
  };
}

function articleHtml({
  title = 'A useful article',
  canonical = '/blog/canonical',
  publishedAt = '2026-09-03T08:30:00+08:00',
  content = 'Substantive article content '.repeat(12),
} = {}) {
  return `<!doctype html><html><head>
    <link rel="canonical" href="${canonical}">
    <meta property="article:published_time" content="${publishedAt}">
    <meta name="author" content="Example Author">
    <meta name="description" content="Example description">
  </head><body><h1>${title}</h1><article>${content}</article></body></html>`;
}

test('fetchBlogArticle supplies a 15 second timeout signal without mutating inputs', async () => {
  const candidate = Object.freeze({ title: 'Candidate', url: 'https://example.com/blog/candidate', publishedAt: null, description: '' });
  const blog = Object.freeze(source());
  const options = { fetchImpl: async (_url, request) => {
    assert.equal(request.redirect, 'manual');
    assert.ok(request.signal instanceof AbortSignal);
    assert.ok(request.signal.aborted === false);
    return response(articleHtml(), { url: 'https://example.com/blog/candidate' });
  } };
  const snapshot = { ...options };

  await fetchBlogArticle(candidate, blog, options);

  assert.deepEqual(options, snapshot);
});

test('fetchBlogArticle never requests cross-origin or private redirect targets', async () => {
  for (const location of ['https://attacker.example/trap', 'https://127.0.0.1/private']) {
    const requested = [];
    const errors = [];
    const result = await fetchBlogArticle(
      { url: 'https://example.com/blog/candidate' },
      source(),
      {
        errors,
        fetchImpl: async (url) => {
          requested.push(url);
          return response('', { status: 302, location });
        },
      },
    );

    assert.equal(result, null);
    assert.deepEqual(requested, ['https://example.com/blog/candidate']);
    assert.deepEqual(errors, ['Blog: Example Blog: article: Redirected to a disallowed URL']);
  }
});

test('fetchBlogArticle canonical precedence is page canonical, then final URL, then candidate URL', async () => {
  const pageCanonical = await fetchBlogArticle(
    { url: 'https://example.com/blog/candidate' },
    source(),
    { fetchImpl: async () => response(articleHtml({ canonical: '/blog/page-canonical' }), { url: 'https://example.com/blog/final' }) },
  );
  const finalCanonical = await fetchBlogArticle(
    { url: 'https://example.com/blog/candidate' },
    source(),
    { fetchImpl: async () => response(articleHtml({ canonical: '' }), { url: 'https://example.com/blog/final' }) },
  );
  const candidateCanonical = await fetchBlogArticle(
    { url: 'https://example.com/blog/candidate' },
    source(),
    { fetchImpl: async () => response(articleHtml({ canonical: '' })) },
  );

  assert.equal(pageCanonical.url, 'https://example.com/blog/page-canonical');
  assert.equal(finalCanonical.url, 'https://example.com/blog/final');
  assert.equal(candidateCanonical.url, 'https://example.com/blog/candidate');
});

test('fetchBlogArticle fetches a private detail URL but emits the public candidate URL', async () => {
  const candidate = {
    title: 'Public candidate',
    url: 'https://example.com/blog/public',
    publishedAt: null,
    description: '',
  };
  Object.defineProperty(candidate, Symbol.for('follow-up.blog.fetch-url'), {
    value: 'https://example.com/api/article?path=public',
  });
  const requested = [];
  const item = await fetchBlogArticle(candidate, source({
    fetchUrlPatterns: ['^https://example\\.com/api/article\\?path=[A-Za-z0-9._-]+$'],
  }), {
    fetchImpl: async (url) => {
      requested.push(url);
      return response(articleHtml({ canonical: '' }), { url });
    },
  });

  assert.deepEqual(requested, ['https://example.com/api/article?path=public']);
  assert.equal(item?.url, 'https://example.com/blog/public');
});

test('fetchBlogArticle validates detail responses against fetch URL patterns', async () => {
  const candidate = { url: 'https://example.com/blog/public' };
  Object.defineProperty(candidate, Symbol.for('follow-up.blog.fetch-url'), {
    value: 'https://example.com/api/article?path=public',
  });
  const errors = [];
  const item = await fetchBlogArticle(candidate, source({
    fetchUrlPatterns: ['^https://example\\.com/api/article\\?path=[A-Za-z0-9._-]+$'],
  }), {
    errors,
    fetchImpl: async () => response(articleHtml({ canonical: '' }), {
      url: 'https://example.com/api/private?path=public',
    }),
  });

  assert.equal(item, null);
  assert.deepEqual(errors, ['Blog: Example Blog: article: Final fetch URL is not allowed for this source']);
});

test('fetchBlogArticle rejects an unapproved initial fetch URL before network access', async () => {
  for (const fetchUrl of [
    'https://attacker.example/api/article?path=public',
    'https://127.0.0.1/api/article?path=public',
    'https://example.com/private?path=public',
  ]) {
    const candidate = { url: 'https://example.com/blog/public' };
    Object.defineProperty(candidate, Symbol.for('follow-up.blog.fetch-url'), { value: fetchUrl });
    const requested = [];
    const errors = [];

    const item = await fetchBlogArticle(candidate, source({
      fetchUrlPatterns: ['^https://example\\.com/api/article\\?path=[A-Za-z0-9._-]+$'],
    }), {
      errors,
      fetchImpl: async (url) => {
        requested.push(url);
        return response(articleHtml(), { url });
      },
    });

    assert.equal(item, null, fetchUrl);
    assert.deepEqual(requested, [], fetchUrl);
    assert.deepEqual(errors, ['Blog: Example Blog: article: Fetch URL is not allowed for this source']);
  }
});

test('fetchBlogArticle rejects canonical URLs outside the exact source origin or source rules', async () => {
  for (const canonical of ['https://www.example.com/blog/post', 'https://example.com/about']) {
    const errors = [];
    const result = await fetchBlogArticle(
      { url: 'https://example.com/blog/candidate' },
      source(),
      { errors, fetchImpl: async () => response(articleHtml({ canonical })) },
    );
    assert.equal(result, null);
    assert.deepEqual(errors, ['Blog: Example Blog: article: Canonical URL is not allowed for this source']);
  }
});

test('fetchBlogArticle rejects a same-origin final URL outside source rules before trusting its allowed page canonical', async () => {
  const errors = [];
  const result = await fetchBlogArticle(
    { url: 'https://example.com/blog/candidate' },
    source(),
    {
      errors,
      fetchImpl: async (url) => url.endsWith('/candidate')
        ? response('', { status: 302, location: '/not-an-article' })
        : response(articleHtml({ canonical: '/blog/allowed' }), { url }),
    },
  );

  assert.equal(result, null);
  assert.deepEqual(errors, ['Blog: Example Blog: article: Final URL is not allowed for this source']);
});

test('fetchBlogArticle rejects invalid and underlength extracted content', async () => {
  for (const html of [null, articleHtml({ content: 'too short' })]) {
    const errors = [];
    const result = await fetchBlogArticle(
      { url: 'https://example.com/blog/candidate' },
      source(),
      { errors, fetchImpl: async () => response(html) },
    );
    assert.equal(result, null);
    assert.deepEqual(errors, ['Blog: Example Blog: article: Invalid or underlength article content']);
  }
});

test('fetchBlogArticle returns exact Blog keys and ISO or null dates', async () => {
  const valid = await fetchBlogArticle(
    { title: 'Candidate title', url: 'https://example.com/blog/candidate', publishedAt: '2026-09-02', description: 'Candidate description' },
    source(),
    { fetchImpl: async () => response(articleHtml()) },
  );
  const invalidDate = await fetchBlogArticle(
    { url: 'https://example.com/blog/other', publishedAt: 'also invalid' },
    source(),
    { fetchImpl: async () => response(articleHtml({ canonical: '/blog/other', publishedAt: 'invalid' })) },
  );

  assert.deepEqual(Object.keys(valid), [
    'source', 'name', 'title', 'url', 'publishedAt', 'author', 'description', 'content',
  ]);
  assert.equal(valid.source, 'blog');
  assert.equal(valid.name, 'Example Blog');
  assert.equal(valid.publishedAt, '2026-09-03T00:30:00.000Z');
  assert.equal(invalidDate.publishedAt, null);
});

test('fetchBlogArticle records exact sanitized errors and isolates default errors', async () => {
  const errors = [];
  const failure = new Error('failed https://example.com/blog/post?token=secret token=hunter2\nnext');
  const fetchImpl = async () => { throw failure; };

  assert.equal(await fetchBlogArticle({ url: 'https://example.com/blog/a' }, source(), { errors, fetchImpl }), null);
  assert.deepEqual(errors, ['Blog: Example Blog: article: failed https://example.com/blog/post token=[redacted] next']);
  assert.equal(await fetchBlogArticle({ url: 'https://example.com/blog/b' }, source(), { fetchImpl }), null);
  assert.deepEqual(errors, ['Blog: Example Blog: article: failed https://example.com/blog/post token=[redacted] next']);
});

function rss(items) {
  return `<rss><channel>${items.map((item) => `<item><title>${item.title}</title><link>${item.url}</link>${item.date ? `<pubDate>${item.date}</pubDate>` : ''}</item>`).join('')}</channel></rss>`;
}

test('fetchBlogContent injects time and fetch, applies 72 hours, limits undated discovery position, and caps three per source', async () => {
  const blog = source();
  const candidates = [
    { title: 'Recent', url: '/blog/recent', date: '2026-09-03T00:00:00Z' },
    { title: 'Undated top', url: '/blog/undated-top' },
    { title: 'Old', url: '/blog/old', date: '2026-08-30T00:00:00Z' },
    { title: 'Undated deep', url: '/blog/undated-deep' },
    { title: 'Recent second', url: '/blog/recent-second', date: '2026-09-02T12:00:00Z' },
    { title: 'Recent third', url: '/blog/recent-third', date: '2026-09-02T10:00:00Z' },
  ];
  const fetched = [];
  const state = { seenArticles: {} };
  const results = await fetchBlogContent([blog], state, [], {
    now: () => Date.parse('2026-09-04T00:00:00Z'),
    fetchImpl: async (url) => {
      fetched.push(url);
      if (url.endsWith('feed.xml')) return response(rss(candidates));
      const slug = new URL(url).pathname.split('/').pop();
      return response(articleHtml({ canonical: `/blog/${slug}` }), { url });
    },
  });

  assert.deepEqual(results.map(({ url }) => url), [
    'https://example.com/blog/recent',
    'https://example.com/blog/undated-top',
    'https://example.com/blog/recent-second',
  ]);
  assert.ok(!fetched.some((url) => url.endsWith('/old') || url.endsWith('/undated-deep')));
  assert.deepEqual(Object.keys(state.seenArticles), results.map(({ url }) => url));
});

test('fetchBlogContent rejects an undated candidate when its authoritative article date is stale', async () => {
  const state = { seenArticles: {} };
  const results = await fetchBlogContent([source()], state, [], {
    discoverImpl: async () => [{
      title: 'Apparently recent',
      url: 'https://example.com/blog/stale',
      publishedAt: null,
    }],
    fetchImpl: async (url) => response(articleHtml({
      canonical: '/blog/stale',
      publishedAt: '2026-08-01T00:00:00Z',
    }), { url }),
    now: () => Date.parse('2026-09-04T00:00:00Z'),
  });

  assert.deepEqual(results, []);
  assert.deepEqual(state, { seenArticles: {} });
});

test('fetchBlogContent continues through candidates until it has three valid unique items', async () => {
  const requested = [];
  const candidates = ['invalid', 'alias-a', 'alias-b', 'second', 'third'].map((slug) => ({
    title: slug,
    url: `https://example.com/blog/${slug}`,
    publishedAt: '2026-09-03T00:00:00Z',
  }));
  const results = await fetchBlogContent([source()], { seenArticles: {} }, [], {
    discoverImpl: async () => candidates,
    fetchImpl: async (url) => {
      requested.push(url);
      const slug = new URL(url).pathname.split('/').pop();
      if (slug === 'invalid') {
        return response(articleHtml({ canonical: '/blog/invalid', content: 'short' }), { url });
      }
      const canonical = slug.startsWith('alias-') ? '/blog/first' : `/blog/${slug}`;
      return response(articleHtml({ canonical }), { url });
    },
    now: () => Date.parse('2026-09-04T00:00:00Z'),
  });

  assert.deepEqual(results.map(({ url }) => url), [
    'https://example.com/blog/first',
    'https://example.com/blog/second',
    'https://example.com/blog/third',
  ]);
  assert.deepEqual(requested, candidates.map(({ url }) => url));
});

test('fetchBlogContent shares a four-request limiter across discovery and article fetches', async () => {
  const sources = ['one', 'two', 'three', 'four', 'five'].map((id) => source({
    id,
    name: `Blog ${id}`,
    url: `https://${id}.example.com/blog/`,
    discovery: [{ type: 'rss', url: `https://${id}.example.com/feed.xml` }],
    articleUrlPatterns: [`^https://${id}\\.example\\.com/blog/`],
  }));
  let active = 0;
  let peak = 0;
  const fetchImpl = async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const parsed = new URL(url);
    if (parsed.pathname === '/feed.xml') {
      return response(rss(Array.from({ length: 3 }, (_, index) => ({
        title: `Post ${index}`,
        url: `/blog/post-${index}`,
        date: '2026-09-03T00:00:00Z',
      }))));
    }
    return response(articleHtml({ canonical: parsed.pathname }), { url });
  };

  const results = await fetchBlogContent(sources, { seenArticles: {} }, [], {
    now: () => Date.parse('2026-09-04T00:00:00Z'), fetchImpl,
  });

  assert.equal(results.length, 15);
  assert.equal(peak, 4);
});

test('fetchBlogContent recognizes raw and canonical legacy state, deduplicates canonicals, and updates state only after valid items', async () => {
  const blogs = [source(), source({ id: 'duplicate', name: 'Duplicate Blog' })];
  const state = { seenArticles: { 'https://example.com/blog/raw-seen': 1, 'https://example.com/blog/canonical-seen': 2 } };
  const feed = rss([
    { title: 'Raw seen', url: '/blog/raw-seen', date: '2026-09-03' },
    { title: 'Canonical seen alias', url: '/blog/alias', date: '2026-09-03' },
    { title: 'Shared alias', url: '/blog/shared-alias', date: '2026-09-03' },
    { title: 'Invalid', url: '/blog/invalid', date: '2026-09-03' },
  ]);
  const results = await fetchBlogContent(blogs, state, [], {
    now: () => Date.parse('2026-09-04T00:00:00Z'),
    fetchImpl: async (url) => {
      if (url.endsWith('feed.xml')) return response(feed);
      if (url.endsWith('/alias')) return response(articleHtml({ canonical: '/blog/canonical-seen' }), { url });
      if (url.endsWith('/invalid')) return response(articleHtml({ canonical: '/blog/invalid', content: 'short' }), { url });
      return response(articleHtml({ canonical: '/blog/shared' }), { url });
    },
  });

  assert.deepEqual(results.map(({ url }) => url), ['https://example.com/blog/shared']);
  assert.equal(state.seenArticles['https://example.com/blog/shared'], Date.parse('2026-09-04T00:00:00Z'));
  assert.equal(state.seenArticles['https://example.com/blog/invalid'], undefined);
});

test('fetchBlogContent checks both raw and normalized candidate URLs in state before fetching', async () => {
  const rawUrl = 'https://example.com/blog/raw?utm_source=feed';
  const normalizedUrl = 'https://example.com/blog/normalized';
  const state = { seenArticles: { [rawUrl]: 1, [normalizedUrl]: 2 } };
  const fetched = [];
  const results = await fetchBlogContent([source()], state, [], {
    discoverImpl: async () => [
      { title: 'Raw', url: rawUrl, publishedAt: '2026-09-03' },
      { title: 'Normalized', url: `${normalizedUrl}?utm_source=feed`, publishedAt: '2026-09-03' },
    ],
    fetchImpl: async (url) => {
      fetched.push(url);
      return response(articleHtml(), { url });
    },
    now: () => Date.parse('2026-09-04T00:00:00Z'),
  });

  assert.deepEqual(results, []);
  assert.deepEqual(fetched, []);
});

test('fetch-only URLs neither suppress public candidates nor become state identities', async () => {
  const publicUrl = 'https://example.com/blog/public';
  const fetchUrl = 'https://example.com/api/article?path=public';
  const candidate = {
    title: 'Public article',
    url: publicUrl,
    publishedAt: '2026-09-03',
    description: '',
  };
  Object.defineProperty(candidate, Symbol.for('follow-up.blog.fetch-url'), { value: fetchUrl });
  const state = { seenArticles: { [fetchUrl]: 1 } };
  const requested = [];

  const results = await fetchBlogContent([source({
    fetchUrlPatterns: ['^https://example\\.com/api/article\\?path=[A-Za-z0-9._-]+$'],
  })], state, [], {
    discoverImpl: async () => [candidate],
    fetchImpl: async (url) => {
      requested.push(url);
      return response(articleHtml({ canonical: '' }), { url });
    },
    now: () => Date.parse('2026-09-04T00:00:00Z'),
  });

  assert.deepEqual(requested, [fetchUrl]);
  assert.deepEqual(results.map(({ url }) => url), [publicUrl]);
  assert.equal(state.seenArticles[publicUrl], Date.parse('2026-09-04T00:00:00Z'));
  assert.deepEqual(state.seenArticles, {
    [fetchUrl]: 1,
    [publicUrl]: Date.parse('2026-09-04T00:00:00Z'),
  });
});

test('fetchBlogContent skips an exact raw tracking URL from real RSS discovery state', async () => {
  const rawUrl = 'https://example.com/blog/tracked?utm_source=legacy';
  const requested = [];
  const results = await fetchBlogContent(
    [source()],
    { seenArticles: { [rawUrl]: 1 } },
    [],
    {
      fetchImpl: async (url) => {
        requested.push(url);
        if (url.endsWith('feed.xml')) {
          return response(rss([{ title: 'Tracked', url: rawUrl, date: '2026-09-03' }]), { url });
        }
        return response(articleHtml(), { url });
      },
      now: () => Date.parse('2026-09-04T00:00:00Z'),
    },
  );

  assert.deepEqual(results, []);
  assert.deepEqual(requested, ['https://example.com/feed.xml']);
});

test('fetchBlogContent checks a legacy final redirect URL in state before emitting canonical content', async () => {
  const state = { seenArticles: { 'https://example.com/blog/final': 1 } };
  const results = await fetchBlogContent([source()], state, [], {
    discoverImpl: async () => [{
      title: 'Redirected',
      url: 'https://example.com/blog/candidate',
      publishedAt: '2026-09-03',
    }],
    fetchImpl: async () => response(
      articleHtml({ canonical: '/blog/canonical' }),
      { url: 'https://example.com/blog/final' },
    ),
    now: () => Date.parse('2026-09-04T00:00:00Z'),
  });

  assert.deepEqual(results, []);
  assert.deepEqual(state, { seenArticles: { 'https://example.com/blog/final': 1 } });
});

test('fetchBlogContent isolates source failures and appends exact source-ordered errors', async () => {
  const errors = ['Earlier error'];
  const good = source({ id: 'good', name: 'Good Blog' });
  const bad = source({ id: 'bad', name: 'Bad Blog', url: 'https://bad.example/blog/', discovery: [{ type: 'rss', url: 'https://bad.example/feed.xml' }], articleUrlPatterns: ['^https://bad\\.example/blog/'] });
  const results = await fetchBlogContent([bad, good], { seenArticles: {} }, errors, {
    now: () => Date.parse('2026-09-04T00:00:00Z'),
    fetchImpl: async (url) => {
      if (url === 'https://bad.example/feed.xml') return response('', { status: 503 });
      if (url.endsWith('feed.xml')) return response(rss([{ title: 'Good', url: '/blog/good', date: '2026-09-03' }]));
      return response(articleHtml({ canonical: '/blog/good' }), { url });
    },
  });

  assert.equal(results.length, 1);
  assert.deepEqual(errors, ['Earlier error', 'Blog: Bad Blog: discovery-rss: HTTP 503']);
});

test('fetchBlogContent keeps article errors in discovery order despite concurrent completion', async () => {
  const errors = [];
  const feed = rss([
    { title: 'First', url: '/blog/first', date: '2026-09-03' },
    { title: 'Second', url: '/blog/second', date: '2026-09-03' },
  ]);
  await fetchBlogContent([source()], { seenArticles: {} }, errors, {
    now: () => Date.parse('2026-09-04T00:00:00Z'),
    fetchImpl: async (url) => {
      if (url.endsWith('feed.xml')) return response(feed);
      if (url.endsWith('/first')) await new Promise((resolve) => setTimeout(resolve, 10));
      return response('', { status: url.endsWith('/first') ? 501 : 502 });
    },
  });

  assert.deepEqual(errors, [
    'Blog: Example Blog: article: HTTP 501',
    'Blog: Example Blog: article: HTTP 502',
  ]);
});

test('fetchBlogContent leaves state untouched when no valid item is produced', async () => {
  const state = {};
  await fetchBlogContent([source()], state, [], {
    fetchImpl: async (url) => url.endsWith('feed.xml')
      ? response(rss([{ title: 'Invalid', url: '/blog/invalid', date: '2026-09-03' }]))
      : response(articleHtml({ canonical: '/blog/invalid', content: 'short' }), { url }),
    now: () => Date.parse('2026-09-04T00:00:00Z'),
  });

  assert.deepEqual(state, {});
});
