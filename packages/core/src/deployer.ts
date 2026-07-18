import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

import { ensureDir, listChildDirectories, pathExists } from '@agentpm/fs';
import {
  AgentPmError,
  type AdapterId,
  type AgentTransformId,
} from '@agentpm/shared';

/**
 * `agentpm deploy` materializes a declarative `deploy.yaml` onto the current
 * machine: it copies/backs up base config files, checks that the AgentPM
 * skill library matches a pushed checkout, concatenates instruction files,
 * and delegates to `AgentPmService.pull`/`AgentPmService.export`. This module
 * owns config parsing/validation and the filesystem-only steps (`base`,
 * `consistency`, `instructions`); `pull`/`export` delegation stays in
 * `service.ts` since it needs the service's own `pull()`/`export()` methods.
 *
 * Base directory entries are synced non-recursively: only files directly
 * inside `src` are considered, nested subdirectories are ignored.
 */

export type DeployBaseMode = 'always' | 'if-missing';

export interface DeployBaseEntry {
  src: string;
  dest: string;
  mode: DeployBaseMode;
  backup: boolean;
}

export interface DeployConsistencyConfig {
  libraryVsCheckoutDir: string;
}

export interface DeployInstructionsEntry {
  dest: string;
  header?: string | undefined;
  sources: string[];
  footer?: string | undefined;
}

export interface DeployPullConfig {
  from?: string | undefined;
  target?: AdapterId[] | undefined;
  transform?: AgentTransformId[] | undefined;
  agents?: boolean | undefined;
}

export interface DeployExportEntry {
  layout: string;
  dest: string;
  install?: boolean | undefined;
  optional?: boolean | undefined;
}

export interface DeployConfig {
  base: DeployBaseEntry[];
  consistency?: DeployConsistencyConfig | undefined;
  instructions: DeployInstructionsEntry[];
  pull?: DeployPullConfig | undefined;
  export: DeployExportEntry[];
}

export interface LoadedDeployConfig {
  config: DeployConfig;
  configDir: string;
}

const PULL_AGENT_VALUES = ['generic', 'codex', 'claude', 'kimi'] as const;
const PULL_TRANSFORM_VALUES = ['codex-agents', 'kimi-agents'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AgentPmError(`${label} must be an object.`);
  }
  return value;
}

function assertKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AgentPmError(
      `Unknown key "${unknown[0]}" in ${label}. Allowed keys: ${allowed.join(', ')}.`,
    );
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentPmError(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalStringField(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AgentPmError(`${label} must be a string.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AgentPmError(`${label} must be a boolean.`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AgentPmError(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/**
 * Resolve a config-declared path: `~/` expands to `os.homedir()`, absolute
 * paths pass through unchanged, and everything else resolves relative to
 * the directory containing `deploy.yaml` (not `process.cwd()`).
 */
function resolveConfiguredPath(configDir: string, raw: string): string {
  let expanded = raw;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

function parseBaseSection(value: unknown, configDir: string): DeployBaseEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AgentPmError('"base" must be an array.');
  }
  return value.map((rawEntry, index) => {
    const label = `base[${index}]`;
    const entry = requireRecord(rawEntry, label);
    assertKnownKeys(entry, ['src', 'dest', 'mode', 'backup'], label);
    const src = requireString(entry.src, `${label}.src`);
    const dest = requireString(entry.dest, `${label}.dest`);
    const mode = requireEnum(
      entry.mode,
      ['always', 'if-missing'] as const,
      `${label}.mode`,
    );
    const backup =
      entry.backup === undefined
        ? mode === 'always'
        : requireBoolean(entry.backup, `${label}.backup`);
    return {
      src: resolveConfiguredPath(configDir, src),
      dest: resolveConfiguredPath(configDir, dest),
      mode,
      backup,
    } satisfies DeployBaseEntry;
  });
}

function parseConsistencySection(
  value: unknown,
  configDir: string,
): DeployConsistencyConfig {
  const label = 'consistency';
  const entry = requireRecord(value, label);
  assertKnownKeys(entry, ['library-vs'], label);
  const libraryVs = requireString(entry['library-vs'], `${label}.library-vs`);
  return { libraryVsCheckoutDir: resolveConfiguredPath(configDir, libraryVs) };
}

function parseInstructionsSection(
  value: unknown,
  configDir: string,
): DeployInstructionsEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AgentPmError('"instructions" must be an array.');
  }
  return value.map((rawEntry, index) => {
    const label = `instructions[${index}]`;
    const entry = requireRecord(rawEntry, label);
    assertKnownKeys(entry, ['dest', 'header', 'sources', 'footer'], label);
    const dest = requireString(entry.dest, `${label}.dest`);
    const sourcesRaw = entry.sources;
    if (!Array.isArray(sourcesRaw) || sourcesRaw.length === 0) {
      throw new AgentPmError(`${label}.sources must be a non-empty array of paths.`);
    }
    const sources = sourcesRaw.map((sourceValue, sourceIndex) =>
      resolveConfiguredPath(
        configDir,
        requireString(sourceValue, `${label}.sources[${sourceIndex}]`),
      ),
    );
    return {
      dest: resolveConfiguredPath(configDir, dest),
      header: optionalStringField(entry.header, `${label}.header`),
      sources,
      footer: optionalStringField(entry.footer, `${label}.footer`),
    } satisfies DeployInstructionsEntry;
  });
}

function parsePullSection(value: unknown): DeployPullConfig {
  const label = 'pull';
  const entry = requireRecord(value, label);
  assertKnownKeys(entry, ['from', 'target', 'transform', 'agents'], label);
  const from = entry.from === undefined ? undefined : requireString(entry.from, `${label}.from`);
  let target: AdapterId[] | undefined;
  if (entry.target !== undefined) {
    if (!Array.isArray(entry.target)) {
      throw new AgentPmError(`${label}.target must be an array.`);
    }
    target = entry.target.map((item, index) =>
      requireEnum(item, PULL_AGENT_VALUES, `${label}.target[${index}]`),
    );
  }
  let transform: AgentTransformId[] | undefined;
  if (entry.transform !== undefined) {
    const rawTransforms = Array.isArray(entry.transform)
      ? entry.transform
      : [entry.transform];
    transform = rawTransforms.map((item, index) =>
      requireEnum(item, PULL_TRANSFORM_VALUES, `${label}.transform[${index}]`),
    );
  }
  const agents =
    entry.agents === undefined ? undefined : requireBoolean(entry.agents, `${label}.agents`);
  return { from, target, transform, agents };
}

function parseExportSection(value: unknown, configDir: string): DeployExportEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AgentPmError('"export" must be an array.');
  }
  return value.map((rawEntry, index) => {
    const label = `export[${index}]`;
    const entry = requireRecord(rawEntry, label);
    assertKnownKeys(entry, ['layout', 'dest', 'install', 'optional'], label);
    const layout = requireString(entry.layout, `${label}.layout`);
    const dest = requireString(entry.dest, `${label}.dest`);
    const install =
      entry.install === undefined ? undefined : requireBoolean(entry.install, `${label}.install`);
    const optional =
      entry.optional === undefined
        ? undefined
        : requireBoolean(entry.optional, `${label}.optional`);
    return {
      layout,
      dest: resolveConfiguredPath(configDir, dest),
      install,
      optional,
    } satisfies DeployExportEntry;
  });
}

export async function loadDeployConfig(configPath: string): Promise<LoadedDeployConfig> {
  const resolvedConfigPath = path.resolve(configPath);
  if (!(await pathExists(resolvedConfigPath))) {
    throw new AgentPmError(
      `Deploy config not found at ${resolvedConfigPath}. Pass --config <path> or create ./deploy.yaml.`,
    );
  }

  const raw = await fs.readFile(resolvedConfigPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    throw new AgentPmError(
      `Failed to parse ${resolvedConfigPath} as YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const configDir = path.dirname(resolvedConfigPath);
  const root = requireRecord(parsed, 'deploy config root');
  assertKnownKeys(
    root,
    ['base', 'consistency', 'instructions', 'pull', 'export'],
    'deploy config root',
  );

  const config: DeployConfig = {
    base: parseBaseSection(root.base, configDir),
    consistency:
      root.consistency === undefined
        ? undefined
        : parseConsistencySection(root.consistency, configDir),
    instructions: parseInstructionsSection(root.instructions, configDir),
    pull: root.pull === undefined ? undefined : parsePullSection(root.pull),
    export: parseExportSection(root.export, configDir),
  };

  return { config, configDir };
}

async function listChildFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

async function filesEqual(pathA: string, pathB: string): Promise<boolean> {
  const [bufferA, bufferB] = await Promise.all([fs.readFile(pathA), fs.readFile(pathB)]);
  return Buffer.compare(bufferA, bufferB) === 0;
}

/** Mirror `destFile`'s absolute path under `backupDir` so backups from a
 * single deploy run never collide, even across drives on Windows. */
function backupTargetFor(backupDir: string, destFile: string): string {
  const resolved = path.resolve(destFile);
  const segments = resolved
    .split(path.sep)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/:$/, ''));
  return path.join(backupDir, ...segments);
}

