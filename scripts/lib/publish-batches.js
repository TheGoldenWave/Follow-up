import { constants, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { writeJsonAtomic } from '../prepare-digest.js';
import { scanBuffer } from '../release/scan-secrets.js';
import { validateCheckpointIntent } from './checkpoint-intent.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INTENT_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 10 * 1024 * 1024;
const publicationReceipts = new WeakSet();

function freezeReceipt(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeReceipt(child);
  }
  return Object.freeze(value);
}

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

async function readBoundedRegular(path, limit, fsImpl) {
  const handle = await fsImpl.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('published run file is unsafe');
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const chunk = await handle.read(buffer, total, Math.min(64 * 1024, buffer.length - total), total);
      if (!chunk.bytesRead) break;
      total += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1
        || after.size !== before.size || total !== before.size || total > limit) {
      throw new Error('published run file changed while reading');
    }
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

/**
 * Atomically publish one run of Signal Batches under `runs/<run_id>/<source>.json`.
 * A crash or invalid batch leaves no partial run file behind.
 */
export async function publishBatchRun(batches, {
  runsDir,
  runId,
  checkpointIntent,
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
  let serializedIntent;
  try { serializedIntent = JSON.parse(checkpointIntent?.bytes?.toString('utf8')); } catch { serializedIntent = null; }
  const intentValidation = validateCheckpointIntent(serializedIntent, { batches, runId });
  if (!checkpointIntent || !Buffer.isBuffer(checkpointIntent.bytes)
      || checkpointIntent.intent?.run_id !== runId
      || JSON.stringify(serializedIntent) !== JSON.stringify(checkpointIntent.intent)
      || hash(checkpointIntent.bytes) !== checkpointIntent.sha256
      || !intentValidation.valid) {
    throw new Error('validated checkpoint intent is required');
  }
  const intentSources = checkpointIntent.intent.sources?.map(source => source.source_id) ?? [];
  if (JSON.stringify(intentSources) !== JSON.stringify(entries.map(([sourceId]) => sourceId))) {
    throw new Error('checkpoint intent source set does not match batches');
  }
  const parent = dirname(runsDir);
  const staging = join(runsDir, `.run-staging-${randomUUID()}`);
  const destination = join(runsDir, runId);
  await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
  await fsImpl.mkdir(runsDir, { recursive: true, mode: 0o700 });
  const runsInfo = await fsImpl.lstat(runsDir);
  if (!runsInfo.isDirectory() || runsInfo.isSymbolicLink()) throw new Error('runs directory is unsafe or symlinked');
  let renamed = false;
  const sources = {};
  let manifestPayload;
  try {
    try { await fsImpl.lstat(destination); throw new Error('run collision: destination exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fsImpl.mkdir(staging, { mode: 0o700 });
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
    await durableWrite(join(staging, 'checkpoint-intent.json'), checkpointIntent.bytes, fsImpl);
    manifestPayload = encode({
      schema_version: '1.0', run_id: runId,
      checkpoint_intent: { file: 'checkpoint-intent.json', sha256: checkpointIntent.sha256 },
      sources,
    });
    await durableWrite(join(staging, 'run.json'), manifestPayload, fsImpl);
    await fsyncDirectory(staging, fsImpl);
    await fsImpl.rename(staging, destination);
    renamed = true;
    await fsyncDirectory(runsDir, fsImpl);
  } catch (error) {
    await fsImpl.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (renamed) {
      const uncertain = new Error('published run durability could not be confirmed');
      uncertain.code = 'run-durability-uncertain';
      throw uncertain;
    }
    throw error;
  }
  const receipt = freezeReceipt({
    runId,
    intentSha256: checkpointIntent.sha256,
    runManifestSha256: hash(manifestPayload),
    sources: Object.fromEntries(Object.entries(sources).map(([sourceId, entry]) => [sourceId, {
      sha256: entry.sha256, batchId: entry.batch_id, status: entry.status,
    }])),
  });
  publicationReceipts.add(receipt);
  return {
    runDir: destination,
    publishedIntentPath: join(destination, 'checkpoint-intent.json'),
    intentSha256: checkpointIntent.sha256,
    receipt,
  };
}

async function validatePublishedRun(batches, { runsDir, runId, receipt, fsImpl }) {
  if (!SAFE_RUN_ID.test(runId) || Object.keys(batches).some(sourceId => !SAFE_ID.test(sourceId))) {
    throw new Error('published run identifiers are unsafe');
  }
  const expectedSources = Object.keys(batches).sort();
  if (!receipt || !publicationReceipts.has(receipt) || !Object.isFrozen(receipt)
      || receipt.runId !== runId
      || JSON.stringify(Object.keys(receipt.sources).sort()) !== JSON.stringify(expectedSources)) {
    throw new Error('valid publication receipt is required');
  }
  const directory = join(runsDir, runId);
  const manifestPayload = await readBoundedRegular(join(directory, 'run.json'), MAX_MANIFEST_BYTES, fsImpl);
  if (hash(manifestPayload) !== receipt.runManifestSha256) throw new Error('published run manifest does not match receipt');
  const manifest = JSON.parse(manifestPayload.toString('utf8'));
  if (manifest.schema_version !== '1.0' || manifest.run_id !== runId
      || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(['checkpoint_intent', 'run_id', 'schema_version', 'sources'])) {
    throw new Error('published run manifest is invalid');
  }
  if (manifest.checkpoint_intent?.file !== 'checkpoint-intent.json'
      || !/^[0-9a-f]{64}$/.test(manifest.checkpoint_intent?.sha256 ?? '')
      || JSON.stringify(Object.keys(manifest.checkpoint_intent).sort()) !== JSON.stringify(['file', 'sha256'])) {
    throw new Error('published checkpoint intent manifest entry is invalid');
  }
  const intentPayload = await readBoundedRegular(join(directory, 'checkpoint-intent.json'), MAX_INTENT_BYTES, fsImpl);
  if (manifest.checkpoint_intent.sha256 !== receipt.intentSha256
      || hash(intentPayload) !== receipt.intentSha256) throw new Error('published checkpoint intent hash mismatch');
  if (JSON.stringify(Object.keys(manifest.sources).sort()) !== JSON.stringify(expectedSources)) {
    throw new Error('published run manifest source set is invalid');
  }
  for (const sourceId of expectedSources) {
    const entry = manifest.sources[sourceId];
    const evidence = receipt.sources[sourceId];
    if (!entry || entry.filename !== `${sourceId}.json` || entry.batch_id !== batches[sourceId].batch_id
      || entry.status !== batches[sourceId].source_status.status
      || entry.sha256 !== evidence.sha256 || entry.batch_id !== evidence.batchId || entry.status !== evidence.status
      || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['batch_id', 'filename', 'sha256', 'status'])) {
      throw new Error('published run manifest entry is invalid');
    }
    const payload = await readBoundedRegular(join(directory, entry.filename), MAX_BATCH_BYTES, fsImpl);
    if (hash(payload) !== evidence.sha256) throw new Error('published run hash mismatch');
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
  receipt,
  fsImpl = systemFs,
  randomUUID = systemRandomUUID,
} = {}) {
  await validatePublishedRun(batches, { runsDir, runId, receipt, fsImpl });
  for (const [sourceId, batch] of Object.entries(batches)) {
    await writeJsonAtomic(join(latestDir, `${sourceId}.json`), {
      run_id: runId,
      batch_id: batch.batch_id,
      batch_sha256: receipt.sources[sourceId].sha256,
      run_manifest_sha256: receipt.runManifestSha256,
      intent_sha256: receipt.intentSha256,
      generated_at: batch.generated_at,
      path: join(runsDir, runId, `${sourceId}.json`),
    }, { fsImpl, randomUUID, label: `latest pointer ${sourceId}` });
  }
  return join(latestDir);
}
