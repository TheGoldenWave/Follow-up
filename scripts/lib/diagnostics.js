import * as systemFs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';

import { validateRelease } from '../release/validate-release.js';
import { resolveRuntimePaths } from './paths.js';
import { inspectSkillRegistration } from './skill-registration.js';

const STATUS = new Set(['ok', 'warning', 'error']);
const SCOPE = new Set(['local', 'network']);
const FRESH_MS = 48 * 60 * 60 * 1000;
const WARNING_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_NETWORK_BYTES = 16 * 1024 * 1024;
const DEFAULT_NETWORK_TIMEOUT_MS = 15_000;
const READ_CHUNK_BYTES = 64 * 1024;
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const CENTRAL_FEED_BASE = 'https://raw.githubusercontent.com/TheGoldenWave/Follow-up/main';
const CANDIDATE_FEED_FILE = 'feed-candidates.json';
const CENTRAL_FEED_FILES = Object.freeze([
  { category: 'x', filename: 'feed-x.json' },
  { category: 'podcasts', filename: 'feed-podcasts.json' },
  { category: 'blogs', filename: 'feed-blogs.json' },
  { category: 'newsletters', filename: 'feed-newsletters.json' },
  { category: 'academic', filename: 'feed-academic.json' },
  { category: 'zh-tech', filename: 'feed-zh-tech.json' },
]);
const SENSITIVE_KEY = /(?:credential|secret|token|cookie|password|authorization|email|interests?|selectionReason|configPath|skillDir|registrationPath|releaseRoot|homeDir|userDir|stateDir|releasesDir)/iu;

export function createFinding({ id, status, scope, blocking, message, evidence }) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('Diagnostic id is required');
  if (!STATUS.has(status)) throw new TypeError('Diagnostic status must be ok, warning, or error');
  if (!SCOPE.has(scope)) throw new TypeError('Diagnostic scope must be local or network');
  if (typeof blocking !== 'boolean') throw new TypeError('Diagnostic blocking must be boolean');
  return {
    id, status, scope, blocking,
    ...(message === undefined ? {} : { message }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

export function classifyFreshness(generatedAt, now = Date.now()) {
  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp)) return { status: 'error', ageMs: null, reason: 'invalid' };
  const ageMs = Number(now) - timestamp;
  if (ageMs < -FUTURE_SKEW_MS) return { status: 'error', ageMs, reason: 'future' };
  if (ageMs < 0) return { status: 'ok', ageMs: 0, reason: 'fresh' };
  if (ageMs <= FRESH_MS) return { status: 'ok', ageMs, reason: 'fresh' };
  if (ageMs <= WARNING_MS) return { status: 'warning', ageMs, reason: 'stale-warning' };
  return { status: 'error', ageMs, reason: 'stale' };
}

