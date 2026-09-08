import { createHash } from 'node:crypto';

const TRACKING_PARAMETER = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|vero_id|_hsenc|_hsmi)$/i;

function requireField(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

export function canonicalizeUrl(value, baseUrl) {
  if (typeof value !== 'string' || value.trim() === '') return null;

  let url;
  try {
    url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;

  url.hash = '';
  for (const parameter of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(parameter)) url.searchParams.delete(parameter);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');

  return url.href;
}

export function frameFields(fields) {
  if (!Array.isArray(fields)) throw new TypeError('fields must be an array');

  const chunks = [];
  for (const [index, field] of fields.entries()) {
    if (typeof field !== 'string') throw new TypeError(`fields[${index}] must be a string`);
    const bytes = Buffer.from(field, 'utf8');
    chunks.push(Buffer.from(`${bytes.length}:`, 'ascii'), bytes);
  }
  return Buffer.concat(chunks);
}

function sha256(fields) {
  return createHash('sha256').update(frameFields(fields)).digest('hex');
}

export function createCandidateId({ channel, sourceId, sourceNativeId, canonicalUrl }) {
  const identity = typeof sourceNativeId === 'string' && sourceNativeId.length > 0
    ? sourceNativeId
    : canonicalizeUrl(canonicalUrl);
  if (!identity) throw new TypeError('candidate identity requires a sourceNativeId or canonical HTTP(S) URL');

  return sha256([
    'candidate-v1',
    requireField(channel, 'channel'),
    requireField(sourceId, 'sourceId'),
    identity,
  ]);
}

export function normalizeFingerprintText(value) {
  if (typeof value !== 'string') throw new TypeError('fingerprint text must be a string');
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function createContentFingerprint({ title, summarizationContent }) {
  return sha256([
    'content-v1',
    normalizeFingerprintText(title),
    normalizeFingerprintText(summarizationContent),
  ]);
}
