import { readFile } from 'node:fs/promises';

import { createCandidateFeed, validateCandidateFeed } from './candidate-feed-contract.js';
import { normalizeLegacyFeeds } from './candidate-normalization.js';
import { CENTRAL_FEED_FILES, validateFeed } from './feed-contract.js';

export const CANDIDATE_FEED_FILE = 'feed-candidates.json';
export const CANDIDATE_RETENTION = Object.freeze({
  defaultDays: 15,
  podcastDays: 30,
  minimumPerSource: 50,
  maxCandidates: 1000,
});

const DAY_MS = 24 * 60 * 60 * 1000;

function expectedRegistry(registry) {
  return registry.map(({ id, sourceId, channel }) => ({ id: id ?? sourceId, channel }));
}

function retentionTimestamp(candidate) {
  return Date.parse(candidate.publishedAt ?? candidate.firstSeenAt);
}

function utcRetentionCutoff(collectionStart, days) {
  const date = new Date(collectionStart);
  const utcDayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return utcDayStart - days * DAY_MS;
}

function compareNewest(first, second) {
  const firstPublished = first.publishedAt ? Date.parse(first.publishedAt) : Number.NEGATIVE_INFINITY;
  const secondPublished = second.publishedAt ? Date.parse(second.publishedAt) : Number.NEGATIVE_INFINITY;
  return secondPublished - firstPublished
    || Date.parse(second.firstSeenAt) - Date.parse(first.firstSeenAt)
    || (first.candidateId < second.candidateId ? -1 : first.candidateId > second.candidateId ? 1 : 0);
}

function collapseSourceDuplicates(candidates) {
  const result = [];
  const nativeIdentities = new Set();
  const urls = new Set();
  for (const candidate of candidates) {
    const nativeIdentity = candidate.sourceNativeId
      ? `${candidate.sourceId}\0${candidate.sourceNativeId}`
      : null;
    const urlIdentity = `${candidate.sourceId}\0${candidate.canonicalUrl}`;
    if ((nativeIdentity && nativeIdentities.has(nativeIdentity)) || urls.has(urlIdentity)) continue;
    if (nativeIdentity) nativeIdentities.add(nativeIdentity);
    urls.add(urlIdentity);
    result.push(candidate);
  }
  return result;
}

function mergeCandidates(previousCandidates, currentCandidates) {
  const current = collapseSourceDuplicates(currentCandidates);
  const currentById = new Map(current.map((candidate) => [candidate.candidateId, candidate]));
  const previous = collapseSourceDuplicates(previousCandidates).filter((candidate) => (
    !currentById.has(candidate.candidateId)
  ));
  const refreshed = current.map((candidate) => {
    const prior = previousCandidates.find(({ candidateId }) => candidateId === candidate.candidateId);
    return prior ? { ...candidate, firstSeenAt: prior.firstSeenAt } : candidate;
  });
  return collapseSourceDuplicates([...refreshed, ...previous]);
}

function applyRetention(candidates, collectionStart, retention) {
  const bySource = new Map();
  for (const candidate of candidates) {
    const values = bySource.get(candidate.sourceId) ?? [];
    values.push(candidate);
    bySource.set(candidate.sourceId, values);
  }

  const eligible = [];
  for (const values of bySource.values()) {
    values.sort(compareNewest);
    const guaranteed = new Set(values.slice(0, retention.minimumPerSource).map(({ candidateId }) => candidateId));
    for (const candidate of values) {
      const days = candidate.channel === 'podcasts' ? retention.podcastDays : retention.defaultDays;
      // Central Feed retention uses complete UTC calendar days, independent of user timezone.
      if (retentionTimestamp(candidate) >= utcRetentionCutoff(collectionStart, days)
        || guaranteed.has(candidate.candidateId)) {
        eligible.push(candidate);
      }
    }
  }
  eligible.sort(compareNewest);
  const retained = eligible.slice(0, retention.maxCandidates);
  const removedByCap = eligible.slice(retention.maxCandidates);
  return { retained, removedByCap };
}

