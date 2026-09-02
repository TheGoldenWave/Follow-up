#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const EXPECTED_FEEDS = [
  'x',
  'podcasts',
  'official-blogs',
  'newsletters',
  'academic-papers',
  'chinese-tech',
];

export const REQUIRED_CRITICAL_FILES = [
  'SKILL.md',
  'VERSION',
  'contracts/central-feed.schema.json',
  'contracts/release-manifest.schema.json',
  'prompts/digest-intro.md',
  'prompts/summarize-blogs.md',
  'prompts/summarize-newsletter.md',
  'prompts/summarize-paper.md',
  'prompts/summarize-podcast.md',
  'prompts/summarize-tweets.md',
  'prompts/summarize-zh-sources.md',
  'prompts/translate.md',
  'scripts/feed-contract.js',
  'scripts/package-lock.json',
  'scripts/package.json',
  'scripts/prepare-digest.js',
  'scripts/release/build-release.sh',
  'scripts/release/validate-release.js',
];

const PRODUCT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TOP_LEVEL_FIELDS = [
  '$schema',
  'schemaVersion',
  'productVersion',
  'releaseDate',
  'channel',
  'minimumSupportedVersion',
  'releaseNotesUrl',
  'trustMode',
  'runtime',
  'acquisition',
  'capabilities',
  'integrity',
];
const PLANNED_CAPABILITIES = [
  'localAcquisition',
  'sidecars',
  'feedbackState',
  'updater',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGregorianDate(value) {
  const match = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    : null;
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateFields(value, path, allowed, required, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }

  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path} has unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  }
  return true;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function git(rootPath, args, options = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: rootPath,
    encoding: 'buffer',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  return stdout;
}

export async function computeTrackedContentDigest(root, treeish = 'HEAD') {
  const rootPath = toPath(root);
  const output = await git(rootPath, ['ls-tree', '-r', '-z', '--full-tree', treeish]);
  const records = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index > start) records.push(output.subarray(start, index));
    start = index + 1;
  }
  const manifestSuffix = Buffer.from('\trelease-manifest.json');
  const included = records.filter((record) => !record.subarray(-manifestSuffix.length).equals(manifestSuffix));
  const canonicalStream = Buffer.concat(included.flatMap((record) => [record, Buffer.from([0])]));
  return {
    algorithm: 'git-ls-tree-sha256-v1',
    digest: sha256(canonicalStream),
  };
}

export async function computeCriticalFileHashes(root, paths, treeish = 'HEAD') {
  const rootPath = toPath(root);
  const hashes = {};
  for (const path of [...paths].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
    if (path === 'release-manifest.json') {
      throw new Error('release-manifest.json cannot hash itself');
    }
    hashes[path] = sha256(await git(rootPath, ['show', `${treeish}:${path}`]));
  }
  return hashes;
}

export async function computeArchiveCriticalFileHashes(root, paths) {
  const rootPath = toPath(root);
  const hashes = {};
  for (const path of [...paths].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
    if (path === 'release-manifest.json') {
      throw new Error('release-manifest.json cannot hash itself');
    }
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
      throw new Error(`critical file path must stay inside the release: ${path}`);
    }
    hashes[path] = sha256(await readFile(resolve(rootPath, path)));
  }
  return hashes;
}

async function verifyReleaseIntegrity(rootPath, manifest, mode, treeish) {
  const errors = [];
  try {
    const criticalPaths = Object.keys(manifest.integrity?.criticalFiles?.files ?? {});
    let criticalFiles;
    if (mode === 'archive') {
      criticalFiles = await computeArchiveCriticalFileHashes(rootPath, criticalPaths);
    } else if (mode === 'checkout') {
      const trackedContent = await computeTrackedContentDigest(rootPath, treeish);
      if (trackedContent.digest !== manifest.integrity.trackedContent?.digest) {
        errors.push(`manifest tracked content digest does not match ${treeish}`);
      }
      criticalFiles = await computeCriticalFileHashes(rootPath, criticalPaths, treeish);
    } else {
      return [`unknown release validation mode: ${mode}`];
    }
    for (const path of criticalPaths) {
      if (criticalFiles[path] !== manifest.integrity.criticalFiles.files[path]) {
        const source = mode === 'archive' ? path : `${treeish}:${path}`;
        errors.push(`manifest critical file hash does not match ${source}`);
      }
    }
  } catch (error) {
    const source = mode === 'archive' ? 'archive' : treeish;
    errors.push(`release integrity could not be verified for ${source}: ${error.message}`);
  }
  return errors;
}

