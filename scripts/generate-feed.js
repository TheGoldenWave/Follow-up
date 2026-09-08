#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (daily at 6am UTC) to fetch content and publish
// feed-x.json, feed-podcasts.json, and feed-blogs.json.
//
// Deduplication: tracks previously seen tweet IDs, episode GUIDs, and article
// URLs in state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --podcasts-only | --blogs-only]
// Env vars needed: X_BEARER_TOKEN, POD2TXT_API_KEY
// ============================================================================

import { readFile, rename, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { basename, join } from "path";
import { pathToFileURL } from "url";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { createFeedEnvelope, validateFeed, validateFeedFiles } from "./feed-contract.js";
import { fetchBlogContent } from "./blog-collector.js";
import { validateBlogSources } from "./blog-source-config.js";
import {
  CANDIDATE_FEED_FILE,
  initializeCandidateFeed,
  loadCandidateFeed,
  mergeCandidateFeed,
} from "./candidate-feed-store.js";
import { normalizeLegacyFeeds } from "./candidate-normalization.js";
import { createSourceStatus, sanitizeDiagnostic } from "./source-status.js";
import {
  publishFeedTransaction,
  recoverFeedPublication,
  withFeedPublicationLock,
} from "./feed-publication.js";

// -- Constants ---------------------------------------------------------------

const POD2TXT_BASE = "https://pod2txt.vercel.app/api";
const X_API_BASE = "https://api.x.com/2";
// Some RSS hosts (notably Substack) block non-browser user agents from cloud IPs.
// Using a real Chrome UA avoids 403 errors in GitHub Actions.
const RSS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly, not daily
const BLOG_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;
const NEWSLETTER_LOOKBACK_HOURS = 72;
const ACADEMIC_LOOKBACK_HOURS = 168; // 7 days for papers
const ZH_TECH_LOOKBACK_HOURS = 72;
const MAX_NEWSLETTERS_PER_SOURCE = 1;
const MAX_PAPERS_PER_SOURCE = 5;
const MAX_ZH_ARTICLES_PER_SOURCE = 3;
const X_USER_LOOKUP_BATCH_SIZE = 5;
const X_RETRY_STATUSES = new Set([500, 502, 503, 504]);
const X_RETRY_ATTEMPTS = 3;
const RSS_PARSE_FAILURE_COUNT = Symbol('rssParseFailureCount');

const SCRIPT_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);

function normalizePublishedAt(value) {
  if (!value) return null;
  const timestamp = Date.parse(
    /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(value) ? `${value} UTC` : value,
  );
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function errorsSince(errors, startIndex) {
  return errors.slice(startIndex).filter((error) => error.startsWith("RSS"));
}

function pruneState(state, now = Date.now()) {
  const dayMs = 24 * 60 * 60 * 1000;
  const tweetCutoff = now - 7 * dayMs;
  const podcastCutoff = now - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000;
  const articleCutoff = now - 7 * dayMs;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < tweetCutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenVideos)) {
    if (ts < podcastCutoff) delete state.seenVideos[id];
  }
  for (const [id, ts] of Object.entries(state.seenArticles || {})) {
    if (ts < articleCutoff) delete state.seenArticles[id];
  }
  return state;
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, "..", "config", "default-sources.json");
  const sources = JSON.parse(await readFile(sourcesPath, "utf-8"));

  // Load additional feed configs for newsletters, academic, and zh-tech
  const newslettersPath = join(SCRIPT_DIR, "..", "config", "feed-newsletters.json");
  const academicPath = join(SCRIPT_DIR, "..", "config", "feed-academic.json");
  const zhTechPath = join(SCRIPT_DIR, "..", "config", "feed-zh-tech.json");
  const blogsPath = join(SCRIPT_DIR, "..", "config", "feed-blogs.json");

  if (existsSync(blogsPath)) {
    const blogConfig = JSON.parse(await readFile(blogsPath, "utf-8"));
    const validation = validateBlogSources(blogConfig.sources);
    if (!validation.valid) {
      throw new Error(`Invalid blog source configuration: ${validation.errors.join('; ')}`);
    }
    sources.blogs = blogConfig.sources;
  }

  sources.newsletters = existsSync(newslettersPath)
    ? JSON.parse(await readFile(newslettersPath, "utf-8")).sources
    : [];
  sources.academic = existsSync(academicPath)
    ? JSON.parse(await readFile(academicPath, "utf-8"))
    : { sources: [] };
  sources.zhTech = existsSync(zhTechPath)
    ? JSON.parse(await readFile(zhTechPath, "utf-8")).sources
    : [];

  return sources;
}

// -- Podcast Fetching (RSS + pod2txt) ----------------------------------------

// Parses an RSS feed XML string and returns episode objects with
// title, publishedAt, guid, and link. RSS feeds list newest first.
function rssDiagnostic(message) {
  return sanitizeDiagnostic(message);
}

const feedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (_name, path) => ['rss.channel.item', 'feed.entry', 'feed.entry.link'].includes(path),
});

function textValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return typeof value?.['#text'] === 'string' ? value['#text'].trim() : null;
}

