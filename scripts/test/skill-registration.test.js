import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  inspectSkillRegistration,
  registerSkill,
} from '../lib/skill-registration.js';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'follow-up-registration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const releaseRoot = join(root, 'release');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(releaseRoot, { recursive: true });
  await fs.writeFile(join(releaseRoot, 'SKILL.md'), '# Follow-up\n');
  return { root, home, releaseRoot };
}

test('registers Codex and Claude Code Skills at their injected platform paths', async (t) => {
  const { home, releaseRoot } = await fixture(t);

  const codex = await registerSkill({
    platform: 'codex', home, env: {}, releaseRoot, randomUUID: () => 'codex-temp',
  });
  const claude = await registerSkill({
    platform: 'claude-code', home, env: {}, releaseRoot, randomUUID: () => 'claude-temp',
  });

  assert.equal(codex.registrationPath, join(home, '.codex', 'skills', 'follow-up'));
  assert.equal(claude.registrationPath, join(home, '.claude', 'skills', 'follow-up'));
  assert.equal(await fs.realpath(codex.registrationPath), await fs.realpath(releaseRoot));
  assert.equal(await fs.realpath(claude.registrationPath), await fs.realpath(releaseRoot));
});

test('custom registration accepts only an absolute caller-selected path', async (t) => {
  const { root, releaseRoot } = await fixture(t);
  const skillDir = join(root, 'agent-skills', 'follow-up');
  const result = await registerSkill({
    platform: 'custom', skillDir, releaseRoot, randomUUID: () => 'custom-temp',
  });
  assert.equal(result.registrationPath, skillDir);
  await assert.rejects(
    registerSkill({ platform: 'custom', skillDir: 'relative/follow-up', releaseRoot }),
    /absolute/i,
  );
});

test('legacy registration is removed only after the new link passes verification', async (t) => {
  const { home, releaseRoot } = await fixture(t);
  const skillParent = join(home, '.codex', 'skills');
  const legacy = join(skillParent, 'follow-builders');
  await fs.mkdir(skillParent, { recursive: true });
  await fs.symlink(releaseRoot, legacy, 'dir');
  const operations = [];
  const fsImpl = {
    ...fs,
    async symlink(target, path, type) {
      operations.push(`symlink:${path}`);
      return fs.symlink(target, path, type);
    },
    async unlink(path) {
      if (path === legacy) operations.push(`unlink:${path}`);
      return fs.unlink(path);
    },
  };

  await assert.rejects(
    registerSkill({ platform: 'codex', home, env: {}, releaseRoot, fsImpl }),
    /replace-follow-builders/i,
  );
  await assert.rejects(
    registerSkill({
      platform: 'codex', home, env: {}, releaseRoot, replaceLegacy: true, fsImpl,
    }),
    /verification callback|required.*verif/i,
  );
  const result = await registerSkill({
    platform: 'codex', home, env: {}, releaseRoot, replaceLegacy: true, fsImpl,
    randomUUID: () => 'ordered-temp',
    verify: async ({ registrationPath }) => {
      operations.push(`verify:${registrationPath}`);
      assert.equal(await fs.realpath(registrationPath), await fs.realpath(releaseRoot));
      return true;
    },
  });

  assert.equal(result.replacedLegacy, true);
  assert.deepEqual(operations.map((entry) => entry.split(':')[0]), ['symlink', 'verify', 'unlink']);
  await assert.rejects(fs.lstat(legacy), { code: 'ENOENT' });
});

test('verification or legacy cleanup failure rolls back the new registration and preserves legacy', async (t) => {
  const { home, releaseRoot } = await fixture(t);
  const parent = join(home, '.codex', 'skills');
  const registrationPath = join(parent, 'follow-up');
  const legacyPath = join(parent, 'follow-builders');
  await fs.mkdir(parent, { recursive: true });
  await fs.symlink(releaseRoot, legacyPath, 'dir');

  await assert.rejects(registerSkill({
    platform: 'codex', home, env: {}, releaseRoot, replaceLegacy: true,
    randomUUID: () => 'verify-failure', verify: async () => false,
  }), /verification/i);
  await assert.rejects(fs.lstat(registrationPath), { code: 'ENOENT' });
  assert.equal((await fs.lstat(legacyPath)).isSymbolicLink(), true);

  const fsImpl = {
    ...fs,
    async unlink(path) {
      if (path === legacyPath) throw new Error('simulated cleanup failure');
      return fs.unlink(path);
    },
  };
  await assert.rejects(registerSkill({
    platform: 'codex', home, env: {}, releaseRoot, replaceLegacy: true, fsImpl,
    randomUUID: () => 'cleanup-failure', verify: async () => true,
  }), /cleanup failure/i);
  await assert.rejects(fs.lstat(registrationPath), { code: 'ENOENT' });
  assert.equal((await fs.lstat(legacyPath)).isSymbolicLink(), true);
});

