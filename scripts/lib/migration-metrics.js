import { canonicalizeUrl } from '../candidate-identity.js';

export function duplicateRate(items, source) {
  const natives = new Set();
  const urls = new Set();
  let duplicates = 0;
  for (const item of items) {
    const raw = item.candidate_id;
    const native = typeof raw === 'string' && raw.startsWith(`${source}:`) ? raw.slice(source.length + 1) : raw;
    const url = canonicalizeUrl(item.url);
    if ((native && natives.has(native)) || (url && urls.has(url))) duplicates += 1;
    if (native) natives.add(native);
    if (url) urls.add(url);
  }
  return items.length ? duplicates / items.length : 0;
}
