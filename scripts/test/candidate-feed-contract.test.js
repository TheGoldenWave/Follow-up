import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANDIDATE_FEED_SCHEMA_VERSION,
  createCandidateFeed,
  validateCandidateFeed,
  validateCandidateFeedCompleteness,
  validateCandidateFeedStructure,
} from '../candidate-feed-contract.js';
import {
  createCandidateId,
  createContentFingerprint,
} from '../candidate-identity.js';

function validCandidate() {
  const candidate = {
    channel: 'blogs',
    sourceId: 'blog:lab',
    canonicalUrl: 'https://example.com/post',
    title: 'A post',
    author: 'Lab',
    publishedAt: '2026-09-05T00:00:00.000Z',
    firstSeenAt: '2026-09-06T00:00:00.000Z',
    lastSeenAt: '2026-09-06T01:00:00.000Z',
    summarizationContent: 'Summary',
    contentTruncated: false,
  };
  candidate.candidateId = createCandidateId(candidate);
  candidate.contentFingerprint = createContentFingerprint(candidate);
  return candidate;
}

function validFields() {
  return {
    generatedAt: '2026-09-06T01:00:00.000Z',
    initializedAt: '2026-09-01T00:00:00.000Z',
    continuousHistorySince: '2026-09-01T00:00:00.000Z',
    retention: {
      defaultDays: 15,
      podcastDays: 30,
      minimumPerSource: 50,
      maxCandidates: 1000,
    },
    historyTruncated: false,
    truncation: {
      affectedSourceIds: [],
      oldestRetainedAt: null,
      removedCount: 0,
    },
    registry: [{
      sourceId: 'blog:lab', channel: 'blogs', sourceName: 'Lab Blog',
      status: 'ok', candidateCount: 1,
    }],
    candidates: [validCandidate()],
  };
}

const expectedRegistry = [{ id: 'blog:lab', channel: 'blogs', name: 'Current Lab Name' }];

function validate(feed, registry = expectedRegistry) {
  return validateCandidateFeed(feed, { expectedRegistry: registry });
}

test('creates and validates a strict candidate Feed v1.0 envelope', () => {
  const feed = createCandidateFeed(validFields(), { expectedRegistry });

  assert.equal(feed.schemaVersion, CANDIDATE_FEED_SCHEMA_VERSION);
  assert.equal(validate(feed).valid, true);
  assert.equal(CANDIDATE_FEED_SCHEMA_VERSION, '1.0');
});

test('requires initialization, history, retention, diagnostics, registry statuses, and candidates', () => {
  for (const key of [
    'generatedAt', 'initializedAt', 'continuousHistorySince', 'retention',
    'historyTruncated', 'truncation', 'registry', 'candidates',
  ]) {
    const fields = validFields();
    delete fields[key];
    const result = validate({ schemaVersion: '1.0', ...fields });
    assert.equal(result.valid, false, key);
    assert.ok(result.errors.some((error) => error.includes(key)), key);
  }
});

test('rejects unknown fields and invalid or non-strict dates', () => {
  const feed = { schemaVersion: '1.0', ...validFields(), unexpected: true };
  assert.equal(validate(feed).valid, false);

  for (const generatedAt of ['2026-09-06', '2026-02-30T00:00:00Z', 'not-a-date']) {
    const result = validate({ ...feed, unexpected: undefined, generatedAt });
    assert.equal(result.valid, false, generatedAt);
  }
});

test('registry contains one current status per source and candidate objects are closed', () => {
  const duplicate = validFields();
  duplicate.registry.push({ ...duplicate.registry[0], status: 'no-results', candidateCount: 0 });
  assert.equal(validate({ schemaVersion: '1.0', ...duplicate }).valid, false);

  const extraCandidateField = validFields();
  extraCandidateField.candidates[0].secret = 'must not pass';
  assert.equal(validate({ schemaVersion: '1.0', ...extraCandidateField }).valid, false);
});

test('validation errors are actionable without echoing secret values', () => {
  const fields = validFields();
  fields.candidates[0].canonicalUrl = 'https://example.com/?token=super-secret';
  fields.candidates[0].channel = 'unknown';
  const result = validate({ schemaVersion: '1.0', ...fields });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('/candidates/0/channel')));
  assert.doesNotMatch(result.errors.join(' '), /super-secret/);
  assert.throws(() => createCandidateFeed({ ...fields, password: 'also-secret' }, { expectedRegistry }), (error) => (
    /Invalid candidate Feed/.test(error.message) && !/also-secret/.test(error.message)
  ));
});

