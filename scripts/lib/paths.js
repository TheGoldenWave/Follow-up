import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RELEASE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function resolveRuntimePaths({
  home,
  env = process.env,
  releaseRoot = DEFAULT_RELEASE_ROOT,
} = {}) {
  const homeDir = home ?? env.HOME ?? homedir();
  const userDir = join(homeDir, '.follow-builders');
  return {
    homeDir,
    userDir,
    stateDir: join(userDir, 'state'),
    releasesDir: join(userDir, 'releases'),
    releaseRoot,
  };
}

export function resolveSkillRegistrationPath(platform, {
  home,
  env = process.env,
  skillDir,
} = {}) {
  const homeDir = home ?? env.HOME ?? homedir();
  if (platform === 'codex') {
    return join(env.CODEX_HOME || join(homeDir, '.codex'), 'skills', 'follow-up');
  }
  if (platform === 'claude-code') {
    return join(env.CLAUDE_CONFIG_DIR || join(homeDir, '.claude'), 'skills', 'follow-up');
  }
  if (platform === 'custom') {
    if (typeof skillDir !== 'string' || !isAbsolute(skillDir)) {
      throw new Error('Custom Skill registration requires an absolute skillDir path');
    }
    return skillDir;
  }
  throw new Error(`Unknown Skill platform: ${platform}`);
}
