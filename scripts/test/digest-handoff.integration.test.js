import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main as validate } from '../validate-digest-selection.js';
import { main as finalize } from '../finalize-digest.js';
import { main as deliver } from '../deliver.js';
import { readDeliveryLedger } from '../delivery-ledger.js';

const fixtures = new URL('./fixtures/', import.meta.url);
function sink() {
  let value = '';
  return { write(chunk) { value += chunk; }, text() { return value; } };
}

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'digest-handoff-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestDocument = JSON.parse(await readFile(new URL('curation/valid-request.json', fixtures)));
  const request = join(root, 'request.json');
  const selectionDir = join(root, 'state', 'selections');
  await mkdir(selectionDir, { recursive: true });
  const selection = join(selectionDir, `${requestDocument.digestId}.json`);
  const validated = join(selectionDir, 'validated', `${requestDocument.digestId}.json`);
  await writeFile(request, JSON.stringify(requestDocument));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  return { root, request, selection, validated, requestDocument, outputDir: join(root, 'outputs') };
}

test('validated manifest in a separate directory hands off to finalize and stdout delivery', async (t) => {
  const paths = await setup(t);
  const { root, request, selection, validated, requestDocument, outputDir } = paths;
  const stderr = sink();
  assert.equal(await validate({
    argv: ['--request', request, '--selection', selection, '--output', validated],
    stdout: sink(), stderr,
  }), 0, stderr.text());
  assert.deepEqual(JSON.parse(await readFile(validated)), JSON.parse(await readFile(selection)));
  assert.equal(await finalize({
    argv: ['--request', request, '--selection', validated, '--output-dir', outputDir],
    stdout: sink(), stderr,
  }), 0, stderr.text());

  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ delivery: { method: 'stdout' } }));
  const ledgerPath = join(root, 'state', 'delivery-ledger.jsonl');
  const resultPath = join(root, 'delivery-result.json');
  const stdout = sink();
  assert.equal(await deliver({
    argv: ['--active', join(outputDir, 'active.json'), '--destination', 'stdout', '--result-out', resultPath],
    configPath, envPath: join(root, '.env'), env: {},
    ledgerPath, outboxDir: join(root, 'state', 'delivery-outbox'),
    transactionDir: join(root, 'state', 'delivery-transactions'), stdout, stderr,
  }), 0, stderr.text());
  assert.match(stdout.text(), /Model launch/);
  assert.match(stdout.text(), /https:\/\/official\.example\/model-launch/);
  assert.equal(stdout.text().trimStart().startsWith('{'), false);
  assert.equal(stderr.text(), '');
  const result = JSON.parse(await readFile(resultPath));
  assert.equal(result.status, 'delivered');
  assert.equal(result.method, 'stdout');
  assert.equal(result.digestId, requestDocument.digestId);
  assert.deepEqual((await readDeliveryLedger({ ledgerPath })).map(({ type }) => type), ['pending', 'delivered']);
});

test('wrong validation output name is rejected and cannot replace an existing active generation', async (t) => {
  const { root, request, selection, outputDir } = await setup(t);
  const wrongOutput = join(root, 'validated-selection.json');
  const previousManifest = await readFile(selection, 'utf8');
  await writeFile(wrongOutput, previousManifest);
  await mkdir(outputDir);
  const activePath = join(outputDir, 'active.json');
  const previousActive = '{"generation":"previous"}\n';
  await writeFile(activePath, previousActive);
  const stdout = sink();
  const stderr = sink();
  assert.equal(await validate({
    argv: ['--request', request, '--selection', selection, '--output', wrongOutput], stdout, stderr,
  }), 1);
  assert.equal(stderr.text(), 'output: filename must match digestId\n');
  assert.equal(await readFile(wrongOutput, 'utf8'), previousManifest);
  // Even an erroneous caller that continues after failure cannot activate this stale manifest.
  const finalizeError = sink();
  assert.equal(await finalize({
    argv: ['--request', request, '--selection', wrongOutput, '--output-dir', outputDir],
    stdout, stderr: finalizeError,
  }), 1);
  assert.equal(finalizeError.text(), 'preparation-failed: selection filename must match digestId\n');
  assert.equal(stdout.text(), '');
  assert.equal(await readFile(activePath, 'utf8'), previousActive);
  assert.deepEqual(await readdir(outputDir), ['active.json']);
  await assert.rejects(readFile(join(root, 'state', 'delivery-ledger.jsonl')), /ENOENT/);
});
