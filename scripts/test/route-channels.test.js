import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEVEN_CHANNELS,
  REVIEW_CHANNEL,
  routeCoreTopicChannels,
  routeSourceChannel,
} from '../lib/route-channels.js';

function source(id, channel, channelPolicy = 'fixed', input = {}) {
  return { id, channel, channel_policy: channelPolicy, input };
}

test('fixed sources route to their declared channel', () => {
  assert.equal(routeSourceChannel(source('blog:a', 'blogs')), 'blogs');
  assert.equal(routeSourceChannel(source('zh-tech:a', 'zh-tech')), 'zh-tech');
});

test('fixed routing rejects a channel outside the seven', () => {
  assert.throws(
    () => routeSourceChannel(source('report:a', 'reports')),
    /unknown fixed channel/,
  );
});

test('core-topic routes academic keywords to academic and blogs', () => {
  const channels = routeCoreTopicChannels(
    source('digg:a', 'reports', 'core-topic', { topic: 'AI research papers and models' }),
  );
  assert.deepEqual(channels, ['academic', 'blogs']);
});

test('core-topic routes Chinese keywords to zh-tech', () => {
  const channels = routeCoreTopicChannels(
    source('digg:b', 'reports', 'core-topic', { topic: '中国大模型科技新闻' }),
  );
  assert.deepEqual(channels, ['zh-tech']);
});

test('core-topic falls back to the review queue when nothing matches', () => {
  assert.equal(routeSourceChannel(source('digg:c', 'reports', 'core-topic', { topic: 'miscellaneous' })), REVIEW_CHANNEL);
  assert.deepEqual(routeCoreTopicChannels(source('digg:c', 'reports', 'core-topic', {})), [REVIEW_CHANNEL]);
});

test('unknown channel_policy throws', () => {
  assert.throws(() => routeSourceChannel(source('blog:a', 'blogs', 'bogus')), /unknown channel_policy/);
});

test('the seven channels are the canonical fixed set', () => {
  assert.deepEqual(SEVEN_CHANNELS, ['x', 'podcasts', 'blogs', 'newsletters', 'academic', 'zh-tech']);
});
