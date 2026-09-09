import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  computeCriticalFileHashes,
  computeTrackedContentDigest,
} from '../release/validate-release.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('../../', import.meta.url);
const buildScript = new URL('../release/build-release.sh', import.meta.url);
const productVersion = (await readFile(new URL('../../VERSION', import.meta.url), 'utf8')).trim();
const archiveName = `Follow-up-v${productVersion}.tar.gz`;
const checksumsName = `Follow-up-v${productVersion}-checksums.txt`;
const archivePrefix = `Follow-up-v${productVersion}`;

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

async function copyTrackedRepository(destination) {
  const root = repositoryRoot.pathname;
  const { stdout } = await run('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' });
  const tracked = stdout.toString().split('\0').filter(Boolean);

  // The test and implementation are uncommitted during their TDD cycle.
  for (const extra of [
    'scripts/release/build-release.sh',
    'scripts/test/release-build.test.js',
    '.github/workflows/release.yml',
  ]) {
    try {
      await stat(join(root, extra));
      if (!tracked.includes(extra)) tracked.push(extra);
    } catch {
      // The initial red run intentionally reaches this path.
    }
  }

  for (const path of tracked.sort()) {
    await mkdir(join(destination, path, '..'), { recursive: true });
    await cp(join(root, path), join(destination, path), { preserveTimestamps: true });
  }
}

async function createReleaseRepository(t, { installDependencies = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-release-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyTrackedRepository(root);
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.name', 'Release Test'], { cwd: root });
  await run('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: root });
  await run('git', ['add', '.'], { cwd: root });
  await run('git', ['commit', '-qm', 'release fixture'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-09-02T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-09-02T00:00:00Z',
    },
  });

  const manifestPath = join(root, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const criticalPaths = Object.keys(manifest.integrity.criticalFiles.files);
  manifest.integrity = {
    trackedContent: await computeTrackedContentDigest(root),
    criticalFiles: {
      algorithm: 'sha256',
      files: await computeCriticalFileHashes(root, criticalPaths),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const { stdout: manifestStatus } = await run(
    'git',
    ['status', '--porcelain', 'release-manifest.json'],
    { cwd: root },
  );
  if (manifestStatus.trim()) {
    await run('git', ['add', 'release-manifest.json'], { cwd: root });
    await run('git', ['commit', '-qm', 'record release integrity'], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-09-02T00:00:01Z',
        GIT_COMMITTER_DATE: '2026-09-02T00:00:01Z',
      },
    });
  }
  if (installDependencies) {
    await run('npm', ['ci'], {
      cwd: join(root, 'scripts'),
      env: { ...process.env, npm_config_cache: join(root, '.npm-cache') },
    });
  } else {
    await cp(
      join(repositoryRoot.pathname, 'scripts', 'node_modules'),
      join(root, 'scripts', 'node_modules'),
      { recursive: true },
    );
  }

  await mkdir(join(root, '.hermes'), { recursive: true });
  await mkdir(join(root, 'docker'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, '.hermes', 'private-plan.md'), 'not for release\n');
  await writeFile(join(root, 'docker', 'docker-compose.yml'), 'unsafe draft\n');
  await writeFile(join(root, '.env'), 'TOKEN=placeholder-secret\n');
  await writeFile(join(root, 'dist', 'development-output.txt'), 'not for release\n');
  await writeFile(join(root, 'docs', 'wechat-integration.md'), 'untracked draft\n');
  return root;
}

async function listArchive(archive) {
  const { stdout } = await run('tar', ['-tzf', archive]);
  return stdout.trim().split('\n');
}

async function treeDigest(root) {
  const entries = [];

  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)))) {
      const path = join(directory, child.name);
      const name = relative(root, path);
      if (child.isDirectory()) {
        entries.push(`d\0${name}\0`);
        await visit(path);
      } else {
        const mode = (await stat(path)).mode & 0o777;
        entries.push(`f\0${name}\0${mode.toString(8)}\0`);
        entries.push(await readFile(path));
        entries.push('\0');
      }
    }
  }

  await visit(root);
  const input = Buffer.concat(entries.map((entry) => Buffer.isBuffer(entry) ? entry : Buffer.from(entry)));
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

