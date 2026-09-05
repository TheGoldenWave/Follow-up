import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommandLineUsageError,
  parseCommandLine,
} from '../command-line.js';

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