function parseRssFeed(xml) {
  const episodes = [];
  let failedItemCount = 0;
  if (typeof xml !== 'string' || xml.trim() === '') throw new Error('Invalid feed XML: empty payload');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Invalid feed XML: ${validation.err.msg} at line ${validation.err.line}`);
  }
  const document = feedXmlParser.parse(xml);
  const isRss = document && Object.hasOwn(document, 'rss');
  const isAtom = document && Object.hasOwn(document, 'feed');
  if (!isRss && !isAtom) throw new Error('Invalid feed XML: root must be rss or feed');
  if (isRss && (!document.rss || !Object.hasOwn(document.rss, 'channel'))) {
    throw new Error('Invalid feed XML: RSS channel is required');
  }
  const items = isRss
    ? (typeof document.rss.channel === 'object' ? document.rss.channel.item ?? [] : [])
    : (typeof document.feed === 'object' ? document.feed.entry ?? [] : []);
  for (const item of items) {
    const title = textValue(item.title) || 'Untitled';
    let guid = textValue(isRss ? item.guid : item.id);
    const publishedAt = normalizePublishedAt(
      textValue(isRss ? item.pubDate : item.published) ?? textValue(item.updated),
    );
    const atomLinks = isAtom ? item.link ?? [] : [];
    const alternate = atomLinks.find((link) => link?.['@_rel'] === 'alternate')
      ?? atomLinks.find((link) => !link?.['@_rel'])
      ?? atomLinks[0];
    const link = isRss ? textValue(item.link) : alternate?.['@_href'] ?? null;

    // Use link as GUID fallback when GUID is missing
    // Some RSS feeds (e.g. 少数派, 36kr) don't include GUID elements
    if (!guid) guid = link;

    if (guid) episodes.push({ title, guid, publishedAt, link });
    else failedItemCount += 1;
  }
  Object.defineProperty(episodes, RSS_PARSE_FAILURE_COUNT, { value: failedItemCount });
  return episodes;
}

// -- YouTube Episode URL Lookup ----------------------------------------------
// Podcast RSS feeds don't know about YouTube, so to get the exact YouTube
// video URL for an episode we look up the channel's recent videos and match
// by title. Free, no API key required. Tries Atom RSS first (stable but
// returns 500 for some channels), falls back to scraping the /videos page.

// Derives a YouTube Atom feed URL from a channel or playlist URL.
// Handles three URL shapes: /@handle, /channel/UCxxx, /playlist?list=PLxxx.
async function getYouTubeFeedUrl(channelUrl) {
  if (!channelUrl || !channelUrl.includes("youtube.com")) return null;

  const playlistMatch = channelUrl.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (playlistMatch) {
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistMatch[1]}`;
  }

  const channelIdMatch = channelUrl.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
  if (channelIdMatch) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelIdMatch[1]}`;
  }

  // /@handle URLs need a round-trip: fetch the channel page and pull the
  // channelId out of its HTML. YouTube embeds it in several places; the
  // "channelId":"UC..." pattern in the JSON blob is the most reliable.
  if (channelUrl.match(/\/@[A-Za-z0-9_.-]+/)) {
    try {
      const res = await fetch(channelUrl, {
        headers: {
          "User-Agent": RSS_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      const idMatch =
        html.match(/"channelId":"(UC[A-Za-z0-9_-]{20,})"/) ||
        html.match(
          /<meta\s+itemprop="(?:identifier|channelId)"\s+content="(UC[A-Za-z0-9_-]{20,})"/,
        );
      if (idMatch) {
        return `https://www.youtube.com/feeds/videos.xml?channel_id=${idMatch[1]}`;
      }
    } catch {
      return null;
    }
  }
  return null;
}

// Scrapes recent videos from a YouTube channel's /videos page by parsing
// the ytInitialData JSON embedded in the HTML. Used as a fallback when the
// Atom RSS endpoint is unavailable. YouTube's internal data shapes change
// occasionally, so we defensively navigate both the rich-grid (channel page)
// and playlist-video-list (playlist page) structures.
function parseYouTubePageData(html) {
  const videos = [];
  const m = html.match(/var\s+ytInitialData\s*=\s*({[\s\S]*?});\s*<\/script>/);
  if (!m) return videos;

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return videos;
  }

  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  for (const tab of tabs) {
    const gridItems =
      tab?.tabRenderer?.content?.richGridRenderer?.contents || [];
    for (const it of gridItems) {
      const v = it?.richItemRenderer?.content?.videoRenderer;
      if (v?.videoId) {
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || "";
        if (title) {
          videos.push({
            title,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
          });
        }
      }
    }
    if (videos.length > 0) break;

    const playlistItems =
      tab?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer
        ?.contents || [];
    for (const it of playlistItems) {
      const v = it?.playlistVideoRenderer;
      if (v?.videoId) {
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || "";
        if (title) {
          videos.push({
            title,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
          });
        }
      }
    }
    if (videos.length > 0) break;
  }
  return videos;
}

