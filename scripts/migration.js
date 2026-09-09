#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isMainModule } from './command-line.js';
import { loadMigrationState, updateMigrationState, recordReview, switchSource, applyRollbacks, sourceVerdict } from './lib/migration-state.js';

export async function main({ argv = process.argv.slice(2), userDir = join(homedir(), '.follow-builders'), now = new Date().toISOString(), stdout = process.stdout } = {}) {
  const [command = 'inspect', sourceId, evidencePath, ...extra] = argv;
  if (extra.length || !['inspect', 'review', 'cutover', 'reset'].includes(command) || (command !== 'inspect' && !sourceId) || (command === 'review' && !evidencePath) || (command !== 'review' && evidencePath)) throw new Error('Usage: migration.js inspect [source] | review <source> <evidence.json> | cutover <source> | reset <source>');
  const path = join(userDir, 'acquisition', 'migration.json');
  let state;
  if (command === 'inspect') state = await loadMigrationState(path);
  else if (command === 'review') {
    const review = JSON.parse(await readFile(evidencePath, 'utf8'));
    state = await updateMigrationState(path, state => applyRollbacks(recordReview(state, sourceId, review), { now }));
  } else state = await updateMigrationState(path, state => switchSource(state, sourceId, { input: command === 'cutover' ? 'local' : 'central', now }));
  if (sourceId && !Object.hasOwn(state.sources, sourceId)) throw new Error('source observation is unavailable');
  const sources = Object.fromEntries(Object.entries(state.sources).filter(([id]) => !sourceId || id === sourceId).map(([id, source]) => [id, { ...source, ...sourceVerdict(source, now) }]));
  stdout.write(`${JSON.stringify({ schemaVersion: '1.0', sources }, null, 2)}\n`);
  return 0;
}
if (isMainModule(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