test('release build creates a deterministic tracked-only v0.2.0 archive and checksum', async (t) => {
  const root = await createReleaseRepository(t);
  const firstOutput = join(root, 'dist-first');
  const secondOutput = join(root, 'dist-second');

  await run('sh', [buildScript.pathname, 'HEAD', firstOutput], { cwd: root });
  await run('sh', [buildScript.pathname, 'HEAD', secondOutput], { cwd: root });

  const firstArchive = join(firstOutput, archiveName);
  const secondArchive = join(secondOutput, archiveName);
  assert.deepEqual(await readFile(firstArchive), await readFile(secondArchive));

  const checksum = await readFile(join(firstOutput, checksumsName), 'utf8');
  assert.match(checksum, new RegExp(`^[a-f0-9]{64}  ${archiveName}\\n$`));
  await run('shasum', ['-a', '256', '-c', basename(join(firstOutput, checksumsName))], {
    cwd: firstOutput,
  });

  const entries = await listArchive(firstArchive);
  assert.ok(entries.includes(`${archivePrefix}/VERSION`));
  assert.ok(entries.includes(`${archivePrefix}/release-manifest.json`));
  for (const forbidden of ['.hermes/', 'docker/', '.env', 'node_modules/', 'dist/', 'wechat-integration.md']) {
    assert.equal(entries.some((entry) => entry.includes(forbidden)), false, forbidden);
  }
});

