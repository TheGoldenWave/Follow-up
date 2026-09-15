import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { invokeAcquisitionRun, invokeCheckpointCommit, loadCollectedBatches } from '../lib/run-acquisition.js';

function fakeChild(code) {
  const listeners = {};
  const child = {
    stdout: { on: (event, cb) => { listeners[`stdout:${event}`] = cb; } },
    stderr: { on: (event, cb) => { listeners[`stderr:${event}`] = cb; } },
    on: (event, cb) => { listeners[event] = cb; },
  };
  queueMicrotask(() => {
    listeners['stdout:data']?.('collected 3 source(s)');
    if (code !== 0) listeners['stderr:data']?.('boom');
    listeners.close?.(code);
  });
  return child;
}

test('invokeAcquisitionRun resolves on exit 0 and captures stdout', async () => {
  const args = [];
  const result = await invokeAcquisitionRun({
    outputDir: '/tmp/acq',
    checkpointOut: '/tmp/acq/checkpoint-intent.json',
    runId: 'run-1',
    pythonPath: 'python3.12',
    spawnImpl: (cmd, argv, opts) => {
      args.push([cmd, argv, opts.cwd]);
      return fakeChild(0);
    },
  });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('collected'));
  assert.deepEqual(args[0][0], 'python3.12');
  assert.deepEqual(args[0][1], ['-I', '-m', 'follow_up_acquisition', 'run', '--run-id', 'run-1', '--output', '/tmp/acq', '--checkpoint-out', '/tmp/acq/checkpoint-intent.json']);
});

test('invokeAcquisitionRun rejects on a non-zero exit', async () => {
  await assert.rejects(
    () => invokeAcquisitionRun({ outputDir: '/tmp/acq', pythonPath: 'python3.12', spawnImpl: () => fakeChild(1) }),
    /acquisition run failed \(1\)/,
  );
});

test('invokeAcquisitionRun bounds and redacts unsafe stderr', async () => {
  await assert.rejects(
    () => invokeAcquisitionRun({ outputDir: '/tmp/acq', pythonPath: 'python3.12',
      spawnImpl: () => {
        const child = fakeChild(1);
        const original = child.stderr.on;
        child.stderr.on = (event, callback) => original(event, () => callback(`token=${'a'.repeat(40)}`));
        return child;
      },
    }),
    error => !error.message.includes('a'.repeat(40)),
  );
});

test('collection uses the bootstrapped interpreter and never installs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'follow-up-runtime-'));
  try {
    await mkdir(join(home, '.follow-builders'));
    await writeFile(join(home, '.follow-builders/runtime.json'), JSON.stringify({
      schemaVersion: '1.0', interpreter: '/isolated/bin/python', packageVersion: '0.3.0',
    }));
    const calls = [];
    await invokeAcquisitionRun({ outputDir: '/tmp/acq', env: { HOME: home, PYTHONPATH: '/untrusted', PYTHONHOME: '/broken' },
      spawnImpl: (cmd, args, options) => { calls.push([cmd, args, options]); return fakeChild(0); },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/isolated/bin/python');
    assert.equal(calls[0][1][0], '-I');
    assert.equal(calls[0][2].env.PYTHONPATH, undefined);
    assert.equal(calls[0][2].env.PYTHONHOME, undefined);
    assert.ok(!calls[0][1].includes('install'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('unbootstrapped collection fails with setup guidance before spawning', async () => {
  await assert.rejects(invokeAcquisitionRun({ outputDir: '/tmp/acq', env: { HOME: '/missing-runtime' },
    spawnImpl: () => { assert.fail('must not spawn'); },
  }), /bootstrap-acquisition/);
});

test('loadCollectedBatches ignores intent and rejects duplicate batch sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-acq-'));
  try {
    await writeFile(join(dir, 'blog:test.json'), JSON.stringify({
      schema_version: '1.0', source: 'blog:test', items: [],
    }));
    await writeFile(join(dir, 'zh-tech:36kr.json'), JSON.stringify({
      schema_version: '1.0', source: 'zh-tech:36kr', items: [],
    }));
    await writeFile(join(dir, 'not-json.txt'), 'ignore me');
    await writeFile(join(dir, 'checkpoint-intent.json'), JSON.stringify({ schema_version: '1.0' }));
    const batches = await loadCollectedBatches({ outputDir: dir });
    assert.deepEqual(Object.keys(batches).sort(), ['blog:test', 'zh-tech:36kr']);
    assert.equal(batches['blog:test'].source, 'blog:test');
    await writeFile(join(dir, 'duplicate.json'), JSON.stringify({ source: 'blog:test' }));
    await assert.rejects(() => loadCollectedBatches({ outputDir: dir }), /duplicate/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invokeCheckpointCommit uses isolated interpreter and never retries', async () => {
  const calls = [];
  const result = await invokeCheckpointCommit({
    intentPath: '/tmp/staging/checkpoint-intent.json', stateRoot: '/tmp/acquisition/source-state',
    pythonPath: '/isolated/bin/python',
    spawnImpl: (cmd, args) => { calls.push([cmd, args]); return fakeChild(3); },
  });
  assert.equal(result.checkpointStatus, 'partial');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['-I', '-m', 'follow_up_acquisition', 'commit-state', '--intent', '/tmp/staging/checkpoint-intent.json', '--state-root', '/tmp/acquisition/source-state']);
});
