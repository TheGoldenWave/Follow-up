import {
  discoverBlogArticles,
  fetchBlogResource,
  sanitizeBlogErrorMessage,
} from './blog-discovery.js';
import { extractBlogArticle } from './blog-extraction.js';
import { matchesBlogSource } from './blog-source-config.js';

const BLOG_LOOKBACK_HOURS = 72;
const MAX_ARTICLES_PER_SOURCE = 3;
const MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_TIMEOUT_MS = 15000;

function normalizePublishedAt(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function createLimiter(maxConcurrent) {
  let active = 0;
  const pending = [];

  const startNext = () => {
    if (active >= maxConcurrent || pending.length === 0) return;
    const { operation, resolve, reject } = pending.shift();
    active += 1;
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        startNext();
      });
  };

  return (operation) => new Promise((resolve, reject) => {
    pending.push({ operation, resolve, reject });
    startNext();
  });
}

function recordArticleError(errors, source, error) {
  errors.push(`Blog: ${source.name}: article: ${sanitizeBlogErrorMessage(error)}`);
}

export async function fetchBlogArticle(candidate, source, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors = options.errors ?? [];

  try {
    const resource = await fetchBlogResource(candidate.url, {
      fetchImpl,
      timeoutMs,
      accept: 'text/html,application/xhtml+xml;q=0.9',
    });
    const extracted = extractBlogArticle(resource.body, resource.url || candidate.url, source);
    if (!extracted) {
      throw new Error('Invalid or underlength article content');
    }
    if (!matchesBlogSource(extracted.canonicalUrl, source)) {
      throw new Error('Canonical URL is not allowed for this source');
    }

    return {
      source: 'blog',
      name: source.name,
      title: extracted.title || candidate.title || 'Untitled',
      url: extracted.canonicalUrl,
      publishedAt: normalizePublishedAt(extracted.publishedAt || candidate.publishedAt),
      author: extracted.author || '',
      description: extracted.description || candidate.description || '',
      content: extracted.content,
    };
  } catch (error) {
    recordArticleError(errors, source, error);
    return null;
  }
}

export async function fetchBlogContent(sources, state, errors, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const discover = options.discoverImpl ?? discoverBlogArticles;
  const nowMs = now();
  const cutoffMs = nowMs - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000;
  const limit = createLimiter(options.maxConcurrent ?? MAX_CONCURRENT_REQUESTS);
  const limitedFetch = (...args) => limit(() => fetchImpl(...args));

  const sourceRuns = await Promise.all((sources ?? []).map(async (source) => {
    const sourceErrors = [];
    try {
      const candidates = await discover(source, {
        fetchImpl: limitedFetch,
        now,
        timeoutMs,
        errors: sourceErrors,
        shadow: options.shadow ?? false,
      });
      const selected = [];
      for (const [index, candidate] of candidates.entries()) {
        if (state.seenArticles?.[candidate.url]) continue;
        const publishedMs = candidate.publishedAt ? Date.parse(candidate.publishedAt) : Number.NaN;
        if (Number.isFinite(publishedMs)) {
          if (publishedMs < cutoffMs) continue;
        } else if (index >= MAX_ARTICLES_PER_SOURCE) {
          continue;
        }
        selected.push(candidate);
        if (selected.length === MAX_ARTICLES_PER_SOURCE) break;
      }

      const fetched = await Promise.all(selected.map(async (candidate) => {
        const articleErrors = [];
        const item = await fetchBlogArticle(candidate, source, {
          fetchImpl: limitedFetch,
          timeoutMs,
          errors: articleErrors,
        });
        return { item, errors: articleErrors };
      }));
      const items = [];
      for (const result of fetched) {
        sourceErrors.push(...result.errors);
        items.push(result.item);
      }
      return { items, errors: sourceErrors };
    } catch (error) {
      sourceErrors.push(`Blog: ${source.name}: collector: ${sanitizeBlogErrorMessage(error)}`);
      return { items: [], errors: sourceErrors };
    }
  }));

  const results = [];
  const seenCanonicals = new Set();
  for (const run of sourceRuns) {
    errors.push(...run.errors);
    for (const item of run.items) {
      if (!item || state.seenArticles?.[item.url] || seenCanonicals.has(item.url)) continue;
      seenCanonicals.add(item.url);
      results.push(item);
      state.seenArticles ??= {};
      state.seenArticles[item.url] = nowMs;
    }
  }
  return results;
}
