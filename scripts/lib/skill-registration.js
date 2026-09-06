import * as systemFs from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { resolveSkillRegistrationPath } from './paths.js';

function requireReleaseRoot(releaseRoot) {
  if (typeof releaseRoot !== 'string' || !isAbsolute(releaseRoot)) {
    throw new TypeError('releaseRoot must be an absolute path');
  }
  return resolve(releaseRoot);
}

async function pathState(path, fsImpl) {
  try {
    return await fsImpl.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino
    && left.isSymbolicLink() === right.isSymbolicLink());
}

async function sameTarget(registrationPath, releaseRoot, fsImpl) {
  try {
    return await fsImpl.realpath(registrationPath) === await fsImpl.realpath(releaseRoot);
  } catch {
    return false;
  }
}

export class RegistrationRollbackError extends Error {
  constructor(options) {
    super('Follow-up registration failed and rollback could not be completed', options);
    this.name = 'RegistrationRollbackError';
    this.code = 'REGISTRATION_ROLLBACK_FAILED';
  }
}

function registrationPaths(platform, options) {
  const registrationPath = resolveSkillRegistrationPath(platform, options);
  return {
    registrationPath,
    legacyPath: join(dirname(registrationPath), 'follow-builders'),
  };
}

export async function inspectSkillRegistration({
  platform,
  releaseRoot,
  fsImpl = systemFs,
  ...pathOptions
}) {
  const target = requireReleaseRoot(releaseRoot);
  const { registrationPath, legacyPath } = registrationPaths(platform, pathOptions);
  const metadata = await pathState(registrationPath, fsImpl);
  const legacyMetadata = await pathState(legacyPath, fsImpl);
  let status = 'missing';
  if (metadata) {
    status = metadata.isSymbolicLink()
      && await sameTarget(registrationPath, target, fsImpl)
      ? 'registered'
      : 'invalid';
  }
  return {
    platform,
    status,
    registrationPath,
    legacyStatus: legacyMetadata
      ? (legacyMetadata.isSymbolicLink() ? 'present' : 'unsafe')
      : 'missing',
  };
}

export async function registerSkill({
  platform,
  releaseRoot,
  replaceLegacy = false,
  verify,
  fsImpl = systemFs,
  randomUUID: _randomUUID,
  ...pathOptions
}) {
  const target = requireReleaseRoot(releaseRoot);
  const skillMetadata = await pathState(join(target, 'SKILL.md'), fsImpl);
  if (!skillMetadata?.isFile()) throw new Error('Release root does not contain a regular SKILL.md');

  const { registrationPath, legacyPath } = registrationPaths(platform, pathOptions);
  const existing = await pathState(registrationPath, fsImpl);
  const legacy = await pathState(legacyPath, fsImpl);
  if (legacy && !replaceLegacy) {
    throw new Error('Existing follow-builders registration requires --replace-follow-builders');
  }
  if (legacy && !legacy.isSymbolicLink()) {
    throw new Error('Existing follow-builders registration is not a removable symbolic link');
  }
  if (legacy && typeof verify !== 'function') {
    throw new Error('A local verification callback is required to replace follow-builders');
  }
  if (existing && !(existing.isSymbolicLink()
      && await sameTarget(registrationPath, target, fsImpl))) {
    throw new Error('Follow-up registration path is already occupied or points elsewhere');
  }

  await fsImpl.mkdir(dirname(registrationPath), { recursive: true, mode: 0o700 });
  let created = false;
  let createdMetadata;
  try {
    if (!existing) {
      await fsImpl.symlink(target, registrationPath, 'dir');
      created = true;
      createdMetadata = await fsImpl.lstat(registrationPath);
    }

    const verified = await (verify ?? (async () => true))({
      platform, registrationPath, releaseRoot: target,
    });
    if (verified !== true || !await sameTarget(registrationPath, target, fsImpl)) {
      throw new Error('Follow-up registration verification failed');
    }
    if (legacy) {
      const currentLegacy = await pathState(legacyPath, fsImpl);
      if (!sameIdentity(legacy, currentLegacy)) {
        throw new Error('Existing follow-builders registration changed concurrently');
      }
      await fsImpl.unlink(legacyPath);
    }
    return {
      platform,
      registrationPath,
      status: existing ? 'already-registered' : 'registered',
      replacedLegacy: Boolean(legacy),
    };
  } catch (error) {
    const rollbackErrors = [];
    if (created) {
      try {
        const current = await pathState(registrationPath, fsImpl);
        if (current && !sameIdentity(createdMetadata, current)) {
          throw new Error('Follow-up registration changed concurrently during rollback');
        }
        if (current) await fsImpl.unlink(registrationPath);
      } catch (cleanupError) { rollbackErrors.push(cleanupError); }
    }
    if (rollbackErrors.length > 0) throw new RegistrationRollbackError({ cause: error });
    throw error;
  }
}
