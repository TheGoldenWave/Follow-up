import { canonicalizeArticleUrl } from './blog-source-config.js';

const ARTICLE_TYPES = new Set(['BlogPosting', 'Article', 'NewsArticle', 'TechArticle']);
const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
};

function decodeEntities(value = '') {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));/gi, (entity, decimal, hex, named) => {
    if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? entity;
    const codePoint = Number.parseInt(decimal ?? hex, hex ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

function parseAttributes(source = '') {
  const attributes = {};
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attributePattern.exec(source)) !== null) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function openingTags(html, tagName) {
  const tags = [];
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  let match;
  while ((match = pattern.exec(html)) !== null) tags.push(parseAttributes(match[1]));
  return tags;
}

function firstMeta(html, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const attributes of openingTags(html, 'meta')) {
    const key = (attributes.property || attributes.name || attributes.itemprop || '').toLowerCase();
    if (wanted.has(key) && attributes.content) return attributes.content.trim();
  }
  return '';
}

function findCanonicalLink(html) {
  for (const attributes of openingTags(html, 'link')) {
    if ((attributes.rel || '').toLowerCase().split(/\s+/).includes('canonical')) {
      return attributes.href || '';
    }
  }
  return '';
}

function articleType(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some((type) => ARTICLE_TYPES.has(String(type).split('/').pop()));
}

function findArticleJsonLd(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findArticleJsonLd(entry);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (articleType(value['@type'])) return value;
  if (value['@graph']) return findArticleJsonLd(value['@graph']);
  return null;
}

function extractArticleJsonLd(html) {
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    if ((attributes.type || '').toLowerCase() !== 'application/ld+json') continue;
    try {
      const article = findArticleJsonLd(JSON.parse(match[2].trim()));
      if (article) return article;
    } catch {
      // Ignore malformed structured data and continue through the page.
    }
  }
  return null;
}

function authorName(author) {
  if (Array.isArray(author)) return author.map(authorName).filter(Boolean).join(', ');
  if (typeof author === 'string') return author.trim();
  if (!author || typeof author !== 'object') return '';
  return String(author.name || '').trim();
}

function selectorMatcher(part) {
  let tagName = '';
  let className = '';
  let id = '';
  if (/^\.[\w-]+$/.test(part)) className = part.slice(1);
  else if (/^#[\w-]+$/.test(part)) id = part.slice(1);
  else {
    const match = part.match(/^([a-z][\w-]*)(?:\.([\w-]+))?$/i);
    if (!match) return null;
    [, tagName, className = ''] = match;
  }
  return {
    tagName,
    matches(attributes) {
      if (id && attributes.id !== id) return false;
      if (className && !(attributes.class || '').split(/\s+/).includes(className)) return false;
      return true;
    },
  };
}

function matchesNode(node, matcher) {
  return (!matcher.tagName || matcher.tagName.toLowerCase() === node.tagName) &&
    matcher.matches(node.attributes);
}

function matchesAncestorChain(ancestors, matchers) {
  let ancestorIndex = ancestors.length - 1;
  for (let matcherIndex = matchers.length - 2; matcherIndex >= 0; matcherIndex -= 1) {
    while (ancestorIndex >= 0 && !matchesNode(ancestors[ancestorIndex], matchers[matcherIndex])) {
      ancestorIndex -= 1;
    }
    if (ancestorIndex < 0) return false;
    ancestorIndex -= 1;
  }
  return true;
}

function extractElement(html, selector) {
  const matchers = selector.trim().split(/\s+/).map(selectorMatcher);
  if (matchers.length === 0 || matchers.some((matcher) => !matcher)) return '';

  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [];
  const candidates = [];
  const tagPattern = /<(\/)?([a-z][\w-]*)\b([^>]*)>/gi;
  let tag;
  while ((tag = tagPattern.exec(html)) !== null) {
    const tagName = tag[2].toLowerCase();
    if (!tag[1]) {
      if (!voidTags.has(tagName) && !tag[3].trimEnd().endsWith('/')) {
        stack.push({
          tagName,
          attributes: parseAttributes(tag[3]),
          contentStart: tagPattern.lastIndex,
          openingIndex: tag.index,
        });
      }
      continue;
    }

    let openingIndex = stack.length - 1;
    while (openingIndex >= 0 && stack[openingIndex].tagName !== tagName) openingIndex -= 1;
    if (openingIndex < 0) continue;
    const node = stack[openingIndex];
    const ancestors = stack.slice(0, openingIndex);
    stack.length = openingIndex;
    const finalMatcher = matchers[matchers.length - 1];
    if (
      matchesNode(node, finalMatcher) &&
      matchesAncestorChain(ancestors, matchers)
    ) {
      candidates.push({
        openingIndex: node.openingIndex,
        content: html.slice(node.contentStart, tag.index),
      });
    }
  }
  candidates.sort((left, right) => left.openingIndex - right.openingIndex);
  return candidates[0]?.content || '';
}

function cleanHtmlText(html = '') {
  let cleaned = html;
  for (const tag of ['script', 'style', 'nav', 'footer', 'aside', 'header']) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  cleaned = cleaned
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, ' ')
    .replace(/<\/(?:p|div|section|article|main|h[1-6]|li|blockquote|pre)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(cleaned).replace(/\s+/g, ' ').trim();
}

function semanticText(html, selector) {
  const content = extractElement(html, selector);
  return content ? cleanHtmlText(content) : '';
}

function semanticTime(html) {
  const pattern = /<time\b([^>]*)>([\s\S]*?)<\/time>/i;
  const match = html.match(pattern);
  if (!match) return '';
  const attributes = parseAttributes(match[1]);
  return (attributes.datetime || attributes.content || cleanHtmlText(match[2])).trim();
}

function firstParseableDate(values) {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const raw = String(value).trim();
    if (raw && !Number.isNaN(Date.parse(raw))) return raw;
  }
  return null;
}

