import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseInstallArgs, runInstaller, runReleaseDoctor } from '../install.js';

const execFileAsync = promisify(execFile);

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

async function pristineRepositoryArchive() {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'follow-install-e2e-')));
  const root = join(base, 'archive'); const repository = fileURLToPath(new URL('../..', import.meta.url));
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: repository, encoding: 'buffer' });
  for (const path of stdout.toString('utf8').split('\0').filter(Boolean)) {
    const target = join(root, path); await fs.mkdir(join(target, '..'), { recursive: true }); await fs.copyFile(join(repository, path), target);
  }
  const manifestPath = join(root, 'release-manifest.json'); const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  for (const path of Object.keys(manifest.integrity.criticalFiles.files)) {
    manifest.integrity.criticalFiles.files[path] = createHash('sha256').update(await fs.readFile(join(root, path))).digest('hex');
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { base, root, home: join(base, 'home'), version: (await fs.readFile(join(root, 'VERSION'), 'utf8')).trim() };
}

test('release doctor resolves dependencies from the staged release, not the pristine source', async () => {
  const f = await fixture(); const staged = join(f.base, 'staged');
  await fs.mkdir(join(staged, 'scripts', 'node_modules', 'target-only'), { recursive: true });
  await fs.writeFile(join(staged, 'scripts', 'node_modules', 'target-only', 'package.json'), JSON.stringify({ name: 'target-only', version: '1.0.0', type: 'module', exports: './index.js' }));
  await fs.writeFile(join(staged, 'scripts', 'node_modules', 'target-only', 'index.js'), 'export default true;\n');
  await fs.writeFile(join(staged, 'scripts', 'doctor.js'), "import targetOnly from 'target-only'; export async function runDoctor(_args, options) { const report={exitCode:targetOnly && options.releaseRoot===process.env.EXPECTED_RELEASE ? 0 : 1}; options.stdout(JSON.stringify(report)); return report; }\n");
  const result = await runReleaseDoctor({ home: f.home, releaseRoot: staged, requireRegistration: false, allowIncomplete: true }, { env: { ...process.env, EXPECTED_RELEASE: staged } });
  assert.equal(result.exitCode, 0);
});

test('pristine archive completes real npm ci and target-local doctor on clean install and reinstall', { timeout: 120_000 }, async () => {
  const f = await pristineRepositoryArchive(); await assert.rejects(fs.lstat(join(f.root, 'scripts', 'node_modules')), { code: 'ENOENT' });
  const errors = []; const reports = []; const clean = await runInstaller(['--platform', 'codex'], { ...f, stdout: () => {}, stderr: (message) => errors.push(message), doctorImpl: async (options) => { const result = await runReleaseDoctor(options); reports.push(result.report); return result; } });
  assert.equal(clean.exitCode, 0, `${errors.join('; ')} ${JSON.stringify(reports)}`); assert.equal(clean.reused, false); assert.equal((await fs.lstat(clean.releaseRoot)).isSymbolicLink(), true);
  const objectRoot = await fs.realpath(clean.releaseRoot); assert.match(objectRoot, /\.0\.1\.0\.object-[A-Za-z0-9_-]+$/); assert.ok(await fs.lstat(join(objectRoot, 'scripts', 'node_modules', 'ajv')));
  const reinstall = await runInstaller(['--platform', 'codex'], { ...f, stdout: () => {}, stderr: () => {} });
  assert.equal(reinstall.exitCode, 0); assert.equal(reinstall.reused, true); assert.equal(reinstall.releaseRoot, clean.releaseRoot);
});

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
  assert.match(operations[0], /npm:.*\.object-/); assert.match(operations[1], /doctor:.*\.object-.*:false/); assert.match(operations[2], /register:.*releases\/0\.2\.0/); assert.match(operations[3], /doctor:.*\.object-.*custom:.*follow-up:true/);
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
  const f = await fixture(); const installed = await runInstaller(['--platform', 'codex'], injected(f)); assert.equal(installed.exitCode, 0); const objectRoot = await fs.realpath(f.releaseRoot); await fs.writeFile(join(objectRoot, 'SKILL.md'), 'immutable'); const calls = [];
  const result = await runInstaller(['--platform', 'codex'], injected({ ...f, validateReleaseImpl: async (root) => { calls.push(root); return []; }, npmCiImpl: async () => calls.push('npm') }));
  assert.equal(result.exitCode, 0); assert.equal(await fs.readFile(join(f.releaseRoot, 'SKILL.md'), 'utf8'), 'immutable'); assert.deepEqual(calls, [f.root, objectRoot]);
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

test('a competing installer never removes a lock it does not own', async () => {
  const f = await fixture(); const lock = join(f.home, '.follow-builders', '.install.lock');
  await fs.mkdir(lock, { recursive: true }); await fs.writeFile(join(lock, 'owner'), 'foreign-token\n');
  assert.equal((await runInstaller(['--platform', 'codex'], injected(f))).exitCode, 1);
  assert.equal(await fs.readFile(join(lock, 'owner'), 'utf8'), 'foreign-token\n');
});

