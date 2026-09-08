import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as systemFs from 'node:fs/promises';

import {
  normalizeLegacyFeed,
  normalizeLegacyFeeds,
} from '../candidate-normalization.js';

// Central feed channels in the same order as candidate-normalization.js.
export const CENTRAL_CHANNELS = [
  'x', 'podcasts', 'blogs', 'newsletters', 'academic', 'zh-tech',
];

// Central feed payload keys per channel (mirrors feed-contract.js PAYLOAD_KEYS).
export const CHANNEL_PAYLOAD = Object.freeze({
  x: 'x',
  podcasts: 'podcasts',
  blogs: 'blogs',
  newsletters: 'newsletters',
  academic: 'papers',
  'zh-tech': 'articles',
});

export const DEFAULT_MIGRATION_PATH = join(
  homedir(), '.follow-builders', 'acquisition', 'migration.json',
);

// Identity fields a central feed entry exposes per channel. These mirror the
// legacy selector keys used by candidate-normalization.js, but are resolved
// against the authoritative registry instead of a frozen map.
function identityKeys(source) {
  const input = source.input ?? {};
  const keys = [];
  if (source.channel === 'x') {
    if (typeof input.handle === 'string' && input.handle.length > 0) {
      keys.push(input.handle);
    }
  } else if (source.channel === 'podcasts' || source.channel === 'blogs') {
    if (typeof source.name === 'string' && source.name.length > 0) {
      keys.push(source.name);
    }
  } else {
    for (const field of ['url', 'rss_url']) {
      if (typeof input[field] === 'string' && input[field].length > 0) {
        keys.push(input[field]);
      }
    }
  }
  return keys;
}

export function buildIdentityIndex(sources) {
  const index = new Map();
  for (const source of sources) {
    for (const identity of identityKeys(source)) {
      const key = `${source.channel}\0${identity}`;
      const existing = index.get(key);
      if (existing !== undefined && existing !== source.id) {
        throw new Error(
          `Duplicate central identity "${identity}" for ${source.channel}: ` +
          `${existing} and ${source.id}`,
        );
      }
      index.set(key, source.id);
    }
  }
  return index;
}

export function resolveSourceId(index, channel, identity = {}) {
  if (typeof identity.sourceId === 'string' && identity.sourceId.length > 0) {
    return identity.sourceId;
  }
  let keys;
  if (channel === 'x') keys = [identity.handle];
  else if (channel === 'podcasts' || channel === 'blogs') keys = [identity.name];
  else keys = [identity.rss, identity.rssUrl, identity.url];
  for (const key of keys) {
    if (typeof key === 'string' && key.length > 0) {
      const sourceId = index.get(`${channel}\0${key}`);
      if (sourceId) return sourceId;
    }
  }
  return null;
}

function withSourceIds(feed, channel, index) {
  const payloadKey = CHANNEL_PAYLOAD[channel];
  const payload = feed?.[payloadKey];
  if (!Array.isArray(payload)) return feed;
  const resolved = payload.map((entry) => {
    const sourceId = resolveSourceId(index, channel, {
      sourceId: entry.sourceId,
      handle: entry.handle,
      name: entry.name,
      rss: entry.rss,
      rssUrl: entry.rssUrl,
      url: entry.url,
    });
    if (!sourceId) {
      throw new Error(
        `No source registry entry for ${channel} central feed item ` +
        `(handle=${entry.handle ?? ''} name=${entry.name ?? ''} url=${entry.url ?? ''})`,
      );
    }
    return { ...entry, sourceId };
  });
  return { ...feed, [payloadKey]: resolved };
}

function registryFromSources(sources) {
  return sources.map(({ id, name, channel }) => ({ id, name, channel }));
}

/**
 * Convert every central Feed into the same camelCase candidate model produced
 * by the local adapters, keyed by stable `source_id` resolved exclusively from
 * `config/sources.json` (never from display names or a second routing catalog).
 *
 * Returns a flat candidate array across all channels.
 */
export function normalizeCentralFeeds(feeds, { sources, seenAt }) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  const index = buildIdentityIndex(sources);
  const registry = registryFromSources(sources);
  const augmented = {};
  for (const channel of CENTRAL_CHANNELS) {
    const payloadKey = CHANNEL_PAYLOAD[channel];
    const present = feeds?.[channel] && Array.isArray(feeds[channel]?.[payloadKey]);
    augmented[channel] = present
      ? withSourceIds(feeds[channel], channel, index)
      : { [payloadKey]: [] };
  }
  return normalizeLegacyFeeds(augmented, { registry, seenAt });
}

/** Convert a single central Feed channel into candidates. */
export function normalizeCentralFeed(feed, channel, { sources, seenAt }) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  const index = buildIdentityIndex(sources);
  const registry = registryFromSources(sources);
  const augmented = withSourceIds(feed, channel, index);
  return normalizeLegacyFeed(augmented, channel, { registry, seenAt });
}

export function emptyMigrationState() {
  return { version: 1, sources: {} };
}

export async function loadMigrationState({
  path = DEFAULT_MIGRATION_PATH,
  fsImpl = systemFs,
} = {}) {
  try {
    const parsed = JSON.parse(await fsImpl.readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('migration state must be a JSON object');
    }
    return { ...emptyMigrationState(), ...parsed };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyMigrationState();
    throw error;
  }
}

export async function saveMigrationState(state, {
  path = DEFAULT_MIGRATION_PATH,
  fsImpl = systemFs,
} = {}) {
  await fsImpl.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fsImpl.writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
