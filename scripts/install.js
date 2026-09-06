#!/usr/bin/env node

import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as systemFs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { registerSkill } from './lib/skill-registration.js';
import { validateArchiveCriticalFiles, validateRelease } from './release/validate-release.js';

const execFile = promisify(nodeExecFile);
export const EX_USAGE = 64;
const USAGE = 'Usage: node scripts/install.js --platform <codex|claude-code|custom> [--skill-dir <absolute-path>] [--register] [--replace-follow-builders]';
const OWNER_FILE = '.install-owner';
const COMPLETE_FILE = '.install-complete.json';
const WORKER_PATH = fileURLToPath(new URL('./lib/install-worker.js', import.meta.url));

export function parseInstallArgs(args) {
  const parsed = { platform: undefined, skillDir: undefined, register: false, replaceFollowBuilders: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--platform' || argument === '--skill-dir') {
      const key = argument === '--platform' ? 'platform' : 'skillDir';
      if (parsed[key] !== undefined) throw new Error(`Duplicate argument: ${argument}. ${USAGE}`);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}. ${USAGE}`);
      parsed[key] = value;
    } else if (argument === '--register' || argument === '--replace-follow-builders') {
      const key = argument === '--register' ? 'register' : 'replaceFollowBuilders';
      if (parsed[key]) throw new Error(`Duplicate argument: ${argument}. ${USAGE}`);
      parsed[key] = true;
    } else throw new Error(`Unknown argument: ${argument}. ${USAGE}`);
  }
  if (!['codex', 'claude-code', 'custom'].includes(parsed.platform)) throw new Error(`Unsupported or missing --platform. ${USAGE}`);
  if (parsed.platform === 'custom' && (!parsed.skillDir || !isAbsolute(parsed.skillDir))) throw new Error('Custom Skill registration requires an absolute --skill-dir path');
  if (parsed.platform !== 'custom' && parsed.skillDir) throw new Error('--skill-dir is only valid for custom platform');
  if (parsed.replaceFollowBuilders && !parsed.register) throw new Error('--replace-follow-builders requires --register');
  return parsed;
}

async function pathState(path, fsImpl) {
  try { return await fsImpl.lstat(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino
    && left.isDirectory() === right.isDirectory() && left.isSymbolicLink() === right.isSymbolicLink());
}

async function snapshotPayload(root, fsImpl, { target = false } = {}) {
  const entries = new Map(); const rootPath = resolve(root);
  async function visit(path) {
    const metadata = await fsImpl.lstat(path); const rel = relative(rootPath, path).split(sep).join('/');
    if (target && (rel === OWNER_FILE || rel === COMPLETE_FILE || rel === 'scripts/node_modules' || rel.startsWith('scripts/node_modules/'))) return;
    if (metadata.isSymbolicLink()) {
      if (target && rel.startsWith('scripts/node_modules/')) return;
      throw new Error('Payload snapshot rejects symbolic links');
    }
    if (metadata.isDirectory()) {
      if (rel) entries.set(rel, { type: 'directory', mode: metadata.mode & 0o777 });
      for (const name of await fsImpl.readdir(path)) await visit(join(path, name));
      return;
    }
    if (!metadata.isFile()) throw new Error('Payload snapshot rejects unsupported file types');
    entries.set(rel, { type: 'file', mode: metadata.mode & 0o777, size: metadata.size,
      sha256: createHash('sha256').update(await fsImpl.readFile(path)).digest('hex') });
  }
  await visit(rootPath); return entries;
}

async function verifyPayloadSnapshot(expected, objectRoot, fsImpl) {
  const actual = await snapshotPayload(objectRoot, fsImpl, { target: true });
  if (actual.size !== expected.size) throw new Error('Installed payload snapshot has unexpected paths');
  for (const [path, value] of expected) {
    if (JSON.stringify(actual.get(path)) !== JSON.stringify(value)) throw new Error(`Installed payload snapshot mismatch at ${path}`);
  }
}

async function inspectTree(root, fsImpl, { rejectDependencies = false, skipDependencies = false } = {}) {
  const sourceRoot = resolve(root);
  async function visit(path) {
    const metadata = await fsImpl.lstat(path);
    if (metadata.isSymbolicLink()) throw new Error('Archive and installation paths must not contain symbolic links');
    if (metadata.isDirectory()) {
      for (const entry of await fsImpl.readdir(path)) {
        if (entry === '.' || entry === '..' || entry.includes(sep)) throw new Error('Archive path traversal detected');
        if (rejectDependencies && (entry === 'node_modules' || entry === '.git')) throw new Error(`Archive must be pristine and must not contain ${entry}`);
        if (skipDependencies && entry === 'node_modules') continue;
        const child = resolve(path, entry);
        const rel = relative(sourceRoot, child);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Archive path traversal detected');
        await visit(child);
      }
    } else if (!metadata.isFile()) throw new Error('Archive contains an unsupported file type');
  }
  await visit(sourceRoot);
}

async function ensureDirectorySafe(path, fsImpl) {
  const absolute = resolve(path); const root = parse(absolute).root; let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component); const metadata = await pathState(current, fsImpl);
    if (metadata) { if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Installation path contains an unsafe component'); }
    else await fsImpl.mkdir(current, { mode: 0o700 });
  }
}

async function copyTree(source, target, fsImpl, { createTarget = true, allowInternalSymlinks = false } = {}) {
  const sourceRoot = resolve(source); const targetRoot = resolve(target);
  if (createTarget) await fsImpl.mkdir(targetRoot, { mode: 0o700 });
  async function copy(current, destination) {
    const metadata = await fsImpl.lstat(current);
    if (metadata.isSymbolicLink()) {
      if (!allowInternalSymlinks) throw new Error('Archive contains an unsafe symbolic link');
      const link = await fsImpl.readlink(current);
      const resolved = resolve(dirname(current), link); const rel = relative(sourceRoot, resolved);
      if (isAbsolute(link) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Installed dependency contains an escaping symbolic link');
      await fsImpl.symlink(link, destination); return;
    }
    if (metadata.isDirectory()) {
      if (current !== sourceRoot) await fsImpl.mkdir(destination, { mode: metadata.mode & 0o777 });
      for (const entry of await fsImpl.readdir(current)) {
        const child = resolve(current, entry); const rel = relative(sourceRoot, child);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Archive path traversal detected');
        await copy(child, join(destination, entry));
      }
    } else if (metadata.isFile()) await fsImpl.copyFile(current, destination);
    else throw new Error('Archive contains an unsupported file type');
  }
  await copy(sourceRoot, targetRoot);
}

async function syncTree(root, fsImpl) {
  const metadata = await fsImpl.lstat(root);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const entry of await fsImpl.readdir(root)) await syncTree(join(root, entry), fsImpl);
  }
  const handle = await fsImpl.open(root, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function completionPayload(root, version, transactionId, fsImpl) {
  const manifestSha256 = createHash('sha256').update(await fsImpl.readFile(join(root, 'release-manifest.json'))).digest('hex');
  return { schemaVersion: 1, version, manifestSha256, transactionId };
}

async function readRegularNoFollow(path, fsImpl) {
  const handle = await fsImpl.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Installation marker is not a regular file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function validateCompletion(root, version, fsImpl) {
  const metadata = await pathState(join(root, COMPLETE_FILE), fsImpl);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error('Immutable release completion marker is missing');
  const [markerText, owner] = await Promise.all([
    readRegularNoFollow(join(root, COMPLETE_FILE), fsImpl),
    readRegularNoFollow(join(root, OWNER_FILE), fsImpl),
  ]);
  const marker = JSON.parse(markerText);
  const expected = await completionPayload(root, version, marker.transactionId, fsImpl);
  if (marker.schemaVersion !== expected.schemaVersion || marker.version !== version
      || marker.manifestSha256 !== expected.manifestSha256
      || typeof marker.transactionId !== 'string' || marker.transactionId.length < 8
      || owner !== `${marker.transactionId}\n`) {
    throw new Error('Immutable release completion marker is invalid');
  }
  return marker;
}

function objectPrefix(version) { return `.${version}.object-`; }

async function resolveReleasePointer(releaseRoot, version, releasesDir, fsImpl) {
  const metadata = await pathState(releaseRoot, fsImpl);
  if (!metadata) return null;
  if (metadata.isSymbolicLink()) {
    const link = await fsImpl.readlink(releaseRoot);
    if (isAbsolute(link) || dirname(link) !== '.' || !link.startsWith(objectPrefix(version))) throw new Error('Existing release pointer is unsafe');
    const objectRoot = join(releasesDir, link); const objectMetadata = await fsImpl.lstat(objectRoot);
    if (objectMetadata.isSymbolicLink() || !objectMetadata.isDirectory()) throw new Error('Existing release object is unsafe');
    if (await fsImpl.realpath(objectRoot) !== resolve(objectRoot)) throw new Error('Existing release object escapes releases directory');
    return { objectRoot, objectIdentity: objectMetadata, pointerTarget: link };
  }
  if (metadata.isDirectory()) return { objectRoot: releaseRoot, objectIdentity: metadata, pointerTarget: null };
  throw new Error('Existing release path is unsafe');
}

async function writeRegistrationMetadata(userDir, registration, fsImpl, id) {
  const path = join(userDir, 'active.json'); const temporary = join(userDir, `.active.json.tmp-${id}`);
  let current = {};
  try { current = JSON.parse(await fsImpl.readFile(path, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await fsImpl.writeFile(temporary, `${JSON.stringify({ ...current, registration }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await fsImpl.rename(temporary, path);
}

async function restoreRegistrationMetadata(userDir, previous, fsImpl, id) {
  const path = join(userDir, 'active.json');
  if (previous === null) { await fsImpl.rm(path, { force: true }); return; }
  const temporary = join(userDir, `.active.json.restore-${id}`);
  await fsImpl.writeFile(temporary, previous, { flag: 'wx', mode: 0o600 });
  await fsImpl.rename(temporary, path);
}

async function validateArchive(root, nodeVersion, validateReleaseImpl, validateCriticalImpl) {
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!Number.isSafeInteger(major) || major < 20) throw new Error('Node.js >=20.0.0 is required');
  const releaseErrors = await validateReleaseImpl(root, { mode: 'archive', verifyIntegrity: true, validateSchema: false });
  if (releaseErrors.length) throw new Error(`Archive validation failed: ${releaseErrors.join('; ')}`);
  const criticalErrors = await validateCriticalImpl(root);
  if (criticalErrors.length) throw new Error(`Archive critical-file validation failed: ${criticalErrors.join('; ')}`);
}

export async function runReleaseDoctor(options, {
  execFileImpl = execFile,
  env = process.env,
} = {}) {
  if (options.allowIncomplete !== true) {
    const version = (await systemFs.readFile(join(options.releaseRoot, 'VERSION'), 'utf8')).trim();
    await validateCompletion(options.releaseRoot, version, systemFs);
  }
  const doctorUrl = pathToFileURL(join(options.releaseRoot, 'scripts', 'doctor.js')).href;
  const serialized = JSON.stringify({
    home: options.home,
    releaseRoot: options.releaseRoot,
    requireRegistration: options.requireRegistration,
    platform: options.platform,
    skillDir: options.skillDir,
  });
  const program = `const module = await import(${JSON.stringify(doctorUrl)}); const options = ${serialized}; const result = await module.runDoctor(['--json'], { ...options, stdout: (value) => process.stdout.write(String(value)), stderr: (value) => process.stderr.write(String(value)) }); process.exitCode = result.exitCode;`;
  let stdout;
  let exitCode = 0;
  try {
    ({ stdout } = await execFileImpl(process.execPath, ['--input-type=module', '--eval', program], {
      env: { ...env, HOME: options.home }, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = error?.stdout;
    exitCode = Number.isSafeInteger(error?.code) ? error.code : 1;
  }
  let report;
  try { report = JSON.parse(String(stdout)); } catch { throw new Error('Release doctor did not return valid JSON'); }
  if (report.exitCode !== exitCode) throw new Error('Release doctor exit code did not match its JSON report');
  return { exitCode, report };
}

async function completeObject(objectRoot, objectIdentity, version, transactionId, fsImpl) {
  if (!sameIdentity(objectIdentity, await fsImpl.lstat(objectRoot))) throw new Error('Release object changed during installation');
  await syncTree(objectRoot, fsImpl);
  const payload = await completionPayload(objectRoot, version, transactionId, fsImpl);
  const temporary = join(objectRoot, `.install-complete.tmp-${transactionId}`);
  await fsImpl.writeFile(temporary, `${JSON.stringify(payload)}\n`, { flag: 'wx', mode: 0o600 });
  const handle = await fsImpl.open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  if (!sameIdentity(objectIdentity, await fsImpl.lstat(objectRoot))) throw new Error('Release object changed before completion');
  await fsImpl.rename(temporary, join(objectRoot, COMPLETE_FILE));
  const directory = await fsImpl.open(objectRoot, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

async function runInternalWorker(mode, args, { cwd, capability, env = process.env, onReady }) {
  const child = spawn(process.execPath, [WORKER_PATH, mode, capability, ...args], {
    cwd, env: { ...env, FOLLOW_UP_INSTALL_CAPABILITY: capability },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk; });
  let ready = false; let created = false; let durable = false; let done = false;
  const completion = new Promise((accept, reject) => {
    child.once('error', reject);
    child.on('message', (message) => {
      if (message?.type === 'ready' && !ready && !created && !durable && !done) ready = true;
      else if (message?.type === 'created' && ready && !created && !durable && !done) created = true;
      else if (message?.type === 'durable' && created && !durable && !done) durable = true;
      else if (message?.type === 'done' && ready && !done && (mode === 'object' || durable)) done = true;
      else { child.kill(); reject(new Error('Invalid installer worker message sequence')); }
    });
    child.once('close', (code) => {
      if (code === 0 && done) accept({ created, durable });
      else { const error = new Error('Installer internal worker failed'); error.created = created; error.durable = durable; reject(error); }
    });
  });
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Installer internal worker did not become ready')), 30_000);
    child.once('message', (message) => { clearTimeout(timer); message?.type === 'ready' ? accept() : reject(new Error('Invalid installer worker response')); });
    child.once('error', reject);
  });
  try { await onReady?.(); child.send({ type: 'start', capability }); } catch (error) { child.kill(); throw error; }
  return completion;
}

export async function runInstaller(args, options = {}) {
  const usesInjectedBuild = ['copyReleaseImpl', 'npmCiImpl', 'doctorImpl'].some((key) => Object.hasOwn(options, key));
  const {
    root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), home = process.env.HOME ?? homedir(), nodeVersion = process.versions.node,
    fsImpl = systemFs, validateReleaseImpl = validateRelease, validateArchiveCriticalFilesImpl = validateArchiveCriticalFiles,
    copyReleaseImpl = copyTree, npmCiImpl = async (cwd) => execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], { cwd }),
    registerSkillImpl = registerSkill, doctorImpl = runReleaseDoctor,
    objectWorkerImpl, pointerWorkerImpl = runInternalWorker,
    onSnapshotComplete, onPreflightComplete, onObjectWorkerReady, onObjectWorkerComplete, onPointerWorkerReady,
    stdout = console.log, stderr = console.error, transactionId = randomUUID(),
  } = options;
  let parsed;
  try { parsed = parseInstallArgs(args); } catch (error) { stderr(`${error.message}\n${USAGE}`); return { exitCode: EX_USAGE, error }; }
  const sourceRoot = resolve(root); let lockPath; let lockIdentity; let lockOwned = false; let objectRoot; let objectIdentity; let pointerTarget; let pointerPublished = false; let published = false; let reused = false;
  let releasesDir; let releasesIdentity;
  let metadataPrevious; let metadataChanged = false;
  try {
    await inspectTree(sourceRoot, fsImpl, { rejectDependencies: true });
    const payloadSnapshot = await snapshotPayload(sourceRoot, fsImpl);
    await onSnapshotComplete?.();
    await validateArchive(sourceRoot, nodeVersion, validateReleaseImpl, validateArchiveCriticalFilesImpl);
    const version = (await fsImpl.readFile(join(sourceRoot, 'VERSION'), 'utf8')).trim();
    await onPreflightComplete?.();
    const userDir = join(home, '.follow-builders'); releasesDir = join(userDir, 'releases'); const releaseRoot = join(releasesDir, version);
    await ensureDirectorySafe(userDir, fsImpl); lockPath = join(userDir, '.install.lock');
    try {
      await fsImpl.mkdir(lockPath, { mode: 0o700 }); lockIdentity = await fsImpl.lstat(lockPath);
      await fsImpl.writeFile(join(lockPath, 'owner'), `${transactionId}\n`, { flag: 'wx', mode: 0o600 }); lockOwned = true;
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('Another Follow-up installer is running');
      if (lockIdentity && sameIdentity(lockIdentity, await pathState(lockPath, fsImpl))) await fsImpl.rm(lockPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const configPath = join(userDir, 'config.json'); const configMetadata = await pathState(configPath, fsImpl);
    if (configMetadata) {
      if (configMetadata.isSymbolicLink() || !configMetadata.isFile()) throw new Error('Existing configuration path is unsafe');
    } else {
      try { await fsImpl.writeFile(configPath, '{}\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; throw new Error('Configuration path changed concurrently'); }
    }
    await ensureDirectorySafe(releasesDir, fsImpl); releasesIdentity = await fsImpl.lstat(releasesDir);
    const existing = await resolveReleasePointer(releaseRoot, version, releasesDir, fsImpl);
    if (existing) {
      ({ objectRoot, objectIdentity, pointerTarget } = existing);
      await validateCompletion(objectRoot, version, fsImpl);
      await inspectTree(objectRoot, fsImpl, { skipDependencies: true });
      const errors = await validateReleaseImpl(objectRoot, { mode: 'archive', verifyIntegrity: true });
      if (errors.length) throw new Error(`Existing immutable release is invalid: ${errors.join('; ')}`);
      reused = true;
    } else {
      objectRoot = await fsImpl.mkdtemp(join(releasesDir, `${objectPrefix(version)}${transactionId}-`));
      await fsImpl.chmod(objectRoot, 0o700); objectIdentity = await fsImpl.lstat(objectRoot);
      if (objectWorkerImpl || !usesInjectedBuild) {
        await (objectWorkerImpl ?? runInternalWorker)('object', [sourceRoot, version, transactionId], {
          cwd: objectRoot, capability: transactionId, env: { ...process.env, HOME: home },
          onReady: () => onObjectWorkerReady?.({ objectRoot, releasesDir }),
        });
      } else {
        await fsImpl.writeFile(join(objectRoot, OWNER_FILE), `${transactionId}\n`, { flag: 'wx', mode: 0o600 });
        await copyReleaseImpl(sourceRoot, objectRoot, fsImpl, { createTarget: false });
        await npmCiImpl(join(objectRoot, 'scripts'));
        const stagedDoctor = await doctorImpl({ home, releaseRoot: objectRoot, requireRegistration: false, allowIncomplete: true });
        const stagedCode = typeof stagedDoctor === 'number' ? stagedDoctor : stagedDoctor?.exitCode;
        if (stagedCode !== 0 && stagedCode !== 2) throw new Error('Local doctor checks failed');
        await completeObject(objectRoot, objectIdentity, version, transactionId, fsImpl);
      }
      if (!sameIdentity(objectIdentity, await fsImpl.lstat(objectRoot))) throw new Error('Release object changed during copy');
      await onObjectWorkerComplete?.({ objectRoot, releasesDir });
      const objectErrors = await validateReleaseImpl(objectRoot, { mode: 'archive', verifyIntegrity: true, validateSchema: false });
      if (objectErrors.length) throw new Error(`Installed object validation failed: ${objectErrors.join('; ')}`);
      const objectCriticalErrors = await validateArchiveCriticalFilesImpl(objectRoot);
      if (objectCriticalErrors.length) throw new Error(`Installed object critical-file validation failed: ${objectCriticalErrors.join('; ')}`);
      await verifyPayloadSnapshot(payloadSnapshot, objectRoot, fsImpl);
      await validateCompletion(objectRoot, version, fsImpl); published = true;
      if (!sameIdentity(releasesIdentity, await fsImpl.lstat(releasesDir))) throw new Error('Release directory changed before pointer publication');
      pointerTarget = relative(releasesDir, objectRoot);
      let publication;
      try {
        publication = await pointerWorkerImpl('publish', [pointerTarget, version], {
          cwd: releasesDir, capability: transactionId,
          onReady: () => onPointerWorkerReady?.({ releasesDir, releaseRoot, pointerTarget }),
        });
      } catch (error) {
        if (error?.created) {
          pointerPublished = true;
          const uncertain = new Error('Install publication is uncertain after the version pointer was created', { cause: error });
          uncertain.code = 'INSTALL_PUBLICATION_UNCERTAIN'; uncertain.publicationUncertain = true; throw uncertain;
        }
        if (await pathState(releaseRoot, fsImpl)) throw new Error('Release target became occupied during installation');
        throw error;
      }
      const injectedPointer = pointerWorkerImpl !== runInternalWorker;
      if (!injectedPointer && publication?.durable !== true) {
        const uncertain = new Error('Install publication is uncertain because pointer durability was not confirmed'); uncertain.code = 'INSTALL_PUBLICATION_UNCERTAIN'; uncertain.publicationUncertain = true; throw uncertain;
      }
      pointerPublished = true;
      if (!sameIdentity(releasesIdentity, await fsImpl.lstat(releasesDir)) || await fsImpl.readlink(releaseRoot) !== pointerTarget) throw new Error('Release pointer changed during publication');
    }
    const verifyRegistration = async () => {
      const result = await doctorImpl({ home, releaseRoot: objectRoot, platform: parsed.platform, skillDir: parsed.skillDir, requireRegistration: true });
      const code = typeof result === 'number' ? result : result?.exitCode;
      return code === 0 || code === 2;
    };
    if (parsed.register) {
      const activePath = join(userDir, 'active.json');
      metadataPrevious = await fsImpl.readFile(activePath).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
      await writeRegistrationMetadata(userDir, { platform: parsed.platform, ...(parsed.skillDir ? { skillDir: parsed.skillDir } : {}) }, fsImpl, transactionId);
      metadataChanged = true;
      const registration = await registerSkillImpl({ platform: parsed.platform, skillDir: parsed.skillDir, home, releaseRoot, replaceLegacy: parsed.replaceFollowBuilders, verify: verifyRegistration, fsImpl });
      stdout(`Follow-up ${version} is ready and registered at ${registration?.registrationPath ?? 'the selected Skill directory'}.`);
    } else {
      const result = await doctorImpl({ home, releaseRoot: objectRoot, requireRegistration: false });
      const code = typeof result === 'number' ? result : result?.exitCode;
      if (code !== 0 && code !== 2) throw new Error('Local doctor checks failed');
      stdout(`Follow-up ${version} is ready. Registration was not requested.`);
    }
    return { exitCode: 0, version, releaseRoot, reused };
  } catch (error) {
    let rollbackError;
    if (metadataChanged) {
      try { await restoreRegistrationMetadata(join(home, '.follow-builders'), metadataPrevious, fsImpl, transactionId); }
      catch (restoreError) { rollbackError = restoreError; }
    }
    if (error?.code === 'REGISTRATION_ROLLBACK_FAILED') rollbackError ??= error;
    const releaseParentOwned = releasesDir && sameIdentity(releasesIdentity, await pathState(releasesDir, fsImpl));
    if (error?.code === 'INSTALL_PUBLICATION_UNCERTAIN') {
      stderr(error.message); return { exitCode: 1, error, publicationUncertain: true, published };
    }
    // Random incomplete or unreferenced objects are ignored by reuse and doctor. Removing
    // their root by pathname after a worker/callback would reintroduce the replacement race.
    if (rollbackError) {
      const uncertain = new Error(`Installation rollback is uncertain: ${rollbackError.message}`, { cause: error });
      uncertain.code = 'INSTALL_ROLLBACK_UNCERTAIN'; stderr(uncertain.message); return { exitCode: 1, error: uncertain, rollbackUncertain: true, published };
    }
    stderr(error.message); return { exitCode: 1, error };
  } finally {
    if (lockOwned && lockPath) {
      const [current, token] = await Promise.all([
        pathState(lockPath, fsImpl), fsImpl.readFile(join(lockPath, 'owner'), 'utf8').catch(() => null),
      ]);
      if (sameIdentity(lockIdentity, current) && token === `${transactionId}\n`) {
        await fsImpl.rm(lockPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) process.exitCode = (await runInstaller(process.argv.slice(2))).exitCode;
