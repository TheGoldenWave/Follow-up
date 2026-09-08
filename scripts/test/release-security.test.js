import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { checkProvenance } from '../release/check-provenance.js';
import { verifyDependencyLicenses } from '../release/verify-dependency-licenses.js';
import { scanDirectory, scanGitTree } from '../release/scan-secrets.js';
import { loadSourceRegistry } from '../source-registry.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL('../../', import.meta.url);

test('secret scanner catches credentials in tracked files and extracted archives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-secret-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Secret Scan Test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'scan@example.invalid'], { cwd: root });
  const secret = ['Ab9xQ7mN4pL2', 'vR8sT6wY3kH5'].join('');
  await writeFile(join(root, 'config.txt'), `MODE=production\nSERVICE_API_KEY=${secret}\n`);
  await execFileAsync('git', ['add', 'config.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const trackedFindings = await scanGitTree(root, 'HEAD');
  const archiveFindings = await scanDirectory(root, { excludedDirectories: ['.git'] });
  assert.ok(trackedFindings.some((finding) => finding.path === 'config.txt'));
  assert.ok(archiveFindings.some((finding) => finding.path === 'config.txt'));
});

test('secret scanner permits documented placeholders and public integrity digests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-placeholder-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'example.env'), [
    'TELEGRAM_BOT_TOKEN=placeholder-only',
    'RESEND_API_KEY=replace-with-your-key',
    'PASSWORD=<YOUR_PASSWORD>',
    'SHA256=fd5e56dfd1ded427db1a42be345bd18dd8123b98bc55cd30ad9446ac538a7eb0',
    '',
  ].join('\n'));

  assert.deepEqual(await scanDirectory(root), []);
});

test('dependency license report exactly matches the lockfile and approved licenses', async () => {
  assert.deepEqual(await verifyDependencyLicenses(repositoryRoot), []);
  const report = await readFile(
    new URL('../../docs/third-party/v0.1.0-dependencies.md', import.meta.url),
    'utf8',
  );
  assert.match(report, /ajv \| 8\.20\.0 \| MIT/);
  assert.match(report, /dotenv \| 16\.6\.1 \| BSD-2-Clause/);
  assert.match(report, /signal-exit \| 3\.0\.7 \| ISC/);
});

test('dependency license verification rejects report drift and unapproved licenses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'follow-up-license-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'docs', 'third-party'), { recursive: true });
  const lock = JSON.parse(await readFile(new URL('../../scripts/package-lock.json', import.meta.url), 'utf8'));
  lock.packages['node_modules/ajv'].license = 'GPL-3.0-only';
  await writeFile(join(root, 'scripts', 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(root, 'docs', 'third-party', 'v0.1.0-dependencies.md'), 'stale report\n');

  const errors = await verifyDependencyLicenses(root);
  assert.ok(errors.some((error) => error.includes('unapproved license GPL-3.0-only')));
  assert.ok(errors.some((error) => error.includes('report does not match')));
});

