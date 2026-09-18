import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { bootstrapAcquisition } from '../bootstrap-acquisition.js';

// v0.4 restricts source URLs to public HTTPS, so this smoke test serves its fixture over
// TLS on loopback with a certificate it issues itself into a temporary directory. Nothing
// secret is committed; the child process is told to trust the throwaway CA via SSL_CERT_FILE.
test('clean isolated installation collects HTTPS RSS and extracts Blog content outside checkout', {
  skip: process.env.RUN_RUNTIME_INSTALL_SMOKE !== '1', timeout: 300_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'follow-up-installed-smoke-'));
  const tls = await mkdtemp(join(tmpdir(), 'follow-up-installed-smoke-tls-'));
  const keyPath = join(tls, 'loopback-key.pem');
  const certPath = join(tls, 'loopback-cert.pem');
  const article = '<html><head><title>Runtime smoke article</title></head><body><article><h1>Runtime smoke article</h1><p>'
    + 'This is a detailed technical article about reliable software deployment and isolated runtime verification. '.repeat(20)
    + '</p></article></body></html>';
  let base;
  let server;
  try {
    await promisify(execFile)('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ]);
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    server = createServer({ key, cert }, (req, res) => {
      if (req.url === '/feed') {
        res.setHeader('Content-Type', 'application/rss+xml');
        res.end(`<rss version="2.0"><channel><title>Test</title><link>${base}</link><description>Test</description><item><title>Runtime smoke article</title><link>${base}/article</link><description>RSS body</description><pubDate>Wed, 09 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(article);
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `https://127.0.0.1:${server.address().port}`;

    const { payload } = await bootstrapAcquisition({ home });
    const env = {
      ...process.env, HOME: home, PYTHONPATH: '', PYTHONHOME: '', SSL_CERT_FILE: certPath,
    };
    const run = (args) => promisify(execFile)(payload.interpreter, ['-I', ...args], { cwd: home, env });
    const doctor = JSON.parse((await run(['-m', 'follow_up_acquisition', 'doctor', '--json'])).stdout);
    assert.equal(doctor.ok, true);
    assert.ok(doctor.registry.startsWith(home));
    const contract = await readFile(join(payload.interpreter, '../../share/follow-up-acquisition/contracts/signal-batch.schema.json'), 'utf8');
    assert.equal(JSON.parse(contract).type, 'object');

    const sources = [
      {
        id: 'blog:smoke-rss', name: 'Smoke RSS', channel: 'blogs', channel_policy: 'fixed',
        adapter: 'rss', requires_credentials: false, default_enabled: true,
        cadence: 'daily', budget: 3, input: { rss_url: `${base}/feed` }, legacy: { feed: null },
      },
      {
        id: 'blog:smoke-web', name: 'Smoke Web', channel: 'blogs', channel_policy: 'fixed',
        adapter: 'web-publication', requires_credentials: false, default_enabled: true,
        cadence: 'daily', budget: 3,
        input: {
          url: base, language: 'en', discovery: [{ type: 'rss', url: `${base}/feed` }],
          article_url_patterns: ['/article$'], exclude_url_patterns: [],
        },
        legacy: { feed: null },
      },
    ];
    const registry = join(home, 'sources.json');
    const output = join(home, 'batches');
    await writeFile(registry, JSON.stringify({ schema_version: '1.0', sources }));
    await run(['-m', 'follow_up_acquisition', 'run', '--registry', registry, '--output', output]);
    for (const [id, adapterId] of [['blog:smoke-rss', 'rss'], ['blog:smoke-web', 'web-publication']]) {
      const batch = JSON.parse(await readFile(join(output, `${id}.json`), 'utf8'));
      assert.equal(batch.adapter_id, adapterId);
      assert.equal(batch.source_status.status, 'ok');
      assert.equal(batch.items.length, 1);
    }
    const blogBatch = JSON.parse(await readFile(join(output, 'blog:smoke-web.json'), 'utf8'));
    assert.match(blogBatch.items[0].text, /reliable software deployment/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
    await rm(tls, { recursive: true, force: true });
  }
});
