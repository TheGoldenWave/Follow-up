import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { sanitizeDiagnostic } from './source-status.js';

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,399}$/u;
const SAFE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
export const DELIVERY_INPUT_LIMITS = Object.freeze({ jsonBytes: 2 * 1024 * 1024, messageBytes: 1024 * 1024 });

function safePlainText(value) {
  return sanitizeDiagnostic(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/@/gu, '＠')
    .replace(/([\\_*[\]()`])/gu, '\\$1');
}

export function renderDigestMessage(artifact) {
  const lines = [safePlainText(artifact.message)];
  for (const [index, item] of artifact.items.entries()) {
    lines.push('', `${index + 1}. ${safePlainText(item.title)}`);
    lines.push(`来源: ${safePlainText(item.sourceId)} | 评分: ${item.scores.totalScore}`);
    lines.push(`理由: ${safePlainText(item.reason)}`);
    lines.push(item.link);
  }
  return `${lines.join('\n')}\n`;
}

async function rejectSymlink(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error('Active digest contains an unsafe symbolic link');
  return metadata;
}

async function rejectSymlinkComponents(path) {
  const absolute = resolve(path);
  let current = sep;
  for (const component of absolute.split(sep).filter(Boolean)) {
    current = join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      const isMacOsVarAlias = current === '/var' && await realpath(current) === '/private/var';
      if (!isMacOsVarAlias) throw new Error('Active digest contains an unsafe symbolic link');
    }
  }
}

async function readLimited(path, maximum) {
  await rejectSymlink(path);
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Active digest input must be a regular file');
    if (metadata.size > maximum) throw new Error('Active digest input exceeds byte limit');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readJson(path, maximum, label) {
  try {
    const bytes = await readLimited(path, maximum);
    return { value: JSON.parse(bytes.toString('utf8')), bytes };
  }
  catch (error) { throw new Error(`${label} is invalid or could not be read`, { cause: error }); }
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) {
    throw new Error(`${label} violates its closed contract`);
  }
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function validateFinalDigestArtifact(artifact) {
  exactFields(artifact, [
    'schemaVersion', 'status', 'digestId', 'requestHash', 'frequency', 'generatedAt',
    'coverage', 'sourceCompleteness', 'incompleteSources', 'contentStats', 'items', 'message',
  ], 'Digest artifact');
  if (artifact.schemaVersion !== '1.0'
    || !['ready', 'no-important-updates', 'partial', 'incomplete-history'].includes(artifact.status)) {
    throw new Error('Digest artifact status is not deliverable');
  }
  if (!SAFE_DIGEST.test(artifact.digestId ?? '') || !HASH.test(artifact.requestHash ?? '')
    || !['daily', 'weekly'].includes(artifact.frequency)
    || !validTimestamp(artifact.generatedAt)
    || typeof artifact.message !== 'string' || artifact.message.length === 0
    || !Array.isArray(artifact.items) || artifact.items.length > 10
    || !Array.isArray(artifact.incompleteSources) || artifact.incompleteSources.length > 20) {
    throw new Error('Digest artifact required fields are invalid');
  }
  exactFields(artifact.coverage, [
    'frequency', 'status', 'complete', 'requestedInterval', 'actualInterval', 'bounds', 'reasons',
  ], 'Digest coverage');
  if (artifact.coverage.frequency !== artifact.frequency
    || !['complete', 'incomplete-history'].includes(artifact.coverage.status)
    || typeof artifact.coverage.complete !== 'boolean' || !Array.isArray(artifact.coverage.reasons)) {
    throw new Error('Digest coverage is inconsistent');
  }
  for (const interval of [artifact.coverage.requestedInterval, artifact.coverage.actualInterval]) {
    exactFields(interval, ['start', 'end'], 'Digest coverage interval');
    if (!validTimestamp(interval.start) || !validTimestamp(interval.end)
      || Date.parse(interval.start) > Date.parse(interval.end)) {
      throw new Error('Digest coverage interval is invalid');
    }
  }
  exactFields(artifact.coverage.bounds, ['startInclusive', 'endInclusive'], 'Digest coverage bounds');
  if (artifact.coverage.bounds.startInclusive !== true
    || typeof artifact.coverage.bounds.endInclusive !== 'boolean'
    || artifact.coverage.reasons.length > 20
    || new Set(artifact.coverage.reasons).size !== artifact.coverage.reasons.length
    || artifact.coverage.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0 || reason.length > 100)) {
    throw new Error('Digest coverage bounds or reasons are invalid');
  }
  exactFields(artifact.sourceCompleteness, [
    'status', 'complete', 'feedFresh', 'expectedSourceCount', 'reportedSourceCount',
    'totalSourceCount', 'okSourceCount', 'noResultsSourceCount', 'partialSourceCount',
    'errorSourceCount', 'missingSourceCount',
  ], 'Digest sourceCompleteness');
  if (!['complete', 'incomplete'].includes(artifact.sourceCompleteness.status)
    || typeof artifact.sourceCompleteness.complete !== 'boolean'
    || typeof artifact.sourceCompleteness.feedFresh !== 'boolean') {
    throw new Error('Digest sourceCompleteness is invalid');
  }
  for (const field of Object.keys(artifact.sourceCompleteness).filter((field) => field.endsWith('Count'))) {
    if (!nonNegativeInteger(artifact.sourceCompleteness[field])
      || artifact.sourceCompleteness[field] > 1000) throw new Error('Digest source counts are invalid');
  }
  const sourceCounts = artifact.sourceCompleteness;
  if (sourceCounts.expectedSourceCount !== sourceCounts.reportedSourceCount + sourceCounts.missingSourceCount
    || sourceCounts.totalSourceCount !== sourceCounts.reportedSourceCount
    || sourceCounts.reportedSourceCount !== sourceCounts.okSourceCount + sourceCounts.noResultsSourceCount
      + sourceCounts.partialSourceCount + sourceCounts.errorSourceCount) {
    throw new Error('Digest source counts are inconsistent');
  }
  exactFields(artifact.contentStats, ['candidateCount', 'eligibleCount', 'excludedCount', 'selectedCount'], 'Digest contentStats');
  if (Object.values(artifact.contentStats).some((value) => !nonNegativeInteger(value))
    || artifact.contentStats.selectedCount !== artifact.items.length
    || artifact.contentStats.candidateCount !== artifact.contentStats.eligibleCount + artifact.contentStats.excludedCount) {
    throw new Error('Digest contentStats are inconsistent');
  }
  for (const source of artifact.incompleteSources) {
    exactFields(source, ['sourceId', 'channel', 'sourceName', 'status'], 'Digest incomplete source');
    if (typeof source.sourceId !== 'string' || typeof source.sourceName !== 'string'
      || !['x', 'podcasts', 'blogs', 'newsletters', 'academic', 'zh-tech'].includes(source.channel)
      || !['partial', 'error'].includes(source.status)) {
      throw new Error('Digest incomplete source is invalid');
    }
  }
  for (const item of artifact.items) {
    exactFields(item, [
      'eventClusterId', 'candidateId', 'channel', 'sourceId', 'title', 'author',
      'publishedAt', 'link', 'scores', 'reason', 'corroborating',
    ], 'Digest item');
    exactFields(item.scores, ['impact', 'relevance', 'evidence', 'novelty', 'corroboration', 'totalScore'], 'Digest item scores');
    const scoreLimits = { impact: 30, relevance: 25, evidence: 20, novelty: 15, corroboration: 10, totalScore: 100 };
    if (Object.entries(scoreLimits).some(([field, maximum]) => (
      !nonNegativeInteger(item.scores[field]) || item.scores[field] > maximum
    )) || item.scores.totalScore !== item.scores.impact + item.scores.relevance
      + item.scores.evidence + item.scores.novelty + item.scores.corroboration
      || item.scores.totalScore < 60
      || typeof item.link !== 'string' || !item.link.startsWith('https://')
      || typeof item.title !== 'string' || item.title.length === 0
      || typeof item.sourceId !== 'string' || item.sourceId.length === 0
      || !['x', 'podcasts', 'blogs', 'newsletters', 'academic', 'zh-tech'].includes(item.channel)
      || !(item.author === null || typeof item.author === 'string')
      || !(item.publishedAt === null || validTimestamp(item.publishedAt))
      || typeof item.reason !== 'string' || item.reason.length === 0 || item.reason.length > 280
      || !Array.isArray(item.corroborating)) {
      throw new Error('Digest item score or fields are invalid');
    }
    for (const candidate of item.corroborating) {
      exactFields(candidate, ['candidateId', 'sourceId', 'title', 'link'], 'Digest corroborating item');
      if (!HASH.test(candidate.candidateId) || typeof candidate.sourceId !== 'string'
        || typeof candidate.title !== 'string' || typeof candidate.link !== 'string'
        || !candidate.link.startsWith('https://')) {
        throw new Error('Digest corroborating item is invalid');
      }
    }
  }
  if ((artifact.status === 'ready' && artifact.items.length === 0)
    || (artifact.status === 'no-important-updates' && artifact.items.length !== 0)) {
    throw new Error('Digest artifact status and selected items are inconsistent');
  }
  const historyComplete = artifact.coverage.status === 'complete' && artifact.coverage.complete;
  const sourcesComplete = artifact.sourceCompleteness.status === 'complete'
    && artifact.sourceCompleteness.complete;
  if (artifact.coverage.complete !== (artifact.coverage.status === 'complete')
    || artifact.sourceCompleteness.complete !== (artifact.sourceCompleteness.status === 'complete')) {
    throw new Error('Digest completeness flags and statuses are inconsistent');
  }
  if (artifact.coverage.complete !== (artifact.coverage.reasons.length === 0)) {
    throw new Error('Digest coverage completeness and reasons are inconsistent');
  }
  const aggregateSourcesComplete = artifact.sourceCompleteness.feedFresh
    && artifact.sourceCompleteness.missingSourceCount === 0
    && artifact.sourceCompleteness.partialSourceCount === 0
    && artifact.sourceCompleteness.errorSourceCount === 0;
  if (artifact.sourceCompleteness.complete !== aggregateSourcesComplete) {
    throw new Error('Digest source completeness and aggregates are inconsistent');
  }
  if (artifact.status === 'ready'
    && (!historyComplete || !sourcesComplete || artifact.items.length === 0)) {
    throw new Error('ready Digest requires complete history, complete sources, and selected items');
  }
  if (artifact.status === 'no-important-updates'
    && (!historyComplete || !sourcesComplete || artifact.items.length !== 0)) {
    throw new Error('no-important-updates Digest requires complete history and sources with no items');
  }
  if (artifact.status === 'partial' && (!historyComplete || sourcesComplete)) {
    throw new Error('partial Digest requires complete history and incomplete sources');
  }
  if (artifact.status === 'incomplete-history' && historyComplete) {
    throw new Error('incomplete-history Digest requires incomplete coverage');
  }
  return artifact;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} is invalid`);
}

function requireBoundIds(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !HASH.test(entry))
    || new Set(value).size !== value.length) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function collectCandidateIds(items) {
  const ids = [];
  for (const item of items) {
    requireHash(item?.candidateId, 'selected candidate ID');
    ids.push(item.candidateId);
    if (item.corroborating !== undefined) {
      if (!Array.isArray(item.corroborating)) throw new Error('selected candidate IDs are invalid');
      for (const candidate of item.corroborating) {
        requireHash(candidate?.candidateId, 'selected candidate ID');
        ids.push(candidate.candidateId);
      }
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error('selected candidate IDs must be unique');
  return ids;
}

export async function loadActiveDigest(activePath, { limits = DELIVERY_INPUT_LIMITS } = {}) {
  if (typeof activePath !== 'string' || basename(activePath) !== 'active.json') {
    throw new Error('Active digest path must name active.json');
  }
  const absoluteActive = resolve(activePath);
  await rejectSymlinkComponents(absoluteActive);
  const { value: active } = await readJson(absoluteActive, limits.jsonBytes, 'Active digest');
  exactFields(active, [
    'schemaVersion', 'generation', 'digestId', 'requestHash', 'candidateIds',
    'eventClusterIds', 'artifact', 'message',
  ], 'Active digest');
  if (active?.schemaVersion !== '1.0' || !SAFE_GENERATION.test(active.generation ?? '')
    || !SAFE_DIGEST.test(active.digestId ?? '')
    || active.artifact !== 'artifact.json' || active.message !== 'message.txt') {
    throw new Error('Active digest is invalid');
  }
  const root = dirname(absoluteActive);
  const generationDir = join(root, 'generations', active.generation);
  await rejectSymlink(join(root, 'generations'));
  await rejectSymlink(generationDir);
  const canonicalRoot = `${await realpath(root)}${sep}`;
  if (!`${await realpath(generationDir)}${sep}`.startsWith(canonicalRoot)) {
    throw new Error('Active digest generation escapes its root');
  }
  const { value: manifest } = await readJson(join(generationDir, 'manifest.json'), limits.jsonBytes, 'Digest manifest');
  exactFields(manifest, [
    'schemaVersion', 'generation', 'digestId', 'requestHash', 'candidateIds',
    'eventClusterIds', 'artifact', 'message', 'artifactHash', 'messageHash',
  ], 'Digest manifest');
  const { value: artifact, bytes: artifactBytes } = await readJson(
    join(generationDir, active.artifact), limits.jsonBytes, 'Digest artifact',
  );
  validateFinalDigestArtifact(artifact);
  const messageBytes = await readLimited(join(generationDir, active.message), limits.messageBytes);
  const message = messageBytes.toString('utf8');
  if (manifest?.schemaVersion !== '1.0' || manifest.generation !== active.generation) {
    throw new Error('Digest manifest generation must match active generation');
  }
  if (manifest.digestId !== active.digestId || artifact?.digestId !== active.digestId) {
    throw new Error('Digest ID must match active generation');
  }
  requireHash(manifest.requestHash, 'manifest requestHash');
  requireHash(active.requestHash, 'active requestHash');
  if (artifact.requestHash !== manifest.requestHash || active.requestHash !== manifest.requestHash) {
    throw new Error('requestHash must match active generation');
  }
  if (manifest.artifact !== active.artifact || manifest.message !== active.message) {
    throw new Error('Digest manifest files must match active generation');
  }
  requireHash(manifest.artifactHash, 'manifest artifactHash');
  requireHash(manifest.messageHash, 'manifest messageHash');
  if (createHash('sha256').update(artifactBytes).digest('hex') !== manifest.artifactHash) {
    throw new Error('Digest artifact hash does not match manifest');
  }
  if (createHash('sha256').update(messageBytes).digest('hex') !== manifest.messageHash) {
    throw new Error('Digest message hash does not match manifest');
  }
  if (message !== renderDigestMessage(artifact)) {
    throw new Error('Digest rendered message does not match artifact');
  }
  const candidateIds = collectCandidateIds(artifact.items);
  const eventClusterIds = artifact.items.map((item) => {
    requireHash(item?.eventClusterId, 'selected event cluster ID');
    return item.eventClusterId;
  });
  if (new Set(eventClusterIds).size !== eventClusterIds.length) {
    throw new Error('selected event cluster IDs must be unique');
  }
  const activeCandidateIds = requireBoundIds(active.candidateIds, 'active candidate IDs');
  const manifestCandidateIds = requireBoundIds(manifest.candidateIds, 'manifest candidate IDs');
  if (!sameIds(candidateIds, activeCandidateIds) || !sameIds(candidateIds, manifestCandidateIds)) {
    throw new Error('selected candidate IDs must match active generation');
  }
  const activeClusterIds = requireBoundIds(active.eventClusterIds, 'active event cluster IDs');
  const manifestClusterIds = requireBoundIds(manifest.eventClusterIds, 'manifest event cluster IDs');
  if (!sameIds(eventClusterIds, activeClusterIds) || !sameIds(eventClusterIds, manifestClusterIds)) {
    throw new Error('selected event cluster IDs must match active generation');
  }
  return {
    activePath: absoluteActive, generation: active.generation, digestId: active.digestId,
    requestHash: manifest.requestHash, frequency: artifact.frequency, status: artifact.status,
    candidateIds, eventClusterIds, message,
  };
}
