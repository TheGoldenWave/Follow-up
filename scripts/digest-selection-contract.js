import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const DIGEST_CURATION_REQUEST_SCHEMA_VERSION = '1.0';
export const DIGEST_SELECTION_SCHEMA_VERSION = '1.0';
export const CURATION_CANDIDATE_LIMIT = 1000;
export const CURATION_SUMMARY_CHARACTER_LIMIT = 12_000;

const requestSchema = JSON.parse(readFileSync(
  new URL('../contracts/digest-curation-request.schema.json', import.meta.url), 'utf8',
));
const selectionSchema = JSON.parse(readFileSync(
  new URL('../contracts/digest-selection.schema.json', import.meta.url), 'utf8',
));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv, { mode: 'full' });
const validateRequestSchema = ajv.compile(requestSchema);
const validateSelectionSchema = ajv.compile(selectionSchema);

function formatErrors(errors = []) {
  return errors.map(({ instancePath, keyword, message, params }) => {
    const path = instancePath || '/';
    if (keyword === 'required') return `${path} requires property ${params.missingProperty}`;
    if (keyword === 'additionalProperties') {
      return `${path} contains unsupported property ${params.additionalProperty}`;
    }
    return `${path} ${message}`;
  });
}

function requestSemanticErrors(request) {
  const errors = [];
  if (request?.coverage?.frequency !== request?.frequency) {
    errors.push('/coverage/frequency must match /frequency');
  }
  if (request?.coverage?.complete !== (request?.coverage?.status === 'complete')) {
    errors.push('/coverage complete and status must agree');
  }
  if (request?.coverage?.complete && request?.coverage?.reasons?.length !== 0) {
    errors.push('/coverage/reasons must be empty when coverage is complete');
  }
  if (!request?.coverage?.complete && request?.coverage?.reasons?.length === 0) {
    errors.push('/coverage/reasons must explain incomplete coverage');
  }
  if (request?.sourceCompleteness?.complete
      !== (request?.sourceCompleteness?.status === 'complete')) {
    errors.push('/sourceCompleteness complete and status must agree');
  }
  if (request?.sourceCompleteness?.reportedSourceCount !== request?.sourceStatuses?.length) {
    errors.push('/sourceCompleteness/reportedSourceCount must match /sourceStatuses length');
  }
  if (request?.sourceCompleteness?.complete
      && request?.sourceCompleteness?.expectedSourceCount
        !== request?.sourceCompleteness?.reportedSourceCount) {
    errors.push('/sourceCompleteness counts must match when source coverage is complete');
  }
  if (!request?.sourceCompleteness?.complete
      && request?.sourceCompleteness?.reportedSourceCount
        > request?.sourceCompleteness?.expectedSourceCount) {
    errors.push('/sourceCompleteness reportedSourceCount must not exceed expectedSourceCount');
  }
  const candidateIds = request?.eligibleCandidates?.map(({ candidateId }) => candidateId) ?? [];
  if (new Set(candidateIds).size !== candidateIds.length) {
    errors.push('/eligibleCandidates must not contain duplicate candidateId values');
  }
  const sourceIds = request?.sourceStatuses?.map(({ sourceId }) => sourceId) ?? [];
  if (new Set(sourceIds).size !== sourceIds.length) {
    errors.push('/sourceStatuses must not contain duplicate sourceId values');
  }
  const sourceById = new Map((request?.sourceStatuses ?? [])
    .map((source) => [source.sourceId, source]));
  for (const [index, candidate] of (request?.eligibleCandidates ?? []).entries()) {
    const source = sourceById.get(candidate.sourceId);
    if (!source) errors.push(`/eligibleCandidates/${index}/sourceId is absent from /sourceStatuses`);
    else if (source.channel !== candidate.channel) {
      errors.push(`/eligibleCandidates/${index}/channel must match its source status`);
    }
  }
  if (request?.contentStats) {
    if (request.contentStats.eligibleCount !== candidateIds.length) {
      errors.push('/contentStats/eligibleCount must match /eligibleCandidates length');
    }
    if (request.contentStats.candidateCount
        !== request.contentStats.eligibleCount + request.contentStats.excludedCount) {
      errors.push('/contentStats candidateCount must equal eligibleCount plus excludedCount');
    }
  }
  return errors;
}

export function validateCurationRequest(request) {
  const schemaValid = validateRequestSchema(request);
  const errors = schemaValid ? [] : formatErrors(validateRequestSchema.errors);
  if (schemaValid) errors.push(...requestSemanticErrors(request));
  return { valid: errors.length === 0, errors };
}

export function validateDigestSelection(selection) {
  const valid = validateSelectionSchema(selection);
  const errors = valid ? [] : formatErrors(validateSelectionSchema.errors);
  return { valid: errors.length === 0, errors };
}