// Fetches recent videos for a YouTube channel/playlist URL. Tries the Atom
// feed first, then scrapes the /videos page if the feed is unavailable.
async function fetchYouTubeVideos(channelUrl) {
  const feedUrl = await getYouTubeFeedUrl(channelUrl);
  if (feedUrl) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": RSS_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const videos = parseYouTubeFeed(await res.text());
        if (videos.length > 0) return videos;
      }
    } catch {
      // fall through to scraping
    }
  }

  if (!channelUrl || !channelUrl.includes("youtube.com")) return [];
  // Playlist URLs should not be mutated; channel URLs need /videos appended
  // so we hit the uploads grid rather than the channel home/shorts page.
  const videosPageUrl = channelUrl.includes("/playlist?")
    ? channelUrl
    : channelUrl.replace(/\/$/, "") + "/videos";
  try {
    const res = await fetch(videosPageUrl, {
      headers: {
        "User-Agent": RSS_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    return parseYouTubePageData(await res.text());
  } catch {
    return [];
  }
}

// Parses a YouTube Atom feed and returns { title, url } for each entry.
function parseYouTubeFeed(xml) {
  const videos = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const videoIdMatch = block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
    if (titleMatch && videoIdMatch) {
      videos.push({
        title: titleMatch[1].trim(),
        url: `https://www.youtube.com/watch?v=${videoIdMatch[1].trim()}`,
      });
    }
  }
  return videos;
}

// Lowercase, strip punctuation, collapse whitespace — so minor title
// differences between a podcast feed and its YouTube upload don't block a match.
function normalizeTitle(t) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Finds the YouTube video whose title best matches the podcast episode title.
// Uses substring match first, then token overlap (>=50% of episode's content
// words must appear in the video title). Returns null if no confident match.
async function findYouTubeEpisodeUrl(channelUrl, episodeTitle) {
  const videos = await fetchYouTubeVideos(channelUrl);
  if (videos.length === 0) return null;

  const needle = normalizeTitle(episodeTitle);
  const needleTokens = new Set(needle.split(" ").filter((w) => w.length > 2));
  if (needleTokens.size === 0) return null;

  let bestUrl = null;
  let bestScore = 0;
  for (const v of videos) {
    const hay = normalizeTitle(v.title);
    if (hay && (hay.includes(needle) || needle.includes(hay))) {
      return v.url;
    }
    const hayTokens = new Set(hay.split(" ").filter((w) => w.length > 2));
    let overlap = 0;
    for (const tok of needleTokens) if (hayTokens.has(tok)) overlap++;
    const score = overlap / needleTokens.size;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = v.url;
    }
  }
  return bestScore >= 0.5 ? bestUrl : null;
}

