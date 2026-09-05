import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FEED_PUBLICATION_JOURNAL,
  publishFeedTransaction,
  recoverFeedPublication,
  withFeedPublicationLock,
} from '../feed-publication.js';

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function contents(root, names) {
  return Promise.all(names.map((name) => readFile(join(root, name), 'utf8')));
}

test('a new process recovers the complete old generation from a prepared journal', async (t) => {
  const root = await temporaryRoot(t);
  const names = ['feed-a.json', 'feed-b.json'];
  await Promise.all(names.map((name) => writeFile(join(root, name), `old-${name}`)));
  const fs = await import('node:fs/promises');
  let replacements = 0;
  const crashingFs = {
    ...fs,
    async rename(from, to) {
      if (names.some((name) => to === join(root, name))) {
        replacements += 1;
        if (replacements === 2) throw new Error('simulated process failure');
      }
      return fs.rename(from, to);
    },
  };

  await assert.rejects(publishFeedTransaction({
    rootDir: root,
    documents: names.map((name) => [join(root, name), `new-${name}`]),
    fsImpl: crashingFs,
    validateStaged: async () => {},
  }), /simulated process failure/);
  assert.deepEqual(await contents(root, names), ['new-feed-a.json', 'old-feed-b.json']);

  await withFeedPublicationLock(root, async () => recoverFeedPublication(root));
  assert.deepEqual(await contents(root, names), ['old-feed-a.json', 'old-feed-b.json']);
  await assert.rejects(access(join(root, FEED_PUBLICATION_JOURNAL)));
});

test('a failed rollback leaves its journal and the next recovery finishes idempotently', async (t) => {
  const root = await temporaryRoot(t);
  const names = ['feed-a.json', 'feed-b.json'];
  await Promise.all(names.map((name) => writeFile(join(root, name), `old-${name}`)));
  const fs = await import('node:fs/promises');
  let replacements = 0;
  const crashingFs = {
    ...fs,
    async rename(from, to) {
      if (names.some((name) => to === join(root, name)) && ++replacements === 2) {
        throw new Error('publish interrupted');
      }
      return fs.rename(from, to);
    },
  };
  await assert.rejects(publishFeedTransaction({
    rootDir: root,
    documents: names.map((name) => [join(root, name), `new-${name}`]),
    fsImpl: crashingFs,
    validateStaged: async () => {},
  }));

  let restoreAttempts = 0;
  const failingRecoveryFs = {
    ...fs,
    async rename(from, to) {
      if (names.some((name) => to === join(root, name)) && ++restoreAttempts === 2) {
        throw new Error('rollback storage failure');
      }
      return fs.rename(from, to);
    },
  };
  await assert.rejects(recoverFeedPublication(root, { fsImpl: failingRecoveryFs }), /rollback storage failure/);
  await access(join(root, FEED_PUBLICATION_JOURNAL));

  await recoverFeedPublication(root);
  assert.deepEqual(await contents(root, names), ['old-feed-a.json', 'old-feed-b.json']);
  await assert.rejects(access(join(root, FEED_PUBLICATION_JOURNAL)));
});

test('a concurrent publisher cannot enter while the cross-process lock is held', async (t) => {
  const root = await temporaryRoot(t);
  await withFeedPublicationLock(root, async () => {
    await assert.rejects(
      withFeedPublicationLock(root, async () => {}),
      /publication.*locked|already being held/i,
    );
  });
});

test('staging validation runs after every document is durable and before replacement', async (t) => {
  const root = await temporaryRoot(t);
  const target = join(root, 'feed-a.json');
  await writeFile(target, 'old');
  let validated = false;
  await publishFeedTransaction({
    rootDir: root,
    documents: [[target, 'new']],
    validateStaged: async ({ stagedPaths }) => {
      assert.equal(await readFile(stagedPaths.get(target), 'utf8'), 'new');
      assert.equal(await readFile(target, 'utf8'), 'old');
      validated = true;
    },
  });
  assert.equal(validated, true);
  assert.equal(await readFile(target, 'utf8'), 'new');
});

test('staging validation failure leaves the old target and removes the unjournaled transaction', async (t) => {
  const root = await temporaryRoot(t);
  const target = join(root, 'feed-a.json');
  await writeFile(target, 'old');
  await assert.rejects(publishFeedTransaction({
    rootDir: root,
    documents: [[target, 'invalid-new']],
    transactionId: 'validation-failure',
    validateStaged: async () => { throw new Error('invalid staged feed'); },
  }), /invalid staged feed/);
  assert.equal(await readFile(target, 'utf8'), 'old');
  await assert.rejects(access(join(root, FEED_PUBLICATION_JOURNAL)));
  await assert.rejects(access(join(root, '.feed-publication-staging', 'validation-failure')));
});

test('recovery keeps the new generation when cleanup failed after the committed journal', async (t) => {
  const root = await temporaryRoot(t);
  const target = join(root, 'feed-a.json');
  await writeFile(target, 'old');
  const fs = await import('node:fs/promises');
  let cleanupFailed = false;
  const cleanupFailureFs = {
    ...fs,
    async unlink(path) {
      if (!cleanupFailed && path === join(root, FEED_PUBLICATION_JOURNAL)) {
        cleanupFailed = true;
        throw new Error('cleanup interrupted');
      }
      return fs.unlink(path);
    },
  };
  await assert.rejects(publishFeedTransaction({
    rootDir: root,
    documents: [[target, 'new']],
    fsImpl: cleanupFailureFs,
    validateStaged: async () => {},
  }), /cleanup interrupted/);
  assert.equal(await readFile(target, 'utf8'), 'new');

  await recoverFeedPublication(root);
  assert.equal(await readFile(target, 'utf8'), 'new');
  await assert.rejects(access(join(root, FEED_PUBLICATION_JOURNAL)));
});

test('recovery removes orphan staging left before the first journal was durable', async (t) => {
  const root = await temporaryRoot(t);
  const orphan = join(root, '.feed-publication-staging', 'orphan', 'new');
  const fs = await import('node:fs/promises');
  await fs.mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, 'feed-a.json'), 'staged');

  assert.equal(await recoverFeedPublication(root), false);
  await assert.rejects(access(join(root, '.feed-publication-staging')));
});
