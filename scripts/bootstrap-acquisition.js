import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { devNull, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WHEEL_PATTERN = /^follow_up_acquisition-(.+)-py3-none-any\.whl$/;

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
  const homeDir = resolve(home ?? env.HOME ?? homedir());
  return join(homeDir, '.follow-builders', 'runtime.json');
}

/**
 * Identify the wheel `pip wheel` just wrote into `buildDir`.
 *
 * The built filename carries the PEP 440 normalization of `pyproject.toml`'s version,
 * which is not the same string as the product version (`0.4.0-beta.6` builds
 * `follow_up_acquisition-0.4.0b6-py3-none-any.whl`). Predicting that filename from a
 * constant duplicated the release version here and silently broke every bootstrap whose
 * version differed, so read back what was actually built instead.
 */
export async function locateBuiltWheel(buildDir) {
  const wheels = (await readdir(buildDir)).filter(entry => WHEEL_PATTERN.test(entry));
  if (wheels.length !== 1) {
    throw new Error(`expected exactly one built follow_up_acquisition wheel, found ${wheels.length}`);
  }
  return {
    path: join(buildDir, wheels[0]),
    version: WHEEL_PATTERN.exec(wheels[0])[1],
  };
}

export async function bootstrapAcquisition({
  home,
  env = process.env,
  spawn = spawnSync,
  python = null,
  packageRoot = PACKAGE_ROOT,
} = {}) {
  const resolved = python ?? resolvePython312({ spawn });
  if (!resolved) {
    throw new Error(
      'No Python 3.12 interpreter found. Install Python 3.12 before bootstrapping local acquisition.',
    );
  }

  const homeDir = resolve(home ?? env.HOME ?? homedir());
  const path = resolveBootstrapPath({ home: homeDir });
  await mkdir(dirname(path), { recursive: true });
  // A new directory preserves the last working runtime if an upgrade fails.
  const runtimeDir = await mkdtemp(join(dirname(path), 'runtime-'));
  const buildDir = await mkdtemp(join(tmpdir(), 'follow-up-wheel-'));
  const interpreter = join(runtimeDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const installEnv = { ...env, HOME: homeDir, PYTHONPATH: '', PYTHONHOME: '', PYTHONNOUSERSITE: '1' };
  // Only the new venv chooses installation destinations. Network overrides
  // remain available, but user/global pip configuration must not redirect writes.
  for (const key of ['PIP_TARGET', 'PIP_PREFIX', 'PIP_ROOT', 'PIP_USER']) delete installEnv[key];
  installEnv.PIP_CONFIG_FILE = devNull;
  const run = (command, args) => {
    const result = spawn(command, args, { cwd: buildDir, env: installEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const diagnostic = String(result.error?.message ?? result.stderr ?? result.stdout)
        .replace(/https?:\/\/\S+/gi, '[package index URL redacted]');
      throw new Error(`Acquisition installation failed: ${diagnostic}`);
    }
  };
  const pendingPath = join(runtimeDir, 'runtime.json.pending');
  try {
    const lockPath = join(packageRoot, 'requirements-acquisition.lock');
    const lock = await readFile(lockPath, 'utf8');
    run(resolved.interpreter, ['-m', 'venv', runtimeDir]);
    run(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--require-hashes', '-r', join(packageRoot, 'requirements-build.lock')]);
    run(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-build-isolation', '--require-hashes', '-r', lockPath]);
    run(interpreter, ['-m', 'pip', 'wheel', '--disable-pip-version-check', '--no-deps', '--no-build-isolation', '--wheel-dir', buildDir, packageRoot]);
    const wheel = await locateBuiltWheel(buildDir);
    run(interpreter, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', wheel.path]);
    run(interpreter, ['-m', 'pip', 'check']);
    run(interpreter, ['-I', '-c', 'import feedparser, trafilatura; from follow_up_acquisition.adapters import rss, web_publication']);
    run(interpreter, ['-I', '-m', 'follow_up_acquisition', 'doctor', '--json']);
    const payload = {
      schemaVersion: '1.0', interpreter,
      python: `${resolved.version.major}.${resolved.version.minor}.${resolved.version.patch}`,
      dependencies: [...lock.matchAll(/^([a-zA-Z0-9_.-]+==[^\s;]+)/gm)].map(match => match[1]),
      packageVersion: wheel.version,
    };
    await writeFile(pendingPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(pendingPath, path);
    return { path, payload };
  } catch (error) {
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
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