// Fetches a transcript from pod2txt. The API is async: first request may
// return "processing", so we poll until "ready" (up to 5 attempts, ~2.5 min).
async function fetchPod2txtTranscript(rssUrl, guid, apiKey) {
  const maxAttempts = 5;
  const pollInterval = 30000; // 30 seconds between polls

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${POD2TXT_BASE}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedurl: rssUrl, guid, apikey: apiKey }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${text}` };
    }

    const data = await res.json();

    if (data.status === "ready" && data.url) {
      // Transcript is ready — fetch the text from the provided URL
      const txtRes = await fetch(data.url);
      if (!txtRes.ok)
        return {
          error: `Failed to fetch transcript text: HTTP ${txtRes.status}`,
        };
      const transcript = await txtRes.text();
      return { transcript };
    }

    if (data.status === "processing") {
      console.error(
        `      pod2txt: processing (attempt ${attempt}/${maxAttempts}), waiting ${pollInterval / 1000}s...`,
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      continue;
    }

    // Unexpected status or error from the API
    return { error: data.message || `Unexpected status: ${data.status}` };
  }

  return { error: "Timed out waiting for transcript processing" };
}

// Main podcast fetching function. For each podcast:
// 1. Fetches the RSS feed to discover episodes
// 2. Filters by lookback window and dedup
// 3. Fetches transcript via pod2txt for the newest unseen episode
async function fetchPodcastContent(podcasts, apiKey, state, errors, options = {}) {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const fetchTranscriptImpl = options.fetchTranscriptImpl ?? fetchPod2txtTranscript;
  const findYouTubeImpl = options.findYouTubeImpl ?? findYouTubeEpisodeUrl;
  const statuses = options.statuses;
  const cutoff = new Date(now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const results = [];

  for (const podcast of podcasts) {
    const sourceErrors = [];
    let failedCandidateCount = 0;
    if (!podcast.rssUrl) {
      sourceErrors.push(rssDiagnostic(`Podcast: No rssUrl configured for ${podcast.name}`));
    } else {
      try {
        console.error(`  Fetching RSS for ${podcast.name}...`);
        const rssRes = await fetchImpl(podcast.rssUrl, {
          headers: {
            "User-Agent": RSS_USER_AGENT,
            Accept: "application/rss+xml, application/xml, text/xml, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
          signal: AbortSignal.timeout(30000),
        });
        if (!rssRes.ok) {
          sourceErrors.push(rssDiagnostic(`Podcast: Failed to fetch RSS for ${podcast.name}: HTTP ${rssRes.status}`));
        } else {
          const parsedEpisodes = parseRssFeed(await rssRes.text());
          if (parsedEpisodes[RSS_PARSE_FAILURE_COUNT] > 0) {
            failedCandidateCount += parsedEpisodes[RSS_PARSE_FAILURE_COUNT];
            sourceErrors.push(rssDiagnostic(`Podcast: ${podcast.name}: ${parsedEpisodes[RSS_PARSE_FAILURE_COUNT]} feed item(s) missing identity`));
          }
          const candidates = parsedEpisodes
            .slice(0, 3)
            .filter((episode) => !state.seenVideos[episode.guid])
            .filter((episode) => !episode.publishedAt || new Date(episode.publishedAt) >= cutoff)
            .sort((first, second) => Date.parse(second.publishedAt ?? 0) - Date.parse(first.publishedAt ?? 0));

          for (const episode of candidates) {
            const transcriptResult = await fetchTranscriptImpl(podcast.rssUrl, episode.guid, apiKey);
            if (transcriptResult.error || !transcriptResult.transcript) {
              failedCandidateCount += 1;
              sourceErrors.push(rssDiagnostic(transcriptResult.error
                ? `Podcast: Transcript error for ${podcast.name} "${episode.title}": ${transcriptResult.error}`
                : `Podcast: Empty transcript for ${podcast.name} "${episode.title}"`));
              continue;
            }

            let youtubeUrl = null;
            const warnings = [];
            try {
              youtubeUrl = await findYouTubeImpl(podcast.url, episode.title);
              if (!youtubeUrl) warnings.push(`${podcast.name}: exact episode URL unavailable; used channel fallback`);
            } catch (error) {
              warnings.push(`${podcast.name}: episode URL enrichment failed; used channel fallback: ${error.message}`);
            }
            results.push({
              source: "podcast",
              sourceId: podcast.id,
              name: podcast.name,
              title: episode.title,
              guid: episode.guid,
              url: youtubeUrl || podcast.url,
              publishedAt: episode.publishedAt,
              transcript: transcriptResult.transcript,
            });
            state.seenVideos[episode.guid] = now();
            statuses?.push(createSourceStatus({
              sourceId: podcast.id,
              channel: 'podcasts',
              sourceName: podcast.name,
              candidateCount: 1,
              failedCandidateCount,
              errors: sourceErrors,
              warnings,
            }));
            break;
          }
        }
      } catch (error) {
        sourceErrors.push(rssDiagnostic(`Podcast: Error processing ${podcast.name}: ${error.message}`));
      }
    }

    const produced = results.some(({ sourceId }) => sourceId === podcast.id);
    if (!produced) {
      statuses?.push(createSourceStatus({
        sourceId: podcast.id,
        channel: 'podcasts',
        sourceName: podcast.name,
        candidateCount: 0,
        failedCandidateCount,
        errors: sourceErrors,
        discoveryComplete: sourceErrors.length === 0 || failedCandidateCount > 0,
      }));
    }
    errors.push(...sourceErrors);
  }
  return results;
}

// -- X/Twitter Fetching (Official API v2) ------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchXWithRetry(url, options) {
  let lastResponse;
  for (let attempt = 1; attempt <= X_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, options);
      lastResponse = res;
      if (!X_RETRY_STATUSES.has(res.status) || attempt === X_RETRY_ATTEMPTS) {
        return res;
      }
    } catch (err) {
      if (attempt === X_RETRY_ATTEMPTS) throw err;
    }
    await sleep(1000 * attempt);
  }
  return lastResponse;
}

async function fetchXContent(xAccounts, bearerToken, state, errors, { now = Date.now } = {}) {
  const results = [];
  const cutoff = new Date(now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup user IDs. Smaller batches make one flaky X response less likely
  // to wipe out the whole feed.
  const handles = xAccounts.map((a) => a.handle);
  let userMap = {};

  for (let i = 0; i < handles.length; i += X_USER_LOOKUP_BATCH_SIZE) {
    const batch = handles.slice(i, i + X_USER_LOOKUP_BATCH_SIZE);
    try {
      const res = await fetchXWithRetry(
        `${X_API_BASE}/users/by?usernames=${batch.join(",")}&user.fields=name,description`,
        { headers: { Authorization: `Bearer ${bearerToken}` } },
      );

      if (!res.ok) {
        errors.push(
          `X API: User lookup failed for ${batch.join(",")}: HTTP ${res.status}`,
        );
        continue;
      }

      const data = await res.json();
      for (const user of data.data || []) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || "",
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error for ${batch.join(",")}: ${err.message}`);
    }
  }

  // Fetch recent tweets per user (max 3, exclude retweets/replies)
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetchXWithRetry(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
          `max_results=5` + // fetch 5, then filter to 3 new ones
          `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
          `&exclude=retweets,replies` +
          `&start_time=${cutoff.toISOString()}`,
        { headers: { Authorization: `Bearer ${bearerToken}` } },
      );

      if (!res.ok) {
        if (res.status === 429) {
          errors.push(`X API: Rate limited, skipping remaining accounts`);
          break;
        }
        errors.push(
          `X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`,
        );
        continue;
      }

      const data = await res.json();
      const allTweets = data.data || [];

      // Filter out already-seen tweets, cap at 3
      const newTweets = [];
      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue; // dedup
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          // note_tweet.text has the full untruncated text for long tweets (>280 chars)
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote:
            t.referenced_tweets?.some((r) => r.type === "quoted") || false,
          quotedTweetId:
            t.referenced_tweets?.find((r) => r.type === "quoted")?.id || null,
        });

        // Mark as seen
        state.seenTweets[t.id] = now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: "x",
        sourceId: account.id,
        name: account.name,
        handle: account.handle,
        bio: userData.description,
        tweets: newTweets,
      });

      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- Generic RSS Feed Fetcher (Newsletters, Academic, Chinese Tech) ----------

// Unified RSS-based feed fetching for newsletters, academic papers, and
// Chinese tech media. All three share the same pattern: RSS feed → parse
// items → filter by lookback → dedup → output.
//
// For academic feeds, an optional keyword filter is applied to surface only
// the most relevant papers (e.g. LLM, agent, reasoning).
async function fetchRssFeeds(
  sources,
  lookbackHours,
  maxPerSource,
  state,
  errors,
  filterKeywords,
  excludeKeywords,
  { fetchImpl = fetch, namespace = "rss", now = Date.now, channel = namespace, statuses } = {},
) {
  const results = [];
  const nowMs = now();
  const cutoff = new Date(nowMs - lookbackHours * 60 * 60 * 1000);

  for (const source of sources) {
    const sourceErrors = [];
    let failedCandidateCount = 0;
    if (!source.rss) {
      console.error(`  ${source.name}: No RSS URL configured, skipping`);
      sourceErrors.push(rssDiagnostic(`RSS: ${source.name}: No RSS URL configured`));
      errors.push(...sourceErrors);
      statuses?.push(createSourceStatus({
        sourceId: source.id, channel, sourceName: source.name,
        errors: sourceErrors, discoveryComplete: false,
      }));
      continue;
    }

    try {
      console.error(`  Fetching RSS for ${source.name}...`);
      const res = await fetchImpl(source.rss, {
        headers: {
          "User-Agent": RSS_USER_AGENT,
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        sourceErrors.push(rssDiagnostic(`RSS: Failed to fetch ${source.name}: HTTP ${res.status}`));
        console.error(`  ${source.name}: HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}`);
      }

      const xml = await res.text();
      let items;
      try {
        items = parseRssFeed(xml);
      } catch (error) {
        throw new Error(`Invalid feed for ${source.name}: ${error.message}`);
      }
      if (items[RSS_PARSE_FAILURE_COUNT] > 0) {
        failedCandidateCount += items[RSS_PARSE_FAILURE_COUNT];
        sourceErrors.push(rssDiagnostic(`RSS: ${source.name}: ${items[RSS_PARSE_FAILURE_COUNT]} feed item(s) missing identity`));
      }
      console.error(`  ${source.name}: ${items.length} items in feed`);

      // Filter by lookback, dedup, and optional keywords
      const newItems = [];
      for (const item of items) {
        // Dedup: use guid as key, fall back to item link
        const legacyKey = item.guid || item.link;
        if (!legacyKey) {
          failedCandidateCount += 1;
          sourceErrors.push(rssDiagnostic(`RSS: ${source.name}: candidate is missing guid and link`));
          continue;
        }
        const dedupKey = `${namespace}:${source.rss}:${legacyKey}`;
        if (state.seenArticles[dedupKey] || state.seenArticles[legacyKey]) {
          console.error(`    Skipping "${item.title}" (already seen)`);
          continue;
        }
        if (item.publishedAt && new Date(item.publishedAt) < cutoff) {
          console.error(`    Skipping "${item.title}" (outside lookback window)`);
          continue;
        }

        // Optional keyword filter for academic papers
        if (filterKeywords && filterKeywords.length > 0) {
          const title = (item.title || "").toLowerCase();
          const hasKeyword = filterKeywords.some((kw) =>
            title.includes(kw.toLowerCase())
          );
          if (!hasKeyword) {
            console.error(`    Skipping "${item.title}" (no keyword match)`);
            continue;
          }
        }
        if (excludeKeywords && excludeKeywords.length > 0) {
          const title = (item.title || "").toLowerCase();
          const hasExclude = excludeKeywords.some((kw) =>
            title.includes(kw.toLowerCase())
          );
          if (hasExclude) {
            console.error(`    Skipping "${item.title}" (excluded keyword match)`);
            continue;
          }
        }

        newItems.push({
          sourceId: source.id,
          title: item.title || "Untitled",
          url: item.link || source.url,
          publishedAt: item.publishedAt || null,
          guid: item.guid || item.link,
          source: source.name,
          language: source.language || "en",
        });

        state.seenArticles[dedupKey] = nowMs;

        if (newItems.length >= maxPerSource) break;
      }

      if (newItems.length > 0) {
        results.push({
          sourceId: source.id,
          source: source.name,
          url: source.url,
          tags: source.tags || [],
          items: newItems,
        });
        console.error(`  ${source.name}: ${newItems.length} new items`);
      }
      errors.push(...sourceErrors);
      statuses?.push(createSourceStatus({
        sourceId: source.id, channel, sourceName: source.name,
        candidateCount: newItems.length, failedCandidateCount, errors: sourceErrors,
      }));
    } catch (err) {
      if (!sourceErrors.some((error) => error.includes(err.message))) {
        sourceErrors.push(rssDiagnostic(`RSS: Error fetching ${source.name}: ${err.message}`));
      }
      errors.push(...sourceErrors);
      statuses?.push(createSourceStatus({
        sourceId: source.id, channel, sourceName: source.name,
        candidateCount: 0, failedCandidateCount,
        errors: sourceErrors, discoveryComplete: false,
      }));
      console.error(`  ${source.name}: ${rssDiagnostic(err.message)}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

