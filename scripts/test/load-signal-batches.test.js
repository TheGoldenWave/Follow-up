import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveSourceNativeId,
  mapSignalBatch,
  mapSignalBatchItem,
  mapSignalBatchSourceStatus,
  loadSignalBatches,
} from '../lib/load-signal-batches.js';

const SEEN_AT = '2026-09-08T01:00:00.000Z';

const source = {
  id: 'blog:test', name: 'Test Blog', channel: 'blogs', channel_policy: 'fixed',
};

const item = {
  candidate_id: 'blog:test:123',
  source: 'blog:test',
  source_type: 'blogs',
  url: 'https://example.com/post?utm_source=x#frag',
  author: 'Author Name',
  published_at: '2026-09-08T00:00:00.000Z',
  date_confidence: 'exact',
  title: 'A title',
  text: 'Body text',
  fetched_at: '2026-09-08T01:00:00.000Z',
};

function batch(overrides = {}) {
  return {
    schema_version: '1.0',
    batch_id: 'b1',
    generated_at: SEEN_AT,
    adapter_id: 'rss',
    adapter_version: '0.3.0',
    source: 'blog:test',
    request: { mode: 'shadow' },
    source_status: { status: 'ok', retryable: false },
    items: [item],
    ...overrides,
  };
}

test('deriveSourceNativeId strips the source prefix', () => {
  assert.equal(deriveSourceNativeId('blog:test:123', 'blog:test'), '123');
  assert.equal(deriveSourceNativeId('x:a', 'x'), 'a');
  assert.equal(deriveSourceNativeId('raw', 'blog:test'), 'raw');
});

test('mapSignalBatchItem maps snake_case to a camelCase candidate', () => {
  const candidate = mapSignalBatchItem(item, { source, channel: 'blogs', seenAt: SEEN_AT });
  assert.equal(candidate.sourceId, 'blog:test');
  assert.equal(candidate.channel, 'blogs');
  assert.equal(candidate.sourceNativeId, '123');
  assert.equal(candidate.canonicalUrl, 'https://example.com/post');
  assert.equal(candidate.title, 'A title');
  assert.equal(candidate.author, 'Author Name');
  assert.equal(candidate.publishedAt, '2026-09-08T00:00:00.000Z');
  assert.equal(candidate.summarizationContent, 'Body text');
  assert.ok(candidate.candidateId);
  assert.ok(candidate.contentFingerprint);
});

test('mapSignalBatchItem falls back to title when text is missing', () => {
  const candidate = mapSignalBatchItem(
    { ...item, text: null },
    { source, channel: 'blogs', seenAt: SEEN_AT },
  );
  assert.equal(candidate.summarizationContent, 'A title');
});

test('mapSignalBatchSourceStatus maps ok with zero items to no-results', () => {
  const status = mapSignalBatchSourceStatus(batch({ items: [] }), { source, channel: 'blogs' });
  assert.equal(status.status, 'no-results');
  assert.equal(status.sourceId, 'blog:test');
});

test('mapSignalBatchSourceStatus maps failures to error with a summary', () => {
  const status = mapSignalBatchSourceStatus(
    batch({ source_status: { status: 'unreachable', code: 'E1', message: 'down', retryable: true }, items: [] }),
    { source, channel: 'blogs' },
  );
  assert.equal(status.status, 'error');
  assert.ok(status.errorSummary.includes('unreachable'));
});

test('mapSignalBatch routes the channel and maps candidates', () => {
  const mapped = mapSignalBatch(batch(), {
    sourceIndex: new Map([['blog:test', source]]), seenAt: SEEN_AT,
  });
  assert.equal(mapped.channel, 'blogs');
  assert.equal(mapped.candidates.length, 1);
  assert.equal(mapped.candidates[0].sourceId, 'blog:test');
  assert.equal(mapped.sourceStatus.status, 'ok');
});

test('mapSignalBatch throws when the source is unknown', () => {
  assert.throws(
    () => mapSignalBatch(batch(), { sourceIndex: new Map(), seenAt: SEEN_AT }),
    /No source registry entry/,
  );
});

test('loadSignalBatches aggregates candidates and statuses across batches', () => {
  const second = source;
  const result = loadSignalBatches([batch()], { sources: [source, second], seenAt: SEEN_AT });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.sourceStatuses.length, 1);
  assert.equal(result.sourceStatuses[0].sourceId, 'blog:test');
});
