import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  computeCriticalFileHashes,
  computeTrackedContentDigest,
  EXPECTED_FEEDS,
  REQUIRED_CRITICAL_FILES,
  validateArchiveCriticalFiles,
  validateManifest,
  validateRelease,
} from '../release/validate-release.js';

const repositoryRoot = new URL('../../', import.meta.url);
const execFileAsync = promisify(execFile);
const validationMode = process.env.FOLLOW_UP_RELEASE_MODE === 'archive' ? 'archive' : 'checkout';

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repositoryRoot), 'utf8'));
}

async function createReleaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await readJson('release-manifest.json');
  const files = new Set([
    'VERSION',
    'CHANGELOG.md',
    'release-manifest.json',
    'contracts/release-manifest.schema.json',
    'scripts/package.json',
    'scripts/package-lock.json',
    ...Object.keys(manifest.integrity.criticalFiles.files),
  ]);
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), await readFile(new URL(file, repositoryRoot)));
  }
  return root;
}

test('repository release identity is frozen at version 0.3.1 on 2026-09-09', async () => {
  const version = (await readFile(new URL('VERSION', repositoryRoot), 'utf8')).trim();
  const packageJson = await readJson('scripts/package.json');
  const packageLock = await readJson('scripts/package-lock.json');
  const manifest = await readJson('release-manifest.json');
  const changelog = await readFile(new URL('CHANGELOG.md', repositoryRoot), 'utf8');
  const releaseDesign = await readFile(
    new URL('docs/superpowers/specs/2026-09-02-version-release-upgrade-design.md', repositoryRoot),
    'utf8',
  );

  assert.equal(version, '0.3.1');
  assert.equal(packageJson.name, 'follow-builders-scripts');
  assert.equal(
    packageJson.description,
    'Scripts for Follow-up - feed generation, digest preparation, and delivery',
  );
  assert.doesNotMatch(packageJson.description, /Follow Builders skill/i);
  assert.equal(packageJson.version, version);
  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[''].version, version);
  assert.equal(manifest.productVersion, version);
  assert.equal(manifest.releaseDate, '2026-09-09');
  assert.match(changelog, /^## \[0\.3\.1\] - 2026-09-09$/m);
  assert.match(releaseDesign, /^Release freeze date: 2026-09-07$/m);
});

test('manifest declares only implemented v0.3 capabilities', async () => {
  const manifest = await readJson('release-manifest.json');

  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.trustMode, 'github-tag-sha256');
  assert.equal(manifest.runtime.node, '>=20.0.0');
  assert.equal(manifest.acquisition.mode, 'centralized');
  assert.deepEqual(manifest.acquisition.feeds, EXPECTED_FEEDS);
  assert.deepEqual(manifest.capabilities, {
    officialBlogs: true,
    channelSelection: true,
    candidatePool: true,
    digestSelection: true,
    deliveryLedger: true,
    atMostOnceDelivery: true,
    installer: true,
    doctor: true,
    localAcquisition: true,
    sidecars: false,
    longTermFeedback: false,
    reports: false,
    paginatedFeed: false,
    explicitReadState: false,
    automaticRollback: false,
    updater: false,
  });
  assert.deepEqual(validateManifest(manifest, manifest.productVersion), []);
});

