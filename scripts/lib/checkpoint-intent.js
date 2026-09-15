import { readFileSync, constants } from 'node:fs';
import * as systemFs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { scanBuffer } from '../release/scan-secrets.js';

const MAX_INTENT_BYTES = 1024 * 1024;
const schema = JSON.parse(readFileSync(
  new URL('../../contracts/checkpoint-intent.schema.json', import.meta.url), 'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);
const canonical = values => [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
const CREDENTIAL_KEY = /(?:^|[_-])(?:api[_-]?key|token|secret|password|credential|cookie|authorization)(?:$|[_-])/i;

function hasCredentialKey(value) {
  if (Array.isArray(value)) return value.some(hasCredentialKey);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => CREDENTIAL_KEY.test(key) || hasCredentialKey(child));
  }
  return false;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateCheckpointIntent(intent, { batches, runId } = {}) {
  const errors = [];
  if (!validateSchema(intent)) {
    errors.push(...validateSchema.errors.map(({ instancePath, message }) => `${instancePath || '/'} ${message}`));
  }
  if (!intent || typeof intent !== 'object') return { valid: false, errors };
  if (runId !== undefined && intent.run_id !== runId) errors.push('/run_id does not match publisher run');
  if (Array.isArray(intent.sources)) {
    const ids = intent.sources.map(source => source?.source_id);
    const sortableIds = ids.filter(id => typeof id === 'string');
    if (sortableIds.length !== ids.length || JSON.stringify(ids) !== JSON.stringify(canonical(new Set(ids)))) {
      errors.push('/sources must be a canonical ordered set');
    }
    for (const [index, source] of intent.sources.entries()) {
      if (!source || typeof source !== 'object') continue;
      const active = source.active_stream_ids;
      if (Array.isArray(active) && JSON.stringify(active) !== JSON.stringify(canonical(new Set(active)))) {
        errors.push(`/sources/${index}/active_stream_ids must be canonical`);
      }
      if (Array.isArray(source.updates)) {
        const updateIds = source.updates.map(update => update?.stream_id);
        const sortableUpdates = updateIds.filter(id => typeof id === 'string');
        if (sortableUpdates.length !== updateIds.length
            || JSON.stringify(updateIds) !== JSON.stringify(canonical(new Set(updateIds)))) {
          errors.push(`/sources/${index}/updates must be a canonical ordered set`);
        }
        if (Array.isArray(active) && updateIds.some(streamId => !active.includes(streamId))) {
          errors.push(`/sources/${index}/updates references an inactive stream`);
        }
      }
      const batch = batches?.[source.source_id];
      if (!batch) errors.push(`/sources/${index}/source_id has no batch`);
      else if (batch.batch_id !== source.batch_id) errors.push(`/sources/${index}/batch_id does not match batch`);
    }
  }
  if (batches && Array.isArray(intent.sources)) {
    const intended = new Set(intent.sources.map(source => source?.source_id));
    for (const sourceId of Object.keys(batches)) {
      if (!intended.has(sourceId)) errors.push('/sources is missing a batch source');
    }
  }
  try {
    const encoded = Buffer.from(JSON.stringify(intent));
    if (encoded.length > MAX_INTENT_BYTES) errors.push('/ exceeds 1 MiB');
    if (scanBuffer('checkpoint-intent.json', encoded).length) errors.push('/ contains credential-shaped data');
    if (hasCredentialKey(intent)) errors.push('/ contains credential-shaped key');
  } catch {
    errors.push('/ is not serializable JSON');
  }
  return { valid: errors.length === 0, errors };
}

async function verifyDirectory(path, expected, fsImpl) {
  if (!expected) return;
  const directory = dirname(path);
  const info = await fsImpl.lstat(directory);
  const realPath = await fsImpl.realpath(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== expected.dev
      || info.ino !== expected.ino || realPath !== expected.realPath || (info.mode & 0o777) !== 0o700) {
    throw new Error('checkpoint staging directory identity mismatch');
  }
}

export async function loadCheckpointIntent({ path, batches, runId, expectedDirectoryIdentity, fsImpl = systemFs } = {}) {
  await verifyDirectory(path, expectedDirectoryIdentity, fsImpl);
  const info = await fsImpl.lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INTENT_BYTES) {
    throw new Error('checkpoint intent is not a bounded regular file');
  }
  const handle = await fsImpl.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let payload;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_INTENT_BYTES) throw new Error('checkpoint intent is unsafe');
    const buffer = Buffer.alloc(MAX_INTENT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, Math.min(64 * 1024, buffer.length - bytesRead), bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1
        || after.size !== opened.size || bytesRead !== opened.size) throw new Error('checkpoint intent changed while reading');
    if (bytesRead > MAX_INTENT_BYTES) throw new Error('checkpoint intent exceeds 1 MiB');
    payload = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  let intent;
  try { intent = JSON.parse(payload.toString('utf8')); }
  catch { throw new Error('checkpoint intent is invalid JSON'); }
  const result = validateCheckpointIntent(intent, { batches, runId });
  if (!result.valid) throw new Error(`checkpoint intent is invalid: ${result.errors.join('; ')}`);
  await verifyDirectory(path, expectedDirectoryIdentity, fsImpl);
  const exactBytes = Buffer.from(payload);
  const envelope = {
    intent: deepFreeze(intent),
    sha256: createHash('sha256').update(exactBytes).digest('hex'),
  };
  Object.defineProperty(envelope, 'bytes', {
    enumerable: true,
    get: () => Buffer.from(exactBytes),
  });
  return Object.freeze(envelope);
}
