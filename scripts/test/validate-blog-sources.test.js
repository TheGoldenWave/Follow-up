import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  runCli,
  validateBlogSourcesLive,
} from '../validate-blog-sources.js';

function source(id) {
  return {
    id,
    name: `Blog ${id}`,
    url: `https://${id}.example.com/blog`,
    language: 'en',
    discovery: [{ type: 'html', url: `https://${id}.example.com/blog` }],
    articleUrlPatterns: [`^https://${id}\\.example\\.com/blog/`],
    excludeUrlPatterns: [],
  };
}

function config(...ids) {
  return JSON.stringify({ sources: ids.map(source) });
}

function memoryStream() {
  let value = '';
  return {
    write(chunk) { value += chunk; },
    text() { return value; },
  };
}

function injectedRun(overrides = {}) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const paths = [];
  return {
    stdout,
    stderr,
    paths,
    options: {
      stdout,
      stderr,
      now: () => new Date('2026-09-04T00:00:00.000Z'),
      readFileImpl: async (url) => {
        paths.push(String(url));
        return config('one', 'two');
      },
      discoverImpl: async (blog) => [{
        title: `Latest ${blog.id}`,
        url: `${blog.url}/latest`,
        publishedAt: '2020-01-01T00:00:00.000Z',
      }],
      fetchArticleImpl: async (candidate, blog) => ({
        source: 'blog',
        name: blog.name,
        title: candidate.title,
        url: candidate.url,
        publishedAt: candidate.publishedAt,
        author: '',
        description: '',
        content: 'valid article content',
      }),
      ...overrides,
    },
  };
}

test('default CLI validates every candidate source and emits only JSON to stdout', async () => {
  const run = injectedRun();

  const exitCode = await runCli({ argv: [], ...run.options });
  const report = JSON.parse(run.stdout.text());

  assert.equal(exitCode, 0);
  assert.match(run.paths[0], /config\/blog-source-candidates\.json$/);
  assert.equal(run.stderr.text(), '');
  assert.equal(report.mode, 'candidates');
  assert.deepEqual(report.sources.map(({ sourceId }) => sourceId), ['one', 'two']);
});

test('--source filters the selected config in candidate and production modes', async () => {
  for (const argv of [['--source=two'], ['--production', '--source=two']]) {
    const run = injectedRun();

    const exitCode = await runCli({ argv, ...run.options });
    const report = JSON.parse(run.stdout.text());

    assert.equal(exitCode, 0);
    assert.deepEqual(report.sources.map(({ sourceId }) => sourceId), ['two']);
    assert.equal(report.mode, argv.includes('--production') ? 'production' : 'candidates');
    assert.match(
      run.paths[0],
      argv.includes('--production') ? /config\/feed-blogs\.json$/ : /config\/blog-source-candidates\.json$/,
    );
  }
});

test('unknown source ID writes a clear diagnostic to stderr and returns nonzero', async () => {
  const run = injectedRun();

  const exitCode = await runCli({ argv: ['--source=missing'], ...run.options });

  assert.equal(exitCode, 1);
  assert.equal(run.stdout.text(), '');
  assert.match(run.stderr.text(), /Unknown blog source ID: missing/);
});

for (const [label, sources, expectedError] of [
  ['insecure URL', [source('one'), source('two')].map((item, index) => (
    index === 1 ? { ...item, url: 'http://two.example.com/blog' } : item
  )), /two\.url: must be an absolute HTTPS URL/],
  ['unsupported discovery type', [{ ...source('one'), discovery: [{ type: 'atom', url: 'https://one.example.com/feed' }] }], /one\.discovery\[0\]\.type/],
  ['unsupported parser', [{ ...source('one'), parser: 'unknown-parser' }], /one\.parser: is not a supported parser/],
  ['invalid article regex', [{ ...source('one'), articleUrlPatterns: ['['] }], /one\.articleUrlPatterns\[0\]/],
  ['duplicate IDs', [source('one'), { ...source('one'), name: 'Duplicate' }], /one\.id: must be unique/],
]) {
  test(`CLI rejects ${label} before source selection or network access`, async () => {
    let networkCalls = 0;
    const run = injectedRun({
      readFileImpl: async () => JSON.stringify({ sources }),
      discoverImpl: async () => {
        networkCalls += 1;
        return [];
      },
      fetchArticleImpl: async () => {
        networkCalls += 1;
        return null;
      },
    });

    const exitCode = await runCli({ argv: ['--source=one'], ...run.options });

    assert.equal(exitCode, 1);
    assert.equal(run.stdout.text(), '');
    assert.match(run.stderr.text(), /Invalid blog source configuration:/);
    assert.match(run.stderr.text(), expectedError);
    assert.equal(networkCalls, 0);
  });
}

test('CLI rejects an empty configured source list instead of reporting vacuous success', async () => {
  let networkCalls = 0;
  const run = injectedRun({
    readFileImpl: async () => JSON.stringify({ sources: [] }),
    discoverImpl: async () => {
      networkCalls += 1;
      return [];
    },
  });

  const exitCode = await runCli({ argv: [], ...run.options });

  assert.equal(exitCode, 1);
  assert.equal(run.stdout.text(), '');
  assert.match(run.stderr.text(), /Invalid blog source configuration: sources must not be empty/);
  assert.equal(networkCalls, 0);
});

