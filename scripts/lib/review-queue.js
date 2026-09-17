import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schema = JSON.parse(readFileSync(
  new URL('../../contracts/review-candidates.schema.json', import.meta.url), 'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export function createReviewQueue(candidates, generatedAt) {
  const queue = {
    schemaVersion: '1.0',
    generatedAt,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      sourceId: candidate.sourceId,
      ...(candidate.sourceNativeId ? { sourceNativeId: candidate.sourceNativeId } : {}),
      title: candidate.title,
      canonicalUrl: candidate.canonicalUrl,
      firstSeenAt: candidate.firstSeenAt,
      lastSeenAt: candidate.lastSeenAt,
      reason: 'unclassified-core-topic',
    })),
  };
  if (!validateSchema(queue)) throw new Error('Invalid review candidate queue');
  return queue;
}
