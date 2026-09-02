#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SAFE_VALUE = /(placeholder|example|replace[-_ ]?with|your[-_ ]|redacted|dummy|test[-_ ]?only|not[-_ ]?a[-_ ]?secret|<[^>]+>)/i;
const ASSIGNMENT = /(?:^|[\r\n"'])(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*|apiKey|accessToken|clientSecret|password)["']?\s*[:=]\s*["']?([^\s"',}]+)/gim;
const HIGH_CONFIDENCE = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g],
  ['openai-key', /\bsk-[A-Za-z0-9]{32,255}\b/g],
];

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function lineNumber(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

export function scanBuffer(path, buffer) {
  if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) return [];
  const text = buffer.toString('utf8');
  const findings = [];

  for (const [rule, pattern] of HIGH_CONFIDENCE) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ path, line: lineNumber(text, match.index), rule });
    }
  }

  ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    const value = match[1].replace(/["']$/, '');
    if (SAFE_VALUE.test(value)) continue;
    if (value.length >= 20 && entropy(value) >= 3.5) {
      findings.push({ path, line: lineNumber(text, match.index), rule: 'high-entropy-credential' });
    }
  }
  return findings;
}

async function visitDirectory(root, directory, excluded, findings) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)))) {
    if (entry.isDirectory() && excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visitDirectory(root, path, excluded, findings);
    } else if (entry.isFile()) {
      const info = await stat(path);
      if (info.size <= MAX_FILE_BYTES) {
        findings.push(...scanBuffer(relative(root, path), await readFile(path)));
      }
    }
  }
}

export async function scanDirectory(root, { excludedDirectories = ['node_modules', '.git', 'dist'] } = {}) {
  const rootPath = resolve(root);
  const findings = [];
  await visitDirectory(rootPath, rootPath, new Set(excludedDirectories), findings);
  return findings;
}

export async function scanGitTree(root, treeish = 'HEAD') {
  const rootPath = resolve(root);
  const { stdout } = await execFileAsync(
    'git',
    ['ls-tree', '-r', '-z', '--name-only', treeish],
    { cwd: rootPath, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 },
  );
  const findings = [];
  for (const path of stdout.toString('utf8').split('\0').filter(Boolean)) {
    const { stdout: contents } = await execFileAsync(
      'git',
      ['show', `${treeish}:${path}`],
      { cwd: rootPath, encoding: 'buffer', maxBuffer: MAX_FILE_BYTES + 1 },
    );
    findings.push(...scanBuffer(path, contents));
  }
  return findings;
}

export async function scanArchive(archivePath) {
  const archive = resolve(archivePath);
  const { stdout } = await execFileAsync(
    'tar',
    ['-tzf', archive],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  const findings = [];
  for (const path of stdout.split('\n').filter((entry) => entry && !entry.endsWith('/'))) {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      findings.push({ path, line: 0, rule: 'unsafe-archive-path' });
      continue;
    }
    const { stdout: contents } = await execFileAsync(
      'tar',
      ['-xOzf', archive, path],
      { encoding: 'buffer', maxBuffer: MAX_FILE_BYTES + 1 },
    );
    findings.push(...scanBuffer(path, contents));
  }
  return findings;
}

function printFindings(findings) {
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
  }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const [mode, value] = process.argv.slice(2);
  let findings;
  if (mode === '--tracked') findings = await scanGitTree(root, value ?? 'HEAD');
  else if (mode === '--archive' && value) findings = await scanArchive(value);
  else if (mode === '--directory' && value) findings = await scanDirectory(value);
  else {
    console.error('Usage: scan-secrets.js --tracked [treeish] | --archive <tar.gz> | --directory <path>');
    process.exit(2);
  }
  if (findings.length > 0) {
    printFindings(findings);
    process.exit(1);
  }
  console.log('No high-confidence secrets found.');
}
