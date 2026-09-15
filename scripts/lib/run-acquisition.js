import { isAbsolute, join } from 'node:path';
import { constants } from 'node:fs';
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
  platformName = process.platform,
} = {}) {
  if (platformName === 'win32' || !constants.O_NOFOLLOW) {
    throw new Error('local acquisition is unsupported without POSIX nofollow file access');
  }
  const entries = await fsImpl.readdir(outputDir, { withFileTypes: true });
  const batches = {};
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (name === 'checkpoint-intent.json' || !name.endsWith('.json')) continue;
    if (typeof entry !== 'string' && entry.isSymbolicLink()) {
      throw new Error('unsafe collected batch file');
    }
    if (typeof entry !== 'string' && !entry.isFile()) continue;
    const path = join(outputDir, name);
    let handle;
    try {
      handle = await fsImpl.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const safe = new Error('collected batch file cannot be opened safely');
      safe.code = error.code;
      throw safe;
    }
    let payload;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BATCH_BYTES) {
        throw new Error('unsafe collected batch file');
      }
      const buffer = Buffer.alloc(MAX_BATCH_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const length = Math.min(64 * 1024, buffer.length - bytesRead);
        const chunk = await handle.read(buffer, bytesRead, length, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      const after = await handle.stat();
      if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino
          || after.size !== before.size || bytesRead !== before.size || bytesRead > MAX_BATCH_BYTES) {
        throw new Error('unsafe or changing collected batch file');
      }
      payload = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const batch = JSON.parse(payload.toString('utf8'));
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
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (!settled) { settled = true; resolve(value); }
    };
    let child;
    try {
      child = spawnImpl(pythonPath, [
        '-I', '-m', 'follow_up_acquisition', 'commit-state',
        '--intent', intentPath, '--state-root', stateRoot,
      ], { cwd, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish({ code: null, checkpointStatus: 'partial', report: { status: 'partial' } });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { if (stdout.length < MAX_PROCESS_OUTPUT) stdout += chunk; });
    child.stderr?.on('data', chunk => { if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk; });
    child.on('error', () => finish({ code: null, checkpointStatus: 'partial', report: { status: 'partial' } }));
    child.on('close', code => {
      stdout = safeOutput(stdout);
      stderr = safeOutput(stderr);
      let report;
      try { report = JSON.parse(stdout); } catch { report = null; }
      const expectedStatuses = code === 0 ? new Set(['committed']) : code === 3 ? new Set(['partial', 'uncertain']) : new Set();
      if (report && typeof report === 'object' && expectedStatuses.has(report.status)) {
        finish({ code, checkpointStatus: report.status, report });
      } else {
        finish({ code, checkpointStatus: 'partial', report: { status: 'partial' } });
      }
    });
  });
}
