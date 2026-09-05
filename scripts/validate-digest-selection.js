#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import { validateSelectionAgainstRequest } from './digest-selection.js';

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

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label}: invalid JSON`);
    throw new Error(`${label}: could not be read`);
  }
}

async function writeAtomic(path, document) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return error.exitCode ?? EX_USAGE;
  }

  try {
    const request = await readJson(options.request, 'request');
    const selection = await readJson(options.selection, 'selection');
    let excludedCandidateIds = [];
    if (options['excluded-candidate-ids']) {
      const exclusionDocument = await readJson(options['excluded-candidate-ids'], 'excluded candidate IDs');
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
    await writeAtomic(options.output, selection);
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