const CHANNEL_FILES = {
  x: "feed-x.json",
  podcasts: "feed-podcasts.json",
  blogs: "feed-blogs.json",
  newsletters: "feed-newsletters.json",
  academic: "feed-academic.json",
  "zh-tech": "feed-zh-tech.json",
};

const CHANNEL_PAYLOADS = {
  x: "x",
  podcasts: "podcasts",
  blogs: "blogs",
  newsletters: "newsletters",
  academic: "papers",
  "zh-tech": "articles",
};

function sourceRegistryFromSources(sources) {
  return [
    ...(sources.x_accounts ?? []).map((source) => ({ ...source, channel: "x" })),
    ...(sources.podcasts ?? []).map((source) => ({ ...source, channel: "podcasts" })),
    ...(sources.blogs ?? []).map((source) => ({ ...source, channel: "blogs" })),
    ...(sources.newsletters ?? []).map((source) => ({ ...source, channel: "newsletters" })),
    ...(sources.academic?.sources ?? []).map((source) => ({ ...source, channel: "academic" })),
    ...(sources.zhTech ?? []).map((source) => ({ ...source, channel: "zh-tech" })),
  ];
}

function sourceCandidateCount(feed, source) {
  const payload = feed?.[CHANNEL_PAYLOADS[source.channel]] ?? [];
  if (source.channel === "x") {
    return payload.filter((group) => group.sourceId === source.id || group.handle === source.handle)
      .reduce((sum, group) => sum + (group.tweets?.length ?? 0), 0);
  }
  if (source.channel === "podcasts" || source.channel === "blogs") {
    return payload.filter((item) => item.sourceId === source.id || item.name === source.name).length;
  }
  return payload.filter((group) => group.sourceId === source.id
    || group.url === source.url || group.url === source.rss)
    .reduce((sum, group) => sum + (group.items?.length ?? 0), 0);
}

