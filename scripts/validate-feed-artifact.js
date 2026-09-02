#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FEEDS = [
  ['feed-x.json', 'x'],
  ['feed-podcasts.json', 'podcasts'],
  ['feed-blogs.json', 'blogs'],
  ['feed-newsletters.json', 'newsletters'],
  ['feed-academic.json', 'papers'],
  ['feed-zh-tech.json', 'articles'],
];
const EXPECTED_FILES = [...FEEDS.map(([filename]) => filename), 'state-feed.json'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateFeedEnvelope(feed, filename, payloadKey) {
  const errors = [];
  if (!isObject(feed)) return [`${filename}: must contain a JSON object`];
  if (!/^1\.\d+$/.test(feed.schemaVersion ?? '')) {
    errors.push(`${filename}: schemaVersion must be compatible 1.x`);
  }
  if (typeof feed.generatedAt !== 'string' || Number.isNaN(Date.parse(feed.generatedAt))) {
    errors.push(`${filename}: generatedAt must be an ISO-compatible date`);
  }
  if (typeof feed.lookbackHours !== 'number' || feed.lookbackHours <= 0) {
    errors.push(`${filename}: lookbackHours must be positive`);
  }
  if (!isObject(feed.stats)) errors.push(`${filename}: stats must be an object`);
  if (!Array.isArray(feed[payloadKey])) {
    errors.push(`${filename}: ${payloadKey} must be an array`);
  }
  if (feed.errors !== undefined
      && (!Array.isArray(feed.errors) || !feed.errors.every((error) => typeof error === 'string'))) {
    errors.push(`${filename}: errors must be an array of strings`);
  }
  return errors;
}

export async function validateArtifactDirectory(directory) {
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

  for (const [filename, payloadKey] of FEEDS) {
    if (documents[filename]) {
      errors.push(...validateFeedEnvelope(documents[filename], filename, payloadKey));
    }
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
