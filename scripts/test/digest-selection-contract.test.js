import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CURATION_CANDIDATE_LIMIT,
  CURATION_SUMMARY_CHARACTER_LIMIT,
  createRequestHash,
  validateCurationRequest,
  validateDigestSelection,
} from '../digest-selection-contract.js';
import {
  INPUT_BYTE_LIMITS,
  TRANSPORT_SCHEMA_MAX_BYTES,
  readJsonLimited,
} from '../validate-digest-selection.js';

const fixtures = new URL('./fixtures/', import.meta.url);

async function fixture(path) {
  return JSON.parse(await readFile(new URL(path, fixtures), 'utf8'));
}

test('curation request v1.0 is closed and records coverage, candidates, source completeness, and fixed rules', async () => {
  const request = await fixture('curation/valid-request.json');
  assert.deepEqual(validateCurationRequest(request), { valid: true, errors: [] });
  assert.equal(validateCurationRequest({ ...request, remoteInterests: true }).valid, false);
  assert.equal(validateCurationRequest({ ...request, digestId: 'digest-1' }).valid, false);
  assert.equal(validateCurationRequest({ ...request, selectionRules: {
    ...request.selectionRules, qualificationThreshold: 59,
  } }).valid, false);
});

test('curation request source completeness and candidate source coverage are internally consistent', async () => {
  const request = await fixture('curation/valid-request.json');
  const wrongExpectedCount = structuredClone(request);
  wrongExpectedCount.sourceCompleteness.expectedSourceCount = 3;
  assert.equal(validateCurationRequest(wrongExpectedCount).valid, false);

  const missingSourceStatus = structuredClone(request);
  missingSourceStatus.sourceStatuses.pop();
  missingSourceStatus.sourceCompleteness.reportedSourceCount = 1;
  missingSourceStatus.sourceCompleteness.expectedSourceCount = 1;
  assert.equal(validateCurationRequest(missingSourceStatus).valid, false);

  const unexplainedCompleteCoverage = structuredClone(request);
  unexplainedCompleteCoverage.coverage.reasons = ['history-truncated'];
  assert.equal(validateCurationRequest(unexplainedCompleteCoverage).valid, false);
});

test('request requires bound content stats, exact source aggregates, and consistent coverage', async () => {
  const request = await fixture('curation/valid-request.json');
  const missingStats = structuredClone(request);
  delete missingStats.contentStats;
  assert.equal(validateCurationRequest(missingStats).valid, false);

  const wrongAggregate = structuredClone(request);
  wrongAggregate.sourceCompleteness.okSourceCount -= 1;
  assert.equal(validateCurationRequest(wrongAggregate).valid, false);

  const shiftedMissing = structuredClone(request);
  shiftedMissing.sourceCompleteness.complete = false;
  shiftedMissing.sourceCompleteness.status = 'incomplete';
  shiftedMissing.sourceCompleteness.reportedSourceCount = 1;
  shiftedMissing.sourceCompleteness.errorSourceCount = 0;
  shiftedMissing.sourceCompleteness.missingSourceCount = 1;
  shiftedMissing.sourceStatuses[0] = {
    ...shiftedMissing.sourceStatuses[0], status: 'error', candidateCount: 0,
    errorSummary: 'A real collection error.',
  };
  shiftedMissing.sourceCompleteness.okSourceCount = 1;
  shiftedMissing.requestHash = createRequestHash(shiftedMissing);
  assert.equal(validateCurationRequest(shiftedMissing).valid, false);

  const wrongCoverage = structuredClone(request);
  wrongCoverage.coverage.actualInterval.start = '2026-09-02T00:00:00.000Z';
  assert.equal(validateCurationRequest(wrongCoverage).valid, false);

  const wrongHash = structuredClone(request);
  wrongHash.requestHash = 'f'.repeat(64);
  assert.notEqual(wrongHash.requestHash, createRequestHash(wrongHash));
  assert.equal(validateCurationRequest(wrongHash).valid, false);
});

test('selection manifest is cryptographically bound to its exact request', async () => {
  const request = await fixture('curation/valid-request.json');
  const selection = await fixture('selections/valid-selection.json');
  assert.equal(selection.requestHash, request.requestHash);
  const rebound = structuredClone(selection);
  rebound.requestHash = 'f'.repeat(64);
  assert.equal(validateDigestSelection(rebound).valid, true);
});

