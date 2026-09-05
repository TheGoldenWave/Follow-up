import { ENABLED_CHANNELS } from './config-contract.js';

const COMPLETE_STATUSES = new Set(['ok', 'no-results']);

export function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[URL]')
    .replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/giu, '[REDACTED]')
    .replace(/\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]*/giu, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/giu, '[REDACTED]')
    .replace(/\bAuthorization\s*:\s*[^,;]+/giu, '[REDACTED]')
    .replace(/\b(?:token|access_token|refresh_token|client_secret|api[_-]?key|authorization|cookie|session|password)\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/file:\/\/[^\s,;)]+/giu, '[REDACTED]')
    .replace(/\/(?:Users|home|tmp|private|var|opt|etc)\/[^\s,;)]+/gu, '[REDACTED]')
    .replace(/[A-Za-z]:\\[^\s,;)]+/gu, '[REDACTED]')
    .trim();
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => message !== null && message !== undefined)
    .map(sanitizeDiagnostic)
    .filter(Boolean);
}

export function createSourceStatus({
  sourceId,
  channel,
  sourceName,
  candidateCount = 0,
  failedCandidateCount = 0,
  warnings = [],
  errors = [],
  equivalentFallbackSucceeded = false,
  discoveryComplete = true,
}) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw new TypeError('sourceId is required');
  if (!ENABLED_CHANNELS.includes(channel)) throw new TypeError(`Unknown source channel: ${channel}`);
  if (typeof sourceName !== 'string' || sourceName.length === 0) throw new TypeError('sourceName is required');
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) throw new TypeError('candidateCount must be a non-negative integer');
  if (!Number.isSafeInteger(failedCandidateCount) || failedCandidateCount < 0) {
    throw new TypeError('failedCandidateCount must be a non-negative integer');
  }

  const cleanErrors = cleanMessages(errors);
  const cleanWarnings = cleanMessages(warnings);
  if (equivalentFallbackSucceeded) cleanWarnings.push(...cleanErrors);

  const hasLoss = failedCandidateCount > 0 || !discoveryComplete
    || (cleanErrors.length > 0 && !equivalentFallbackSucceeded);
  const status = candidateCount > 0
    ? (hasLoss ? 'partial' : 'ok')
    : (hasLoss ? 'error' : 'no-results');
  const result = {
    sourceId,
    channel,
    sourceName,
    status,
    candidateCount,
    ...(failedCandidateCount > 0 ? { failedCandidateCount } : {}),
    ...(cleanWarnings.length > 0 ? { warnings: cleanWarnings } : {}),
  };
  if (status === 'partial' || status === 'error') {
    const details = cleanErrors.length > 0
      ? cleanErrors
      : [failedCandidateCount > 0 ? `${failedCandidateCount} candidate(s) failed` : 'discovery completeness could not be established'];
    result.errorSummary = `${sourceName}: ${details.join('; ')}`;
  }
  return result;
}

function expectedNamespace(channel) {
  if (channel === 'podcasts') return 'podcast';
  if (channel === 'blogs') return 'blog';
  if (channel === 'newsletters') return 'newsletter';
  return channel;
}

function normalizeExpectedSource(source, index) {
  const sourceId = source?.id ?? source?.sourceId;
  if (typeof sourceId !== 'string' || sourceId.length === 0
    || typeof source?.channel !== 'string') {
    throw new TypeError(`expectedRegistry[${index}] requires id and channel`);
  }
  if (!ENABLED_CHANNELS.includes(source.channel)) {
    throw new TypeError(`expectedRegistry[${index}] has unknown channel ${source.channel}`);
  }
  if (!sourceId.startsWith(`${expectedNamespace(source.channel)}:`)) {
    throw new TypeError(`expectedRegistry[${index}] source namespace does not match channel`);
  }
  return { sourceId, channel: source.channel };
}

export function summarizeChannelCompleteness(statuses, expectedRegistry, channels) {
  if (!Array.isArray(statuses)) throw new TypeError('statuses must be an array');
  if (!Array.isArray(expectedRegistry)) throw new TypeError('expectedRegistry must be an array');
  const expectedSources = expectedRegistry.map(normalizeExpectedSource);
  const expectedIds = expectedSources.map(({ sourceId }) => sourceId);
  if (new Set(expectedIds).size !== expectedIds.length) {
    throw new TypeError('expectedRegistry contains duplicate source IDs');
  }
  const requestedChannels = channels ?? ENABLED_CHANNELS.filter((channel) => (
    expectedSources.some((source) => source.channel === channel)
  ));

  return requestedChannels.map((channel) => {
    const channelSources = expectedSources.filter((source) => source.channel === channel);
    const incompleteSourceIds = channelSources
      .filter(({ sourceId }) => {
        const matches = statuses.filter((status) => status?.sourceId === sourceId);
        return matches.length !== 1
          || matches[0].channel !== channel
          || !COMPLETE_STATUSES.has(matches[0].status);
      })
      .map(({ sourceId }) => sourceId);
    return {
      channel,
      complete: channelSources.length > 0 && incompleteSourceIds.length === 0,
      sourceCount: channelSources.length,
      incompleteSourceIds,
    };
  });
}
