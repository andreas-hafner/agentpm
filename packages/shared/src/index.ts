import { createHash } from 'node:crypto';
import path from 'node:path';

export const MANIFEST_VERSION = 1;
export const PROJECT_CONFIG_VERSION = 1;
export const GLOBAL_CONFIG_VERSION = 1;

export type SourceKind = 'git' | 'local' | 'registry';
export type ContentKind = 'git' | 'local';
export type InstallScope = 'global' | 'project' | 'workspace';
export type LocalInstallScope = Exclude<InstallScope, 'global'>;
export type AdapterId = 'generic' | 'codex' | 'claude';
export type EntryKind = 'skill' | 'agent' | 'subagent';
export type LayoutMigrationRisk = 'safe' | 'remap' | 'breaking';
export type DiffKind = 'added' | 'removed' | 'changed';
export type DoctorSeverity = 'info' | 'warning' | 'error';

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  locator: string;
  normalizedLocator: string;
  displayName: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogEntryRecord {
  id: string;
  sourceId: string;
  name: string;
  description: string | null;
  repo: string;
  ref: string | null;
  path: string | null;
  adapterHint: AdapterId | null;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CacheRepoRecord {
  cacheKey: string;
  sourceId: string | null;
  locator: string;
  kind: ContentKind;
  basePath: string;
  currentRevision: string | null;
  isGit: boolean;
  layoutSignature: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface InstallRecord {
  id: string;
  name: string;
  sourceId: string;
  catalogEntryId: string | null;
  adapter: AdapterId;
  scope: InstallScope;
  scopeRoot: string;
  targetPath: string;
  linkTarget: string;
  sourceRelativePath: string;
  sourceRootRelativePath: string;
  selectedItems: string[];
  contentKind: ContentKind;
  contentLocator: string;
  contentRef: string | null;
  cacheKey: string | null;
  installedRevision: string | null;
  layoutSignature: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DetectedScript {
  name: string;
  relativePath: string;
}

export interface DetectedEntry {
  name: string;
  relativePath: string;
  rootRelativePath: string;
  adapter: AdapterId;
  kind: EntryKind;
  warnings: string[];
}

export interface DetectedGroup {
  adapter: AdapterId;
  label: string;
  relativeRoot: string;
  kind: EntryKind;
  nativeTargetRelativeRoot: string;
  confidence: number;
  entries: DetectedEntry[];
}

export interface AdapterCompatibility {
  adapter: AdapterId;
  compatible: boolean;
  score: number;
  reasons: string[];
}

export interface InspectionTrust {
  trusted: boolean;
  score: number;
  reasons: string[];
}

export interface InspectionReport {
  locator: string;
  sourceKind: SourceKind;
  resolvedPath: string;
  groups: DetectedGroup[];
  scripts: DetectedScript[];
  compatibleAdapters: AdapterCompatibility[];
  installable: boolean;
  trust: InspectionTrust;
  warnings: string[];
  layoutSignature: string;
}

export interface InstallMapping {
  name: string;
  adapter: AdapterId;
  sourceRelativePath: string;
  sourceRootRelativePath: string;
  targetRelativePath: string;
}

export interface AdapterUpdateResult {
  risk: LayoutMigrationRisk;
  nextRelativePath: string | null;
  warnings: string[];
}

export interface RegistryIndexEntry {
  name: string;
  description?: string | undefined;
  repo: string;
  ref?: string | undefined;
  path?: string | undefined;
  adapterHint?: AdapterId | undefined;
  target?: AdapterId | undefined;
  tags?: string[] | undefined;
}

export interface RegistryIndexFile {
  version: number;
  entries: RegistryIndexEntry[];
}

export interface ManifestSourceSpec {
  id?: string | undefined;
  locator: string;
  kind?: SourceKind | undefined;
}

export interface ManifestInstallSpec {
  name: string;
  source?: string | undefined;
  items: string[];
  scope: LocalInstallScope;
  ref?: string | undefined;
  revision?: string | undefined;
  target?: AdapterId | undefined;
  adapter?: AdapterId | undefined;
  workspaceRoot?: string | undefined;
}

export type PushTargetKind = 'git' | 'registry';

export interface ManifestPushTargetSpec {
  id?: string | undefined;
  locator: string;
  kind?: PushTargetKind | undefined;
  default?: boolean | undefined;
}

export interface ManifestFile {
  version: number;
  sources: ManifestSourceSpec[];
  installs: ManifestInstallSpec[];
  targets: ManifestPushTargetSpec[];
}

export type ProjectSourceSpec = string | ManifestSourceSpec;

export interface ProjectSkillObjectSpec {
  name: string;
  source?: string | undefined;
  items?: string[] | undefined;
  scope?: LocalInstallScope | undefined;
  ref?: string | undefined;
  revision?: string | undefined;
  target?: AdapterId | undefined;
  adapter?: AdapterId | undefined;
  workspaceRoot?: string | undefined;
}

export type ProjectSkillSpec = string | ProjectSkillObjectSpec;

export interface ProjectConfigFile {
  version?: number | undefined;
  sources?: ProjectSourceSpec[] | undefined;
  skills?: ProjectSkillSpec[] | undefined;
  targets?: ManifestPushTargetSpec[] | undefined;
  scope?: LocalInstallScope | undefined;
}

export interface LoadedProjectConfig {
  configPath: string;
  localConfigPath?: string | undefined;
  format: 'agentpm.yaml' | '.agentpmrc';
  manifest: ManifestFile;
  warnings: string[];
}

export interface GlobalConfigFile {
  version: number;
  defaults?:
    | {
        workspaceRoot?: string | undefined;
      }
    | undefined;
  targets?: ManifestPushTargetSpec[] | undefined;
}

export interface SearchResult {
  kind: 'catalog' | 'installed';
  name: string;
  description: string | null;
  sourceId: string | null;
  adapter: AdapterId | null;
  scope: InstallScope | null;
  locator: string | null;
}

export interface DiffEntry {
  kind: DiffKind;
  path: string;
}

export interface UpdatePreview {
  install: InstallRecord;
  source: SourceRecord | null;
  changed: boolean;
  currentRevision: string | null;
  candidateRevision: string | null;
  diff: DiffEntry[];
  risk: LayoutMigrationRisk;
  warnings: string[];
  nextLinkTarget: string | null;
}

export type RuntimeContextLayer = 'global' | 'project' | 'temporary';

export interface RuntimeContextEntry {
  layer: RuntimeContextLayer;
  name: string;
  sourceId: string | null;
  sourceLocator: string | null;
  adapter: AdapterId | null;
  sourceRelativePath: string | null;
  targetPath: string | null;
  linkTarget: string | null;
  scope: InstallScope | null;
  warnings: string[];
}

export interface RuntimeContextGraph {
  cwd: string;
  configPath: string | null;
  sources: SourceRecord[];
  layers: Record<RuntimeContextLayer, RuntimeContextEntry[]>;
  warnings: string[];
}

export interface PushOptions {
  path?: string | undefined;
  target?: string | undefined;
  message?: string | undefined;
  dryRun?: boolean | undefined;
  all?: boolean | undefined;
}

export interface PushResult {
  success: boolean;
  targetLocator: string;
  revision?: string | undefined;
  warnings: string[];
  entries: string[];
}

export interface DoctorIssue {
  severity: DoctorSeverity;
  code: string;
  message: string;
  path?: string;
  installId?: string;
  sourceId?: string;
  remedy?: string;
}

export interface InstallSelection {
  source: SourceRecord;
  entry: CatalogEntryRecord;
}

export interface SelectOption<T> {
  label: string;
  value: T;
  description?: string;
}

export interface PromptApi {
  selectOne?<T>(message: string, options: SelectOption<T>[]): Promise<T>;
  selectMany?<T>(message: string, options: SelectOption<T>[]): Promise<T[]>;
  confirm?(message: string, details?: string[]): Promise<boolean>;
}

export interface RefreshSourceResult {
  source: SourceRecord;
  indexedEntries: number;
}

export interface CacheCleanOptions {
  dryRun?: boolean | undefined;
}

export interface CacheCleanResult {
  removedEntries: number;
  removedPaths: string[];
  dryRun: boolean;
}

export type DoctorFixAction =
  | {
      code: 'remove-source';
      sourceId: string;
      description: string;
    }
  | {
      code: 'remove-install-record';
      installId: string;
      description: string;
    };

export interface DoctorFixResult {
  action: DoctorFixAction;
  applied: boolean;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function stableHash(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item'
  );
}

export function makeId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${stableHash(parts)}`;
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function isGitSshLocator(value: string): boolean {
  return /^[^@\s]+@[^:\s]+:.+/i.test(value);
}

export function isSkillsShLocator(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }
  const url = new URL(value);
  return url.hostname === 'skills.sh' || url.hostname === 'www.skills.sh';
}

export function isSkillsHubLocator(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }
  const url = new URL(value);
  return url.hostname === 'skillshub.wtf';
}

export function isGitRevision(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export function sortBy<T>(
  items: T[],
  keyFn: (item: T) => string | number,
): T[] {
  return [...items].sort((left, right) => {
    const leftKey = keyFn(left);
    const rightKey = keyFn(right);
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });
}

export function classifyLocator(locator: string): SourceKind {
  const normalized = locator.trim();
  if (
    normalized === 'skills.sh' ||
    normalized === 'www.skills.sh' ||
    normalized === 'skillshub.wtf'
  ) {
    return 'registry';
  }
  if (
    normalized.startsWith('registry:') ||
    normalized.startsWith('registry+https://')
  ) {
    return 'registry';
  }
  if (normalized.startsWith('github:')) {
    return 'git';
  }
  if (normalized.startsWith('local:')) {
    return 'local';
  }
  const ext = path.extname(normalized).toLowerCase();
  if (ext === '.yaml' || ext === '.yml' || ext === '.json') {
    return 'registry';
  }
  if (
    isHttpUrl(normalized) &&
    (normalized.endsWith('.yaml') ||
      normalized.endsWith('.yml') ||
      normalized.endsWith('.json'))
  ) {
    return 'registry';
  }
  if (isSkillsShLocator(normalized) || isSkillsHubLocator(normalized)) {
    return 'registry';
  }
  if (
    isHttpUrl(normalized) ||
    normalized.startsWith('file://') ||
    isGitSshLocator(normalized) ||
    normalized.endsWith('.git')
  ) {
    return 'git';
  }
  return 'local';
}

export function displayNameFromLocator(locator: string): string {
  const trimmed = locator.trim();
  const withoutQuery = trimmed.split('?')[0] ?? trimmed;
  const basename = path.basename(withoutQuery, path.extname(withoutQuery));
  return basename || slugify(trimmed);
}

export class AgentPmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentPmError';
  }
}