export async function validateArchiveCriticalFiles(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
) {
  const rootPath = toPath(root);
  try {
    const manifest = JSON.parse(await readFile(resolve(rootPath, 'release-manifest.json'), 'utf8'));
    if (!isObject(manifest.integrity?.criticalFiles?.files)
        || Object.keys(manifest.integrity.criticalFiles.files).length === 0) {
      return ['manifest critical file list is missing or empty'];
    }
    const missing = REQUIRED_CRITICAL_FILES.filter(
      (path) => !Object.hasOwn(manifest.integrity.criticalFiles.files, path),
    );
    if (missing.length > 0) {
      return missing.map((path) => `manifest is missing required critical file ${path}`);
    }
    return verifyReleaseIntegrity(rootPath, manifest, 'archive', 'HEAD');
  } catch (error) {
    return [`archive critical-file preflight failed: ${error.message}`];
  }
}

export function validateManifest(manifest, repositoryVersion) {
  const errors = [];
  if (!validateFields(manifest, 'manifest', TOP_LEVEL_FIELDS, TOP_LEVEL_FIELDS, errors)) {
    return errors;
  }

  if (manifest.$schema !== './contracts/release-manifest.schema.json') {
    errors.push('manifest.$schema must reference the release manifest schema');
  }
  if (manifest.schemaVersion !== '1.0') {
    errors.push('manifest.schemaVersion must be 1.0');
  }
  if (typeof manifest.productVersion !== 'string'
      || !PRODUCT_VERSION_PATTERN.test(manifest.productVersion)) {
    errors.push('manifest.productVersion must be a plain semantic version');
  }
  if (manifest.productVersion !== repositoryVersion) {
    errors.push(`manifest.productVersion ${manifest.productVersion} does not match VERSION ${repositoryVersion}`);
  }
  if (!isGregorianDate(manifest.releaseDate)) {
    errors.push('manifest.releaseDate must be a real Gregorian date using YYYY-MM-DD');
  }
  if (manifest.channel !== 'stable') errors.push('manifest.channel must be stable');
  if (manifest.minimumSupportedVersion !== null) {
    errors.push('manifest.minimumSupportedVersion must be null for the first release');
  }
  const expectedNotesUrl = `https://github.com/TheGoldenWave/Follow-up/releases/tag/v${manifest.productVersion}`;
  if (manifest.releaseNotesUrl !== expectedNotesUrl) {
    errors.push('manifest.releaseNotesUrl must identify the matching canonical GitHub release');
  }
  if (manifest.trustMode !== 'github-tag-sha256') {
    errors.push('manifest.trustMode must be github-tag-sha256');
  }

  if (validateFields(manifest.runtime, 'manifest.runtime', ['node'], ['node'], errors)
      && manifest.runtime.node !== '>=20.0.0') {
    errors.push('manifest.runtime.node must be >=20.0.0');
  }

  if (validateFields(
    manifest.acquisition,
    'manifest.acquisition',
    ['mode', 'feeds'],
    ['mode', 'feeds'],
    errors,
  )) {
    if (manifest.acquisition.mode !== 'centralized') {
      errors.push('manifest.acquisition.mode must be centralized');
    }
    if (!Array.isArray(manifest.acquisition.feeds)
        || manifest.acquisition.feeds.length !== EXPECTED_FEEDS.length
        || !EXPECTED_FEEDS.every((feed, index) => manifest.acquisition.feeds[index] === feed)) {
      errors.push('manifest.acquisition.feeds must list exactly the six feeds in canonical order');
    }
  }

  if (validateFields(
    manifest.capabilities,
    'manifest.capabilities',
    PLANNED_CAPABILITIES,
    PLANNED_CAPABILITIES,
    errors,
  )) {
    for (const capability of PLANNED_CAPABILITIES) {
      if (manifest.capabilities[capability] !== false) {
        errors.push(`manifest.capabilities.${capability} must be false in v0.1.0`);
      }
    }
  }

  if (validateFields(
    manifest.integrity,
    'manifest.integrity',
    ['trackedContent', 'criticalFiles'],
    ['trackedContent', 'criticalFiles'],
    errors,
  )) {
    if (validateFields(
      manifest.integrity.trackedContent,
      'manifest.integrity.trackedContent',
      ['algorithm', 'digest'],
      ['algorithm', 'digest'],
      errors,
    )) {
      if (manifest.integrity.trackedContent.algorithm !== 'git-ls-tree-sha256-v1') {
        errors.push('manifest.integrity.trackedContent.algorithm must be git-ls-tree-sha256-v1');
      }
      if (!/^[a-f0-9]{64}$/.test(manifest.integrity.trackedContent.digest ?? '')) {
        errors.push('manifest.integrity.trackedContent.digest must be a lowercase SHA-256 digest');
      }
    }

    if (validateFields(
      manifest.integrity.criticalFiles,
      'manifest.integrity.criticalFiles',
      ['algorithm', 'files'],
      ['algorithm', 'files'],
      errors,
    )) {
      if (manifest.integrity.criticalFiles.algorithm !== 'sha256') {
        errors.push('manifest.integrity.criticalFiles.algorithm must be sha256');
      }
      const files = manifest.integrity.criticalFiles.files;
      if (!isObject(files) || Object.keys(files).length === 0) {
        errors.push('manifest.integrity.criticalFiles.files must be a non-empty object');
      } else {
        for (const path of REQUIRED_CRITICAL_FILES) {
          if (!Object.hasOwn(files, path)) {
            errors.push(`manifest.integrity.criticalFiles.files is missing required critical file ${path}`);
          }
        }
        for (const [path, digest] of Object.entries(files)) {
          if (path === 'release-manifest.json') {
            errors.push('manifest.integrity.criticalFiles.files cannot include release-manifest.json');
          }
          if (!/^[a-f0-9]{64}$/.test(digest)) {
            errors.push(`manifest.integrity.criticalFiles.files.${path} must be a lowercase SHA-256 digest`);
          }
        }
      }
    }
  }

  return errors;
}

