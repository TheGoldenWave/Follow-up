import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  classifyFreshness,
  createFinding,
  fetchJsonBounded,
  readJsonBounded,
  redactDiagnostics,
  runDiagnostics,
  summarizeDiagnostics,
  validateInstalledDependencies,
} from '../lib/diagnostics.js';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');

test('findings use the closed status, scope, and blocking fields', () => {
  assert.deepEqual(createFinding({
    id: 'node', status: 'ok', scope: 'local', blocking: false, message: 'Node is supported',
  }), {
    id: 'node', status: 'ok', scope: 'local', blocking: false, message: 'Node is supported',
  });
  assert.throws(() => createFinding({ id: 'bad', status: 'degraded', scope: 'local' }), /status/i);
  assert.throws(() => createFinding({ id: 'bad', status: 'ok', scope: 'remote' }), /scope/i);
});

test('freshness thresholds are healthy through 48h, warning through 7d, then degraded', () => {
  assert.equal(classifyFreshness('2026-09-04T12:00:00.000Z', NOW).status, 'ok');
  assert.equal(classifyFreshness('2026-09-04T11:59:59.999Z', NOW).status, 'warning');
  assert.equal(classifyFreshness('2026-08-30T12:00:00.000Z', NOW).status, 'warning');
  assert.equal(classifyFreshness('2026-08-30T11:59:59.999Z', NOW).status, 'error');
  assert.equal(classifyFreshness('invalid', NOW).status, 'error');
  assert.equal(classifyFreshness('2026-09-06T12:05:00.000Z', NOW).status, 'ok');
  assert.equal(classifyFreshness('2026-09-06T12:05:00.001Z', NOW).status, 'error');
});

test('diagnostics finish every offline check before network checks and isolate failures', async () => {
  const calls = [];
  const offlineChecks = ['version', 'manifest', 'node', 'config', 'dependencies', 'registration',
    'feed-contract', 'candidate-history', 'unresolved-pending'].map((id) => async () => {
    calls.push(`local:${id}`);
    if (id === 'config') throw new Error('config failed with token=private');
    return createFinding({ id, status: 'ok', scope: 'local', blocking: false, message: 'ok' });
  });
  const networkChecks = ['x', 'blogs'].map((id) => async () => {
    calls.push(`network:${id}`);
    if (id === 'x') throw new Error('https://user:pass@example.test/feed?token=private');
    return createFinding({ id: `network:${id}`, status: 'ok', scope: 'network', blocking: false, message: 'ok' });
  });

  const report = await runDiagnostics({ network: true, offlineChecks, networkChecks, now: NOW });
  assert.deepEqual(calls.slice(0, 9), offlineChecks.map((_, index) => `local:${['version', 'manifest', 'node', 'config', 'dependencies', 'registration', 'feed-contract', 'candidate-history', 'unresolved-pending'][index]}`));
  assert.equal(calls[9], 'network:x');
  assert.equal(report.findings.length, 11);
  assert.equal(report.findings.find(({ id }) => id === 'config').status, 'error');
  assert.equal(report.findings.find(({ id }) => id === 'network:x').scope, 'network');
});

test('summary exit codes prioritize local blocking over degraded network', () => {
  const localFailure = createFinding({ id: 'config', status: 'error', scope: 'local', blocking: true });
  const networkFailure = createFinding({ id: 'network:x', status: 'error', scope: 'network', blocking: false });
  const warning = createFinding({ id: 'history', status: 'warning', scope: 'local', blocking: false });
  assert.equal(summarizeDiagnostics([localFailure, networkFailure]).exitCode, 1);
  assert.equal(summarizeDiagnostics([networkFailure]).exitCode, 2);
  assert.equal(summarizeDiagnostics([warning]).exitCode, 0);
  assert.equal(summarizeDiagnostics([]).exitCode, 0);
});

