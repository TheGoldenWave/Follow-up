#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OWNER_FILE = '.install-owner';
const COMPLETE_FILE = '.install-complete.json';
let currentStage = 'copy';

function fail(message) { throw new Error(message); }

function validateCapability(value) {
  if (!/^[0-9a-f-]{36}$/u.test(value ?? '') || process.env.FOLLOW_UP_INSTALL_CAPABILITY !== value) fail('Invalid installer worker capability');
  if (typeof process.send !== 'function') fail('Installer worker requires a private IPC channel');
}

async function waitForStart(capability) {
  process.send({ type: 'ready' });
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Installer worker start timed out')), 30_000);
    process.once('message', (message) => {
      clearTimeout(timer);
      if (message?.type !== 'start' || message.capability !== capability) reject(new Error('Invalid installer worker start message'));
      else accept();
    });
  });
}

async function copyTree(source, destination = '.') {
  const sourceRoot = resolve(source);
  async function copy(current, target) {
    const metadata = await fs.lstat(current);
    if (metadata.isSymbolicLink()) fail('Verified archive contains a symbolic link');
    if (metadata.isDirectory()) {
      if (target !== '.') await fs.mkdir(target, { mode: metadata.mode & 0o777 });
      for (const entry of await fs.readdir(current)) {
        const child = resolve(current, entry); const rel = relative(sourceRoot, child);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('Archive path traversal detected');
        await copy(child, join(target, entry));
      }
    } else if (metadata.isFile()) await fs.copyFile(current, target);
    else fail('Verified archive contains an unsupported file type');
  }
  await copy(sourceRoot, destination);
}

async function syncTree(path) {
  const metadata = await fs.lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) for (const entry of await fs.readdir(path)) await syncTree(join(path, entry));
  const handle = await fs.open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

async function buildObject(sourceRoot, version, transactionId) {
  currentStage = 'copy';
  await fs.writeFile(OWNER_FILE, `${transactionId}\n`, { flag: 'wx', mode: 0o600 });
  await copyTree(sourceRoot);
  currentStage = 'npm-ci';
  await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], { cwd: 'scripts', timeout: 120_000 });
  currentStage = 'doctor';
  const releaseRoot = process.cwd();
  const doctor = await import(pathToFileURL(resolve('scripts/doctor.js')).href);
  const result = await doctor.runDoctor(['--json'], { home: process.env.HOME, releaseRoot, requireRegistration: false, stdout: () => {}, stderr: () => {} });
  if (result.exitCode !== 0 && result.exitCode !== 2) fail('Local doctor checks failed');
  currentStage = 'fsync';
  await syncTree('.');
  const manifestSha256 = createHash('sha256').update(await fs.readFile('release-manifest.json')).digest('hex');
  const payload = { schemaVersion: 1, version, manifestSha256, transactionId };
  const temporary = `.install-complete.tmp-${transactionId}`;
  await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, { flag: 'wx', mode: 0o600 });
  const handle = await fs.open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, COMPLETE_FILE);
  const directory = await fs.open('.', 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

async function publishPointer(objectName, versionName) {
  currentStage = 'pointer';
  if (dirname(objectName) !== '.' || dirname(versionName) !== '.' || !objectName.startsWith(`.${versionName}.object-`)) fail('Invalid release pointer names');
  await fs.symlink(objectName, versionName, 'dir');
  process.send({ type: 'created' });
  const directory = await fs.open('.', 'r'); try { await directory.sync(); } finally { await directory.close(); }
  process.send({ type: 'durable' });
}

async function removePointer(objectName, versionName) {
  currentStage = 'pointer';
  if (await fs.readlink(versionName) !== objectName) fail('Release pointer ownership changed');
  await fs.unlink(versionName);
  process.send({ type: 'created' });
  const directory = await fs.open('.', 'r'); try { await directory.sync(); } finally { await directory.close(); }
  process.send({ type: 'durable' });
}

const [mode, capability, ...args] = process.argv.slice(2);
try {
  validateCapability(capability); await waitForStart(capability);
  if (mode === 'object') {
    if (args.length !== 3 || !isAbsolute(args[0]) || !/^\d+\.\d+\.\d+$/u.test(args[1]) || args[2] !== capability) fail('Invalid object worker arguments');
    await buildObject(...args);
  } else if (mode === 'publish') {
    if (args.length !== 2) fail('Invalid pointer worker arguments');
    await publishPointer(...args);
  } else if (mode === 'remove') {
    if (args.length !== 2) fail('Invalid pointer cleanup arguments');
    await removePointer(...args);
  }
  else fail('Unknown installer worker mode');
  process.send({ type: 'done' });
} catch (error) {
  const code = `WORKER_${currentStage.toUpperCase().replaceAll('-', '_')}_FAILED`;
  process.send?.({ type: 'failed', stage: currentStage, code });
  process.exitCode = 1;
}
