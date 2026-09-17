import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const COMMUNITY_EVIDENCE_MAX_BYTES = 4096;

const schema = JSON.parse(readFileSync(
  new URL('../contracts/community-evidence.schema.json', import.meta.url), 'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv, { mode: 'full' });
const validateSchema = ajv.compile(schema);

function formatErrors(errors = []) {
  return errors.map(({ instancePath, keyword, message, params }) => {
    const path = instancePath || '/';
    if (keyword === 'required') return `${path} requires property ${params.missingProperty}`;
    if (keyword === 'additionalProperties') return `${path} contains unsupported property ${params.additionalProperty}`;
    return `${path} ${message}`;
  });
}

export function validateCommunityEvidence(value) {
  const schemaValid = validateSchema(value);
  const errors = schemaValid ? [] : formatErrors(validateSchema.errors);
  if (schemaValid) {
    const kinds = value.views.map(({ kind }) => kind);
    if (new Set(kinds).size !== kinds.length) errors.push('/views must not repeat kind');
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > COMMUNITY_EVIDENCE_MAX_BYTES) {
      errors.push(`/ exceeds the ${COMMUNITY_EVIDENCE_MAX_BYTES}-byte limit`);
    }
  }
  return { valid: errors.length === 0, errors };
}