test('manifest records non-circular tracked content and critical-file integrity', {
  skip: validationMode === 'archive' ? 'tracked content digest is checkout-only' : false,
}, async () => {
  const manifest = await readJson('release-manifest.json');

  assert.equal(manifest.integrity.trackedContent.algorithm, 'git-ls-tree-sha256-v1');
  assert.match(manifest.integrity.trackedContent.digest, /^[a-f0-9]{64}$/);
  assert.equal(manifest.integrity.criticalFiles.algorithm, 'sha256');
  assert.equal(Object.hasOwn(manifest.integrity.criticalFiles.files, 'release-manifest.json'), false);
  const requiredCriticalFiles = [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'SKILL.md',
    'VERSION',
    'config/config-schema.json',
    'contracts/candidate-feed.schema.json',
    'contracts/central-feed.schema.json',
    'contracts/digest-curation-request.schema.json',
    'contracts/digest-selection.schema.json',
    'contracts/release-manifest.schema.json',
    'docs/project-progress.md',
    'docs/source-catalog.md',
    'docs/third-party/v0.1.0-dependencies.md',
    'prompts/curate-digest.md',
    'prompts/digest-intro.md',
    'prompts/summarize-blogs.md',
    'prompts/summarize-newsletter.md',
    'prompts/summarize-paper.md',
    'prompts/summarize-podcast.md',
    'prompts/summarize-tweets.md',
    'prompts/summarize-zh-sources.md',
    'prompts/translate.md',
    'scripts/candidate-feed-contract.js',
    'scripts/candidate-feed-store.js',
    'scripts/candidate-identity.js',
    'scripts/candidate-normalization.js',
    'scripts/command-line.js',
    'scripts/config-contract.js',
    'scripts/deliver.js',
    'scripts/delivery-ledger.js',
    'scripts/delivery-message.js',
    'scripts/delivery-outbox.js',
    'scripts/delivery-providers.js',
    'scripts/digest-candidates.js',
    'scripts/digest-selection-contract.js',
    'scripts/digest-selection.js',
    'scripts/digest-window.js',
    'scripts/doctor.js',
    'scripts/feed-contract.js',
    'scripts/finalize-digest.js',
    'scripts/install.js',
    'scripts/lib/diagnostics.js',
    'scripts/lib/install-worker.js',
    'scripts/lib/paths.js',
    'scripts/lib/skill-registration.js',
    'scripts/package-lock.json',
    'scripts/package.json',
    'scripts/prepare-digest.js',
    'scripts/release/build-release.sh',
    'scripts/release/check-provenance.js',
    'scripts/release/scan-secrets.js',
    'scripts/release/validate-release.js',
    'scripts/release/verify-dependency-licenses.js',
    'scripts/resolve-delivery.js',
    'scripts/schedule-gate.js',
    'scripts/source-registry.js',
    'scripts/source-status.js',
    'scripts/validate-digest-selection.js',
    'scripts/validate-feed-artifact.js',
  ];
  for (const path of requiredCriticalFiles) assert.ok(REQUIRED_CRITICAL_FILES.includes(path), path);
  for (const path of ['requirements-acquisition.lock', 'config/sources.json', 'scripts/collect-and-prepare.js', 'src/follow_up_acquisition/cli.py']) {
    assert.ok(REQUIRED_CRITICAL_FILES.includes(path), path);
  }
  for (const path of REQUIRED_CRITICAL_FILES) {
    assert.ok(Object.hasOwn(manifest.integrity.criticalFiles.files, path), path);
  }
  assert.deepEqual(
    manifest.integrity.trackedContent,
    await computeTrackedContentDigest(repositoryRoot),
  );
  assert.deepEqual(
    manifest.integrity.criticalFiles.files,
    await computeCriticalFileHashes(
      repositoryRoot,
      Object.keys(manifest.integrity.criticalFiles.files),
    ),
  );
});

