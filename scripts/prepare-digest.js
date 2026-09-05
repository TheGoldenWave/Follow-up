#!/usr/bin/env node

import { randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateCandidateFeed } from './candidate-feed-contract.js';
import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import { normalizeConfig } from './config-contract.js';
import { readDeliveryLedger } from './delivery-ledger.js';
import { resolveDigestCandidates } from './digest-candidates.js';
import {
  CURATION_SUMMARY_CHARACTER_LIMIT,
  DIGEST_CURATION_REQUEST_SCHEMA_VERSION,
  validateCurationRequest,
} from './digest-selection-contract.js';
import { resolveRuntimePaths } from './lib/paths.js';
import { loadSourceRegistry } from './source-registry.js';
import { readJsonLimited } from './validate-digest-selection.js';
import { validateFeed } from './feed-contract.js';

const USER_DIR = join(homedir(), '.follow-builders');
const CENTRAL_FEED_BASE = 'https://raw.githubusercontent.com/TheGoldenWave/Follow-up/main';
export const CENTRAL_CANDIDATE_FEED_URL = `${CENTRAL_FEED_BASE}/feed-candidates.json`;
export const CANDIDATE_FEED_STALE_AFTER_MS = 48 * 60 * 60 * 1000;
export const PREPARE_INPUT_LIMITS = Object.freeze({ configBytes: 256 * 1024 });
export const SELECTION_RULES = Object.freeze({
  qualificationThreshold: 60,
  maxSelected: 10,
  maxLeadsPerSource: 2,
  channelPositionLimit: 4,
  channelLimitAppliesAtQualifyingChannelCount: 3,
  ordering: 'totalScore-desc,evidence-desc,publishedAt-desc,candidateId-asc',
  sourceDiversityFirst: true,
});

const PROMPT_FILES = [
  'summarize-podcast.md', 'summarize-tweets.md', 'summarize-blogs.md',
  'summarize-newsletter.md', 'summarize-paper.md', 'summarize-zh-sources.md',
  'digest-intro.md', 'translate.md',
];

class SafeOutputError extends Error {}

export async function fetchJSON(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return null;
  return response.json();
}

// Kept for v0.1 callers. The v0.2 prepare workflow never calls this helper.
export const CENTRAL_FEEDS = [
  ['x', 'Tweet', 'feed-x.json', 'x', 'x'],
  ['podcasts', 'Podcast', 'feed-podcasts.json', 'podcasts', 'podcasts'],
  ['blogs', 'Blog', 'feed-blogs.json', 'blogs', 'blogs'],
  ['newsletters', 'Newsletter', 'feed-newsletters.json', 'newsletters', 'newsletters'],
  ['academic', 'Academic', 'feed-academic.json', 'papers', 'academic'],
  ['zh-tech', 'Chinese technology', 'feed-zh-tech.json', 'articles', 'zhTech'],
].map(([category, label, filename, payloadKey, outputKey]) => ({
  category, label, filename, payloadKey, outputKey, url: `${CENTRAL_FEED_BASE}/${filename}`,
}));

export async function loadCentralFeedData({ fetchJson = fetchJSON } = {}) {
  const data = Object.fromEntries(CENTRAL_FEEDS.map(({ outputKey }) => [outputKey, []]));
  const feeds = {};
  const errors = [];
  await Promise.all(CENTRAL_FEEDS.map(async (spec) => {
    try {
      const feed = await fetchJson(spec.url);
      if (!feed) errors.push(`Could not fetch ${spec.label.toLowerCase()} feed`);
      else {
        const validation = validateFeed(feed, spec.category);
        if (!validation.valid) {
          errors.push(`${spec.label} feed is invalid (${validation.errors.join('; ')}); expected compatible schema 1.x. Update Follow-up before retrying.`);
        } else {
          feeds[spec.category] = feed;
          data[spec.outputKey] = feed[spec.payloadKey];
          if (feed.errors?.length) {
            errors.push(...feed.errors.map((error) => `${spec.label} feed problem: ${error}`));
          }
        }
      }
    } catch {
      errors.push(`Could not fetch ${spec.label.toLowerCase()} feed`);
    }
  }));
  return { data, feeds, errors };
}

