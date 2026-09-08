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

/**
 * Resolve the effective candidates and source statuses for one run.
 *
 * @param {object} options
 * @param {string} options.mode - central | shadow | hybrid | local
 * @param {{candidates: object[], registry: object[]}} options.central
 * @param {{candidates: object[], sourceStatuses: object[]}} options.local
 * @returns {{mode: string, candidates: object[], sourceStatuses: object[], shadow?: object}}
 */
export function combineAcquisitionInput({ mode, central, local }) {
  const normalized = normalizeAcquisitionMode(mode);
  const centralCandidates = central?.candidates ?? [];
  const centralStatuses = central?.registry ?? [];
  const localCandidates = local?.candidates ?? [];
  const localStatuses = local?.sourceStatuses ?? [];

  if (normalized === 'central') {
    return { mode: normalized, candidates: centralCandidates, sourceStatuses: centralStatuses };
  }
  if (normalized === 'local') {
    return { mode: normalized, candidates: localCandidates, sourceStatuses: localStatuses };
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
      .filter((status) => LOCAL_AUTHORITATIVE.has(status.status))
      .map((status) => status.sourceId),
  );
  const candidates = [
    ...localCandidates.filter((candidate) => authoritativeSources.has(candidate.sourceId)),
    ...centralCandidates.filter((candidate) => !authoritativeSources.has(candidate.sourceId)),
  ];
  const sourceStatuses = [
    ...localStatuses.filter((status) => authoritativeSources.has(status.sourceId)),
    ...centralStatuses.filter((status) => !authoritativeSources.has(status.sourceId)),
  ];
  return { mode: normalized, candidates, sourceStatuses };
}
