import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../validate-digest-selection.js';

const fixtures = new URL('./fixtures/', import.meta.url);

function sink() {
  let value = '';
  return { write(chunk) { value += chunk; }, text() { return value; } };
}

test('CLI rejects malformed arguments with EX_USAGE', async () => {
  const stdout = sink();
  const stderr = sink();
  assert.equal(await main({ argv: ['--request', 'only.json'], stdout, stderr }), 64);
  assert.equal(await main({ argv: ['--wat', 'no'], stdout, stderr }), 64);
});

test('CLI reports deterministic sanitized JSON and validation failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'digest-selection-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidRequest = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  await writeFile(invalidRequest, '{"interests":["private roadmap"],');
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  const stdout = sink();
  const stderr = sink();
  const code = await main({ argv: ['--request', invalidRequest, '--selection', selection,
    '--output', join(root, 'out.json')], stdout, stderr });
  assert.equal(code, 1);
  assert.equal(stdout.text(), '');
  assert.match(stderr.text(), /^request: invalid JSON\n$/);
  assert.doesNotMatch(stderr.text(), /private roadmap|selectionReason/);
});

test('CLI validates exclusions and atomically writes the validated manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'digest-selection-valid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  const exclusions = join(root, 'excluded.json');
  const output = join(root, 'validated.json');
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  const selectionBuffer = await readFile(new URL('selections/valid-selection.json', fixtures));
  await writeFile(selection, selectionBuffer);
  await writeFile(exclusions, '{"excludedCandidateIds":[]}\n');
  const stdout = sink();
  const stderr = sink();
  const code = await main({ argv: ['--request', request, '--selection', selection,
    '--excluded-candidate-ids', exclusions, '--output', output], stdout, stderr });
  assert.equal(code, 0, stderr.text());
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), JSON.parse(selectionBuffer));
  assert.match(stdout.text(), /validated/i);
  assert.equal(stderr.text(), '');
});
