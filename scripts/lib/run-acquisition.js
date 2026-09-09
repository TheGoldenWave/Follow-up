import { isAbsolute, join } from 'node:path';
import { spawn as systemSpawn } from 'node:child_process';
import * as systemFs from 'node:fs/promises';
import { resolveBootstrapPath } from '../bootstrap-acquisition.js';

/**
 * Invoke the Python Acquisition Runtime `run` command, which collects every
 * enabled rss/web-publication source and writes one Signal Batch per source into
 * `outputDir`. Resolves on exit code 0 and rejects on any failure so callers can
 * classify the run instead of silently proceeding.
 */
export async function invokeAcquisitionRun({
  outputDir,
  pythonPath,
  cwd,
  env = process.env,
  spawnImpl = systemSpawn,
} = {}) {
  if (!pythonPath) {
    try {
      const runtime = JSON.parse(await systemFs.readFile(resolveBootstrapPath({ env }), 'utf8'));
      if (runtime.schemaVersion !== '1.0' || !isAbsolute(runtime.interpreter ?? '')) {
        throw new Error('invalid runtime descriptor');
      }
      pythonPath = runtime.interpreter;
    } catch (error) {
      throw new Error(`Acquisition runtime is not ready. Run node scripts/bootstrap-acquisition.js first: ${error.message}`);
    }
  }
  const runtimeEnv = { ...env };
  delete runtimeEnv.PYTHONPATH;
  delete runtimeEnv.PYTHONHOME;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      pythonPath,
      ['-I', '-m', 'follow_up_acquisition', 'run', '--output', outputDir],
      { cwd, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] },
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