async function backupExistingFile(destFile: string, backupDir: string): Promise<string> {
  const backupTarget = backupTargetFor(backupDir, destFile);
  await ensureDir(path.dirname(backupTarget));
  await fs.copyFile(destFile, backupTarget);
  return backupTarget;
}

async function processFilePair(
  srcFile: string,
  destFile: string,
  mode: DeployBaseMode,
  backup: boolean,
  backupDir: string,
  dryRun: boolean,
  actions: string[],
): Promise<void> {
  const destExists = await pathExists(destFile);

  if (mode === 'if-missing') {
    if (destExists) {
      actions.push(`base skip ${destFile} (exists)`);
      return;
    }
    if (dryRun) {
      actions.push(`[dry-run] base copy ${destFile} (create)`);
      return;
    }
    await ensureDir(path.dirname(destFile));
    await fs.copyFile(srcFile, destFile);
    actions.push(`base copy ${destFile} (create)`);
    return;
  }

  // mode === 'always'
  if (destExists) {
    if (await filesEqual(srcFile, destFile)) {
      actions.push(`base skip ${destFile} (unchanged)`);
      return;
    }
    if (dryRun) {
      actions.push(
        `[dry-run] base copy ${destFile} (changed${backup ? ', backup' : ''})`,
      );
      return;
    }
    if (backup) {
      const backupPath = await backupExistingFile(destFile, backupDir);
      actions.push(`base backup ${destFile} -> ${backupPath}`);
    }
    await fs.copyFile(srcFile, destFile);
    actions.push(`base copy ${destFile} (changed)`);
    return;
  }

  if (dryRun) {
    actions.push(`[dry-run] base copy ${destFile} (create)`);
    return;
  }
  await ensureDir(path.dirname(destFile));
  await fs.copyFile(srcFile, destFile);
  actions.push(`base copy ${destFile} (create)`);
}

async function processBaseEntry(
  entry: DeployBaseEntry,
  backupDir: string,
  dryRun: boolean,
  actions: string[],
): Promise<void> {
  const srcStat = await fs.stat(entry.src).catch(() => null);
  if (!srcStat) {
    throw new AgentPmError(`base.src not found: ${entry.src}`);
  }

  if (!srcStat.isDirectory()) {
    await processFilePair(entry.src, entry.dest, entry.mode, entry.backup, backupDir, dryRun, actions);
    return;
  }

  const destStat = await fs.stat(entry.dest).catch(() => null);
  if (destStat && !destStat.isDirectory()) {
    throw new AgentPmError(
      `base.dest ${entry.dest} exists and is not a directory, but base.src ${entry.src} is a directory.`,
    );
  }

  const fileNames = await listChildFiles(entry.src);
  for (const fileName of fileNames) {
    await processFilePair(
      path.join(entry.src, fileName),
      path.join(entry.dest, fileName),
      entry.mode,
      entry.backup,
      backupDir,
      dryRun,
      actions,
    );
  }
}

export interface RunBaseStepParams {
  entries: DeployBaseEntry[];
  backupDir: string;
  dryRun: boolean;
}

export async function runBaseStep(params: RunBaseStepParams): Promise<{ actions: string[] }> {
  const actions: string[] = [];
  for (const entry of params.entries) {
    await processBaseEntry(entry, params.backupDir, params.dryRun, actions);
  }
  return { actions };
}

