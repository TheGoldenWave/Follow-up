#!/usr/bin/env node

import { execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

async function copyTree(source, target, fsImpl) {
  const sourceRoot = resolve(source); const targetRoot = resolve(target);
  await fsImpl.mkdir(targetRoot, { mode: 0o700 });
  async function copy(current, destination) {
    const metadata = await fsImpl.lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('Archive contains an unsafe symbolic link');
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

async function promoteRelease(stagingRoot, releaseRoot, { fsImpl, releasesDir, releasesIdentity }) {
  if (!sameIdentity(releasesIdentity, await fsImpl.lstat(releasesDir))) throw new Error('Release directory changed during installation');
  if (await pathState(releaseRoot, fsImpl)) throw new Error('Release target became occupied during installation');
  if (process.platform === 'win32') throw new Error('Atomic no-clobber release promotion is unsupported on Windows');
  await execFile('mv', ['-n', stagingRoot, releaseRoot]);
}

async function verifyPromotion(stagingRoot, releaseRoot, stagingIdentity, { fsImpl, releasesDir, releasesIdentity }) {
  const [parentAfter, targetAfter, stagingAfter] = await Promise.all([
    pathState(releasesDir, fsImpl), pathState(releaseRoot, fsImpl), pathState(stagingRoot, fsImpl),
  ]);
  if (!sameIdentity(releasesIdentity, parentAfter) || !sameIdentity(stagingIdentity, targetAfter) || stagingAfter) {
    throw new Error('Release promotion lost its no-clobber guarantee');
  }
}

export async function runInstaller(args, options = {}) {
  const {
    root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), home = process.env.HOME ?? homedir(), nodeVersion = process.versions.node,
    fsImpl = systemFs, validateReleaseImpl = validateRelease, validateArchiveCriticalFilesImpl = validateArchiveCriticalFiles,
    copyReleaseImpl = copyTree, npmCiImpl = async (cwd) => execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], { cwd }),
    registerSkillImpl = registerSkill, doctorImpl = runReleaseDoctor,
    promoteReleaseImpl = promoteRelease,
    stdout = console.log, stderr = console.error, transactionId = randomUUID(),
  } = options;
  let parsed;
  try { parsed = parseInstallArgs(args); } catch (error) { stderr(`${error.message}\n${USAGE}`); return { exitCode: EX_USAGE, error }; }
  const sourceRoot = resolve(root); let lockPath; let lockIdentity; let lockOwned = false; let stagingRoot; let promoted = false; let reused = false;
  let releasesDir; let releasesIdentity;
  let metadataPrevious; let metadataChanged = false; let configCreated = false;
  try {
    await inspectTree(sourceRoot, fsImpl, { rejectDependencies: true });
    await validateArchive(sourceRoot, nodeVersion, validateReleaseImpl, validateArchiveCriticalFilesImpl);
    const version = (await fsImpl.readFile(join(sourceRoot, 'VERSION'), 'utf8')).trim();
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
      try { await fsImpl.writeFile(configPath, '{}\n', { flag: 'wx', mode: 0o600 }); configCreated = true; }
      catch (error) { if (error?.code !== 'EEXIST') throw error; throw new Error('Configuration path changed concurrently'); }
    }
    await ensureDirectorySafe(releasesDir, fsImpl); releasesIdentity = await fsImpl.lstat(releasesDir);
    const existing = await pathState(releaseRoot, fsImpl);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('Existing release path is unsafe');
      await inspectTree(releaseRoot, fsImpl, { skipDependencies: true });
      const errors = await validateReleaseImpl(releaseRoot, { mode: 'archive', verifyIntegrity: true });
      if (errors.length) throw new Error(`Existing immutable release is invalid: ${errors.join('; ')}`);
      reused = true;
    } else {
      stagingRoot = join(releasesDir, `.${version}.staging-${transactionId}`);
      if (await pathState(stagingRoot, fsImpl)) throw new Error('Unique staging directory already exists');
      await copyReleaseImpl(sourceRoot, stagingRoot, fsImpl);
      await npmCiImpl(join(stagingRoot, 'scripts'));
      const stagedDoctor = await doctorImpl({ home, releaseRoot: stagingRoot, requireRegistration: false });
      const stagedCode = typeof stagedDoctor === 'number' ? stagedDoctor : stagedDoctor?.exitCode;
      if (stagedCode !== 0 && stagedCode !== 2) throw new Error('Local doctor checks failed');
      const stagingIdentity = await fsImpl.lstat(stagingRoot);
      await promoteReleaseImpl(stagingRoot, releaseRoot, { fsImpl, releasesDir, releasesIdentity });
      await verifyPromotion(stagingRoot, releaseRoot, stagingIdentity, { fsImpl, releasesDir, releasesIdentity });
      stagingRoot = undefined; promoted = true;
    }
    const verifyRegistration = async () => {
      const result = await doctorImpl({ home, releaseRoot, platform: parsed.platform, skillDir: parsed.skillDir, requireRegistration: true });
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
      const result = await doctorImpl({ home, releaseRoot, requireRegistration: false });
      const code = typeof result === 'number' ? result : result?.exitCode;
      if (code !== 0 && code !== 2) throw new Error('Local doctor checks failed');
      stdout(`Follow-up ${version} is ready. Registration was not requested.`);
    }
    return { exitCode: 0, version, releaseRoot, reused };
  } catch (error) {
    if (metadataChanged) await restoreRegistrationMetadata(join(home, '.follow-builders'), metadataPrevious, fsImpl, transactionId).catch(() => {});
    const releaseParentOwned = releasesDir && sameIdentity(releasesIdentity, await pathState(releasesDir, fsImpl));
    if (stagingRoot && releaseParentOwned) await fsImpl.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (promoted && releaseParentOwned) {
      const version = await fsImpl.readFile(join(sourceRoot, 'VERSION'), 'utf8').then((value) => value.trim()).catch(() => null);
      if (version) await fsImpl.rm(join(home, '.follow-builders', 'releases', version), { recursive: true, force: true }).catch(() => {});
    }
    if (configCreated) {
      const configPath = join(home, '.follow-builders', 'config.json');
      const unchanged = await fsImpl.readFile(configPath, 'utf8').then((value) => value === '{}\n').catch(() => false);
      if (unchanged) await fsImpl.unlink(configPath).catch(() => {});
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
