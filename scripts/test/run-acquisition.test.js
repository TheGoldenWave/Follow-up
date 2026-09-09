import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { invokeAcquisitionRun, loadCollectedBatches } from '../lib/run-acquisition.js';

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
    pythonPath: 'python3.12',
    spawnImpl: (cmd, argv, opts) => {
      args.push([cmd, argv, opts.cwd]);
      return fakeChild(0);
    },
  });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('collected'));
  assert.deepEqual(args[0][0], 'python3.12');
  assert.deepEqual(args[0][1], ['-I', '-m', 'follow_up_acquisition', 'run', '--output', '/tmp/acq']);
});

test('invokeAcquisitionRun rejects on a non-zero exit', async () => {
  await assert.rejects(
    () => invokeAcquisitionRun({ outputDir: '/tmp/acq', pythonPath: 'python3.12', spawnImpl: () => fakeChild(1) }),
    /acquisition run failed \(1\)/,
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

test('loadCollectedBatches reads only JSON files and keys by source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-up-acq-'));
  try {
    await writeFile(join(dir, 'blog:test.json'), JSON.stringify({
      schema_version: '1.0', source: 'blog:test', items: [],
    }));
    await writeFile(join(dir, 'zh-tech:36kr.json'), JSON.stringify({
      schema_version: '1.0', source: 'zh-tech:36kr', items: [],
    }));
    await writeFile(join(dir, 'not-json.txt'), 'ignore me');
    const batches = await loadCollectedBatches({ outputDir: dir });
    assert.deepEqual(Object.keys(batches).sort(), ['blog:test', 'zh-tech:36kr']);
    assert.equal(batches['blog:test'].source, 'blog:test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
