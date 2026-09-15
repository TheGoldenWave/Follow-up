import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

import { canonicalizeUrl } from './candidate-identity.js';
import { isMainModule } from './command-line.js';
import { loadMigrationState, sourceVerdict, validateSourceId } from './lib/migration-state.js';
import { validateSignalBatch } from './lib/publish-batches.js';
import { duplicateRate } from './lib/migration-metrics.js';

export const USER_DIR = join(homedir(), '.follow-builders');

const FAILURE_STATUSES = new Set([
  'rate-limited', 'auth-failed', 'unreachable', 'timeout',
  'schema-drift', 'skipped-unconfigured', 'error',
]);
const SAFE_RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;

async function readBounded(path, limit) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('unsafe durable pointer file');
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const part = await handle.read(buffer, total, Math.min(64 * 1024, buffer.length - total), total);
      if (!part.bytesRead) break;
      total += part.bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1
        || after.size !== before.size || total !== before.size || total > limit) throw new Error('durable pointer file changed');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

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
    relevance_met: Number.isFinite(metrics.relevance) && metrics.relevance >= 0.8 && metrics.relevance <= 1,
    run_threshold_met: metrics.runCount >= 3,
    contracts_ok: metrics.contractsOk === true,
    secrets_clean: metrics.secretsClean === true,
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
export function computeShadowReport({ localBatches, centralFeed, history = {}, evidence = {}, migrationState, now }) {
  const centralCandidates = centralFeed?.candidates ?? [];
  const centralBySource = new Map();
  for (const candidate of centralCandidates) {
    const list = centralBySource.get(candidate.sourceId) ?? [];
    list.push(candidate);
    centralBySource.set(candidate.sourceId, list);
  }

  const sources = [];
  const sourceIds = new Set([...Object.keys(localBatches), ...Object.keys(migrationState?.sources ?? {})]);
  for (const source of sourceIds) {
    const batch = localBatches[source] ?? { items: [], source_status: { status: 'error' } };
    const runs = new Map((history[source] ?? []).map(run => [run.batchId, run]));
    if (batch.batch_id) runs.set(batch.batch_id, { batchId: batch.batch_id, status: batch.source_status?.status ?? 'error' });
    const statuses = [...runs.values()].map(run => run.status);
    const items = batch.items ?? [];
    const metrics = {
      source,
      overlapRate: overlapRate(items, centralBySource.get(source) ?? [], source),
      duplicateRate: duplicateRate(items, source),
      errorRate: statuses.length ? statuses.filter((status) => FAILURE_STATUSES.has(status)).length / statuses.length : 0,
      runCount: runs.size,
      streak: runStreak(statuses),
      relevance: evidence[source]?.relevance ?? null,
      contractsOk: evidence[source]?.contractsOk === true,
      secretsClean: evidence[source]?.secretsClean === true,
      secretsLeaked: evidence[source]?.secretsLeaked === true,
      statuses,
    };
    const persisted = migrationState?.sources?.[source];
    const verdict = persisted ? sourceVerdict(persisted, now) : null;
    if (verdict) {
      verdict.cutover.latest_batch_available = !!batch.batch_id && batch.batch_id === persisted.runs.at(-1)?.batchId;
      verdict.cutover.passed &&= verdict.cutover.latest_batch_available;
    }
    if (persisted) {
      metrics.relevance = verdict.relevance;
      metrics.runCount = persisted.runs.length;
      metrics.statuses = persisted.runs.map(run => run.status);
      metrics.errorRate = metrics.statuses.length ? metrics.statuses.filter(status => FAILURE_STATUSES.has(status)).length / metrics.statuses.length : 0;
      metrics.streak = runStreak(metrics.statuses);
      metrics.contractsOk = persisted.runs.at(-1)?.contractsOk === true;
      metrics.secretsClean = persisted.runs.at(-1)?.secretsClean === true;
    }
    sources.push({
      source,
      metrics,
      cutover: verdict?.cutover ?? { ...cutoverVerdict(metrics), observation_complete: false, passed: false },
      rollback: verdict?.rollback ?? rollbackVerdict(metrics),
    });
  }
  return { sources };
}