test('redacted JSON removes credentials, secret queries, cookies, tokens, email, interests, reasons, and paths', () => {
  const report = {
    generatedAt: '2026-09-06T12:00:00.000Z',
    findings: [{
      id: 'unsafe', status: 'error', scope: 'local', blocking: true,
      message: 'failed at /Users/alice/private/config.json and /opt/company/private/state.json for alice@example.com',
      evidence: {
        credential: 'credential-value',
        cookie: 'session=abc',
        token: 'tok_private',
        email: 'alice@example.com',
        interests: ['acquisition targets'],
        selectionReason: 'private rationale',
        url: 'https://alice:password@example.com/feed?token=secret&topic=public',
        nested: 'Authorization: Bearer abc.def.ghi; Cookie: sid=secret',
        configPath: '/Users/alice/private/config.json',
      },
    }],
  };
  const serialized = JSON.stringify(redactDiagnostics(report));
  for (const secret of [
    'credential-value', 'session=abc', 'tok_private', 'alice@example.com',
    'acquisition targets', 'private rationale', 'password', 'secret',
    '/Users/alice/private/config.json', '/opt/company/private/state.json', 'abc.def.ghi',
  ]) assert.doesNotMatch(serialized, new RegExp(secret.replaceAll('.', '\\.'), 'i'));
  assert.match(serialized, /\[redacted\]/i);
});