function redactString(value) {
  let output = value;
  output = output.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[redacted]');
  output = output.replace(/\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+[^\s;,]+/giu, '[redacted]');
  output = output.replace(/\bCookie\s*:\s*[^;\n]+(?:;[^\n]*)?/giu, '[redacted]');
  output = output.replace(/\b(token|secret|password|credential|cookie)\s*=\s*[^&\s;,]+/giu, '$1=[redacted]');
  output = output.replace(/https?:\/\/[^\s/]+/giu, (origin) => {
    try {
      const url = new URL(origin);
      return `${url.protocol}//${url.host}`;
    } catch { return '[redacted]'; }
  });
  output = output.replace(/([?&](?:token|secret|password|key|signature|credential)=[^&#\s]*)/giu, (part) => `${part.split('=')[0]}=[redacted]`);
  output = output.replace(/(["'])(?:\/(?!\/)|[A-Z]:\\)(?:(?!\1).)+\1/giu, '$1[redacted-path]$1');
  const pathBoundary = '(^|[\\s([{=:\'\"])';
  output = output.replace(new RegExp(`${pathBoundary}\\/(?!\\/)\\S[\\s\\S]*$`, 'u'), '$1[redacted-path]');
  output = output.replace(new RegExp(`${pathBoundary}[A-Z]:\\\\\\S[\\s\\S]*$`, 'iu'), '$1[redacted-path]');
  return output;
}

function redactValue(value, key) {
  if (key && SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey, redactValue(entryValue, entryKey),
    ]));
  }
  return value;
}

export function redactDiagnostics(value) {
  return redactValue(value);
}

export function summarizeDiagnostics(findings) {
  const summary = {
    healthy: findings.filter(({ status }) => status === 'ok').length,
    warnings: findings.filter(({ status }) => status === 'warning').length,
    errors: findings.filter(({ status }) => status === 'error').length,
    localBlocking: findings.filter(({ scope, blocking, status }) => (
      scope === 'local' && blocking && status === 'error'
    )).length,
    networkDegraded: findings.filter(({ scope, status }) => (
      scope === 'network' && status === 'error'
    )).length,
  };
  return {
    ...summary,
    exitCode: summary.localBlocking > 0 ? 1 : summary.networkDegraded > 0 ? 2 : 0,
  };
}

function failureFinding(id, scope, error) {
  return createFinding({
    id,
    status: 'error',
    scope,
    blocking: scope === 'local',
    message: error instanceof Error ? error.message : String(error),
  });
}

export async function readJsonBounded(path, maximum, fsImpl = systemFs) {
  let handle;
  try {
    handle = await fsImpl.open(path, READ_FLAGS);
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error('JSON input is not a regular file');
    if (initial.size > maximum) throw new Error('JSON input exceeds the diagnostic byte limit');
    const chunks = [];
    let total = 0;
    while (total <= maximum) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maximum - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum) throw new Error('JSON input exceeds the diagnostic byte limit');
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const final = await handle.stat();
    if (final.size !== initial.size || total !== initial.size) throw new Error('JSON input changed while reading');
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJson(path, readFileImpl, maximum = 16 * 1024 * 1024) {
  if (readFileImpl === systemFs.readFile) return readJsonBounded(path, maximum);
  const text = await readFileImpl(path, 'utf8');
  if (Buffer.byteLength(text) > maximum) throw new Error('JSON input exceeds the diagnostic byte limit');
  return JSON.parse(text);
}

export async function validateInstalledDependencies(releaseRoot, {
  readFileImpl = systemFs.readFile,
  accessImpl = systemFs.access,
  resolveDependencyImpl = (dependency) => createRequire(
    join(releaseRoot, 'scripts/package.json'),
  ).resolve(dependency),
} = {}) {
  const packageJson = await readJson(
    join(releaseRoot, 'scripts/package.json'), readFileImpl, 1024 * 1024,
  );
  const lock = await readJson(
    join(releaseRoot, 'scripts/package-lock.json'), readFileImpl, 16 * 1024 * 1024,
  );
  if (!lock.packages?.['']) throw new Error('Dependency lockfile is incomplete');
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (!lock.packages[`node_modules/${dependency}`]) {
      throw new Error(`Dependency lockfile is missing ${dependency}`);
    }
  }
  for (const [packagePath, locked] of Object.entries(lock.packages)) {
    if (!packagePath.startsWith('node_modules/')) continue;
    const installed = await readJson(
      join(releaseRoot, 'scripts', packagePath, 'package.json'), readFileImpl, 1024 * 1024,
    );
    if (typeof locked.version !== 'string' || installed.version !== locked.version) {
      throw new Error(`Installed dependency does not match the lockfile: ${packagePath.slice('node_modules/'.length)}`);
    }
    const exported = installed.exports?.['.'] ?? installed.exports;
    const selectExport = (value) => {
      if (typeof value === 'string') return value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      for (const key of ['node', 'import', 'require', 'default']) {
        const selected = selectExport(value[key]);
        if (selected) return selected;
      }
      return null;
    };
    const entry = installed.main ?? selectExport(exported) ?? 'index.js';
    if (typeof entry !== 'string' || entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error(`Installed dependency has an invalid entry: ${packagePath.slice('node_modules/'.length)}`);
    }
    await accessImpl(join(releaseRoot, 'scripts', packagePath, entry.replace(/^\.\//u, '')));
  }
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    await resolveDependencyImpl(dependency);
  }
}

function defaultOfflineChecks(options) {
  const {
    releaseRoot,
    configPath,
    platform,
    skillDir,
    userDir,
    home,
    env = process.env,
    nodeVersion = process.versions.node,
    readFileImpl = systemFs.readFile,
    accessImpl = systemFs.access,
    validateReleaseImpl = validateRelease,
    resolveDependencyImpl,
    validateConfigImpl,
    inspectRegistrationImpl = inspectSkillRegistration,
    validateFeedFilesImpl,
    readDeliveryLedgerImpl,
    deriveDeliveryStateImpl,
  } = options;
  let version;
  return [
    async () => {
      version = (await readFileImpl(join(releaseRoot, 'VERSION'), 'utf8')).trim();
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) throw new Error('VERSION is invalid');
      return createFinding({ id: 'version', status: 'ok', scope: 'local', blocking: false, message: `Product version ${version}` });
    },
    async () => {
      const errors = await validateReleaseImpl(releaseRoot, { mode: 'archive', verifyIntegrity: true });
      if (errors.length > 0) throw new Error(`Release manifest is inconsistent: ${errors.join('; ')}`);
      return createFinding({ id: 'manifest', status: 'ok', scope: 'local', blocking: false, message: 'Release manifest is consistent' });
    },
    async () => {
      const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
      if (!Number.isSafeInteger(major) || major < 20) throw new Error('Node.js 20 or newer is required');
      return createFinding({ id: 'node', status: 'ok', scope: 'local', blocking: false, message: `Node.js ${nodeVersion} is supported` });
    },
    async () => {
      const config = await readJson(configPath, readFileImpl, 256 * 1024);
      const validator = validateConfigImpl
        ?? (await import('../config-contract.js')).validateConfig;
      const result = validator(config);
      if (!result.valid) throw new Error(`Configuration is invalid: ${result.errors.join('; ')}`);
      return createFinding({ id: 'config', status: 'ok', scope: 'local', blocking: false, message: 'Configuration is valid' });
    },
    async () => {
      await validateInstalledDependencies(releaseRoot, {
        readFileImpl, accessImpl, resolveDependencyImpl,
      });
      return createFinding({ id: 'dependencies', status: 'ok', scope: 'local', blocking: false, message: 'Locked dependencies are installed' });
    },
    async () => {
      let platforms = platform ? [{ platform, skillDir }] : [];
      if (!platform) {
        let activeRegistration = false;
        try {
          const active = await readJson(join(userDir, 'active.json'), readFileImpl, 256 * 1024);
          const selectedPlatform = active?.registration?.platform;
          const selectedSkillDir = active?.registration?.skillDir;
          const validBuiltIn = selectedPlatform === 'codex' || selectedPlatform === 'claude-code';
          const validCustom = selectedPlatform === 'custom'
            && typeof selectedSkillDir === 'string' && isAbsolute(selectedSkillDir);
          if (validBuiltIn || validCustom) {
            activeRegistration = true;
            platforms.push({
              platform: selectedPlatform,
              ...(validCustom ? { skillDir: selectedSkillDir } : {}),
            });
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            // Registration probes remain isolated below; malformed metadata does not hide built-ins.
          }
        }
        if (!activeRegistration) {
          platforms.push({ platform: 'codex' }, { platform: 'claude-code' });
        }
      }
      let registered = false;
      for (const candidate of platforms) {
        try {
          const result = await inspectRegistrationImpl({
            platform: candidate.platform,
            skillDir: candidate.skillDir,
            releaseRoot, home, env,
          });
          if (result.status === 'registered') {
            registered = true;
            break;
          }
        } catch { /* A broken registration must not hide another valid target. */ }
      }
      if (!registered) throw new Error('Requested Skill registration is missing or invalid');
      return createFinding({ id: 'registration', status: 'ok', scope: 'local', blocking: false, message: 'Requested Skill registration is valid' });
    },
    async () => {
      const validator = validateFeedFilesImpl
        ?? (await import('../feed-contract.js')).validateFeedFiles;
      const errors = await validator({
        readJson: (filename) => readJson(join(releaseRoot, filename), readFileImpl, 128 * 1024 * 1024),
      });
      if (errors.length > 0) throw new Error(`Local Feed contract validation failed: ${errors.join('; ')}`);
      return createFinding({ id: 'feed-contract', status: 'ok', scope: 'local', blocking: false, message: 'Local Feed contracts are valid' });
    },
    async () => {
      const feed = await readJson(join(releaseRoot, CANDIDATE_FEED_FILE), readFileImpl, 128 * 1024 * 1024);
      const timestamp = Date.parse(feed.continuousHistorySince);
      if (!Number.isFinite(timestamp)) throw new Error('Candidate history boundary is invalid');
      const warning = feed.historyTruncated === true;
      return createFinding({
        id: 'candidate-history', status: warning ? 'warning' : 'ok', scope: 'local', blocking: false,
        message: warning ? 'Candidate history has recorded truncation' : 'Candidate history is continuous',
      });
    },
    async () => {
      const ledger = readDeliveryLedgerImpl && deriveDeliveryStateImpl
        ? { readDeliveryLedger: readDeliveryLedgerImpl, deriveDeliveryState: deriveDeliveryStateImpl }
        : await import('../delivery-ledger.js');
      const events = await ledger.readDeliveryLedger({ home, env });
      const state = ledger.deriveDeliveryState(events);
      const unresolved = [...state.attempts.values()].filter(({ resolution }) => !resolution).length
        + (state.unresolvedReplacementAttempts?.length ?? 0);
      return createFinding({
        id: 'unresolved-pending', status: unresolved > 0 ? 'warning' : 'ok', scope: 'local', blocking: false,
        message: unresolved > 0 ? `${unresolved} delivery attempt(s) require review` : 'No unresolved delivery attempts',
      });
    },
  ];
}

export async function fetchJsonBounded(url, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS,
  maxBytes = MAX_NETWORK_BYTES,
} = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Network diagnostic requires HTTPS');
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('Network diagnostic timed out'));
  }, timeoutMs);
  const withAbort = (promise) => new Promise((resolvePromise, reject) => {
    const abort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) {
      reject(controller.signal.reason);
      return;
    }
    controller.signal.addEventListener('abort', abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => {
      controller.signal.removeEventListener('abort', abort);
    });
  });
  try {
    const response = await fetchImpl(parsed.href, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) return null;
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Remote Feed exceeds the diagnostic byte limit');
    const reader = response.body?.getReader?.();
    let bytes;
    if (reader) {
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await withAbort(reader.read());
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error('Remote Feed exceeds the diagnostic byte limit');
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      bytes = Buffer.concat(chunks, total);
    } else {
      bytes = new Uint8Array(await withAbort(response.arrayBuffer()));
      if (bytes.byteLength > maxBytes) throw new Error('Remote Feed exceeds the diagnostic byte limit');
    }
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

function defaultNetworkChecks(options) {
  const fetchJson = options.fetchJson ?? ((url) => fetchJsonBounded(url, options));
  return CENTRAL_FEED_FILES.map(({ category, filename }) => async () => {
    const id = `network:${category}`;
    const feed = await fetchJson(`${CENTRAL_FEED_BASE}/${filename}`);
    if (!feed) throw new Error(`${category} Feed is unreachable`);
    const validateFeedImpl = options.validateFeedImpl
      ?? (await import('../feed-contract.js')).validateFeed;
    const validation = validateFeedImpl(feed, category);
    if (!validation.valid) throw new Error(`${category} Feed is invalid`);
    const freshness = classifyFreshness(feed.generatedAt, options.now ?? Date.now());
    return createFinding({
      id, status: freshness.status, scope: 'network', blocking: false,
      message: freshness.status === 'ok' ? `${category} Feed is reachable and fresh`
        : freshness.status === 'warning' ? `${category} Feed is reachable but stale`
          : freshness.reason === 'future' ? `${category} Feed timestamp is in the future`
            : freshness.reason === 'invalid' ? `${category} Feed timestamp is invalid`
              : `${category} Feed is more than seven days old`,
      evidence: { ageMs: freshness.ageMs },
    });
  });
}

export async function runDiagnostics(options = {}) {
  const runtimePaths = resolveRuntimePaths(options);
  const resolved = {
    ...options,
    userDir: runtimePaths.userDir,
    releaseRoot: options.releaseRoot ?? runtimePaths.releaseRoot,
    configPath: options.configPath ?? join(runtimePaths.userDir, 'config.json'),
  };
  const offlineChecks = options.offlineChecks ?? defaultOfflineChecks(resolved);
  const findings = [];
  for (const check of offlineChecks) {
    try { findings.push(await check()); }
    catch (error) { findings.push(failureFinding(check.id ?? inferCheckId(findings.length), 'local', error)); }
  }
  if (options.network) {
    const networkChecks = options.networkChecks ?? defaultNetworkChecks(resolved);
    for (const check of networkChecks) {
      try { findings.push(await check()); }
      catch (error) {
        const index = findings.filter(({ scope }) => scope === 'network').length;
        const category = CENTRAL_FEED_FILES[index]?.category ?? `check-${index + 1}`;
        findings.push(failureFinding(check.id ?? `network:${category}`, 'network', error));
      }
    }
  }
  const summary = summarizeDiagnostics(findings);
  return redactDiagnostics({
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    findings,
    summary: {
      healthy: summary.healthy,
      warnings: summary.warnings,
      errors: summary.errors,
      localBlocking: summary.localBlocking,
      networkDegraded: summary.networkDegraded,
    },
    exitCode: summary.exitCode,
  });
}

function inferCheckId(index) {
  return ['version', 'manifest', 'node', 'config', 'dependencies', 'registration',
    'feed-contract', 'candidate-history', 'unresolved-pending'][index] ?? `local:${index + 1}`;
}