test('rollback failure is explicit instead of returning with unknown registration state', async (t) => {
  const { home, releaseRoot } = await fixture(t);
  const registrationPath = join(home, '.codex', 'skills', 'follow-up');
  const fsImpl = {
    ...fs,
    async unlink(path) {
      if (path === registrationPath) throw new Error('simulated rollback failure');
      return fs.unlink(path);
    },
  };
  await assert.rejects(registerSkill({
    platform: 'codex', home, env: {}, releaseRoot, fsImpl,
    randomUUID: () => 'rollback-failure', verify: async () => false,
  }), (error) => {
    assert.equal(error.code, 'REGISTRATION_ROLLBACK_FAILED');
    assert.match(error.message, /rollback/i);
    return true;
  });
});

test('concurrent destination creation is never deleted or overwritten', async (t) => {
  const { home, releaseRoot } = await fixture(t);
  const parent = join(home, '.codex', 'skills');
  await fs.mkdir(parent, { recursive: true });
  const destination = join(parent, 'follow-up');
  const fsImpl = {
    ...fs,
    async symlink(target, path, type) {
      await fs.writeFile(path, 'concurrent owner', { flag: 'wx' });
      return fs.symlink(target, path, type);
    },
  };
  await assert.rejects(registerSkill({
    platform: 'codex', home, env: {}, releaseRoot, fsImpl,
    randomUUID: () => 'race',
  }), /exist/i);
  assert.equal(await fs.readFile(destination, 'utf8'), 'concurrent owner');
});

test('rollback and legacy cleanup never remove a concurrently replaced path', async (t) => {
  const { home, releaseRoot } = await fixture(t);
  const parent = join(home, '.codex', 'skills');
  const registrationPath = join(parent, 'follow-up');
  const legacyPath = join(parent, 'follow-builders');
  await fs.mkdir(parent, { recursive: true });

  await assert.rejects(registerSkill({
    platform: 'codex', home, env: {}, releaseRoot,
    verify: async () => {
      await fs.unlink(registrationPath);
      await fs.writeFile(registrationPath, 'concurrent registration');
      return false;
    },
  }), (error) => error.code === 'REGISTRATION_ROLLBACK_FAILED');
  assert.equal(await fs.readFile(registrationPath, 'utf8'), 'concurrent registration');
  await fs.unlink(registrationPath);

  await fs.symlink(releaseRoot, legacyPath, 'dir');
  await assert.rejects(registerSkill({
    platform: 'codex', home, env: {}, releaseRoot, replaceLegacy: true,
    verify: async () => {
      await fs.unlink(legacyPath);
      await fs.writeFile(legacyPath, 'concurrent legacy owner');
      return true;
    },
  }), /changed concurrently/i);
  assert.equal(await fs.readFile(legacyPath, 'utf8'), 'concurrent legacy owner');
  await assert.rejects(fs.lstat(registrationPath), { code: 'ENOENT' });
});

test('registration inspection distinguishes correct, missing, and unsafe registrations', async (t) => {
  const { root, releaseRoot } = await fixture(t);
  const registrationPath = join(root, 'skills', 'follow-up');
  assert.equal((await inspectSkillRegistration({
    platform: 'custom', skillDir: registrationPath, releaseRoot,
  })).status, 'missing');
  await fs.mkdir(join(root, 'skills'), { recursive: true });
  await fs.symlink(releaseRoot, registrationPath, 'dir');
  assert.equal((await inspectSkillRegistration({
    platform: 'custom', skillDir: registrationPath, releaseRoot,
  })).status, 'registered');
  await fs.unlink(registrationPath);
  await fs.writeFile(registrationPath, 'not a link');
  assert.equal((await inspectSkillRegistration({
    platform: 'custom', skillDir: registrationPath, releaseRoot,
  })).status, 'invalid');
});

test('registration accepts only an exact internal one-hop immutable release pointer', async (t) => {
  const { root } = await fixture(t); const releases = join(root, 'releases'); await fs.mkdir(releases);
  const object = join(releases, '.0.2.0.object-AbCd1234'); await fs.mkdir(object); await fs.writeFile(join(object, 'SKILL.md'), '# skill');
  const pointer = join(releases, '0.2.0'); await fs.symlink('.0.2.0.object-AbCd1234', pointer, 'dir');
  const skillDir = join(root, 'skills', 'follow-up');
  assert.equal((await registerSkill({ platform: 'custom', skillDir, releaseRoot: pointer })).status, 'registered');
  await fs.unlink(skillDir);
  const outside = join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(join(outside, 'SKILL.md'), '# outside'); await fs.unlink(pointer); await fs.symlink(outside, pointer, 'dir');
  await assert.rejects(registerSkill({ platform: 'custom', skillDir, releaseRoot: pointer }), /unsafe|internal|pointer/i);
  await fs.unlink(pointer); const hop = join(releases, '.0.2.0.object-Hop12345'); await fs.symlink(object, hop, 'dir'); await fs.symlink('.0.2.0.object-Hop12345', pointer, 'dir');
  await assert.rejects(registerSkill({ platform: 'custom', skillDir, releaseRoot: pointer }), /unsafe|one-hop|pointer/i);
});
