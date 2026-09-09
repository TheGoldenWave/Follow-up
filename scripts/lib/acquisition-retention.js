import { readdir, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../prepare-digest.js';
import { updateLocalPool } from './local-candidate-store.js';

const DAY = 86_400_000;
async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Called under the collection lock; never traverse symlinks.
export async function cleanAcquisitionHistory(root, now) {
  const timestamp = Date.parse(now);
  const poolPath = join(root, 'candidate-pool.json');
  try {
    if ((await lstat(poolPath)).isSymbolicLink()) throw new Error('unsafe acquisition pool');
    const pool = JSON.parse(await readFile(poolPath, 'utf8'));
    await writeJsonAtomic(poolPath, updateLocalPool(pool, { candidates: [], sourceStatuses: [] }, now), { label: 'expired candidate pool' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const area of ['staging', 'runs']) {
    const base = join(root, area);
    try { if ((await lstat(base)).isSymbolicLink()) throw new Error('unsafe acquisition history'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const run of await entries(base)) {
      if (!run.isDirectory() || run.isSymbolicLink()) continue;
      const directory = join(base, run.name);
      if (area === 'staging') { await rm(directory, { recursive: true, force: true }); continue; }
      for (const file of await entries(directory)) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const path = join(directory, file.name);
        const batch = JSON.parse(await readFile(path, 'utf8'));
        const age = timestamp - Date.parse(batch.generated_at);
        if (!Number.isFinite(age)) throw new Error('invalid acquisition history timestamp');
        if (age > 90 * DAY) await rm(path);
        else if (age > 7 * DAY && batch.items?.some(item => item.text)) {
          batch.items = batch.items.map(item => ({ ...item, text: null }));
          await writeJsonAtomic(path, batch, { label: 'expired acquisition text' });
        }
      }
      if ((await entries(directory)).length === 0) await rm(directory, { recursive: true });
    }
  }
}
