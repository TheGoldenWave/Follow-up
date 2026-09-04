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

test('extraction failure tries at most three candidates and reports source errors', async () => {
  const attempted = [];
  const candidates = Array.from({ length: 5 }, (_, index) => ({
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
  assert.equal(report.sources[0].candidates, 5);
  assert.equal(report.sources[0].validArticles, 0);
  assert.equal(report.sources[0].errors.length, 3);
  assert.deepEqual(attempted, candidates.slice(0, 3).map(({ url }) => url));
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
  assert.doesNotMatch(sourceText, /generate-feed|fetchBlogContent|writeFile|appendFile|rename|unlink/);
});

test('package exposes the live blog source validator command', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts['validate-blog-sources'], 'node validate-blog-sources.js');
});
