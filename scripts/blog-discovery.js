import { isIP } from 'node:net';

import {
  canonicalizeArticleUrl,
  matchesBlogSource,
} from './blog-source-config.js';

const MAX_CANDIDATES = 12;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15000;
const BLOG_USER_AGENT = 'Mozilla/5.0 (compatible; FollowBuilders/1.0; +https://github.com/)';
const RAW_BLOG_URL = Symbol.for('follow-up.blog.raw-url');

function candidateWithRawUrl(candidate, rawUrl) {
  Object.defineProperty(candidate, RAW_BLOG_URL, { value: rawUrl });
  return candidate;
}

export function getBlogCandidateRawUrl(candidate) {
  return candidate?.[RAW_BLOG_URL] ?? candidate?.url;
}

function decodeNumericEntity(match, code, radix) {
  const value = Number.parseInt(code, radix);
  if (!Number.isFinite(value) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return match;
  }
  return String.fromCodePoint(value);
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeNumericEntity(match, code, 16))
    .replace(/&#(\d+);/g, (match, code) => decodeNumericEntity(match, code, 10))
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
  const prefix = `(?:^|\\s)${name}\\s*=\\s*`;
  const quoted = tag.match(new RegExp(`${prefix}(["'])([\\s\\S]*?)\\1`, 'i'));
  if (quoted) return decodeXml(quoted[2]).trim();
  const unquoted = tag.match(new RegExp(`${prefix}([^\\s>]+)`, 'i'));
  return unquoted ? decodeXml(unquoted[1]).trim() : '';
}

