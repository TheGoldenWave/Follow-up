import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { writeJsonAtomic } from '../prepare-digest.js';
import { duplicateRate } from './migration-metrics.js';

const DAY_MS = 86_400_000;
const SUCCESS = new Set(['ok', 'no-results', 'partial']);
const STATUSES = new Set([...SUCCESS, 'rate-limited', 'auth-failed', 'unreachable', 'timeout', 'schema-drift', 'skipped-unconfigured', 'error']);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function validateSourceId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) throw new Error('invalid migration source ID');
}
export function validateMigrationState(state) {
  if (state?.schemaVersion !== '1.0' || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)) throw new Error('invalid migration state');
  for (const [id, source] of Object.entries(state.sources)) {
    validateSourceId(id);
    if (!source || !['central', 'local'].includes(source.input) || !date(source.observation_started_at) || !date(source.observation_until) || Date.parse(source.observation_until) < Date.parse(source.observation_started_at) + 14 * DAY_MS || !Array.isArray(source.runs)) throw new Error('invalid migration source state');
    const seen = new Set();
    let previousTime = -Infinity;
    for (const key of ['cutover_at', 'last_success_at']) if (source[key] !== null && !date(source[key])) throw new Error('invalid migration timestamp');
    if (source.rollback_reason !== null && (typeof source.rollback_reason !== 'string' || !source.rollback_reason)) throw new Error('invalid migration rollback reason');
    for (const run of source.runs) {
      if (typeof run.batchId !== 'string' || !run.batchId || seen.has(run.batchId) || !date(run.generatedAt) || !STATUSES.has(run.status)) throw new Error('invalid migration run');
      seen.add(run.batchId);
      if (Date.parse(run.generatedAt) < previousTime) throw new Error('migration history must be chronological');
      previousTime = Date.parse(run.generatedAt);
      if (run.candidateIds !== undefined && (!Array.isArray(run.candidateIds) || run.candidateIds.some(id => typeof id !== 'string'))) throw new Error('invalid migration candidate IDs');
      for (const key of ['contractsOk', 'secretsClean', 'secretsLeaked']) if (run[key] !== undefined && typeof run[key] !== 'boolean') throw new Error('invalid migration checks');
      if (run.duplicateRate !== undefined && (!Number.isFinite(run.duplicateRate) || run.duplicateRate < 0 || run.duplicateRate > 1)) throw new Error('invalid duplicate rate');
    }
    if (source.review) validateReview(source, source.review);
  }
  return state;
}

export async function loadMigrationState(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.schemaVersion !== '1.0' || !value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)) {
      throw new Error('invalid migration state');
    }
    return validateMigrationState(value);
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: '1.0', sources: {} };
    throw error;
  }
}

export async function saveMigrationState(path, state) {
  await writeJsonAtomic(path, validateMigrationState(state), { label: 'migration state' });
}

export async function updateMigrationState(path, updater) {
  await mkdir(dirname(path), { recursive: true });
  let unlock;
  try { unlock = await lockfile.lock(path, { realpath: false, retries: 0, stale: 60_000, update: 10_000 }); }
  catch (error) { if (error.code === 'ELOCKED') throw new Error('migration state is locked by another operation'); throw error; }
  try {
    const state = await updater(await loadMigrationState(path));
    await saveMigrationState(path, state);
    return state;
  } finally { await unlock(); }
}

export function recordRun(previous, batches, { now, checks = {} } = {}) {
  const state = structuredClone(validateMigrationState(previous ?? { schemaVersion: '1.0', sources: {} }));
  for (const batch of batches) {
    validateSourceId(batch.source);
    if (!date(batch.generated_at) || typeof batch.batch_id !== 'string' || !batch.batch_id || !STATUSES.has(batch.source_status?.status)) throw new Error('invalid migration batch');
    const source = state.sources[batch.source] ?? {
      input: 'central', cutover_at: null, rollback_reason: null,
      observation_started_at: batch.generated_at,
      observation_until: new Date(Date.parse(batch.generated_at) + 14 * DAY_MS).toISOString(),
      last_success_at: null, runs: [],
    };
    if (SUCCESS.has(batch.source_status.status) && checks[batch.source]?.contractsOk === true && checks[batch.source]?.secretsClean === true && !checks[batch.source]?.secretsLeaked && !source.runs.some(run => SUCCESS.has(run.status) && run.contractsOk && run.secretsClean && !run.secretsLeaked)) {
      source.observation_started_at = batch.generated_at;
      source.observation_until = new Date(Date.parse(batch.generated_at) + 14 * DAY_MS).toISOString();
    }
    if (!source.runs.some(run => run.batchId === batch.batch_id)) {
      const candidateIds = (batch.items ?? []).map(item => item.candidate_id);
      source.runs.push({ batchId: batch.batch_id, generatedAt: batch.generated_at, status: batch.source_status.status, candidateIds,
        duplicateRate: duplicateRate(batch.items ?? [], batch.source),
        contractsOk: checks[batch.source]?.contractsOk === true,
        secretsClean: checks[batch.source]?.secretsClean === true,
        secretsLeaked: checks[batch.source]?.secretsLeaked === true });
    }
    source.runs.sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt) || a.batchId.localeCompare(b.batchId));
    const cutoff = Date.parse(now ?? source.runs.at(-1).generatedAt) - 90 * DAY_MS;
    source.runs = source.runs.filter(run => Date.parse(run.generatedAt) >= cutoff);
    if (source.review && !source.runs.some(run => run.batchId === source.review.batchId)) delete source.review;
    source.last_success_at = source.runs.filter(run => SUCCESS.has(run.status)).at(-1)?.generatedAt ?? null;
    state.sources[batch.source] = source;
  }
  return validateMigrationState(state);
}

