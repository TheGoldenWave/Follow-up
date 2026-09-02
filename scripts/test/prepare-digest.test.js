import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  loadPrompts,
  resolveInstalledPromptsDir,
} from '../prepare-digest.js';

async function createPromptFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-prompts-'));
  const userPromptsDir = join(root, 'user-prompts');
  const localPromptsDir = join(root, 'installed-prompts');
  await mkdir(userPromptsDir);
  await mkdir(localPromptsDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { userPromptsDir, localPromptsDir };
}

test('an explicit user prompt overrides the installed release prompt', async (t) => {
  const paths = await createPromptFixture(t);
  await writeFile(join(paths.userPromptsDir, 'digest-intro.md'), 'custom prompt');
  await writeFile(join(paths.localPromptsDir, 'digest-intro.md'), 'installed prompt');

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['digest-intro.md'],
  });

  assert.deepEqual(result, {
    prompts: { digest_intro: 'custom prompt' },
    errors: [],
  });
});

test('the installed release prompt is used when no user override exists', async (t) => {
  const paths = await createPromptFixture(t);
  await writeFile(join(paths.localPromptsDir, 'summarize-tweets.md'), 'tagged prompt');

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['summarize-tweets.md'],
  });

  assert.deepEqual(result, {
    prompts: { summarize_tweets: 'tagged prompt' },
    errors: [],
  });
});

test('the default installed prompt directory resolves from the module URL', () => {
  const moduleUrl = new URL('file:///C:/Program%20Files/Follow-up/scripts/prepare-digest.js');

  assert.equal(
    resolveInstalledPromptsDir(moduleUrl),
    fileURLToPath(new URL('../prompts/', moduleUrl)),
  );
});

test('prompt loading uses the default installed prompt directory', async (t) => {
  const { userPromptsDir } = await createPromptFixture(t);

  const result = await loadPrompts({
    userPromptsDir,
    promptFiles: ['digest-intro.md'],
  });

  assert.match(result.prompts.digest_intro, /digest/i);
  assert.deepEqual(result.errors, []);
});

test('prompt loading does not make a mutable-branch network request', async (t) => {
  const paths = await createPromptFixture(t);
  await writeFile(join(paths.localPromptsDir, 'translate.md'), 'local only');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.fail('prompt loading must not use the network');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['translate.md'],
  });

  assert.equal(result.prompts.translate, 'local only');
  assert.deepEqual(result.errors, []);
});

test('a missing user and installed prompt returns an actionable error', async (t) => {
  const paths = await createPromptFixture(t);

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['digest-intro.md'],
  });

  assert.deepEqual(result.prompts, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /~\/\.follow-builders\/prompts\/digest-intro\.md/);
  assert.match(result.errors[0], /prompts\/digest-intro\.md/);
  assert.match(result.errors[0], /custom prompt|reinstall/i);
  assert.doesNotMatch(result.errors[0], new RegExp(paths.userPromptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.errors[0], new RegExp(paths.localPromptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('an unreadable user override reports a sanitized error and falls back locally', async (t) => {
  const paths = await createPromptFixture(t);
  await mkdir(join(paths.userPromptsDir, 'digest-intro.md'));
  await writeFile(join(paths.localPromptsDir, 'digest-intro.md'), 'installed fallback');

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['digest-intro.md'],
  });

  assert.equal(result.prompts.digest_intro, 'installed fallback');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /~\/\.follow-builders\/prompts\/digest-intro\.md/);
  assert.match(result.errors[0], /installed prompt/i);
  assert.doesNotMatch(result.errors[0], new RegExp(paths.userPromptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a broken installed prompt is non-fatal and later prompts still load', async (t) => {
  const paths = await createPromptFixture(t);
  await mkdir(join(paths.localPromptsDir, 'digest-intro.md'));
  await writeFile(join(paths.localPromptsDir, 'translate.md'), 'translate prompt');

  const result = await loadPrompts({
    ...paths,
    promptFiles: ['digest-intro.md', 'translate.md'],
  });

  assert.deepEqual(result.prompts, { translate: 'translate prompt' });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /prompts\/digest-intro\.md/);
  assert.match(result.errors[0], /reinstall/i);
  assert.doesNotMatch(result.errors[0], new RegExp(paths.localPromptsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