function isPrivateIpLiteral(hostname) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(value);
  if (version === 4) {
    const [first, second] = value.split('.').map(Number);
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (version === 6) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('::ffff:')) return isPrivateIpLiteral(value.slice(7));
    const first = Number.parseInt(value.split(':', 1)[0], 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

function safeChildSitemapUrl(value, parentUrl) {
  const canonicalUrl = canonicalizeArticleUrl(value, parentUrl);
  if (!canonicalUrl) return null;

  try {
    const candidate = new URL(canonicalUrl);
    const parent = new URL(parentUrl);
    if (candidate.protocol !== 'https:'
      || candidate.origin !== parent.origin
      || isPrivateIpLiteral(candidate.hostname)) return null;
    return canonicalUrl;
  } catch {
    return null;
  }
}

function safeRedirectUrl(value, currentUrl, approvedOrigin) {
  if (!value) return null;

  try {
    const target = new URL(value, currentUrl);
    if (target.protocol !== 'https:'
      || target.origin !== approvedOrigin
      || target.username
      || target.password
      || isPrivateIpLiteral(target.hostname)) return null;
    target.hash = '';
    return target.href;
  } catch {
    return null;
  }
}

function normalizeDate(value) {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function addCandidate(candidates, seen, source, rawUrl, baseUrl, metadata) {
  const decodedRawUrl = decodeXml(rawUrl).trim();
  const url = canonicalizeArticleUrl(decodedRawUrl, baseUrl);
  if (!url || !matchesBlogSource(url, source) || seen.has(url) || !metadata.title) return;

  seen.add(url);
  candidates.push(candidateWithRawUrl({
    title: metadata.title,
    url,
    publishedAt: normalizeDate(metadata.publishedAt),
    description: metadata.description,
  }, decodedRawUrl));
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
      const alternateLinks = linkTags.filter((tag) => {
        const rel = attributeValue(tag, 'rel').toLowerCase();
        return !rel || rel === 'alternate';
      });
      const alternate = alternateLinks.find((tag) => {
        const type = attributeValue(tag, 'type').toLowerCase();
        return !type || type === 'text/html';
      }) ?? alternateLinks[0];
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
      const url = safeChildSitemapUrl(elementValue(block, ['loc']), baseUrl);
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
    const rawUrl = elementValue(block, ['loc']);
    const url = canonicalizeArticleUrl(rawUrl, baseUrl);
    if (!url || !matchesBlogSource(url, source) || seen.has(url)) continue;
    seen.add(url);
    const publishedAt = normalizeDate(elementValue(block, ['lastmod']));
    candidates.push(candidateWithRawUrl(
      { title: '', url, publishedAt, description: '' },
      rawUrl,
    ));
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

function elementRanges(html, expression) {
  return [...html.matchAll(expression)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function includesPosition(ranges, position) {
  return ranges.some(({ start, end }) => position >= start && position < end);
}

export function parseBlogIndex(html, source, baseUrl) {
  if (typeof html !== 'string' || !html.trim()) return [];

  const candidates = [];
  const seen = new Set();
  const mainRanges = elementRanges(html, /<main\b[^>]*>[\s\S]*?<\/main\s*>/gi);
  const excludedRanges = [
    ...elementRanges(html, /<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi),
    ...elementRanges(
      html,
      /<([\w.-]+)\b[^>]*(?:class|id)\s*=\s*(["'])[^"']*\b(?:related|recommended)[^"']*\2[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ),
  ];
  const anchors = html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi);
  for (const match of anchors) {
    if ((mainRanges.length > 0 && !includesPosition(mainRanges, match.index))
      || includesPosition(excludedRanges, match.index)) continue;

    const rawUrl = attributeValue(match[1], 'href');
    const url = canonicalizeArticleUrl(rawUrl, baseUrl);
    if (!url || !matchesBlogSource(url, source) || seen.has(url)) continue;

    const block = enclosingBlock(html, match.index, match.index + match[0].length);
    const titleAttribute = attributeValue(match[1], 'title');
    const anchorText = cleanText(match[2]);
    const heading = block ? elementValue(block, ['h2', 'h3']) : '';
    const title = titleAttribute || (/^read more$/i.test(anchorText) ? heading : anchorText);
    if (!title) continue;

    seen.add(url);
    candidates.push(candidateWithRawUrl({
      title,
      url,
      publishedAt: block ? indexDate(block) : null,
      description: block ? elementValue(block, ['p']) : '',
    }, rawUrl));
    if (candidates.length === MAX_CANDIDATES) break;
  }

  return candidates;
}

export function sanitizeBlogErrorMessage(error) {
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

export async function fetchBlogResource(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  accept = 'application/atom+xml, application/rss+xml, application/xml, text/xml, text/html;q=0.9',
} = {}) {
  const approvedOrigin = new URL(url).origin;
  let currentUrl = url;
  let redirects = 0;
  const signal = AbortSignal.timeout(timeoutMs);

  while (true) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        Accept: accept,
        'User-Agent': BLOG_USER_AGENT,
      },
      redirect: 'manual',
      signal,
    });

    if (response?.status >= 300 && response.status < 400) {
      if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects');
      const location = response.headers?.get?.('location');
      if (!location) throw new Error('Redirect response missing Location');
      const targetUrl = safeRedirectUrl(location, currentUrl, approvedOrigin);
      if (!targetUrl) throw new Error('Redirected to a disallowed URL');
      currentUrl = targetUrl;
      redirects += 1;
      continue;
    }

    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
    if (response.url && !safeRedirectUrl(response.url, currentUrl, approvedOrigin)) {
      throw new Error('Redirected to a disallowed URL');
    }
    return { body: await response.text(), url: response.url || currentUrl };
  }
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
      const { body } = await fetchBlogResource(discovery.url, options);
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
            const { body: childBody } = await fetchBlogResource(childUrl, options);
            groups.push(parseSitemap(childBody, source, childUrl).candidates);
          } catch (error) {
            options.errors.push(
              `Blog: ${source.name}: discovery-sitemap: ${sanitizeBlogErrorMessage(error)}`,
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
        `Blog: ${source.name}: discovery-${discovery.type}: ${sanitizeBlogErrorMessage(error)}`,
      );
    }
  }

  return [];
}
