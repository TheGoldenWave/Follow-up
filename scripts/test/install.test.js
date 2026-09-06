import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseInstallArgs, runInstaller } from '../install.js';

test('installer CLI requires a supported platform and absolute custom path', () => {
  assert.deepEqual(parseInstallArgs(['--platform', 'codex']), {
    platform: 'codex', skillDir: undefined, register: false, replaceFollowBuilders: false,
  });
  assert.throws(() => parseInstallArgs([]), /platform|usage/i);
  assert.throws(() => parseInstallArgs(['--platform', 'unknown']), /platform|usage/i);
  assert.throws(() => parseInstallArgs(['--platform', 'custom', '--skill-dir', 'relative']), /absolute/i);
  assert.throws(() => parseInstallArgs(['--platform', 'codex', '--register', '--register']), /duplicate/i);
});

test('preflight failure performs no copy, npm lifecycle, or registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'follow-install-'));
  const operations = [];
  await writeFile(join(root, 'VERSION'), '0.2.0\n');
  await writeFile(join(root, 'release-manifest.json'), JSON.stringify({ productVersion: '0.1.0' }));
  const result = await runInstaller(['--platform', 'codex', '--register'], {
    root,
    validateArchiveCriticalFilesImpl: async () => ['critical hash mismatch'],
    fsImpl: {
      readFile: async (...args) => (await import('node:fs/promises')).readFile(...args),
      stat: async (...args) => (await import('node:fs/promises')).stat(...args),
    },
    copyReleaseImpl: async () => operations.push('copy'),
    npmCiImpl: async () => operations.push('npm'),
    registerSkillImpl: async () => operations.push('register'),
    stderr: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(operations, []);
});

test('local doctor failure prevents registration activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'follow-install-'));
  await writeFile(join(root, 'VERSION'), '0.2.0\n');
  await writeFile(join(root, 'release-manifest.json'), JSON.stringify({ productVersion: '0.2.0' }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await writeFile(join(root, 'scripts', 'package-lock.json'), JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.2.0' } } }));
  const operations = [];
  const result = await runInstaller(['--platform', 'codex', '--register'], {
    root,
    validateArchiveCriticalFilesImpl: async () => [],
    copyReleaseImpl: async () => operations.push('copy'),
    npmCiImpl: async () => operations.push('npm'),
    registerSkillImpl: async ({ verify }) => { operations.push('register'); assert.equal(await verify(), false); throw new Error('doctor failed'); },
    doctorImpl: async () => ({ exitCode: 1 }),
    stderr: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(operations, ['copy', 'npm', 'register']);
});
