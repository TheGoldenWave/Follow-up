import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadActiveDigest, validateFinalDigestArtifact } from '../delivery-message.js';
import { renderDigestMessage } from '../finalize-digest.js';

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
    coverage: {
      frequency: 'daily', status: 'complete', complete: true,
      requestedInterval: { start: '2026-09-05T00:00:00.000Z', end: '2026-09-06T08:00:00.000Z' },
      actualInterval: { start: '2026-09-05T00:00:00.000Z', end: '2026-09-06T08:00:00.000Z' },
      bounds: { startInclusive: true, endInclusive: true }, reasons: [],
    },
    sourceCompleteness: {
      status: 'complete', complete: true, feedFresh: true, expectedSourceCount: 1,
      reportedSourceCount: 1, totalSourceCount: 1, okSourceCount: 1,
      noResultsSourceCount: 0, partialSourceCount: 0, errorSourceCount: 0,
      missingSourceCount: 0,
    },
    incompleteSources: [],
    contentStats: { candidateCount: 1, eligibleCount: 1, excludedCount: 0, selectedCount: 1 },
    items: [{
      candidateId: id('candidate'), eventClusterId: id('cluster'), channel: 'blogs',
      sourceId: 'blog:test', title: 'Important update', author: 'Author',
      publishedAt: '2026-09-06T07:00:00.000Z', link: 'https://example.com/update',
      scores: { impact: 20, relevance: 20, evidence: 20, novelty: 10, corroboration: 0, totalScore: 70 },
      reason: 'Relevant verified update.', corroborating: [],
    }],
    message: '今日重要更新',
    ...overrides.artifact,
  };
  const artifactText = `${JSON.stringify(artifact)}\n`;
  const message = overrides.message ?? renderDigestMessage(artifact);
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
    artifactHash: id(artifactText), messageHash: id(message),
    ...overrides.manifest,
  };
  await writeFile(join(root, 'active.json'), `${JSON.stringify(active)}\n`);
  await writeFile(join(generationDir, 'artifact.json'), artifactText);
  await writeFile(join(generationDir, 'message.txt'), message);
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
  assert.equal(loaded.message, renderDigestMessage(fixture.artifact));
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

  const unknownArtifact = await generationFixture(t, { artifact: { unexpected: true } });
  await assert.rejects(loadActiveDigest(unknownArtifact.activePath), /artifact.*unsupported|closed/i);

  const invalidStatus = await generationFixture(t, { artifact: { status: 'preparation-failed' } });
  await assert.rejects(loadActiveDigest(invalidStatus.activePath), /status|deliverable/i);

  const wrongMessageHash = await generationFixture(t, { manifest: { messageHash: id('other') } });
  await assert.rejects(loadActiveDigest(wrongMessageHash.activePath), /message.*hash/i);

  const inconsistentMessage = await generationFixture(t, { message: 'different text\n' });
  await assert.rejects(loadActiveDigest(inconsistentMessage.activePath), /message.*match|rendered/i);

  const duplicateCandidate = await generationFixture(t, {
    artifact: {
      contentStats: { candidateCount: 2, eligibleCount: 2, excludedCount: 0, selectedCount: 2 },
      items: [
        {
          candidateId: id('candidate'), eventClusterId: id('cluster'), channel: 'blogs',
          sourceId: 'blog:test', title: 'One', author: 'Author', publishedAt: null,
          link: 'https://example.com/one',
          scores: { impact: 20, relevance: 20, evidence: 20, novelty: 10, corroboration: 0, totalScore: 70 },
          reason: 'Reason one.', corroborating: [],
        },
        {
          candidateId: id('candidate'), eventClusterId: id('cluster-2'), channel: 'blogs',
          sourceId: 'blog:test', title: 'Two', author: 'Author', publishedAt: null,
          link: 'https://example.com/two',
          scores: { impact: 20, relevance: 20, evidence: 20, novelty: 10, corroboration: 0, totalScore: 70 },
          reason: 'Reason two.', corroborating: [],
        },
      ],
    },
  });
  await assert.rejects(loadActiveDigest(duplicateCandidate.activePath), /candidate.*unique|selected/i);
});

test('loadActiveDigest rejects a symlink in any active path component', async (t) => {
  const fixture = await generationFixture(t);
  const aliasRoot = await mkdtemp(join(tmpdir(), 'follow-up-active-alias-'));
  t.after(() => rm(aliasRoot, { recursive: true, force: true }));
  await symlink(fixture.activePath.slice(0, -'/active.json'.length), join(aliasRoot, 'linked'));
  await assert.rejects(loadActiveDigest(join(aliasRoot, 'linked', 'active.json')), /symbolic link|symlink/i);
});

test('final artifact semantic validation enforces score threshold and status priority', async (t) => {
  const { artifact } = await generationFixture(t);
  assert.throws(() => validateFinalDigestArtifact({
    ...structuredClone(artifact), items: [{
      ...artifact.items[0],
      scores: { impact: 10, relevance: 10, evidence: 10, novelty: 10, corroboration: 0, totalScore: 40 },
    }],
  }), /60|threshold|score/i);

  const readyWithIncompleteSources = structuredClone(artifact);
  readyWithIncompleteSources.sourceCompleteness.complete = false;
  readyWithIncompleteSources.sourceCompleteness.status = 'incomplete';
  assert.throws(() => validateFinalDigestArtifact(readyWithIncompleteSources), /ready|source.*complete/i);

  const partialWithCompleteSources = structuredClone(artifact);
  partialWithCompleteSources.status = 'partial';
  assert.throws(() => validateFinalDigestArtifact(partialWithCompleteSources), /partial|source.*incomplete/i);

  const incompleteWithoutHistoryGap = structuredClone(artifact);
  incompleteWithoutHistoryGap.status = 'incomplete-history';
  assert.throws(() => validateFinalDigestArtifact(incompleteWithoutHistoryGap), /history|coverage/i);

  const noUpdateWithIncompleteSources = structuredClone(artifact);
  noUpdateWithIncompleteSources.status = 'no-important-updates';
  noUpdateWithIncompleteSources.items = [];
  noUpdateWithIncompleteSources.contentStats.selectedCount = 0;
  noUpdateWithIncompleteSources.sourceCompleteness.complete = false;
  noUpdateWithIncompleteSources.sourceCompleteness.status = 'incomplete';
  assert.throws(() => validateFinalDigestArtifact(noUpdateWithIncompleteSources), /no-important|complete/i);
});
