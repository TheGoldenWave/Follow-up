import { isAbsolute, join } from 'node:path';
import { spawn as systemSpawn } from 'node:child_process';
import * as systemFs from 'node:fs/promises';
import { resolveBootstrapPath } from '../bootstrap-acquisition.js';
import { redactDiagnostics } from './diagnostics.js';

const MAX_PROCESS_OUTPUT = 16 * 1024;
const MAX_BATCH_BYTES = 10 * 1024 * 1024;

async function resolveInterpreter({ pythonPath, env }) {
  if (pythonPath) return pythonPath;
  try {
    const runtime = JSON.parse(await systemFs.readFile(resolveBootstrapPath({ env }), 'utf8'));
    if (runtime.schemaVersion !== '1.0' || !isAbsolute(runtime.interpreter ?? '')) {
      throw new Error('invalid runtime descriptor');
    }
    return runtime.interpreter;
  } catch (error) {
    throw new Error(`Acquisition runtime is not ready. Run node scripts/bootstrap-acquisition.js first: ${error.message}`);
  }
}

function safeOutput(value) {
  const bounded = value.slice(0, MAX_PROCESS_OUTPUT).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return redactDiagnostics(bounded);
}

/**
 * Invoke the Python Acquisition Runtime `run` command, which collects every
 * enabled rss/web-publication source and writes one Signal Batch per source into
 * `outputDir`. Resolves on exit code 0 and rejects on any failure so callers can
 * classify the run instead of silently proceeding.
 */
export async function invokeAcquisitionRun({
  outputDir,
  checkpointOut = join(outputDir, 'checkpoint-intent.json'),
  runId = 'manual-run',
  pythonPath,
  cwd,
  env = process.env,
  spawnImpl = systemSpawn,
} = {}) {
  pythonPath = await resolveInterpreter({ pythonPath, env });
  const runtimeEnv = { ...env };
  delete runtimeEnv.PYTHONPATH;
  delete runtimeEnv.PYTHONHOME;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      pythonPath,
      ['-I', '-m', 'follow_up_acquisition', 'run', '--run-id', runId,
        '--output', outputDir, '--checkpoint-out', checkpointOut],
      { cwd, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { if (stdout.length < MAX_PROCESS_OUTPUT) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      stdout = safeOutput(stdout);
      stderr = safeOutput(stderr);
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
  const entries = await fsImpl.readdir(outputDir, { withFileTypes: true });
  const batches = {};
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (name === 'checkpoint-intent.json' || !name.endsWith('.json')) continue;
    if (typeof entry !== 'string' && !entry.isFile()) continue;
    const path = join(outputDir, name);
    const info = await fsImpl.lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BATCH_BYTES) {
      throw new Error(`unsafe collected batch file: ${name}`);
    }
    const batch = JSON.parse(await fsImpl.readFile(path, 'utf8'));
    if (Object.hasOwn(batches, batch.source)) throw new Error(`duplicate collected batch source: ${batch.source}`);
    batches[batch.source] = batch;
  }
  return batches;
}

/** Invoke the one-shot post-publication CAS command. Exit 3 is an operational partial result. */
export async function invokeCheckpointCommit({
  intentPath, stateRoot, pythonPath, cwd, env = process.env, spawnImpl = systemSpawn,
} = {}) {
  pythonPath = await resolveInterpreter({ pythonPath, env });
  const runtimeEnv = { ...env };
  delete runtimeEnv.PYTHONPATH;
  delete runtimeEnv.PYTHONHOME;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(pythonPath, [
      '-I', '-m', 'follow_up_acquisition', 'commit-state',
      '--intent', intentPath, '--state-root', stateRoot,
    ], { cwd, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { if (stdout.length < MAX_PROCESS_OUTPUT) stdout += chunk; });
    child.stderr?.on('data', chunk => { if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      stdout = safeOutput(stdout);
      stderr = safeOutput(stderr);
      if (code === 0 || code === 3) {
        let report;
        try { report = JSON.parse(stdout); } catch { report = {}; }
        resolve({ code, stdout, stderr, checkpointStatus: report.status ?? (code === 0 ? 'committed' : 'partial'), report });
      } else {
        reject(new Error(`checkpoint commit failed (${code}): ${stderr.trim()}`));
      }
    });
  });
}
