import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSourceStatus,
  summarizeChannelCompleteness,
} from '../source-status.js';

test('creates the four source states from collection facts', () => {
  assert.equal(createSourceStatus({
    sourceId: 'blog:ok', channel: 'blogs', sourceName: 'OK', candidateCount: 2,
  }).status, 'ok');
  assert.equal(createSourceStatus({
    sourceId: 'blog:none', channel: 'blogs', sourceName: 'None', candidateCount: 0,
  }).status, 'no-results');
  assert.equal(createSourceStatus({
    sourceId: 'blog:partial', channel: 'blogs', sourceName: 'Partial',
    candidateCount: 1, failedCandidateCount: 1, errors: ['article extraction failed'],
  }).status, 'partial');
  assert.equal(createSourceStatus({
    sourceId: 'blog:error', channel: 'blogs', sourceName: 'Error',
    candidateCount: 0, errors: ['discovery failed'],
  }).status, 'error');
});

test('an equivalent successful fallback remains ok with a warning', () => {
  const status = createSourceStatus({
    sourceId: 'blog:fallback', channel: 'blogs', sourceName: 'Fallback', candidateCount: 1,
    warnings: ['preferred RSS failed'], equivalentFallbackSucceeded: true,
  });

  assert.equal(status.status, 'ok');
  assert.deepEqual(status.warnings, ['preferred RSS failed']);
});

test('partial and error diagnostics name the source but redact secrets and personal data', () => {
  const status = createSourceStatus({
    sourceId: 'newsletter:private', channel: 'newsletters', sourceName: 'Private Letter',
    candidateCount: 0,
    errors: [
      'GET https://api.example.test/feed?token=abc123&topic=ai failed for person@example.com',
      'Authorization: Bearer auth-secret client_secret=client-secret refresh_token=refresh-secret',
      'request failed\nCookie: sid=first-secret; csrf=second-secret\nretry stopped',
      'response failed\r\nSet-Cookie: sid=set-secret; HttpOnly\r\nretry stopped',
      'cookie=session-secret at (/Users/alice/private/feed.json)',
      'AWS_SECRET_ACCESS_KEY="very secret aws value"',
      "api key='quoted api secret value'",
      'client-secret: client secret with spaces',
      'password = unquoted password with spaces',
      'OPENAI_API_KEY="openai secret with spaces"',
      "GITHUB_TOKEN='github secret value'",
      'service-secret_key=generic underscore secret',
      'service secret-key: generic hyphen secret',
      'request failed: OPENAI_API_KEY="embedded secret value"',
      'details (GITHUB_TOKEN=parenthesized secret)',
      'foo=public, OPENAI_API_KEY=comma secret value',
    ],
  });
  const serialized = JSON.stringify(status);

  assert.equal(status.status, 'error');
  assert.match(serialized, /Private Letter/);
  assert.doesNotMatch(serialized, /abc123|person@example\.com|auth-secret|client-secret|refresh-secret|first-secret|second-secret|set-secret|session-secret|very secret aws value|quoted api secret value|client secret with spaces|unquoted password with spaces|openai secret with spaces|github secret value|generic underscore secret|generic hyphen secret|embedded secret value|parenthesized secret|comma secret value|\/Users\/alice/);
  assert.match(serialized, /\[REDACTED\]/);
});

test('summarizes completeness per channel and identifies incomplete sources', () => {
  const statuses = [
    createSourceStatus({ sourceId: 'x:a', channel: 'x', sourceName: 'A', candidateCount: 1 }),
    createSourceStatus({ sourceId: 'x:b', channel: 'x', sourceName: 'B', candidateCount: 0 }),
    createSourceStatus({ sourceId: 'blog:a', channel: 'blogs', sourceName: 'Blog A', candidateCount: 1,
      failedCandidateCount: 1, errors: ['one article failed'] }),
  ];

  const expectedRegistry = [
    { id: 'x:a', channel: 'x' },
    { id: 'x:b', channel: 'x' },
    { id: 'blog:a', channel: 'blogs' },
  ];
  assert.deepEqual(summarizeChannelCompleteness(statuses, expectedRegistry), [
    { channel: 'x', complete: true, sourceCount: 2, incompleteSourceIds: [] },
    { channel: 'blogs', complete: false, sourceCount: 1, incompleteSourceIds: ['blog:a'] },
  ]);
});

test('missing configured source status makes its channel incomplete', () => {
  const statuses = [createSourceStatus({
    sourceId: 'newsletter:a', channel: 'newsletters', sourceName: 'A', candidateCount: 0,
  })];
  const expectedRegistry = [
    { id: 'newsletter:a', channel: 'newsletters' },
    { id: 'newsletter:b', channel: 'newsletters' },
  ];

  assert.deepEqual(summarizeChannelCompleteness(statuses, expectedRegistry), [{
    channel: 'newsletters',
    complete: false,
    sourceCount: 2,
    incompleteSourceIds: ['newsletter:b'],
  }]);
});

test('rejects malformed, unknown-channel, mismatched, and duplicate expected sources', () => {
  for (const expectedRegistry of [
    ['x:a'],
    [{ id: 'x:a', channel: 'bogus' }],
    [{ id: 'blog:a', channel: 'x' }],
    [{ id: 'x:a', channel: 'x' }, { id: 'x:a', channel: 'x' }],
  ]) {
    assert.throws(
      () => summarizeChannelCompleteness([], expectedRegistry),
      /expectedRegistry|channel|namespace|duplicate/i,
    );
  }
});