export function resolveInstalledPromptsDir(moduleUrl = import.meta.url) {
  return fileURLToPath(new URL('../prompts/', moduleUrl));
}

async function readPrompt(path, fsImpl = systemFs) {
  try {
    return { content: await fsImpl.readFile(path, 'utf8') };
  } catch (error) {
    return { error };
  }
}

export async function loadPrompts({
  userPromptsDir = join(USER_DIR, 'prompts'),
  localPromptsDir = resolveInstalledPromptsDir(),
  promptFiles = PROMPT_FILES,
  fsImpl = systemFs,
} = {}) {
  const prompts = {};
  const errors = [];
  for (const filename of promptFiles) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPrompt = await readPrompt(join(userPromptsDir, filename), fsImpl);
    if (userPrompt.content !== undefined) {
      prompts[key] = userPrompt.content;
      continue;
    }
    if (userPrompt.error?.code !== 'ENOENT') {
      errors.push(`Could not read custom prompt ~/.follow-builders/prompts/${filename}; trying installed prompt prompts/${filename} instead.`);
    }
    const localPrompt = await readPrompt(join(localPromptsDir, filename), fsImpl);
    if (localPrompt.content !== undefined) prompts[key] = localPrompt.content;
    else if (localPrompt.error?.code === 'ENOENT') {
      errors.push(`Could not load prompt ${filename}. Add a custom prompt at ~/.follow-builders/prompts/${filename} or reinstall Follow-up to restore prompts/${filename}.`);
    } else {
      errors.push(`Could not read installed prompt prompts/${filename}. Reinstall Follow-up or add a custom prompt at ~/.follow-builders/prompts/${filename}.`);
    }
  }
  return { prompts, errors };
}

export async function loadCurationPrompt(options = {}) {
  const result = await loadPrompts({ ...options, promptFiles: ['curate-digest.md'] });
  if (!result.prompts.curate_digest) throw new Error('curation prompt is unavailable');
  return result.prompts.curate_digest;
}

function expectedRegistry(registry) {
  return registry.map(({ id, sourceId, channel }) => ({ id: id ?? sourceId, channel }));
}

function boundedCandidates(candidates) {
  return candidates.map((candidate) => {
    const characters = Array.from(candidate.summarizationContent);
    if (characters.length <= CURATION_SUMMARY_CHARACTER_LIMIT) return { ...candidate };
    return {
      ...candidate,
      summarizationContent: characters.slice(0, CURATION_SUMMARY_CHARACTER_LIMIT).join(''),
      contentTruncated: true,
    };
  });
}

function sourceCompleteness(sourceStatuses, expectedCount, feed, now) {
  const generatedAt = Date.parse(feed.generatedAt);
  const stale = !Number.isFinite(generatedAt)
    || Date.parse(now) - generatedAt > CANDIDATE_FEED_STALE_AFTER_MS;
  const sourcesComplete = sourceStatuses.length === expectedCount
    && sourceStatuses.every(({ status }) => status === 'ok' || status === 'no-results');
  const complete = !stale && sourcesComplete;
  return {
    status: complete ? 'complete' : 'incomplete',
    complete,
    expectedSourceCount: expectedCount,
    reportedSourceCount: sourceStatuses.length,
  };
}

async function rejectSymlink(path, fsImpl, allowMissing) {
  try {
    if ((await fsImpl.lstat(path)).isSymbolicLink()) throw new SafeOutputError();
  } catch (error) {
    if (error instanceof SafeOutputError) throw error;
    if (allowMissing && error?.code === 'ENOENT') return;
    throw error;
  }
}

