import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadActiveDigest } from '../delivery-message.js';

const id = (value) => createHash('sha256').update(value).digest('hex');

async function generationFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-active-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generation = 'generation-1';
  const generationDir = join(root, 'generations', generation);
  await mkdir(generationDir, { recursive: true });
  const artifact = {
    schemaVersion: '1.0', status: 'ready', digestId: 'digest-1', requestHash: id('request'),
    frequency: 'daily', generatedAt: '2026-09-06T08:00:00.000Z',
    contentStats: { candidateCount: 1, eligibleCount: 1, excludedCount: 0, selectedCount: 1 },
    items: [{ candidateId: id('candidate'), eventClusterId: id('cluster') }],
    ...overrides.artifact,
  };
  const active = {
    schemaVersion: '1.0', generation, digestId: artifact.digestId,
    requestHash: artifact.requestHash,
    candidateIds: artifact.items.map(({ candidateId }) => candidateId),
    eventClusterIds: artifact.items.map(({ eventClusterId }) => eventClusterId),
    artifact: 'artifact.json', message: 'message.txt', ...overrides.active,
  };
  const manifest = {
    schemaVersion: '1.0', generation, digestId: artifact.digestId,
    requestHash: artifact.requestHash, artifact: 'artifact.json', message: 'message.txt',
    candidateIds: artifact.items.map(({ candidateId }) => candidateId),
    eventClusterIds: artifact.items.map(({ eventClusterId }) => eventClusterId),
    ...overrides.manifest,
  };
  await writeFile(join(root, 'active.json'), `${JSON.stringify(active)}\n`);
  await writeFile(join(generationDir, 'artifact.json'), `${JSON.stringify(artifact)}\n`);
  await writeFile(join(generationDir, 'message.txt'), 'important digest\n');
  await writeFile(join(generationDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { activePath: join(root, 'active.json'), artifact, generationDir };
}

test('loadActiveDigest binds active, manifest, artifact, and rendered message', async (t) => {
  const fixture = await generationFixture(t);
  const loaded = await loadActiveDigest(fixture.activePath);
  assert.equal(loaded.digestId, 'digest-1');
  assert.equal(loaded.requestHash, id('request'));
  assert.deepEqual(loaded.candidateIds, [id('candidate')]);
  assert.deepEqual(loaded.eventClusterIds, [id('cluster')]);
  assert.equal(loaded.message, 'important digest\n');
});

test('loadActiveDigest rejects generation identity and selected-content mismatches', async (t) => {
  const wrongGeneration = await generationFixture(t, { manifest: { generation: 'other' } });
  await assert.rejects(loadActiveDigest(wrongGeneration.activePath), /generation.*match/i);

  const wrongRequest = await generationFixture(t, { manifest: { requestHash: id('other') } });
  await assert.rejects(loadActiveDigest(wrongRequest.activePath), /requestHash.*match/i);

  const wrongActiveCandidates = await generationFixture(t, {
    active: { candidateIds: [id('other-candidate')] },
  });
  await assert.rejects(loadActiveDigest(wrongActiveCandidates.activePath), /candidate.*match/i);

  const wrongManifestClusters = await generationFixture(t, {
    manifest: { eventClusterIds: [id('other-cluster')] },
  });
  await assert.rejects(loadActiveDigest(wrongManifestClusters.activePath), /cluster.*match/i);

  const duplicateCandidate = await generationFixture(t, {
    artifact: {
      contentStats: { candidateCount: 2, eligibleCount: 2, excludedCount: 0, selectedCount: 2 },
      items: [
        { candidateId: id('candidate'), eventClusterId: id('cluster') },
        { candidateId: id('candidate'), eventClusterId: id('cluster-2') },
      ],
    },
  });
  await assert.rejects(loadActiveDigest(duplicateCandidate.activePath), /candidate.*unique|selected/i);
});