function toPath(root) {
  return root instanceof URL ? fileURLToPath(root) : resolve(root);
}

async function readJson(path, label, errors) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    errors.push(`${label} is not readable JSON: ${error.message}`);
    return null;
  }
}

export async function validateRelease(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  { treeish = 'HEAD', mode = 'checkout', verifyIntegrity = true } = {},
) {
  const rootPath = toPath(root);
  const errors = [];
  let version;

  try {
    version = (await readFile(resolve(rootPath, 'VERSION'), 'utf8')).trim();
  } catch (error) {
    errors.push(`VERSION is not readable: ${error.message}`);
    return errors;
  }
  if (!PRODUCT_VERSION_PATTERN.test(version)) errors.push('VERSION must be a plain semantic version');

  const manifest = await readJson(
    resolve(rootPath, 'release-manifest.json'),
    'release-manifest.json',
    errors,
  );
  if (manifest) errors.push(...validateManifest(manifest, version));
  if (verifyIntegrity && manifest?.integrity) {
    errors.push(...await verifyReleaseIntegrity(rootPath, manifest, mode, treeish));
  }

  const [packageJson, packageLock, schema] = await Promise.all([
    readJson(resolve(rootPath, 'scripts/package.json'), 'scripts/package.json', errors),
    readJson(resolve(rootPath, 'scripts/package-lock.json'), 'scripts/package-lock.json', errors),
    readJson(
      resolve(rootPath, 'contracts/release-manifest.schema.json'),
      'contracts/release-manifest.schema.json',
      errors,
    ),
  ]);

  if (manifest && schema) {
    try {
      const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
        import('ajv/dist/2020.js'),
        import('ajv-formats'),
      ]);
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      addFormats(ajv, { mode: 'full' });
      const validateSchema = ajv.compile(schema);
      if (!validateSchema(manifest)) {
        for (const error of validateSchema.errors ?? []) {
          const location = error.instancePath || '/';
          errors.push(`release-manifest.json schema validation failed at ${location}: ${error.message}`);
        }
      }
    } catch (error) {
      errors.push(`contracts/release-manifest.schema.json is invalid: ${error.message}`);
    }
  }
  if (packageJson?.version !== version) {
    errors.push(`scripts/package.json version ${packageJson?.version} does not match VERSION ${version}`);
  }
  if (packageLock?.version !== version || packageLock?.packages?.['']?.version !== version) {
    errors.push(`scripts/package-lock.json versions do not match VERSION ${version}`);
  }
  if (packageJson?.engines?.node !== manifest?.runtime?.node) {
    errors.push('scripts/package.json engines.node does not match manifest.runtime.node');
  }
  if (packageLock?.packages?.['']?.engines?.node !== manifest?.runtime?.node) {
    errors.push('scripts/package-lock.json engines.node does not match manifest.runtime.node');
  }
  if (schema?.$id !== 'https://github.com/TheGoldenWave/Follow-up/contracts/release-manifest.schema.json') {
    errors.push('contracts/release-manifest.schema.json has an unexpected $id');
  }

  try {
    const changelog = await readFile(resolve(rootPath, 'CHANGELOG.md'), 'utf8');
    const heading = new RegExp(
      `^## \\[${escapeRegExp(version)}\\] - ${escapeRegExp(manifest?.releaseDate ?? '')}$`,
      'm',
    );
    if (!heading.test(changelog)) {
      errors.push(`CHANGELOG.md date does not match manifest.releaseDate for VERSION ${version}`);
    }
  } catch (error) {
    errors.push(`CHANGELOG.md is not readable: ${error.message}`);
  }

  return errors;
}

