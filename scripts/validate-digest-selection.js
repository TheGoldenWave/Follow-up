#!/usr/bin/env node

import { randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import { validateSelectionAgainstRequest } from './digest-selection.js';

export const INPUT_BYTE_LIMITS = Object.freeze({
  requestBytes: 16 * 1024 * 1024,
  selectionBytes: 8 * 1024 * 1024,
  exclusionBytes: 4 * 1024 * 1024,
});

class SafeIoError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SafeIoError';
  }
}

function parseOptions(argv) {
  return parseCommandLine(argv, {
    options: {
      request: { type: 'string' },
      selection: { type: 'string' },
      output: { type: 'string' },
      'excluded-candidate-ids': { type: 'string' },
    },
    validate({ values, positionals }) {
      if (positionals.length > 0) throw new CommandLineUsageError('unexpected positional arguments');
      for (const name of ['request', 'selection', 'output']) {
        if (!values[name]) throw new CommandLineUsageError(`--${name} is required`);
      }
    },
  }).values;
}

async function readJson(path, label, maxBytes, fsImpl) {
  try {
    const metadata = await fsImpl.stat(path);
    if (!metadata.isFile()) throw new SafeIoError(`${label}: input is not a regular file`);
    if (metadata.size > maxBytes) throw new SafeIoError(`${label}: input exceeds byte limit`);
    return JSON.parse(await fsImpl.readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SafeIoError) throw error;
    if (error instanceof SyntaxError) throw new Error(`${label}: invalid JSON`);
    throw new SafeIoError(`${label}: could not be read`, { cause: error });
  }
}

async function rejectSymlink(path, fsImpl, { allowMissing }) {
  try {
    const metadata = await fsImpl.lstat(path);
    if (metadata.isSymbolicLink()) throw new SafeIoError('output: unsafe symbolic link');
  } catch (error) {
    if (error instanceof SafeIoError) throw error;
    if (allowMissing && error?.code === 'ENOENT') return;
    throw error;
  }
}

async function closeQuietly(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Preserve the primary write error.
  }
}

async function writeAtomic(path, document, { fsImpl, randomUUID }) {
  const requestedTarget = resolve(path);
  const parent = dirname(requestedTarget);
  const token = randomUUID();
  if (typeof token !== 'string' || !/^[a-z0-9-]+$/i.test(token)) {
    throw new SafeIoError('output: could not be written');
  }
  let temporary;
  let temporaryHandle;
  let temporaryOwned = false;
  let parentHandle;
  try {
    await rejectSymlink(parent, fsImpl, { allowMissing: true });
    await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
    await rejectSymlink(parent, fsImpl, { allowMissing: false });
    const canonicalParent = await fsImpl.realpath(parent);
    const target = join(canonicalParent, basename(requestedTarget));
    temporary = `${target}.tmp-${token}`;
    await rejectSymlink(target, fsImpl, { allowMissing: true });

    temporaryHandle = await fsImpl.open(temporary, 'wx', 0o600);
    temporaryOwned = true;
    await temporaryHandle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await rejectSymlink(parent, fsImpl, { allowMissing: false });
    await rejectSymlink(target, fsImpl, { allowMissing: true });
    await fsImpl.rename(temporary, target);
    parentHandle = await fsImpl.open(parent, 'r');
    await parentHandle.sync();
    await parentHandle.close();
    parentHandle = undefined;
  } catch (error) {
    await closeQuietly(temporaryHandle);
    await closeQuietly(parentHandle);
    try {
      if (temporaryOwned) await fsImpl.rm(temporary, { force: true });
    } catch {
      // Cleanup failure must not reveal the temporary path.
    }
    if (error instanceof SafeIoError) throw error;
    throw new SafeIoError('output: could not be written', { cause: error });
  }
}

export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  fsImpl = systemFs,
  randomUUID = systemRandomUUID,
  limits = INPUT_BYTE_LIMITS,
} = {}) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return error.exitCode ?? EX_USAGE;
  }

  try {
    const effectiveLimits = { ...INPUT_BYTE_LIMITS, ...limits };
    const request = await readJson(options.request, 'request', effectiveLimits.requestBytes, fsImpl);
    const selection = await readJson(
      options.selection, 'selection', effectiveLimits.selectionBytes, fsImpl,
    );
    let excludedCandidateIds = [];
    if (options['excluded-candidate-ids']) {
      const exclusionDocument = await readJson(
        options['excluded-candidate-ids'], 'excluded candidate IDs',
        effectiveLimits.exclusionBytes, fsImpl,
      );
      excludedCandidateIds = Array.isArray(exclusionDocument)
        ? exclusionDocument : exclusionDocument?.excludedCandidateIds;
      if (!Array.isArray(excludedCandidateIds)
          || excludedCandidateIds.some((candidateId) => typeof candidateId !== 'string')) {
        throw new Error('excluded candidate IDs: expected a string array');
      }
    }
    const result = validateSelectionAgainstRequest(request, selection, { excludedCandidateIds });
    if (!result.valid) {
      for (const error of result.errors) stderr.write(`validation: ${error}\n`);
      return 1;
    }
    await writeAtomic(options.output, selection, { fsImpl, randomUUID });
    stdout.write('Digest selection validated.\n');
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
