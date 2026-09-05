import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  canonicalizeUrl,
  createCandidateId,
  createContentFingerprint,
  frameFields,
  normalizeFingerprintText,
} from '../candidate-identity.js';

test('canonicalizeUrl removes transport noise and sorts semantic query parameters', () => {
  const variants = [
    'https://Example.COM:443/posts/one/?b=2&utm_source=email&a=1#section',
    'https://example.com/posts/one?a=1&b=2',
  ];

  assert.equal(canonicalizeUrl(variants[0]), 'https://example.com/posts/one?a=1&b=2');
  assert.equal(canonicalizeUrl(variants[0]), canonicalizeUrl(variants[1]));
  assert.equal(
    canonicalizeUrl('http://example.com:80/?gclid=secret'),
    'http://example.com/',
  );
  assert.equal(canonicalizeUrl('ftp://example.com/file'), null);
  assert.equal(canonicalizeUrl('not a URL'), null);
});

test('frameFields uses unambiguous UTF-8 byte lengths in documented order', () => {
  assert.equal(frameFields(['a', 'bc']).toString('utf8'), '1:a2:bc');
  assert.equal(frameFields(['你', 'a']).toString('utf8'), '3:你1:a');
  assert.notDeepEqual(frameFields(['ab', 'c']), frameFields(['a', 'bc']));
});

test('candidate IDs use native identity when present and canonical URL otherwise', () => {
  const nativeExpected = createHash('sha256')
    .update(frameFields(['candidate-v1', 'x', 'x:karpathy', '42']))
    .digest('hex');
  assert.equal(createCandidateId({
    channel: 'x',
    sourceId: 'x:karpathy',
    sourceNativeId: '42',
    canonicalUrl: 'https://x.com/karpathy/status/42',
  }), nativeExpected);

  assert.equal(
    createCandidateId({
      channel: 'blogs',
      sourceId: 'blog:example',
      canonicalUrl: 'https://example.com/post/?utm_medium=rss#top',
    }),
    createCandidateId({
      channel: 'blogs',
      sourceId: 'blog:example',
      canonicalUrl: 'https://example.com/post',
    }),
  );
});

test('content fingerprints normalize Unicode, case, and whitespace without boundary collisions', () => {
  assert.equal(normalizeFingerprintText('  CAFE\u0301\n Launch  '), 'café launch');
  assert.equal(
    createContentFingerprint({ title: ' CAFE\u0301 ', summarizationContent: 'New\n\tMODEL' }),
    createContentFingerprint({ title: 'café', summarizationContent: 'new model' }),
  );
  assert.notEqual(
    createContentFingerprint({ title: 'ab', summarizationContent: 'c' }),
    createContentFingerprint({ title: 'a', summarizationContent: 'bc' }),
  );
});
