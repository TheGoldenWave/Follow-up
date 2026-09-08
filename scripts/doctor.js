#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import {
  redactDiagnostics,
  runDiagnostics,
  summarizeDiagnostics,
} from './lib/diagnostics.js';

export const EX_USAGE = 64;
const USAGE = 'Usage: node scripts/doctor.js [--network] [--json]';

export function parseDoctorArgs(args) {
  const parsed = { network: false, json: false };
  for (const argument of args) {
    if (argument !== '--network' && argument !== '--json') {
      throw new Error(`Unknown argument: ${argument}. ${USAGE}`);
    }
    const key = argument.slice(2);
    if (parsed[key]) throw new Error(`Duplicate argument: ${argument}. ${USAGE}`);
    parsed[key] = true;
  }
  return parsed;
}

function renderHuman(report) {
  const lines = report.findings.map((finding) => (
    `${finding.id} [${finding.status.toUpperCase()}] (${finding.scope}${finding.blocking ? ', blocking' : ''}): ${finding.message ?? ''}`
  ));
  lines.push(`Summary: ${report.summary.healthy} healthy, ${report.summary.warnings} warning(s), ${report.summary.errors} error(s)`);
  return lines;
}

export async function runDoctor(args, {
  runDiagnosticsImpl = runDiagnostics,
  stdout = console.log,
  stderr = console.error,
  ...diagnosticOptions
} = {}) {
  let parsed;
  try {
    parsed = parseDoctorArgs(args);
  } catch (error) {
    stderr(`${error.message}\n${USAGE}`);
    return { exitCode: EX_USAGE };
  }
  const rawReport = await runDiagnosticsImpl({
    ...diagnosticOptions,
    network: parsed.network,
  });
  const calculated = summarizeDiagnostics(rawReport.findings ?? []);
  const report = redactDiagnostics({
    ...rawReport,
    summary: {
      healthy: calculated.healthy,
      warnings: calculated.warnings,
      errors: calculated.errors,
      localBlocking: calculated.localBlocking,
      networkDegraded: calculated.networkDegraded,
    },
    exitCode: calculated.exitCode,
  });
  if (parsed.json) stdout(JSON.stringify(report, null, 2));
  else for (const line of renderHuman(report)) stdout(line);
  return { exitCode: report.exitCode, report };
}

const isCli = process.argv[1]
  && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url;

if (isCli) {
  const result = await runDoctor(process.argv.slice(2));
  process.exitCode = result.exitCode;
}
