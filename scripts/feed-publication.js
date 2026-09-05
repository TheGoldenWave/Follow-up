import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import lockfile from 'proper-lockfile';

export const FEED_PUBLICATION_JOURNAL = '.feed-publication-journal.json';
export const FEED_PUBLICATION_LOCK = '.feed-publication.lock';
const STAGING_DIRECTORY = '.feed-publication-staging';

const defaultFs = { mkdir, open, readFile, rename, rm, unlink, writeFile };

async function fsyncFile(path, fsImpl) {
  const handle = await fsImpl.open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path, fsImpl) {
  const handle = await fsImpl.open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurable(path, content, fsImpl) {
  await fsImpl.writeFile(path, content);
  await fsyncFile(path, fsImpl);
}

async function writeJournal(rootDir, journal, fsImpl) {
  const journalPath = join(rootDir, FEED_PUBLICATION_JOURNAL);
  const temporaryPath = `${journalPath}.tmp-${journal.transactionId}`;
  await writeDurable(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, fsImpl);
  await fsImpl.rename(temporaryPath, journalPath);
  await fsyncDirectory(rootDir, fsImpl);
}

function requireLocalTarget(rootDir, target) {
  const root = resolve(rootDir);
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(`${root}${sep}`)) {
    throw new Error(`Publication target is outside the feed root: ${target}`);
  }
  return resolvedTarget;
}

function requireWithin(parent, child, label) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (!resolvedChild.startsWith(`${resolvedParent}${sep}`)) {
    throw new Error(`${label} is outside its transaction directory`);
  }
  return resolvedChild;
}

export async function withFeedPublicationLock(rootDir, operation, options = {}) {
  await defaultFs.mkdir(rootDir, { recursive: true });
  let release;
  try {
    release = await lockfile.lock(rootDir, {
      realpath: false,
      retries: options.retries ?? 0,
      stale: options.stale ?? 120_000,
      lockfilePath: join(rootDir, FEED_PUBLICATION_LOCK),
    });
  } catch (error) {
    if (error?.code === 'ELOCKED') {
      throw new Error('Feed publication is locked by another process', { cause: error });
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function publishFeedTransaction({
  rootDir,
  documents,
  validateStaged,
  fsImpl = defaultFs,
  transactionId = `${Date.now()}-${process.pid}`,
}) {
  if (!/^[A-Za-z0-9._-]+$/.test(transactionId)) {
    throw new Error('Invalid feed publication transaction ID');
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('Feed publication requires at least one document');
  }
  const transactionDir = join(rootDir, STAGING_DIRECTORY, transactionId);
  const newDir = join(transactionDir, 'new');
  const backupDir = join(transactionDir, 'old');
  await fsImpl.mkdir(newDir, { recursive: true });
  await fsImpl.mkdir(backupDir, { recursive: true });

  let journalWritten = false;
  try {
    const targets = [];
    const uniqueTargets = new Set();
    const stagedPaths = new Map();
    for (const [index, [rawTarget, value]] of documents.entries()) {
      const target = requireLocalTarget(rootDir, rawTarget);
      if (uniqueTargets.has(target)) throw new Error(`Duplicate publication target: ${target}`);
      uniqueTargets.add(target);
      const filename = `${String(index).padStart(2, '0')}-${basename(target)}`;
      const stagedPath = join(newDir, filename);
      const backupPath = join(backupDir, filename);
      const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
      await writeDurable(stagedPath, content, fsImpl);
      let existed = true;
      try {
        await writeDurable(backupPath, await fsImpl.readFile(target), fsImpl);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        existed = false;
      }
      stagedPaths.set(target, stagedPath);
      targets.push({ target, stagedPath, backupPath, existed });
    }

    await fsyncDirectory(newDir, fsImpl);
    await fsyncDirectory(backupDir, fsImpl);
    await fsyncDirectory(transactionDir, fsImpl);
    await validateStaged?.({ stagedPaths, targets });

    const journal = {
      version: 1,
      transactionId,
      phase: 'prepared',
      transactionDir,
      targets,
    };
    await writeJournal(rootDir, journal, fsImpl);
    journalWritten = true;
    journal.phase = 'replacing';
    await writeJournal(rootDir, journal, fsImpl);

    for (const target of targets) await fsImpl.rename(target.stagedPath, target.target);
    for (const target of targets) await fsyncFile(target.target, fsImpl);
    await fsyncDirectory(rootDir, fsImpl);

    journal.phase = 'committed';
    await writeJournal(rootDir, journal, fsImpl);
    await fsImpl.unlink(join(rootDir, FEED_PUBLICATION_JOURNAL));
    await fsImpl.rm(transactionDir, { recursive: true, force: true });
    await fsyncDirectory(rootDir, fsImpl);
  } catch (error) {
    if (!journalWritten) await fsImpl.rm(transactionDir, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverFeedPublication(rootDir, { fsImpl = defaultFs } = {}) {
  const journalPath = join(rootDir, FEED_PUBLICATION_JOURNAL);
  let journal;
  try {
    journal = JSON.parse(await fsImpl.readFile(journalPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await fsImpl.rm(join(rootDir, STAGING_DIRECTORY), { recursive: true, force: true });
      return false;
    }
    throw new Error(`Cannot recover feed publication journal: ${error.message}`, { cause: error });
  }
  if (journal?.version !== 1 || !/^[A-Za-z0-9._-]+$/.test(journal.transactionId ?? '')
    || !['prepared', 'replacing', 'committed'].includes(journal.phase)
    || !Array.isArray(journal.targets) || typeof journal.transactionDir !== 'string') {
    throw new Error('Cannot recover malformed feed publication journal');
  }
  const transactionDir = requireWithin(
    join(rootDir, STAGING_DIRECTORY),
    journal.transactionDir,
    'Journal transaction directory',
  );

  if (journal.phase !== 'committed') {
    for (const [index, entry] of journal.targets.entries()) {
      const target = requireLocalTarget(rootDir, entry.target);
      if (entry.existed) {
        const backupPath = requireWithin(transactionDir, entry.backupPath, 'Journal backup path');
        const restorePath = join(dirname(target), `.${basename(target)}.restore-${journal.transactionId}-${index}`);
        await writeDurable(restorePath, await fsImpl.readFile(backupPath), fsImpl);
        await fsImpl.rename(restorePath, target);
        await fsyncFile(target, fsImpl);
      } else {
        await fsImpl.unlink(target).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    }
    await fsyncDirectory(rootDir, fsImpl);
  }

  await fsImpl.unlink(journalPath);
  await fsImpl.rm(transactionDir, { recursive: true, force: true });
  await fsImpl.rm(join(rootDir, STAGING_DIRECTORY), { recursive: true, force: true });
  await fsyncDirectory(rootDir, fsImpl);
  return true;
}
