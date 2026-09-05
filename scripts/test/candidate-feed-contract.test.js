import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANDIDATE_FEED_SCHEMA_VERSION,
  createCandidateFeed,
  validateCandidateFeed,
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

test('creates and validates a strict candidate Feed v1.0 envelope', () => {
  const feed = createCandidateFeed(validFields());

  assert.equal(feed.schemaVersion, CANDIDATE_FEED_SCHEMA_VERSION);
  assert.equal(validateCandidateFeed(feed).valid, true);
  assert.equal(CANDIDATE_FEED_SCHEMA_VERSION, '1.0');
});

test('requires initialization, history, retention, diagnostics, registry statuses, and candidates', () => {
  for (const key of [
    'generatedAt', 'initializedAt', 'continuousHistorySince', 'retention',
    'historyTruncated', 'truncation', 'registry', 'candidates',
  ]) {
    const fields = validFields();
    delete fields[key];
    const result = validateCandidateFeed({ schemaVersion: '1.0', ...fields });
    assert.equal(result.valid, false, key);
    assert.ok(result.errors.some((error) => error.includes(key)), key);
  }
});

test('rejects unknown fields and invalid or non-strict dates', () => {
  const feed = { schemaVersion: '1.0', ...validFields(), unexpected: true };
  assert.equal(validateCandidateFeed(feed).valid, false);

  for (const generatedAt of ['2026-09-06', '2026-02-30T00:00:00Z', 'not-a-date']) {
    const result = validateCandidateFeed({ ...feed, unexpected: undefined, generatedAt });
    assert.equal(result.valid, false, generatedAt);
  }
});

test('registry contains one current status per source and candidate objects are closed', () => {
  const duplicate = validFields();
  duplicate.registry.push({ ...duplicate.registry[0], status: 'no-results', candidateCount: 0 });
  assert.equal(validateCandidateFeed({ schemaVersion: '1.0', ...duplicate }).valid, false);

  const extraCandidateField = validFields();
  extraCandidateField.candidates[0].secret = 'must not pass';
  assert.equal(validateCandidateFeed({ schemaVersion: '1.0', ...extraCandidateField }).valid, false);
});

test('validation errors are actionable without echoing secret values', () => {
  const fields = validFields();
  fields.candidates[0].canonicalUrl = 'https://example.com/?token=super-secret';
  fields.candidates[0].channel = 'unknown';
  const result = validateCandidateFeed({ schemaVersion: '1.0', ...fields });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('/candidates/0/channel')));
  assert.doesNotMatch(result.errors.join(' '), /super-secret/);
  assert.throws(() => createCandidateFeed({ ...fields, password: 'also-secret' }), (error) => (
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
    assert.equal(validateCandidateFeed({ schemaVersion: '1.0', ...fields }).valid, false);
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
    assert.doesNotThrow(() => validateCandidateFeed(feed));
    assert.equal(validateCandidateFeed(feed).valid, false);
  }
});

test('recomputes canonical identity and content hashes and enforces UTF-8 byte limits', () => {
  for (const mutation of [
    (candidate) => { candidate.canonicalUrl = 'https://example.com/post/?utm_source=feed#top'; },
    (candidate) => { candidate.candidateId = 'a'.repeat(64); },
    (candidate) => { candidate.contentFingerprint = 'b'.repeat(64); },
    (candidate) => { candidate.summarizationContent = `${'a'.repeat(23_999)}😀`; candidate.contentTruncated = false; },
  ]) {
    const fields = validFields();
    mutation(fields.candidates[0]);
    assert.equal(validateCandidateFeed({ schemaVersion: '1.0', ...fields }).valid, false);
  }
});
