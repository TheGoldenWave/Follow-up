import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const EX_USAGE = 64;

export class CommandLineUsageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CommandLineUsageError';
    this.exitCode = EX_USAGE;
  }
}

export function isMainModule(metaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return pathToFileURL(realpathSync(resolve(argvPath))).href === metaUrl;
  } catch {
    return false;
  }
}

export function parseCommandLine(argv, {
  options = {},
  allowPositionals = false,
  validate,
} = {}) {
  try {
    const parsed = parseArgs({
      args: argv,
      options,
      allowPositionals,
      strict: true,
    });
    const result = {
      values: { ...parsed.values },
      positionals: [...parsed.positionals],
    };
    validate?.(result);
    return result;
  } catch (error) {
    if (error instanceof CommandLineUsageError) throw error;
    throw new CommandLineUsageError(error.message, { cause: error });
  }
}