function sourceErrors(errors, source) {
  const identities = [source.id, source.name, source.rss, source.rssUrl]
    .filter(Boolean).map(String);
  return errors.filter((error) => identities.some((identity) => error.includes(identity))
    || (source.handle && error.startsWith('X API') && (error.includes(`@${source.handle}`)
      || new RegExp(`(?:^|[, ])${source.handle}(?:[, :]|$)`, 'i').test(error)))
    || (source.channel === 'x' && error.includes('Rate limited')));
}

function buildStatuses(registry, feeds, errors, structuredStatuses = []) {
  const expectedIds = new Set(registry.map(({ id }) => id));
  const explicitIds = structuredStatuses.map(({ sourceId }) => sourceId);
  if (new Set(explicitIds).size !== explicitIds.length) {
    throw new Error('Structured source statuses contain duplicate source IDs');
  }
  const unknown = explicitIds.find((sourceId) => !expectedIds.has(sourceId));
  if (unknown) throw new Error(`Structured source status references unknown source ${unknown}`);
  const explicit = new Map(structuredStatuses.map((status) => [status.sourceId, status]));
  return registry.map((source) => explicit.get(source.id) ?? createSourceStatus({
    sourceId: source.id,
    channel: source.channel,
    sourceName: source.name,
    candidateCount: sourceCandidateCount(feeds[source.channel], source),
    errors: sourceErrors(errors, source),
  }));
}

async function readState(path, fsImpl) {
  try {
    const state = JSON.parse(await fsImpl.readFile(path, "utf8"));
    return {
      seenTweets: state.seenTweets ?? {},
      seenVideos: state.seenVideos ?? {},
      seenArticles: state.seenArticles ?? {},
    };
  } catch {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  }
}

function validState(state) {
  return state && typeof state === 'object' && !Array.isArray(state)
    && state.seenTweets && typeof state.seenTweets === 'object' && !Array.isArray(state.seenTweets)
    && state.seenVideos && typeof state.seenVideos === 'object' && !Array.isArray(state.seenVideos)
    && state.seenArticles && typeof state.seenArticles === 'object' && !Array.isArray(state.seenArticles);
}

async function validateStagedDocuments({ targets }, { channels, registry, fsImpl, full }) {
  const byFilename = new Map(targets.map(({ target, stagedPath }) => [basename(target), stagedPath]));
  if (full) {
    const errors = await validateFeedFiles({
      readJson: async (filename) => JSON.parse(await fsImpl.readFile(byFilename.get(filename), 'utf8')),
      expectedRegistry: registry,
    });
    if (errors.length > 0) throw new Error(`Staged Feed validation failed: ${errors.join('; ')}`);
    const state = JSON.parse(await fsImpl.readFile(byFilename.get('state-feed.json'), 'utf8'));
    if (!validState(state)) throw new Error('Staged state-feed.json is invalid');
    return;
  }
  for (const channel of channels) {
    const filename = CHANNEL_FILES[channel];
    const feed = JSON.parse(await fsImpl.readFile(byFilename.get(filename), 'utf8'));
    const result = validateFeed(feed, channel);
    if (!result.valid) throw new Error(`${filename}: ${result.errors.join('; ')}`);
  }
}

