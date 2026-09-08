import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  bootstrapAcquisition,
  parsePythonVersion,
  resolveBootstrapPath,
  resolvePython312,
} from '../bootstrap-acquisition.js';

test('parsePythonVersion extracts a semver triple', () => {
  assert.deepEqual(parsePythonVersion('Python 3.12.13\n'), {
    major: 3,
    minor: 12,
    patch: 13,
  });
  assert.equal(parsePythonVersion('not python'), null);
});

test('resolvePython312 prefers a real 3.12 interpreter', () => {
  const spawn = (candidate) => {
    if (candidate === 'python3.12') {
      return { status: 0, stdout: 'Python 3.12.13\n' };
    }
    return { status: 0, stdout: 'Python 3.13.15\n' };
  };
  const resolved = resolvePython312({ spawn });
  assert.equal(resolved.interpreter, 'python3.12');
  assert.equal(resolved.version.minor, 12);
});

test('resolvePython312 rejects non-3.12 interpreters', () => {
  const spawn = () => ({ status: 0, stdout: 'Python 3.13.15\n' });
  assert.equal(resolvePython312({ spawn }), null);
});

test('bootstrapAcquisition writes runtime.json under an injected home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'follow-up-bootstrap-'));
  try {
    const python = {
      interpreter: 'python3.12',
      version: { major: 3, minor: 12, patch: 13 },
    };
    const { path, payload } = await bootstrapAcquisition({ home, python });
    assert.equal(path, resolveBootstrapPath({ home }));
    assert.equal(payload.interpreter, 'python3.12');

    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.schemaVersion, '1.0');
    assert.equal(raw.packageVersion, '0.3.0');
    assert.deepEqual(raw.dependencies, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('bootstrapAcquisition fails without a Python 3.12 interpreter', async () => {
  const spawn = () => ({ status: 1, stdout: '' });
  await assert.rejects(
    bootstrapAcquisition({ home: '/tmp/x', python: null, spawn }),
    /Python 3\.12/,
  );
});
