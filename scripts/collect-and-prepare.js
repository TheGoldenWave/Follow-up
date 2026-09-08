#!/usr/bin/env node

import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID as systemRandomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { isMainModule } from './command-line.js';
import { normalizeAcquisitionMode } from './lib/resolve-acquisition-input.js';
import { invokeAcquisitionRun, loadCollectedBatches } from './lib/run-acquisition.js';
import { publishBatchRun, publishLatestPointers } from './lib/publish-batches.js';

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
} = {}) {
  const mode = normalizeAcquisitionMode(config.acquisition?.mode);
  if (mode === 'central') {
    return { mode, collected: false };
  }

  const acquisitionDir = join(userDir, 'acquisition');
  const runsDir = join(acquisitionDir, 'runs');
  const latestDir = join(acquisitionDir, 'latest');

  await invokeRun({ outputDir: acquisitionDir });
  const batches = await loadBatches({ outputDir: acquisitionDir });
  const runId = `${now.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

  await publishRun(batches, { runsDir, runId, randomUUID });
  await publishPointers(batches, { runsDir, latestDir, runId, randomUUID });

  return { mode, collected: true, runId, batchCount: Object.keys(batches).length, batches };
}

async function main({ stdout = process.stdout, stderr = process.stderr } = {}) {
  let config = {};
  try {
    config = JSON.parse(await readFile(join(USER_DIR, 'config.json'), 'utf8'));
  } catch {
    // Missing or unreadable config defaults to central mode.
  }
  try {
    const result = await collectAndPrepare({ config });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`collection-failed: ${error.message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