export async function runConsistencyStep(
  consistency: DeployConsistencyConfig,
  skillsLibraryDir: string,
): Promise<{ actions: string[] }> {
  const checkoutDir = consistency.libraryVsCheckoutDir;
  const skillNames = await listChildDirectories(skillsLibraryDir);
  const mismatches: string[] = [];
  let checked = 0;

  for (const name of skillNames) {
    const libraryPath = path.join(skillsLibraryDir, name, 'SKILL.md');
    if (!(await pathExists(libraryPath))) {
      continue;
    }
    const checkoutPath = path.join(checkoutDir, 'skills', name, 'SKILL.md');
    if (!(await pathExists(checkoutPath))) {
      mismatches.push(`"${name}": missing at ${checkoutPath}`);
      continue;
    }
    checked += 1;
    if (!(await filesEqual(libraryPath, checkoutPath))) {
      mismatches.push(`"${name}": ${libraryPath} differs from ${checkoutPath}`);
    }
  }

  if (mismatches.length > 0) {
    throw new AgentPmError(
      `Consistency check failed: the AgentPM skill library differs from the checkout at ${checkoutDir}.\n` +
        mismatches.map((mismatch) => `  - ${mismatch}`).join('\n') +
        '\n\nPush your library edits (agentpm push) or refresh the checkout (git pull) before deploying.',
    );
  }

  return { actions: [`consistency: ${checked} skill(s) verified against ${checkoutDir}`] };
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, '');
}

async function buildInstructionsContent(entry: DeployInstructionsEntry): Promise<string> {
  const segments: string[] = [];
  if (entry.header !== undefined) {
    segments.push(trimTrailingNewlines(entry.header));
  }
  for (const sourcePath of entry.sources) {
    const content = await fs.readFile(sourcePath, 'utf8');
    segments.push(trimTrailingNewlines(content));
  }
  if (entry.footer !== undefined) {
    segments.push(trimTrailingNewlines(entry.footer));
  }
  return `${segments.join('\n\n')}\n`;
}

async function processInstructionsEntry(
  entry: DeployInstructionsEntry,
  backupDir: string,
  dryRun: boolean,
  actions: string[],
): Promise<void> {
  for (const sourcePath of entry.sources) {
    if (!(await pathExists(sourcePath))) {
      throw new AgentPmError(`instructions source not found: ${sourcePath}`);
    }
  }

  const content = await buildInstructionsContent(entry);
  const destExists = await pathExists(entry.dest);

  if (destExists) {
    const existing = await fs.readFile(entry.dest, 'utf8');
    if (existing === content) {
      actions.push(`instructions skip ${entry.dest} (unchanged)`);
      return;
    }
    if (dryRun) {
      actions.push(`[dry-run] instructions write ${entry.dest} (changed, backup)`);
      return;
    }
    const backupPath = await backupExistingFile(entry.dest, backupDir);
    actions.push(`instructions backup ${entry.dest} -> ${backupPath}`);
    await ensureDir(path.dirname(entry.dest));
    await fs.writeFile(entry.dest, content, 'utf8');
    actions.push(`instructions write ${entry.dest} (changed)`);
    return;
  }

  if (dryRun) {
    actions.push(`[dry-run] instructions write ${entry.dest} (create)`);
    return;
  }
  await ensureDir(path.dirname(entry.dest));
  await fs.writeFile(entry.dest, content, 'utf8');
  actions.push(`instructions write ${entry.dest} (create)`);
}

export interface RunInstructionsStepParams {
  entries: DeployInstructionsEntry[];
  backupDir: string;
  dryRun: boolean;
}

export async function runInstructionsStep(
  params: RunInstructionsStepParams,
): Promise<{ actions: string[] }> {
  const actions: string[] = [];
  for (const entry of params.entries) {
    await processInstructionsEntry(entry, params.backupDir, params.dryRun, actions);
  }
  return { actions };
}

/** Filesystem-safe deploy backup directory name: ISO timestamps contain
 * colons, which Windows rejects in file/directory names. */
export function deployBackupDirName(isoTimestamp: string): string {
  return `deploy-${isoTimestamp.replace(/:/g, '-')}`;
}
