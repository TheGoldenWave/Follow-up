#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export async function checkProvenance(root) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : resolve(root);
  const errors = [];
  let notices = '';
  try {
    notices = await readFile(resolve(rootPath, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  } catch (error) {
    return [`THIRD_PARTY_NOTICES.md is missing: ${error.message}`];
  }
  const status = /^Redistribution authorization status:\s*`([^`]+)`$/mi.exec(notices)?.[1];
  if (status !== 'authorized') {
    errors.push(`redistribution authorization status is ${status ?? 'missing'}; expected authorized`);
  }
  if (!/zarazhangrui\/follow-builders/.test(notices)) {
    errors.push('upstream provenance does not identify zarazhangrui/follow-builders');
  }
  try {
    await access(resolve(rootPath, 'LICENSE'), constants.R_OK);
  } catch {
    errors.push('project LICENSE is missing');
  }
  return errors;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = await checkProvenance(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log('Project provenance authorization is valid.');
}
