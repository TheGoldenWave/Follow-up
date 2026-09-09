import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
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
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push([cmd, args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const { path, payload } = await bootstrapAcquisition({ home, python, spawn });
    assert.equal(path, resolveBootstrapPath({ home }));
    assert.ok(isAbsolute(payload.interpreter));
    assert.ok(payload.interpreter.startsWith(home));
    assert.ok(calls.some(([, args]) => args.includes('venv')));
    assert.ok(calls.some(([, args]) => args.includes('--require-hashes')));
    assert.ok(calls.some(([, args]) => args.includes('wheel') && args.includes('--no-deps')));
    assert.ok(calls.some(([, args]) => args.includes('install') && args.some(a => a.endsWith('.whl')) && args.includes('--no-deps')));
    assert.ok(calls.some(([, args]) => args.includes('doctor')));

    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.schemaVersion, '1.0');
    assert.equal(raw.packageVersion, '0.3.1');
    assert.ok(raw.dependencies.includes('feedparser==6.0.14'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('failed installation never publishes a runtime descriptor', async () => {
  const home = await mkdtemp(join(tmpdir(), 'follow-up-bootstrap-fail-'));
  try {
    await assert.rejects(bootstrapAcquisition({ home,
      python: { interpreter: 'python3.12', version: { major: 3, minor: 12, patch: 13 } },
      spawn: () => ({ status: 1, stderr: 'installation failed' }),
    }), /installation failed/);
    await assert.rejects(readFile(resolveBootstrapPath({ home })), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('failed upgrade preserves working descriptor and hides index credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'follow-up-bootstrap-upgrade-'));
  try {
    await mkdir(join(home, '.follow-builders'));
    const previous = JSON.stringify({ interpreter: '/working/bin/python' });
    await writeFile(resolveBootstrapPath({ home }), previous);
    await assert.rejects(bootstrapAcquisition({ home,
      python: { interpreter: 'python3.12', version: { major: 3, minor: 12, patch: 13 } },
      spawn: () => ({ status: 1, stderr: 'https://user:secret@example.com/simple?token=secret failed' }),
    }), error => !error.message.includes('secret') && error.message.includes('installation failed'));
    assert.equal(await readFile(resolveBootstrapPath({ home }), 'utf8'), previous);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('bootstrapAcquisition fails without a Python 3.12 interpreter', async () => {
  const spawn = () => ({ status: 1, stdout: '' });
  await assert.rejects(
    bootstrapAcquisition({ home: '/tmp/x', python: null, spawn }),
    /Python 3\.12/,
  );
});

test('bootstrap ignores inherited pip destinations and config while preserving network settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'follow-up-pip-env-'));
  try {
    const config = join(home, 'unsafe-pip.conf');
    await writeFile(config, '[global]\ntarget = /outside-runtime\n');
    const env = { HOME: home, PIP_TARGET: '/outside-runtime', PIP_PREFIX: '/outside-runtime',
      PIP_ROOT: '/outside-runtime', PIP_USER: '1', PIP_CONFIG_FILE: config,
      PIP_INDEX_URL: 'https://mirror.example/simple', PIP_CERT: '/network/cert.pem', HTTPS_PROXY: 'http://proxy.example' };
    await bootstrapAcquisition({ home, env,
      python: { interpreter: 'python3.12', version: { major: 3, minor: 12, patch: 13 } },
      spawn: (command, args, options) => {
        for (const key of ['PIP_TARGET', 'PIP_PREFIX', 'PIP_ROOT', 'PIP_USER']) assert.equal(options.env[key], undefined);
        assert.equal(options.env.PIP_CONFIG_FILE, devNull);
        for (const key of ['PIP_INDEX_URL', 'PIP_CERT', 'HTTPS_PROXY']) assert.equal(options.env[key], env[key]);
        return { status: 0, stdout: '' };
      },
    });
    assert.equal(env.PIP_TARGET, '/outside-runtime');
    assert.equal(await readFile(config, 'utf8'), '[global]\ntarget = /outside-runtime\n');
  } finally { await rm(home, { recursive: true, force: true }); }
});
