#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const EXPECTED_FEEDS = [
  'x',
  'podcasts',
  'official-blogs',
  'newsletters',
  'academic-papers',
  'chinese-tech',
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

export async function validateRelease(root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')) {
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

  const [manifest, packageJson, packageLock, schema] = await Promise.all([
    readJson(resolve(rootPath, 'release-manifest.json'), 'release-manifest.json', errors),
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
  if (manifest) errors.push(...validateManifest(manifest, version));
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
  const errors = await validateRelease();
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Release metadata is valid.');
  }
}
