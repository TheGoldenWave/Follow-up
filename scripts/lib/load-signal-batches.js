import {
  canonicalizeUrl,
  createCandidateId,
  createContentFingerprint,
} from '../candidate-identity.js';
import {
  DEFAULT_CONTENT_CHARACTER_LIMIT,
  truncateUnicode,
} from '../candidate-normalization.js';
import { sanitizeDiagnostic } from '../source-status.js';
import { routeSourceChannel } from './route-channels.js';

const FAILURE_STATUSES = new Set([
  'rate-limited', 'auth-failed', 'unreachable', 'timeout',
  'schema-drift', 'skipped-unconfigured', 'error',
]);

function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

export function deriveSourceNativeId(candidateId, source) {
  if (typeof candidateId !== 'string' || candidateId.length === 0) return undefined;
  const prefix = `${source}:`;
  if (candidateId.startsWith(prefix)) return candidateId.slice(prefix.length);
  return candidateId;
}

export function mapSignalBatchItem(item, { source, channel, seenAt }) {
  const canonicalUrl = canonicalizeUrl(item.url);
  if (!canonicalUrl) {
    throw new Error(`Invalid candidate URL for source ${item.source}`);
  }
  const sourceNativeId = deriveSourceNativeId(item.candidate_id, item.source);
  const title = typeof item.title === 'string' ? item.title : '';
  const rawText = typeof item.text === 'string' && item.text.length > 0
    ? item.text
    : (title || '');
  const { content, truncated } = truncateUnicode(rawText, DEFAULT_CONTENT_CHARACTER_LIMIT);
  const candidate = {
    candidateId: createCandidateId({
      channel,
      sourceId: item.source,
      sourceNativeId,
      canonicalUrl,
    }),
    channel,
    sourceId: item.source,
    ...(sourceNativeId ? { sourceNativeId } : {}),
    canonicalUrl,
    title,
    author: typeof item.author === 'string' && item.author.length > 0
      ? item.author
      : (source?.name ?? item.source),
    publishedAt: normalizeDate(item.published_at),
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    summarizationContent: content,
    contentTruncated: truncated,
  };
  candidate.contentFingerprint = createContentFingerprint(candidate);
  return candidate;
}

export function mapSignalBatchSourceStatus(batch, { source, channel }) {
  const status = batch.source_status?.status ?? 'error';
  const candidateCount = Array.isArray(batch.items) ? batch.items.length : 0;
  let nodeStatus;
  if (status === 'ok') nodeStatus = candidateCount > 0 ? 'ok' : 'no-results';
  else if (status === 'no-results') nodeStatus = 'no-results';
  else if (status === 'partial') nodeStatus = 'partial';
  else nodeStatus = 'error';
  const sourceStatus = {
    sourceId: batch.source,
    channel,
    sourceName: source?.name ?? batch.source,
    status: nodeStatus,
    candidateCount,
  };
  if (nodeStatus === 'error' || nodeStatus === 'partial') {
    const message = batch.source_status?.message;
    const code = batch.source_status?.code;
    const summary = [status, code, message].filter(Boolean).join(': ');
    sourceStatus.errorSummary = sanitizeDiagnostic(
      `${source?.name ?? batch.source}: ${summary}`,
    );
  }
  return sourceStatus;
}

export function mapSignalBatch(batch, { sourceIndex, seenAt }) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    throw new TypeError('Signal Batch must be an object');
  }
  const sourceId = batch.source;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new TypeError('Signal Batch source must be a non-empty string');
  }
  const source = sourceIndex?.get(sourceId);
  if (!source) {
    throw new Error(`No source registry entry for Signal Batch source ${sourceId}`);
  }
  const channel = routeSourceChannel(source);
  const resolvedSeenAt = normalizeDate(batch.generated_at) ?? seenAt;
  const candidates = (batch.items ?? []).map((item) => (
    mapSignalBatchItem(item, { source, channel, seenAt: resolvedSeenAt })
  ));
  return {
    sourceId,
    channel,
    sourceStatus: mapSignalBatchSourceStatus(batch, { source, channel }),
    candidates,
  };
}

export function loadSignalBatches(batches, { sources, seenAt }) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  const sourceIndex = new Map(sources.map((source) => [source.id, source]));
  const candidates = [];
  const sourceStatuses = [];
  for (const batch of batches) {
    const mapped = mapSignalBatch(batch, { sourceIndex, seenAt });
    candidates.push(...mapped.candidates);
    sourceStatuses.push(mapped.sourceStatus);
  }
  return { candidates, sourceStatuses };
}