test('redaction removes complete quoted and escaped absolute paths containing spaces', () => {
  const serialized = JSON.stringify(redactDiagnostics({
    message: 'read "/Users/alice/Secret Project/private.json" and C:\\Users\\Alice Smith\\token.txt',
    escaped: 'open /Users/alice/Secret\\ Project/private.json now',
  }));
  for (const fragment of [
    'Secret Project', 'Secret\\\\ Project', 'private.json',
    'Alice Smith', 'token.txt', '/Users/alice', 'C:\\\\Users',
  ]) assert.doesNotMatch(serialized, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(serialized, /redacted-path/i);
});

test('redaction conservatively removes the rest of an unquoted absolute POSIX path with spaces', () => {
  const redacted = redactDiagnostics({
    message: 'failed /Users/alice/Secret Project/private.json',
    url: 'request https://example.com/path with ordinary words',
    prose: 'ratio input/output remains ordinary text',
  });
  assert.equal(redacted.message, 'failed [redacted-path]');
  assert.equal(redacted.url, 'request https://example.com/path with ordinary words');
  assert.equal(redacted.prose, 'ratio input/output remains ordinary text');
});

test('redaction does not infer unquoted POSIX path endings from extensions or separators', () => {
  for (const message of [
    '/Users/alice/My Report.json',
    'failed /Users/alice/Secret Project',
  ]) {
    const redacted = redactDiagnostics({ message });
    assert.equal(redacted.message, message.startsWith('/')
      ? '[redacted-path]'
      : 'failed [redacted-path]');
    assert.doesNotMatch(redacted.message, /alice|Report|Secret|Project/i);
  }
  assert.equal(
    redactDiagnostics({ value: 'request https://example.com/path remains visible' }).value,
    'request https://example.com/path remains visible',
  );
  assert.equal(
    redactDiagnostics({ value: 'relative input/output remains visible' }).value,
    'relative input/output remains visible',
  );
});

test('redaction recognizes absolute paths after common diagnostic boundaries', () => {
  const cases = [
    ['failed /Users/alice/My Report.json', 'failed [redacted-path]'],
    ['failed (/Users/alice/My Report.json)', 'failed ([redacted-path]'],
    ['failed [/Users/alice/My Report.json]', 'failed [[redacted-path]'],
    ['failed {/Users/alice/My Report.json}', 'failed {[redacted-path]'],
    ['path=/Users/alice/My Report.json', 'path=[redacted-path]'],
    ['path:/Users/alice/My Report.json', 'path:[redacted-path]'],
    ['path="/Users/alice/My Report.json"', 'path="[redacted-path]"'],
    ["path='/Users/alice/My Report.json'", "path='[redacted-path]'"],
    ['path=C:\\Users\\Alice Smith\\token.txt', 'path=[redacted-path]'],
    ['failed (C:\\Users\\Alice Smith\\token.txt)', 'failed ([redacted-path]'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(redactDiagnostics({ message }).message, expected, message);
  }

  for (const value of [
    'https://example.com/path remains visible',
    'relative input/output remains visible',
    'ratio:1/2 remains visible',
  ]) assert.equal(redactDiagnostics({ value }).value, value);
});

test('default offline diagnostics cover all required local contracts through injected adapters', async () => {
  const report = await runDiagnostics({
    network: false,
    releaseRoot: '/release',
    configPath: '/state/config.json',
    platform: 'custom',
    skillDir: '/skills/follow-up',
    nodeVersion: '20.11.0',
    readFileImpl: async (path) => {
      const value = String(path);
      if (value.endsWith('/VERSION')) return '0.2.0\n';
      if (value.endsWith('/scripts/package.json')) return JSON.stringify({ version: '0.2.0', engines: { node: '>=20.0.0' }, dependencies: { ajv: '^8.0.0' } });
      if (value.endsWith('/scripts/package-lock.json')) return JSON.stringify({
        version: '0.2.0', packages: {
          '': { version: '0.2.0' },
          'node_modules/ajv': { version: '8.17.1' },
        },
      });
      if (value.endsWith('/scripts/node_modules/ajv/package.json')) return JSON.stringify({ version: '8.17.1' });
      if (value === '/state/config.json') return JSON.stringify({ enabledChannels: [] });
      if (value.endsWith('/feed-candidates.json')) return JSON.stringify({
        generatedAt: '2026-09-06T00:00:00.000Z', continuousHistorySince: '2026-09-01T00:00:00.000Z', historyTruncated: true,
      });
      throw Object.assign(new Error(`missing ${value}`), { code: 'ENOENT' });
    },
    accessImpl: async () => {},
    resolveDependencyImpl: async () => {},
    validateReleaseImpl: async (_root, options) => {
      assert.equal(options.verifyIntegrity, true);
      assert.equal(options.mode, 'archive');
      return [];
    },
    validateConfigImpl: () => ({ valid: true, errors: [] }),
    inspectRegistrationImpl: async () => ({ status: 'registered' }),
    validateFeedFilesImpl: async () => [],
    readDeliveryLedgerImpl: async () => [{ type: 'pending', attemptId: 'attempt-1' }],
    deriveDeliveryStateImpl: () => ({ attempts: new Map([['attempt-1', { resolution: null }]]), unresolvedReplacementAttempts: [] }),
    now: NOW,
  });
  assert.deepEqual(report.findings.map(({ id }) => id), [
    'version', 'manifest', 'node', 'config', 'dependencies', 'registration',
    'feed-contract', 'candidate-history', 'unresolved-pending',
  ]);
  assert.equal(report.findings.find(({ id }) => id === 'candidate-history').status, 'warning');
  assert.equal(report.findings.find(({ id }) => id === 'unresolved-pending').status, 'warning');
});

test('default registration discovery requires at least one valid built-in registration', async () => {
  const base = {
    network: false, releaseRoot: '/release', configPath: '/state/config.json', nodeVersion: '20.0.0', now: NOW,
    readFileImpl: async (path) => {
      const value = String(path);
      if (value.endsWith('/VERSION')) return '0.2.0';
      if (value.endsWith('/scripts/package.json')) return JSON.stringify({ dependencies: {} });
      if (value.endsWith('/scripts/package-lock.json')) return JSON.stringify({ packages: { '': {} } });
      if (value === '/state/config.json') return '{}';
      if (value.endsWith('/feed-candidates.json')) return JSON.stringify({ continuousHistorySince: '2026-09-01T00:00:00.000Z', historyTruncated: false });
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    validateReleaseImpl: async () => [], validateConfigImpl: () => ({ valid: true, errors: [] }),
    validateFeedFilesImpl: async () => [], readDeliveryLedgerImpl: async () => [],
    deriveDeliveryStateImpl: () => ({ attempts: new Map(), unresolvedReplacementAttempts: [] }),
  };
  const missing = await runDiagnostics({
    ...base, inspectRegistrationImpl: async () => ({ status: 'missing' }),
  });
  assert.equal(missing.findings.find(({ id }) => id === 'registration').status, 'error');
  const calls = [];
  const registered = await runDiagnostics({
    ...base,
    inspectRegistrationImpl: async ({ platform }) => {
      calls.push(platform);
      return { status: platform === 'claude-code' ? 'registered' : 'missing' };
    },
  });
  assert.deepEqual(calls, ['codex', 'claude-code']);
  assert.equal(registered.findings.find(({ id }) => id === 'registration').status, 'ok');

  calls.length = 0;
  const custom = await runDiagnostics({
    ...base,
    readFileImpl: async (path) => {
      if (String(path).endsWith('/active.json')) return JSON.stringify({
        registration: { platform: 'custom', skillDir: '/agent/custom/follow-up' },
      });
      return base.readFileImpl(path);
    },
    inspectRegistrationImpl: async ({ platform, skillDir }) => {
      calls.push(`${platform}:${skillDir ?? ''}`);
      if (platform === 'custom') return { status: 'registered' };
      throw new Error('broken built-in registration');
    },
  });
  assert.deepEqual(calls, ['custom:/agent/custom/follow-up']);
  assert.equal(custom.findings.find(({ id }) => id === 'registration').status, 'ok');

  calls.length = 0;
  const brokenCustom = await runDiagnostics({
    ...base,
    readFileImpl: async (path) => {
      if (String(path).endsWith('/active.json')) return JSON.stringify({
        registration: { platform: 'custom', skillDir: '/agent/custom/follow-up' },
      });
      return base.readFileImpl(path);
    },
    inspectRegistrationImpl: async ({ platform }) => {
      calls.push(platform);
      return { status: platform === 'codex' ? 'registered' : 'missing' };
    },
  });
  assert.deepEqual(calls, ['custom']);
  assert.equal(brokenCustom.findings.find(({ id }) => id === 'registration').status, 'error');

  calls.length = 0;
  const activeCodex = await runDiagnostics({
    ...base,
    readFileImpl: async (path) => {
      if (String(path).endsWith('/active.json')) return JSON.stringify({
        registration: { platform: 'codex' },
      });
      return base.readFileImpl(path);
    },
    inspectRegistrationImpl: async ({ platform }) => {
      calls.push(platform);
      return { status: platform === 'claude-code' ? 'registered' : 'missing' };
    },
  });
  assert.deepEqual(calls, ['codex']);
  assert.equal(activeCodex.findings.find(({ id }) => id === 'registration').status, 'error');
  assert.equal(activeCodex.exitCode, 1);

  calls.length = 0;
  const activeClaude = await runDiagnostics({
    ...base,
    readFileImpl: async (path) => {
      if (String(path).endsWith('/active.json')) return JSON.stringify({
        registration: { platform: 'claude-code' },
      });
      return base.readFileImpl(path);
    },
    inspectRegistrationImpl: async ({ platform }) => {
      calls.push(platform);
      return { status: platform === 'codex' ? 'registered' : 'missing' };
    },
  });
  assert.deepEqual(calls, ['claude-code']);
  assert.equal(activeClaude.exitCode, 1);
});

test('chunked network reads stop at the configured byte limit', async () => {
  let reads = 0;
  const response = {
    ok: true, headers: { get: () => null },
    body: { getReader: () => ({
      async read() { reads += 1; return { done: false, value: new Uint8Array(8) }; },
      async cancel() {}, releaseLock() {},
    }) },
  };
  await assert.rejects(fetchJsonBounded('https://example.test/feed.json', {
    fetchImpl: async () => response, maxBytes: 15,
  }), /byte limit/i);
  assert.equal(reads, 2);
});

test('network timeout remains active while a response body stalls', { timeout: 200 }, async () => {
  const response = {
    ok: true, headers: { get: () => null },
    body: { getReader: () => ({
      async read() { return new Promise(() => {}); },
      async cancel() {}, releaseLock() {},
    }) },
  };
  await assert.rejects(fetchJsonBounded('https://example.test/feed.json', {
    fetchImpl: async () => response, timeoutMs: 5,
  }), /timed out/i);
});

test('local JSON reads reject oversized files before loading their contents', async () => {
  let readCalled = false;
  const handle = {
    async stat() { return { isFile: () => true, size: 17 }; },
    async read() { readCalled = true; return { bytesRead: 0 }; },
    async close() {},
  };
  await assert.rejects(readJsonBounded('/state/oversized.json', 16, {
    open: async () => handle,
  }), /byte limit/i);
  assert.equal(readCalled, false);
});

test('dependency diagnostics verify transitive packages and installed versions from the lockfile', async () => {
  const documents = new Map([
    ['/release/scripts/package.json', { dependencies: { direct: '1.0.0' } }],
    ['/release/scripts/package-lock.json', { packages: {
      '': {}, 'node_modules/direct': { version: '1.0.0' },
      'node_modules/transitive': { version: '2.0.0' },
    } }],
    ['/release/scripts/node_modules/direct/package.json', { version: '1.0.0', main: 'index.js' }],
  ]);
  const readFileImpl = async (path) => {
    const document = documents.get(String(path));
    if (!document) throw Object.assign(new Error('missing transitive package'), { code: 'ENOENT' });
    return JSON.stringify(document);
  };
  const accessImpl = async () => {};
  await assert.rejects(validateInstalledDependencies('/release', {
    readFileImpl, accessImpl,
  }), /transitive|missing/i);
  documents.set('/release/scripts/node_modules/transitive/package.json', { version: '1.9.0', main: 'index.js' });
  await assert.rejects(validateInstalledDependencies('/release', {
    readFileImpl, accessImpl,
  }), /lockfile|transitive/i);
  documents.set('/release/scripts/node_modules/transitive/package.json', { version: '2.0.0', main: 'index.js' });
  await assert.rejects(validateInstalledDependencies('/release', {
    readFileImpl,
    accessImpl: async (path) => {
      if (String(path).includes('/transitive/')) throw new Error('transitive entry is missing');
    },
    resolveDependencyImpl: async () => {},
  }), /entry|missing/i);
});

test('default network diagnostics report each feed independently for reachability, validity, and freshness', async () => {
  const localFeed = async (filename, generatedAt) => ({
    ...JSON.parse(await readFile(new URL(`../../${filename}`, import.meta.url), 'utf8')),
    generatedAt,
  });
  const feeds = new Map([
    ['feed-x.json', await localFeed('feed-x.json', '2026-09-06T00:00:00.000Z')],
    ['feed-podcasts.json', await localFeed('feed-podcasts.json', '2026-09-03T00:00:00.000Z')],
    ['feed-blogs.json', null],
    ['feed-newsletters.json', { invalid: true }],
    ['feed-academic.json', await localFeed('feed-academic.json', '2026-08-20T00:00:00.000Z')],
    ['feed-zh-tech.json', await localFeed('feed-zh-tech.json', '2026-09-06T00:00:00.000Z')],
  ]);
  const report = await runDiagnostics({
    network: true,
    offlineChecks: [],
    fetchJson: async (url) => feeds.get(new URL(url).pathname.split('/').at(-1)),
    now: NOW,
  });
  assert.equal(report.findings.length, 6);
  assert.deepEqual(report.findings.map(({ status }) => status), [
    'ok', 'warning', 'error', 'error', 'error', 'ok',
  ]);
  assert.equal(report.exitCode, 2);
});

test('network freshness messages distinguish future, invalid, and stale timestamps', async () => {
  const baseFeed = JSON.parse(await readFile(new URL('../../feed-x.json', import.meta.url), 'utf8'));
  for (const [generatedAt, expected] of [
    ['2027-09-06T12:00:00.000Z', /future/i],
    ['not-a-time', /invalid/i],
    ['2026-08-20T12:00:00.000Z', /more than seven days|stale/i],
  ]) {
    const report = await runDiagnostics({
      network: true,
      offlineChecks: [],
      fetchJson: async (url) => url.endsWith('/feed-x.json')
        ? { ...baseFeed, generatedAt }
        : null,
      now: NOW,
    });
    assert.match(report.findings.find(({ id }) => id === 'network:x').message, expected);
  }
});
