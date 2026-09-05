import {
  canonicalizeUrl,
  createCandidateId,
  createContentFingerprint,
} from './candidate-identity.js';

export const DEFAULT_CONTENT_BYTE_LIMIT = 24_000;
export const PODCAST_CONTENT_BYTE_LIMIT = 80_000;

const CHANNEL_SPECS = [
  ['x', 'x'],
  ['podcasts', 'podcasts'],
  ['blogs', 'blogs'],
  ['newsletters', 'newsletters'],
  ['academic', 'papers'],
  ['zh-tech', 'articles'],
];

export function truncateUtf8(value, maxBytes) {
  const text = typeof value === 'string' ? value : '';
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { content: text, truncated: false };
  }

  const parts = [];
  let length = 0;
  for (const codePoint of text) {
    const bytes = Buffer.byteLength(codePoint, 'utf8');
    if (length + bytes > maxBytes) break;
    parts.push(codePoint);
    length += bytes;
  }
  return { content: parts.join(''), truncated: true };
}

function normalizeDate(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError(`Invalid candidate date: ${String(value)}`);
  return new Date(time).toISOString();
}

function matchingRegistryEntries(registry, channel, identity) {
  if (identity.sourceId) {
    return registry.filter((source) => (
      source.channel === channel && source.id === identity.sourceId
    ));
  }
  return registry.filter((source) => {
    if (source.channel !== channel) return false;
    if (channel === 'x' && identity.handle && source.handle === identity.handle) return true;
    return identity.name && source.name === identity.name;
  });
}

function resolveSource(registry, channel, identity) {
  const matches = matchingRegistryEntries(registry, channel, identity);
  if (matches.length === 0) {
    throw new Error(`No source registry entry for ${channel} source ${identity.name || identity.handle || identity.sourceId || '<unknown>'}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous source registry entry for ${channel} source ${identity.name || identity.handle || identity.sourceId}`);
  }
  return matches[0];
}

function chooseContent(item, channel) {
  if (channel === 'x') return item.text;
  if (channel === 'podcasts') return item.transcript || item.description || item.title;
  if (channel === 'blogs') return item.content || item.description || item.title;
  return item.content || item.summary || item.description || item.title;
}

function buildCandidate(item, context) {
  const canonicalUrl = canonicalizeUrl(item.url);
  if (!canonicalUrl) throw new TypeError(`Invalid candidate URL for source ${context.source.id}`);

  const title = context.channel === 'x' ? item.text : item.title;
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TypeError(`Candidate title is required for source ${context.source.id}`);
  }
  const sourceNativeId = item.id || item.guid || undefined;
  const limit = context.channel === 'podcasts'
    ? PODCAST_CONTENT_BYTE_LIMIT
    : DEFAULT_CONTENT_BYTE_LIMIT;
  const { content: summarizationContent, truncated: contentTruncated } = truncateUtf8(
    chooseContent(item, context.channel),
    limit,
  );
  const candidate = {
    candidateId: createCandidateId({
      channel: context.channel,
      sourceId: context.source.id,
      sourceNativeId,
      canonicalUrl,
    }),
    channel: context.channel,
    sourceId: context.source.id,
    ...(sourceNativeId ? { sourceNativeId } : {}),
    canonicalUrl,
    title,
    author: item.author || context.author || context.source.name || '',
    publishedAt: normalizeDate(item.publishedAt ?? item.createdAt),
    firstSeenAt: context.seenAt,
    lastSeenAt: context.seenAt,
    summarizationContent,
    contentTruncated,
  };
  candidate.contentFingerprint = createContentFingerprint(candidate);
  return candidate;
}

function normalizeGroupedItems(groups, channel, registry, seenAt) {
  const candidates = [];
  for (const group of groups) {
    const source = resolveSource(registry, channel, {
      sourceId: group.sourceId || group.id,
      handle: group.handle,
      name: group.name || group.source,
    });
    const items = channel === 'x' ? group.tweets : group.items;
    if (!Array.isArray(items)) throw new TypeError(`${channel} source ${source.id} items must be an array`);
    for (const item of items) {
      candidates.push(buildCandidate(item, {
        channel,
        source,
        seenAt,
        author: channel === 'x' ? group.name || group.handle : group.source || group.name,
      }));
    }
  }
  return candidates;
}

export function normalizeLegacyFeed(feed, channel, { registry, seenAt }) {
  if (!Array.isArray(registry)) throw new TypeError('source registry must be an array');
  const normalizedSeenAt = normalizeDate(seenAt);
  const spec = CHANNEL_SPECS.find(([candidateChannel]) => candidateChannel === channel);
  if (!spec) throw new TypeError(`Unknown legacy feed channel: ${channel}`);
  const payload = feed?.[spec[1]];
  if (!Array.isArray(payload)) throw new TypeError(`${channel} feed payload must be an array`);

  if (channel === 'podcasts' || channel === 'blogs') {
    return payload.map((item) => {
      const source = resolveSource(registry, channel, {
        sourceId: item.sourceId,
        name: item.name,
      });
      return buildCandidate(item, { channel, source, seenAt: normalizedSeenAt, author: item.name });
    });
  }
  return normalizeGroupedItems(payload, channel, registry, normalizedSeenAt);
}

export function normalizeLegacyFeeds(feeds, options) {
  return CHANNEL_SPECS.flatMap(([channel]) => normalizeLegacyFeed(feeds?.[channel], channel, options));
}