test('reinstalling the same archive leaves existing user configuration and credentials byte-for-byte unchanged', async (t) => {
  const root = await createReleaseRepository(t);
  const output = join(root, 'release-output');
  await run('sh', [buildScript.pathname, 'HEAD', output], { cwd: root });

  const fixtureHome = await mkdtemp(join(tmpdir(), 'follow-up-home-'));
  const installRoot = await mkdtemp(join(tmpdir(), 'follow-up-install-'));
  t.after(() => rm(fixtureHome, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const userState = join(fixtureHome, '.follow-builders');
  await mkdir(join(userState, 'prompts'), { recursive: true });
  await writeFile(join(userState, 'config.json'), '{"language":"bilingual","onboardingComplete":true}\n');
  await writeFile(join(userState, 'prompts', 'digest-intro.md'), 'My private prompt.\n');
  await writeFile(join(userState, '.env'), 'TELEGRAM_BOT_TOKEN=placeholder-only\n');
  const before = await treeDigest(userState);

  const archive = join(output, archiveName);
  await run('tar', ['-xzf', archive, '-C', installRoot]);
  const program = join(installRoot, archivePrefix);
  await run('npm', ['ci'], {
    cwd: join(program, 'scripts'),
    env: { ...process.env, HOME: fixtureHome, npm_config_cache: join(root, '.npm-cache') },
  });
  await rm(join(program, 'scripts', 'node_modules'), { recursive: true, force: true });
  await run('tar', ['-xzf', archive, '-C', installRoot]);
  await run('npm', ['ci'], {
    cwd: join(program, 'scripts'),
    env: { ...process.env, HOME: fixtureHome, npm_config_cache: join(root, '.npm-cache') },
  });

  assert.equal(await treeDigest(userState), before);
  assert.notEqual(fixtureHome, homedir());
});

test('the exact archive installs and passes archive-supported validation and contracts without Git metadata', async (t) => {
  const root = await createReleaseRepository(t);
  const output = join(root, 'archive-validation-output');
  const installRoot = await mkdtemp(join(tmpdir(), 'follow-up-archive-validation-'));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  await run('sh', [buildScript.pathname, 'HEAD', output], { cwd: root });
  await run('tar', [
    '-xzf',
    join(output, archiveName),
    '-C',
    installRoot,
  ]);
  const program = join(installRoot, archivePrefix);
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...archiveEnvironment } = process.env;
  await assert.rejects(stat(join(program, '.git')));
  const preflight = await run('node', [
    'release/validate-release.js',
    '--archive-critical-only',
  ], {
    cwd: join(program, 'scripts'),
    env: archiveEnvironment,
  });
  assert.match(preflight.stdout, /critical file SHA-256 hashes are valid/i);
  await run('npm', ['ci'], {
    cwd: join(program, 'scripts'),
    env: { ...archiveEnvironment, npm_config_cache: join(root, '.npm-cache') },
  });

  const validation = await run('npm', ['run', 'validate-release:archive'], {
    cwd: join(program, 'scripts'),
    env: archiveEnvironment,
  });
  assert.match(validation.stdout, /tracked content digest is checkout-only/i);
  assert.match(validation.stdout, /Release metadata is valid/);

  const contracts = await run('npm', ['run', 'test:archive'], {
    cwd: join(program, 'scripts'),
    env: archiveEnvironment,
  });
  const contractOutput = `${contracts.stdout}\n${contracts.stderr}`;
  assert.match(contractOutput, /all six checked-in feeds use schemaVersion 1\.0/);
  assert.match(contractOutput, /installed release prompt is used/);
  assert.match(contractOutput, /repository release validator accepts/);
  assert.match(contractOutput, /fail 0/);
});

test('all three registered Skill paths execute a documented workflow with real fixtures', async (t) => {
  const root = await createReleaseRepository(t, { installDependencies: false });
  const output = join(root, 'platform-output');
  const installRoot = await mkdtemp(join(tmpdir(), 'follow-up-platform-install-'));
  const fixtureHome = await realpath(await mkdtemp(join(tmpdir(), 'follow-up-platform-home-')));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  t.after(() => rm(fixtureHome, { recursive: true, force: true }));
  await run('sh', [buildScript.pathname, 'HEAD', output], { cwd: root });
  await run('tar', ['-xzf', join(output, archiveName), '-C', installRoot]);
  const program = join(installRoot, archivePrefix);
  const codexHome = join(fixtureHome, '.codex');
  const claudeHome = join(fixtureHome, '.claude');
  const customSkill = join(fixtureHome, 'custom', 'follow-up');
  const commonEnv = {
    ...process.env, HOME: fixtureHome, CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  const registrations = [
    ['codex', join(codexHome, 'skills', 'follow-up'), []],
    ['claude-code', join(claudeHome, 'skills', 'follow-up'), []],
    ['custom', customSkill, ['--skill-dir', customSkill]],
  ];
  for (const [platform, skillRoot, extra] of registrations) {
    await run('node', [
      'scripts/install.js', '--platform', platform, ...extra, '--register',
    ], { cwd: program, env: commonEnv });
    const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
    const commandLines = skill.split('\n').filter((line) => (
      line.includes('FOLLOW_UP_SKILL_DIR=') && line.includes('/scripts/')
    ));
    const documentedEntrypoints = new Set(commandLines.flatMap((line) => {
      const match = /\/scripts\/([a-z-]+\.js)"/.exec(line);
      return match ? [match[1]] : [];
    }));
    for (const entrypoint of [
      'prepare-digest.js', 'finalize-digest.js', 'validate-digest-selection.js',
      'deliver.js', 'resolve-delivery.js', 'schedule-gate.js',
    ]) {
      assert.equal(documentedEntrypoints.has(entrypoint), true, `${platform}:${entrypoint}`);
    }
    const scheduleExample = commandLines.find((line) => line.includes('/schedule-gate.js'));
    assert.match(
      scheduleExample,
      /schedule-gate\.js" --config "\$HOME\/\.follow-builders\/config\.json"$/,
    );
    assert.doesNotMatch(scheduleExample, /--frequency|--destination/);

    const userDir = join(fixtureHome, '.follow-builders');
    const stateDir = join(userDir, 'state');
    await rm(stateDir, { recursive: true, force: true });
    await mkdir(stateDir, { recursive: true });
    const configPath = join(userDir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      onboardingComplete: false, enabledChannels: ['blogs'], delivery: { method: 'stdout' },
    }));
    const script = (name) => {
      assert.equal(documentedEntrypoints.has(name), true, name);
      return join(skillRoot, 'scripts', name);
    };

    await assert.rejects(
      run('node', [script('schedule-gate.js'), '--config', configPath], { env: commonEnv }),
      (error) => {
        const result = JSON.parse(error.stdout);
        return error.code === 1 && result.authorized === false
          && result.status === 'schedule-not-authorized';
      },
      `${platform}:schedule-gate`,
    );
    const deniedRequest = join(fixtureHome, `${platform}-denied-request.json`);
    await assert.rejects(
      run('node', [
        script('prepare-digest.js'), '--request-out', deniedRequest,
        '--frequency', 'daily', '--scheduled',
      ], { env: commonEnv }),
      (error) => error.code === 1 && /schedule-not-authorized/.test(error.stderr),
      `${platform}:prepare`,
    );
    await assert.rejects(stat(deniedRequest), /ENOENT/);

    await writeFile(configPath, JSON.stringify({
      onboardingComplete: true, enabledChannels: ['blogs'], delivery: { method: 'stdout' },
    }));
    const flowRoot = join(fixtureHome, `${platform}-flow`);
    await mkdir(flowRoot, { recursive: true });
    const requestPath = join(flowRoot, 'request.json');
    const selectionPath = join(
      flowRoot,
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.json',
    );
    const validatedDir = join(flowRoot, 'validated');
    await mkdir(validatedDir);
    const validatedPath = join(validatedDir, 'd'.repeat(64) + '.json');
    await cp(join(skillRoot, 'scripts', 'test', 'fixtures', 'curation', 'valid-request.json'), requestPath);
    await cp(join(skillRoot, 'scripts', 'test', 'fixtures', 'selections', 'valid-selection.json'), selectionPath);
    await run('node', [
      script('validate-digest-selection.js'), '--request', requestPath,
      '--selection', selectionPath, '--output', validatedPath,
    ], { env: commonEnv });
    assert.equal(JSON.parse(await readFile(validatedPath, 'utf8')).digestId, 'd'.repeat(64));

    const outputDir = join(flowRoot, 'output');
    const finalized = await run('node', [
      script('finalize-digest.js'), '--request', requestPath,
      '--selection', validatedPath, '--output-dir', outputDir,
    ], { env: commonEnv });
    assert.equal(JSON.parse(finalized.stdout).status, 'ready');
    const activePath = join(outputDir, 'active.json');
    assert.equal(JSON.parse(await readFile(activePath, 'utf8')).digestId, 'd'.repeat(64));

    const deliveryResult = join(flowRoot, 'delivery-result.json');
    const delivered = await run('node', [
      script('deliver.js'), '--active', activePath, '--destination', 'stdout',
      '--result-out', deliveryResult,
    ], { env: commonEnv });
    assert.match(delivered.stdout, /Model launch/);
    assert.equal(JSON.parse(await readFile(deliveryResult, 'utf8')).status, 'delivered');

    const attemptId = `review-${platform}`;
    const outboxModule = await import(pathToFileURL(
      join(skillRoot, 'scripts', 'delivery-outbox.js'),
    ).href);
    await outboxModule.reserveOutboxAttempt({
      schemaVersion: '1.0', type: 'pending', occurredAt: '2026-09-07T12:00:00.000Z',
      attemptId, digestId: `pending-${platform}`, frequency: 'daily',
      candidateIds: ['f'.repeat(64)], eventClusterIds: ['e'.repeat(64)],
      destinationType: 'stdout', messageHash: 'c'.repeat(64),
    }, { home: fixtureHome });
    const resolutionResult = join(flowRoot, 'resolution-result.json');
    await run('node', [
      script('resolve-delivery.js'), attemptId, 'delivered',
      '--result-out', resolutionResult,
    ], { env: commonEnv });
    assert.deepEqual(
      (({ status, action, attemptId: id }) => ({ status, action, attemptId: id }))(
        JSON.parse(await readFile(resolutionResult, 'utf8')),
      ),
      { status: 'resolved', action: 'delivered', attemptId },
    );
    const ledger = await readFile(join(stateDir, 'delivery-ledger.jsonl'), 'utf8');
    assert.match(ledger, new RegExp(`"attemptId":"${attemptId}"`));
    assert.match(ledger, /"type":"delivered"/);
  }
});

