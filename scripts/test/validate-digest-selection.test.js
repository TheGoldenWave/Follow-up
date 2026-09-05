import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

test('CLI rejects oversized request, selection, and exclusion inputs before reading JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'digest-selection-oversize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  const exclusions = join(root, 'excluded.json');
  await writeFile(request, '{}');
  await writeFile(selection, '{}');
  await writeFile(exclusions, '{}');

  for (const [field, expected] of [
    ['requestBytes', 'request'], ['selectionBytes', 'selection'],
    ['exclusionBytes', 'excluded candidate IDs'],
  ]) {
    const stdout = sink();
    const stderr = sink();
    const code = await main({
      argv: ['--request', request, '--selection', selection,
        '--excluded-candidate-ids', exclusions, '--output', join(root, `${field}.json`)],
      limits: { requestBytes: field === 'requestBytes' ? 1 : 1024,
        selectionBytes: field === 'selectionBytes' ? 1 : 1024,
        exclusionBytes: field === 'exclusionBytes' ? 1 : 1024 },
      stdout, stderr,
    });
    assert.equal(code, 1);
    assert.equal(stderr.text(), `${expected}: input exceeds byte limit\n`);
  }
});

test('atomic output rejects symlink targets and parents without exposing paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'digest-selection-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  const outside = join(root, 'outside.json');
  await writeFile(outside, 'unchanged');
  const targetLink = join(root, 'target-link.json');
  await symlink(outside, targetLink);
  const realParent = join(root, 'real-parent');
  await mkdir(realParent);
  const parentLink = join(root, 'parent-link');
  await symlink(realParent, parentLink);

  for (const output of [targetLink, join(parentLink, 'output.json')]) {
    const stdout = sink();
    const stderr = sink();
    assert.equal(await main({ argv: ['--request', request, '--selection', selection,
      '--output', output], stdout, stderr }), 1);
    assert.equal(stderr.text(), 'output: unsafe symbolic link\n');
    assert.doesNotMatch(stderr.text(), new RegExp(root));
  }
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
});

test('atomic output uses exclusive random temp files and preserves old output on collision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'digest-selection-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  const output = join(root, 'validated.json');
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  await writeFile(output, 'old-output');
  await writeFile(`${output}.tmp-fixed`, 'occupied');
  const stdout = sink();
  const stderr = sink();
  const code = await main({ argv: ['--request', request, '--selection', selection,
    '--output', output], randomUUID: () => 'fixed', stdout, stderr });
  assert.equal(code, 1);
  assert.equal(stderr.text(), 'output: could not be written\n');
  assert.equal(await readFile(output, 'utf8'), 'old-output');
  assert.equal(await readFile(`${output}.tmp-fixed`, 'utf8'), 'occupied');
  assert.doesNotMatch(stderr.text(), /tmp-fixed|digest-selection-collision/);
});

test('atomic output does not follow a prepositioned temp symlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'digest-selection-temp-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  const output = join(root, 'validated.json');
  const outside = join(root, 'outside.json');
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  await writeFile(output, 'old-output');
  await writeFile(outside, 'outside-output');
  await symlink(outside, `${output}.tmp-linked`);
  const stderr = sink();
  assert.equal(await main({ argv: ['--request', request, '--selection', selection,
    '--output', output], randomUUID: () => 'linked', stdout: sink(), stderr }), 1);
  assert.equal(stderr.text(), 'output: could not be written\n');
  assert.equal(await readFile(output, 'utf8'), 'old-output');
  assert.equal(await readFile(outside, 'utf8'), 'outside-output');
  assert.equal((await fs.lstat(`${output}.tmp-linked`)).isSymbolicLink(), true);
});

test('atomic output cleans a failed temp write and preserves old output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'digest-selection-write-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  const output = join(root, 'validated.json');
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  await writeFile(output, 'old-output');
  let closed = false;
  const fsImpl = {
    ...fs,
    async open(path, flags, mode) {
      if (flags !== 'wx') return fs.open(path, flags, mode);
      const handle = await fs.open(path, flags, mode);
      return {
        async writeFile() { throw new Error(`sensitive ${path}`); },
        async sync() { return handle.sync(); },
        async close() { closed = true; return handle.close(); },
      };
    },
  };
  const stdout = sink();
  const stderr = sink();
  const code = await main({ argv: ['--request', request, '--selection', selection,
    '--output', output], randomUUID: () => 'failed-write', fsImpl, stdout, stderr });
  assert.equal(code, 1);
  assert.equal(stderr.text(), 'output: could not be written\n');
  assert.equal(closed, true);
  assert.equal(await readFile(output, 'utf8'), 'old-output');
  await assert.rejects(readFile(`${output}.tmp-failed-write`, 'utf8'), /ENOENT/);
  assert.doesNotMatch(stderr.text(), /sensitive|failed-write|digest-selection-write-failure/);
});

test('mkdir and rename failures use fixed labels and preserve old output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'digest-selection-io-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, 'request.json');
  const selection = join(root, 'selection.json');
  const output = join(root, 'validated.json');
  await writeFile(request, await readFile(new URL('curation/valid-request.json', fixtures)));
  await writeFile(selection, await readFile(new URL('selections/valid-selection.json', fixtures)));
  await writeFile(output, 'old-output');

  for (const operation of ['mkdir', 'rename']) {
    const fsImpl = {
      ...fs,
      async [operation](...args) {
        throw new Error(`sensitive ${operation} ${args[0]}`);
      },
    };
    const stderr = sink();
    const code = await main({ argv: ['--request', request, '--selection', selection,
      '--output', output], randomUUID: () => operation, fsImpl, stdout: sink(), stderr });
    assert.equal(code, 1);
    assert.equal(stderr.text(), 'output: could not be written\n');
    assert.doesNotMatch(stderr.text(), new RegExp(root));
    assert.equal(await readFile(output, 'utf8'), 'old-output');
  }
});
