import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { frameFields } from '../candidate-identity.js';
import { createRequestHash } from '../digest-selection-contract.js';
import {
  createEventClusterId,
  selectEventClusters,
  validateSelectionAgainstRequest,
} from '../digest-selection.js';

const digestId = 'd'.repeat(64);

function candidate(char, channel, sourceId, publishedAt) {
  return {
    candidateId: char.repeat(64), channel, sourceId,
    canonicalUrl: `https://example.com/${char}`,
    title: `Candidate ${char}`, author: 'Fixture', publishedAt,
    firstSeenAt: publishedAt, lastSeenAt: publishedAt,
    contentFingerprint: char.repeat(64), summarizationContent: `Content ${char}`,
    contentTruncated: false,
  };
}

function request(candidates) {
  const sourceStatuses = [...new Map(candidates.map(({ sourceId, channel }) => [sourceId, {
    sourceId, channel, sourceName: sourceId, status: 'ok',
    candidateCount: candidates.filter((candidateItem) => candidateItem.sourceId === sourceId).length,
  }])).values()];
  const value = {
    schemaVersion: '1.0', digestId, frequency: 'daily', generatedAt: '2026-09-06T08:00:00.000Z',
    coverage: {
      frequency: 'daily', status: 'complete', complete: true,
      requestedInterval: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-06T08:00:00.000Z' },
      actualInterval: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-06T08:00:00.000Z' },
      bounds: { startInclusive: true, endInclusive: true }, reasons: [],
    },
    eligibleCandidates: candidates,
    sourceStatuses,
    sourceCompleteness: {
      status: 'complete', complete: true, feedFresh: true,
      expectedSourceCount: sourceStatuses.length, reportedSourceCount: sourceStatuses.length,
      totalSourceCount: sourceStatuses.length,
      okSourceCount: sourceStatuses.length, noResultsSourceCount: 0,
      partialSourceCount: 0, errorSourceCount: 0, missingSourceCount: 0,
    },
    contentStats: {
      candidateCount: candidates.length, eligibleCount: candidates.length,
      excludedCount: 0, selectedCount: 0,
    },
    selectionRules: {
      qualificationThreshold: 60, maxSelected: 10, maxLeadsPerSource: 2,
      channelPositionLimit: 4, channelLimitAppliesAtQualifyingChannelCount: 3,
      ordering: 'totalScore-desc,evidence-desc,publishedAt-desc,candidateId-asc',
      sourceDiversityFirst: true,
    },
  };
  value.requestHash = createRequestHash(value);
  return value;
}

function cluster(candidate, totalScore, evidence = 15, corroboratingCandidateIds = []) {
  const rest = totalScore - evidence;
  const impact = Math.min(30, rest);
  const relevance = Math.min(25, rest - impact);
  const novelty = Math.min(15, rest - impact - relevance);
  const corroboration = rest - impact - relevance - novelty;
  return {
    eventClusterId: createEventClusterId([candidate.candidateId, ...corroboratingCandidateIds]),
    leadCandidateId: candidate.candidateId,
    corroboratingCandidateIds,
    scores: { impact, relevance, evidence, novelty, corroboration, totalScore },
    selectionReason: `Select ${candidate.candidateId[0]}`,
  };
}

test('event cluster identity reuses length-prefixed framing with UTF-8 byte-order candidate IDs', () => {
  const ids = ['f'.repeat(64), '0'.repeat(64), 'a'.repeat(64)];
  const expected = createHash('sha256')
    .update(frameFields(['event-v1', ...[...ids].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))]))
    .digest('hex');
  assert.equal(createEventClusterId(ids), expected);
  assert.equal(createEventClusterId([...ids].reverse()), expected);
  assert.throws(() => createEventClusterId([ids[0], ids[0]]), /duplicate/i);
});

test('selection takes the highest item from distinct sources first, then fills under source and channel limits', () => {
  const candidates = [
    candidate('a', 'blogs', 'blog:a', '2026-09-06T07:00:00.000Z'),
    candidate('b', 'x', 'x:b', '2026-09-06T07:01:00.000Z'),
    candidate('c', 'blogs', 'blog:a', '2026-09-06T07:02:00.000Z'),
    candidate('d', 'blogs', 'blog:c', '2026-09-06T07:03:00.000Z'),
    candidate('e', 'newsletters', 'newsletter:d', '2026-09-06T07:04:00.000Z'),
    candidate('f', 'x', 'x:e', '2026-09-06T07:05:00.000Z'),
    candidate('1', 'x', 'x:f', '2026-09-06T07:06:00.000Z'),
    candidate('2', 'blogs', 'blog:g', '2026-09-06T07:07:00.000Z'),
    candidate('3', 'newsletters', 'newsletter:h', '2026-09-06T07:08:00.000Z'),
    candidate('4', 'x', 'x:i', '2026-09-06T07:09:00.000Z'),
    candidate('5', 'x', 'x:j', '2026-09-06T07:10:00.000Z'),
    candidate('6', 'blogs', 'blog:k', '2026-09-06T07:11:00.000Z'),
  ];
  const scores = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 59];
  const clusters = candidates.map((item, index) => cluster(item, scores[index], 20));
  const selected = selectEventClusters(request(candidates), clusters);

  assert.deepEqual(selected, [
    clusters[0].eventClusterId, clusters[1].eventClusterId, clusters[3].eventClusterId,
    clusters[4].eventClusterId, clusters[5].eventClusterId, clusters[6].eventClusterId,
    clusters[7].eventClusterId, clusters[8].eventClusterId, clusters[9].eventClusterId,
    clusters[2].eventClusterId,
  ]);
  assert.equal(selected.includes(clusters[11].eventClusterId), false);
});

