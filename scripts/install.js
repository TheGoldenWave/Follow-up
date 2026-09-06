#!/usr/bin/env node

import { execFile as nodeExecFile } from 'node:child_process';
import * as systemFs from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { validateArchiveCriticalFiles } from './release/validate-release.js';
import { registerSkill } from './lib/skill-registration.js';
import { runDoctor } from './doctor.js';

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
  if (!parsed.platform || !['codex', 'claude-code', 'custom'].includes(parsed.platform)) {
    throw new Error(`Unsupported or missing --platform. ${USAGE}`);
  }
  if (parsed.platform === 'custom' && (!parsed.skillDir || !isAbsolute(parsed.skillDir))) {
    throw new Error('Custom Skill registration requires an absolute --skill-dir path');
  }
  if (parsed.platform !== 'custom' && parsed.skillDir) throw new Error('--skill-dir is only valid for custom platform');
  if (parsed.replaceFollowBuilders && !parsed.register) throw new Error('--replace-follow-builders requires --register');
  return parsed;
}

async function copyTree(source, target, fsImpl) {
  const sourceRoot = resolve(source);
  async function copy(current, destination) {
    const metadata = await fsImpl.lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`Archive contains unsafe symbolic link: ${current}`);
    if (metadata.isDirectory()) {
      await fsImpl.mkdir(destination, { recursive: true, mode: 0o755 });
      for (const entry of await fsImpl.readdir(current)) {
        const child = resolve(current, entry);
        if (relative(sourceRoot, child).startsWith('..')) throw new Error('Archive path traversal detected');
        await copy(child, join(destination, entry));
      }
    } else if (metadata.isFile()) {
      await fsImpl.mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await fsImpl.copyFile(current, destination);
    } else throw new Error(`Archive contains unsupported file: ${current}`);
  }
  await copy(sourceRoot, target);
}

async function readVersion(root, fsImpl) {
  const version = (await fsImpl.readFile(join(root, 'VERSION'), 'utf8')).trim();
  const manifest = JSON.parse(await fsImpl.readFile(join(root, 'release-manifest.json'), 'utf8'));
  if (!version || manifest.productVersion !== version) throw new Error('VERSION and manifest productVersion mismatch');
  const packageJson = JSON.parse(await fsImpl.readFile(join(root, 'scripts', 'package.json'), 'utf8'));
  const lockJson = JSON.parse(await fsImpl.readFile(join(root, 'scripts', 'package-lock.json'), 'utf8'));
  if (packageJson.version !== version || lockJson.version !== version
      || lockJson.packages?.['']?.version !== version) {
    throw new Error('VERSION, package, and lockfile versions mismatch');
  }
  return version;
}

export async function runInstaller(args, options = {}) {
  const {
    root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    home = process.env.HOME,
    nodeVersion = process.versions.node,
    fsImpl = systemFs,
    validateArchiveCriticalFilesImpl = validateArchiveCriticalFiles,
    copyReleaseImpl = copyTree,
    npmCiImpl = async (cwd) => execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd }),
    registerSkillImpl = registerSkill,
    doctorImpl = async ({ home: doctorHome, releaseRoot }) => (
      await runDoctor([], { home: doctorHome, releaseRoot })
    ).exitCode,
    stdout = console.log,
    stderr = console.error,
  } = options;
  let parsed;
  try { parsed = parseInstallArgs(args); } catch (error) {
    stderr(`${error.message}\n${USAGE}`); return { exitCode: EX_USAGE, error };
  }
  try {
    if (Number.parseInt(nodeVersion, 10) < 20) throw new Error('Node.js >=20.0.0 is required');
    const version = await readVersion(root, fsImpl);
    const lock = await fsImpl.stat(join(root, 'scripts', 'package-lock.json')).catch(() => null);
    if (!lock?.isFile()) throw new Error('scripts/package-lock.json is required');
    const criticalErrors = await validateArchiveCriticalFilesImpl(root);
    if (criticalErrors.length) throw new Error(`Archive verification failed: ${criticalErrors.join('; ')}`);

    const releaseRoot = join(home ?? process.env.HOME ?? homedir(), '.follow-builders', 'releases', version);
    await copyReleaseImpl(root, releaseRoot, fsImpl);
    await npmCiImpl(join(releaseRoot, 'scripts'));
    const doctorVerify = async () => {
      const result = await doctorImpl({ home, releaseRoot });
      const code = typeof result === 'number' ? result : result?.exitCode;
      return code === 0 || code === 2;
    };
    if (parsed.register) {
      await registerSkillImpl({ platform: parsed.platform, skillDir: parsed.skillDir, home,
        releaseRoot, replaceLegacy: parsed.replaceFollowBuilders, verify: doctorVerify, fsImpl });
    }
    stdout(`Follow-up ${version} is ready${parsed.register ? ' and registered' : ''}.`);
    return { exitCode: 0, version, releaseRoot };
  } catch (error) {
    stderr(error.message); return { exitCode: 1, error };
  }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) process.exitCode = (await runInstaller(process.argv.slice(2))).exitCode;
