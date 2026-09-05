import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,399}$/u;
const SAFE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
export const DELIVERY_INPUT_LIMITS = Object.freeze({ jsonBytes: 2 * 1024 * 1024, messageBytes: 1024 * 1024 });

async function rejectSymlink(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error('Active digest contains an unsafe symbolic link');
  return metadata;
}

async function readLimited(path, maximum) {
  await rejectSymlink(path);
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Active digest input must be a regular file');
    if (metadata.size > maximum) throw new Error('Active digest input exceeds byte limit');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function readJson(path, maximum, label) {
  try { return JSON.parse(await readLimited(path, maximum)); }
  catch (error) { throw new Error(`${label} is invalid or could not be read`, { cause: error }); }
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} is invalid`);
}

function requireBoundIds(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !HASH.test(entry))
    || new Set(value).size !== value.length) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function collectCandidateIds(items) {
  const ids = [];
  for (const item of items) {
    requireHash(item?.candidateId, 'selected candidate ID');
    ids.push(item.candidateId);
    if (item.corroborating !== undefined) {
      if (!Array.isArray(item.corroborating)) throw new Error('selected candidate IDs are invalid');
      for (const candidate of item.corroborating) {
        requireHash(candidate?.candidateId, 'selected candidate ID');
        ids.push(candidate.candidateId);
      }
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error('selected candidate IDs must be unique');
  return ids;
}

export async function loadActiveDigest(activePath, { limits = DELIVERY_INPUT_LIMITS } = {}) {
  if (typeof activePath !== 'string' || basename(activePath) !== 'active.json') {
    throw new Error('Active digest path must name active.json');
  }
  const absoluteActive = resolve(activePath);
  const active = await readJson(absoluteActive, limits.jsonBytes, 'Active digest');
  if (active?.schemaVersion !== '1.0' || !SAFE_GENERATION.test(active.generation ?? '')
    || !SAFE_DIGEST.test(active.digestId ?? '')
    || active.artifact !== 'artifact.json' || active.message !== 'message.txt') {
    throw new Error('Active digest is invalid');
  }
  const root = dirname(absoluteActive);
  const generationDir = join(root, 'generations', active.generation);
  await rejectSymlink(join(root, 'generations'));
  await rejectSymlink(generationDir);
  const canonicalRoot = `${await realpath(root)}${sep}`;
  if (!`${await realpath(generationDir)}${sep}`.startsWith(canonicalRoot)) {
    throw new Error('Active digest generation escapes its root');
  }
  const manifest = await readJson(join(generationDir, 'manifest.json'), limits.jsonBytes, 'Digest manifest');
  const artifact = await readJson(join(generationDir, active.artifact), limits.jsonBytes, 'Digest artifact');
  const message = await readLimited(join(generationDir, active.message), limits.messageBytes);
  if (manifest?.schemaVersion !== '1.0' || manifest.generation !== active.generation) {
    throw new Error('Digest manifest generation must match active generation');
  }
  if (manifest.digestId !== active.digestId || artifact?.digestId !== active.digestId) {
    throw new Error('Digest ID must match active generation');
  }
  requireHash(manifest.requestHash, 'manifest requestHash');
  requireHash(active.requestHash, 'active requestHash');
  if (artifact.requestHash !== manifest.requestHash || active.requestHash !== manifest.requestHash) {
    throw new Error('requestHash must match active generation');
  }
  if (manifest.artifact !== active.artifact || manifest.message !== active.message) {
    throw new Error('Digest manifest files must match active generation');
  }
  if (!['daily', 'weekly'].includes(artifact.frequency) || !Array.isArray(artifact.items)) {
    throw new Error('Digest artifact is invalid');
  }
  if (!artifact.contentStats || artifact.contentStats.selectedCount !== artifact.items.length) {
    throw new Error('Digest selected content does not match contentStats');
  }
  const candidateIds = collectCandidateIds(artifact.items);
  const eventClusterIds = artifact.items.map((item) => {
    requireHash(item?.eventClusterId, 'selected event cluster ID');
    return item.eventClusterId;
  });
  if (new Set(eventClusterIds).size !== eventClusterIds.length) {
    throw new Error('selected event cluster IDs must be unique');
  }
  const activeCandidateIds = requireBoundIds(active.candidateIds, 'active candidate IDs');
  const manifestCandidateIds = requireBoundIds(manifest.candidateIds, 'manifest candidate IDs');
  if (!sameIds(candidateIds, activeCandidateIds) || !sameIds(candidateIds, manifestCandidateIds)) {
    throw new Error('selected candidate IDs must match active generation');
  }
  const activeClusterIds = requireBoundIds(active.eventClusterIds, 'active event cluster IDs');
  const manifestClusterIds = requireBoundIds(manifest.eventClusterIds, 'manifest event cluster IDs');
  if (!sameIds(eventClusterIds, activeClusterIds) || !sameIds(eventClusterIds, manifestClusterIds)) {
    throw new Error('selected event cluster IDs must match active generation');
  }
  return {
    activePath: absoluteActive, generation: active.generation, digestId: active.digestId,
    requestHash: manifest.requestHash, frequency: artifact.frequency, status: artifact.status,
    candidateIds, eventClusterIds, message,
  };
}
