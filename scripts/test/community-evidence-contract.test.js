import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMUNITY_EVIDENCE_MAX_BYTES,
  validateCommunityEvidence,
} from '../community-evidence-contract.js';

function validEvidence() {
  return {
    role: 'community-discovery',
    views: [{
      kind: 'daily',
      pageUrl: 'https://huggingface.co/papers/date/2026-09-16',
      rank: 1,
      upvotes: 42,
    }],
    github: { url: 'https://github.com/example/project', stars: 1200 },
  };
}

test('accepts bounded community discovery evidence', () => {
  assert.equal(COMMUNITY_EVIDENCE_MAX_BYTES, 4096);
  assert.deepEqual(validateCommunityEvidence(validEvidence()), { valid: true, errors: [] });
});

test('rejects unrecognized fields, duplicated views, invalid metrics, and non-GitHub URLs', () => {
  for (const mutate of [
    (value) => { value.untrusted = true; },
    (value) => { value.views.push({ ...value.views[0] }); },
    (value) => { value.views[0].rank = 0; },
    (value) => { value.views[0].upvotes = 1.5; },
    (value) => { value.github.url = 'https://example.com/project'; },
  ]) {
    const value = validEvidence();
    mutate(value);
    assert.equal(validateCommunityEvidence(value).valid, false);
  }
});

test('uses UTF-8 bytes, not UTF-16 length, for the hard evidence limit', () => {
  const value = validEvidence();
  value.views[0].pageUrl = `https://huggingface.co/${'a'.repeat(4000)}`;
  assert.equal(validateCommunityEvidence(value).valid, false);
});
