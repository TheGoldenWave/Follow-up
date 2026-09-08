import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { fetchBlogArticle } from './blog-collector.js';
import {
  discoverBlogArticles,
  sanitizeBlogErrorMessage,
} from './blog-discovery.js';
import { validateBlogSources } from './blog-source-config.js';

const MAX_ARTICLE_ATTEMPTS = 12;
const MAX_VALID_ARTICLES = 3;
const CONFIG_URLS = {
  candidates: new URL('../config/blog-source-candidates.json', import.meta.url),
  production: new URL('../config/feed-blogs.json', import.meta.url),
};

function errorMessage(source, stage, error) {
  return `Blog: ${source.name}: validator-${stage}: ${sanitizeBlogErrorMessage(error)}`;
}

async function readSources(mode, readFileImpl) {
  const raw = await readFileImpl(CONFIG_URLS[mode], 'utf8');
  const config = JSON.parse(raw);
  if (!Array.isArray(config?.sources)) {
    throw new Error(`${mode} blog config must contain a sources array`);
  }
  return config.sources;
}

function selectSources(sources, sourceId) {
  if (!sourceId) return sources;
  const selected = sources.filter((source) => source.id === sourceId);
  if (selected.length === 0) throw new Error(`Unknown blog source ID: ${sourceId}`);
  return selected;
}

function assertValidSources(sources) {
  const result = validateBlogSources(sources);
  const errors = [...result.errors];
  if (Array.isArray(sources) && sources.length === 0) {
    errors.push('sources must not be empty');
  }
  if (errors.length > 0) {
    throw new Error(`Invalid blog source configuration: ${errors.join('; ')}`);
  }
}

async function validateSource(source, {
  discoverImpl,
  fetchArticleImpl,
  fetchImpl,
  timeoutMs,
}) {
  const errors = [];
  let candidates = [];

  try {
    const discovered = await discoverImpl(source, { fetchImpl, timeoutMs, errors });
    if (Array.isArray(discovered)) candidates = discovered;
    else errors.push(errorMessage(source, 'discovery', 'Discovery did not return an array'));
  } catch (error) {
    errors.push(errorMessage(source, 'discovery', error));
  }

  let validArticles = 0;
  for (const candidate of candidates.slice(0, MAX_ARTICLE_ATTEMPTS)) {
    try {
      const article = await fetchArticleImpl(candidate, source, {
        fetchImpl,
        timeoutMs,
        errors,
      });
      if (article) {
        validArticles += 1;
        if (validArticles === MAX_VALID_ARTICLES) break;
      }
    } catch (error) {
      errors.push(errorMessage(source, 'article', error));
    }
  }

  const discovery = candidates.length > 0;
  return {
    sourceId: source.id,
    discovery,
    candidates: candidates.length,
    validArticles,
    errors,
    passed: discovery && validArticles > 0,
  };
}

export async function validateBlogSourcesLive({
  production = false,
  mode = production ? 'production' : 'candidates',
  sourceId,
  sources,
  readFileImpl = readFile,
  discoverImpl = discoverBlogArticles,
  fetchArticleImpl = fetchBlogArticle,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  now = () => new Date(),
} = {}) {
  if (mode !== 'candidates' && mode !== 'production') {
    throw new Error(`Unknown validation mode: ${mode}`);
  }

  const configuredSources = sources ?? await readSources(mode, readFileImpl);
  assertValidSources(configuredSources);
  const selectedSources = selectSources(configuredSources, sourceId);
  const sourceReports = [];
  for (const source of selectedSources) {
    sourceReports.push(await validateSource(source, {
      discoverImpl,
      fetchArticleImpl,
      fetchImpl,
      timeoutMs,
    }));
  }

  return {
    generatedAt: new Date(now()).toISOString(),
    mode,
    passed: sourceReports.every((source) => source.passed),
    sources: sourceReports,
  };
}

function parseArgs(argv) {
  let production = false;
  let sourceId;

  for (const argument of argv) {
    if (argument === '--production') {
      production = true;
    } else if (argument.startsWith('--source=')) {
      sourceId = argument.slice('--source='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { production, sourceId };
}

export async function runCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  ...options
} = {}) {
  try {
    const { production, sourceId } = parseArgs(argv);
    const report = await validateBlogSourcesLive({
      ...options,
      production,
      mode: production ? 'production' : 'candidates',
      sourceId,
    });
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.passed ? 0 : 1;
  } catch (error) {
    stderr.write(`${sanitizeBlogErrorMessage(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