test('tie order is total, evidence, publication time, then candidate ID', () => {
  const candidates = [
    candidate('b', 'blogs', 'blog:b', '2026-09-06T07:00:00.000Z'),
    candidate('a', 'blogs', 'blog:a', '2026-09-06T07:00:00.000Z'),
    candidate('c', 'blogs', 'blog:c', '2026-09-06T06:00:00.000Z'),
    candidate('d', 'blogs', 'blog:d', '2026-09-06T08:00:00.000Z'),
  ];
  const clusters = [cluster(candidates[0], 80, 18), cluster(candidates[1], 80, 18),
    cluster(candidates[2], 80, 19), cluster(candidates[3], 80, 18)];
  assert.deepEqual(selectEventClusters(request(candidates), clusters), [
    clusters[2].eventClusterId, clusters[3].eventClusterId,
    clusters[1].eventClusterId, clusters[0].eventClusterId,
  ]);
});

test('null publication time sorts after valid times and then uses candidate ID', () => {
  const candidates = [
    candidate('b', 'blogs', 'blog:b', null),
    candidate('a', 'blogs', 'blog:a', null),
    candidate('c', 'blogs', 'blog:c', '2026-09-06T06:00:00.000Z'),
  ];
  const clusters = candidates.map((item) => cluster(item, 80, 18));
  assert.deepEqual(selectEventClusters(request(candidates), clusters), [
    clusters[2].eventClusterId, clusters[1].eventClusterId, clusters[0].eventClusterId,
  ]);
});

test('validator enforces membership, arithmetic, threshold order, exclusions, and cross-source corroboration', () => {
  const candidates = [
    candidate('a', 'blogs', 'blog:a', '2026-09-06T07:00:00.000Z'),
    candidate('b', 'x', 'x:b', '2026-09-06T07:01:00.000Z'),
    candidate('c', 'blogs', 'blog:a', '2026-09-06T07:02:00.000Z'),
  ];
  const clusters = [cluster(candidates[0], 80, 18, [candidates[1].candidateId]), cluster(candidates[2], 59, 15)];
  const manifest = { schemaVersion: '1.0', digestId, requestHash: request(candidates).requestHash, generatedAt: '2026-09-06T08:01:00.000Z',
    clusters, selectedEventClusterIds: [clusters[0].eventClusterId] };
  assert.deepEqual(validateSelectionAgainstRequest(request(candidates), manifest), { valid: true, errors: [] });

  const wrongRequestHash = { ...manifest, requestHash: 'f'.repeat(64) };
  assert.match(
    validateSelectionAgainstRequest(request(candidates), wrongRequestHash).errors.join('; '),
    /requestHash must match/i,
  );

  const wrongTotal = structuredClone(manifest);
  wrongTotal.clusters[0].scores.totalScore = 79;
  assert.equal(validateSelectionAgainstRequest(request(candidates), wrongTotal).valid, false);

  const duplicate = structuredClone(manifest);
  duplicate.clusters[1].corroboratingCandidateIds = [candidates[0].candidateId];
  duplicate.clusters[1].eventClusterId = createEventClusterId([candidates[2].candidateId, candidates[0].candidateId]);
  assert.equal(validateSelectionAgainstRequest(request(candidates), duplicate).valid, false);

  assert.equal(validateSelectionAgainstRequest(request(candidates), manifest, {
    excludedCandidateIds: [candidates[1].candidateId],
  }).valid, false);

  const sameSource = { ...cluster(candidates[0], 70, 18, [candidates[2].candidateId]), scores: {
    impact: 20, relevance: 15, evidence: 18, novelty: 10, corroboration: 7, totalScore: 70,
  } };
  const sameSourceManifest = { ...manifest, clusters: [sameSource], selectedEventClusterIds: [sameSource.eventClusterId] };
  assert.equal(validateSelectionAgainstRequest(request(candidates), sameSourceManifest).valid, false);

  const wrongOrder = { ...manifest, selectedEventClusterIds: [] };
  assert.equal(validateSelectionAgainstRequest(request(candidates), wrongOrder).valid, false);
});

