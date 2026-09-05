import { createHash } from 'node:crypto';

import { frameFields } from './candidate-identity.js';
import {
  validateCurationRequest,
  validateDigestSelection,
} from './digest-selection-contract.js';

const HASH_ID = /^[a-f0-9]{64}$/;

function byteOrder(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

export function createEventClusterId(candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    throw new TypeError('candidateIds must be a non-empty array');
  }
  for (const [index, candidateId] of candidateIds.entries()) {
    if (typeof candidateId !== 'string' || !HASH_ID.test(candidateId)) {
      throw new TypeError(`candidateIds[${index}] must be a SHA-256 identity`);
    }
  }
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new TypeError('candidateIds must not contain duplicate identities');
  }
  const sorted = [...candidateIds].sort(byteOrder);
  return createHash('sha256').update(frameFields(['event-v1', ...sorted])).digest('hex');
}

function publicationTime(candidate) {
  const parsed = Date.parse(candidate?.publishedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareClusters(candidateById) {
  return (left, right) => (
    right.scores.totalScore - left.scores.totalScore
    || right.scores.evidence - left.scores.evidence
    || publicationTime(candidateById.get(right.leadCandidateId))
      - publicationTime(candidateById.get(left.leadCandidateId))
    || byteOrder(left.leadCandidateId, right.leadCandidateId)
  );
}

function selectionContext(request, clusters) {
  const candidateById = new Map(request.eligibleCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const qualifying = clusters
    .filter(({ scores }) => scores.totalScore >= request.selectionRules.qualificationThreshold)
    .sort(compareClusters(candidateById));
  const qualifyingChannels = new Set(qualifying
    .map(({ leadCandidateId }) => candidateById.get(leadCandidateId)?.channel)
    .filter(Boolean));
  return {
    candidateById,
    qualifying,
    channelLimitApplies: qualifyingChannels.size
      >= request.selectionRules.channelLimitAppliesAtQualifyingChannelCount,
  };
}

export function selectEventClusters(request, clusters) {
  const { candidateById, qualifying, channelLimitApplies } = selectionContext(request, clusters);
  const selected = [];
  const selectedIds = new Set();
  const leadCountsBySource = new Map();
  const positionCountsByChannel = new Map();
  const representedSources = new Set();

  function take(cluster) {
    if (selected.length >= request.selectionRules.maxSelected) return false;
    const lead = candidateById.get(cluster.leadCandidateId);
    if (!lead) return false;
    if ((leadCountsBySource.get(lead.sourceId) ?? 0) >= request.selectionRules.maxLeadsPerSource) {
      return false;
    }
    if (channelLimitApplies
        && (positionCountsByChannel.get(lead.channel) ?? 0)
          >= request.selectionRules.channelPositionLimit) {
      return false;
    }
    selected.push(cluster.eventClusterId);
    selectedIds.add(cluster.eventClusterId);
    representedSources.add(lead.sourceId);
    leadCountsBySource.set(lead.sourceId, (leadCountsBySource.get(lead.sourceId) ?? 0) + 1);
    positionCountsByChannel.set(lead.channel, (positionCountsByChannel.get(lead.channel) ?? 0) + 1);
    return true;
  }

  for (const cluster of qualifying) {
    const lead = candidateById.get(cluster.leadCandidateId);
    if (lead && !representedSources.has(lead.sourceId)) take(cluster);
  }
  for (const cluster of qualifying) {
    if (!selectedIds.has(cluster.eventClusterId)) take(cluster);
  }
  return selected;
}

export function validateSelectionAgainstRequest(request, manifest, { excludedCandidateIds = [] } = {}) {
  const errors = [];
  const requestResult = validateCurationRequest(request);
  const selectionResult = validateDigestSelection(manifest);
  errors.push(...requestResult.errors.map((error) => `request${error}`));
  errors.push(...selectionResult.errors.map((error) => `selection${error}`));
  if (!requestResult.valid || !selectionResult.valid) return { valid: false, errors };

  if (request.digestId !== manifest.digestId) errors.push('/digestId must match the curation request');
  const candidateById = new Map(request.eligibleCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const excluded = new Set(excludedCandidateIds);
  const assigned = new Map();
  const clusterById = new Map();
  const totalCandidateReferences = manifest.clusters.reduce(
    (total, cluster) => total + 1 + cluster.corroboratingCandidateIds.length,
    0,
  );
  if (totalCandidateReferences > Math.min(request.eligibleCandidates.length, 1000)) {
    errors.push('/clusters exceed the candidate reference budget');
  }

  for (const [index, cluster] of manifest.clusters.entries()) {
    const path = `/clusters/${index}`;
    if (clusterById.has(cluster.eventClusterId)) errors.push(`${path}/eventClusterId must be unique`);
    clusterById.set(cluster.eventClusterId, cluster);
    const members = [cluster.leadCandidateId, ...cluster.corroboratingCandidateIds];
    if (cluster.corroboratingCandidateIds.includes(cluster.leadCandidateId)) {
      errors.push(`${path}/leadCandidateId must not appear in corroboratingCandidateIds`);
    }
    for (const candidateId of members) {
      if (!candidateById.has(candidateId)) errors.push(`${path} references an ineligible candidate`);
      if (excluded.has(candidateId)) errors.push(`${path} references a delivery-excluded candidate`);
      if (assigned.has(candidateId)) errors.push(`${path} assigns a candidate already used by another cluster`);
      else assigned.set(candidateId, cluster.eventClusterId);
    }
    try {
      if (cluster.eventClusterId !== createEventClusterId(members)) {
        errors.push(`${path}/eventClusterId does not match its byte-sorted candidate membership`);
      }
    } catch {
      // The selection Schema already reports malformed member identities.
    }
    const { impact, relevance, evidence, novelty, corroboration, totalScore } = cluster.scores;
    if (totalScore !== impact + relevance + evidence + novelty + corroboration) {
      errors.push(`${path}/scores/totalScore must equal the component sum`);
    }
    const sourceIds = new Set(members.map((candidateId) => candidateById.get(candidateId)?.sourceId).filter(Boolean));
    if (corroboration > 0 && sourceIds.size < 2) {
      errors.push(`${path}/scores/corroboration requires at least two source IDs`);
    }
  }

  for (const candidateId of candidateById.keys()) {
    if (!assigned.has(candidateId)) {
      errors.push(`/eligibleCandidates eligible candidate ${candidateId} must appear in exactly one cluster`);
    }
  }

  for (const [index, eventClusterId] of manifest.selectedEventClusterIds.entries()) {
    const cluster = clusterById.get(eventClusterId);
    if (!cluster) errors.push(`/selectedEventClusterIds/${index} does not reference a cluster`);
    else if (cluster.scores.totalScore < request.selectionRules.qualificationThreshold) {
      errors.push(`/selectedEventClusterIds/${index} is below the qualification threshold`);
    }
  }

  const expected = selectEventClusters(request, manifest.clusters);
  if (JSON.stringify(manifest.selectedEventClusterIds) !== JSON.stringify(expected)) {
    errors.push('/selectedEventClusterIds must equal the deterministic portfolio selection order');
  }
  return { valid: errors.length === 0, errors };
}
