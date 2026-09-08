import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_VERSION = '0.3.0';

export function parsePythonVersion(stdout) {
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(String(stdout).trim());
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function probePython(candidate, spawn = spawnSync) {
  const result = spawn(candidate, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return null;
  }
  return parsePythonVersion(result.stdout);
}

export function resolvePython312({
  candidates = ['python3.12', 'python3'],
  spawn = spawnSync,
} = {}) {
  for (const candidate of candidates) {
    const version = probePython(candidate, spawn);
    if (version && version.major === 3 && version.minor === 12) {
      return { interpreter: candidate, version };
    }
  }
  return null;
}

export function resolveBootstrapPath({ home, env = process.env } = {}) {
  const homeDir = home ?? env.HOME ?? homedir();
  return join(homeDir, '.follow-builders', 'runtime.json');
}

export async function bootstrapAcquisition({
  home,
  env = process.env,
  spawn = spawnSync,
  python = null,
} = {}) {
  const resolved = python ?? resolvePython312({ spawn });
  if (!resolved) {
    throw new Error(
      'No Python 3.12 interpreter found. Install Python 3.12 before bootstrapping local acquisition.',
    );
  }

  const homeDir = home ?? env.HOME ?? homedir();
  const path = join(homeDir, '.follow-builders', 'runtime.json');
  const payload = {
    schemaVersion: '1.0',
    interpreter: resolved.interpreter,
    python: `${resolved.version.major}.${resolved.version.minor}.${resolved.version.patch}`,
    // The acquisition foundation is standard-library only; dependency
    // installation arrives with the RSS and official-blog adapters.
    dependencies: [],
    packageVersion: PACKAGE_VERSION,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path, payload };
}

// Runnable directly: `node scripts/bootstrap-acquisition.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapAcquisition()
    .then(({ path }) => {
      console.log(`Acquisition runtime bootstrapped: ${path}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