test('release workflow separates read-only build from guarded write-only publication', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const buildStart = workflow.indexOf('\n  build:');
  const publishStart = workflow.indexOf('\n  publish:');
  assert.ok(buildStart > 0);
  assert.ok(publishStart > buildStart);
  const build = workflow.slice(buildStart, publishStart);
  const publish = workflow.slice(publishStart);

  assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
  assert.match(workflow, /concurrency:\s*\n\s*group: .*github\.ref_name.*\n\s*cancel-in-progress: false/);
  assert.doesNotMatch(workflow.slice(0, buildStart), /contents: write/);

  assert.match(build, /permissions:\s*\n\s*contents: read/);
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /node-version: ['"]20['"]/);
  assert.match(build, /actions\/upload-artifact@/);
  assert.doesNotMatch(build, /contents: write|gh release create/);
  assert.match(build, /npm run validate-release/);
  assert.match(build, /npm run validate-feeds/);
  assert.match(build, /npm test/);
  assert.match(build, /npm run test:archive/);
  assert.match(build, /npm run validate-release:archive/);
  assert.match(build, /--archive-critical-only/);
  const archiveSmoke = build.slice(build.indexOf('archive-smoke'));
  assert.ok(archiveSmoke.indexOf('--archive-critical-only') < archiveSmoke.indexOf('npm ci'));
  assert.match(build, /build-release\.sh/);

  assert.match(publish, /needs: build/);
  assert.match(publish, /permissions:\s*\n\s*contents: write/);
  assert.match(publish, /actions\/download-artifact@/);
  assert.doesNotMatch(publish, /actions\/checkout|actions\/setup-node|npm (ci|test|run)/);
  assert.match(publish, /shasum -a 256 -c/);
  assert.match(publish, /cmp .*release-manifest\.json/);
  assert.match(publish, /RELEASE_IMMUTABILITY_CONFIRMED/);
  assert.match(publish, /repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags/);
  assert.match(publish, /git\/tags/);
  assert.match(publish, /GITHUB_SHA/);
  assert.match(publish, /gh release view/);
  assert.equal((workflow.match(/gh release create/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /--clobber|release upload .*--clobber/);
});

test('release workflow pins every action to the reviewed full commit SHA', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const expectedActions = new Map([
    ['actions/checkout', ['11d5960a326750d5838078e36cf38b85af677262', 'v4.4.0']],
    ['actions/setup-node', ['49933ea5288caeca8642d1e84afbd3f7d6820020', 'v4.4.0']],
    ['actions/upload-artifact', ['ea165f8d65b6e75b540449e92b4886f43607fa02', 'v4.6.2']],
    ['actions/download-artifact', ['d3f86a106a0bac45b974a628896c90dbdf5c8093', 'v4.3.0']],
  ]);
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*(.+))?$/gm)];

  assert.equal(uses.length, expectedActions.size);
  for (const [, action, revision, comment] of uses) {
    const [expectedRevision, expectedComment] = expectedActions.get(action) ?? [];
    assert.equal(revision, expectedRevision, action);
    assert.match(revision, /^[a-f0-9]{40}$/);
    assert.equal(comment, expectedComment, action);
  }
  assert.equal(uses.some(([, action]) => action === 'actions/download-artifact'), true);
});

