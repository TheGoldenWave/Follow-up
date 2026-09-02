import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const FEED_SCHEMA_VERSION = '1.0';
export const CENTRAL_FEED_FILES = [
  { category: 'x', filename: 'feed-x.json' },
  { category: 'podcasts', filename: 'feed-podcasts.json' },
  { category: 'blogs', filename: 'feed-blogs.json' },
  { category: 'newsletters', filename: 'feed-newsletters.json' },
  { category: 'academic', filename: 'feed-academic.json' },
  { category: 'zh-tech', filename: 'feed-zh-tech.json' },
];

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

export async function validateFeedFiles({
  readJson = async (filename) => JSON.parse(await readFile(
    new URL(`../${filename}`, import.meta.url),
    'utf8',
  )),
} = {}) {
  const errors = [];
  for (const { category, filename } of CENTRAL_FEED_FILES) {
    try {
      const result = validateFeed(await readJson(filename), category);
      errors.push(...result.errors.map((error) => `${filename}: ${error}`));
    } catch (error) {
      errors.push(`${filename}: ${error.message}`);
    }
  }
  return errors;
}

async function main() {
  const errors = await validateFeedFiles();
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log('All six central feeds are valid.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
