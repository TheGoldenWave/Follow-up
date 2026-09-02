import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const FEED_SCHEMA_VERSION = '1.0';

const PAYLOAD_KEYS = {
  x: 'x',
  podcasts: 'podcasts',
  blogs: 'blogs',
  newsletters: 'newsletters',
  academic: 'papers',
  'zh-tech': 'articles',
};

const schema = JSON.parse(readFileSync(
  new URL('../contracts/central-feed.schema.json', import.meta.url),
  'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

function formatErrors(errors = []) {
  return errors.map(({ instancePath, message }) => (
    `${instancePath || '/'} ${message}`
  ));
}

export function validateFeed(feed, category) {
  const expectedPayload = PAYLOAD_KEYS[category];
  if (!expectedPayload) {
    return { valid: false, errors: [`Unknown feed category: ${category}`] };
  }

  const schemaValid = validateSchema(feed);
  const errors = schemaValid ? [] : formatErrors(validateSchema.errors);
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    return { valid: false, errors };
  }
  if (!Object.hasOwn(feed, expectedPayload)) {
    errors.push(`/${expectedPayload} is required for ${category}`);
  }

  for (const [otherCategory, payloadKey] of Object.entries(PAYLOAD_KEYS)) {
    if (otherCategory !== category && Object.hasOwn(feed, payloadKey)) {
      errors.push(`/${payloadKey} does not belong to ${category}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createFeedEnvelope(fields) {
  return { ...fields, schemaVersion: FEED_SCHEMA_VERSION };
}