async function collectAll({ channels, sources, state, fetchImpl, now, env, stderr }) {
  const errors = [];
  const feeds = {};
  const structuredStatuses = [];
  const generatedAt = new Date(now()).toISOString();

  if (channels.includes("x")) {
    stderr("Fetching X/Twitter content...");
    const content = await fetchXContent(sources.x_accounts ?? [], env.X_BEARER_TOKEN, state, errors, { now });
    feeds.x = createFeedEnvelope({ generatedAt, lookbackHours: TWEET_LOOKBACK_HOURS, x: content,
      stats: { xBuilders: content.length, totalTweets: content.reduce((sum, group) => sum + group.tweets.length, 0) },
      errors: errors.filter((error) => error.startsWith("X API")).length ? errors.filter((error) => error.startsWith("X API")) : undefined });
  }
  if (channels.includes("podcasts")) {
    stderr("Fetching podcast content (RSS + pod2txt)...");
    const content = await fetchPodcastContent(sources.podcasts ?? [], env.POD2TXT_API_KEY, state, errors, {
      now, fetchImpl, statuses: structuredStatuses,
    });
    feeds.podcasts = createFeedEnvelope({ generatedAt, lookbackHours: PODCAST_LOOKBACK_HOURS, podcasts: content,
      stats: { podcastEpisodes: content.length },
      errors: errors.filter((error) => error.startsWith("Podcast")).length ? errors.filter((error) => error.startsWith("Podcast")) : undefined });
  }
  if (channels.includes("blogs")) {
    stderr("Fetching blog content...");
    const content = await fetchBlogContent(sources.blogs ?? [], state, errors, {
      fetchImpl, now, statuses: structuredStatuses,
    });
    feeds.blogs = createFeedEnvelope({ generatedAt, lookbackHours: BLOG_LOOKBACK_HOURS, blogs: content,
      stats: { blogPosts: content.length },
      errors: errors.filter((error) => error.startsWith("Blog")).length ? errors.filter((error) => error.startsWith("Blog")) : undefined });
  }
  for (const [channel, configuredSources, lookbackHours, maxPerSource] of [
    ["newsletters", sources.newsletters ?? [], NEWSLETTER_LOOKBACK_HOURS, MAX_NEWSLETTERS_PER_SOURCE],
    ["academic", sources.academic?.sources ?? [], ACADEMIC_LOOKBACK_HOURS, MAX_PAPERS_PER_SOURCE],
    ["zh-tech", sources.zhTech ?? [], ZH_TECH_LOOKBACK_HOURS, MAX_ZH_ARTICLES_PER_SOURCE],
  ]) {
    if (!channels.includes(channel)) continue;
    const errorStart = errors.length;
    const content = await fetchRssFeeds(configuredSources, lookbackHours, maxPerSource, state, errors,
      channel === "academic" ? sources.academic?.filters?.minKeywords ?? [] : undefined,
      channel === "academic" ? sources.academic?.filters?.excludeKeywords ?? [] : undefined,
      { fetchImpl, namespace: channel, now, channel, statuses: structuredStatuses });
    feeds[channel] = createFeedEnvelope({ generatedAt, lookbackHours,
      [CHANNEL_PAYLOADS[channel]]: content, stats: { sources: content.length },
      errors: errorsSince(errors, errorStart).length ? errorsSince(errors, errorStart) : undefined });
  }
  return { feeds, state, errors, structuredStatuses };
}

