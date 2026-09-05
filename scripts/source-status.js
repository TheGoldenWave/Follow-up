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

export function summarizeChannelCompleteness(statuses, channels) {
  if (!Array.isArray(statuses)) throw new TypeError('statuses must be an array');
  const requestedChannels = channels ?? ENABLED_CHANNELS.filter((channel) => (
    statuses.some((status) => status.channel === channel)
  ));

  return requestedChannels.map((channel) => {
    const sourceStatuses = statuses.filter((status) => status.channel === channel);
    const incompleteSourceIds = sourceStatuses
      .filter(({ status }) => !COMPLETE_STATUSES.has(status))
      .map(({ sourceId }) => sourceId);
    return {
      channel,
      complete: sourceStatuses.length > 0 && incompleteSourceIds.length === 0,
      sourceCount: sourceStatuses.length,
      incompleteSourceIds,
    };
  });
}