test('provenance gate accepts maintainer-attested MIT authorization and project license', async () => {
  const errors = await checkProvenance(repositoryRoot);
  assert.deepEqual(errors, []);

  const notices = await readFile(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /zarazhangrui\/follow-builders/);
  assert.match(notices, /upstream GitHub.*no license/i);
  assert.match(notices, /maintainer explicitly confirmed on 2026-09-02/i);
  assert.match(notices, /maintainer attestation in this project release process/i);
  assert.match(notices, /MIT redistribution authorization/i);
  assert.match(notices, /redistribution authorization status:\s*`authorized`/i);
  assert.doesNotMatch(notices, /upstream (?:public )?repo(?:sitory)? (?:is|was) MIT/i);

  const license = await readFile(new URL('../../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Copyright \(c\) 2026 Zara Zhang/);
  assert.match(license, /Copyright \(c\) 2026 GoldenWave/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
});

test('v0.1.0 docs avoid unverified ClawHub and state the authorized MIT terms accurately', async () => {
  for (const path of ['README.md', 'README.zh-CN.md', 'SKILL.md']) {
    const content = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /clawhub install follow-builders/i, path);
  }
  for (const path of ['README.md', 'README.zh-CN.md']) {
    const content = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.match(content, /distributed under (?:the )?MIT|按 MIT 许可证分发/i, path);
    assert.match(content, /confirmed MIT authorization|已确认的 MIT 授权/i, path);
    assert.match(content, /\[LICENSE\]\(LICENSE\)/, path);
    assert.match(content, /\[THIRD_PARTY_NOTICES\.md\]\(THIRD_PARTY_NOTICES\.md\)/, path);
  }
});

test('v0.2 exposes only the follow-up user invocation while retaining migration paths and provenance', async () => {
  const skill = await readFile(new URL('../../SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /^name: follow-up$/m);
  for (const path of ['README.md', 'README.zh-CN.md', 'SKILL.md']) {
    const content = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.match(content, /set up follow-up/i, path);
    assert.match(content, /\/follow-up(?:\s|`|$)/i, path);
    assert.doesNotMatch(content, /set up follow builders/i, path);
    assert.doesNotMatch(
      content,
      /(?:invoke|run|type|输入|执行|调用)[^\n]{0,40}`?\/follow-builders(?:\s|`|$)/i,
      path,
    );
    assert.match(content, /~\/\.follow-builders\//, path);
  }
  const notices = await readFile(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /zarazhangrui\/follow-builders/);
});

test('SKILL uses one cross-platform immutable runtime root and records exact source counts', async () => {
  const skill = await readFile(new URL('../../SKILL.md', import.meta.url), 'utf8');
  const counts = {};
  for (const { channel } of await loadSourceRegistry()) {
    counts[channel] = (counts[channel] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    x: 30, podcasts: 10, blogs: 17, newsletters: 4, academic: 6, 'zh-tech': 3,
  });
  assert.doesNotMatch(skill, /CLAUDE_SKILL_DIR/);
  assert.match(
    skill,
    /FOLLOW_UP_SKILL_DIR[^\n]*\.follow-builders\/releases\/0\.2\.0/,
  );
  for (const entrypoint of [
    'prepare-digest.js', 'finalize-digest.js', 'validate-digest-selection.js',
    'deliver.js', 'resolve-delivery.js', 'schedule-gate.js',
  ]) {
    assert.match(skill, new RegExp(`FOLLOW_UP_SKILL_DIR[^\\n]*${entrypoint.replace('.', '\\.')}`));
  }
  const scheduleExample = skill.split('\n').find((line) => (
    line.includes('FOLLOW_UP_SKILL_DIR=') && line.includes('/schedule-gate.js')
  ));
  assert.match(
    scheduleExample,
    /schedule-gate\.js" --config "\$HOME\/\.follow-builders\/config\.json"$/,
  );
  assert.doesNotMatch(scheduleExample, /--frequency|--destination/);
  assert.match(skill, /30[^\n]*(?:X|构建者)/i);
  assert.match(skill, /10[^\n]*(?:Podcast|播客)/i);
  assert.match(skill, /17[^\n]*(?:Blog|官网)/i);
  assert.match(skill, /4[^\n]*Newsletter/i);
  assert.match(skill, /6[^\n]*(?:Academic|学术)/i);
  assert.match(skill, /3[^\n]*(?:Chinese|中文)/i);
  assert.match(skill, /Industry reports[^\n]*(?:planned|规划)/i);
});

test('v0.2 closure design is Chinese-first and the plan records local versus external completion', async () => {
  const design = await readFile(
    new URL('../../docs/superpowers/specs/2026-09-05-v0.2.0-product-closure-design.md', import.meta.url),
    'utf8',
  );
  const han = (design.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const latin = (design.match(/[A-Za-z]/gu) ?? []).length;
  assert.ok(han > 2500, `expected substantial Chinese design content, got ${han}`);
  assert.ok(han > latin * 0.55, `expected Chinese-first prose, got han=${han}, latin=${latin}`);
  for (const heading of ['目的', '用户入口', '版本范围', '状态机', '安装与信任模型', '验收标准']) {
    assert.match(design, new RegExp(`^## .*${heading}`, 'm'), heading);
  }

  const plan = await readFile(
    new URL('../../docs/superpowers/plans/2026-09-05-v0.2.0-product-closure.md', import.meta.url),
    'utf8',
  );
  for (let task = 1; task <= 12; task += 1) {
    const section = plan.split(new RegExp(`^### Task ${task + 1}：`, 'm'))[0]
      .split(new RegExp(`^### Task ${task}：`, 'm'))[1];
    assert.ok(section, `Task ${task}`);
    assert.doesNotMatch(section, /^- \[ \]/m, `Task ${task} has unfinished local work`);
  }
  assert.match(plan, /- \[x\] 运行完整 Node 测试/);
  assert.match(plan, /- \[ \] 推送 reviewed branch[^\n]*外部授权/);
  assert.match(plan, /- \[ \] 下载公开资产[^\n]*外部授权/);
});

test('release workflow runs secret, dependency-license, and provenance gates before upload', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const upload = workflow.indexOf('actions/upload-artifact@');
  assert.ok(upload > 0);
  for (const command of [
    'scan-secrets.js --tracked',
    'scan-secrets.js --archive',
    'verify-dependency-licenses.js',
    'check-provenance.js',
  ]) {
    const position = workflow.indexOf(command);
    assert.ok(position > 0 && position < upload, command);
  }
});
