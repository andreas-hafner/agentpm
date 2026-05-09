import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

import { ensureDir, pathExists, readTextFile, writeTextFile } from '@agentpm/fs';
import {
  GLOBAL_CONFIG_VERSION,
  MANIFEST_VERSION,
  type GlobalConfigFile,
  type InstallScope,
  type LocalInstallScope,
  type ManifestFile,
} from '@agentpm/shared';

export interface AgentPmPaths {
  homeDir: string;
  cacheDir: string;
  dbPath: string;
  globalConfigPath: string;
  manifestPath: string;
}

export function resolveAgentPmPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): AgentPmPaths {
  const homeDir = env.AGENTPM_HOME ?? path.join(os.homedir(), '.agentpm');
  return {
    homeDir,
    cacheDir: path.join(homeDir, 'cache'),
    dbPath: path.join(homeDir, 'agentpm.db'),
    globalConfigPath: path.join(homeDir, 'config.yaml'),
    manifestPath: path.join(cwd, 'agentpm.yaml'),
  };
}

export async function ensureAgentPmHome(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentPmPaths> {
  const paths = resolveAgentPmPaths(cwd, env);
  await ensureDir(paths.homeDir);
  await ensureDir(paths.cacheDir);
  return paths;
}

function parseYaml<T>(content: string): T {
  return yaml.load(content) as T;
}

function stringifyYaml(value: unknown): string {
  return yaml.dump(value, {
    noRefs: true,
    lineWidth: 100,
  });
}

export async function loadGlobalConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<GlobalConfigFile> {
  const paths = resolveAgentPmPaths(cwd, env);
  if (!(await pathExists(paths.globalConfigPath))) {
    return { version: GLOBAL_CONFIG_VERSION };
  }

  const parsed = parseYaml<GlobalConfigFile>(await readTextFile(paths.globalConfigPath));
  return parsed ?? { version: GLOBAL_CONFIG_VERSION };
}

export async function saveGlobalConfig(
  cwd: string,
  config: GlobalConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = await ensureAgentPmHome(cwd, env);
  await writeTextFile(paths.globalConfigPath, stringifyYaml(config));
}

export async function loadManifest(cwd: string): Promise<ManifestFile | null> {
  const manifestPath = path.join(cwd, 'agentpm.yaml');
  if (!(await pathExists(manifestPath))) {
    return null;
  }

  const parsed = parseYaml<ManifestFile>(await readTextFile(manifestPath));
  return parsed ?? null;
}

export async function saveManifest(cwd: string, manifest: ManifestFile): Promise<string> {
  const manifestPath = path.join(cwd, 'agentpm.yaml');
  await writeTextFile(manifestPath, stringifyYaml(manifest));
  return manifestPath;
}

export function createEmptyManifest(): ManifestFile {
  return {
    version: MANIFEST_VERSION,
    sources: [],
    installs: [],
  };
}

export function resolveScopeRoot(
  scope: InstallScope,
  cwd: string,
  globalConfig: GlobalConfigFile,
  workspaceRoot?: string,
): string {
  if (scope === 'global') {
    return os.homedir();
  }

  if (scope === 'project') {
    return cwd;
  }

  return workspaceRoot ?? globalConfig.defaults?.workspaceRoot ?? cwd;
}

export function isLocalManifestScope(scope: InstallScope): scope is LocalInstallScope {
  return scope === 'project' || scope === 'workspace';
}

