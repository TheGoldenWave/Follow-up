import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanAcquisitionHistory } from '../lib/acquisition-retention.js';

test('raw staging expires and archived text is removed before metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acquisition-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['runs/old', 'staging/old']) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, 'blog:a.json'), JSON.stringify({ generated_at: '2026-09-01T00:00:00Z', items: [{ text: 'private body' }] }));
  }
  await cleanAcquisitionHistory(root, '2026-09-09T00:00:00Z');
  assert.equal(JSON.parse(await readFile(join(root, 'runs/old/blog:a.json'), 'utf8')).items[0].text, null);
  await assert.rejects(readFile(join(root, 'staging/old/blog:a.json')), { code: 'ENOENT' });
  await cleanAcquisitionHistory(root, '2027-01-01T00:00:00Z');
  await assert.rejects(readFile(join(root, 'runs/old/blog:a.json')), { code: 'ENOENT' });
});

test('cleanup expires candidate text regardless of selected acquisition mode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pool-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'candidate-pool.json');
  await writeFile(path, JSON.stringify({ schemaVersion: '1.0', continuousHistorySince: '2026-01-01T00:00:00Z', candidates: [
    { candidateId: 'a', title: 'Title', summarizationContent: 'old text', lastSeenAt: '2026-09-01T00:00:00Z' },
  ] }));
  await cleanAcquisitionHistory(root, '2026-09-09T00:00:00Z');
  const pool = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(pool.candidates[0].summarizationContent, '');
  assert.equal(pool.continuousHistorySince, '2026-06-11T00:00:00.000Z');
});
