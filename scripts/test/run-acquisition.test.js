import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(args[0][1], ['-m', 'follow_up_acquisition', 'run', '--output', '/tmp/acq']);
});

test('invokeAcquisitionRun rejects on a non-zero exit', async () => {
  await assert.rejects(
    () => invokeAcquisitionRun({ outputDir: '/tmp/acq', spawnImpl: () => fakeChild(1) }),
    /acquisition run failed \(1\)/,
  );
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
