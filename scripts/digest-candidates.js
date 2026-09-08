import { normalizeConfig } from './config-contract.js';
import { deriveDeliveryState } from './delivery-ledger.js';
import { deriveDigestWindow } from './digest-window.js';

function emptyExclusions() {
  return { total: 0, counts: {}, reasons: [] };
}

function exclude(excluded, candidateId, reason) {
  excluded.total += 1;
  excluded.counts[reason] = (excluded.counts[reason] ?? 0) + 1;
  excluded.reasons.push({ candidateId, reason });
}

function weeklyCandidateTimestamp(candidate) {
  const parsed = Date.parse(candidate.firstSeenAt);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`Candidate ${candidate.candidateId} has no valid firstSeenAt timestamp`);
  }
  return parsed;
}

export async function resolveDigestCandidates({
  config = {},
  frequency = config.frequency ?? 'daily',
  now = new Date().toISOString(),
  deliveryEvents = [],
  loadCandidateFeed,
}) {
  const { enabledChannels } = normalizeConfig(config);
  if (enabledChannels.length === 0) {
    return {
      status: 'no-channels',
      coverage: null,
      eligibleCandidates: [],
      sourceStatuses: [],
      excluded: emptyExclusions(),
      ordering: 'candidate-feed-stable',
    };
  }
  if (typeof loadCandidateFeed !== 'function') {
    throw new TypeError('loadCandidateFeed must be a function');
  }

  const feed = await loadCandidateFeed();
  if (!feed || !Array.isArray(feed.candidates) || !Array.isArray(feed.registry)) {
    throw new TypeError('Candidate Feed must contain candidates and registry arrays');
  }
  const sourceStatuses = feed.registry.filter(({ channel }) => enabledChannels.includes(channel));
  const enabledSourceIds = sourceStatuses.map(({ sourceId }) => sourceId);
  const coverage = deriveDigestWindow({
    frequency,
    now,
    continuousHistorySince: feed.continuousHistorySince,
    deliveryEvents,
    enabledSourceIds,
    truncation: feed.historyTruncated ? feed.truncation : null,
  });
  const deliveryState = deriveDeliveryState(deliveryEvents);
  const startMs = Date.parse(coverage.actualInterval.start);
  const endMs = Date.parse(coverage.actualInterval.end);
  const eligibleCandidates = [];
  const excluded = emptyExclusions();

  // Candidate Feed order is intentionally stable through eligibility filtering.
  for (const candidate of feed.candidates) {
    if (!enabledChannels.includes(candidate.channel)) {
      exclude(excluded, candidate.candidateId, 'channel-disabled');
      continue;
    }
    if (frequency === 'weekly') {
      const eligibleAt = weeklyCandidateTimestamp(candidate);
      const afterEnd = coverage.bounds.endInclusive ? eligibleAt > endMs : eligibleAt >= endMs;
      if (eligibleAt < startMs || afterEnd) {
        exclude(excluded, candidate.candidateId, 'outside-coverage');
        continue;
      }
    }
    const state = deliveryState.candidateStates.get(candidate.candidateId) ?? 'unpushed';
    if (state === 'delivery-uncertain' || state === 'pushed-unseen') {
      exclude(excluded, candidate.candidateId, state);
      continue;
    }
    eligibleCandidates.push(candidate);
  }

  return {
    status: coverage.status === 'complete' ? 'ok' : 'incomplete-history',
    coverage,
    eligibleCandidates,
    sourceStatuses,
    excluded,
    ordering: 'candidate-feed-stable',
  };
}
