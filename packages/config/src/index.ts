import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from '@agentpm/fs';
import {
  GLOBAL_CONFIG_VERSION,
  MANIFEST_VERSION,
  type GlobalConfigFile,
  type InstallScope,
  type LoadedProjectConfig,
  type LocalInstallScope,
  type ManifestFile,
  type ManifestInstallSpec,
  type ProjectConfigFile,
  type ProjectSkillSpec,
  type ProjectSourceSpec,
} from '@agentpm/shared';

export const PROJECT_CONFIG_FILENAME = 'agentpm.yaml';
export const LOCAL_PROJECT_CONFIG_FILENAME = '.agentpmrc';

export interface AgentPmPaths {
  homeDir: string;
  cacheDir: string;
  dbPath: string;
  globalConfigPath: string;
  manifestPath: string;
}

export function resolveAgentPmPaths(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentPmPaths {
  const homeDir = env.AGENTPM_HOME ?? path.join(os.homedir(), '.agentpm');
  return {
    homeDir,
    cacheDir: path.join(homeDir, 'cache'),
    dbPath: path.join(homeDir, 'agentpm.db'),
    globalConfigPath: path.join(homeDir, 'config.yaml'),
    manifestPath: path.join(cwd, PROJECT_CONFIG_FILENAME),
  };
}

export async function ensureAgentPmHome(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentPmPaths> {
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

export async function loadGlobalConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GlobalConfigFile> {
  const paths = resolveAgentPmPaths(cwd, env);
  if (!(await pathExists(paths.globalConfigPath))) {
    return { version: GLOBAL_CONFIG_VERSION };
  }

  const parsed = parseYaml<GlobalConfigFile>(
    await readTextFile(paths.globalConfigPath),
  );
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
  const manifestPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  if (!(await pathExists(manifestPath))) {
    return null;
  }

  const parsed = parseYaml<Record<string, unknown>>(
    await readTextFile(manifestPath),
  );
  return parsed ? normalizeProjectConfig(parsed) : null;
}

export async function saveManifest(
  cwd: string,
  manifest: ManifestFile,
): Promise<string> {
  const manifestPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  await writeTextFile(manifestPath, stringifyYaml(manifest));
  return manifestPath;
}

function normalizeSourceSpec(
  source: ProjectSourceSpec,
): ManifestFile['sources'][number] {
  if (typeof source === 'string') {
    return { locator: source };
  }
  return source;
}

function normalizeSkillSpec(
  skill: ProjectSkillSpec,
  defaultScope: LocalInstallScope,
): ManifestInstallSpec {
  if (typeof skill === 'string') {
    return {
      name: skill,
      items: [skill],
      scope: defaultScope,
    };
  }

  return {
    name: skill.name,
    source: skill.source,
    items: skill.items && skill.items.length > 0 ? skill.items : [skill.name],
    scope: skill.scope ?? defaultScope,
    ref: skill.ref,
    revision: skill.revision,
    adapter: skill.adapter,
    workspaceRoot: skill.workspaceRoot,
  };
}

export function projectConfigToManifest(
  config: ProjectConfigFile,
): ManifestFile {
  const defaultScope = config.scope ?? 'project';
  return {
    version: config.version ?? MANIFEST_VERSION,
    sources: (config.sources ?? []).map((source) =>
      normalizeSourceSpec(source),
    ),
    installs: (config.skills ?? []).map((skill) =>
      normalizeSkillSpec(skill, defaultScope),
    ),
  };
}

function looksLikeManifestFile(value: Record<string, unknown>): boolean {
  return Array.isArray(value.installs);
}

function normalizeProjectConfig(value: Record<string, unknown>): ManifestFile {
  if (looksLikeManifestFile(value)) {
    return {
      version:
        typeof value.version === 'number' ? value.version : MANIFEST_VERSION,
      sources: Array.isArray(value.sources)
        ? (value.sources as ProjectSourceSpec[]).map((source) =>
            normalizeSourceSpec(source),
          )
        : [],
      installs: Array.isArray(value.installs)
        ? (value.installs as ManifestInstallSpec[]).map((install) => ({
            ...install,
            items:
              Array.isArray(install.items) && install.items.length > 0
                ? install.items
                : [install.name],
            scope: install.scope ?? 'project',
          }))
        : [],
    };
  }

  return projectConfigToManifest(value);
}

function mergeManifests(
  canonical: ManifestFile,
  local: ManifestFile,
): ManifestFile {
  return {
    version: canonical.version,
    sources: [...canonical.sources, ...local.sources],
    installs: [...canonical.installs, ...local.installs],
  };
}

export async function loadProjectConfig(
  cwd: string,
): Promise<LoadedProjectConfig | null> {
  const configPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  if (await pathExists(configPath)) {
    const parsed =
      parseYaml<Record<string, unknown>>(await readTextFile(configPath)) ?? {};
    let manifest = normalizeProjectConfig(parsed);
    const localConfigPath = path.join(cwd, LOCAL_PROJECT_CONFIG_FILENAME);
    const warnings: string[] = [];

    if (await pathExists(localConfigPath)) {
      const localParsed =
        parseYaml<Record<string, unknown>>(
          await readTextFile(localConfigPath),
        ) ?? {};
      manifest = mergeManifests(manifest, normalizeProjectConfig(localParsed));
      warnings.push(
        `${LOCAL_PROJECT_CONFIG_FILENAME} was merged as a local override; commit ${PROJECT_CONFIG_FILENAME} for team reproducibility.`,
      );
    }

    return {
      configPath,
      localConfigPath: (await pathExists(localConfigPath))
        ? localConfigPath
        : undefined,
      format: 'agentpm.yaml',
      manifest,
      warnings,
    };
  }

  const localConfigPath = path.join(cwd, LOCAL_PROJECT_CONFIG_FILENAME);
  if (await pathExists(localConfigPath)) {
    const parsed =
      parseYaml<Record<string, unknown>>(await readTextFile(localConfigPath)) ??
      {};
    return {
      configPath: localConfigPath,
      format: '.agentpmrc',
      manifest: normalizeProjectConfig(parsed),
      warnings: [
        `${LOCAL_PROJECT_CONFIG_FILENAME} was loaded as a compatibility fallback. Prefer ${PROJECT_CONFIG_FILENAME} for committed project configuration.`,
      ],
    };
  }

  return null;
}

export async function saveProjectConfig(
  cwd: string,
  config: ProjectConfigFile,
): Promise<string> {
  const configPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  await writeTextFile(configPath, stringifyYaml(config));
  return configPath;
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

export function isLocalManifestScope(
  scope: InstallScope,
): scope is LocalInstallScope {
  return scope === 'project' || scope === 'workspace';
}