async function closeQuietly(handle) {
  try { await handle?.close(); } catch { /* Preserve the primary failure. */ }
}

export async function writeJsonAtomic(path, document, {
  fsImpl = systemFs,
  randomUUID = systemRandomUUID,
  label = 'output',
} = {}) {
  const requestedTarget = resolve(path);
  const parent = dirname(requestedTarget);
  const token = randomUUID();
  if (typeof token !== 'string' || !/^[a-z0-9-]+$/iu.test(token)) {
    throw new Error(`${label} could not be written`);
  }
  let temporary;
  let handle;
  let parentHandle;
  let temporaryOwned = false;
  try {
    await rejectSymlink(parent, fsImpl, true);
    await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
    await rejectSymlink(parent, fsImpl, false);
    const canonicalParent = await fsImpl.realpath(parent);
    const target = join(canonicalParent, basename(requestedTarget));
    temporary = `${target}.tmp-${token}`;
    await rejectSymlink(target, fsImpl, true);
    handle = await fsImpl.open(temporary, 'wx', 0o600);
    temporaryOwned = true;
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rejectSymlink(parent, fsImpl, false);
    await rejectSymlink(target, fsImpl, true);
    await fsImpl.rename(temporary, target);
    parentHandle = await fsImpl.open(parent, 'r');
    await parentHandle.sync();
    await parentHandle.close();
    parentHandle = undefined;
  } catch (error) {
    await closeQuietly(handle);
    await closeQuietly(parentHandle);
    if (temporaryOwned) await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw new Error(`${label} could not be written`, { cause: error });
  }
}

export async function prepareDigest({
  config,
  frequency = config?.frequency ?? 'daily',
  scheduled = false,
  authorizeScheduled = async () => true,
  now = new Date().toISOString(),
  registry,
  deliveryEvents = [],
  loadCandidateFeed,
  loadCurationPrompt: loadPrompt = loadCurationPrompt,
  randomUUID = systemRandomUUID,
} = {}) {
  const normalizedConfig = normalizeConfig(config ?? {});
  if (scheduled && !await authorizeScheduled({ config: normalizedConfig, frequency })) {
    throw new Error('scheduled run is not authorized');
  }
  if (normalizedConfig.enabledChannels.length === 0) {
    return { status: 'no-channels', message: '未启用任何内容渠道。' };
  }
  if (!['daily', 'weekly'].includes(frequency)) throw new TypeError('frequency must be daily or weekly');
  if (!Array.isArray(registry)) throw new TypeError('source registry is unavailable');
  if (typeof loadCandidateFeed !== 'function') throw new TypeError('candidate Feed loader is unavailable');

  const feed = await loadCandidateFeed();
  const feedValidation = validateCandidateFeed(feed, { expectedRegistry: expectedRegistry(registry) });
  if (!feedValidation.valid) throw new Error('candidate Feed is invalid');
  const resolved = await resolveDigestCandidates({
    config: normalizedConfig, frequency, now, deliveryEvents, loadCandidateFeed: async () => feed,
  });
  const enabledRegistry = registry.filter(({ channel }) => normalizedConfig.enabledChannels.includes(channel));
  const request = {
    schemaVersion: DIGEST_CURATION_REQUEST_SCHEMA_VERSION,
    digestId: randomUUID(),
    frequency,
    coverage: resolved.coverage,
    eligibleCandidates: boundedCandidates(resolved.eligibleCandidates),
    ...(Array.isArray(normalizedConfig.interests) && normalizedConfig.interests.length > 0
      ? { interests: [...normalizedConfig.interests] } : {}),
    sourceStatuses: resolved.sourceStatuses.map((status) => ({ ...status })),
    sourceCompleteness: sourceCompleteness(
      resolved.sourceStatuses, enabledRegistry.length, feed, now,
    ),
    selectionRules: { ...SELECTION_RULES },
    generatedAt: now,
  };
  const validation = validateCurationRequest(request);
  if (!validation.valid) throw new Error('curation request is invalid');
  const prompt = await loadPrompt();
  return {
    status: 'request-ready',
    contextStatus: !request.coverage.complete
      ? 'incomplete-history'
      : request.sourceCompleteness.complete ? 'complete' : 'partial',
    request,
    prompt,
    excluded: resolved.excluded,
  };
}

