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

test('loadCollectedBatches reads through one nofollow handle without lstat/readFile', async () => {
  const payload = Buffer.from(JSON.stringify({ source: 'blog:test' }));
  let closed = 0;
  const handle = {
    stat: async () => ({ isFile: () => true, nlink: 1, size: payload.length, dev: 1, ino: 2 }),
    read: async (buffer, offset, length, position) => {
      if (position >= payload.length) return { bytesRead: 0 };
      payload.copy(buffer, offset, position);
      return { bytesRead: payload.length - position };
    },
    close: async () => { closed += 1; },
  };
  const batches = await loadCollectedBatches({ outputDir: '/staging', fsImpl: {
    readdir: async () => [{ name: 'batch.json', isFile: () => true, isSymbolicLink: () => false }],
    lstat: async () => assert.fail('must not lstat'), readFile: async () => assert.fail('must not readFile'),
    open: async (path, flags) => { assert.equal(typeof flags, 'number'); return handle; },
  } });
  assert.equal(batches['blog:test'].source, 'blog:test');
  assert.equal(closed, 1);
});

test('loadCollectedBatches completes bounded short reads from the same handle', async () => {
  const payload = Buffer.from(JSON.stringify({ source: 'blog:test' }));
  let reads = 0;
  const handle = {
    stat: async () => ({ isFile: () => true, nlink: 1, size: payload.length, dev: 1, ino: 2 }),
    read: async (buffer, offset, length, position) => {
      reads += 1;
      const count = Math.min(5, length, payload.length - position);
      if (count > 0) payload.copy(buffer, offset, position, position + count);
      return { bytesRead: Math.max(count, 0) };
    }, close: async () => {},
  };
  const batches = await loadCollectedBatches({ outputDir: '/staging', fsImpl: {
    readdir: async () => [{ name: 'batch.json', isFile: () => true, isSymbolicLink: () => false }],
    open: async () => handle,
  } });
  assert.equal(batches['blog:test'].source, 'blog:test');
  assert.ok(reads > 1);
});

test('loadCollectedBatches rejects oversized and non-posix acquisition without reading', async () => {
  const entries = [{ name: 'batch.json', isFile: () => true, isSymbolicLink: () => false }];
  let reads = 0;
  const fsImpl = { readdir: async () => entries, open: async () => ({
    stat: async () => ({ isFile: () => true, nlink: 1, size: 10 * 1024 * 1024 + 1, dev: 1, ino: 2 }),
    read: async () => { reads += 1; return { bytesRead: 0 }; }, close: async () => {},
  }) };
  await assert.rejects(() => loadCollectedBatches({ outputDir: '/staging', fsImpl }), /unsafe|large|bounded/);
  assert.equal(reads, 0);
  await assert.rejects(() => loadCollectedBatches({ outputDir: '/staging', fsImpl, platformName: 'win32' }), /unsupported/);
});

test('loadCollectedBatches rejects a symlink swap at the nofollow open boundary', async () => {
  let opens = 0;
  await assert.rejects(() => loadCollectedBatches({ outputDir: '/staging', fsImpl: {
    readdir: async () => [{ name: 'batch.json', isFile: () => true, isSymbolicLink: () => false }],
    open: async () => { opens += 1; const error = new Error('nofollow'); error.code = 'ELOOP'; throw error; },
  } }), error => error.code === 'ELOOP');
  assert.equal(opens, 1);
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

test('invokeCheckpointCommit converts exit one, spawn error, and malformed output to partial once', async () => {
  for (const spawnImpl of [
    () => fakeChild(1),
    () => {
      const listeners = {};
      const child = { stdout: { on() {} }, stderr: { on() {} }, on: (event, callback) => { listeners[event] = callback; } };
      queueMicrotask(() => listeners.error(new Error('/private/path secret')));
      return child;
    },
    () => fakeChild(0),
  ]) {
    let calls = 0;
    const result = await invokeCheckpointCommit({
      intentPath: '/private/intent', stateRoot: '/private/state', pythonPath: '/python',
      spawnImpl: (...args) => { calls += 1; return spawnImpl(...args); },
    });
    assert.equal(calls, 1);
    assert.equal(result.checkpointStatus, 'partial');
    assert.equal(JSON.stringify(result).includes('/private'), false);
  }
});

test('invokeCheckpointCommit preserves a validated durability uncertainty result', async () => {
  const result = await invokeCheckpointCommit({ intentPath: '/i', stateRoot: '/s', pythonPath: '/p', spawnImpl: () => {
    const listeners = {};
    const child = {
      stdout: { on: (event, callback) => { listeners[`out:${event}`] = callback; } },
      stderr: { on() {} }, on: (event, callback) => { listeners[event] = callback; },
    };
    queueMicrotask(() => {
      listeners['out:data'](JSON.stringify({ status: 'uncertain', committed: 0, failed: 1, sources: [] }));
      listeners.close(3);
    });
    return child;
  } });
  assert.equal(result.checkpointStatus, 'uncertain');
});
