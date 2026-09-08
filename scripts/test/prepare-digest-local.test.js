import assert from 'node:assert/strict';
import test from 'node:test';

import { createCandidateId, createContentFingerprint } from '../candidate-identity.js';
import { prepareDigest } from '../prepare-digest.js';

const NOW = '2026-09-06T09:00:00.000Z';

function candidate(label, sourceId = 'blog:official') {
  const value = {
    channel: 'blogs', sourceId,
    canonicalUrl: `https://example.com/${label}`,
    title: label, author: 'Author', publishedAt: '2026-09-06T07:00:00.000Z',
    firstSeenAt: '2026-09-06T07:01:00.000Z', lastSeenAt: '2026-09-06T07:01:00.000Z',
    summarizationContent: label, contentTruncated: false,
  };
  value.candidateId = createCandidateId(value);
  value.contentFingerprint = createContentFingerprint(value);
  return value;
}

function centralFeed(candidates) {
  return {
    schemaVersion: '1.0', generatedAt: '2026-09-06T08:00:00.000Z',
    initializedAt: '2026-09-01T00:00:00.000Z', continuousHistorySince: '2026-09-01T00:00:00.000Z',
    retention: { defaultDays: 15, podcastDays: 30, minimumPerSource: 50, maxCandidates: 1000 },
    historyTruncated: false,
    truncation: { affectedSourceIds: [], oldestRetainedAt: null, removedCount: 0 },
    registry: [{ sourceId: 'blog:official', channel: 'blogs', sourceName: 'Official', status: 'ok', candidateCount: candidates.length }],
    candidates,
  };
}

const registry = [{ id: 'blog:official', channel: 'blogs', name: 'Official' }];
const config = { enabledChannels: ['blogs'], onboardingComplete: true };

function localBatches(label) {
  const local = candidate(label);
  return async () => ({
    candidates: [local],
    sourceStatuses: [{ sourceId: 'blog:official', channel: 'blogs', sourceName: 'Official', status: 'ok', candidateCount: 1 }],
  });
}

test('local mode delivers local candidates instead of central', async () => {
  const result = await prepareDigest({
    config, frequency: 'daily', now: NOW, registry,
    loadCandidateFeed: async () => centralFeed([candidate('central-post')]),
    loadCurationPrompt: async () => 'prompt',
    mode: 'local',
    loadLocalSignalBatches: localBatches('local-post'),
  });
  assert.deepEqual(result.request.eligibleCandidates.map((c) => c.title), ['local-post']);
});

test('shadow mode delivers central candidates and excludes local', async () => {
  const result = await prepareDigest({
    config, frequency: 'daily', now: NOW, registry,
    loadCandidateFeed: async () => centralFeed([candidate('central-post')]),
    loadCurationPrompt: async () => 'prompt',
    mode: 'shadow',
    loadLocalSignalBatches: localBatches('local-post'),
  });
  assert.deepEqual(result.request.eligibleCandidates.map((c) => c.title), ['central-post']);
});