function jsonLdUrl(article) {
  if (typeof article?.url === 'string') return article.url;
  if (typeof article?.mainEntityOfPage === 'string') return article.mainEntityOfPage;
  return article?.mainEntityOfPage?.['@id'] || '';
}

function siteExtraction(html, parser, articleUrl) {
  if (parser === 'anthropic-engineering') return extractAnthropicArticleContent(html);
  if (parser === 'claude-blog') return extractClaudeBlogArticleContent(html);
  if (parser === 'qwen-blog') return extractQwenBlogArticleContent(html, articleUrl);
  return null;
}

function extractQwenBlogArticleContent(body, articleUrl) {
  try {
    const data = JSON.parse(body)?.data;
    const parameters = new URL(articleUrl).searchParams;
    const requestedPath = parameters.get('path') || parameters.get('id');
    const article = Array.isArray(data?.articles)
      ? data.articles.find(({ path }) => path === requestedPath)
      : data;
    if (!article || article.path !== requestedPath || typeof article.content !== 'string') {
      return null;
    }
    return {
      title: String(article.title || '').trim(),
      publishedAt: article.extra?.date || null,
      author: String(article.extra?.author || '').trim(),
      description: String(article.extra?.description || '').trim(),
      canonicalUrl: articleUrl,
      content: article.content,
    };
  } catch {
    return null;
  }
}

function cleanSiteParserContent(content, html) {
  let cleaned = cleanHtmlText(content);
  for (const tag of ['script', 'style', 'nav', 'footer', 'aside', 'header']) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const boilerplate = cleanHtmlText(match[1]);
      if (boilerplate) cleaned = cleaned.split(boilerplate).join(' ');
    }
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

