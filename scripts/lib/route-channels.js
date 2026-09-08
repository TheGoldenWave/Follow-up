// Channel routing for acquisition candidates. Fixed sources map to their
// declared channel; core-topic sources (Reddit, Digg) map to one or more of the
// existing seven channels and never create platform-named channels.

export const SEVEN_CHANNELS = Object.freeze([
  'x', 'podcasts', 'blogs', 'newsletters', 'academic', 'zh-tech',
]);

// Unclassified core-topic candidates land in the review queue, not a new channel.
export const REVIEW_CHANNEL = 'review';

// Topic keyword → target channels, ordered by specificity. Core-topic sources
// (Reddit/Digg) land here in later versions; v0.3.0 has none.
const CORE_TOPIC_RULES = Object.freeze([
  [/academic|paper|research|arxiv|llm|model|training/i, ['academic', 'blogs']],
  [/startup|venture|funding|saas|business/i, ['blogs', 'newsletters']],
  [/video|podcast|audio|youtube/i, ['podcasts']],
  [/china|chinese|中文|科技|模型|大模型/i, ['zh-tech']],
]);

export function routeCoreTopicChannels(source) {
  const topic = String(source?.input?.topic ?? source?.input?.query ?? source?.name ?? '');
  const matched = [];
  for (const [pattern, channels] of CORE_TOPIC_RULES) {
    if (pattern.test(topic)) {
      for (const channel of channels) {
        if (!matched.includes(channel)) matched.push(channel);
      }
    }
  }
  return matched.length > 0 ? matched : [REVIEW_CHANNEL];
}

export function routeSourceChannel(source) {
  const policy = source?.channel_policy ?? 'fixed';
  if (policy === 'fixed') {
    const channel = source.channel;
    if (!SEVEN_CHANNELS.includes(channel)) {
      throw new Error(`Source ${source.id} has unknown fixed channel "${channel}"`);
    }
    return channel;
  }
  if (policy === 'core-topic') {
    return routeCoreTopicChannels(source)[0];
  }
  throw new Error(`Source ${source.id} has unknown channel_policy "${policy}"`);
}
