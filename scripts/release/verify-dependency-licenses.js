#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export const APPROVED_LICENSES = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);

function packageName(path) {
  return path.replace(/^node_modules\//, '');
}

export function renderDependencyReport(lock) {
  const dependencies = Object.entries(lock.packages ?? {})
    .filter(([path]) => path.startsWith('node_modules/'))
    .map(([path, metadata]) => ({ name: packageName(path), ...metadata }))
    .sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
  const rows = dependencies.map((dependency) => (
    `| ${dependency.name} | ${dependency.version} | ${dependency.license} | ${dependency.resolved} |`
  ));
  return [
    '# Follow-up v0.1.0 Dependency Licenses',
    '',
    'Generated from `scripts/package-lock.json`. Release verification requires this file to match exactly.',
    '',
    'Approved dependency licenses: MIT, BSD-2-Clause, BSD-3-Clause, ISC.',
    '',
    '| Package | Version | License | Source |',
    '|---|---:|---|---|',
    ...rows,
    '',
  ].join('\n');
}

export async function verifyDependencyLicenses(root) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : resolve(root);
  const lock = JSON.parse(await readFile(resolve(rootPath, 'scripts/package-lock.json'), 'utf8'));
  const errors = [];
  for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/')) continue;
    if (!metadata.license) errors.push(`${packageName(path)} has no declared license`);
    else if (!APPROVED_LICENSES.has(metadata.license)) {
      errors.push(`${packageName(path)} uses unapproved license ${metadata.license}`);
    }
    if (!metadata.version || !metadata.resolved) errors.push(`${packageName(path)} lacks version or source`);
  }
  const expected = renderDependencyReport(lock);
  let actual = '';
  try {
    actual = await readFile(resolve(rootPath, 'docs/third-party/v0.1.0-dependencies.md'), 'utf8');
  } catch (error) {
    errors.push(`dependency report is missing: ${error.message}`);
  }
  if (actual && actual !== expected) errors.push('dependency report does not match scripts/package-lock.json');
  return errors;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = await verifyDependencyLicenses(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log('Dependency licenses and inventory are valid.');
}
