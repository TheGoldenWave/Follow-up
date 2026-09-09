import { createContentFingerprint } from '../candidate-identity.js';

const DAY_MS = 86_400_000;
const AUTHORITATIVE = new Set(['ok', 'no-results', 'partial']);

export function updateLocalPool(previous, current, now) {
  const cutoff = Date.parse(now) - 90 * DAY_MS;
  const textCutoff = Date.parse(now) - 7 * DAY_MS;
  const prior = new Map((previous?.candidates ?? []).map(item => [item.candidateId, item]));
  const candidates = new Map(prior);
  for (const candidate of current.candidates) {
    const existing = prior.get(candidate.candidateId);
    candidates.set(candidate.candidateId, { ...candidate,
      firstSeenAt: existing?.firstSeenAt ?? candidate.firstSeenAt,
    });
  }
  const retained = [...candidates.values()]
    .filter(candidate => Date.parse(candidate.lastSeenAt) >= cutoff)
    .map(candidate => {
      if (Date.parse(candidate.lastSeenAt) >= textCutoff) return candidate;
      const expired = { ...candidate, summarizationContent: '', contentTruncated: true };
      return { ...expired, contentFingerprint: createContentFingerprint(expired) };
    });
  return {
    schemaVersion: '1.0', generatedAt: now,
    continuousHistorySince: new Date(Math.max(Date.parse(previous?.continuousHistorySince ?? now), cutoff)).toISOString(),
    candidates: retained,
  };
}

export function localInputForRun(pool, sourceStatuses) {
  const activeSources = new Set(sourceStatuses.filter(source => AUTHORITATIVE.has(source.status)).map(source => source.sourceId));
  const candidates = pool.candidates.filter(candidate => activeSources.has(candidate.sourceId));
  const counts = new Map();
  for (const candidate of candidates) counts.set(candidate.sourceId, (counts.get(candidate.sourceId) ?? 0) + 1);
  return {
    candidates,
    continuousHistorySince: pool.continuousHistorySince,
    sourceStatuses: sourceStatuses.map(source => {
      const candidateCount = counts.get(source.sourceId) ?? 0;
      return { ...source, candidateCount,
        status: source.status === 'no-results' && candidateCount ? 'ok' : source.status,
      };
    }),
  };
}
