import {
  canonicalizeArticleUrl,
  matchesBlogSource,
} from './blog-source-config.js';

const MAX_CANDIDATES = 12;
const DEFAULT_TIMEOUT_MS = 15000;
const BLOG_USER_AGENT = 'Mozilla/5.0 (compatible; FollowBuilders/1.0; +https://github.com/)';

function decodeXml(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(value) {
  const withoutCdata = String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeXml(withoutCdata.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function isWellFormedXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return false;

  const sanitized = xml
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const stack = [];
  const tags = sanitized.match(/<[^>]+>/g) ?? [];
  if (tags.length === 0) return false;

  for (const tag of tags) {
    if (/^<\s*!/.test(tag) || /^<\s*\?/.test(tag)) continue;
    const closing = tag.match(/^<\s*\/\s*([\w.-]+(?::[\w.-]+)?)\s*>$/);
    if (closing) {
      if (stack.pop() !== closing[1]) return false;
      continue;
    }
    if (/\/\s*>$/.test(tag)) continue;
    const opening = tag.match(/^<\s*([\w.-]+(?::[\w.-]+)?)(?:\s[^>]*)?>$/);
    if (!opening) return false;
    stack.push(opening[1]);
  }

  return stack.length === 0;
}

function elementValue(block, localNames) {
  for (const name of localNames) {
    const expression = new RegExp(
      `<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`,
      'i',
    );
    const match = block.match(expression);
    if (match) return cleanText(match[1]);
  }
  return '';
}

function attributeValue(tag, name) {
  const quoted = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  if (quoted) return decodeXml(quoted[2]).trim();
  const unquoted = tag.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i'));
  return unquoted ? decodeXml(unquoted[1]).trim() : '';
}

function normalizeDate(value) {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function addCandidate(candidates, seen, source, rawUrl, baseUrl, metadata) {
  const url = canonicalizeArticleUrl(decodeXml(rawUrl), baseUrl);
  if (!url || !matchesBlogSource(url, source) || seen.has(url) || !metadata.title) return;

  seen.add(url);
  candidates.push({
    title: metadata.title,
    url,
    publishedAt: normalizeDate(metadata.publishedAt),
    description: metadata.description,
  });
}

export function parseBlogFeed(xml, source, baseUrl) {
  if (!isWellFormedXml(xml)) return [];

  const blocks = [...xml.matchAll(/<(?:[\w.-]+:)?(item|entry)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>/gi)];
  const candidates = [];
  const seen = new Set();

  for (const [, kind, block] of blocks) {
    let rawUrl = '';
    if (kind.toLowerCase() === 'entry') {
      const linkTags = block.match(/<(?:[\w.-]+:)?link\b[^>]*\/?>/gi) ?? [];
      const alternate = linkTags.find((tag) => attributeValue(tag, 'rel').toLowerCase() === 'alternate');
      rawUrl = attributeValue(alternate ?? linkTags[0] ?? '', 'href');
    } else {
      rawUrl = elementValue(block, ['link']);
      if (!rawUrl) rawUrl = elementValue(block, ['guid']);
    }

    addCandidate(candidates, seen, source, rawUrl, baseUrl, {
      title: elementValue(block, ['title']),
      publishedAt: elementValue(block, ['pubDate', 'published', 'updated', 'date']),
      description: elementValue(block, ['description', 'summary', 'encoded']),
    });
    if (candidates.length === MAX_CANDIDATES) break;
  }

  return candidates;
}

/**
 * Parses either a sitemap urlset or sitemapindex without fetching child maps.
 * Child sitemap URLs are returned separately for one-level orchestration.
 */
export function parseSitemap(xml, source, baseUrl) {
  const empty = { candidates: [], sitemapUrls: [] };
  if (!isWellFormedXml(xml)) return empty;

  const isIndex = /<(?:[\w.-]+:)?sitemapindex\b/i.test(xml);
  const blockName = isIndex ? 'sitemap' : 'url';
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${blockName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${blockName}\\s*>`,
    'gi',
  );
  const blocks = [...xml.matchAll(expression)].map((match) => match[1]);

  if (isIndex) {
    const seen = new Set();
    const sitemapUrls = [];
    for (const block of blocks) {
      const url = canonicalizeArticleUrl(elementValue(block, ['loc']), baseUrl);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sitemapUrls.push(url);
      if (sitemapUrls.length === MAX_CANDIDATES) break;
    }
    return { candidates: [], sitemapUrls };
  }

  const seen = new Set();
  const candidates = [];
  for (const block of blocks) {
    const url = canonicalizeArticleUrl(elementValue(block, ['loc']), baseUrl);
    if (!url || !matchesBlogSource(url, source) || seen.has(url)) continue;
    seen.add(url);
    const publishedAt = normalizeDate(elementValue(block, ['lastmod']));
    candidates.push({ title: '', url, publishedAt, description: '' });
  }

  candidates.sort((left, right) => {
    if (left.publishedAt === null) return right.publishedAt === null ? 0 : 1;
    if (right.publishedAt === null) return -1;
    return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  });
  return { candidates: candidates.slice(0, MAX_CANDIDATES), sitemapUrls: [] };
}

function enclosingBlock(html, anchorStart, anchorEnd) {
  for (const tagName of ['article', 'li']) {
    const openingStart = html.lastIndexOf(`<${tagName}`, anchorStart);
    if (openingStart === -1) continue;
    const priorClose = html.lastIndexOf(`</${tagName}`, anchorStart);
    if (priorClose > openingStart) continue;
    const closingStart = html.indexOf(`</${tagName}`, anchorEnd);
    if (closingStart === -1) continue;
    const closingEnd = html.indexOf('>', closingStart);
    if (closingEnd !== -1) return html.slice(openingStart, closingEnd + 1);
  }
  return '';
}

function indexDate(block) {
  const time = block.match(/<time\b([^>]*)>([\s\S]*?)<\/time\s*>/i);
  if (!time) return null;
  return normalizeDate(attributeValue(time[1], 'datetime') || cleanText(time[2]));
}

export function parseBlogIndex(html, source, baseUrl) {
  if (typeof html !== 'string' || !html.trim()) return [];

  const candidates = [];
  const seen = new Set();
  const anchors = html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi);
  for (const match of anchors) {
    const rawUrl = attributeValue(match[1], 'href');
    const url = canonicalizeArticleUrl(rawUrl, baseUrl);
    if (!url || !matchesBlogSource(url, source) || seen.has(url)) continue;

    const block = enclosingBlock(html, match.index, match.index + match[0].length);
    const titleAttribute = attributeValue(match[1], 'title');
    const title = titleAttribute || cleanText(match[2]);
    if (!title) continue;

    seen.add(url);
    candidates.push({
      title,
      url,
      publishedAt: block ? indexDate(block) : null,
      description: block ? elementValue(block, ['p']) : '',
    });
    if (candidates.length === MAX_CANDIDATES) break;
  }

  return candidates;
}

function sanitizeErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s]+/gi, (value) => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[url]';
      }
    })
    .replace(/\b(token|api[_-]?key|password|secret)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || 'Unknown error';
}

async function fetchText(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, text/html;q=0.9',
      'User-Agent': BLOG_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
  return response.text();
}

function mergeSitemapCandidates(groups) {
  const seen = new Set();
  const candidates = [];
  for (const group of groups) {
    for (const candidate of group) {
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => {
    if (left.publishedAt === null) return right.publishedAt === null ? 0 : 1;
    if (right.publishedAt === null) return -1;
    return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  });
  return candidates.slice(0, MAX_CANDIDATES);
}

export async function discoverBlogArticles(source, options = {}) {
  options.fetchImpl ??= globalThis.fetch;
  options.now ??= Date.now;
  options.timeoutMs ??= DEFAULT_TIMEOUT_MS;
  options.errors ??= [];
  options.shadow ??= false;

  for (const discovery of source?.discovery ?? []) {
    try {
      const body = await fetchText(discovery.url, options.fetchImpl, options.timeoutMs);
      let candidates;

      if (discovery.type === 'rss') {
        candidates = parseBlogFeed(body, source, discovery.url);
      } else if (discovery.type === 'html') {
        candidates = parseBlogIndex(body, source, discovery.url);
      } else if (discovery.type === 'sitemap') {
        const parsed = parseSitemap(body, source, discovery.url);
        const groups = [parsed.candidates];
        for (const childUrl of parsed.sitemapUrls) {
          try {
            const childBody = await fetchText(childUrl, options.fetchImpl, options.timeoutMs);
            groups.push(parseSitemap(childBody, source, childUrl).candidates);
          } catch (error) {
            options.errors.push(
              `Blog: ${source.name}: discovery-sitemap: ${sanitizeErrorMessage(error)}`,
            );
          }
        }
        candidates = mergeSitemapCandidates(groups);
      } else {
        candidates = [];
      }

      if (candidates.length > 0) return candidates.slice(0, MAX_CANDIDATES);
    } catch (error) {
      options.errors.push(
        `Blog: ${source.name}: discovery-${discovery.type}: ${sanitizeErrorMessage(error)}`,
      );
    }
  }

  return [];
}
