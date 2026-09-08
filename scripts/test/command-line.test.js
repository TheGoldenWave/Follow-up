import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  CommandLineUsageError,
  parseCommandLine,
} from '../command-line.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const options = {
  platform: { type: 'string' },
  register: { type: 'boolean' },
  'skill-dir': { type: 'string' },
};

function assertUsageError(callback, pattern) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof CommandLineUsageError);
    assert.equal(error.exitCode, 64);
    assert.match(error.message, pattern);
    return true;
  });
}

test('strict parsing accepts declared string and boolean options', () => {
  assert.deepEqual(parseCommandLine([
    '--platform', 'custom',
    '--skill-dir=/opt/follow-up',
    '--register',
  ], { options }), {
    values: {
      platform: 'custom',
      register: true,
      'skill-dir': '/opt/follow-up',
    },
    positionals: [],
  });
});

test('unknown arguments and missing option values exit with usage code 64', () => {
  assertUsageError(
    () => parseCommandLine(['--unknown'], { options }),
    /unknown/i,
  );
  assertUsageError(
    () => parseCommandLine(['--platform'], { options }),
    /platform|value/i,
  );
});

test('positionals are rejected unless explicitly enabled', () => {
  assertUsageError(
    () => parseCommandLine(['extra'], { options }),
    /positional|unexpected/i,
  );
});

test('invalid combinations use the same usage error contract', () => {
  assertUsageError(
    () => parseCommandLine(['--platform', 'codex', '--skill-dir', '/tmp/custom'], {
      options,
      validate({ values }) {
        if (values.platform !== 'custom' && values['skill-dir']) {
          throw new Error('--skill-dir requires --platform custom');
        }
      },
    }),
    /requires --platform custom/i,
  );
});

test('installed release symlinks execute every user-facing workflow CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-cli-link-'));
  const installed = join(root, '0.2.0');
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(repositoryRoot, installed, 'dir');

  for (const entrypoint of [
    'prepare-digest.js',
    'finalize-digest.js',
    'validate-digest-selection.js',
    'deliver.js',
    'resolve-delivery.js',
    'schedule-gate.js',
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [join(installed, 'scripts', entrypoint)], {
        encoding: 'utf8',
      }),
      (error) => {
        assert.equal(error.code, 64, entrypoint);
        assert.match(`${error.stdout}\n${error.stderr}`, /usage/i, entrypoint);
        return true;
      },
    );
  }
});
