import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseInstallArgs, runInstaller } from '../install.js';

async function fixture() {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'follow-install-')));
  const root = join(base, 'archive'); const home = join(base, 'home');
  await fs.mkdir(join(root, 'scripts'), { recursive: true });
  await fs.writeFile(join(root, 'VERSION'), '0.2.0\n'); await fs.writeFile(join(root, 'SKILL.md'), '# Follow-up\n');
  await fs.writeFile(join(root, 'release-manifest.json'), JSON.stringify({ productVersion: '0.2.0' }));
  await fs.writeFile(join(root, 'scripts', 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await fs.writeFile(join(root, 'scripts', 'package-lock.json'), JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.2.0' } } }));
  return { base, root, home, releaseRoot: join(home, '.follow-builders', 'releases', '0.2.0') };
}

function injected(options = {}) {
  return { validateReleaseImpl: async () => [], validateArchiveCriticalFilesImpl: async () => [], npmCiImpl: async () => {}, doctorImpl: async () => ({ exitCode: 0 }), stdout: () => {}, stderr: () => {}, ...options };
}

test('strict CLI supports three adapters and requires explicit registration authorization', () => {
  assert.deepEqual(parseInstallArgs(['--platform', 'codex']), { platform: 'codex', skillDir: undefined, register: false, replaceFollowBuilders: false });
  assert.deepEqual(parseInstallArgs(['--platform', 'claude-code', '--register']), { platform: 'claude-code', skillDir: undefined, register: true, replaceFollowBuilders: false });
  assert.throws(() => parseInstallArgs([]), /platform|usage/i); assert.throws(() => parseInstallArgs(['--platform', 'unknown']), /platform/i);
  assert.throws(() => parseInstallArgs(['--platform', 'custom', '--skill-dir', 'relative']), /absolute/i);
  assert.throws(() => parseInstallArgs(['--platform', 'codex', '--replace-follow-builders']), /register/i);
  assert.throws(() => parseInstallArgs(['--platform', 'codex', '--register', '--register']), /duplicate/i);
});

test('preflight rejects unsupported Node and missing lockfile before installation writes', async () => {
  const oldNode = await fixture(); let lifecycle = false;
  assert.equal((await runInstaller(['--platform', 'codex'], injected({ ...oldNode, nodeVersion: '19.9.0', npmCiImpl: async () => { lifecycle = true; } }))).exitCode, 1);
  assert.equal(lifecycle, false);
  const missingLock = await fixture(); await fs.rm(join(missingLock.root, 'scripts', 'package-lock.json'));
  assert.equal((await runInstaller(['--platform', 'codex'], injected({ ...missingLock, validateReleaseImpl: async () => ['lockfile missing'] }))).exitCode, 1);
  await assert.rejects(fs.lstat(missingLock.releaseRoot), { code: 'ENOENT' });
});

test('complete archive preflight runs before all writes and lifecycle actions', async () => {
  const f = await fixture(); const operations = [];
  const result = await runInstaller(['--platform', 'codex', '--register'], injected({ ...f,
    validateReleaseImpl: async (_root, options) => { assert.equal(options.validateSchema, false); operations.push('manifest'); return ['bad trust metadata']; },
    validateArchiveCriticalFilesImpl: async () => { operations.push('critical'); return []; },
    npmCiImpl: async () => operations.push('npm'), registerSkillImpl: async () => operations.push('register'),
    fsImpl: new Proxy(fs, { get(target, key) { if (['mkdir', 'rename', 'copyFile', 'writeFile', 'symlink'].includes(key)) return async () => operations.push(`write:${key}`); return target[key]; } }),
  }));
  assert.equal(result.exitCode, 1); assert.deepEqual(operations, ['manifest']);
});

test('clean install stages, installs, atomically publishes, then registers with adapter-aware doctor', async () => {
  const f = await fixture(); const operations = []; const skillDir = join(f.base, 'skills', 'follow-up');
  const result = await runInstaller(['--platform', 'custom', '--skill-dir', skillDir, '--register'], injected({ ...f,
    npmCiImpl: async (cwd) => operations.push(`npm:${cwd}`),
    doctorImpl: async ({ releaseRoot, platform, skillDir: selected, requireRegistration }) => { operations.push(`doctor:${releaseRoot}:${platform}:${selected}:${requireRegistration}`); return { exitCode: 0 }; },
    registerSkillImpl: async ({ releaseRoot, verify }) => { operations.push(`register:${releaseRoot}`); assert.equal(await verify(), true); },
  }));
  assert.equal(result.exitCode, 0); assert.equal(await fs.readFile(join(f.releaseRoot, 'SKILL.md'), 'utf8'), '# Follow-up\n');
  assert.deepEqual(JSON.parse(await fs.readFile(join(f.home, '.follow-builders', 'config.json'), 'utf8')), {});
  assert.match(operations[0], /npm:.*\.staging-/); assert.match(operations[1], /doctor:.*\.staging-.*:false/); assert.match(operations[2], /register:.*releases\/0\.2\.0/); assert.match(operations[3], /doctor:.*custom:.*follow-up:true/);
});

test('without registration local doctor gates publication and skips registration check', async () => {
  const f = await fixture(); let doctorOptions;
  const result = await runInstaller(['--platform', 'codex'], injected({ ...f, doctorImpl: async (options) => { doctorOptions = options; return { exitCode: 1 }; } }));
  assert.equal(result.exitCode, 1); assert.equal(doctorOptions.requireRegistration, false); await assert.rejects(fs.lstat(f.releaseRoot), { code: 'ENOENT' });
});

test('doctor exit 2 is accepted and local exit 1 removes newly published release', async () => {
  for (const [exitCode, expected] of [[2, 0], [1, 1]]) { const f = await fixture(); const result = await runInstaller(['--platform', 'codex'], injected({ ...f, doctorImpl: async () => ({ exitCode }) })); assert.equal(result.exitCode, expected); assert.equal(Boolean(await fs.lstat(f.releaseRoot).catch(() => null)), exitCode === 2); }
});

test('reinstall validates and reuses immutable release without copy or npm', async () => {
  const f = await fixture(); await fs.mkdir(f.releaseRoot, { recursive: true }); await fs.writeFile(join(f.releaseRoot, 'SKILL.md'), 'immutable'); const calls = [];
  const result = await runInstaller(['--platform', 'codex'], injected({ ...f, validateReleaseImpl: async (root) => { calls.push(root); return []; }, npmCiImpl: async () => calls.push('npm') }));
  assert.equal(result.exitCode, 0); assert.equal(await fs.readFile(join(f.releaseRoot, 'SKILL.md'), 'utf8'), 'immutable'); assert.deepEqual(calls, [f.root, f.releaseRoot]);
});

test('invalid existing release and symlinked release parents are rejected without overwrite', async () => {
  const f = await fixture(); await fs.mkdir(f.releaseRoot, { recursive: true }); await fs.writeFile(join(f.releaseRoot, 'sentinel'), 'keep');
  assert.equal((await runInstaller(['--platform', 'codex'], injected({ ...f, validateReleaseImpl: async (root) => root === f.root ? [] : ['invalid installed release'] }))).exitCode, 1);
  assert.equal(await fs.readFile(join(f.releaseRoot, 'sentinel'), 'utf8'), 'keep');
  const second = await fixture(); await fs.mkdir(join(second.home, '.follow-builders'), { recursive: true }); const outside = join(second.base, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, join(second.home, '.follow-builders', 'releases'));
  assert.equal((await runInstaller(['--platform', 'codex'], injected(second))).exitCode, 1); assert.deepEqual(await fs.readdir(outside), []);
});

test('source symlinks and copy, npm, or lock failure leave no release or staging', async () => {
  for (const failure of ['source-link', 'copy', 'npm', 'locked']) { const f = await fixture();
    if (failure === 'source-link') await fs.symlink('/tmp', join(f.root, 'escape'));
    if (failure === 'locked') { await fs.mkdir(join(f.home, '.follow-builders'), { recursive: true }); await fs.mkdir(join(f.home, '.follow-builders', '.install.lock')); }
    const overrides = { ...f }; if (failure === 'copy') overrides.copyReleaseImpl = async () => { throw new Error('copy failed'); }; if (failure === 'npm') overrides.npmCiImpl = async () => { throw new Error('npm failed'); };
    assert.equal((await runInstaller(['--platform', 'codex'], injected(overrides))).exitCode, 1, failure); assert.equal(Boolean(await fs.lstat(f.releaseRoot).catch(() => null)), false, failure);
    assert.equal((await fs.readdir(join(f.home, '.follow-builders', 'releases')).catch(() => [])).some((name) => name.includes('.staging-')), false, failure);
  }
});

test('v0.1 legacy upgrade requires replace and verifies new link before deletion for all adapters', async () => {
  for (const platform of ['codex', 'claude-code', 'custom']) { const f = await fixture(); const operations = []; const args = ['--platform', platform, '--register']; if (platform === 'custom') args.push('--skill-dir', join(f.base, 'agent', 'follow-up'));
    assert.equal((await runInstaller(args, injected({ ...f, registerSkillImpl: async () => { throw new Error('requires --replace-follow-builders'); } }))).exitCode, 1);
    const errors = []; const accepted = await runInstaller([...args, '--replace-follow-builders'], injected({ ...f, stderr: (message) => errors.push(message), registerSkillImpl: async ({ verify, replaceLegacy }) => { assert.equal(replaceLegacy, true); operations.push('link'); assert.equal(await verify(), true); operations.push('delete-legacy'); }, doctorImpl: async ({ platform: selected, requireRegistration }) => { if (requireRegistration) { assert.equal(selected, platform); operations.push('doctor'); } return { exitCode: 0 }; } }));
    assert.equal(accepted.exitCode, 0, errors.join('; ')); assert.deepEqual(operations, ['link', 'doctor', 'delete-legacy']);
  }
});

test('registration failure restores prior active metadata and removes a newly published release', async () => {
  const f = await fixture(); const user = join(f.home, '.follow-builders'); await fs.mkdir(user, { recursive: true });
  const original = Buffer.from('{"generation":"keep"}\n'); await fs.writeFile(join(user, 'active.json'), original);
  const result = await runInstaller(['--platform', 'custom', '--skill-dir', join(f.base, 'skills', 'follow-up'), '--register'], injected({ ...f,
    registerSkillImpl: async ({ verify }) => { assert.equal(await verify(), true); throw new Error('registration cleanup failed'); },
  }));
  assert.equal(result.exitCode, 1); assert.deepEqual(await fs.readFile(join(user, 'active.json')), original);
  await assert.rejects(fs.lstat(f.releaseRoot), { code: 'ENOENT' });
});

test('mutable config, prompts, env, and state remain byte-for-byte unchanged', async () => {
  const f = await fixture(); const user = join(f.home, '.follow-builders'); const files = { 'config.json': Buffer.from([0, 1, 2]), 'prompts/custom.md': Buffer.from('custom'), '.env': Buffer.from('TOKEN=x\n'), 'state/history.bin': Buffer.from([255, 4]) };
  for (const [name, bytes] of Object.entries(files)) { await fs.mkdir(join(user, name, '..'), { recursive: true }); await fs.writeFile(join(user, name), bytes); }
  assert.equal((await runInstaller(['--platform', 'codex'], injected(f))).exitCode, 0); for (const [name, bytes] of Object.entries(files)) assert.deepEqual(await fs.readFile(join(user, name)), bytes);
});

test('module has a main guard and README invokes installer directly with upgrade flag', async () => {
  const script = `import ${JSON.stringify(new URL('../install.js', import.meta.url).href)}; console.log('imported')`; const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); assert.equal(await new Promise((resolve) => child.on('close', resolve)), 0); assert.equal(output.trim(), 'imported');
  for (const readme of ['README.md', 'README.zh-CN.md']) { const text = await fs.readFile(new URL(`../../${readme}`, import.meta.url), 'utf8'); assert.match(text, /node scripts\/install\.js --platform/); assert.doesNotMatch(text, /npm ci --prefix scripts/); assert.match(text, /--replace-follow-builders/); }
});

test('CLI invalid usage exits 64', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../install.js', import.meta.url)), '--bad'], { stdio: ['ignore', 'ignore', 'pipe'] });
  assert.equal(await new Promise((resolve) => child.on('close', resolve)), 64);
});