test('concurrent installers keep the winner lock until its transaction finishes', async () => {
  const f = await fixture(); let releaseNpm;
  const gate = new Promise((resolve) => { releaseNpm = resolve; });
  const first = runInstaller(['--platform', 'codex'], injected({ ...f, npmCiImpl: async () => gate }));
  const lock = join(f.home, '.follow-builders', '.install.lock');
  while (!await fs.lstat(lock).catch(() => null)) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await runInstaller(['--platform', 'codex'], injected(f));
  assert.equal(second.exitCode, 1); assert.ok(await fs.lstat(lock));
  releaseNpm(); assert.equal((await first).exitCode, 0); await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
});

test('pointer publication refuses existing directory, file, or external symlink without mutation', async () => {
  for (const occupied of ['directory', 'file', 'symlink']) { const f = await fixture(); const victim = join(f.base, 'victim'); await fs.mkdir(victim); await fs.writeFile(join(victim, 'sentinel'), 'keep');
    const result = await runInstaller(['--platform', 'codex'], injected({ ...f, onPointerWorkerReady: async () => {
      if (occupied === 'directory') { await fs.mkdir(f.releaseRoot); await fs.writeFile(join(f.releaseRoot, 'foreign'), 'keep'); }
      else if (occupied === 'file') await fs.writeFile(f.releaseRoot, 'foreign');
      else await fs.symlink(victim, f.releaseRoot);
    } }));
    assert.equal(result.exitCode, 1, occupied);
    const before = occupied === 'directory' ? ['foreign'] : occupied === 'file' ? 'foreign' : victim;
    const after = occupied === 'directory' ? await fs.readdir(f.releaseRoot) : occupied === 'file' ? await fs.readFile(f.releaseRoot, 'utf8') : await fs.readlink(f.releaseRoot);
    assert.deepEqual(after, before); assert.deepEqual(await fs.readdir(victim), ['sentinel']);
  }
});

test('pointer publication detects replacement of the releases parent with a symlink', async () => {
  const f = await fixture(); const outside = join(f.base, 'outside'); const detached = join(f.base, 'detached-releases'); await fs.mkdir(outside);
  const result = await runInstaller(['--platform', 'codex'], injected({ ...f, onPointerWorkerReady: async ({ releasesDir }) => { await fs.rename(releasesDir, detached); await fs.symlink(outside, releasesDir); } }));
  assert.equal(result.exitCode, 1); assert.deepEqual(await fs.readdir(outside), []);
});

test('stable object cwd prevents pathname replacement from redirecting writes', { timeout: 120_000 }, async () => {
  const f = await pristineRepositoryArchive(); const victim = join(f.base, 'victim'); const detached = join(f.base, 'detached-object'); await fs.mkdir(victim); await fs.writeFile(join(victim, 'sentinel'), 'unchanged');
  const result = await runInstaller(['--platform', 'codex'], { ...f, stdout: () => {}, stderr: () => {}, onObjectWorkerReady: async ({ objectRoot }) => { await fs.rename(objectRoot, detached); await fs.symlink(victim, objectRoot); } });
  assert.equal(result.exitCode, 1); assert.deepEqual(await fs.readdir(victim), ['sentinel']); assert.equal(await fs.readFile(join(victim, 'sentinel'), 'utf8'), 'unchanged');
  assert.ok(await fs.lstat(join(detached, '.install-owner'))); assert.ok(await fs.lstat(join(detached, 'SKILL.md')));
});

test('incomplete object pointer is never reused', async () => {
  const f = await fixture(); const releases = join(f.releaseRoot, '..'); const object = join(releases, '.0.2.0.object-abandoned'); await fs.mkdir(object, { recursive: true }); await fs.writeFile(join(object, '.install-owner'), 'abandoned\n'); await fs.symlink('.0.2.0.object-abandoned', f.releaseRoot);
  const result = await runInstaller(['--platform', 'codex'], injected({ ...f, validateReleaseImpl: async () => [] }));
  assert.equal(result.exitCode, 1); assert.equal(await fs.readFile(join(object, '.install-owner'), 'utf8'), 'abandoned\n');
});

test('forged completion marker with mismatched owner token is rejected by reuse and doctor', async () => {
  const f = await fixture(); const installed = await runInstaller(['--platform', 'codex'], injected(f)); assert.equal(installed.exitCode, 0); const object = await fs.realpath(f.releaseRoot);
  const markerPath = join(object, '.install-complete.json'); const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); marker.transactionId = 'forged-token'; await fs.writeFile(markerPath, JSON.stringify(marker));
  assert.equal((await runInstaller(['--platform', 'codex'], injected(f))).exitCode, 1);
  await assert.rejects(runReleaseDoctor({ home: f.home, releaseRoot: object, requireRegistration: false }), /completion|owner/i);
});

