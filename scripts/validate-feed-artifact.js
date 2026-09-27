#!/usr/bin/env node

import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The central feed publish job runs this gate with `contents: write` and, by
// design, never installs dependencies or runs the test suite. Everything here
// therefore stays on the standard library.
//
// Schema and registry validation happens in the generate job, which has the
// locked dependencies: `npm run validate-feeds` accepts the six central feeds
// and the candidate Feed, and only then are the artifact checksums written.
// This gate binds the downloaded artifact to that accepted content and
// re-checks the artifact shape, so a swapped, truncated or extra file cannot
// reach the published feeds.

export const ARTIFACT_FILES = [
  'feed-academic.json',
  'feed-blogs.json',
  'feed-candidates.json',
  'feed-newsletters.json',
  'feed-podcasts.json',
  'feed-x.json',
  'feed-zh-tech.json',
  'state-feed.json',
];

export const CHECKSUM_FILE = 'feed-artifact-checksums.txt';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function writeArtifactChecksums(directory, outputPath = join(directory, CHECKSUM_FILE)) {
  const lines = [];
  for (const filename of [...ARTIFACT_FILES].sort()) {
    const path = resolve(directory, filename);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${filename}: checksums cover regular files only`);
    }
    lines.push(`${await sha256File(path)}  ${filename}`);
  }
  await writeFile(outputPath, `${lines.join('\n')}\n`);
  return lines;
}

function parseChecksums(text) {
  const digests = new Map();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([a-f0-9]{64})[ \t]+(.+)$/.exec(line);
    if (!match) return null;
    const [, digest, filename] = match;
    if (digests.has(filename)) return null;
    digests.set(filename.trim(), digest);
  }
  return digests;
}

export async function validateArtifactDirectory(directory) {
  const errors = [];
  const entries = (await readdir(directory)).sort();
  const expected = [...ARTIFACT_FILES, CHECKSUM_FILE].sort();
  for (const filename of entries.filter((entry) => !expected.includes(entry))) {
    errors.push(`unexpected artifact file: ${filename}`);
  }
  for (const filename of expected.filter((entry) => !entries.includes(entry))) {
    errors.push(`missing artifact file: ${filename}`);
  }
  if (errors.length > 0) return errors;

  const checksumPath = resolve(directory, CHECKSUM_FILE);
  let digests;
  try {
    digests = parseChecksums(await readFile(checksumPath, 'utf8'));
  } catch (error) {
    errors.push(`${CHECKSUM_FILE}: unreadable: ${error.message}`);
    return errors;
  }
  if (!digests) {
    errors.push(`${CHECKSUM_FILE}: expected one '<sha256>  <filename>' line per artifact file`);
    return errors;
  }
  for (const filename of ARTIFACT_FILES) {
    if (!digests.has(filename)) errors.push(`${CHECKSUM_FILE}: missing digest for ${filename}`);
  }
  for (const filename of digests.keys()) {
    if (!ARTIFACT_FILES.includes(filename)) errors.push(`${CHECKSUM_FILE}: unexpected entry: ${filename}`);
  }
  if (errors.length > 0) return errors;

  const documents = {};
  for (const filename of ARTIFACT_FILES) {
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
    const digest = await sha256File(path);
    if (digest !== digests.get(filename)) {
      errors.push(`${filename}: does not match ${CHECKSUM_FILE}`);
      continue;
    }
    try {
      documents[filename] = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      errors.push(`${filename}: invalid JSON: ${error.message}`);
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
  const args = process.argv.slice(2);
  const directory = args.find((arg) => !arg.startsWith('--'));
  if (!directory) throw new Error('Usage: node validate-feed-artifact.js <directory> [--write-checksums [path]]');
  if (args.includes('--write-checksums')) {
    const outputPath = args[args.indexOf('--write-checksums') + 1];
    const lines = await writeArtifactChecksums(directory, outputPath?.startsWith('--') ? undefined : outputPath);
    console.log(`Wrote ${lines.length} artifact checksums to ${outputPath ?? join(directory, CHECKSUM_FILE)}.`);
    return;
  }
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