test('enforces source status semantics and source namespace/channel consistency', () => {
  for (const mutation of [
    (fields) => { fields.registry[0].status = 'no-results'; fields.registry[0].candidateCount = 1; },
    (fields) => { fields.registry[0].status = 'ok'; fields.registry[0].candidateCount = 0; },
    (fields) => { fields.registry[0].failedCandidateCount = 1; },
    (fields) => { fields.registry[0].errorSummary = 'Lab: lost one'; },
    (fields) => { fields.registry[0].status = 'partial'; fields.registry[0].errorSummary = 'Lab: lost one'; fields.registry[0].candidateCount = 0; },
    (fields) => { fields.registry[0].sourceId = 'x:wrong'; },
    (fields) => { fields.candidates[0].channel = 'x'; },
  ]) {
    const fields = validFields();
    mutation(fields);
    assert.equal(validate({ schemaVersion: '1.0', ...fields }).valid, false);
  }
});

test('returns validation errors rather than throwing for malformed collection fields', () => {
  for (const [field, value] of [
    ['registry', {}],
    ['registry', 'bad'],
    ['registry', [null]],
    ['candidates', {}],
    ['candidates', 'bad'],
    ['candidates', [null]],
  ]) {
    const feed = { schemaVersion: '1.0', ...validFields(), [field]: value };
    assert.doesNotThrow(() => validate(feed));
    assert.equal(validate(feed).valid, false);
  }
});

test('recomputes canonical identity and content hashes and enforces Unicode character limits', () => {
  for (const mutation of [
    (candidate) => { candidate.canonicalUrl = 'https://example.com/post/?utm_source=feed#top'; },
    (candidate) => { candidate.candidateId = 'a'.repeat(64); },
    (candidate) => { candidate.contentFingerprint = 'b'.repeat(64); },
  ]) {
    const fields = validFields();
    mutation(fields.candidates[0]);
    assert.equal(validate({ schemaVersion: '1.0', ...fields }).valid, false);
  }
});

test('accepts exact character limits and rejects one extra astral code point', () => {
  for (const { channel, sourceId, sourceName, limit } of [
    { channel: 'blogs', sourceId: 'blog:lab', sourceName: 'Lab', limit: 24_000 },
    { channel: 'podcasts', sourceId: 'podcast:show', sourceName: 'Show', limit: 80_000 },
  ]) {
    const registry = [{ id: sourceId, channel, name: sourceName }];
    const fields = validFields();
    fields.registry = [{ sourceId, channel, sourceName, status: 'ok', candidateCount: 1 }];
    const candidate = fields.candidates[0];
    candidate.channel = channel;
    candidate.sourceId = sourceId;
    candidate.summarizationContent = '😀'.repeat(limit);
    candidate.candidateId = createCandidateId(candidate);
    candidate.contentFingerprint = createContentFingerprint(candidate);
    assert.equal(validate({ schemaVersion: '1.0', ...fields }, registry).valid, true);

    candidate.summarizationContent += '😀';
    candidate.contentFingerprint = createContentFingerprint(candidate);
    const result = validate({ schemaVersion: '1.0', ...fields }, registry);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => (
      error.includes('/candidates/0/summarizationContent')
        && (error.includes('characters') || error.includes('more than'))
    )));
  }
});

test('enforces feed and candidate timestamp ordering invariants', () => {
  for (const [message, mutation] of [
    ['initializedAt', (fields) => { fields.initializedAt = '2026-09-07T00:00:00.000Z'; }],
    ['continuousHistorySince', (fields) => { fields.continuousHistorySince = '2026-09-07T00:00:00.000Z'; }],
    ['firstSeenAt', (fields) => { fields.candidates[0].firstSeenAt = '2026-09-06T02:00:00.000Z'; }],
    ['lastSeenAt', (fields) => { fields.candidates[0].lastSeenAt = '2026-09-06T02:00:00.000Z'; }],
  ]) {
    const fields = validFields();
    mutation(fields);
    const result = validate({ schemaVersion: '1.0', ...fields });
    assert.equal(result.valid, false, message);
    assert.ok(result.errors.some((error) => error.includes(message)), message);
  }
});