test('selection manifest v1.0 is closed and bounds every integer score and selection reason', async () => {
  const selection = await fixture('selections/valid-selection.json');
  assert.deepEqual(validateDigestSelection(selection), { valid: true, errors: [] });

  const badScore = structuredClone(selection);
  badScore.clusters[0].scores.impact = 31;
  assert.equal(validateDigestSelection(badScore).valid, false);

  const fractional = structuredClone(selection);
  fractional.clusters[0].scores.relevance = 20.5;
  assert.equal(validateDigestSelection(fractional).valid, false);

  const verbose = structuredClone(selection);
  verbose.clusters[0].selectionReason = 'x'.repeat(281);
  assert.equal(validateDigestSelection(verbose).valid, false);

  assert.equal(validateDigestSelection({ ...selection, hidden: true }).valid, false);

  const tooManyCorroborating = structuredClone(selection);
  tooManyCorroborating.clusters[0].corroboratingCandidateIds = Array.from(
    { length: 1000 }, (_, index) => index.toString(16).padStart(64, '0'),
  );
  assert.equal(validateDigestSelection(tooManyCorroborating).valid, false);
});

test('semantic evaluation fixture labels official-lead and no-interests cases as review material', async () => {
  const evaluation = await fixture('curation/semantic-evaluation.json');
  assert.equal(evaluation.fixtureType, 'semantic-evaluation-only');
  assert.ok(evaluation.cases.some(({ expectedReview }) => expectedReview.preferredLead));
  assert.ok(evaluation.cases.some(({ interestsPresent }) => interestsPresent === false));
});

test('maximum candidate-count request with maximum curation summaries fits the transport byte limit', async (t) => {
  const base = await fixture('curation/valid-request.json');
  const summary = '😀'.repeat(CURATION_SUMMARY_CHARACTER_LIMIT);
  const candidates = Array.from({ length: CURATION_CANDIDATE_LIMIT }, (_, index) => ({
    ...base.eligibleCandidates[0],
    candidateId: index.toString(16).padStart(64, '0'),
    sourceNativeId: '😀'.repeat(512),
    canonicalUrl: `https://example.com/${'a'.repeat(2024)}${index.toString().padStart(4, '0')}`,
    title: '😀'.repeat(500),
    author: '😀'.repeat(200),
    contentFingerprint: (index + 1000).toString(16).padStart(64, '0'),
    summarizationContent: summary,
  }));
  const request = {
    ...base,
    eligibleCandidates: candidates,
    sourceStatuses: [{ ...base.sourceStatuses[0], candidateCount: 1000 }],
    sourceCompleteness: {
      status: 'complete', complete: true, feedFresh: true,
      expectedSourceCount: 1, reportedSourceCount: 1, totalSourceCount: 1,
      okSourceCount: 1, noResultsSourceCount: 0, partialSourceCount: 0,
      errorSourceCount: 0, missingSourceCount: 0,
    },
    contentStats: {
      candidateCount: 1000, eligibleCount: 1000, excludedCount: 0, selectedCount: 0,
    },
  };
  request.requestHash = createRequestHash(request);
  const serialized = `${JSON.stringify(request)}\n`;
  assert.deepEqual(validateCurationRequest(request), { valid: true, errors: [] });
  assert.ok(Buffer.byteLength(serialized) <= INPUT_BYTE_LIMITS.requestBytes);

  const root = await mkdtemp(join(tmpdir(), 'digest-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'request.json');
  await writeFile(path, serialized);
  assert.equal((await readJsonLimited(
    path, 'request', INPUT_BYTE_LIMITS.requestBytes,
  )).eligibleCandidates.length, 1000);
});

test('declared byte gates cover conservative worst-case bounded transport documents', () => {
  for (const field of ['requestBytes', 'selectionBytes', 'exclusionBytes']) {
    assert.ok(TRANSPORT_SCHEMA_MAX_BYTES[field] <= INPUT_BYTE_LIMITS[field], field);
  }
});

test('curation candidate fields exceeding the summary transport contract are rejected', async () => {
  const request = await fixture('curation/valid-request.json');
  request.eligibleCandidates[0].summarizationContent = 'x'.repeat(
    CURATION_SUMMARY_CHARACTER_LIMIT + 1,
  );
  assert.equal(validateCurationRequest(request).valid, false);
});