function validateReview(source, review) {
  const run = source.runs.find(run => run.batchId === review.batchId);
  if (!run || typeof review.reviewer !== 'string' || !review.reviewer.trim() || !date(review.reviewedAt) || Date.parse(review.reviewedAt) < Date.parse(run.generatedAt) || !Array.isArray(review.items) || !review.items.length) throw new Error('invalid review evidence');
  const ids = new Set();
  for (const item of review.items) {
    if (!run.candidateIds?.includes(item.candidateId) || typeof item.relevant !== 'boolean' || ids.has(item.candidateId)) throw new Error('invalid review candidate evidence');
    ids.add(item.candidateId);
  }
}
export function recordReview(previous, sourceId, review) {
  validateSourceId(sourceId);
  const state = structuredClone(validateMigrationState(previous));
  const source = state.sources[sourceId];
  if (!source) throw new Error('source observation is unavailable');
  validateReview(source, review);
  source.review = structuredClone(review);
  return state;
}
export function sourceVerdict(source, now = new Date().toISOString()) {
  const runs = source.runs.filter(run => Date.parse(run.generatedAt) >= Date.parse(now) - 90 * DAY_MS && Date.parse(run.generatedAt) <= Date.parse(now));
  const latest = runs.at(-1);
  const review = source.review;
  const relevance = review ? review.items.filter(item => item.relevant).length / review.items.length : null;
  const currentReview = review && review.batchId === latest?.batchId && Date.parse(review.reviewedAt) <= Date.parse(now);
  const gates = {
    observation_complete: runs.some(run => SUCCESS.has(run.status) && run.contractsOk && run.secretsClean && !run.secretsLeaked) && date(now) && Date.parse(now) >= Date.parse(source.observation_until),
    run_threshold_met: runs.filter(run => SUCCESS.has(run.status) && run.contractsOk && run.secretsClean && !run.secretsLeaked).length >= 3,
    duplicates_absent: latest?.duplicateRate === 0,
    relevance_met: !!currentReview && relevance >= 0.8,
    contracts_ok: !!latest && SUCCESS.has(latest.status) && latest.contractsOk === true,
    secrets_clean: !!latest && latest.secretsClean === true && !latest.secretsLeaked,
  };
  gates.passed = Object.values(gates).every(Boolean);
  let rollback = null;
  if (latest?.secretsLeaked) rollback = 'secret-leak';
  else if (runs.length >= 2 && runs.slice(-2).every(run => !SUCCESS.has(run.status))) rollback = 'consecutive-failures';
  else if (latest?.duplicateRate > 0.05) rollback = 'duplicates';
  else if (currentReview && relevance < 0.8) rollback = 'relevance';
  return { cutover: gates, rollback, relevance: currentReview ? relevance : null };
}
export function switchSource(previous, sourceId, { input, now = new Date().toISOString(), rollbackReason } = {}) {
  validateSourceId(sourceId);
  const state = structuredClone(validateMigrationState(previous));
  const source = state.sources[sourceId];
  if (!source) throw new Error('source observation is unavailable');
  if (!['central', 'local'].includes(input)) throw new Error('unsupported source input');
  if (input === 'local') {
    const verdict = sourceVerdict(source, now);
    if (!verdict.cutover.observation_complete) throw new Error('source observation is incomplete');
    if (!verdict.cutover.passed || verdict.rollback) throw new Error('source cutover gates failed');
    source.cutover_at = now;
    source.rollback_reason = null;
  } else {
    source.rollback_reason = rollbackReason ?? 'manual';
  }
  source.input = input;
  return state;
}

export function applyRollbacks(previous, { now = new Date().toISOString() } = {}) {
  const state = structuredClone(validateMigrationState(previous));
  for (const source of Object.values(state.sources)) {
    const reason = sourceVerdict(source, now).rollback;
    if (source.input === 'local' && reason) { source.input = 'central'; source.rollback_reason = reason; }
  }
  return state;
}