const isCli = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  const args = process.argv.slice(2);
  const mode = args.includes('--archive') ? 'archive' : 'checkout';
  const treeishIndex = args.indexOf('--treeish');
  const treeish = treeishIndex >= 0 ? args[treeishIndex + 1] : 'HEAD';
  if (treeishIndex >= 0 && !treeish) {
    console.error('--treeish requires a Git revision');
    process.exit(2);
  }

  if (args.includes('--archive-critical-only')) {
    const errors = await validateArchiveCriticalFiles();
    if (errors.length > 0) {
      for (const error of errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log('Archive critical file SHA-256 hashes are valid.');
    process.exit(0);
  }

  if (args.includes('--write-integrity')) {
    if (mode === 'archive') {
      console.error('--write-integrity requires a Git checkout');
      process.exit(2);
    }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const manifestPath = resolve(root, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const criticalPaths = Object.keys(manifest.integrity?.criticalFiles?.files ?? {});
    manifest.integrity = {
      trackedContent: await computeTrackedContentDigest(root, treeish),
      criticalFiles: {
        algorithm: 'sha256',
        files: await computeCriticalFileHashes(root, criticalPaths, treeish),
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Updated release integrity from ${treeish}.`);
    process.exit(0);
  }

  const errors = await validateRelease(undefined, { treeish, mode });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    if (mode === 'archive') {
      console.log('Tracked content digest is checkout-only; archive mode verified all critical file SHA-256 hashes.');
    }
    console.log('Release metadata is valid.');
  }
}
