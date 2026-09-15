import { readFile } from 'node:fs/promises';

const REGISTRY_URL = new URL('../config/sources.json', import.meta.url);
const SCOPES = new Set(['central-live', 'local-enabled', 'all']);
const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;
const CHANNEL_NAMESPACES = Object.freeze({
  x: 'x', podcasts: 'podcast', blogs: 'blog', newsletters: 'newsletter',
  academic: 'academic', 'zh-tech': 'zh-tech', reports: 'report',
});

function requireScope(scope) {
  if (!SCOPES.has(scope)) {
    throw new TypeError('source registry scope is required: central-live, local-enabled, or all');
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function projectCompatibility(source) {
  const input = source.input;
  const projected = {
    ...source,
    ...input,
    ...(input.rss_url ? { rss: input.rss_url, rssUrl: input.rss_url } : {}),
    ...(input.article_url_patterns ? { articleUrlPatterns: input.article_url_patterns } : {}),
    ...(input.exclude_url_patterns ? { excludeUrlPatterns: input.exclude_url_patterns } : {}),
    ...(input.fetch_url_patterns ? { fetchUrlPatterns: input.fetch_url_patterns } : {}),
    ...(input.content_selectors ? { contentSelectors: input.content_selectors } : {}),
    ...(input.content_selector_priority !== undefined
      ? { contentSelectorPriority: input.content_selector_priority } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    maxArticles: source.budget,
  };
  if (projected.parser === null) delete projected.parser;
  return deepFreeze(projected);
}

function validateDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('source registry document must be an object');
  }
  if (document.schema_version !== '1.0') {
    throw new TypeError("source registry schema_version must be '1.0'");
  }
  if (!Array.isArray(document.sources)) throw new TypeError('source registry sources must be an array');
  const seen = new Set();
  for (const source of document.sources) {
    if (!source || typeof source !== 'object' || typeof source.id !== 'string') {
      throw new TypeError('each source requires an explicit namespaced source id');
    }
    if (source.id.length > 128) throw new TypeError('source id length must not exceed 128 characters');
    if (!ID_PATTERN.test(source.id)) {
      throw new TypeError('each source requires an explicit namespaced source id');
    }
    if (seen.has(source.id)) throw new TypeError(`Duplicate source id: ${source.id}`);
    seen.add(source.id);
    if (!source.input || typeof source.input !== 'object' || Array.isArray(source.input)) {
      throw new TypeError(`${source.id} input must be an object`);
    }
    if (!source.legacy || !Object.hasOwn(source.legacy, 'feed')) {
      throw new TypeError(`${source.id} legacy.feed is required`);
    }
    if (source.channel_policy === 'core-topic') {
      if (!source.id.startsWith('community:') || source.channel !== null) {
        throw new TypeError(`${source.id} core-topic sources require community namespace and null channel`);
      }
    } else if (source.channel_policy === 'fixed') {
      const namespace = CHANNEL_NAMESPACES[source.channel];
      if (!namespace || !source.id.startsWith(`${namespace}:`)) {
        throw new TypeError(`${source.id} namespace must match its fixed channel`);
      }
    } else {
      throw new TypeError(`${source.id} has an invalid channel policy`);
    }
  }
}

export function createSourceRegistry(document, options) {
  const scope = options?.scope;
  requireScope(scope);
  validateDocument(document);
  const cloned = cloneJson(document.sources);
  const selected = cloned.filter((source) => {
    if (scope === 'central-live') return source.legacy.feed !== null;
    if (scope === 'local-enabled') return source.default_enabled === true;
    return true;
  });
  return deepFreeze(selected.map(projectCompatibility));
}

export async function loadSourceRegistry(options) {
  const scope = options?.scope;
  requireScope(scope);
  const readFileImpl = options?.readFileImpl ?? readFile;
  const document = JSON.parse(await readFileImpl(REGISTRY_URL, 'utf8'));
  return createSourceRegistry(document, { scope });
}