function activePriorTruncation(previous, registry, collectionStart) {
  if (!previous?.historyTruncated || !previous.truncation?.oldestRetainedAt) return null;
  const channels = new Map(registry.map(({ id, sourceId, channel }) => [id ?? sourceId, channel]));
  const stillRelevant = previous.truncation.affectedSourceIds.some((sourceId) => {
    const days = channels.get(sourceId) === 'podcasts'
      ? CANDIDATE_RETENTION.podcastDays
      : CANDIDATE_RETENTION.defaultDays;
    const boundary = previous.truncation.newestRemovedFirstSeenAtBySource?.[sourceId]
      ?? previous.truncation.oldestRetainedFirstSeenAtBySource?.[sourceId]
      ?? previous.truncation.oldestRetainedAt;
    return Date.parse(boundary) >= utcRetentionCutoff(collectionStart, days);
  });
  return stillRelevant ? previous.truncation : null;
}

function truncation(retained, removedByCap, priorTruncation) {
  if (removedByCap.length === 0 && !priorTruncation) {
    return {
      historyTruncated: false,
      truncation: {
        affectedSourceIds: [],
        oldestRetainedAt: null,
        oldestRetainedFirstSeenAtBySource: {},
        oldestRemovedFirstSeenAtBySource: {},
        newestRemovedFirstSeenAtBySource: {},
        removedCount: 0,
      },
    };
  }
  if (removedByCap.length === 0) {
    return { historyTruncated: true, truncation: { ...priorTruncation } };
  }
  const affectedSourceIds = [...new Set([
    ...(priorTruncation?.affectedSourceIds ?? []),
    ...removedByCap.map(({ sourceId }) => sourceId),
  ])].sort();
  const previousBoundaries = priorTruncation?.oldestRetainedFirstSeenAtBySource ?? {};
  const previousOldestRemoved = priorTruncation?.oldestRemovedFirstSeenAtBySource ?? {};
  const previousNewestRemoved = priorTruncation?.newestRemovedFirstSeenAtBySource ?? {};
  const previouslyAffected = new Set(priorTruncation?.affectedSourceIds ?? []);
  const currentRemovedBySource = new Map();
  for (const candidate of removedByCap) {
    const values = currentRemovedBySource.get(candidate.sourceId) ?? [];
    values.push(Date.parse(candidate.firstSeenAt));
    currentRemovedBySource.set(candidate.sourceId, values);
  }
  const oldestRetainedFirstSeenAtBySource = Object.fromEntries(affectedSourceIds.map((sourceId) => {
    const retainedForSource = retained.filter((candidate) => candidate.sourceId === sourceId);
    const removedForSource = removedByCap.filter((candidate) => candidate.sourceId === sourceId);
    const retainedBoundary = retainedForSource.length > 0
      ? Math.min(...retainedForSource.map((candidate) => Date.parse(candidate.firstSeenAt)))
      : Number.NEGATIVE_INFINITY;
    const removedBoundary = removedForSource.length > 0
      ? Math.max(...removedForSource.map((candidate) => Date.parse(candidate.firstSeenAt)))
      : Number.NEGATIVE_INFINITY;
    const currentBoundary = Math.max(retainedBoundary, removedBoundary);
    const previousBoundary = Date.parse(previousBoundaries[sourceId]);
    const fallbackBoundary = previouslyAffected.has(sourceId)
      ? Date.parse(priorTruncation?.oldestRetainedAt)
      : Number.NaN;
    const boundary = Math.max(
      currentBoundary,
      Number.isFinite(previousBoundary) ? previousBoundary : Number.NEGATIVE_INFINITY,
      Number.isFinite(fallbackBoundary) ? fallbackBoundary : Number.NEGATIVE_INFINITY,
    );
    return [sourceId, new Date(boundary).toISOString()];
  }));
  const oldestRemovedFirstSeenAtBySource = Object.fromEntries(affectedSourceIds.map((sourceId) => {
    const current = currentRemovedBySource.get(sourceId) ?? [];
    const prior = Date.parse(previousOldestRemoved[sourceId]);
    const fallbackPriorBoundary = previouslyAffected.has(sourceId)
      ? Date.parse(priorTruncation?.oldestRetainedAt)
      : Number.NaN;
    const values = [
      ...current,
      Number.isFinite(prior) ? prior : fallbackPriorBoundary,
    ].filter(Number.isFinite);
    return [sourceId, new Date(Math.min(...values)).toISOString()];
  }));
  const newestRemovedFirstSeenAtBySource = Object.fromEntries(affectedSourceIds.map((sourceId) => {
    const current = currentRemovedBySource.get(sourceId) ?? [];
    const prior = Date.parse(previousNewestRemoved[sourceId]);
    const fallbackPriorBoundary = previouslyAffected.has(sourceId)
      ? Date.parse(priorTruncation?.oldestRetainedAt)
      : Number.NaN;
    const values = [
      ...current,
      Number.isFinite(prior) ? prior : fallbackPriorBoundary,
    ].filter(Number.isFinite);
    return [sourceId, new Date(Math.max(...values)).toISOString()];
  }));
  return {
    historyTruncated: true,
    truncation: {
      affectedSourceIds,
      oldestRetainedAt: new Date(Math.min(...retained.map(retentionTimestamp))).toISOString(),
      oldestRetainedFirstSeenAtBySource,
      oldestRemovedFirstSeenAtBySource,
      newestRemovedFirstSeenAtBySource,
      removedCount: (priorTruncation?.removedCount ?? 0) + removedByCap.length,
    },
  };
}

