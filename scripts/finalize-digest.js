#!/usr/bin/env node

import { randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import { validateSelectionAgainstRequest } from './digest-selection.js';
import {
  AtomicWriteCommittedError,
  writeJsonAtomic,
} from './prepare-digest.js';
import { sanitizeDiagnostic } from './source-status.js';
import { INPUT_BYTE_LIMITS, readJsonLimited } from './validate-digest-selection.js';

function periodLabel(frequency) {
  return frequency === 'weekly' ? '本周' : '今日';
}

function safeSourceName(value, fallback) {
  const sanitized = sanitizeDiagnostic(value || fallback)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(sanitized || fallback).slice(0, 80).join('');
}

function safePlainText(value) {
  return sanitizeDiagnostic(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/@/gu, '＠')
    .replace(/([\\_*[\]()`])/gu, '\\$1');
}

export function renderDigestMessage(artifact) {
  const lines = [safePlainText(artifact.message)];
  for (const [index, item] of artifact.items.entries()) {
    lines.push('', `${index + 1}. ${safePlainText(item.title)}`);
    lines.push(`来源: ${safePlainText(item.sourceId)} | 评分: ${item.scores.totalScore}`);
    lines.push(`理由: ${safePlainText(item.reason)}`);
    lines.push(item.link);
  }
  return `${lines.join('\n')}\n`;
}

function messageFor(status, frequency, itemCount, incompleteSources) {
  const period = periodLabel(frequency);
  const sourceNames = incompleteSources.slice(0, 3).map(({ sourceName }) => sourceName);
  const moreCount = Math.max(0, incompleteSources.length - sourceNames.length);
  const sourceLabel = sourceNames.length > 0
    ? `（${sourceNames.join('、')}${moreCount > 0 ? `等 ${incompleteSources.length} 个来源` : ''}）`
    : '';
  if (status === 'no-important-updates') return `${period}无重要更新`;
  if (status === 'incomplete-history') {
    return itemCount > 0
      ? `历史覆盖不完整${sourceLabel}，以下为${period}可确认的重要更新。`
      : `历史覆盖不完整${sourceLabel}，无法完成${period}重要性确认。`;
  }
  if (status === 'partial') {
    return itemCount > 0
      ? `部分来源检查不完整${sourceLabel}，以下为${period}已确认的重要更新。`
      : `部分来源检查不完整${sourceLabel}，无法完成${period}重要性确认。`;
  }
  return `${period}重要更新`;
}

export function finalizeDigest(request, selection) {
  const validation = validateSelectionAgainstRequest(request, selection);
  if (!validation.valid) throw new Error('selection manifest is invalid');
  const candidateById = new Map(
    request.eligibleCandidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const clusterById = new Map(selection.clusters.map((cluster) => [cluster.eventClusterId, cluster]));
  const items = selection.selectedEventClusterIds.map((eventClusterId) => {
    const cluster = clusterById.get(eventClusterId);
    const lead = candidateById.get(cluster.leadCandidateId);
    const corroborating = cluster.corroboratingCandidateIds.map((candidateId) => {
      const candidate = candidateById.get(candidateId);
      return {
        candidateId, sourceId: candidate.sourceId, title: candidate.title,
        link: candidate.canonicalUrl,
      };
    });
    return {
      eventClusterId,
      candidateId: lead.candidateId,
      channel: lead.channel,
      sourceId: lead.sourceId,
      title: lead.title,
      author: lead.author,
      publishedAt: lead.publishedAt,
      link: lead.canonicalUrl,
      scores: { ...cluster.scores },
      reason: cluster.selectionReason,
      corroborating,
    };
  });
  const status = !request.coverage.complete
    ? 'incomplete-history'
    : !request.sourceCompleteness.complete
      ? 'partial'
      : items.length > 0 ? 'ready' : 'no-important-updates';
  const incompleteSources = request.sourceStatuses
    .filter(({ status: sourceStatus }) => sourceStatus === 'partial' || sourceStatus === 'error')
    .slice(0, 20)
    .map(({ sourceId, channel, sourceName, status: sourceStatus }) => ({
      sourceId,
      channel,
      sourceName: safeSourceName(sourceName, sourceId),
      status: sourceStatus,
    }));
  const baseStats = request.contentStats ?? {
    candidateCount: request.eligibleCandidates.length,
    eligibleCount: request.eligibleCandidates.length,
    excludedCount: 0,
    selectedCount: 0,
  };
  const contentStats = { ...baseStats, selectedCount: items.length };
  return {
    schemaVersion: '1.0', status, digestId: request.digestId, requestHash: request.requestHash,
    frequency: request.frequency, generatedAt: selection.generatedAt,
    coverage: request.coverage, sourceCompleteness: request.sourceCompleteness,
    incompleteSources,
    contentStats,
    items, message: messageFor(status, request.frequency, items.length, incompleteSources),
  };
}

async function closeQuietly(handle) {
  try { await handle?.close(); } catch { /* Preserve the primary failure. */ }
}

async function rejectSymlink(path, fsImpl, allowMissing = false) {
  try {
    if ((await fsImpl.lstat(path)).isSymbolicLink()) throw new Error('unsafe symbolic link');
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return;
    throw error;
  }
}

async function writeDurableFile(path, contents, fsImpl) {
  let handle;
  try {
    handle = await fsImpl.open(path, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await closeQuietly(handle);
  }
}

async function fsyncDirectory(path, fsImpl) {
  const handle = await fsImpl.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function activateDigestGeneration(outputDir, artifact, message, {
  fsImpl = systemFs,
  randomUUID = systemRandomUUID,
} = {}) {
  const root = resolve(outputDir);
  const generations = join(root, 'generations');
  let stagingDir;
  let generationDir;
  let generation;
  let generationVisible = false;
  try {
    const candidateIds = artifact.items.flatMap((item) => [
      item.candidateId,
      ...(item.corroborating ?? []).map((candidate) => candidate.candidateId),
    ]);
    const eventClusterIds = artifact.items.map((item) => item.eventClusterId);
    await rejectSymlink(root, fsImpl, true);
    await fsImpl.mkdir(root, { recursive: true, mode: 0o700 });
    await rejectSymlink(root, fsImpl);
    await rejectSymlink(generations, fsImpl, true);
    await fsImpl.mkdir(generations, { recursive: true, mode: 0o700 });
    await rejectSymlink(generations, fsImpl);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      if (typeof token !== 'string' || !/^[a-z0-9-]+$/iu.test(token)) {
        throw new Error('invalid generation token');
      }
      generation = `${artifact.digestId}-${token}`;
      stagingDir = join(generations, `.staging-${generation}`);
      generationDir = join(generations, generation);
      await rejectSymlink(stagingDir, fsImpl, true);
      await rejectSymlink(generationDir, fsImpl, true);
      try {
        await fsImpl.mkdir(stagingDir, { mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === 2) throw error;
      }
    }

    await writeDurableFile(
      join(stagingDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, fsImpl,
    );
    await writeDurableFile(join(stagingDir, 'message.txt'), message, fsImpl);
    const manifest = {
      schemaVersion: '1.0',
      generation,
      digestId: artifact.digestId,
      requestHash: artifact.requestHash,
      candidateIds,
      eventClusterIds,
      artifact: 'artifact.json',
      message: 'message.txt',
    };
    await writeDurableFile(
      join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, fsImpl,
    );
    await fsyncDirectory(stagingDir, fsImpl);
    await fsImpl.rename(stagingDir, generationDir);
    generationVisible = true;
    await fsyncDirectory(generations, fsImpl);

    const active = {
      schemaVersion: '1.0', generation, digestId: artifact.digestId,
      requestHash: artifact.requestHash, candidateIds, eventClusterIds,
      artifact: 'artifact.json', message: 'message.txt',
    };
    try {
      await writeJsonAtomic(join(root, 'active.json'), active, {
        fsImpl, randomUUID, label: 'digest activation',
      });
    } catch (error) {
      if (error instanceof AtomicWriteCommittedError) throw error;
      await fsImpl.rm(generationDir, { recursive: true, force: true }).catch(() => {});
      generationVisible = false;
      throw error;
    }
    return { active, generationDir };
  } catch (error) {
    if (error instanceof AtomicWriteCommittedError) throw error;
    if (stagingDir) await fsImpl.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (generationVisible && generationDir) {
      await fsImpl.rm(generationDir, { recursive: true, force: true }).catch(() => {});
    }
    throw new Error('digest generation could not be activated', { cause: error });
  }
}

function parseOptions(argv) {
  return parseCommandLine(argv, {
    options: {
      request: { type: 'string' }, selection: { type: 'string' }, 'output-dir': { type: 'string' },
      output: { type: 'string' },
      'message-out': { type: 'string' },
    },
    validate({ values, positionals }) {
      if (positionals.length) throw new CommandLineUsageError('unexpected positional arguments');
      for (const name of ['request', 'selection']) {
        if (!values[name]) throw new CommandLineUsageError(`--${name} is required`);
        if (!isAbsolute(values[name])) throw new CommandLineUsageError(`--${name} must be absolute`);
      }
      if (!values['output-dir']) throw new CommandLineUsageError('--output-dir is required');
      if (!isAbsolute(values['output-dir'])) throw new CommandLineUsageError('--output-dir must be absolute');
      if (values.output || values['message-out']) {
        throw new CommandLineUsageError('--output and --message-out are replaced by --output-dir');
      }
    },
  }).values;
}

export async function main({
  argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr,
  fsImpl = systemFs, randomUUID = systemRandomUUID, limits = INPUT_BYTE_LIMITS,
} = {}) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return error.exitCode ?? EX_USAGE;
  }
  try {
    const request = await readJsonLimited(options.request, 'request', limits.requestBytes, fsImpl);
    if (basename(options.selection) !== `${request.digestId}.json`) {
      throw new Error('selection filename must match digestId');
    }
    const selection = await readJsonLimited(options.selection, 'selection', limits.selectionBytes, fsImpl);
    const artifact = finalizeDigest(request, selection);
    const activated = await activateDigestGeneration(
      options['output-dir'], artifact, renderDigestMessage(artifact), { fsImpl, randomUUID },
    );
    stdout.write(`${JSON.stringify({
      status: artifact.status,
      digestId: artifact.digestId,
      activePath: join(options['output-dir'], 'active.json'),
      generation: activated.active.generation,
    })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof AtomicWriteCommittedError) {
      stderr.write(`committed-but-uncertain: ${error.message}\n`);
      return 1;
    }
    const known = new Set([
      'request: invalid JSON', 'request: could not be read', 'request: input exceeds byte limit',
      'selection: invalid JSON', 'selection: could not be read', 'selection: input exceeds byte limit',
      'selection manifest is invalid', 'selection filename must match digestId',
      'digest generation could not be activated',
    ]);
    stderr.write(`preparation-failed: ${known.has(error.message) ? error.message : 'digest finalization failed'}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
