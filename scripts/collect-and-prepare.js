#!/usr/bin/env node

import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID as systemRandomUUID } from 'node:crypto';
import { readFile, mkdir, rm } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

import { isMainModule } from './command-line.js';
import { normalizeAcquisitionMode } from './lib/resolve-acquisition-input.js';
import { invokeAcquisitionRun, loadCollectedBatches } from './lib/run-acquisition.js';
import { publishBatchRun, publishLatestPointers } from './lib/publish-batches.js';
import { main as prepareMain, parseOptions, writeJsonAtomic } from './prepare-digest.js';
import { updateLocalPool, localInputForRun } from './lib/local-candidate-store.js';
import { loadSignalBatches } from './lib/load-signal-batches.js';
import { normalizeConfig } from './config-contract.js';
import { authorizeSchedule } from './schedule-gate.js';
import { recordRun, applyRollbacks, updateMigrationState } from './lib/migration-state.js';
import { scanBuffer } from './release/scan-secrets.js';
import { cleanAcquisitionHistory } from './lib/acquisition-retention.js';

export const USER_DIR = join(homedir(), '.follow-builders');

/**
 * Single on-demand and scheduled acquisition entry point. In `central` mode it
 * skips local collection entirely; otherwise it invokes the Python runtime,
 * validates and atomically publishes each batch under `runs/<run_id>/`, and
 * updates per-source `latest.json` pointers.
 */
export async function collectAndPrepare({
  config = {},
  now = new Date().toISOString(),
  randomUUID = systemRandomUUID,
  userDir = USER_DIR,
  invokeRun = invokeAcquisitionRun,
  loadBatches = loadCollectedBatches,
  publishRun = publishBatchRun,
  publishPointers = publishLatestPointers,
  prepare,
  validateBatches,
  onUnsafeBatches,
} = {}) {
  const mode = normalizeAcquisitionMode(config.acquisition?.mode);
  if (mode === 'central') {
    return { mode, collected: false, ...(prepare ? { prepared: await prepare({ mode, batches: {} }) } : {}) };
  }

  const acquisitionDir = join(userDir, 'acquisition');
  const runsDir = join(acquisitionDir, 'runs');
  const latestDir = join(acquisitionDir, 'latest');

  const runId = `${now.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const outputDir = join(acquisitionDir, 'staging', runId);
  await invokeRun({ outputDir, env: { ...process.env, HOME: join(userDir, '..') } });
  const batches = await loadBatches({ outputDir });
  if (validateBatches) await validateBatches(batches);
  if (Object.entries(batches).some(([id, batch]) => scanBuffer(id, Buffer.from(JSON.stringify(batch))).length)) {
    if (onUnsafeBatches) await onUnsafeBatches(batches);
    await rm(outputDir, { recursive: true, force: true });
    throw new Error('unsafe acquisition output');
  }

  await publishRun(batches, { runsDir, runId, randomUUID });
  await publishPointers(batches, { runsDir, latestDir, runId, randomUUID });

  return { mode, collected: true, runId, batchCount: Object.keys(batches).length, batches,
    ...(prepare ? { prepared: await prepare({ mode, batches, runId }) } : {}) };
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr,
  userDir = USER_DIR, now = new Date().toISOString(), invokeRun = invokeAcquisitionRun,
  preparation = {},
} = {}) {
  try {
    const options = parseOptions(argv);
    const config = JSON.parse(await readFile(join(userDir, 'config.json'), 'utf8'));
    const normalized = normalizeConfig(config);
    if (options.scheduled) {
      const gate = authorizeSchedule(normalized, { now, frequency: options.frequency ?? normalized.schedule?.frequency ?? config.frequency ?? 'daily' });
      if (!gate.authorized && gate.status !== 'no-channels') throw new Error('schedule-not-authorized');
    } else if (!normalized.onboardingComplete) throw new Error('onboarding-required');
    if (!normalized.enabledChannels.length) return prepareMain({ argv, stdout, stderr, config, now });
    const sources = JSON.parse(await readFile(new URL('../config/sources.json', import.meta.url), 'utf8'));
    const acquisitionDir = join(userDir, 'acquisition');
    await mkdir(acquisitionDir, { recursive: true, mode: 0o700 });
    const unlock = await lockfile.lock(acquisitionDir, { realpath: true, retries: 0, stale: 60_000, update: 10_000 });
    try {
      await cleanAcquisitionHistory(acquisitionDir, now);
      const result = await collectAndPrepare({ config, now, userDir, invokeRun,
        validateBatches: batches => loadSignalBatches(Object.values(batches), { sources: sources.sources, seenAt: now }),
        onUnsafeBatches: async batches => {
          const unsafe = Object.entries(batches).filter(([id, batch]) => scanBuffer(id, Buffer.from(JSON.stringify(batch))).length);
          const sanitized = unsafe.map(([source, batch]) => ({ source, batch_id: batch.batch_id, generated_at: now, items: [], source_status: { status: 'error' } }));
          const checks = Object.fromEntries(unsafe.map(([id]) => [id, { contractsOk: false, secretsClean: false, secretsLeaked: true }]));
          await updateMigrationState(join(acquisitionDir, 'migration.json'), state => applyRollbacks(recordRun(state, sanitized, { now, checks }), { now }));
        },
        prepare: async ({ batches }) => {
        let local;
        let migrationState;
        if (normalizeAcquisitionMode(config.acquisition?.mode) !== 'central') {
          const checks = Object.fromEntries(Object.entries(batches).map(([id, batch]) => {
            const clean = scanBuffer(id, Buffer.from(JSON.stringify(batch))).length === 0;
            return [id, { contractsOk: true, secretsClean: clean, secretsLeaked: !clean }];
          }));
          migrationState = await updateMigrationState(join(acquisitionDir, 'migration.json'),
            state => applyRollbacks(recordRun(state, Object.values(batches), { now, checks }), { now }));
          if (Object.values(checks).some(check => !check.secretsClean)) throw new Error('unsafe acquisition output');
          const mapped = loadSignalBatches(Object.values(batches), { sources: sources.sources, seenAt: now });
          const poolPath = join(acquisitionDir, 'candidate-pool.json');
          let previous = null;
          try { previous = JSON.parse(await readFile(poolPath, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          const pool = updateLocalPool(previous, mapped, now);
          await writeJsonAtomic(poolPath, pool, { label: 'local candidate pool' });
          local = localInputForRun(pool, mapped.sourceStatuses);
        }
        return prepareMain({ ...preparation, argv, stdout, stderr, config, now,
          migrationState,
          paths: { ...preparation.paths, home: join(userDir, '..') },
          loadLocalSignalBatches: async () => local,
        });
      } });
      return result.prepared;
    } finally { await unlock(); }
  } catch (error) {
    const known = ['schedule-not-authorized', 'onboarding-required'].includes(error.message);
    stderr.write(`collection-failed: ${error.exitCode || known ? error.message : 'check configuration and acquisition runtime'}\n`);
    return error.exitCode ?? 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