function createMergedFeed({
  previousCandidates,
  currentCandidates,
  statuses,
  registry,
  collectionStart,
  initializedAt,
  continuousHistorySince,
  previous,
}) {
  const merged = mergeCandidates(previousCandidates, currentCandidates);
  const { retained, removedByCap } = applyRetention(merged, collectionStart, CANDIDATE_RETENTION);
  return createCandidateFeed({
    generatedAt: collectionStart,
    initializedAt,
    continuousHistorySince,
    retention: { ...CANDIDATE_RETENTION },
    ...truncation(
      retained,
      removedByCap,
      activePriorTruncation(previous, registry, collectionStart),
    ),
    registry: statuses,
    candidates: retained,
  }, { expectedRegistry: expectedRegistry(registry) });
}

export async function loadCandidateFeed({
  path = new URL(`../${CANDIDATE_FEED_FILE}`, import.meta.url),
  readFileImpl = readFile,
  registry,
}) {
  let serialized;
  try {
    serialized = await readFileImpl(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Candidate Feed is missing; run --initialize-candidate-feed once`, { cause: error });
    }
    throw error;
  }
  let feed;
  try {
    feed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Candidate Feed contains invalid JSON: ${error.message}`, { cause: error });
  }
  const result = validateCandidateFeed(feed, { expectedRegistry: expectedRegistry(registry) });
  if (!result.valid) throw new Error(`Invalid candidate Feed: ${result.errors.join('; ')}`);
  return feed;
}

export function initializeCandidateFeed({
  feeds,
  currentCandidates,
  statuses,
  registry,
  collectionStart,
}) {
  for (const { category, filename } of CENTRAL_FEED_FILES) {
    const result = validateFeed(feeds?.[category], category);
    if (!result.valid) throw new Error(`${filename}: ${result.errors.join('; ')}`);
  }
  const snapshotCandidates = normalizeLegacyFeeds(feeds, {
    registry,
    seenAt: collectionStart,
  });
  return createMergedFeed({
    previousCandidates: snapshotCandidates,
    currentCandidates,
    statuses,
    registry,
    collectionStart,
    initializedAt: collectionStart,
    continuousHistorySince: collectionStart,
  });
}

export function mergeCandidateFeed(previous, {
  currentCandidates,
  statuses,
  registry,
  collectionStart,
}) {
  const validation = validateCandidateFeed(previous, { expectedRegistry: expectedRegistry(registry) });
  if (!validation.valid) throw new Error(`Invalid candidate Feed: ${validation.errors.join('; ')}`);
  return createMergedFeed({
    previousCandidates: previous.candidates,
    currentCandidates,
    statuses,
    registry,
    collectionStart,
    initializedAt: previous.initializedAt,
    continuousHistorySince: previous.continuousHistorySince,
    previous,
  });
}
