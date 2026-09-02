#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';

import { validateFeed } from './feed-contract.js';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const CENTRAL_FEED_BASE = 'https://raw.githubusercontent.com/TheGoldenWave/Follow-up/main';
export const CENTRAL_FEEDS = [
  { category: 'x', label: 'Tweet', filename: 'feed-x.json', payloadKey: 'x', outputKey: 'x' },
  { category: 'podcasts', label: 'Podcast', filename: 'feed-podcasts.json', payloadKey: 'podcasts', outputKey: 'podcasts' },
  { category: 'blogs', label: 'Blog', filename: 'feed-blogs.json', payloadKey: 'blogs', outputKey: 'blogs' },
  { category: 'newsletters', label: 'Newsletter', filename: 'feed-newsletters.json', payloadKey: 'newsletters', outputKey: 'newsletters' },
  { category: 'academic', label: 'Academic', filename: 'feed-academic.json', payloadKey: 'papers', outputKey: 'academic' },
  { category: 'zh-tech', label: 'Chinese technology', filename: 'feed-zh-tech.json', payloadKey: 'articles', outputKey: 'zhTech' },
].map((spec) => ({ ...spec, url: `${CENTRAL_FEED_BASE}/${spec.filename}` }));

const PROMPTS_BASE = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'summarize-newsletter.md',
  'summarize-paper.md',
  'summarize-zh-sources.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

export async function fetchJSON(
  url,
  { fetchImpl = fetch, timeoutMs = 15000 } = {},
) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

export async function loadCentralFeedData({ fetchJson = fetchJSON } = {}) {
  const data = Object.fromEntries(CENTRAL_FEEDS.map(({ outputKey }) => [outputKey, []]));
  const feeds = {};
  const errors = [];

  await Promise.all(CENTRAL_FEEDS.map(async (spec) => {
    let feed;
    try {
      feed = await fetchJson(spec.url);
    } catch (error) {
      errors.push(`Could not fetch ${spec.label.toLowerCase()} feed: ${error.message}`);
      return;
    }

    if (!feed) {
      errors.push(`Could not fetch ${spec.label.toLowerCase()} feed`);
      return;
    }

    const validation = validateFeed(feed, spec.category);
    if (!validation.valid) {
      errors.push(
        `${spec.label} feed is invalid (${validation.errors.join('; ')}); `
        + 'expected compatible schema 1.x. Update Follow-up before retrying.',
      );
      return;
    }

    feeds[spec.category] = feed;
    data[spec.outputKey] = feed[spec.payloadKey];
    if (feed.errors?.length) {
      errors.push(...feed.errors.map((error) => `${spec.label} feed problem: ${error}`));
    }
  }));

  return { data, feeds, errors };
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch all feeds
  const { data: feedData, feeds, errors: feedErrors } = await loadCentralFeedData();
  errors.push(...feedErrors);
  const feedX = feeds.x;
  const feedPodcasts = feeds.podcasts;
  const feedBlogs = feeds.blogs;

  // 3. Load prompts with priority: user custom > remote (GitHub) > local default
  //
  // If the user has a custom prompt at ~/.follow-builders/prompts/<file>,
  // use that (they personalized it — don't overwrite with remote updates).
  // Otherwise, fetch the latest from GitHub so they get central improvements.
  // If GitHub is unreachable, fall back to the local copy shipped with the skill.
  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: user's custom prompt (they personalized it)
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    // Priority 2: latest from GitHub (central updates)
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    // Priority 3: local copy shipped with the skill
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build the output — everything the LLM needs in one blob
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    ...feedData,

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      newsletterSources: feedData.newsletters.length,
      academicCategories: feedData.academic.length,
      totalPapers: feedData.academic.reduce((sum, s) => sum + (s.items?.length || 0), 0),
      zhTechSources: feedData.zhTech.length,
      totalZhArticles: feedData.zhTech.reduce((sum, s) => sum + (s.items?.length || 0), 0),
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Non-fatal errors
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(JSON.stringify({
      status: 'error',
      message: err.message
    }));
    process.exit(1);
  });
}
