import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

import { canonicalizeUrl } from './candidate-identity.js';
import { isMainModule } from './command-line.js';
import { loadCollectedBatches } from './lib/run-acquisition.js';

export const USER_DIR = join(homedir(), '.follow-builders');

const FAILURE_STATUSES = new Set([
  'rate-limited', 'auth-failed', 'unreachable', 'timeout',
  'schema-drift', 'skipped-unconfigured', 'error',
]);

function nativeIdOf(candidateId, source) {
  const prefix = `${source}:`;
  return typeof candidateId === 'string' && candidateId.startsWith(prefix)
    ? candidateId.slice(prefix.length)
    : candidateId;
}

function localKey(item, source) {
  return { native: nativeIdOf(item.candidate_id, source), url: canonicalizeUrl(item.url) };
}

function centralKey(candidate) {
  return {
    native: candidate.sourceNativeId ?? null,
    url: candidate.canonicalUrl ?? canonicalizeUrl(candidate.url),
  };
}

function matches(local, centralSet) {
  if (local.native && centralSet.has(`n:${local.native}`)) return true;
  if (local.url && centralSet.has(`u:${local.url}`)) return true;
  return false;
}

function overlapRate(localItems, centralItems, source) {
  if (localItems.length === 0) return 1;
  const central = new Set(centralItems.flatMap((candidate) => {
    const key = centralKey(candidate);
    return [
      ...(key.native ? [`n:${key.native}`] : []),
      ...(key.url ? [`u:${key.url}`] : []),
    ];
  }));
  return localItems.filter((item) => matches(localKey(item, source), central)).length / localItems.length;
}

function duplicateRate(localItems, source) {
  if (localItems.length === 0) return 0;
  const seen = new Set();
  let duplicates = 0;
  for (const item of localItems) {
    const key = localKey(item, source);
    const fingerprint = `${key.native ?? ''}\0${key.url ?? ''}`;
    if (seen.has(fingerprint)) duplicates += 1;
    seen.add(fingerprint);
  }
  return duplicates / localItems.length;
}

function runStreak(statuses) {
  let streak = 0;
  for (let index = statuses.length - 1; index >= 0; index -= 1) {
    if (FAILURE_STATUSES.has(statuses[index])) break;
    streak += 1;
  }
  return streak;
}

function cutoverVerdict(metrics) {
  const gates = {
    duplicates_absent: metrics.duplicateRate === 0,
    relevance_met: metrics.relevance === null || metrics.relevance >= 0.8,
  };
  gates.passed = Object.values(gates).every(Boolean);
  return gates;
}

function rollbackVerdict(metrics) {
  if (metrics.secretsLeaked) return 'secret-leak';
  const statuses = metrics.statuses ?? [];
  if (statuses.length >= 2
    && FAILURE_STATUSES.has(statuses[statuses.length - 1])
    && FAILURE_STATUSES.has(statuses[statuses.length - 2])) {
    return 'consecutive-failures';
  }
  if (metrics.duplicateRate > 0.05) return 'duplicates';
  if (metrics.relevance !== null && metrics.relevance < 0.8) return 'relevance';
  return null;
}

/**
 * Compute per-source shadow-comparison metrics between local batches and the
 * central candidate Feed, plus cutover and rollback verdicts.
 */
export function computeShadowReport({ localBatches, centralFeed }) {
  const centralCandidates = centralFeed?.candidates ?? [];
  const centralBySource = new Map();
  for (const candidate of centralCandidates) {
    const list = centralBySource.get(candidate.sourceId) ?? [];
    list.push(candidate);
    centralBySource.set(candidate.sourceId, list);
  }

  const sources = [];
  for (const [source, batch] of Object.entries(localBatches)) {
    const statuses = [batch.source_status?.status ?? 'error'];
    const items = batch.items ?? [];
    const metrics = {
      source,
      overlapRate: overlapRate(items, centralBySource.get(source) ?? [], source),
      duplicateRate: duplicateRate(items, source),
      errorRate: statuses.filter((status) => FAILURE_STATUSES.has(status)).length / statuses.length,
      runCount: 1,
      streak: runStreak(statuses),
      relevance: null,
      secretsLeaked: false,
      statuses,
    };
    sources.push({
      source,
      metrics,
      cutover: cutoverVerdict(metrics),
      rollback: rollbackVerdict(metrics),
    });
  }
  return { sources };
}

async function main({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const acquisitionDir = join(USER_DIR, 'acquisition');
  let batches = {};
  let centralFeed = { candidates: [] };
  try {
    batches = await loadCollectedBatches({ outputDir: acquisitionDir });
  } catch {
    // No local run yet; report an empty shadow comparison.
  }
  try {
    centralFeed = JSON.parse(await readFile(join(USER_DIR, 'feed-candidates.json'), 'utf8'));
  } catch {
    // No local central feed copy; overlap is reported as zero against empty central.
  }
  const report = computeShadowReport({ localBatches: batches, centralFeed });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
