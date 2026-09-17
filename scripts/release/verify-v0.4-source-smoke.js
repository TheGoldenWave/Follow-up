#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { scanBuffer } from './scan-secrets.js';

const EXPECTED = new Map([
  ['github', new Set(['community:github'])],
  ['hackernews', new Set(['community:hacker-news'])],
  ['reddit', new Set(['community:reddit-artificial', 'community:reddit-localllama', 'community:reddit-machinelearning'])],
  ['techmeme', new Set(['community:techmeme'])],
  ['arxiv', new Set(['academic:arxiv-cs-ai', 'academic:arxiv-cs-cl', 'academic:arxiv-cs-cr', 'academic:arxiv-cs-cv', 'academic:arxiv-cs-lg', 'academic:arxiv-cs-ro'])],
  ['hugging-face-papers', new Set(['academic:hugging-face-papers'])],
]);
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SENSITIVE_NOTE = /(?:github_pat_|\bgh[pousr]_|\bsk-|\bAKIA|-----BEGIN|https?:\/\/)/i;
const schema = JSON.parse(await readFile(new URL('../../contracts/v0.4-source-smoke.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv, { mode: 'full' });
const validateSchema = ajv.compile(schema);

function pathErrors(errors = []) {
  return errors.map(({ instancePath, keyword, params }) => (
    keyword === 'required'
      ? `${instancePath || '/'} requires ${params.missingProperty}`
      : `${instancePath || '/'} is invalid`
  ));
}

export function validateSourceSmoke(evidence, { now = new Date().toISOString() } = {}) {
  const errors = validateSchema(evidence) ? [] : pathErrors(validateSchema.errors);
  if (!evidence || !Array.isArray(evidence.runs)) return errors;
  const nowMs = Date.parse(now);
  const seen = new Set();
  for (const [index, run] of evidence.runs.entries()) {
    const path = `/runs/${index}`;
    if (!run || typeof run !== 'object') continue;
    if (seen.has(run.adapterId)) errors.push(`${path}/adapterId must be unique`);
    seen.add(run.adapterId);
    if (!EXPECTED.get(run.adapterId)?.has(run.sourceId)) errors.push(`${path}/sourceId must match adapterId`);
    const startedAt = Date.parse(run.startedAt);
    const completedAt = Date.parse(run.completedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt > completedAt) {
      errors.push(`${path}/startedAt must not be later than completedAt`);
    }
    if (!Number.isFinite(completedAt) || !Number.isFinite(nowMs) || nowMs - completedAt > MAX_AGE_MS || completedAt > nowMs) {
      errors.push(`${path}/completedAt must be within seven days`);
    }
    if (run.status !== 'ok') errors.push(`${path}/status must be ok`);
    if (run.uniqueCandidateCount < 1 || run.rawCandidateCount < run.uniqueCandidateCount) {
      errors.push(`${path}/uniqueCandidateCount must be between 1 and rawCandidateCount`);
    }
    const duplicateRate = run.rawCandidateCount === 0 ? 0
      : (run.rawCandidateCount - run.uniqueCandidateCount) / run.rawCandidateCount;
    if (run.duplicateRate !== duplicateRate) errors.push(`${path}/duplicateRate must match counts`);
    if (run.sampledCandidateCount !== Math.min(5, run.uniqueCandidateCount)) {
      errors.push(`${path}/sampledCandidateCount must equal min(5, uniqueCandidateCount)`);
    }
    const relevanceRate = run.sampledCandidateCount === 0 ? 0
      : run.relevantCandidateCount / run.sampledCandidateCount;
    if (run.relevantCandidateCount > run.sampledCandidateCount || run.relevanceRate !== relevanceRate || relevanceRate < 0.8) {
      errors.push(`${path}/relevanceRate must match reviewed samples and be at least 0.8`);
    }
    if (SENSITIVE_NOTE.test(run.notes ?? '') || scanBuffer('smoke-evidence', Buffer.from(JSON.stringify(run))).length) {
      errors.push(`${path}/notes contains restricted content`);
    }
  }
  for (const adapterId of EXPECTED.keys()) if (!seen.has(adapterId)) errors.push('/runs must contain every v0.4 adapter');
  return [...new Set(errors)];
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const args = process.argv.slice(2);
  const evidenceIndex = args.indexOf('--evidence');
  const nowIndex = args.indexOf('--now');
  if ((evidenceIndex >= 0 && !args[evidenceIndex + 1]) || (nowIndex >= 0 && !args[nowIndex + 1])) {
    console.error('usage: verify-v0.4-source-smoke.js [--evidence <path>] [--now <ISO-8601>]');
    process.exit(2);
  }
  const path = evidenceIndex >= 0 ? resolve(args[evidenceIndex + 1])
    : resolve(root, 'docs/operations/evidence/v0.4.0-source-smoke.json');
  try {
    const evidence = JSON.parse(await readFile(path, 'utf8'));
    const errors = validateSourceSmoke(evidence, { now: nowIndex >= 0 ? args[nowIndex + 1] : undefined });
    if (errors.length) {
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else console.log('v0.4 source smoke evidence is valid.');
  } catch {
    console.error('- / evidence is unavailable or invalid JSON');
    process.exitCode = 1;
  }
}
