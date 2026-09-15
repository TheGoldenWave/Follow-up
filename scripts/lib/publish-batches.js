import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { writeJsonAtomic } from '../prepare-digest.js';
import { scanBuffer } from '../release/scan-secrets.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const schema = JSON.parse(readFileSync(
  new URL('../../contracts/signal-batch.schema.json', import.meta.url),
  'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export function validateSignalBatch(batch) {
  const valid = validateSchema(batch);
  return {
    valid,
    errors: valid ? [] : validateSchema.errors.map(({ instancePath, message }) => (
      `${instancePath || '/'} ${message}`
    )),
  };
}

function assertValidBatch(sourceId, batch) {
  const result = validateSignalBatch(batch);
  if (!result.valid) {
    throw new Error(`Signal Batch for ${sourceId} is invalid: ${result.errors.join('; ')}`);
  }
  if (batch.source !== sourceId) {
    throw new Error(`Signal Batch source ${batch.source} does not match filename ${sourceId}`);
  }
  if (!SAFE_ID.test(sourceId)) throw new Error(`Signal Batch source ${sourceId} is unsafe`);
  if (scanBuffer(`${sourceId}.json`, Buffer.from(JSON.stringify(batch))).length) {
    throw new Error(`Signal Batch for ${sourceId} contains unsafe data`);
  }
}

const encode = value => Buffer.from(`${JSON.stringify(value)}\n`);
const hash = value => createHash('sha256').update(value).digest('hex');

async function durableWrite(path, payload, fsImpl) {
  const handle = await fsImpl.open(path, 'wx', 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path, fsImpl) {
  const handle = await fsImpl.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Atomically publish one run of Signal Batches under `runs/<run_id>/<source>.json`.
 * A crash or invalid batch leaves no partial run file behind.
 */
export async function publishBatchRun(batches, {
  runsDir,
  runId,
  fsImpl = systemFs,
  randomUUID = systemRandomUUID,
} = {}) {
  if (typeof runsDir !== 'string' || typeof runId !== 'string') {
    throw new TypeError('runsDir and runId are required');
  }
  if (!SAFE_RUN_ID.test(runId)) throw new Error('runId is unsafe');
  const entries = Object.entries(batches).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
  const encoded = new Map();
  for (const [sourceId, batch] of entries) {
    assertValidBatch(sourceId, batch);
    encoded.set(sourceId, encode(batch));
  }
  const parent = dirname(runsDir);
  const staging = join(parent, `.runs-staging-${randomUUID()}`);
  const destination = join(runsDir, runId);
  await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
  await fsImpl.mkdir(runsDir, { recursive: true, mode: 0o700 });
  const runsInfo = await fsImpl.lstat(runsDir);
  if (!runsInfo.isDirectory() || runsInfo.isSymbolicLink()) throw new Error('runs directory is unsafe or symlinked');
  try {
    try { await fsImpl.lstat(destination); throw new Error('run collision: destination exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fsImpl.mkdir(staging, { mode: 0o700 });
    const sources = {};
    for (const [sourceId, batch] of entries) {
      const payload = encoded.get(sourceId);
      const filename = `${sourceId}.json`;
      await durableWrite(join(staging, filename), payload, fsImpl);
      sources[sourceId] = {
        filename,
        sha256: hash(payload),
        status: batch.source_status.status,
        batch_id: batch.batch_id,
      };
    }
    await durableWrite(join(staging, 'run.json'), encode({
      schema_version: '1.0', run_id: runId, sources,
    }), fsImpl);
    await fsyncDirectory(staging, fsImpl);
    await fsImpl.rename(staging, destination);
    await fsyncDirectory(runsDir, fsImpl);
  } catch (error) {
    await fsImpl.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return destination;
}

async function validatePublishedRun(batches, { runsDir, runId, fsImpl }) {
  const directory = join(runsDir, runId);
  const manifest = JSON.parse(await fsImpl.readFile(join(directory, 'run.json'), 'utf8'));
  if (manifest.schema_version !== '1.0' || manifest.run_id !== runId
      || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(['run_id', 'schema_version', 'sources'])) {
    throw new Error('published run manifest is invalid');
  }
  const expected = Object.keys(batches).sort();
  if (JSON.stringify(Object.keys(manifest.sources).sort()) !== JSON.stringify(expected)) {
    throw new Error('published run manifest source set is invalid');
  }
  for (const sourceId of expected) {
    const entry = manifest.sources[sourceId];
    if (!entry || entry.filename !== `${sourceId}.json` || entry.batch_id !== batches[sourceId].batch_id
      || entry.status !== batches[sourceId].source_status.status
      || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['batch_id', 'filename', 'sha256', 'status'])) {
      throw new Error('published run manifest entry is invalid');
    }
    const payload = await fsImpl.readFile(join(directory, entry.filename));
    if (hash(payload) !== entry.sha256) throw new Error('published run hash mismatch');
  }
}

/**
 * Atomically update each source's `latest.json` pointer after every batch in the
 * run validated and published successfully.
 */
export async function publishLatestPointers(batches, {
  runsDir,
  latestDir,
  runId,
  fsImpl = systemFs,
  randomUUID = systemRandomUUID,
} = {}) {
  await validatePublishedRun(batches, { runsDir, runId, fsImpl });
  for (const [sourceId, batch] of Object.entries(batches)) {
    await writeJsonAtomic(join(latestDir, `${sourceId}.json`), {
      run_id: runId,
      batch_id: batch.batch_id,
      generated_at: batch.generated_at,
      path: join(runsDir, runId, `${sourceId}.json`),
    }, { fsImpl, randomUUID, label: `latest pointer ${sourceId}` });
  }
  return join(latestDir);
}
