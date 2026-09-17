import { dirname, isAbsolute, join } from 'node:path';
import { constants, readFileSync } from 'node:fs';
import { spawn as systemSpawn } from 'node:child_process';
import * as systemFs from 'node:fs/promises';
import { resolveBootstrapPath } from '../bootstrap-acquisition.js';
import { redactDiagnostics } from './diagnostics.js';
import Ajv2020 from 'ajv/dist/2020.js';

const reportSchema = JSON.parse(readFileSync(
  new URL('../../contracts/checkpoint-commit-report.schema.json', import.meta.url), 'utf8',
));
const validateReportSchema = new Ajv2020({ allErrors: true, strict: false }).compile(reportSchema);

const MAX_PROCESS_OUTPUT = 16 * 1024;
const MAX_BATCH_BYTES = 10 * 1024 * 1024;

function fallbackReport(runId, sources) {
  const ids = [...sources].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  return { schema_version: '1.0', run_id: runId, status: 'partial', source_count: ids.length,
    sources: ids.map(source_id => ({ source_id, status: 'error' })) };
}

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

async function preparePrivateOutput(outputDir, fsImpl) {
  const parent = dirname(outputDir);
  await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await fsImpl.lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('acquisition staging parent is unsafe');
  await fsImpl.chmod(parent, 0o700);
  await fsImpl.mkdir(outputDir, { mode: 0o700 });
  const pathInfo = await fsImpl.lstat(outputDir);
  if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink() || (pathInfo.mode & 0o777) !== 0o700) {
    throw new Error('acquisition output directory is unsafe');
  }
  const realPath = await fsImpl.realpath(outputDir);
  const handle = await fsImpl.open(outputDir, 'r');
  const opened = await handle.stat();
  if (!opened.isDirectory() || opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino) {
    await handle.close();
    throw new Error('acquisition output directory identity mismatch');
  }
  return { handle, opened, realPath };
}

async function verifyPrivateOutput(outputDir, identity, fsImpl) {
  const opened = await identity.handle.stat();
  const pathInfo = await fsImpl.lstat(outputDir);
  const realPath = await fsImpl.realpath(outputDir);
  if (!opened.isDirectory() || !pathInfo.isDirectory() || pathInfo.isSymbolicLink()
      || opened.dev !== identity.opened.dev || opened.ino !== identity.opened.ino
      || pathInfo.dev !== identity.opened.dev || pathInfo.ino !== identity.opened.ino
      || realPath !== identity.realPath || (pathInfo.mode & 0o777) !== 0o700) {
    throw new Error('acquisition output directory changed during collection');
  }
}

async function verifyDirectoryIdentity(outputDir, expected, fsImpl) {
  if (!expected) return;
  const info = await fsImpl.lstat(outputDir);
  const realPath = await fsImpl.realpath(outputDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== expected.dev
      || info.ino !== expected.ino || realPath !== expected.realPath || (info.mode & 0o777) !== 0o700) {
    throw new Error('acquisition staging directory identity mismatch');
  }
}

