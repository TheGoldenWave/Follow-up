import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveRuntimePaths,
  resolveSkillRegistrationPath,
} from '../lib/paths.js';

test('runtime paths can inject home and release root', () => {
  assert.deepEqual(resolveRuntimePaths({
    home: '/tmp/home',
    releaseRoot: '/tmp/release',
  }), {
    homeDir: '/tmp/home',
    userDir: '/tmp/home/.follow-builders',
    stateDir: '/tmp/home/.follow-builders/state',
    releasesDir: '/tmp/home/.follow-builders/releases',
    releaseRoot: '/tmp/release',
  });
});

test('runtime paths can inject HOME through the environment', () => {
  assert.equal(
    resolveRuntimePaths({ env: { HOME: '/tmp/env-home' } }).userDir,
    '/tmp/env-home/.follow-builders',
  );
});

test('Codex and Claude Code registration paths honor injected environment roots', () => {
  const options = {
    home: '/tmp/home',
    env: {
      CODEX_HOME: '/tmp/codex',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
    },
  };

  assert.equal(
    resolveSkillRegistrationPath('codex', options),
    '/tmp/codex/skills/follow-up',
  );
  assert.equal(
    resolveSkillRegistrationPath('claude-code', options),
    '/tmp/claude/skills/follow-up',
  );
});

test('built-in registration paths fall back to the injected home', () => {
  assert.equal(
    resolveSkillRegistrationPath('codex', { home: '/tmp/home', env: {} }),
    '/tmp/home/.codex/skills/follow-up',
  );
  assert.equal(
    resolveSkillRegistrationPath('claude-code', { home: '/tmp/home', env: {} }),
    '/tmp/home/.claude/skills/follow-up',
  );
});

test('custom registration requires an absolute path', () => {
  assert.equal(
    resolveSkillRegistrationPath('custom', { skillDir: '/opt/skills/follow-up' }),
    '/opt/skills/follow-up',
  );
  assert.throws(
    () => resolveSkillRegistrationPath('custom', { skillDir: 'relative/path' }),
    /absolute/i,
  );
});
