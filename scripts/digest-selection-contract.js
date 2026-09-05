import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { frameFields } from './candidate-identity.js';

export const DIGEST_CURATION_REQUEST_SCHEMA_VERSION = '1.0';
export const DIGEST_SELECTION_SCHEMA_VERSION = '1.0';
export const CURATION_CANDIDATE_LIMIT = 1000;
export const CURATION_SUMMARY_CHARACTER_LIMIT = 12_000;
export const MISSING_SOURCE_STATUS_SUMMARY = 'Source status was not reported.';

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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createRequestHash(request) {
  const { requestHash: _excluded, ...boundFields } = request;
  return createHash('sha256')
    .update(frameFields(['digest-request-v1', canonicalJson(boundFields)]))
    .digest('hex');
}

function requestSemanticErrors(request) {
  const errors = [];
  if (request?.coverage?.frequency !== request?.frequency) {
    errors.push('/coverage/frequency must match /frequency');
  }
  const requestedStart = Date.parse(request?.coverage?.requestedInterval?.start);
  const requestedEnd = Date.parse(request?.coverage?.requestedInterval?.end);
  const actualStart = Date.parse(request?.coverage?.actualInterval?.start);
  const actualEnd = Date.parse(request?.coverage?.actualInterval?.end);
  if (Number.isFinite(actualStart) && Number.isFinite(actualEnd) && actualStart > actualEnd) {
    errors.push('/coverage/actualInterval must not be reversed');
  }
  if (Number.isFinite(requestedStart) && Number.isFinite(requestedEnd)
      && Number.isFinite(actualStart) && Number.isFinite(actualEnd)
      && (actualStart < requestedStart || actualEnd > requestedEnd)) {
    errors.push('/coverage/actualInterval must remain inside /requestedInterval');
  }
  if (request?.coverage?.complete
      && (actualStart !== requestedStart || actualEnd !== requestedEnd)) {
    errors.push('/coverage complete intervals must match');
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
  const completeness = request?.sourceCompleteness;
  const statusCounts = { ok: 0, 'no-results': 0, partial: 0, error: 0 };
  let derivedMissingCount = 0;
  for (const source of request?.sourceStatuses ?? []) {
    if (Object.hasOwn(statusCounts, source?.status)) statusCounts[source.status] += 1;
    if (source?.status === 'error' && source?.candidateCount === 0
        && source?.errorSummary === MISSING_SOURCE_STATUS_SUMMARY) {
      derivedMissingCount += 1;
    }
  }
  const missingCount = completeness?.missingSourceCount ?? 0;
  if (completeness?.totalSourceCount !== request?.sourceStatuses?.length) {
    errors.push('/sourceCompleteness/totalSourceCount must match /sourceStatuses length');
  }
  if (completeness?.expectedSourceCount !== completeness?.totalSourceCount) {
    errors.push('/sourceCompleteness expectedSourceCount must match totalSourceCount');
  }
  if (completeness?.reportedSourceCount + missingCount !== completeness?.expectedSourceCount) {
    errors.push('/sourceCompleteness reportedSourceCount plus missingSourceCount must match expectedSourceCount');
  }
  if (missingCount !== derivedMissingCount) {
    errors.push('/sourceCompleteness/missingSourceCount must match synthetic missing statuses');
  }
  if (completeness?.reportedSourceCount
      !== (request?.sourceStatuses?.length ?? 0) - derivedMissingCount) {
    errors.push('/sourceCompleteness/reportedSourceCount must exclude synthetic missing statuses');
  }
  if (completeness?.okSourceCount !== statusCounts.ok
      || completeness?.noResultsSourceCount !== statusCounts['no-results']
      || completeness?.partialSourceCount !== statusCounts.partial
      || completeness?.errorSourceCount !== statusCounts.error - derivedMissingCount) {
    errors.push('/sourceCompleteness status aggregates must match /sourceStatuses');
  }
  const derivedComplete = completeness?.feedFresh === true && missingCount === 0
    && statusCounts.partial === 0 && statusCounts.error === 0
    && completeness?.reportedSourceCount === completeness?.expectedSourceCount;
  if (completeness?.complete !== derivedComplete) {
    errors.push('/sourceCompleteness complete must match source aggregates');
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
  if (request?.requestHash !== createRequestHash(request)) {
    errors.push('/requestHash must bind the exact curation request');
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
