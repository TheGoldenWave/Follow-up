#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CANDIDATE_FEED_FILE,
  CENTRAL_FEED_FILES,
  validateFeedFiles,
} from './feed-contract.js';
import { loadSourceRegistry } from './source-registry.js';

const EXPECTED_FILES = [
  ...CENTRAL_FEED_FILES.map(({ filename }) => filename),
  CANDIDATE_FEED_FILE,
  'state-feed.json',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function validateArtifactDirectory(directory, { expectedRegistry } = {}) {
  const errors = [];
  const entries = (await readdir(directory)).sort();
  const expected = [...EXPECTED_FILES].sort();
  for (const filename of entries.filter((entry) => !expected.includes(entry))) {
    errors.push(`unexpected artifact file: ${filename}`);
  }
  for (const filename of expected.filter((entry) => !entries.includes(entry))) {
    errors.push(`missing artifact file: ${filename}`);
  }

  const documents = {};
  for (const filename of expected.filter((entry) => entries.includes(entry))) {
    const path = resolve(directory, filename);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      errors.push(`${filename}: symbolic links are forbidden`);
      continue;
    }
    if (!metadata.isFile()) {
      errors.push(`${filename}: must be a regular file`);
      continue;
    }
    try {
      documents[filename] = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      errors.push(`${filename}: invalid JSON: ${error.message}`);
    }
  }

  const feedFilesPresent = [...CENTRAL_FEED_FILES.map(({ filename }) => filename), CANDIDATE_FEED_FILE]
    .every((filename) => documents[filename]);
  if (feedFilesPresent) {
    errors.push(...await validateFeedFiles({
      readJson: async (filename) => documents[filename],
      expectedRegistry: expectedRegistry ?? await loadSourceRegistry(),
    }));
  }
  const state = documents['state-feed.json'];
  if (state && (!isObject(state)
      || !isObject(state.seenTweets)
      || !isObject(state.seenVideos)
      || !isObject(state.seenArticles))) {
    errors.push('state-feed.json: seenTweets, seenVideos, and seenArticles must be objects');
  }
  return errors;
}

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node validate-feed-artifact.js <directory>');
  const errors = await validateArtifactDirectory(directory);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log('Generated feed artifact is valid.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
