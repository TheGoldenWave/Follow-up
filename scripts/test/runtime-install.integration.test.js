import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { bootstrapAcquisition } from '../bootstrap-acquisition.js';

test('clean isolated installation collects RSS and extracts Blog content outside checkout', {
  skip: process.env.RUN_RUNTIME_INSTALL_SMOKE !== '1', timeout: 300_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'follow-up-installed-smoke-'));
  const article = '<html><head><title>Runtime smoke article</title></head><body><article><h1>Runtime smoke article</h1><p>'
    + 'This is a detailed technical article about reliable software deployment and isolated runtime verification. '.repeat(20)
    + '</p></article></body></html>';
  let base;
  const server = createServer((req, res) => {
    if (req.url === '/feed') {
      res.setHeader('Content-Type', 'application/rss+xml');
      res.end(`<rss version="2.0"><channel><title>Test</title><link>${base}</link><description>Test</description><item><title>Runtime smoke article</title><link>${base}/article</link><description>RSS body</description><pubDate>Wed, 09 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
    } else { res.setHeader('Content-Type', 'text/html'); res.end(article); }
  });
  try {
    const { payload } = await bootstrapAcquisition({ home });
    const env = { ...process.env, HOME: home, PYTHONPATH: '', PYTHONHOME: '' };
    const run = (args) => promisify(execFile)(payload.interpreter, ['-I', ...args], { cwd: home, env });
    const doctor = JSON.parse((await run(['-m', 'follow_up_acquisition', 'doctor', '--json'])).stdout);
    assert.equal(doctor.ok, true);
    assert.ok(doctor.registry.startsWith(home));
    const contract = await readFile(join(payload.interpreter, '../../share/follow-up-acquisition/contracts/signal-batch.schema.json'), 'utf8');
    assert.equal(JSON.parse(contract).type, 'object');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const sources = ['rss', 'web-publication'].map((adapter, index) => ({
      id: `blog:smoke-${index}`, name: 'Smoke', channel: 'blogs', channel_policy: 'fixed', adapter,
      requires_credentials: false, default_enabled: true, cadence: 'daily', budget: 3,
      input: { url: base, rss_url: `${base}/feed`, discovery: [{ type: 'rss', url: `${base}/feed` }] },
      legacy: { feed: null },
    }));
    const registry = join(home, 'sources.json');
    const output = join(home, 'batches');
    await writeFile(registry, JSON.stringify({ schema_version: '1.0', sources }));
    await run(['-m', 'follow_up_acquisition', 'run', '--registry', registry, '--output', output]);
    for (let index = 0; index < 2; index++) {
      const batch = JSON.parse(await readFile(join(output, `blog:smoke-${index}.json`), 'utf8'));
      assert.equal(batch.source_status.status, 'ok');
      assert.equal(batch.items.length, 1);
      if (index === 1) assert.match(batch.items[0].text, /reliable software deployment/);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