test('validator requires every eligible candidate to appear in exactly one cluster', () => {
  const candidates = [
    candidate('a', 'blogs', 'blog:a', '2026-09-06T07:00:00.000Z'),
    candidate('b', 'x', 'x:b', '2026-09-06T07:01:00.000Z'),
    candidate('c', 'newsletters', 'newsletter:c', '2026-09-06T07:02:00.000Z'),
  ];
  const clusters = candidates.map((item, index) => cluster(item, 90 - index, 20));
  const validManifest = {
    schemaVersion: '1.0', digestId, requestHash: request(candidates).requestHash, generatedAt: '2026-09-06T08:01:00.000Z', clusters,
    selectedEventClusterIds: selectEventClusters(request(candidates), clusters),
  };
  assert.deepEqual(validateSelectionAgainstRequest(request(candidates), validManifest), {
    valid: true, errors: [],
  });

  const emptyManifest = { ...validManifest, clusters: [], selectedEventClusterIds: [] };
  assert.match(
    validateSelectionAgainstRequest(request(candidates), emptyManifest).errors.join('; '),
    /eligible candidate.*cluster/i,
  );

  const omittedHighScore = {
    ...validManifest,
    clusters: clusters.slice(1),
    selectedEventClusterIds: selectEventClusters(request(candidates), clusters.slice(1)),
  };
  assert.match(
    validateSelectionAgainstRequest(request(candidates), omittedHighScore).errors.join('; '),
    /eligible candidate.*cluster/i,
  );

  const omittedThirdChannel = {
    ...validManifest,
    clusters: clusters.slice(0, 2),
    selectedEventClusterIds: selectEventClusters(request(candidates), clusters.slice(0, 2)),
  };
  assert.match(
    validateSelectionAgainstRequest(request(candidates), omittedThirdChannel).errors.join('; '),
    /eligible candidate.*cluster/i,
  );

  const unknown = candidate('f', 'academic', 'academic:f', '2026-09-06T07:03:00.000Z');
  const extraUnknown = structuredClone(validManifest);
  extraUnknown.clusters.push(cluster(unknown, 60, 20));
  extraUnknown.selectedEventClusterIds = selectEventClusters(
    request(candidates), extraUnknown.clusters,
  );
  assert.match(
    validateSelectionAgainstRequest(request(candidates), extraUnknown).errors.join('; '),
    /ineligible candidate/i,
  );
});

test('validator permits empty clusters only when no candidates are eligible', () => {
  const emptyManifest = {
    schemaVersion: '1.0', digestId, requestHash: request([]).requestHash, generatedAt: '2026-09-06T08:01:00.000Z',
    clusters: [], selectedEventClusterIds: [],
  };
  assert.deepEqual(validateSelectionAgainstRequest(request([]), emptyManifest), {
    valid: true, errors: [],
  });
});

test('validator rejects wrong cluster identity and duplicate or unknown selected IDs', () => {
  const candidates = [candidate('a', 'blogs', 'blog:a', '2026-09-06T07:00:00.000Z')];
  const clusters = [cluster(candidates[0], 80, 18)];
  const manifest = {
    schemaVersion: '1.0', digestId, requestHash: request(candidates).requestHash, generatedAt: '2026-09-06T08:01:00.000Z', clusters,
    selectedEventClusterIds: [clusters[0].eventClusterId],
  };

  const wrongClusterId = structuredClone(manifest);
  wrongClusterId.clusters[0].eventClusterId = 'f'.repeat(64);
  wrongClusterId.selectedEventClusterIds = ['f'.repeat(64)];
  assert.match(
    validateSelectionAgainstRequest(request(candidates), wrongClusterId).errors.join('; '),
    /eventClusterId does not match/i,
  );

  const duplicateSelected = structuredClone(manifest);
  duplicateSelected.selectedEventClusterIds.push(clusters[0].eventClusterId);
  assert.equal(validateSelectionAgainstRequest(request(candidates), duplicateSelected).valid, false);

  const unknownSelected = structuredClone(manifest);
  unknownSelected.selectedEventClusterIds = ['e'.repeat(64)];
  assert.match(
    validateSelectionAgainstRequest(request(candidates), unknownSelected).errors.join('; '),
    /does not reference a cluster/i,
  );
});

test('validator rejects manifests whose total candidate references exceed the request budget', () => {
  const candidates = [
    candidate('a', 'blogs', 'blog:a', '2026-09-06T07:00:00.000Z'),
    candidate('b', 'x', 'x:b', '2026-09-06T07:01:00.000Z'),
  ];
  const first = cluster(candidates[0], 80, 18, [candidates[1].candidateId]);
  const second = cluster(candidates[1], 70, 18);
  const manifest = {
    schemaVersion: '1.0', digestId, requestHash: request(candidates).requestHash, generatedAt: '2026-09-06T08:01:00.000Z',
    clusters: [first, second], selectedEventClusterIds: [first.eventClusterId, second.eventClusterId],
  };
  assert.match(
    validateSelectionAgainstRequest(request(candidates), manifest).errors.join('; '),
    /candidate reference budget/i,
  );
});
