import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateCurationRequest,
  validateDigestSelection,
} from '../digest-selection-contract.js';

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
});

test('semantic evaluation fixture labels official-lead and no-interests cases as review material', async () => {
  const evaluation = await fixture('curation/semantic-evaluation.json');
  assert.equal(evaluation.fixtureType, 'semantic-evaluation-only');
  assert.ok(evaluation.cases.some(({ expectedReview }) => expectedReview.preferredLead));
  assert.ok(evaluation.cases.some(({ interestsPresent }) => interestsPresent === false));
});
