import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXPECTED_FEEDS,
  validateManifest,
  validateRelease,
} from '../release/validate-release.js';

const repositoryRoot = new URL('../../', import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repositoryRoot), 'utf8'));
}

async function createReleaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'contracts'));

  const files = [
    'VERSION',
    'CHANGELOG.md',
    'release-manifest.json',
    'contracts/release-manifest.schema.json',
    'scripts/package.json',
    'scripts/package-lock.json',
  ];
  for (const file of files) {
    await writeFile(join(root, file), await readFile(new URL(file, repositoryRoot)));
  }
  return root;
}

test('repository release identity agrees on version 0.1.0', async () => {
  const version = (await readFile(new URL('VERSION', repositoryRoot), 'utf8')).trim();
  const packageJson = await readJson('scripts/package.json');
  const packageLock = await readJson('scripts/package-lock.json');
  const manifest = await readJson('release-manifest.json');
  const changelog = await readFile(new URL('CHANGELOG.md', repositoryRoot), 'utf8');

  assert.equal(version, '0.1.0');
  assert.equal(packageJson.version, version);
  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[''].version, version);
  assert.equal(manifest.productVersion, version);
  assert.match(changelog, /^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}$/m);
});

test('manifest describes only the stable centralized six-feed baseline', async () => {
  const manifest = await readJson('release-manifest.json');

  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.trustMode, 'github-tag-sha256');
  assert.equal(manifest.runtime.node, '>=20.0.0');
  assert.equal(manifest.acquisition.mode, 'centralized');
  assert.deepEqual(manifest.acquisition.feeds, EXPECTED_FEEDS);
  assert.deepEqual(manifest.capabilities, {
    localAcquisition: false,
    sidecars: false,
    feedbackState: false,
    updater: false,
  });
  assert.deepEqual(validateManifest(manifest, manifest.productVersion), []);
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

  assert.ok(validateManifest(withUnknownField, '0.1.0').some(
    (error) => error.includes('unknown field'),
  ));
  assert.ok(validateManifest(withMissingFeed, '0.1.0').some(
    (error) => error.includes('six feeds'),
  ));
  assert.ok(validateManifest(withPlannedClaim, '0.1.0').some(
    (error) => error.includes('sidecars'),
  ));
});

test('repository release validator accepts the checked-in release metadata', async () => {
  assert.deepEqual(await validateRelease(repositoryRoot), []);
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
