// Combine central and local acquisition inputs according to the configured mode.
// `central` is the migration-safe default; local Signal Batches only replace or
// augment central candidates once a source is observed and cut over.

export const ACQUISITION_MODES = Object.freeze(['central', 'shadow', 'hybrid', 'local']);

export function normalizeAcquisitionMode(value) {
  if (value === undefined || value === null || value === '') return 'central';
  if (!ACQUISITION_MODES.includes(value)) {
    throw new TypeError(`Unknown acquisition mode "${value}"`);
  }
  return value;
}

// Local statuses that are authoritative during hybrid observation. A local
// `no-results` is a genuine empty result and must not fall back to central.
const LOCAL_AUTHORITATIVE = new Set(['ok', 'no-results', 'partial']);
function failureStatus(sourceId, metadata, message) {
  return { sourceId, channel: metadata?.channel ?? 'blogs', sourceName: metadata?.sourceName ?? sourceId, candidateCount: 0, status: 'error', errorSummary: message };
}

/**
 * Resolve the effective candidates and source statuses for one run.
 *
 * @param {object} options
 * @param {string} options.mode - central | shadow | hybrid | local
 * @param {{candidates: object[], registry: object[]}} options.central
 * @param {{candidates: object[], sourceStatuses: object[]}} options.local
 * @returns {{mode: string, candidates: object[], sourceStatuses: object[], shadow?: object}}
 */
export function combineAcquisitionInput({ mode, central, local, migrationState }) {
  const normalized = normalizeAcquisitionMode(mode);
  const centralCandidates = central?.candidates ?? [];
  const centralStatuses = central?.registry ?? [];
  const localCandidates = local?.candidates ?? [];
  const localStatuses = local?.sourceStatuses ?? [];

  if (normalized === 'central') {
    return { mode: normalized, candidates: centralCandidates, sourceStatuses: centralStatuses };
  }
  if (normalized === 'local') {
    const quarantined = new Map(Object.entries(migrationState?.sources ?? {}).filter(([, route]) => route.input === 'central' && route.rollback_reason));
    const sourceStatuses = localStatuses.map(status => quarantined.has(status.sourceId) ? failureStatus(status.sourceId, status, `migration-rollback:${quarantined.get(status.sourceId).rollback_reason}`) : status);
    for (const [sourceId, route] of quarantined) if (!sourceStatuses.some(status => status.sourceId === sourceId)) sourceStatuses.push(failureStatus(sourceId, centralStatuses.find(status => status.sourceId === sourceId), `migration-rollback:${route.rollback_reason}`));
    return { mode: normalized, candidates: localCandidates.filter(candidate => !quarantined.has(candidate.sourceId)), sourceStatuses };
  }
  if (normalized === 'shadow') {
    // Deliver central only; keep local candidates out of the Digest and attach
    // them for diagnostics/metrics reporting.
    return {
      mode: normalized,
      candidates: centralCandidates,
      sourceStatuses: centralStatuses,
      shadow: local,
    };
  }

  // hybrid: local ok/no-results/partial is authoritative; any failure falls back
  // to central for that source.
  const authoritativeSources = new Set(
    localStatuses
      .filter((status) => {
        const route = migrationState?.sources?.[status.sourceId];
        if (route?.input === 'central' && route.rollback_reason) return false;
        return route?.input === 'local' || LOCAL_AUTHORITATIVE.has(status.status);
      })
      .map((status) => status.sourceId),
  );
  for (const [id, route] of Object.entries(migrationState?.sources ?? {})) if (route.input === 'local') authoritativeSources.add(id);
  const visibleLocalStatuses = [...localStatuses];
  for (const id of authoritativeSources) {
    if (!visibleLocalStatuses.some(status => status.sourceId === id)) visibleLocalStatuses.push(failureStatus(id, centralStatuses.find(status => status.sourceId === id), 'local-batch-unavailable'));
  }
  const candidates = [
    ...localCandidates.filter((candidate) => authoritativeSources.has(candidate.sourceId) && LOCAL_AUTHORITATIVE.has(visibleLocalStatuses.find(status => status.sourceId === candidate.sourceId)?.status)),
    ...centralCandidates.filter((candidate) => !authoritativeSources.has(candidate.sourceId)),
  ];
  const sourceStatuses = [
    ...visibleLocalStatuses.filter((status) => authoritativeSources.has(status.sourceId)),
    ...centralStatuses.filter((status) => !authoritativeSources.has(status.sourceId)),
  ];
  return { mode: normalized, candidates, sourceStatuses };
}