test('v0.1 legacy upgrade requires replace and verifies new link before deletion for all adapters', async () => {
  for (const platform of ['codex', 'claude-code', 'custom']) { const f = await fixture(); const operations = []; const args = ['--platform', platform, '--register']; if (platform === 'custom') args.push('--skill-dir', join(f.base, 'agent', 'follow-up'));
    assert.equal((await runInstaller(args, injected({ ...f, registerSkillImpl: async () => { throw new Error('requires --replace-follow-builders'); } }))).exitCode, 1);
    const errors = []; const accepted = await runInstaller([...args, '--replace-follow-builders'], injected({ ...f, stderr: (message) => errors.push(message), registerSkillImpl: async ({ verify, replaceLegacy }) => { assert.equal(replaceLegacy, true); operations.push('link'); assert.equal(await verify(), true); operations.push('delete-legacy'); }, doctorImpl: async ({ platform: selected, requireRegistration }) => { if (requireRegistration) { assert.equal(selected, platform); operations.push('doctor'); } return { exitCode: 0 }; } }));
    assert.equal(accepted.exitCode, 0, errors.join('; ')); assert.deepEqual(operations, ['link', 'doctor', 'delete-legacy']);
  }
});

test('real registration adapters preserve v0.1 legacy links until target doctor succeeds', async () => {
  for (const platform of ['codex', 'claude-code', 'custom']) {
    const f = await fixture(); const skillDir = platform === 'custom' ? join(f.base, 'custom', 'follow-up') : undefined;
    const registrationPath = skillDir ?? join(f.home, platform === 'codex' ? '.codex' : '.claude', 'skills', 'follow-up');
    const legacyPath = join(registrationPath, '..', 'follow-builders'); const legacyTarget = join(f.base, 'v0.1');
    await fs.mkdir(legacyTarget, { recursive: true }); await fs.writeFile(join(legacyTarget, 'SKILL.md'), 'legacy');
    await fs.mkdir(join(registrationPath, '..'), { recursive: true }); await fs.symlink(legacyTarget, legacyPath, 'dir');
    const mutable = join(f.home, '.follow-builders', 'state', 'legacy.bin'); await fs.mkdir(join(mutable, '..'), { recursive: true }); await fs.writeFile(mutable, Buffer.from([7, 0, 1]));
    const args = ['--platform', platform, '--register', ...(skillDir ? ['--skill-dir', skillDir] : [])];
    assert.equal((await runInstaller(args, injected(f))).exitCode, 1); assert.equal(await fs.realpath(legacyPath), legacyTarget);
    const order = [];
    const accepted = await runInstaller([...args, '--replace-follow-builders'], injected({ ...f,
      doctorImpl: async ({ requireRegistration, releaseRoot }) => {
        if (requireRegistration) { order.push('doctor'); assert.equal(await fs.realpath(registrationPath), releaseRoot); assert.equal(await fs.realpath(legacyPath), legacyTarget); }
        return { exitCode: 0 };
      },
    }));
    assert.equal(accepted.exitCode, 0); assert.deepEqual(order, ['doctor']); await assert.rejects(fs.lstat(legacyPath), { code: 'ENOENT' });
    assert.equal(await fs.realpath(registrationPath), await fs.realpath(accepted.releaseRoot)); assert.deepEqual(await fs.readFile(mutable), Buffer.from([7, 0, 1]));
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

test('active metadata rollback failure is explicit and retains its published release', async () => {
  const f = await fixture(); const errors = []; const user = join(f.home, '.follow-builders'); await fs.mkdir(user, { recursive: true }); await fs.writeFile(join(user, 'active.json'), '{"generation":"old"}\n');
  const wrapped = new Proxy(fs, { get(target, key) { if (key !== 'writeFile') return target[key]; return async (path, contents, options) => { if (String(path).includes('.active.json.restore-')) throw new Error('restore denied'); return fs.writeFile(path, contents, options); }; } });
  const result = await runInstaller(['--platform', 'codex', '--register'], injected({ ...f, fsImpl: wrapped,
    registerSkillImpl: async () => { throw new Error('registration failed'); }, stderr: (message) => errors.push(message),
  }));
  assert.equal(result.exitCode, 1); assert.match(errors.join('\n'), /rollback.*uncertain|restore/i); assert.ok(await fs.lstat(f.releaseRoot));
  const active = JSON.parse(await fs.readFile(join(f.home, '.follow-builders', 'active.json'), 'utf8')); assert.equal(active.registration.platform, 'codex');
});

test('registration rollback failure retains completed pointer so a stuck Skill link is not dangling', async () => {
  const f = await fixture(); const registrationPath = join(f.home, '.codex', 'skills', 'follow-up'); const errors = [];
  const result = await runInstaller(['--platform', 'codex', '--register'], injected({ ...f, stderr: (message) => errors.push(message),
    registerSkillImpl: async ({ releaseRoot }) => { await fs.mkdir(join(registrationPath, '..'), { recursive: true }); await fs.symlink(releaseRoot, registrationPath); const error = new Error('registration rollback failed'); error.code = 'REGISTRATION_ROLLBACK_FAILED'; throw error; },
  }));
  assert.equal(result.exitCode, 1); assert.match(errors.join('\n'), /rollback.*uncertain/i); assert.ok(await fs.lstat(f.releaseRoot)); assert.equal(await fs.realpath(registrationPath), await fs.realpath(f.releaseRoot));
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