test('frozen user documentation states the v0.2 product boundary in both languages', async () => {
  const documents = await Promise.all([
    'README.md',
    'README.zh-CN.md',
    'SKILL.md',
    'docs/source-catalog.md',
  ].map(async (path) => [path, await readFile(new URL(path, repositoryRoot), 'utf8')]));

  for (const [path, content] of documents) {
    assert.match(content, /set up follow-up/i, path);
    assert.match(content, /\/follow-up(?:\s|`|$)/i, path);
    assert.match(content, /~\/\.follow-builders\//, path);
    assert.match(content, /72\s*(?:hours?|小时)/i, path);
    assert.match(content, /60\s*(?:point|分|门槛|threshold)/i, path);
    assert.match(content, /6\s*[-–]\s*10/, path);
    assert.match(content, /partial/i, path);
    assert.match(content, /incomplete-history/i, path);
    assert.match(content, /weekly/i, path);
    assert.match(content, /(?:pushed,? unseen|已推未读)/i, path);
    assert.match(content, /(?:un pushed|unpushed|未推)/i, path);
    assert.match(content, /(?:delivery uncertain|投递不确定|不确定状态)/i, path);
    assert.match(content, /(?:no immediate official-site alerts|does not send immediate alerts|不会.*即时)/i, path);
  }

  const english = documents.find(([path]) => path === 'README.md')[1];
  const chinese = documents.find(([path]) => path === 'README.zh-CN.md')[1];
  for (const [path, content] of [['README.md', english], ['README.zh-CN.md', chinese]]) {
    assert.match(content, /(?:reinstall|重装)/i, path);
    assert.match(content, /(?:upgrade from v?0\.1|从 v?0\.1.*升级)/i, path);
    assert.match(content, /doctor/i, path);
    assert.match(content, /(?:today|今日).*no important updates|(?:this week|本周).*no important updates|今日无重要更新|本周无重要更新/i, path);
    assert.match(content, /(?:codex|claude-code|custom)/i, path);
    assert.match(content, /--archive-critical-only/, path);
  }
});

test('source catalog production Blog IDs exactly match the namespaced runtime config', async () => {
  const catalog = await readFile(new URL('docs/source-catalog.md', repositoryRoot), 'utf8');
  assert.doesNotMatch(catalog, /README[^\n]*Papers With Code/i);
  assert.match(
    catalog,
    /本目录[^\n]*Papers With Code[^\n]*Semantic Scholar[^\n]*会议论文入口[^\n]*候选[^\n]*当前学术采集实际只有 arXiv RSS/,
  );
  const productionSection = catalog.match(
    /^### 生产 Blog 来源\n([\s\S]*?)(?=^##\s)/m,
  )?.[1];
  assert.ok(productionSection, 'production Blog section');

  const catalogIds = [...productionSection.matchAll(/^\| `([^`]+)` \|/gm)]
    .map((match) => match[1]);
  const config = await readJson('config/feed-blogs.json');
  const configuredIds = config.sources.map((source) => source.id);

  assert.equal(catalogIds.length, 17);
  assert.equal(new Set(catalogIds).size, catalogIds.length);
  assert.ok(catalogIds.every((id) => /^blog:[a-z0-9-]+$/.test(id)));
  assert.deepEqual(
    catalogIds.toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    configuredIds.toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  );
});

test('tracked content digest changes for tracked add, remove, content, and mode changes', {
  skip: validationMode === 'archive' ? 'Git object mutation is checkout-only' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Integrity Test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'integrity@example.invalid'], { cwd: root });
  await writeFile(join(root, 'tracked.txt'), 'original\n');
  await writeFile(join(root, 'release-manifest.json'), '{}\n');
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  const baseline = await computeTrackedContentDigest(root);

  await writeFile(join(root, 'tracked.txt'), 'changed\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'content'], { cwd: root });
  const contentChanged = await computeTrackedContentDigest(root);

  await execFileAsync('git', ['update-index', '--chmod=+x', 'tracked.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'mode'], { cwd: root });
  const modeChanged = await computeTrackedContentDigest(root);

  await writeFile(join(root, 'added.txt'), 'added\n');
  await execFileAsync('git', ['add', 'added.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'add'], { cwd: root });
  const added = await computeTrackedContentDigest(root);

  await execFileAsync('git', ['rm', '-q', 'added.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'remove'], { cwd: root });
  const removed = await computeTrackedContentDigest(root);

  assert.notEqual(contentChanged.digest, baseline.digest);
  assert.notEqual(modeChanged.digest, contentChanged.digest);
  assert.notEqual(added.digest, modeChanged.digest);
  assert.equal(removed.digest, modeChanged.digest);
});

test('validator rejects malformed and mismatched product versions', async () => {
  const manifest = await readJson('release-manifest.json');

  assert.ok(validateManifest({ ...manifest, productVersion: 'v0.1' }, '0.1.0').some(
    (error) => error.includes('productVersion'),
  ));
  assert.ok(validateManifest(manifest, '0.1.1').some(
    (error) => error.includes('does not match VERSION'),
  ));
});

test('validator and schema reject non-Gregorian release dates', async (t) => {
  const manifest = await readJson('release-manifest.json');

  assert.ok(validateManifest({ ...manifest, releaseDate: '2026-02-30' }, '0.1.0').some(
    (error) => error.includes('releaseDate'),
  ));

  const root = await createReleaseFixture(t);
  manifest.releaseDate = '2026-02-30';
  await writeFile(
    join(root, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  assert.ok((await validateRelease(root)).some(
    (error) => error.includes('schema validation failed') && error.includes('releaseDate'),
  ));
});

test('validator rejects unsupported channel, trust mode, runtime, and acquisition mode', async () => {
  const manifest = await readJson('release-manifest.json');
  const invalidCases = [
    [{ ...manifest, channel: 'beta' }, 'channel'],
    [{ ...manifest, trustMode: 'unsigned' }, 'trustMode'],
    [{ ...manifest, runtime: { node: '>=18.0.0' } }, 'runtime.node'],
    [{ ...manifest, acquisition: { ...manifest.acquisition, mode: 'local' } }, 'acquisition.mode'],
  ];

  for (const [candidate, expectedField] of invalidCases) {
    assert.ok(validateManifest(candidate, '0.1.0').some(
      (error) => error.includes(expectedField),
    ));
  }
});

test('validator rejects missing feeds, unknown fields, and implemented planned capabilities', async () => {
  const manifest = await readJson('release-manifest.json');
  const withUnknownField = { ...manifest, updaterVersion: '0.1.0' };
  const withMissingFeed = {
    ...manifest,
    acquisition: { ...manifest.acquisition, feeds: EXPECTED_FEEDS.slice(0, -1) },
  };
  const withPlannedClaim = {
    ...manifest,
    capabilities: { ...manifest.capabilities, sidecars: true },
  };
  const withMissingCriticalFile = structuredClone(manifest);
  delete withMissingCriticalFile.integrity.criticalFiles.files['scripts/release/build-release.sh'];

  assert.ok(validateManifest(withUnknownField, '0.1.0').some(
    (error) => error.includes('unknown field'),
  ));
  assert.ok(validateManifest(withMissingFeed, '0.1.0').some(
    (error) => error.includes('six feeds'),
  ));
  assert.ok(validateManifest(withPlannedClaim, '0.1.0').some(
    (error) => error.includes('sidecars'),
  ));
  assert.ok(validateManifest(withMissingCriticalFile, '0.1.0').some(
    (error) => error.includes('required critical file')
      && error.includes('scripts/release/build-release.sh'),
  ));
});

test('repository release validator accepts the checked-in release metadata', async () => {
  assert.deepEqual(await validateRelease(repositoryRoot, { mode: validationMode }), []);
});

test('archive mode validates critical files without Git metadata and rejects tampering', async (t) => {
  const root = await createReleaseFixture(t);
  assert.deepEqual(await validateRelease(root, { mode: 'archive' }), []);

  const manifestPath = join(root, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.integrity.criticalFiles.files['scripts/package-lock.json'];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.ok((await validateArchiveCriticalFiles(root)).some(
    (error) => error.includes('required critical file')
      && error.includes('scripts/package-lock.json'),
  ));

  await writeFile(
    manifestPath,
    await readFile(new URL('release-manifest.json', repositoryRoot)),
  );
  await writeFile(join(root, 'SKILL.md'), 'tampered archive content\n');
  assert.ok((await validateRelease(root, { mode: 'archive' })).some(
    (error) => error.includes('critical file hash') && error.includes('SKILL.md'),
  ));
});

test('repository release validator rejects package, lockfile, and changelog version drift', async (t) => {
  const root = await createReleaseFixture(t);

  const packageJson = JSON.parse(await readFile(join(root, 'scripts/package.json'), 'utf8'));
  packageJson.version = '0.1.1';
  await writeFile(join(root, 'scripts/package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.1] - 2026-09-02\n');

  const errors = await validateRelease(root);
  assert.ok(errors.some((error) => error.includes('scripts/package.json')));
  assert.ok(errors.some((error) => error.includes('CHANGELOG.md')));

  const packageLock = JSON.parse(await readFile(join(root, 'scripts/package-lock.json'), 'utf8'));
  packageLock.version = '0.1.1';
  packageLock.packages[''].version = '0.1.1';
  await writeFile(join(root, 'scripts/package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`);

  assert.ok((await validateRelease(root)).some(
    (error) => error.includes('scripts/package-lock.json'),
  ));
});

test('repository validator applies the checked-in Draft 2020-12 schema', async (t) => {
  const root = await createReleaseFixture(t);
  const schemaPath = join(root, 'contracts/release-manifest.schema.json');
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  schema.properties.productVersion.const = '9.9.9';
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

  assert.ok((await validateRelease(root)).some(
    (error) => error.includes('schema validation failed') && error.includes('productVersion'),
  ));
});

test('schema rejects release note URLs outside the canonical GitHub release origin', async (t) => {
  const root = await createReleaseFixture(t);
  const manifestPath = join(root, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.releaseNotesUrl = 'https://example.com/releases/tag/v0.1.0';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.ok((await validateRelease(root)).some(
    (error) => error.includes('schema validation failed') && error.includes('releaseNotesUrl'),
  ));
});

test('repository validator requires changelog and manifest release dates to agree', async (t) => {
  const root = await createReleaseFixture(t);
  await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0] - 2026-09-01\n');

  assert.ok((await validateRelease(root)).some(
    (error) => error.includes('CHANGELOG.md') && error.includes('releaseDate'),
  ));
});

test('repository validator requires package and lockfile Node engines to match the manifest', async (t) => {
  const root = await createReleaseFixture(t);
  const packagePath = join(root, 'scripts/package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.engines.node = '>=22.0.0';
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const lockPath = join(root, 'scripts/package-lock.json');
  const packageLock = JSON.parse(await readFile(lockPath, 'utf8'));
  packageLock.packages[''].engines.node = '>=18.0.0';
  await writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

  const errors = await validateRelease(root);
  assert.ok(errors.some((error) => error.includes('scripts/package.json engines.node')));
  assert.ok(errors.some((error) => error.includes('scripts/package-lock.json engines.node')));
});