function parseOptions(argv) {
  return parseCommandLine(argv, {
    options: {
      'request-out': { type: 'string' },
      frequency: { type: 'string' },
      scheduled: { type: 'boolean' },
    },
    validate({ values, positionals }) {
      if (positionals.length) throw new CommandLineUsageError('unexpected positional arguments');
      if (!values['request-out']) throw new CommandLineUsageError('--request-out is required');
      if (!isAbsolute(values['request-out'])) throw new CommandLineUsageError('--request-out must be absolute');
      if (values.frequency && !['daily', 'weekly'].includes(values.frequency)) {
        throw new CommandLineUsageError('--frequency must be daily or weekly');
      }
    },
  }).values;
}

export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  fsImpl = systemFs,
  paths = {},
  config,
  registry,
  deliveryEvents,
  loadCandidateFeed: injectedFeedLoader,
  loadCurationPrompt: injectedPromptLoader,
  fetchJson = fetchJSON,
  now = new Date().toISOString(),
  randomUUID = systemRandomUUID,
  authorizeScheduled,
} = {}) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return error.exitCode ?? EX_USAGE;
  }
  try {
    const runtimePaths = resolveRuntimePaths(paths);
    const loadedConfig = config ?? await readJsonLimited(
      paths.configPath ?? join(runtimePaths.userDir, 'config.json'),
      'config', PREPARE_INPUT_LIMITS.configBytes, fsImpl,
    );
    const normalized = normalizeConfig(loadedConfig);
    if (normalized.enabledChannels.length === 0) {
      const result = await prepareDigest({
        config: loadedConfig,
        frequency: options.frequency ?? loadedConfig.frequency ?? 'daily',
        scheduled: options.scheduled ?? false,
        authorizeScheduled,
      });
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    const loadedRegistry = registry ?? await loadSourceRegistry({ readFileImpl: fsImpl.readFile.bind(fsImpl) });
    const events = deliveryEvents ?? await readDeliveryLedger({ ...paths, ledgerPath: paths.ledgerPath });
    const loadFeed = injectedFeedLoader ?? (paths.candidateFeedPath
      ? async () => readJsonLimited(
        paths.candidateFeedPath, 'candidate Feed', 128 * 1024 * 1024, fsImpl,
      )
      : async () => {
        const value = await fetchJson(CENTRAL_CANDIDATE_FEED_URL);
        if (!value) throw new Error('candidate Feed is unavailable');
        return value;
      });
    const prepared = await prepareDigest({
      config: loadedConfig,
      frequency: options.frequency ?? loadedConfig.frequency ?? 'daily',
      scheduled: options.scheduled ?? false,
      authorizeScheduled,
      now,
      registry: loadedRegistry,
      deliveryEvents: events,
      loadCandidateFeed: loadFeed,
      loadCurationPrompt: injectedPromptLoader,
      randomUUID,
    });
    await writeJsonAtomic(options['request-out'], prepared.request, {
      fsImpl, randomUUID, label: 'request output',
    });
    stdout.write(`${JSON.stringify({
      status: prepared.status,
      contextStatus: prepared.contextStatus,
      digestId: prepared.request.digestId,
      requestPath: options['request-out'],
      prompt: prepared.prompt,
      excluded: prepared.excluded,
    })}\n`);
    return 0;
  } catch (error) {
    const message = error.message === 'request output could not be written'
      ? error.message : 'digest preparation failed';
    stderr.write(`preparation-failed: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
