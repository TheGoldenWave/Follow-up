import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const ENABLED_CHANNELS = Object.freeze([
  'x',
  'podcasts',
  'blogs',
  'newsletters',
  'academic',
  'zh-tech',
]);

const schema = JSON.parse(readFileSync(
  new URL('../config/config-schema.json', import.meta.url),
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

export function validateConfig(config) {
  const valid = validateSchema(config);
  return {
    valid,
    errors: valid ? [] : formatErrors(validateSchema.errors),
  };
}

export function normalizeConfig(config) {
  const result = validateConfig(config);
  if (!result.valid) {
    throw new Error(`Invalid Follow-up configuration: ${result.errors.join('; ')}`);
  }
  return {
    ...config,
    enabledChannels: config.enabledChannels
      ? [...config.enabledChannels]
      : [...ENABLED_CHANNELS],
  };
}