test('callable validator checks the complete injected source array before filtering', async () => {
  let discoveryCalls = 0;
  const invalidUnselectedSource = {
    ...source('two'),
    articleUrlPatterns: ['['],
  };

  await assert.rejects(
    validateBlogSourcesLive({
      sources: [source('one'), invalidUnselectedSource],
      sourceId: 'one',
      discoverImpl: async () => {
        discoveryCalls += 1;
        return [];
      },
    }),
    /Invalid blog source configuration: two\.articleUrlPatterns\[0\]/,
  );
  assert.equal(discoveryCalls, 0);
});

test('callable validator returns the stable report contract and ignores article age', async () => {
  const oldCandidate = {
    title: 'Low-frequency latest article',
    url: 'https://one.example.com/blog/latest',
    publishedAt: '2020-01-01T00:00:00.000Z',
  };
  const report = await validateBlogSourcesLive({
    sources: [source('one')],
    mode: 'candidates',
    now: () => new Date('2026-09-04T00:00:00.000Z'),
    discoverImpl: async () => [oldCandidate],
    fetchArticleImpl: async () => ({ title: oldCandidate.title, url: oldCandidate.url }),
  });

  assert.deepEqual(Object.keys(report), ['generatedAt', 'mode', 'passed', 'sources']);
  assert.equal(report.generatedAt, '2026-09-04T00:00:00.000Z');
  assert.equal(report.passed, true);
  assert.deepEqual(report.sources, [{
    sourceId: 'one',
    discovery: true,
    candidates: 1,
    validArticles: 1,
    errors: [],
    passed: true,
  }]);
});

test('discovery failure is isolated in the source report', async () => {
  const report = await validateBlogSourcesLive({
    sources: [source('one')],
    discoverImpl: async (_blog, { errors }) => {
      errors.push('Blog: Blog one: discovery-html: HTTP 503');
      return [];
    },
    fetchArticleImpl: async () => assert.fail('article fetch must not run without candidates'),
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.sources[0], {
    sourceId: 'one',
    discovery: false,
    candidates: 0,
    validArticles: 0,
    errors: ['Blog: Blog one: discovery-html: HTTP 503'],
    passed: false,
  });
});

test('extraction failure tries at most twelve candidates and reports source errors', async () => {
  const attempted = [];
  const candidates = Array.from({ length: 14 }, (_, index) => ({
    title: `Post ${index}`,
    url: `https://one.example.com/blog/post-${index}`,
  }));
  const report = await validateBlogSourcesLive({
    sources: [source('one')],
    discoverImpl: async () => candidates,
    fetchArticleImpl: async (candidate, _blog, { errors }) => {
      attempted.push(candidate.url);
      errors.push(`invalid: ${candidate.url}`);
      return null;
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.sources[0].discovery, true);
  assert.equal(report.sources[0].candidates, 14);
  assert.equal(report.sources[0].validArticles, 0);
  assert.equal(report.sources[0].errors.length, 12);
  assert.deepEqual(attempted, candidates.slice(0, 12).map(({ url }) => url));
});

test('validator continues past three invalid candidates and stops after three valid articles', async () => {
  const attempted = [];
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    title: `Post ${index}`,
    url: `https://one.example.com/blog/post-${index}`,
  }));
  const report = await validateBlogSourcesLive({
    sources: [source('one')],
    discoverImpl: async () => candidates,
    fetchArticleImpl: async (candidate) => {
      attempted.push(candidate.url);
      const index = Number(candidate.url.split('-').pop());
      return index >= 3 ? { title: candidate.title, url: candidate.url } : null;
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.sources[0].candidates, 10);
  assert.equal(report.sources[0].validArticles, 3);
  assert.deepEqual(attempted, candidates.slice(0, 6).map(({ url }) => url));
});

test('CLI exits nonzero when any selected source fails live validation', async () => {
  const run = injectedRun({
    discoverImpl: async (blog, { errors }) => {
      if (blog.id === 'two') {
        errors.push('discovery failed');
        return [];
      }
      return [{ title: 'Latest', url: `${blog.url}/latest` }];
    },
  });

  const exitCode = await runCli({ argv: [], ...run.options });
  const report = JSON.parse(run.stdout.text());

  assert.equal(exitCode, 1);
  assert.equal(report.passed, false);
  assert.equal(report.sources[1].passed, false);
  assert.equal(run.stderr.text(), '');
});

test('validator architecture imports discovery and article reads only', async () => {
  const sourceText = await readFile(new URL('../validate-blog-sources.js', import.meta.url), 'utf8');

  assert.match(sourceText, /from ['"]\.\/blog-discovery\.js['"]/);
  assert.match(sourceText, /from ['"]\.\/blog-collector\.js['"]/);
  assert.match(sourceText, /validateBlogSources/);
  assert.doesNotMatch(sourceText, /generate-feed|fetchBlogContent|writeFile|appendFile|rename|unlink/);
});

test('package exposes the live blog source validator command', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts['validate-blog-sources'], 'node validate-blog-sources.js');
});
