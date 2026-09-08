import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { writeJsonAtomic } from '../prepare-digest.js';

const schema = JSON.parse(readFileSync(
  new URL('../../contracts/signal-batch.schema.json', import.meta.url),
  'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export function validateSignalBatch(batch) {
  const valid = validateSchema(batch);
  return {
    valid,
    errors: valid ? [] : validateSchema.errors.map(({ instancePath, message }) => (
      `${instancePath || '/'} ${message}`
    )),
  };
}

function assertValidBatch(sourceId, batch) {
  const result = validateSignalBatch(batch);
  if (!result.valid) {
    throw new Error(`Signal Batch for ${sourceId} is invalid: ${result.errors.join('; ')}`);
  }
  if (batch.source !== sourceId) {
    throw new Error(`Signal Batch source ${batch.source} does not match filename ${sourceId}`);
  }
}

/**
 * Atomically publish one run of Signal Batches under `runs/<run_id>/<source>.json`.
 * A crash or invalid batch leaves no partial run file behind.
 */
export async function publishBatchRun(batches, {
  runsDir,
  runId,
  fsImpl = systemFs,
  randomUUID = systemRandomUUID,
} = {}) {
  if (typeof runsDir !== 'string' || typeof runId !== 'string') {
    throw new TypeError('runsDir and runId are required');
  }
  for (const [sourceId, batch] of Object.entries(batches)) {
    assertValidBatch(sourceId, batch);
    await writeJsonAtomic(join(runsDir, runId, `${sourceId}.json`), batch, {
      fsImpl, randomUUID, label: `run batch ${sourceId}`,
    });
  }
  return join(runsDir, runId);
}

/**
 * Atomically update each source's `latest.json` pointer after every batch in the
 * run validated and published successfully.
 */
export async function publishLatestPointers(batches, {
  runsDir,
  latestDir,
  runId,
  fsImpl = systemFs,
  randomUUID = systemRandomUUID,
} = {}) {
  for (const [sourceId, batch] of Object.entries(batches)) {
    await writeJsonAtomic(join(latestDir, `${sourceId}.json`), {
      run_id: runId,
      batch_id: batch.batch_id,
      generated_at: batch.generated_at,
      path: join(runsDir, runId, `${sourceId}.json`),
    }, { fsImpl, randomUUID, label: `latest pointer ${sourceId}` });
  }
  return join(latestDir);
}
