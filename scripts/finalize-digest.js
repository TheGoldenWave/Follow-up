#!/usr/bin/env node

import { randomUUID as systemRandomUUID } from 'node:crypto';
import * as systemFs from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandLineUsageError, EX_USAGE, parseCommandLine } from './command-line.js';
import { validateSelectionAgainstRequest } from './digest-selection.js';
import { writeJsonAtomic } from './prepare-digest.js';
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
    schemaVersion: '1.0', status, digestId: request.digestId,
    frequency: request.frequency, generatedAt: selection.generatedAt,
    coverage: request.coverage, sourceCompleteness: request.sourceCompleteness,
    incompleteSources,
    contentStats,
    items, message: messageFor(status, request.frequency, items.length, incompleteSources),
  };
}

function parseOptions(argv) {
  return parseCommandLine(argv, {
    options: {
      request: { type: 'string' }, selection: { type: 'string' }, output: { type: 'string' },
    },
    validate({ values, positionals }) {
      if (positionals.length) throw new CommandLineUsageError('unexpected positional arguments');
      for (const name of ['request', 'selection', 'output']) {
        if (!values[name]) throw new CommandLineUsageError(`--${name} is required`);
        if (!isAbsolute(values[name])) throw new CommandLineUsageError(`--${name} must be absolute`);
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
    const selection = await readJsonLimited(options.selection, 'selection', limits.selectionBytes, fsImpl);
    const artifact = finalizeDigest(request, selection);
    await writeJsonAtomic(options.output, artifact, { fsImpl, randomUUID, label: 'output' });
    stdout.write(`${JSON.stringify({ status: artifact.status, digestId: artifact.digestId })}\n`);
    return 0;
  } catch (error) {
    const known = new Set([
      'request: invalid JSON', 'request: could not be read', 'request: input exceeds byte limit',
      'selection: invalid JSON', 'selection: could not be read', 'selection: input exceeds byte limit',
      'selection manifest is invalid', 'output could not be written',
    ]);
    stderr.write(`preparation-failed: ${known.has(error.message) ? error.message : 'digest finalization failed'}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
