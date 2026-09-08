import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
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
export const FEED_ARTIFACT_FILES = Object.freeze([
  'feed-x.json',
  'feed-podcasts.json',
  'feed-blogs.json',
  'feed-newsletters.json',
  'feed-academic.json',
  'feed-zh-tech.json',
  'feed-candidates.json',
  'state-feed.json',
]);
const ARTIFACT_FILE_SET = new Set(FEED_ARTIFACT_FILES);

const defaultFs = { lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile };

async function requireSafeRoot(rootDir, fsImpl) {
  const root = resolve(rootDir);
  const components = root.split(sep).filter(Boolean);
  let current = sep;
  for (const component of components) {
    current = join(current, component);
    const componentMetadata = await fsImpl.lstat(current);
    if (componentMetadata.isSymbolicLink()) {
      throw new Error(`Feed publication root contains a symbolic link: ${current}`);
    }
  }
  const metadata = await fsImpl.lstat(root);
  if (metadata.isSymbolicLink()) throw new Error('Feed publication root must not be a symbolic link');
  if (!metadata.isDirectory()) throw new Error('Feed publication root must be a directory');
  await fsImpl.realpath(root);
  return root;
}

async function requireSafeExistingComponents(root, path, fsImpl) {
  const relative = path.slice(root.length + 1).split(sep).filter(Boolean);
  let current = root;
  for (const component of relative) {
    current = join(current, component);
    try {
      const metadata = await fsImpl.lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Feed publication path contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function requireArtifactTarget(root, target) {
  const resolvedTarget = resolve(target);
  const filename = basename(resolvedTarget);
  if (!ARTIFACT_FILE_SET.has(filename) || resolvedTarget !== join(root, filename)) {
    throw new Error(`Publication target is not an approved feed artifact: ${target}`);
  }
  return resolvedTarget;
}

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
  await requireSafeExistingComponents(rootDir, journalPath, fsImpl);
  const temporaryPath = `${journalPath}.tmp-${journal.transactionId}`;
  await requireSafeExistingComponents(rootDir, temporaryPath, fsImpl);
  await writeDurable(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, fsImpl);
  await fsImpl.rename(temporaryPath, journalPath);
  await fsyncDirectory(rootDir, fsImpl);
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
  const root = await requireSafeRoot(rootDir, defaultFs);
  await requireSafeExistingComponents(root, join(root, FEED_PUBLICATION_LOCK), defaultFs);
  let release;
  try {
    release = await lockfile.lock(rootDir, {
      realpath: false,
      retries: options.retries ?? 0,
      stale: options.stale ?? 120_000,
      lockfilePath: join(root, FEED_PUBLICATION_LOCK),
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
  const root = await requireSafeRoot(rootDir, fsImpl);
  const stagingRoot = join(root, STAGING_DIRECTORY);
  await requireSafeExistingComponents(root, join(root, FEED_PUBLICATION_JOURNAL), fsImpl);
  await requireSafeExistingComponents(root, stagingRoot, fsImpl);
  const approvedTargets = [];
  const uniqueTargets = new Set();
  for (const [rawTarget] of documents) {
    const target = requireArtifactTarget(root, rawTarget);
    if (uniqueTargets.has(target)) throw new Error(`Duplicate publication target: ${target}`);
    uniqueTargets.add(target);
    await requireSafeExistingComponents(root, target, fsImpl);
    approvedTargets.push(target);
  }
  const transactionDir = join(stagingRoot, transactionId);
  const newDir = join(transactionDir, 'new');
  const backupDir = join(transactionDir, 'old');
  await fsImpl.mkdir(newDir, { recursive: true });
  await fsImpl.mkdir(backupDir, { recursive: true });
  await requireSafeExistingComponents(root, newDir, fsImpl);
  await requireSafeExistingComponents(root, backupDir, fsImpl);

  let journalWritten = false;
  try {
    const targets = [];
    const stagedPaths = new Map();
    for (const [index, [, value]] of documents.entries()) {
      const target = approvedTargets[index];
      const filename = `${String(index).padStart(2, '0')}-${basename(target)}`;
      const stagedPath = join(newDir, filename);
      const backupPath = join(backupDir, filename);
      await requireSafeExistingComponents(root, stagedPath, fsImpl);
      await requireSafeExistingComponents(root, backupPath, fsImpl);
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
    await writeJournal(root, journal, fsImpl);
    journalWritten = true;
    journal.phase = 'replacing';
    await writeJournal(root, journal, fsImpl);

    for (const target of targets) await fsImpl.rename(target.stagedPath, target.target);
    for (const target of targets) await fsyncFile(target.target, fsImpl);
    await fsyncDirectory(root, fsImpl);

    journal.phase = 'committed';
    await writeJournal(root, journal, fsImpl);
    await fsImpl.unlink(join(root, FEED_PUBLICATION_JOURNAL));
    await fsImpl.rm(transactionDir, { recursive: true, force: true });
    await fsyncDirectory(root, fsImpl);
  } catch (error) {
    if (!journalWritten) await fsImpl.rm(transactionDir, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverFeedPublication(rootDir, { fsImpl = defaultFs } = {}) {
  const root = await requireSafeRoot(rootDir, fsImpl);
  const journalPath = join(root, FEED_PUBLICATION_JOURNAL);
  await requireSafeExistingComponents(root, journalPath, fsImpl);
  await requireSafeExistingComponents(root, join(root, STAGING_DIRECTORY), fsImpl);
  let journal;
  try {
    journal = JSON.parse(await fsImpl.readFile(journalPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await fsImpl.rm(join(root, STAGING_DIRECTORY), { recursive: true, force: true });
      return false;
    }
    throw new Error(`Cannot recover feed publication journal: ${error.message}`, { cause: error });
  }
  if (journal?.version !== 1 || !/^[A-Za-z0-9._-]+$/.test(journal.transactionId ?? '')
    || !['prepared', 'replacing', 'committed'].includes(journal.phase)
    || !Array.isArray(journal.targets) || typeof journal.transactionDir !== 'string') {
    throw new Error('Cannot recover malformed feed publication journal');
  }
  const expectedTransactionDir = join(root, STAGING_DIRECTORY, journal.transactionId);
  const transactionDir = requireWithin(
    join(root, STAGING_DIRECTORY),
    journal.transactionDir,
    'Journal transaction directory',
  );
  if (transactionDir !== expectedTransactionDir) {
    throw new Error('Journal transaction directory does not match its transaction ID');
  }
  await requireSafeExistingComponents(root, transactionDir, fsImpl);

  const seenTargets = new Set();
  for (const [index, entry] of journal.targets.entries()) {
    const target = requireArtifactTarget(root, entry.target);
    if (seenTargets.has(target)) throw new Error(`Journal contains duplicate artifact target: ${target}`);
    seenTargets.add(target);
    const filename = `${String(index).padStart(2, '0')}-${basename(target)}`;
    if (resolve(entry.stagedPath) !== join(transactionDir, 'new', filename)
      || resolve(entry.backupPath) !== join(transactionDir, 'old', filename)) {
      throw new Error(`Journal paths do not match artifact target ${basename(target)}`);
    }
    await requireSafeExistingComponents(root, entry.stagedPath, fsImpl);
    await requireSafeExistingComponents(root, entry.backupPath, fsImpl);
  }

  if (journal.phase !== 'committed') {
    for (const [index, entry] of journal.targets.entries()) {
      const target = requireArtifactTarget(root, entry.target);
      if (entry.existed) {
        const backupPath = requireWithin(transactionDir, entry.backupPath, 'Journal backup path');
        const restorePath = join(dirname(target), `.${basename(target)}.restore-${journal.transactionId}-${index}`);
        await requireSafeExistingComponents(root, restorePath, fsImpl);
        await writeDurable(restorePath, await fsImpl.readFile(backupPath), fsImpl);
        await fsImpl.rename(restorePath, target);
        await fsyncFile(target, fsImpl);
      } else {
        await fsImpl.unlink(target).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    }
    await fsyncDirectory(root, fsImpl);
  }

  await fsImpl.unlink(journalPath);
  await fsImpl.rm(transactionDir, { recursive: true, force: true });
  await fsImpl.rm(join(root, STAGING_DIRECTORY), { recursive: true, force: true });
  await fsyncDirectory(root, fsImpl);
  return true;
}