test('canonical release design documents the implemented non-circular integrity model', async () => {
  const design = await readFile(
    new URL('../../docs/superpowers/specs/2026-09-02-version-release-upgrade-design.md', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(design, /repository tree identity/);
  assert.match(design, /sorted.*git ls-tree[\s\S]*excluding `release-manifest\.json`/i);
  assert.match(design, /critical(?: tracked)?-?file SHA-256/i);
  assert.match(design, /archive[\s\S]*critical file hashes[\s\S]*checksums/i);
});

test('reinstall and archive smoke tests use ordinary npm ci with isolated HOME', async () => {
  const source = await readFile(new URL(import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\['ci', '--ignore-scripts'\]/);
  assert.match(source, /HOME: fixtureHome/);

  const workflow = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\n\s+npm ci\n/);
  assert.doesNotMatch(workflow, /npm ci --ignore-scripts/);
});

test('installation docs use archive-safe validation commands after extraction', async () => {
  for (const path of ['README.md', 'README.zh-CN.md']) {
    const documentation = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.match(documentation, /npm run validate-release:archive/);
    assert.match(documentation, /--archive-critical-only/);
    assert.match(documentation, /releases\/download\/v0\.3\.0\/release-manifest\.json/);
    assert.match(documentation, /cmp release-manifest\.json/);
    assert.match(documentation, /npm run test:archive/);
    assert.match(documentation, /tracked content digest/i);
    assert.match(documentation, /RELEASE_IMMUTABILITY_CONFIRMED/);
    assert.match(documentation, /protect(?:s|ed)[\s\S]{0,40}v\*/i);
    assert.match(documentation, /immutable\s+releases/i);
    assert.match(documentation, /self-verif/i);
  }
});