async function runGeneration(options = {}) {
  const processImpl = options.processImpl ?? process;
  const args = options.args ?? processImpl.argv.slice(2);
  const env = options.env ?? processImpl.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const loadSourcesImpl = options.loadSourcesImpl ?? loadSources;
  const fsImpl = options.fsImpl ?? { readFile, writeFile, rename, unlink };
  const rootDir = options.rootDir ?? join(SCRIPT_DIR, "..");
  const collectAllImpl = options.collectAllImpl ?? collectAll;
  const shadow = args.includes("--shadow");
  const blogSourceId = args.find((arg) => arg.startsWith("--blog-source="))?.slice("--blog-source=".length);
  const tweetsOnly = args.includes("--tweets-only");
  const podcastsOnly = args.includes("--podcasts-only");
  const blogsOnly = args.includes("--blogs-only");
  const newslettersOnly = args.includes("--newsletters-only");
  const academicOnly = args.includes("--academic-only");
  const zhTechOnly = args.includes("--zh-tech-only");
  const initialize = args.includes("--initialize-candidate-feed");

  // If a specific --*-only flag is set, only that feed type runs.
  // If no flag is set, all feed types run.
  const anyOnly = tweetsOnly || podcastsOnly || blogsOnly || newslettersOnly || academicOnly || zhTechOnly || Boolean(blogSourceId);
  const runTweets = tweetsOnly || !anyOnly;
  const runPodcasts = podcastsOnly || !anyOnly;
  const runBlogs = blogsOnly || Boolean(blogSourceId) || !anyOnly;
  const runNewsletters = newslettersOnly || !anyOnly;
  const runAcademic = academicOnly || !anyOnly;
  const runZhTech = zhTechOnly || !anyOnly;

  if (anyOnly && initialize) {
    throw new Error("--initialize-candidate-feed requires a complete generation");
  }

  let sources = await loadSourcesImpl();

  if (shadow) {
    const selectedBlogs = blogSourceId
      ? (sources.blogs ?? []).filter(({ id }) => id === blogSourceId)
      : sources.blogs ?? [];
    if (blogSourceId && selectedBlogs.length === 0) {
      throw new Error(`Unknown blog source: ${blogSourceId}`);
    }
    const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
    const errors = [];
    for (const blog of selectedBlogs) stderr(`Processing blog: ${blog.name}`);
    const blogs = await fetchBlogContent(selectedBlogs, state, errors, {
      fetchImpl,
      now,
      shadow: true,
    });
    const envelope = createFeedEnvelope({
      generatedAt: new Date(now()).toISOString(),
      lookbackHours: BLOG_LOOKBACK_HOURS,
      blogs,
      stats: { blogPosts: blogs.length },
      errors: errors.length > 0 ? errors : undefined,
    });
    const serialized = JSON.stringify(envelope, null, 2);
    stdout(serialized);
    return JSON.parse(serialized);
  }

  if (blogSourceId) {
    const selected = (sources.blogs ?? []).filter(({ id }) => id === blogSourceId);
    if (selected.length === 0 && options.collectAllImpl === undefined) throw new Error(`Unknown blog source: ${blogSourceId}`);
    sources = { ...sources, blogs: selected };
  }

  const channels = [
    ...(runTweets ? ["x"] : []), ...(runPodcasts ? ["podcasts"] : []),
    ...(runBlogs ? ["blogs"] : []), ...(runNewsletters ? ["newsletters"] : []),
    ...(runAcademic ? ["academic"] : []), ...(runZhTech ? ["zh-tech"] : []),
  ];
  const registry = sourceRegistryFromSources(sources);
  const candidatePath = join(rootDir, CANDIDATE_FEED_FILE);
  let previousCandidateFeed;
  let initializationFeeds;
  if (!anyOnly) {
    if (initialize) {
      try {
        await fsImpl.readFile(candidatePath, "utf8");
        throw new Error("Candidate Feed already exists; initialization refuses to overwrite it");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      initializationFeeds = {};
      for (const channel of Object.keys(CHANNEL_FILES)) {
        const filename = CHANNEL_FILES[channel];
        let feed;
        try {
          feed = JSON.parse(await fsImpl.readFile(join(rootDir, filename), "utf8"));
        } catch (error) {
          throw new Error(`${filename}: cannot initialize from the current Feed: ${error.message}`, { cause: error });
        }
        const validation = validateFeed(feed, channel);
        if (!validation.valid) throw new Error(`${filename}: ${validation.errors.join('; ')}`);
        initializationFeeds[channel] = feed;
      }
    } else {
      previousCandidateFeed = await loadCandidateFeed({ path: candidatePath, readFileImpl: fsImpl.readFile, registry });
    }
  }

  if (runPodcasts && !env.POD2TXT_API_KEY) throw new Error("POD2TXT_API_KEY not set");
  if (runTweets && !env.X_BEARER_TOKEN) throw new Error("X_BEARER_TOKEN not set");

  const state = await readState(join(rootDir, "state-feed.json"), fsImpl);
  const collectionStartMs = now();
  const collectionStart = new Date(collectionStartMs).toISOString();
  const collected = await collectAllImpl({ channels, sources, state, fetchImpl, now, env, stderr });
  const feeds = collected.feeds ?? {};
  const documents = channels.map((channel) => [join(rootDir, CHANNEL_FILES[channel]), feeds[channel]]);

  if (!anyOnly) {
    const statuses = collected.statuses ?? buildStatuses(
      registry, feeds, collected.errors ?? [], collected.structuredStatuses ?? [],
    );
    const currentCandidates = collected.candidates ?? normalizeLegacyFeeds(feeds, {
      registry, seenAt: collectionStart,
    });
    const candidateFeed = initialize
      ? initializeCandidateFeed({ feeds: initializationFeeds, currentCandidates, statuses, registry, collectionStart })
      : mergeCandidateFeed(previousCandidateFeed, { currentCandidates, statuses, registry, collectionStart });
    documents.push([candidatePath, candidateFeed]);
    documents.push([join(rootDir, "state-feed.json"), pruneState(collected.state ?? state, collectionStartMs)]);
  }
  // Multi-file publication is a lock-protected, journaled transaction. Recovery
  // restores the prior generation after interruption; it is not a single rename.
  const publishTransactionImpl = options.publishTransactionImpl ?? publishFeedTransaction;
  const publicationOptions = {
    rootDir,
    documents,
    transactionId: `${collectionStartMs}-${processImpl.pid ?? 'process'}`,
    validateStaged: (context) => validateStagedDocuments(context, {
      documents, channels, registry, fsImpl, full: !anyOnly,
    }),
  };
  if (options.fsImpl) publicationOptions.fsImpl = fsImpl;
  await publishTransactionImpl(publicationOptions);
  return Object.fromEntries(documents.map(([path, document]) => [path, document]));
}

async function main(options = {}) {
  const rootDir = options.rootDir ?? join(SCRIPT_DIR, "..");
  const fsImpl = options.fsImpl ?? { readFile, writeFile, rename, unlink };
  const withLockImpl = options.withPublicationLockImpl
    ?? (options.fsImpl ? async (_root, operation) => operation() : withFeedPublicationLock);
  const recoverImpl = options.recoverPublicationImpl ?? recoverFeedPublication;
  return withLockImpl(rootDir, async () => {
    await recoverImpl(rootDir, options.fsImpl ? { fsImpl } : undefined);
    try {
      return await runGeneration({ ...options, rootDir });
    } catch (error) {
      try {
        await recoverImpl(rootDir, options.fsImpl ? { fsImpl } : undefined);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `Feed generation failed and crash recovery remains pending: ${recoveryError.message}`,
        );
      }
      throw error;
    }
  });
}

export {
  errorsSince,
  fetchPodcastContent,
  fetchRssFeeds,
  buildStatuses,
  collectAll,
  loadSources,
  main,
  normalizePublishedAt,
  parseRssFeed,
  pruneState,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Feed generation failed:", err.message);
    process.exitCode = 1;
  });
}