async function removeOwnedOutput(outputDir, identity, fsImpl) {
  if (!identity) return;
  try {
    await verifyPrivateOutput(outputDir, identity, fsImpl);
    await identity.handle.close();
    await fsImpl.rm(outputDir, { recursive: true, force: true });
  } catch {
    await identity.handle.close().catch(() => {});
  }
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
  stateRoot,
  runId = 'manual-run',
  pythonPath,
  cwd,
  env = process.env,
  spawnImpl = systemSpawn,
  fsImpl = systemFs,
  manageOutput = true,
} = {}) {
  pythonPath = await resolveInterpreter({ pythonPath, env });
  const outputIdentity = manageOutput ? await preparePrivateOutput(outputDir, fsImpl) : null;
  const runtimeEnv = { ...env };
  delete runtimeEnv.PYTHONPATH;
  delete runtimeEnv.PYTHONHOME;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = async error => {
      if (settled) return;
      settled = true;
      await removeOwnedOutput(outputDir, outputIdentity, fsImpl);
      reject(error);
    };
    let child;
    try {
      child = spawnImpl(
        pythonPath,
        ['-I', '-m', 'follow_up_acquisition', 'run', '--run-id', runId,
          '--output', outputDir, '--checkpoint-out', checkpointOut,
          ...(stateRoot ? ['--state-root', stateRoot] : [])],
        { cwd, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      void fail(new Error('acquisition process could not start'));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { if (stdout.length < MAX_PROCESS_OUTPUT) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk; });
    child.on('error', error => { void fail(error); });
    child.on('close', async (code) => {
      stdout = safeOutput(stdout);
      stderr = safeOutput(stderr);
      try {
        if (outputIdentity) await verifyPrivateOutput(outputDir, outputIdentity, fsImpl);
        if (code === 0 && !settled) {
          settled = true;
          resolve({ code, stdout, stderr,
          stagingIdentity: outputIdentity ? {
            dev: outputIdentity.opened.dev, ino: outputIdentity.opened.ino,
            realPath: outputIdentity.realPath,
          } : null });
        }
        else {
          await fail(new Error(`acquisition run failed (${code}): ${stderr.trim()}`));
        }
      } catch {
        await fail(new Error('acquisition output directory could not be verified'));
      } finally {
        if (code === 0 && settled && outputIdentity) await outputIdentity.handle.close().catch(() => {});
      }
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
  expectedDirectoryIdentity,
} = {}) {
  if (platformName === 'win32' || !constants.O_NOFOLLOW) {
    throw new Error('local acquisition is unsupported without POSIX nofollow file access');
  }
  await verifyDirectoryIdentity(outputDir, expectedDirectoryIdentity, fsImpl);
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
  await verifyDirectoryIdentity(outputDir, expectedDirectoryIdentity, fsImpl);
  return batches;
}

/** Invoke the one-shot post-publication CAS command. Exit 3 is an operational partial result. */
export async function invokeCheckpointCommit({
  intentPath, stateRoot, expectedSha256, expectedRunId,
  expectedSources = [],
  pythonPath, cwd, env = process.env, spawnImpl = systemSpawn,
} = {}) {
  pythonPath = await resolveInterpreter({ pythonPath, env });
  const runtimeEnv = { ...env };
  delete runtimeEnv.PYTHONPATH;
  delete runtimeEnv.PYTHONHOME;
  return new Promise(resolve => {
    const fallback = () => ({ code: null, checkpointStatus: 'partial', report: fallbackReport(expectedRunId, expectedSources) });
    let settled = false;
    const finish = value => {
      if (!settled) { settled = true; resolve(value); }
    };
    let child;
    try {
      child = spawnImpl(pythonPath, [
        '-I', '-m', 'follow_up_acquisition', 'commit-state',
        '--intent', intentPath, '--state-root', stateRoot,
        '--expected-sha256', expectedSha256, '--expected-run-id', expectedRunId,
      ], { cwd, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(fallback());
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { if (stdout.length < MAX_PROCESS_OUTPUT) stdout += chunk; });
    child.stderr?.on('data', chunk => { if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk; });
    child.on('error', () => finish(fallback()));
    child.on('close', code => {
      stdout = safeOutput(stdout);
      stderr = safeOutput(stderr);
      let report;
      try { report = JSON.parse(stdout); } catch { report = null; }
      const expectedStatuses = code === 0 ? new Set(['committed']) : code === 3 ? new Set(['partial', 'uncertain']) : new Set();
      const ids = report?.sources?.map(source => source.source_id) ?? [];
      const sortedExpected = [...expectedSources].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
      const aggregate = report?.sources?.some(source => source.status === 'uncertain') ? 'uncertain'
        : report?.sources?.every(source => source.status === 'committed') ? 'committed' : 'partial';
      if (report && validateReportSchema(report) && report.run_id === expectedRunId
          && report.source_count === report.sources.length
          && JSON.stringify(ids) === JSON.stringify(sortedExpected)
          && new Set(ids).size === ids.length
          && report.status === aggregate
          && expectedStatuses.has(report.status)) {
        finish({ code, checkpointStatus: report.status, report });
      } else {
        finish({ ...fallback(), code });
      }
    });
  });
}
