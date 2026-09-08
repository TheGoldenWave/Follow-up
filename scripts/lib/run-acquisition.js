import { join } from 'node:path';
import { spawn as systemSpawn } from 'node:child_process';
import * as systemFs from 'node:fs/promises';

/**
 * Invoke the Python Acquisition Runtime `run` command, which collects every
 * enabled rss/web-publication source and writes one Signal Batch per source into
 * `outputDir`. Resolves on exit code 0 and rejects on any failure so callers can
 * classify the run instead of silently proceeding.
 */
export function invokeAcquisitionRun({
  outputDir,
  pythonPath = 'python3.12',
  cwd,
  env = process.env,
  spawnImpl = systemSpawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      pythonPath,
      ['-m', 'follow_up_acquisition', 'run', '--output', outputDir],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`acquisition run failed (${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Read every `*.json` Signal Batch produced by a run, keyed by `batch.source`.
 */
export async function loadCollectedBatches({
  outputDir,
  fsImpl = systemFs,
} = {}) {
  const entries = await fsImpl.readdir(outputDir);
  const batches = {};
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const batch = JSON.parse(await fsImpl.readFile(join(outputDir, entry), 'utf8'));
    batches[batch.source] = batch;
  }
  return batches;
}