export async function loadLatestBatches(acquisitionDir) {
  let names;
  try { names = await fs.readdir(join(acquisitionDir, 'latest')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const batches = {};
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const source = name.slice(0, -5);
    validateSourceId(source);
    const pointer = JSON.parse((await readBounded(join(acquisitionDir, 'latest', name), 64 * 1024)).toString('utf8'));
    const legacy = exactKeys(pointer, ['run_id', 'batch_id', 'generated_at', 'path']);
    const current = exactKeys(pointer, ['schema_version', 'run_id', 'batch_id', 'generated_at', 'path',
      'batch_sha256', 'run_manifest_sha256', 'intent_sha256']) && pointer.schema_version === '1.0';
    if (!legacy && !current) throw new Error('invalid latest pointer shape');
    if (!SAFE_RUN.test(pointer.run_id) || (current && ![pointer.batch_sha256, pointer.run_manifest_sha256, pointer.intent_sha256].every(value => HASH.test(value)))) {
      throw new Error('invalid latest pointer binding');
    }
    const root = await fs.realpath(join(acquisitionDir, 'runs'));
    const expected = join(acquisitionDir, 'runs', pointer.run_id, `${source}.json`);
    if (resolve(pointer.path) !== resolve(expected)) throw new Error('invalid latest batch path');
    const path = await fs.realpath(resolve(pointer.path));
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid latest batch path');
    let manifestEntry;
    if (current) {
      const runDir = join(acquisitionDir, 'runs', pointer.run_id);
      const manifestBytes = await readBounded(join(runDir, 'run.json'), 1024 * 1024);
      if (digest(manifestBytes) !== pointer.run_manifest_sha256) throw new Error('invalid run manifest hash');
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      const entry = manifest.sources?.[source];
      manifestEntry = entry;
      if (manifest.run_id !== pointer.run_id || manifest.checkpoint_intent?.sha256 !== pointer.intent_sha256
          || entry?.filename !== `${source}.json` || entry?.sha256 !== pointer.batch_sha256
          || entry?.batch_id !== pointer.batch_id) throw new Error('invalid run manifest linkage');
      const intentBytes = await readBounded(join(runDir, 'checkpoint-intent.json'), 1024 * 1024);
      if (digest(intentBytes) !== pointer.intent_sha256) throw new Error('invalid published intent hash');
    }
    const batchBytes = await readBounded(path, 10 * 1024 * 1024);
    if (current && digest(batchBytes) !== pointer.batch_sha256) throw new Error('invalid published batch hash');
    const batch = JSON.parse(batchBytes.toString('utf8'));
    if (!validateSignalBatch(batch).valid || batch.source !== source || batch.batch_id !== pointer.batch_id || batch.generated_at !== pointer.generated_at) throw new Error('invalid latest batch');
    if (current && manifestEntry.status !== batch.source_status.status) throw new Error('invalid batch status linkage');
    batches[source] = batch;
  }
  return batches;
}

export async function main({ stdout = process.stdout, userDir = USER_DIR, now } = {}) {
  const acquisitionDir = join(userDir, 'acquisition');
  const batches = await loadLatestBatches(acquisitionDir);
  let centralFeed = { candidates: [] };
  try {
    centralFeed = JSON.parse(await fs.readFile(join(userDir, 'feed-candidates.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // No local central feed copy; overlap is reported as zero against empty central.
  }
  const state = await loadMigrationState(join(acquisitionDir, 'migration.json'));
  const history = Object.fromEntries(Object.entries(state.sources).map(([id, source]) => [id, source.runs]));
  const evidence = Object.fromEntries(Object.entries(state.sources).map(([id, source]) => [id, source.evidence ?? {}]));
  const report = computeShadowReport({ localBatches: batches, centralFeed, history, evidence, migrationState: state, now });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
