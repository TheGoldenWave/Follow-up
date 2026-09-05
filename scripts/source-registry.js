import { readFile } from 'node:fs/promises';

const CONFIG_URLS = {
  defaultSources: new URL('../config/default-sources.json', import.meta.url),
  blogs: new URL('../config/feed-blogs.json', import.meta.url),
  newsletters: new URL('../config/feed-newsletters.json', import.meta.url),
  academic: new URL('../config/feed-academic.json', import.meta.url),
  zhTech: new URL('../config/feed-zh-tech.json', import.meta.url),
};

const SOURCE_GROUPS = [
  ['x', 'x', (configs) => configs.defaultSources?.x_accounts],
  ['podcasts', 'podcast', (configs) => configs.defaultSources?.podcasts],
  ['blogs', 'blog', (configs) => configs.blogs?.sources],
  ['newsletters', 'newsletter', (configs) => configs.newsletters?.sources],
  ['academic', 'academic', (configs) => configs.academic?.sources],
  ['zh-tech', 'zh-tech', (configs) => configs.zhTech?.sources],
];

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;

export function createSourceRegistry(configs) {
  const registry = [];
  const seen = new Set();

  for (const [channel, namespace, selectSources] of SOURCE_GROUPS) {
    const sources = selectSources(configs);
    if (!Array.isArray(sources)) {
      throw new Error(`${channel} sources must be an array`);
    }
    for (const source of sources) {
      if (typeof source?.id !== 'string' || !ID_PATTERN.test(source.id)) {
        throw new Error(`${channel} source ${source?.name ?? '<unnamed>'} requires an explicit namespaced id`);
      }
      if (!source.id.startsWith(`${namespace}:`)) {
        throw new Error(`${source.id} must use the ${namespace}: namespace`);
      }
      if (seen.has(source.id)) {
        throw new Error(`Duplicate source id: ${source.id}`);
      }
      seen.add(source.id);
      registry.push(Object.freeze({ ...source, channel }));
    }
  }

  return Object.freeze(registry);
}

export async function loadSourceRegistry({ readFileImpl = readFile } = {}) {
  const entries = await Promise.all(Object.entries(CONFIG_URLS).map(async ([key, url]) => [
    key,
    JSON.parse(await readFileImpl(url, 'utf8')),
  ]));
  return createSourceRegistry(Object.fromEntries(entries));
}
