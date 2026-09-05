import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  canonicalizeUrl,
  createCandidateId,
  createContentFingerprint,
} from './candidate-identity.js';
import {
  DEFAULT_CONTENT_CHARACTER_LIMIT,
  PODCAST_CONTENT_CHARACTER_LIMIT,
} from './candidate-normalization.js';

export const CANDIDATE_FEED_SCHEMA_VERSION = '1.0';

const schema = JSON.parse(readFileSync(
  new URL('../contracts/candidate-feed.schema.json', import.meta.url),
  'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv, { mode: 'full' });
const validateSchema = ajv.compile(schema);

function formatErrors(errors = []) {
  return errors.map(({ instancePath, keyword, message, params }) => {
    const path = instancePath || '/';
    if (keyword === 'required') return `${path} requires property ${params.missingProperty}`;
    if (keyword === 'additionalProperties') return `${path} contains unsupported property ${params.additionalProperty}`;
    return `${path} ${message}`;
  });
}

function uniquenessErrors(feed) {
  const errors = [];
  for (const [path, values] of [
    ['/registry', Array.isArray(feed?.registry)
      ? feed.registry.map((entry) => entry?.sourceId) : null],
    ['/candidates', Array.isArray(feed?.candidates)
      ? feed.candidates.map((entry) => entry?.candidateId) : null],
  ]) {
    if (values && new Set(values).size !== values.length) {
      errors.push(`${path} must not contain duplicate identities`);
    }
  }
  if (Array.isArray(feed?.registry) && Array.isArray(feed?.candidates)) {
    const sources = new Map(feed.registry
      .filter((status) => status && typeof status === 'object')
      .map((status) => [status.sourceId, status]));
    for (const [index, candidate] of feed.candidates.entries()) {
      if (!candidate || typeof candidate !== 'object') continue;
      const source = sources.get(candidate.sourceId);
      if (!source) {
        errors.push(`/candidates/${index}/sourceId is absent from /registry`);
      } else if (source.channel !== candidate.channel) {
        errors.push(`/candidates/${index}/channel must match its /registry source channel`);
      }
    }
  }
  return errors;
}

function expectedNamespace(channel) {
  if (channel === 'podcasts') return 'podcast';
  if (channel === 'blogs') return 'blog';
  if (channel === 'newsletters') return 'newsletter';
  return channel;
}

function semanticErrors(feed) {
  const errors = [];
  const registry = Array.isArray(feed.registry) ? feed.registry : [];
  const candidates = Array.isArray(feed.candidates) ? feed.candidates : [];
  for (const [index, source] of registry.entries()) {
    if (typeof source?.sourceId === 'string' && typeof source?.channel === 'string'
      && !source.sourceId.startsWith(`${expectedNamespace(source.channel)}:`)) {
      errors.push(`/registry/${index}/sourceId must use the namespace for its channel`);
    }
    if (source?.status === 'ok' && source.candidateCount < 1) {
      errors.push(`/registry/${index}/candidateCount must be positive for ok status`);
    }
    if ((source?.status === 'ok' || source?.status === 'no-results')
      && source.failedCandidateCount !== undefined) {
      errors.push(`/registry/${index}/failedCandidateCount is incompatible with ${source.status} status`);
    }
    if ((source?.status === 'ok' || source?.status === 'no-results')
      && source.errorSummary !== undefined) {
      errors.push(`/registry/${index}/errorSummary is incompatible with ${source.status} status`);
    }
    if ((source?.status === 'no-results' || source?.status === 'error')
      && source.candidateCount !== 0) {
      errors.push(`/registry/${index}/candidateCount must be zero for ${source.status} status`);
    }
    if (source?.status === 'partial' && source.candidateCount < 1) {
      errors.push(`/registry/${index}/candidateCount must be positive for partial status`);
    }
  }

  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (typeof candidate.sourceId === 'string' && typeof candidate.channel === 'string'
      && !candidate.sourceId.startsWith(`${expectedNamespace(candidate.channel)}:`)) {
      errors.push(`/candidates/${index}/sourceId must use the namespace for its channel`);
    }
    if (typeof candidate.canonicalUrl === 'string'
      && canonicalizeUrl(candidate.canonicalUrl) !== candidate.canonicalUrl) {
      errors.push(`/candidates/${index}/canonicalUrl must be canonical`);
    }
    try {
      if (candidate.candidateId !== createCandidateId(candidate)) {
        errors.push(`/candidates/${index}/candidateId does not match candidate identity`);
      }
    } catch {
      // Schema errors already describe missing or malformed identity fields.
    }
    try {
      if (candidate.contentFingerprint !== createContentFingerprint(candidate)) {
        errors.push(`/candidates/${index}/contentFingerprint does not match normalized content`);
      }
    } catch {
      // Schema errors already describe missing or malformed content fields.
    }
    if (typeof candidate.summarizationContent === 'string') {
      const limit = candidate.channel === 'podcasts'
        ? PODCAST_CONTENT_CHARACTER_LIMIT
        : DEFAULT_CONTENT_CHARACTER_LIMIT;
      if (Array.from(candidate.summarizationContent).length > limit) {
        errors.push(`/candidates/${index}/summarizationContent exceeds the ${limit}-character limit`);
      }
    }
  }
  return errors;
}

function timestampErrors(feed) {
  const errors = [];
  const generatedAt = Date.parse(feed.generatedAt);
  if (!Number.isFinite(generatedAt)) return errors;
  for (const field of ['initializedAt', 'continuousHistorySince']) {
    const timestamp = Date.parse(feed[field]);
    if (Number.isFinite(timestamp) && timestamp > generatedAt) {
      errors.push(`/${field} must not be later than /generatedAt`);
    }
  }
  if (!Array.isArray(feed.candidates)) return errors;
  for (const [index, candidate] of feed.candidates.entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const firstSeenAt = Date.parse(candidate.firstSeenAt);
    const lastSeenAt = Date.parse(candidate.lastSeenAt);
    if (Number.isFinite(firstSeenAt) && Number.isFinite(lastSeenAt) && firstSeenAt > lastSeenAt) {
      errors.push(`/candidates/${index}/firstSeenAt must not be later than lastSeenAt`);
    }
    if (Number.isFinite(lastSeenAt) && lastSeenAt > generatedAt) {
      errors.push(`/candidates/${index}/lastSeenAt must not be later than /generatedAt`);
    }
  }
  return errors;
}

function truncationErrors(feed) {
  const errors = [];
  const boundaries = feed?.truncation?.oldestRetainedFirstSeenAtBySource;
  const oldestRemoved = feed?.truncation?.oldestRemovedFirstSeenAtBySource;
  const newestRemoved = feed?.truncation?.newestRemovedFirstSeenAtBySource;
  if (oldestRemoved || newestRemoved) {
    if (!oldestRemoved || !newestRemoved) {
      errors.push('/truncation removed firstSeenAt range maps must be provided together');
    } else {
      const affected = new Set(feed.truncation.affectedSourceIds ?? []);
      for (const sourceId of affected) {
        if (!Object.hasOwn(oldestRemoved, sourceId) || !Object.hasOwn(newestRemoved, sourceId)) {
          errors.push(`/truncation removed firstSeenAt ranges are missing affected source ${sourceId}`);
          continue;
        }
        if (Date.parse(oldestRemoved[sourceId]) > Date.parse(newestRemoved[sourceId])) {
          errors.push(`/truncation removed firstSeenAt range is reversed for source ${sourceId}`);
        }
      }
      for (const sourceId of [...Object.keys(oldestRemoved), ...Object.keys(newestRemoved)]) {
        if (!affected.has(sourceId)) {
          errors.push(`/truncation removed firstSeenAt ranges contain unaffected source ${sourceId}`);
        }
      }
    }
  }
  if (!boundaries || typeof boundaries !== 'object' || Array.isArray(boundaries)) return errors;
  const affected = new Set(feed.truncation.affectedSourceIds ?? []);
  for (const sourceId of Object.keys(boundaries)) {
    if (!affected.has(sourceId)) {
      errors.push(`/truncation/oldestRetainedFirstSeenAtBySource contains unaffected source ${sourceId}`);
    }
  }
  if (feed.historyTruncated) {
    for (const sourceId of affected) {
      if (!Object.hasOwn(boundaries, sourceId)) {
        errors.push(`/truncation/oldestRetainedFirstSeenAtBySource is missing affected source ${sourceId}`);
      }
    }
  }
  return errors;
}

function normalizedExpectedRegistry(expectedRegistry) {
  if (!Array.isArray(expectedRegistry)) {
    return { errors: ['/registry requires an expectedRegistry array for completeness validation'] };
  }
  const expected = new Map();
  const errors = [];
  for (const [index, source] of expectedRegistry.entries()) {
    const sourceId = source?.id ?? source?.sourceId;
    if (typeof sourceId !== 'string' || typeof source?.channel !== 'string') {
      errors.push(`/expectedRegistry/${index} requires id and channel`);
      continue;
    }
    if (expected.has(sourceId)) {
      errors.push(`/expectedRegistry contains duplicate source ${sourceId}`);
      continue;
    }
    expected.set(sourceId, {
      channel: source.channel,
      sourceName: typeof source.name === 'string' && source.name.length > 0
        ? source.name : sourceId,
    });
  }
  return { expected, errors };
}

function registryIdentityErrors(feed, expectedRegistry) {
  const { expected, errors } = normalizedExpectedRegistry(expectedRegistry);
  if (!expected) return errors;

  const actual = Array.isArray(feed.registry)
    ? new Map(feed.registry
      .filter((source) => source && typeof source === 'object')
      .map((source) => [source.sourceId, source.channel]))
    : new Map();
  for (const [sourceId, { channel }] of expected) {
    if (actual.has(sourceId) && actual.get(sourceId) !== channel) {
      errors.push(`/registry source ${sourceId} must use configured channel ${channel}`);
    }
  }
  for (const sourceId of actual.keys()) {
    if (!expected.has(sourceId)) errors.push(`/registry contains unconfigured source ${sourceId}`);
  }
  return errors;
}

function registryCoverageErrors(feed, expectedRegistry) {
  const { expected, errors } = normalizedExpectedRegistry(expectedRegistry);
  if (!expected) return errors;
  const actualIds = new Set(Array.isArray(feed.registry)
    ? feed.registry.map((source) => source?.sourceId) : []);
  for (const sourceId of expected.keys()) {
    if (!actualIds.has(sourceId)) errors.push(`/registry is missing configured source ${sourceId}`);
  }
  return errors;
}

export function validateCandidateFeedStructure(feed, { expectedRegistry } = {}) {
  const schemaValid = validateSchema(feed);
  const errors = schemaValid ? [] : formatErrors(validateSchema.errors);
  if (feed && typeof feed === 'object' && !Array.isArray(feed)) {
    errors.push(...uniquenessErrors(feed));
    errors.push(...semanticErrors(feed));
    errors.push(...timestampErrors(feed));
    errors.push(...truncationErrors(feed));
    errors.push(...registryIdentityErrors(feed, expectedRegistry));
  }
  return { valid: errors.length === 0, errors };
}

export function validateCandidateFeedCompleteness(feed, { expectedRegistry } = {}) {
  const { expected, errors } = normalizedExpectedRegistry(expectedRegistry);
  if (!expected || errors.length > 0) {
    throw new TypeError('expectedRegistry must contain unique source identities');
  }
  const actualIds = new Set(Array.isArray(feed?.registry)
    ? feed.registry.map((source) => source?.sourceId) : []);
  const missingSources = [];
  for (const [sourceId, source] of expected) {
    if (!actualIds.has(sourceId)) missingSources.push({ sourceId, ...source });
  }
  return { complete: missingSources.length === 0, missingSources };
}

export function validateCandidateFeed(feed, options = {}) {
  const structure = validateCandidateFeedStructure(feed, options);
  const errors = [...structure.errors];
  if (feed && typeof feed === 'object' && !Array.isArray(feed)) {
    errors.push(...registryCoverageErrors(feed, options.expectedRegistry));
  }
  return { valid: errors.length === 0, errors };
}

export function createCandidateFeed(fields, options) {
  const feed = { ...fields, schemaVersion: CANDIDATE_FEED_SCHEMA_VERSION };
  const result = validateCandidateFeed(feed, options);
  if (!result.valid) {
    throw new Error(`Invalid candidate Feed: ${result.errors.join('; ')}`);
  }
  return feed;
}
