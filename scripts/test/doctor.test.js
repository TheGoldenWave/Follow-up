import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  parseDoctorArgs,
  runDoctor,
} from '../doctor.js';

test('doctor CLI accepts only unique --network and --json flags', () => {
  assert.deepEqual(parseDoctorArgs([]), { network: false, json: false });
  assert.deepEqual(parseDoctorArgs(['--network', '--json']), { network: true, json: true });
  for (const args of [['--unknown'], ['--network=true'], ['--json', '--json'], ['value']]) {
    assert.throws(() => parseDoctorArgs(args), /usage|unknown|duplicate/i);
  }
});

test('runDoctor emits redacted JSON and preserves diagnostic exit semantics', async () => {
  const stdout = [];
  const report = {
    generatedAt: '2026-09-06T12:00:00.000Z',
    findings: [{
      id: 'config', status: 'error', scope: 'local', blocking: true,
      message: 'bad /Users/alice/config.json token=secret alice@example.com',
    }],
    exitCode: 1,
  };
  const result = await runDoctor(['--json'], {
    runDiagnosticsImpl: async () => report,
    stdout: (line) => stdout.push(line),
  });
  assert.equal(result.exitCode, 1);
  const serialized = stdout.join('\n');
  assert.doesNotMatch(serialized, /alice|secret|@example|\/Users\//i);
  assert.deepEqual(JSON.parse(serialized).summary, {
    healthy: 0, warnings: 0, errors: 1, localBlocking: 1, networkDegraded: 0,
  });
});

test('human output includes every finding without exposing evidence', async () => {
  const stdout = [];
  const report = {
    generatedAt: '2026-09-06T12:00:00.000Z', exitCode: 2,
    findings: [
      { id: 'version', status: 'ok', scope: 'local', blocking: false, message: 'Version is consistent' },
      { id: 'network:x', status: 'error', scope: 'network', blocking: false, message: 'token=private unreachable' },
    ],
  };
  const result = await runDoctor(['--network'], {
    runDiagnosticsImpl: async (options) => {
      assert.equal(options.network, true);
      return report;
    },
    stdout: (line) => stdout.push(line),
  });
  assert.equal(result.exitCode, 2);
  assert.match(stdout.join('\n'), /version.*ok/i);
  assert.match(stdout.join('\n'), /network:x.*error/i);
  assert.doesNotMatch(stdout.join('\n'), /private/i);
});

test('invalid CLI usage returns EX_USAGE 64 without running diagnostics', async () => {
  let called = false;
  const stderr = [];
  const result = await runDoctor(['--bad'], {
    runDiagnosticsImpl: async () => { called = true; },
    stderr: (line) => stderr.push(line),
  });
  assert.equal(result.exitCode, 64);
  assert.equal(called, false);
  assert.match(stderr.join('\n'), /usage/i);
});

test('doctor has a main guard and imported module does not execute the CLI', async () => {
  const script = `import ${JSON.stringify(new URL('../doctor.js', import.meta.url).href)}; console.log('imported')`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout.trim(), 'imported');
});

test('doctor can load before optional runtime dependencies are diagnosed', async () => {
  const source = await readFile(new URL('../lib/diagnostics.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import .*\.\.(?:\/config-contract|\/delivery-ledger|\/feed-contract)\.js/m);
});