test('truncation first-seen ranges are paired, source-complete, and ordered', () => {
  const fields = validFields();
  fields.historyTruncated = true;
  fields.truncation = {
    affectedSourceIds: ['blog:lab'],
    oldestRetainedAt: '2026-09-05T00:00:00.000Z',
    oldestRemovedFirstSeenAtBySource: { 'blog:lab': '2026-09-04T00:00:00.000Z' },
    newestRemovedFirstSeenAtBySource: { 'blog:lab': '2026-09-05T00:00:00.000Z' },
    removedCount: 1,
  };
  assert.equal(validate({ schemaVersion: '1.0', ...fields }).valid, true);

  delete fields.truncation.newestRemovedFirstSeenAtBySource['blog:lab'];
  assert.equal(validate({ schemaVersion: '1.0', ...fields }).valid, false);

  fields.truncation.newestRemovedFirstSeenAtBySource['blog:lab'] = '2026-09-03T00:00:00.000Z';
  assert.equal(validate({ schemaVersion: '1.0', ...fields }).valid, false);
});

test('requires exactly one status for every configured source', () => {
  const configured = [
    { id: 'blog:lab', channel: 'blogs', name: 'Renamed Lab' },
    { id: 'blog:second', channel: 'blogs', name: 'Second Blog' },
  ];
  const missing = validFields();
  missing.registry[0].status = 'no-results';
  missing.registry[0].candidateCount = 0;
  missing.candidates = [];
  const missingResult = validate({ schemaVersion: '1.0', ...missing }, configured);
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.errors.some((error) => error.includes('blog:second')));

  const extra = validFields();
  extra.registry.push({
    sourceId: 'blog:extra', channel: 'blogs', sourceName: 'Extra',
    status: 'no-results', candidateCount: 0,
  });
  const extraResult = validate({ schemaVersion: '1.0', ...extra }, expectedRegistry);
  assert.equal(extraResult.valid, false);
  assert.ok(extraResult.errors.some((error) => error.includes('blog:extra')));
  assert.equal(validateCandidateFeed({ schemaVersion: '1.0', ...validFields() }).valid, false);
});

test('structural validation permits missing expected statuses but rejects unknown or mismatched identities', () => {
  const configured = [
    ...expectedRegistry,
    { id: 'x:builder', channel: 'x', name: 'Builder' },
  ];
  const incomplete = { schemaVersion: '1.0', ...validFields() };
  assert.equal(validateCandidateFeedStructure(incomplete, { expectedRegistry: configured }).valid, true);
  assert.deepEqual(validateCandidateFeedCompleteness(incomplete, { expectedRegistry: configured }), {
    complete: false,
    missingSources: [{ sourceId: 'x:builder', channel: 'x', sourceName: 'Builder' }],
  });

  const unknown = structuredClone(incomplete);
  unknown.registry.push({
    sourceId: 'x:unknown', channel: 'x', sourceName: 'Unknown',
    status: 'no-results', candidateCount: 0,
  });
  assert.equal(validateCandidateFeedStructure(unknown, { expectedRegistry: configured }).valid, false);

  const mismatched = structuredClone(incomplete);
  mismatched.registry[0].channel = 'x';
  assert.equal(validateCandidateFeedStructure(mismatched, { expectedRegistry: configured }).valid, false);
});

test('structural validation recomputes exact candidate counts for every source status', () => {
  for (const [status, candidateCount] of [
    ['ok', 0],
    ['no-results', 1],
  ]) {
    const fields = validFields();
    fields.registry[0] = { ...fields.registry[0], status, candidateCount };
    assert.equal(validateCandidateFeedStructure(
      { schemaVersion: '1.0', ...fields }, { expectedRegistry },
    ).valid, false, status);
  }
  const partialMismatch = validFields();
  partialMismatch.registry[0] = {
    ...partialMismatch.registry[0], status: 'partial', candidateCount: 0,
    errorSummary: 'One candidate may be incomplete.',
  };
  assert.equal(validateCandidateFeedStructure(
    { schemaVersion: '1.0', ...partialMismatch }, { expectedRegistry },
  ).valid, false);
});
