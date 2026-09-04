import {
  discoverBlogArticles,
  getBlogCandidateFetchUrl,
  fetchBlogResource,
  getBlogCandidateRawUrl,
  sanitizeBlogErrorMessage,
} from './blog-discovery.js';
import { extractBlogArticle } from './blog-extraction.js';
import {
  canonicalizeArticleUrl,
  matchesBlogFetchSource,
  matchesBlogSource,
} from './blog-source-config.js';

const BLOG_LOOKBACK_HOURS = 72;
const MAX_ARTICLES_PER_SOURCE = 3;
const MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_TIMEOUT_MS = 15000;
const ARTICLE_IDENTITIES = Symbol('articleIdentities');

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

function articleIdentities(source, ...values) {
  const identities = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    try {
      new URL(value);
      identities.add(value);
    } catch {
      // Relative discovery URLs are only unique after source-based normalization.
    }
    const normalized = canonicalizeArticleUrl(value, source.url);
    if (normalized) identities.add(normalized);
  }
  return [...identities];
}

function hasSeenIdentity(seenArticles, identities) {
  return identities.some((identity) => seenArticles?.[identity]);
}

export async function fetchBlogArticle(candidate, source, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors = options.errors ?? [];

  try {
    const fetchUrl = getBlogCandidateFetchUrl(candidate);
    if (fetchUrl !== candidate.url && !matchesBlogFetchSource(fetchUrl, source)) {
      throw new Error('Fetch URL is not allowed for this source');
    }
    const resource = await fetchBlogResource(fetchUrl, {
      fetchImpl,
      timeoutMs,
      accept: 'text/html,application/xhtml+xml;q=0.9',
    });
    if (fetchUrl !== candidate.url) {
      if (!matchesBlogFetchSource(resource.url, source)) {
        throw new Error('Final fetch URL is not allowed for this source');
      }
    } else if (!matchesBlogSource(resource.url, source)) {
      throw new Error('Final URL is not allowed for this source');
    }
    const extractionUrl = fetchUrl !== candidate.url
      ? candidate.url
      : resource.url || candidate.url;
    const extracted = extractBlogArticle(resource.body, extractionUrl, source);
    if (!extracted) {
      throw new Error('Invalid or underlength article content');
    }
    if (!matchesBlogSource(extracted.canonicalUrl, source)) {
      throw new Error('Canonical URL is not allowed for this source');
    }

    const item = {
      source: 'blog',
      name: source.name,
      title: extracted.title || candidate.title || 'Untitled',
      url: extracted.canonicalUrl,
      publishedAt: normalizePublishedAt(extracted.publishedAt || candidate.publishedAt),
      author: extracted.author || '',
      description: extracted.description || candidate.description || '',
      content: extracted.content,
    };
    Object.defineProperty(item, ARTICLE_IDENTITIES, {
      value: articleIdentities(
        source,
        getBlogCandidateRawUrl(candidate),
        candidate.url,
        fetchUrl === candidate.url ? resource.url : null,
        extracted.canonicalUrl,
      ),
    });
    return item;
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
      const items = [];
      const sourceIdentities = new Set();
      for (const [index, candidate] of candidates.slice(0, 12).entries()) {
        const identities = articleIdentities(
          source,
          getBlogCandidateRawUrl(candidate),
          candidate.url,
        );
        if (hasSeenIdentity(state.seenArticles, identities)) continue;
        const publishedMs = candidate.publishedAt ? Date.parse(candidate.publishedAt) : Number.NaN;
        if (Number.isFinite(publishedMs)) {
          if (publishedMs < cutoffMs) continue;
        } else if (index >= MAX_ARTICLES_PER_SOURCE) {
          continue;
        }
        const articleErrors = [];
        const item = await fetchBlogArticle(candidate, source, {
          fetchImpl: limitedFetch,
          timeoutMs,
          errors: articleErrors,
        });
        sourceErrors.push(...articleErrors);
        if (!item) continue;
        const authoritativePublishedMs = item.publishedAt
          ? Date.parse(item.publishedAt)
          : Number.NaN;
        if (Number.isFinite(authoritativePublishedMs) && authoritativePublishedMs < cutoffMs) {
          continue;
        }
        const itemIdentities = item[ARTICLE_IDENTITIES] ?? [item.url];
        if (hasSeenIdentity(state.seenArticles, itemIdentities)
          || itemIdentities.some((identity) => sourceIdentities.has(identity))) continue;
        for (const identity of itemIdentities) sourceIdentities.add(identity);
        items.push(item);
        if (items.length === MAX_ARTICLES_PER_SOURCE) break;
      }
      return { items, errors: sourceErrors };
    } catch (error) {
      sourceErrors.push(`Blog: ${source.name}: collector: ${sanitizeBlogErrorMessage(error)}`);
      return { items: [], errors: sourceErrors };
    }
  }));

  const results = [];
  const seenIdentities = new Set();
  for (const run of sourceRuns) {
    errors.push(...run.errors);
    for (const item of run.items) {
      if (!item) continue;
      const identities = item[ARTICLE_IDENTITIES] ?? [item.url];
      if (hasSeenIdentity(state.seenArticles, identities)
        || identities.some((identity) => seenIdentities.has(identity))) continue;
      for (const identity of identities) seenIdentities.add(identity);
      results.push(item);
      state.seenArticles ??= {};
      state.seenArticles[item.url] = nowMs;
    }
  }
  return results;
}