export function extractBlogArticle(html, articleUrl, source = {}) {
  if (typeof html !== 'string') return null;

  const structured = extractArticleJsonLd(html);
  const site = siteExtraction(html, source.parser, articleUrl);
  if (source.parser === 'qwen-blog' && site) {
    const content = cleanSiteParserContent(site.content, html);
    const canonicalUrl = canonicalizeArticleUrl(site.canonicalUrl, source.url);
    if (!site.title || !canonicalUrl || content.replace(/\s/g, '').length < 200) return null;
    return {
      title: decodeEntities(site.title),
      canonicalUrl,
      publishedAt: firstParseableDate([site.publishedAt]),
      author: decodeEntities(site.author),
      description: decodeEntities(site.description),
      content,
    };
  }
  const title = decodeEntities(String(
    structured?.headline || structured?.name ||
    firstMeta(html, ['og:title', 'twitter:title', 'title']) ||
    semanticText(html, 'h1') || site?.title || '',
  )).trim();
  const publishedAt = firstParseableDate([
    structured?.datePublished,
    firstMeta(html, ['article:published_time', 'datepublished', 'date', 'pubdate']),
    semanticTime(html),
    site?.publishedAt,
  ]);
  const author = decodeEntities(
    authorName(structured?.author) || firstMeta(html, ['author', 'article:author']) || site?.author || '',
  ).trim();
  const description = decodeEntities(String(
    structured?.description || firstMeta(html, ['og:description', 'description', 'twitter:description'])
    || site?.description || '',
  )).trim();

  const canonicalCandidate =
    findCanonicalLink(html) || jsonLdUrl(structured) || firstMeta(html, ['og:url'])
    || site?.canonicalUrl || articleUrl;
  const canonicalUrl = canonicalizeArticleUrl(canonicalCandidate, articleUrl || source.url);

  let content = typeof structured?.articleBody === 'string'
    ? cleanHtmlText(structured.articleBody)
    : '';
  if (!content && site?.content) content = cleanSiteParserContent(site.content, html);
  if (!content && source.contentSelectorPriority === true) {
    for (const selector of source.contentSelectors || []) {
      content = semanticText(html, selector);
      if (content) break;
    }
  }
  if (!content) content = semanticText(html, 'article') || semanticText(html, 'main');
  if (!content) {
    for (const selector of source.contentSelectors || []) {
      content = semanticText(html, selector);
      if (content) break;
    }
  }

  if (!title || !canonicalUrl || content.replace(/\s/g, '').length < 200) return null;
  return { title, canonicalUrl, publishedAt, author, description, content };
}

// Extracts the main text content from an Anthropic Engineering article page.
// Tries the embedded JSON first (Next.js SSR data), then falls back to
// stripping HTML tags from the article body.
export function extractAnthropicArticleContent(html) {
  let title = "";
  let author = "";
  let publishedAt = null;
  let content = "";

  // Try to get structured data from Next.js __NEXT_DATA__
  const nextDataMatch = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const pageProps = data?.props?.pageProps;
      const post =
        pageProps?.post || pageProps?.article || pageProps?.entry || pageProps;
      title = post?.title || "";
      author = post?.author?.name || post?.authors?.[0]?.name || "";
      publishedAt =
        post?.publishedOn || post?.publishedAt || post?.date || null;

      // Extract text from the body blocks (Sanity CMS portable text format)
      const body = post?.body || post?.content || [];
      if (Array.isArray(body)) {
        const textParts = [];
        for (const block of body) {
          if (block._type === "block" && block.children) {
            const text = block.children.map((c) => c.text || "").join("");
            if (text.trim()) textParts.push(text.trim());
          }
        }
        content = textParts.join("\n\n");
      }
      if (content) return { title, author, publishedAt, content };
    } catch {
      // Fall through to HTML stripping
    }
  }

  // Fallback: extract title from <h1> and body from <article> or main content
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, "").trim();

  // Try to find the article body and strip HTML tags
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = articleMatch ? articleMatch[1] : html;

  // Strip script/style tags first, then all remaining HTML tags
  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { title, author, publishedAt, content };
}

// Extracts the main text content from a Claude Blog article page.
// Uses JSON-LD schema data if present, then falls back to the rich text body.
export function extractClaudeBlogArticleContent(html) {
  let title = "";
  let author = "";
  let publishedAt = null;
  let content = "";

  // Try JSON-LD structured data first (most reliable for metadata)
  const jsonLdRegex =
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld["@type"] === "BlogPosting" || ld["@type"] === "Article") {
        title = ld.headline || ld.name || "";
        author = ld.author?.name || "";
        publishedAt = ld.datePublished || null;
        break;
      }
    } catch {
      // Not valid JSON-LD, skip
    }
  }

  // Extract body text from the Webflow rich text container
  const richTextMatch =
    html.match(
      /<div[^>]*class="[^"]*u-rich-text-blog[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    ) ||
    html.match(/<div[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (richTextMatch) {
    content = richTextMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // If rich text extraction failed, try a broader approach
  if (!content) {
    // Get title from <h1> if not already found
    if (!title) {
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, "").trim();
    }

    // Strip the whole page down to text as a last resort
    content = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return { title, author, publishedAt, content };
}
