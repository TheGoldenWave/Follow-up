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

export const LEGACY_SOURCE_ID_MAP = Object.freeze({
  x: Object.freeze({
    karpathy: 'x:karpathy',
    swyx: 'x:swyx',
    joshwoodward: 'x:joshwoodward',
    bcherny: 'x:bcherny',
    thsottiaux: 'x:thsottiaux',
    petergyang: 'x:petergyang',
    thenanyu: 'x:thenanyu',
    realmadhuguru: 'x:realmadhuguru',
    AmandaAskell: 'x:amandaaskell',
    _catwu: 'x:catwu',
    trq212: 'x:trq212',
    GoogleLabs: 'x:googlelabs',
    amasad: 'x:amasad',
    rauchg: 'x:rauchg',
    alexalbert__: 'x:alexalbert',
    levie: 'x:levie',
    ryolu_: 'x:ryolu',
    garrytan: 'x:garrytan',
    mattturck: 'x:mattturck',
    zarazhangrui: 'x:zarazhangrui',
    nikunj: 'x:nikunj',
    steipete: 'x:steipete',
    danshipper: 'x:danshipper',
    adityaag: 'x:adityaag',
    sama: 'x:sama',
    claudeai: 'x:claudeai',
    dario_amodei_h: 'x:dario-amodei',
    nathanlabenz: 'x:nathanlabenz',
    jackclarksf: 'x:jackclarksf',
    bentossell: 'x:bentossell',
  }),
  podcasts: Object.freeze({
    'Latent Space': 'podcast:latent-space',
    'Training Data': 'podcast:training-data',
    'No Priors': 'podcast:no-priors',
    'Unsupervised Learning': 'podcast:unsupervised-learning',
    'The MAD Podcast with Matt Turck': 'podcast:mad-podcast',
    'AI & I by Every': 'podcast:ai-and-i',
    'Lex Fridman Podcast': 'podcast:lex-fridman',
    'The Cognitive Revolution': 'podcast:cognitive-revolution',
    'Lightcone (YC)': 'podcast:lightcone',
    Acquired: 'podcast:acquired',
  }),
  blogs: Object.freeze({
    'Anthropic Engineering': 'blog:anthropic-engineering',
    'Claude Blog': 'blog:claude-blog',
    'Anthropic Interpretability': 'blog:anthropic-interpretability',
    'Anthropic Science': 'blog:anthropic-science',
    'OpenAI Alignment Research Blog': 'blog:openai-alignment',
    'Google Antigravity Blog': 'blog:google-antigravity',
    'Google DeepMind Blog': 'blog:google-deepmind',
    'Google Research Blog': 'blog:google-research',
    'Microsoft Research Blog': 'blog:microsoft-research',
    'Amazon Science Blog': 'blog:amazon-science',
    'IBM Research Blog': 'blog:ibm-research',
    'Perplexity Research Articles': 'blog:perplexity-research',
    'Qwen Blog': 'blog:qwen-blog',
    'Kimi Research & Tech Blog': 'blog:kimi-blog',
    'ERNIE Blog': 'blog:ernie-blog',
    'MiniMax Blog': 'blog:minimax-blog',
    'Apple Machine Learning Research': 'blog:apple-ml-research',
  }),
  newsletters: Object.freeze({
    'https://stratechery.com/': 'newsletter:stratechery',
    'https://stratechery.com/feed/': 'newsletter:stratechery',
    'https://oneusefulthing.org/': 'newsletter:one-useful-thing',
    'https://oneusefulthing.org/feed': 'newsletter:one-useful-thing',
    'https://thealgorithmicbridge.com/': 'newsletter:algorithmic-bridge',
    'https://thealgorithmicbridge.com/feed': 'newsletter:algorithmic-bridge',
    'https://aisnakeoil.substack.com/': 'newsletter:ai-snake-oil',
    'https://aisnakeoil.substack.com/feed': 'newsletter:ai-snake-oil',
  }),
  academic: Object.freeze({
    'https://arxiv.org/list/cs.AI/recent': 'academic:arxiv-cs-ai',
    'https://rss.arxiv.org/rss/cs.AI': 'academic:arxiv-cs-ai',
    'https://arxiv.org/list/cs.CL/recent': 'academic:arxiv-cs-cl',
    'https://rss.arxiv.org/rss/cs.CL': 'academic:arxiv-cs-cl',
    'https://arxiv.org/list/cs.CV/recent': 'academic:arxiv-cs-cv',
    'https://rss.arxiv.org/rss/cs.CV': 'academic:arxiv-cs-cv',
    'https://arxiv.org/list/cs.LG/recent': 'academic:arxiv-cs-lg',
    'https://rss.arxiv.org/rss/cs.LG': 'academic:arxiv-cs-lg',
    'https://arxiv.org/list/cs.RO/recent': 'academic:arxiv-cs-ro',
    'https://rss.arxiv.org/rss/cs.RO': 'academic:arxiv-cs-ro',
    'https://arxiv.org/list/cs.CR/recent': 'academic:arxiv-cs-cr',
    'https://rss.arxiv.org/rss/cs.CR': 'academic:arxiv-cs-cr',
  }),
  'zh-tech': Object.freeze({
    'https://36kr.com/': 'zh-tech:36kr',
    'https://36kr.com/feed': 'zh-tech:36kr',
    'https://sspai.com/': 'zh-tech:sspai',
    'https://sspai.com/feed': 'zh-tech:sspai',
    'https://www.qbitai.com/': 'zh-tech:qbitai',
    'https://www.qbitai.com/rss': 'zh-tech:qbitai',
  }),
});

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

function legacyMigrationKeys(channel, identity) {
  if (channel === 'x') return [identity.handle];
  if (channel === 'podcasts' || channel === 'blogs') return [identity.name];
  return [identity.rss, identity.rssUrl, identity.url];
}

function resolveSource(registry, channel, identity) {
  let sourceId;
  if (Object.hasOwn(identity, 'sourceId')) {
    if (typeof identity.sourceId !== 'string' || identity.sourceId.length === 0) {
      throw new Error(`${channel} sourceId must be a non-empty string when present`);
    }
    sourceId = identity.sourceId;
  } else {
    const keys = legacyMigrationKeys(channel, identity)
      .filter((key) => typeof key === 'string' && key.length > 0);
    const mappedIds = keys.map((key) => LEGACY_SOURCE_ID_MAP[channel]?.[key]);
    if (keys.length === 0 || mappedIds.some((mappedId) => !mappedId)) {
      throw new Error(`No frozen legacy source mapping for ${channel} source`);
    }
    const uniqueIds = new Set(mappedIds);
    if (uniqueIds.size !== 1) {
      throw new Error(`Ambiguous frozen legacy source mapping for ${channel} source`);
    }
    [sourceId] = uniqueIds;
  }
  const matches = registry.filter((source) => (
    source.channel === channel && source.id === sourceId
  ));
  if (matches.length === 0) {
    throw new Error(`No source registry entry for ${channel} source ${sourceId}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous source registry entry for ${channel} source ${sourceId}`);
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
      ...(Object.hasOwn(group, 'sourceId')
        ? { sourceId: group.sourceId }
        : Object.hasOwn(group, 'id') ? { sourceId: group.id } : {}),
      handle: group.handle,
      name: group.name || group.source,
      rss: group.rss,
      rssUrl: group.rssUrl,
      url: group.url,
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
        ...(Object.hasOwn(item, 'sourceId') ? { sourceId: item.sourceId } : {}),
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
