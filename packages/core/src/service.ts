import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  getAdapter,
  inspectRepository,
  listInstallableEntries,
} from '@agentpm/adapters';
import {
  LOCAL_PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_FILENAME,
  ensureAgentPmHome,
  loadGlobalConfig,
  upsertProjectConfigInstalls,
  loadProjectConfig,
  resolveScopeRoot,
  saveProjectConfig,
} from '@agentpm/config';
import { AgentPmDatabase } from '@agentpm/db';
import {
  computeTreeSignature,
  diffTrees,
  ensureDir,
  ensureManagedLink,
  isBrokenLink,
  pathExists,
  removeManagedLink,
  walkFiles,
} from '@agentpm/fs';
import {
  DEFAULT_DISCOVERY_PATHS,
  cleanupTemporaryRelease,
  createTemporaryGitRelease,
  inferContentKind,
  isLocalGitRepository,
  materializeGitRelease,
  normalizeSparsePaths,
  resolveGitRevision,
  resolveReleasePath,
  runGitCommand,
} from '@agentpm/git';
import { loadRegistryIndex } from '@agentpm/registry';
import {
  AgentPmError,
  MANIFEST_VERSION,
  classifyLocator,
  displayNameFromLocator,
  makeId,
  nowIso,
  slugify,
  toPosixPath,
  type CacheCleanOptions,
  type CacheCleanResult,
  type CatalogEntryRecord,
  type ContentKind,
  type DoctorFixAction,
  type DoctorFixResult,
  type DoctorIssue,
  type InstallRecord,
  type InstallScope,
  type AdapterId,
  type InspectionReport,
  type LoadedProjectConfig,
  type ManifestFile,
  type ManifestPushTargetSpec,
  type ManifestSourceSpec,
  type PromptApi,
  type ProjectConfigFile,
  type ManifestInstallSpec,
  type PushOptions,
  type PushResult,
  type RefreshSourceResult,
  type RuntimeContextEntry,
  type RuntimeContextGraph,
  type SearchResult,
  type SourceKind,
  type SourceRecord,
  type UpdatePreview,
} from '@agentpm/shared';

export interface AddSourceResult {
  source: SourceRecord;
  indexedEntries: number;
  report?: InspectionReport;
}

export interface InstallOptions {
  scope?: InstallScope | undefined;
  workspaceRoot?: string | undefined;
  all?: boolean | undefined;
  skills?: string[] | undefined;
  ref?: string | null | undefined;
  revision?: string | null | undefined;
  target?: AdapterId | undefined;
  from?: string | undefined;
  addSource?: boolean | undefined;
  yes?: boolean | undefined;
  updateProjectConfig?: boolean | undefined;
}

export interface RemoveInstallOptions {
  purge?: boolean;
}

export interface UpdateOptions {
  names?: string[] | undefined;
  apply?: boolean | undefined;
  yes?: boolean | undefined;
}

export interface AgentPmServiceOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompts?: PromptApi;
  onStatus?: ((message: string) => void) | undefined;
}

interface ServicePaths {
  homeDir: string;
  cacheDir: string;
  dbPath: string;
  globalConfigPath: string;
  manifestPath: string;
}

interface PreparedContent {
  report: InspectionReport;
  contentKind: ContentKind;
  contentLocator: string;
  contentRef: string | null;
  revision: string | null;
  repoRoot: string;
  cacheKey: string | null;
  cleanup?: (() => Promise<void>) | undefined;
}

interface ConfiguredSourceBinding {
  spec: ManifestSourceSpec;
  source: SourceRecord;
}

interface PushCandidate {
  name: string;
  adapter: AdapterId;
  sourcePath: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
}

export interface SourceSkillEntry {
  name: string;
  path: string | null;
  adapter: AdapterId | null;
  description: string | null;
  repo: string;
  sourceId: string | null;
  sourceDisplayName: string;
}

export interface SourceEntriesResult {
  sourceId: string | null;
  sourceDisplayName: string;
  sourceLocator: string;
  persisted: boolean;
  entries: SourceSkillEntry[];
}

const execFileAsync = promisify(execFile);

function normalizeCatalogSelector(selector: string): string {
  return selector.trim().replace(/\\/g, '/');
}

function matchesCatalogEntrySelector(
  entry: CatalogEntryRecord,
  selector: string,
): boolean {
  const normalizedSelector = normalizeCatalogSelector(selector);
  if (!normalizedSelector) {
    return false;
  }

  if (entry.name === normalizedSelector) {
    return true;
  }

  if (!entry.path) {
    return false;
  }

  return (
    entry.path === normalizedSelector ||
    entry.path.endsWith(`/${normalizedSelector}`)
  );
}

function matchesCatalogEntryTarget(
  entry: CatalogEntryRecord,
  target?: AdapterId,
): boolean {
  return !target || entry.adapterHint === null || entry.adapterHint === target;
}

export class AgentPmService {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompts: PromptApi;
  readonly onStatus: ((message: string) => void) | undefined;
  readonly paths: ServicePaths;
  readonly db: AgentPmDatabase;

  constructor(options: AgentPmServiceOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.env = { ...process.env, ...options.env };
    this.prompts = options.prompts ?? {};
    this.onStatus = options.onStatus;

    const agentPmHome =
      this.env.AGENTPM_HOME ?? path.join(os.homedir(), '.agentpm');
    this.paths = {
      homeDir: agentPmHome,
      cacheDir: path.join(agentPmHome, 'cache'),
      dbPath: path.join(agentPmHome, 'agentpm.db'),
      globalConfigPath: path.join(agentPmHome, 'config.yaml'),
      manifestPath: path.join(this.cwd, PROJECT_CONFIG_FILENAME),
    };

    this.db = new AgentPmDatabase(this.paths.dbPath);
  }

  async initialize(): Promise<void> {
    await ensureAgentPmHome(this.cwd, this.env);
  }

  close(): void {
    this.db.close();
  }

  private cacheBasePath(cacheKey: string): string {
    return path.join(this.paths.cacheDir, 'repos', cacheKey.slice(0, 16));
  }

  private reportStatus(message: string): void {
    this.onStatus?.(message);
  }

  private async toGitTransportLocator(locator: string): Promise<string> {
    if (locator.includes('://') || locator.includes('@')) {
      return locator;
    }

    const localPath = path.resolve(locator);
    if (await pathExists(localPath)) {
      return pathToFileURL(localPath).href;
    }

    return locator;
  }

  async addSource(locator: string): Promise<AddSourceResult> {
    await this.initialize();
    const kind = await this.classifySource(locator);
    const normalizedLocator = this.normalizeLocator(locator, kind);
    const sourceId = makeId('src', kind, normalizedLocator);
    const source: SourceRecord = {
      id: sourceId,
      kind,
      locator: normalizedLocator,
      normalizedLocator,
      displayName: displayNameFromLocator(normalizedLocator),
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const storedSource = this.db.upsertSource(source);
    return this.reindexSource(storedSource);
  }

  listSources(): SourceRecord[] {
    return this.db.listSources();
  }

  async listSourceEntries(
    sourceToken?: string,
    options: { refresh?: boolean | undefined; target?: AdapterId | undefined } = {},
  ): Promise<SourceEntriesResult> {
    await this.initialize();

    let source = sourceToken ? this.findSourceByToken(sourceToken) : null;
    if (!source && !sourceToken) {
      const sources = this.db.listSources();
      if (sources.length === 0) {
        throw new AgentPmError(
          'No sources have been added yet. Use "agentpm source add <locator>" first.',
        );
      }
      if (!this.prompts.selectOne) {
        throw new AgentPmError(
          'Listing source skills without a source requires an interactive TTY.',
        );
      }
      source = await this.prompts.selectOne(
        'Choose a source to inspect:',
        sources.map((candidate) => ({
          label: candidate.displayName,
          description: candidate.locator,
          value: candidate,
        })),
      );
    }

    if (source) {
      if (options.refresh) {
        await this.reindexSource(source);
      }
      const entries = this.db
        .listCatalogEntriesBySource(source.id)
        .filter((entry) => matchesCatalogEntryTarget(entry, options.target))
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          adapter: entry.adapterHint,
          description: entry.description,
          repo: entry.repo,
          sourceId: source.id,
          sourceDisplayName: source.displayName,
        }));
      return {
        sourceId: source.id,
        sourceDisplayName: source.displayName,
        sourceLocator: source.locator,
        persisted: true,
        entries,
      };
    }

    if (!sourceToken) {
      throw new AgentPmError('A source token or locator is required.');
    }

    const kind = await this.classifySource(sourceToken);
    const normalizedLocator = this.normalizeLocator(sourceToken, kind);
    const displayName = displayNameFromLocator(normalizedLocator);
    if (kind === 'registry') {
      const registry = await loadRegistryIndex(normalizedLocator);
      const entries = registry.entries
        .filter(
          (entry) =>
            !options.target ||
            !entry.target ||
            entry.target === options.target ||
            entry.adapterHint === options.target,
        )
        .map((entry) => ({
          name: entry.name,
          path: entry.path ?? null,
          adapter: entry.target ?? entry.adapterHint ?? null,
          description: entry.description ?? null,
          repo: resolveRegistryRepo(normalizedLocator, entry.repo),
          sourceId: null,
          sourceDisplayName: displayName,
        }));
      return {
        sourceId: null,
        sourceDisplayName: displayName,
        sourceLocator: normalizedLocator,
        persisted: false,
        entries,
      };
    }

    const prepared = await this.prepareInspectionTarget(normalizedLocator, kind, {
      sourceId: null,
    });
    try {
      const entries = this.catalogEntriesFromInspection(
        '__preview__',
        normalizedLocator,
        prepared.report,
      )
        .filter((entry) => matchesCatalogEntryTarget(entry, options.target))
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          adapter: entry.adapterHint,
          description: entry.description,
          repo: entry.repo,
          sourceId: null,
          sourceDisplayName: displayName,
        }));
      return {
        sourceId: null,
        sourceDisplayName: displayName,
        sourceLocator: normalizedLocator,
        persisted: false,
        entries,
      };
    } finally {
      await prepared.cleanup?.();
    }
  }

  async refreshSources(
    sourceTokens: string[] = [],
  ): Promise<RefreshSourceResult[]> {
    await this.initialize();
    const sources =
      sourceTokens.length > 0
        ? sourceTokens.map((token) => {
            const source = this.findSourceByToken(token);
            if (!source) {
              throw new AgentPmError(`Unknown source: ${token}`);
            }
            return source;
          })
        : this.db.listSources();

    const results: RefreshSourceResult[] = [];
    for (const source of sources) {
      const result = await this.reindexSource(source);
      results.push({
        source: result.source,
        indexedEntries: result.indexedEntries,
      });
    }
    return results;
  }

  async removeSource(sourceToken: string): Promise<void> {
    await this.initialize();
    const source = this.findSourceByToken(sourceToken);
    if (!source) {
      throw new AgentPmError(`Unknown source: ${sourceToken}`);
    }

    if (this.db.countInstallsForSource(source.id) > 0) {
      throw new AgentPmError(
        `Cannot remove source "${source.displayName}" while installs still depend on it.`,
      );
    }

    this.db.deleteSource(source.id);
  }

  async inspect(
    target: string,
    options: {
      skill?: string | undefined;
      target?: AdapterId | undefined;
    } = {},
  ): Promise<InspectionReport> {
    await this.initialize();
    const source = this.findSourceByToken(target);
    if (source && source.kind !== 'registry') {
      const prepared = await this.prepareInspectionTarget(
        source.locator,
        source.kind,
      );
      try {
        return this.annotateInspectionForRequest(prepared.report, options);
      } finally {
        await prepared.cleanup?.();
      }
    }

    const kind = await this.classifySource(target);
    if (kind === 'registry') {
      throw new AgentPmError(
        'Registry indexes are not inspectable as repositories.',
      );
    }

    const prepared = await this.prepareInspectionTarget(target, kind);
    try {
      return this.annotateInspectionForRequest(prepared.report, options);
    } finally {
      await prepared.cleanup?.();
    }
  }

  search(query: string): SearchResult[] {
    const catalogResults = this.db.searchCatalogEntries(query).map((entry) => ({
      kind: 'catalog' as const,
      name: entry.name,
      description: entry.description,
      sourceId: entry.sourceId,
      adapter: entry.adapterHint,
      scope: null,
      locator: entry.repo,
    }));
    return [...catalogResults, ...this.db.searchInstalled(query)];
  }

  listInstalls(): InstallRecord[] {
    return this.db.listInstalls();
  }

  async install(
    names: string[],
    options: InstallOptions = {},
  ): Promise<InstallRecord[]> {
    await this.initialize();
    const globalConfig = await loadGlobalConfig(this.cwd, this.env);
    const scope = await this.resolveScope(options.scope);
    const scopeRoot = resolveScopeRoot(
      scope,
      this.cwd,
      globalConfig,
      options.workspaceRoot,
    );
    const selections = await this.resolveSelections(names, options);
    const installs: InstallRecord[] = [];

    for (const selection of selections) {
      const prepared = await this.prepareContentForEntry(
        selection.entry,
        selection.source,
        {
          ref: options.ref,
          revision: options.revision,
        },
      );

      try {
        const selector: {
          name?: string | undefined;
          relativePath?: string | undefined;
        } = {
          name: selection.entry.name,
        };
        if (selection.entry.path) {
          selector.relativePath = selection.entry.path;
        }
        const detectedEntries = listInstallableEntries(prepared.report).filter(
          (entry) => !options.target || entry.adapter === options.target,
        );
        const detectedEntry =
          // 1. Exact relativePath match
          detectedEntries.find((entry) => {
            if (selector.relativePath) {
              return entry.relativePath === selector.relativePath;
            }
            return selector.name ? entry.name === selector.name : false;
          }) ??
          // 2. Exact name match
          detectedEntries.find(
            (entry) => entry.name === selection.entry.name,
          ) ??
          // 3. Basename match — handles nested paths like composio-skills/doppler-automation
          (selector.relativePath
            ? detectedEntries.find(
                (entry) =>
                  path.basename(entry.relativePath) === selector.relativePath,
              )
            : undefined) ??
          // 4. Basename of relativePath matches the name hint
          (selector.name
            ? detectedEntries.find(
                (entry) => path.basename(entry.relativePath) === selector.name,
              )
            : undefined);

        if (!detectedEntry) {
          const targetSummary = options.target
            ? ` for target "${options.target}"`
            : '';
          const availableNames = detectedEntries
            .slice(0, 20)
            .map((e) => `  - ${e.name} (${e.relativePath})`)
            .join('\n');
          const moreNote =
            detectedEntries.length > 20
              ? `\n  ... and ${detectedEntries.length - 20} more`
              : '';
          throw new AgentPmError(
            `Could not find installable entry "${selection.entry.name}"${targetSummary} in ${prepared.contentLocator}.` +
              (detectedEntries.length > 0
                ? `\n\nAvailable entries in this repository:\n${availableNames}${moreNote}`
                : '\n\nNo installable entries (SKILL.md) were detected in this repository.'),
          );
        }

        const adapter = getAdapter(detectedEntry.adapter);
        const mapping = await adapter.install(detectedEntry, scopeRoot);
        const linkTarget = path.join(
          prepared.repoRoot,
          mapping.sourceRelativePath,
        );
        const targetPath = path.join(scopeRoot, mapping.targetRelativePath);

        await ensureDir(path.dirname(targetPath));
        await ensureManagedLink(targetPath, linkTarget);

        const installedRevision =
          prepared.revision ??
          (prepared.contentKind === 'local'
            ? await computeTreeSignature(
                path.join(prepared.repoRoot, mapping.sourceRelativePath),
              )
            : null);

        const installId = makeId(
          'inst',
          selection.source.id,
          mapping.name,
          scope,
          scopeRoot,
        );
        const savedInstall = this.db.saveInstall({
          id: installId,
          name: mapping.name,
          sourceId: selection.source.id,
          catalogEntryId: selection.entry.id,
          adapter: mapping.adapter,
          scope,
          scopeRoot,
          targetPath,
          linkTarget,
          sourceRelativePath: mapping.sourceRelativePath,
          sourceRootRelativePath: mapping.sourceRootRelativePath,
          selectedItems:
            options.skills && options.skills.length > 0
              ? options.skills
              : [mapping.name],
          contentKind: prepared.contentKind,
          contentLocator: prepared.contentLocator,
          contentRef: options.ref ?? selection.entry.ref ?? null,
          cacheKey: prepared.cacheKey,
          installedRevision,
          layoutSignature: prepared.report.layoutSignature,
          metadata: {},
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });

        await this.recordGeneratedTargetInLocalGitExclude(savedInstall);
        await this.ensureGitignored(scopeRoot, targetPath, options.yes);
        installs.push(savedInstall);
      } finally {
        await prepared.cleanup?.();
      }
    }

    if (installs.length > 0 && options.updateProjectConfig !== false) {
      await this.updateExistingProjectConfig(installs);
    }

    return installs;
  }

  async previewUpdates(options: UpdateOptions = {}): Promise<UpdatePreview[]> {
    await this.initialize();
    const installs = this.filterInstallsByName(options.names);
    const previews: UpdatePreview[] = [];

    for (const install of installs) {
      const source = this.db.getSource(install.sourceId);
      if (install.contentKind === 'local') {
        previews.push(await this.previewLocalInstallUpdate(install, source));
        continue;
      }

      const candidateRevision = await resolveGitRevision(
        install.contentLocator,
        install.contentRef ?? undefined,
        this.env,
      );
      if (candidateRevision === install.installedRevision) {
        previews.push({
          install,
          source,
          changed: false,
          currentRevision: install.installedRevision,
          candidateRevision,
          diff: [],
          risk: 'safe',
          warnings: [],
          nextLinkTarget: install.linkTarget,
        });
        continue;
      }

      const prepared = await this.prepareGitCandidateFromInstall(
        install,
        candidateRevision,
      );
      try {
        const adapter = getAdapter(install.adapter);
        const updateResult = adapter.update(install, prepared.report);
        const nextLinkTarget = updateResult.nextRelativePath
          ? path.join(prepared.repoRoot, updateResult.nextRelativePath)
          : null;
        const diff =
          nextLinkTarget && (await pathExists(install.linkTarget))
            ? await diffTrees(install.linkTarget, nextLinkTarget)
            : [];

        previews.push({
          install,
          source,
          changed: true,
          currentRevision: install.installedRevision,
          candidateRevision,
          diff,
          risk: updateResult.risk,
          warnings: updateResult.warnings,
          nextLinkTarget,
        });
      } finally {
        await prepared.cleanup?.();
      }
    }

    return previews;
  }

  async update(options: UpdateOptions = {}): Promise<UpdatePreview[]> {
    const previews = await this.previewUpdates({ ...options, apply: false });
    if (!options.apply) {
      return previews;
    }

    for (const preview of previews) {
      if (!preview.changed || !preview.nextLinkTarget) {
        continue;
      }

      if (
        (preview.risk === 'remap' || preview.risk === 'breaking') &&
        !options.yes
      ) {
        const confirmed = await this.prompts.confirm?.(
          `Update ${preview.install.name} with ${preview.risk} layout risk?`,
          preview.warnings,
        );
        if (!confirmed) {
          preview.warnings.push('Skipped by user.');
          continue;
        }
      }

      try {
        await removeManagedLink(preview.install.targetPath);
        await ensureManagedLink(
          preview.install.targetPath,
          preview.nextLinkTarget,
        );
        const nextSourceRelativePath =
          preview.install.contentKind === 'git' &&
          preview.install.cacheKey &&
          preview.candidateRevision
            ? path
                .relative(
                  resolveReleasePath(
                    this.cacheBasePath(preview.install.cacheKey),
                    preview.candidateRevision,
                  ),
                  preview.nextLinkTarget,
                )
                .split(path.sep)
                .join('/')
            : preview.install.sourceRelativePath;
        this.db.saveInstall({
          ...preview.install,
          linkTarget: preview.nextLinkTarget,
          sourceRelativePath: nextSourceRelativePath,
          installedRevision: preview.candidateRevision,
          updatedAt: nowIso(),
        });
      } catch (error) {
        throw new AgentPmError(
          `Failed to update "${preview.install.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return previews;
  }

  async cleanCache(options: CacheCleanOptions = {}): Promise<CacheCleanResult> {
    await this.initialize();
    await ensureDir(this.paths.cacheDir);
    const installedCacheKeys = new Set(
      this.db
        .listInstalls()
        .map((install) => install.cacheKey)
        .filter((cacheKey): cacheKey is string => Boolean(cacheKey)),
    );
    const removedPaths: string[] = [];

    for (const cacheRepo of this.db.listCacheRepos()) {
      if (installedCacheKeys.has(cacheRepo.cacheKey)) {
        continue;
      }
      if (cacheRepo.metadata.role === 'push-target') {
        continue;
      }
      if (!options.dryRun) {
        await fs.rm(cacheRepo.basePath, { recursive: true, force: true });
        this.db.deleteCacheRepo(cacheRepo.cacheKey);
      }
      removedPaths.push(cacheRepo.basePath);
    }

    const reposDir = path.join(this.paths.cacheDir, 'repos');
    const repoEntries = await fs
      .readdir(reposDir, { withFileTypes: true })
      .catch(() => []);
    const knownPaths = new Set(
      this.db
        .listCacheRepos()
        .map((cacheRepo) => path.resolve(cacheRepo.basePath)),
    );
    for (const entry of repoEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const entryPath = path.join(reposDir, entry.name);
      if (knownPaths.has(path.resolve(entryPath))) {
        continue;
      }
      if (!options.dryRun) {
        await fs.rm(entryPath, { recursive: true, force: true });
      }
      removedPaths.push(entryPath);
    }

    return {
      removedEntries: removedPaths.length,
      removedPaths,
      dryRun: Boolean(options.dryRun),
    };
  }

  async removeInstall(
    name: string,
    options: RemoveInstallOptions = {},
  ): Promise<InstallRecord> {
    await this.initialize();
    const installs = this.db.listInstallsByName(name);
    if (installs.length === 0) {
      throw new AgentPmError(`No install named "${name}" found.`);
    }

    let install = installs[0]!;
    if (installs.length > 1) {
      if (!this.prompts.selectOne) {
        throw new AgentPmError(
          `Multiple installs named "${name}" found. Re-run interactively to choose one.`,
        );
      }

      install = await this.prompts.selectOne(
        `Choose which "${name}" install to remove:`,
        installs.map((candidate) => ({
          label: `${candidate.name} (${candidate.scope})`,
          description: candidate.targetPath,
          value: candidate,
        })),
      );
    }

    await removeManagedLink(install.targetPath);
    this.db.removeInstall(install.id);

    if (
      options.purge &&
      install.cacheKey &&
      this.db.countInstallsForCacheKey(install.cacheKey) === 0
    ) {
      await fs.rm(this.cacheBasePath(install.cacheKey), {
        recursive: true,
        force: true,
      });
    }

    return install;
  }

  async initManifest(): Promise<{
    manifestPath: string;
    manifest: ManifestFile;
  }> {
    await this.initialize();
    const installs = this.db
      .listInstalls()
      .filter(
        (install) =>
          install.scope !== 'global' &&
          path.resolve(install.scopeRoot) === this.cwd,
      );
    const sources = installs
      .map((install) => this.db.getSource(install.sourceId))
      .filter((source): source is SourceRecord => Boolean(source));

    const uniqueSources = [
      ...new Map(sources.map((source) => [source.id, source])).values(),
    ];
    const projectConfig: ProjectConfigFile = {
      version: MANIFEST_VERSION,
      sources: uniqueSources.map((source) => ({
        id: source.id,
        locator: source.locator,
        kind: source.kind,
      })),
      targets: [],
      scope: 'project',
      skills: installs.map((install) => {
        const base = {
          name: install.name,
          source: install.sourceId,
          items:
            install.selectedItems.length > 0
              ? install.selectedItems
              : [install.name],
          scope:
            install.scope === 'global' ? ('project' as const) : install.scope,
          ref: install.contentRef ?? undefined,
          revision: install.installedRevision ?? undefined,
          target: install.adapter,
          workspaceRoot:
            install.scope === 'workspace' ? install.scopeRoot : undefined,
        };

        if (
          base.scope === 'project' &&
          !base.ref &&
          !base.revision &&
          base.items.length === 1 &&
          base.items[0] === install.name
        ) {
          return install.name;
        }

        return base;
      }),
    };

    const manifest: ManifestFile = {
      version: MANIFEST_VERSION,
      sources: uniqueSources.map((source) => ({
        id: source.id,
        locator: source.locator,
        kind: source.kind,
      })),
      installs: installs.map((install) => ({
        name: install.name,
        source: install.sourceId,
        items:
          install.selectedItems.length > 0
            ? install.selectedItems
            : [install.name],
        scope: install.scope === 'global' ? 'project' : install.scope,
        ref: install.contentRef ?? undefined,
        revision: install.installedRevision ?? undefined,
        target: install.adapter,
        workspaceRoot:
          install.scope === 'workspace' ? install.scopeRoot : undefined,
      })),
      targets: [],
    };

    const manifestPath = await saveProjectConfig(this.cwd, projectConfig);
    return { manifestPath, manifest };
  }

  async syncManifest(): Promise<InstallRecord[]> {
    await this.initialize();
    const loadedConfig = await loadProjectConfig(this.cwd);
    if (!loadedConfig) {
      throw new AgentPmError(
        `No ${PROJECT_CONFIG_FILENAME} found in ${this.cwd}. Use "agentpm init" or add a committed ${PROJECT_CONFIG_FILENAME}.`,
      );
    }

    const manifest = loadedConfig.manifest;
    const orderedSources = await this.ensureConfiguredSources(manifest.sources);

    const installs: InstallRecord[] = [];
    for (const installSpec of manifest.installs) {
      const sourceToken =
        installSpec.source !== undefined
          ? this.resolveConfiguredSourceToken(
              installSpec.source,
              orderedSources,
            )
          : this.resolveSourceForConfiguredSkill(
              installSpec.items,
              orderedSources,
              installSpec.target ?? installSpec.adapter,
            );
      const created = await this.install([sourceToken], {
        scope: installSpec.scope,
        workspaceRoot: installSpec.workspaceRoot,
        skills: installSpec.items,
        ref: installSpec.ref ?? null,
        revision: installSpec.revision ?? null,
        target: installSpec.target ?? installSpec.adapter,
        yes: true,
        updateProjectConfig: false,
      });
      installs.push(...created);
    }

    return installs;
  }

  async addTarget(
    id: string,
    locator: string,
    global = false,
    defaultTarget = false,
  ): Promise<void> {
    await this.initialize();
    const sourceKind = await this.classifySource(locator);
    const pushKind = sourceKind === 'local' ? ('git' as const) : sourceKind;
    if (global) {
      const { addTargetToGlobalConfig } = await import('@agentpm/config');
      await addTargetToGlobalConfig(
        this.cwd,
        {
          id,
          locator,
          kind: pushKind,
          default: defaultTarget,
        },
        this.env,
      );
    } else {
      const { addTargetToProjectConfig } = await import('@agentpm/config');
      await addTargetToProjectConfig(this.cwd, {
        id,
        locator,
        kind: pushKind,
        default: defaultTarget,
      });
    }
  }

  async setDefaultTarget(id: string, global = false): Promise<void> {
    await this.initialize();
    if (global) {
      const { setDefaultGlobalTarget } = await import('@agentpm/config');
      await setDefaultGlobalTarget(this.cwd, id, this.env);
    } else {
      const { setDefaultProjectTarget } = await import('@agentpm/config');
      await setDefaultProjectTarget(this.cwd, id);
    }
  }

  async removeTarget(id: string, global = false): Promise<void> {
    await this.initialize();
    if (global) {
      const { removeTargetFromGlobalConfig } = await import('@agentpm/config');
      await removeTargetFromGlobalConfig(this.cwd, id, this.env);
    } else {
      const { removeTargetFromProjectConfig } = await import('@agentpm/config');
      await removeTargetFromProjectConfig(this.cwd, id);
    }
  }

  async push(options: PushOptions = {}): Promise<PushResult> {
    await this.initialize();
    const loadedConfig = await loadProjectConfig(this.cwd);
    const target = await this.resolvePushTarget(options.target, loadedConfig);
    const entries = await this.resolvePushCandidates(options.path, options.all);

    if (entries.length === 0) {
      return {
        success: true,
        targetLocator: target.locator,
        warnings: ['No entries selected.'],
        entries: [],
      };
    }

    if (target.kind === 'git') {
      return this.pushToGit(
        target.locator,
        entries,
        options.message,
        options.dryRun,
      );
    }

    if (target.kind === 'registry') {
      throw new AgentPmError('Registry push is not implemented yet.');
    }

    throw new AgentPmError(`Unsupported push target kind: ${target.kind}`);
  }

  private async resolvePushTarget(
    token: string | undefined,
    config: LoadedProjectConfig | null,
  ): Promise<ManifestPushTargetSpec> {
    const { loadGlobalConfig } = await import('@agentpm/config');
    const globalConfig = await loadGlobalConfig(this.cwd, this.env);

    const useProjectTargets = (config?.manifest.targets ?? []).length > 0;
    const targets = useProjectTargets
      ? (config?.manifest.targets ?? [])
      : (globalConfig.targets ?? []);

    if (token) {
      const match = targets.find((t) => t.id === token || t.locator === token);
      if (match) {
        return match;
      }
      return {
        locator: token,
        kind: classifyLocator(token) === 'registry' ? 'registry' : 'git',
      };
    }

    const defaultTarget = targets.find((t) => t.default);
    if (defaultTarget) {
      return defaultTarget;
    }

    if (targets.length === 1) {
      return targets[0]!;
    }

    if (targets.length > 1 && this.prompts.selectOne) {
      const selected = await this.prompts.selectOne(
        'Choose a push target:',
        targets.map((target) => ({
          label: target.id ?? target.locator,
          value: target,
          description: `${target.kind ?? 'git'}  ${target.locator}`,
        })),
      );
      if (selected.id && this.prompts.confirm) {
        const shouldSaveDefault = await this.prompts.confirm(
          `Save "${selected.id}" as the default push target?`,
          [
            useProjectTargets
              ? 'The default will be written to agentpm.yaml.'
              : 'The default will be written to global AgentPM config.',
          ],
        );
        if (shouldSaveDefault) {
          await this.setDefaultTarget(selected.id, !useProjectTargets);
        }
      }
      return selected;
    }

    const available =
      targets.length > 0
        ? targets
            .map(
              (target) =>
                `  - ${target.id ?? target.locator} (${target.kind ?? 'git'}) ${target.locator}`,
            )
            .join('\n')
        : '  - none configured';
    throw new AgentPmError(
      `No push target specified and no default target configured in agentpm.yaml or global config.\n\nAvailable targets:\n${available}\n\nUse --to <target>, or set one with: agentpm target default <id>${useProjectTargets ? '' : ' --global'}`,
    );
  }

  private installRecordToManifestSpec(install: InstallRecord): ManifestInstallSpec {
    return {
      name: install.name,
      source: install.sourceId,
      items:
        install.selectedItems.length > 0 ? install.selectedItems : [install.name],
      scope: install.scope === 'global' ? 'project' : install.scope,
      ref: install.contentRef ?? undefined,
      revision: install.installedRevision ?? undefined,
      target: install.adapter,
      workspaceRoot:
        install.scope === 'workspace' ? install.scopeRoot : undefined,
    };
  }

  private async updateExistingProjectConfig(
    installs: InstallRecord[],
  ): Promise<void> {
    const loadedConfig = await loadProjectConfig(this.cwd);
    if (!loadedConfig || loadedConfig.format !== 'agentpm.yaml') {
      return;
    }

    const localInstalls = installs.filter((install) => install.scope !== 'global');
    if (localInstalls.length === 0) {
      return;
    }

    const sources = localInstalls
      .map((install) => this.db.getSource(install.sourceId))
      .filter((source): source is SourceRecord => Boolean(source))
      .map((source) => ({
        id: source.id,
        locator: source.locator,
        kind: source.kind,
      } satisfies ManifestSourceSpec));

    const uniqueSources = [
      ...new Map(sources.map((source) => [source.id ?? source.locator, source])).values(),
    ];

    await upsertProjectConfigInstalls(this.cwd, {
      sources: uniqueSources,
      installs: localInstalls.map((install) => this.installRecordToManifestSpec(install)),
    });
  }

  private async discoverPushCandidates(
    rootPath: string,
  ): Promise<PushCandidate[]> {
    const report = await inspectRepository(rootPath, rootPath, 'local');
    const entries = listInstallableEntries(report);
    const candidates = entries.map((entry) => {
      return {
        name: entry.name,
        adapter: entry.adapter,
        sourcePath: path.join(rootPath, entry.relativePath),
        sourceRelativePath: entry.relativePath,
        destinationRelativePath: entry.relativePath,
      } satisfies PushCandidate;
    });

    const installedCandidates = this.db
      .listInstalls()
      .filter((install) => path.resolve(install.scopeRoot) === rootPath)
      .map((install) => ({
        name: install.name,
        adapter: install.adapter,
        sourcePath: install.linkTarget,
        sourceRelativePath: install.sourceRelativePath,
        destinationRelativePath: toPosixPath(
          path.relative(rootPath, install.targetPath),
        ),
      }));

    return [
      ...new Map(
        [...candidates, ...installedCandidates].map((candidate) => [
          candidate.destinationRelativePath,
          candidate,
        ]),
      ).values(),
    ].sort((left, right) =>
      left.destinationRelativePath.localeCompare(right.destinationRelativePath),
    );
  }

  private async resolvePushCandidates(
    token: string | undefined,
    all = false,
  ): Promise<PushCandidate[]> {
    const workspaceCandidates = await this.discoverPushCandidates(this.cwd);

    if (workspaceCandidates.length === 0) {
      throw new AgentPmError(
        'No pushable skills or agents were detected in the current workspace.',
      );
    }

    if (all) {
      return workspaceCandidates;
    }

    const normalizedToken = normalizeCatalogSelector(token ?? '.');
    if (normalizedToken && normalizedToken !== '.') {
      const resolvedPath = path.resolve(this.cwd, normalizedToken);
      const pathMatches = (await pathExists(resolvedPath))
        ? workspaceCandidates.filter((candidate) => {
            const candidateRoot = path.resolve(candidate.sourcePath);
            return (
              resolvedPath === candidateRoot ||
              resolvedPath.startsWith(`${candidateRoot}${path.sep}`)
            );
          })
        : [];

      if (pathMatches.length > 0) {
        return this.choosePushCandidates(pathMatches, normalizedToken);
      }

      const selectorMatches = workspaceCandidates.filter((candidate) => {
        const destinationBase = path.basename(
          candidate.destinationRelativePath,
        );
        const sourceBase = path.basename(candidate.sourceRelativePath);
        return (
          candidate.name === normalizedToken ||
          candidate.sourceRelativePath === normalizedToken ||
          candidate.destinationRelativePath === normalizedToken ||
          sourceBase === normalizedToken ||
          destinationBase === normalizedToken
        );
      });

      if (selectorMatches.length > 0) {
        return this.choosePushCandidates(selectorMatches, normalizedToken);
      }

      if (await pathExists(resolvedPath)) {
        const directCandidates =
          await this.discoverPushCandidates(resolvedPath);
        if (directCandidates.length > 0) {
          return directCandidates;
        }
      }

      const available = workspaceCandidates
        .map(
          (candidate) =>
            `  - ${candidate.name} -> ${candidate.destinationRelativePath}`,
        )
        .join('\n');
      throw new AgentPmError(
        `Could not find a pushable skill or agent matching "${token}".\n\nAvailable entries:\n${available}`,
      );
    }

    if (workspaceCandidates.length === 1) {
      return workspaceCandidates;
    }

    if (this.prompts.selectMany) {
      return this.prompts.selectMany(
        'Choose skills or agents to push:',
        workspaceCandidates.map((candidate) => ({
          label: candidate.name,
          value: candidate,
          description: `${candidate.adapter}  ${candidate.destinationRelativePath}`,
        })),
      );
    }

    const available = workspaceCandidates
      .map(
        (candidate) =>
          `  - ${candidate.name} -> ${candidate.destinationRelativePath}`,
      )
      .join('\n');
    throw new AgentPmError(
      `Multiple pushable entries were detected. Re-run with a skill name, a path, or --all.\n\nAvailable entries:\n${available}`,
    );
  }

  private async choosePushCandidates(
    matches: PushCandidate[],
    token: string,
  ): Promise<PushCandidate[]> {
    if (matches.length === 1) {
      return matches;
    }

    if (!this.prompts.selectOne) {
      const available = matches
        .map(
          (candidate) =>
            `  - ${candidate.name} -> ${candidate.destinationRelativePath}`,
        )
        .join('\n');
      throw new AgentPmError(
        `Multiple pushable entries matched "${token}". Re-run in interactive mode or use a more specific path.\n\nMatches:\n${available}`,
      );
    }

    const selected = await this.prompts.selectOne(
      `Multiple entries match "${token}". Choose one to push:`,
      matches.map((candidate) => ({
        label: candidate.name,
        value: candidate,
        description: `${candidate.adapter}  ${candidate.destinationRelativePath}`,
      })),
    );
    return [selected];
  }

  private async pushToGit(
    locator: string,
    entries: PushCandidate[],
    message?: string,
    dryRun?: boolean,
  ): Promise<PushResult> {
    const warnings: string[] = [];
    const pushedEntries = entries.map((entry) => entry.destinationRelativePath);
    if (dryRun) {
      return {
        success: true,
        targetLocator: locator,
        warnings: ['Dry run: would push to ' + locator],
        entries: pushedEntries,
      };
    }
    try {
      const { repoPath: releasePath } =
        await this.preparePushTargetRepository(locator);

      this.reportStatus(
        `Copying ${entries.length === 1 ? entries[0]!.name : `${entries.length} selected entries`} into the target repository...`,
      );
      for (const entry of entries) {
        const destinationRoot = path.join(
          releasePath,
          entry.destinationRelativePath,
        );
        await fs.rm(destinationRoot, { recursive: true, force: true });

        const files = await walkFiles(entry.sourcePath);
        for (const file of files) {
          const relative = path.relative(entry.sourcePath, file);
          const destination = path.join(destinationRoot, relative);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.copyFile(file, destination);
        }
      }

      const destinationPathspecs = entries.map((entry) =>
        toPosixPath(entry.destinationRelativePath),
      );
      await runGitCommand(
        ['add', '-A', '--force', '--', ...destinationPathspecs],
        {
          cwd: releasePath,
          env: this.env,
        },
      );

      const commitMessage =
        message ??
        `Update ${entries.length === 1 ? entries[0]!.name : `${entries.length} skills`} from AgentPM`;
      this.reportStatus('Creating Git commit...');
      await runGitCommand(['commit', '--quiet', '-m', commitMessage], {
        cwd: releasePath,
        env: this.env,
      }).catch(() => {
        warnings.push('No changes to commit or commit failed.');
      });

      const revision = (
        await runGitCommand(['rev-parse', 'HEAD'], {
          cwd: releasePath,
          env: this.env,
          captureStdout: true,
        }).catch(() => ({ stdout: '' }))
      ).stdout.trim();
      if (!revision) {
        throw new AgentPmError(
          'No commit is available to push. Add files or create a commit before pushing.',
        );
      }

      this.reportStatus('Pushing changes to the remote target...');
      await runGitCommand(['push', '--quiet', '--set-upstream', 'origin', 'HEAD'], {
        cwd: releasePath,
        env: this.env,
      });

      const cacheKey = makeId('push-target', locator);
      this.db.saveCacheRepo({
        cacheKey,
        sourceId: null,
        locator,
        kind: 'git',
        basePath: path.dirname(releasePath),
        currentRevision: revision,
        isGit: true,
        layoutSignature: null,
        metadata: {
          role: 'push-target',
        },
        updatedAt: nowIso(),
      });

      return {
        success: true,
        targetLocator: locator,
        revision,
        warnings,
        entries: pushedEntries,
      };
    } catch (error) {
      throw new AgentPmError(
        `Git push fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async preparePushTargetRepository(
    locator: string,
  ): Promise<{ repoPath: string; cacheKey: string }> {
    const cacheKey = makeId('push-target', locator);
    const cacheBasePath = this.cacheBasePath(cacheKey);
    const repoPath = path.join(cacheBasePath, 'worktree');
    const gitDir = path.join(repoPath, '.git');
    const transportLocator = await this.toGitTransportLocator(locator);

    if (!(await pathExists(gitDir))) {
      await fs.rm(cacheBasePath, { recursive: true, force: true }).catch(() => {});
      await ensureDir(cacheBasePath);
      this.reportStatus('Cloning the target repository into the local cache...');
      await runGitCommand(['clone', '--quiet', transportLocator, repoPath], {
        env: this.env,
      });
      return { repoPath, cacheKey };
    }

    this.reportStatus('Refreshing the cached target repository...');
    await runGitCommand(['reset', '--hard', '--quiet', 'HEAD'], {
      cwd: repoPath,
      env: this.env,
    }).catch(() => {});
    await runGitCommand(['clean', '-fd'], {
      cwd: repoPath,
      env: this.env,
    }).catch(() => {});
    await runGitCommand(['fetch', '--quiet', 'origin', '--prune'], {
      cwd: repoPath,
      env: this.env,
    }).catch(() => {});
    await runGitCommand(['pull', '--ff-only', '--quiet'], {
      cwd: repoPath,
      env: this.env,
    }).catch(() => {});

    return { repoPath, cacheKey };
  }

  async resolveRuntimeContext(
    options: { temporarySkills?: string[] } = {},
  ): Promise<RuntimeContextGraph> {
    await this.initialize();
    const loadedConfig = await loadProjectConfig(this.cwd);
    const sourceBindings = loadedConfig
      ? await this.ensureConfiguredSources(loadedConfig.manifest.sources)
      : [];
    const sources = sourceBindings.map((binding) => binding.source);
    const globalEntries = this.db
      .listInstalls()
      .filter((install) => install.scope === 'global')
      .map((install) => this.runtimeEntryFromInstall('global', install));

    const projectEntries = loadedConfig
      ? loadedConfig.manifest.installs.map((installSpec) => {
          const sourceToken =
            installSpec.source !== undefined
              ? this.resolveConfiguredSourceToken(
                  installSpec.source,
                  sourceBindings,
                )
              : this.resolveSourceForConfiguredSkill(
                  installSpec.items,
                  sourceBindings,
                  installSpec.target ?? installSpec.adapter,
                );
          const source = this.findSourceByToken(sourceToken);
          const itemSelector = installSpec.items[0] ?? installSpec.name;
          const target = installSpec.target ?? installSpec.adapter;
          const entry = source
            ? this.db
                .listCatalogEntriesBySource(source.id)
                .find(
                  (candidate) =>
                    matchesCatalogEntrySelector(candidate, itemSelector) &&
                    matchesCatalogEntryTarget(candidate, target),
                )
            : null;
          const installed =
            this.findProjectInstall(
              entry?.name ?? installSpec.name,
              installSpec.scope,
              installSpec.workspaceRoot,
            ) ??
            (entry?.path
              ? this.findProjectInstallBySourcePath(
                  entry.path,
                  installSpec.scope,
                  installSpec.workspaceRoot,
                )
              : null);

          return {
            layer: 'project' as const,
            name: entry?.name ?? installSpec.name,
            sourceId: source?.id ?? null,
            sourceLocator: source?.locator ?? null,
            adapter: target ?? entry?.adapterHint ?? installed?.adapter ?? null,
            sourceRelativePath:
              entry?.path ?? installed?.sourceRelativePath ?? null,
            targetPath: installed?.targetPath ?? null,
            linkTarget: installed?.linkTarget ?? null,
            scope: installed?.scope ?? installSpec.scope,
            warnings: entry
              ? []
              : [
                  `Configured skill "${installSpec.name}" is not indexed in resolved sources.`,
                ],
          } satisfies RuntimeContextEntry;
        })
      : [];

    const temporaryEntries = (options.temporarySkills ?? []).map((name) =>
      this.resolveTemporaryRuntimeEntry(name, sourceBindings),
    );
    const warnings = loadedConfig
      ? loadedConfig.warnings
      : [
          `No ${PROJECT_CONFIG_FILENAME} found; project layer is empty. ${LOCAL_PROJECT_CONFIG_FILENAME} is only a local override file.`,
        ];

    return {
      cwd: this.cwd,
      configPath: loadedConfig?.configPath ?? null,
      sources,
      layers: {
        global: globalEntries,
        project: projectEntries,
        temporary: temporaryEntries,
      },
      warnings,
    };
  }

  async doctor(): Promise<DoctorIssue[]> {
    await this.initialize();
    const issues: DoctorIssue[] = [];
    const loadedConfig = await loadProjectConfig(this.cwd).catch(
      (error: unknown) => {
        issues.push({
          severity: 'error',
          code: 'config-invalid',
          path: this.paths.manifestPath,
          message:
            error instanceof Error
              ? `Project config is invalid: ${error.message}`
              : 'Project config is invalid.',
          remedy:
            'Fix agentpm.yaml so sources is an array and skills entries are strings or valid objects.',
        });
        return null;
      },
    );

    if (loadedConfig) {
      const configuredSources = loadedConfig.manifest.sources.map((source) => ({
        id: source.id,
        rawLocator: source.locator,
        normalizedLocator: this.normalizeLocator(
          source.locator,
          source.kind ?? classifyLocator(source.locator),
        ),
      }));
      for (const installSpec of loadedConfig.manifest.installs) {
        if (!installSpec.source) {
          continue;
        }
        const matchesConfiguredSource = configuredSources.some(
          (source) =>
            source.id === installSpec.source ||
            source.rawLocator === installSpec.source ||
            source.normalizedLocator === installSpec.source,
        );
        if (!matchesConfiguredSource) {
          issues.push({
            severity: 'error',
            code: 'config-source-missing',
            path: loadedConfig.configPath,
            message: `Configured skill "${installSpec.name}" references unknown source "${installSpec.source}".`,
            remedy:
              'Add a matching source id or locator under sources, or update the skill source field.',
          });
        }
      }

      const configuredBindings = await this.ensureConfiguredSources(
        loadedConfig.manifest.sources,
      ).catch((error: unknown) => {
        issues.push({
          severity: 'error',
          code: 'config-source-unavailable',
          path: loadedConfig.configPath,
          message:
            error instanceof Error
              ? `Configured source is unavailable: ${error.message}`
              : 'Configured source is unavailable.',
          remedy:
            'Verify private Git credentials, registry tokens, or local source paths.',
        });
        return [] as ConfiguredSourceBinding[];
      });

      if (configuredBindings.length > 0) {
        for (const installSpec of loadedConfig.manifest.installs) {
          const target = installSpec.target ?? installSpec.adapter;
          try {
            const sourceToken =
              installSpec.source !== undefined
                ? this.resolveConfiguredSourceToken(
                    installSpec.source,
                    configuredBindings,
                  )
                : this.resolveSourceForConfiguredSkill(
                    installSpec.items,
                    configuredBindings,
                    target,
                  );
            const source = this.findSourceByToken(sourceToken);
            const entries = source
              ? this.db.listCatalogEntriesBySource(source.id)
              : [];
            const hasMatchingEntry = installSpec.items.some((item) =>
              entries.some(
                (entry) =>
                  matchesCatalogEntrySelector(entry, item) &&
                  matchesCatalogEntryTarget(entry, target),
              ),
            );
            if (!hasMatchingEntry) {
              issues.push({
                severity: 'error',
                code: 'config-skill-missing',
                path: loadedConfig.configPath,
                message: `Configured skill "${installSpec.name}" is not available from the resolved source${target ? ` for target "${target}"` : ''}.`,
                remedy:
                  'Check the skill items, source id, registry path, or target value.',
              });
            }
          } catch (error) {
            issues.push({
              severity: 'error',
              code: 'config-skill-unresolved',
              path: loadedConfig.configPath,
              message:
                error instanceof Error
                  ? error.message
                  : `Configured skill "${installSpec.name}" could not be resolved.`,
              remedy:
                'Check the skill source, item selectors, source order, and target.',
            });
          }
        }
      }
    }

    for (const source of this.db.listSources()) {
      if (source.kind === 'local' && !(await pathExists(source.locator))) {
        issues.push({
          severity: 'error',
          code: 'source-missing',
          sourceId: source.id,
          path: source.locator,
          message: `Local source is missing: ${source.locator}`,
          remedy: 'Remove or re-add the source with a valid path.',
        });
      }

      if (source.kind === 'git') {
        try {
          await resolveGitRevision(source.locator, undefined, this.env);
        } catch (error) {
          issues.push({
            severity: 'error',
            code: 'source-unavailable',
            sourceId: source.id,
            message: `Git source is unavailable: ${source.locator}`,
            remedy:
              error instanceof Error
                ? error.message
                : 'Verify network access and repository permissions.',
          });
        }
      }

      if (
        source.kind === 'registry' &&
        this.db.listCatalogEntriesBySource(source.id).length === 0
      ) {
        issues.push({
          severity: 'warning',
          code: 'registry-empty',
          sourceId: source.id,
          message: `Registry source ${source.displayName} has no indexed entries.`,
          remedy: 'Re-add the source or inspect the registry index file.',
        });
      }
    }

    for (const install of this.db.listInstalls()) {
      const targetMissing = !(await pathExists(install.targetPath));
      if (targetMissing) {
        issues.push({
          severity: 'error',
          code: 'install-missing',
          installId: install.id,
          path: install.targetPath,
          message: `Install target is missing: ${install.targetPath}`,
          remedy: 'Reinstall or remove the missing install record.',
        });
      } else if (await isBrokenLink(install.targetPath)) {
        issues.push({
          severity: 'error',
          code: 'broken-link',
          installId: install.id,
          path: install.targetPath,
          message: `Broken link detected: ${install.targetPath}`,
          remedy: 'Run agentpm remove/install to repair the link.',
        });
      }

      if (
        install.cacheKey &&
        !targetMissing &&
        !(await pathExists(this.cacheBasePath(install.cacheKey)))
      ) {
        issues.push({
          severity: 'error',
          code: 'missing-cache',
          installId: install.id,
          path: this.cacheBasePath(install.cacheKey),
          message: 'Cached release is missing.',
          remedy: 'Reinstall or update the entry to restore the cache.',
        });
      }

      if (
        install.contentKind === 'local' &&
        !(await pathExists(install.contentLocator))
      ) {
        issues.push({
          severity: 'error',
          code: 'source-content-missing',
          installId: install.id,
          path: install.contentLocator,
          message: `Local install source is missing: ${install.contentLocator}`,
          remedy: 'Restore the source path or reinstall from another source.',
        });
      }

      try {
        await fs.access(path.dirname(install.targetPath), fsConstants.W_OK);
      } catch {
        issues.push({
          severity: 'warning',
          code: 'permission-warning',
          installId: install.id,
          path: install.targetPath,
          message: `Write access looks restricted for ${path.dirname(install.targetPath)}`,
          remedy: 'Check permissions before updating or removing this install.',
        });
      }

      if (install.scope !== 'global') {
        const tracked = await this.isGitTrackedPath(
          install.scopeRoot,
          install.targetPath,
        );
        if (tracked) {
          issues.push({
            severity: 'warning',
            code: 'generated-target-tracked',
            installId: install.id,
            path: install.targetPath,
            message: `Generated AgentPM target is tracked by Git: ${install.targetPath}`,
            remedy:
              'Remove the generated target from Git tracking and keep only agentpm.yaml committed.',
          });
        }
      }
    }

    return issues;
  }

  async planDoctorFixes(
    issues: DoctorIssue[] | null = null,
  ): Promise<DoctorFixAction[]> {
    await this.initialize();
    const doctorIssues = issues ?? (await this.doctor());
    const actions: DoctorFixAction[] = [];

    for (const issue of doctorIssues) {
      if (issue.code === 'install-missing' && issue.installId) {
        const install = this.db.getInstall(issue.installId);
        if (!install) {
          continue;
        }
        actions.push({
          code: 'remove-install-record',
          installId: install.id,
          description: `Removing stale install record: ${install.name} (${install.targetPath})`,
        });
        continue;
      }

      if (
        !issue.sourceId ||
        (issue.code !== 'source-missing' &&
          issue.code !== 'source-unavailable' &&
          issue.code !== 'registry-empty')
      ) {
        continue;
      }

      const source = this.db.getSource(issue.sourceId);
      if (!source || this.db.countInstallsForSource(source.id) > 0) {
        continue;
      }

      actions.push({
        code: 'remove-source',
        sourceId: source.id,
        description: `Removing unreachable source: ${source.displayName} (${source.locator})`,
      });
    }

    return actions;
  }

  async applyDoctorFixes(
    actions: DoctorFixAction[],
  ): Promise<DoctorFixResult[]> {
    await this.initialize();
    const results: DoctorFixResult[] = [];

    for (const action of actions) {
      if (action.code === 'remove-source') {
        const source = this.db.getSource(action.sourceId);
        if (!source) {
          results.push({ action, applied: false });
          continue;
        }
        if (this.db.countInstallsForSource(source.id) > 0) {
          throw new AgentPmError(
            `Cannot remove source "${source.displayName}" while installs still depend on it.`,
          );
        }
        this.db.deleteSource(source.id);
        results.push({ action, applied: true });
      } else if (action.code === 'remove-install-record') {
        const install = this.db.getInstall(action.installId);
        if (!install) {
          results.push({ action, applied: false });
          continue;
        }
        this.db.removeInstall(install.id);
        results.push({ action, applied: true });
      }
    }

    return results;
  }

  private async reindexSource(source: SourceRecord): Promise<AddSourceResult> {
    if (source.kind === 'registry') {
      const registry = await loadRegistryIndex(source.locator);
      const entries = this.catalogEntriesFromRegistry(source, registry.entries);
      this.db.replaceCatalogEntries(source.id, entries);
      return { source, indexedEntries: entries.length };
    }

    const prepared = await this.prepareInspectionTarget(source.locator, source.kind, {
      sourceId: source.id,
    });
    try {
      const entries = this.catalogEntriesFromInspection(
        source.id,
        source.locator,
        prepared.report,
      );
      this.db.replaceCatalogEntries(source.id, entries);
      return {
        source,
        indexedEntries: entries.length,
        report: prepared.report,
      };
    } finally {
      await prepared.cleanup?.();
    }
  }

  private catalogEntriesFromRegistry(
    source: Pick<SourceRecord, 'id' | 'locator'>,
    entries: Array<{
      name: string;
      description?: string | undefined;
      repo: string;
      ref?: string | undefined;
      path?: string | undefined;
      adapterHint?: AdapterId | undefined;
      target?: AdapterId | undefined;
      tags?: string[] | undefined;
    }>,
  ): CatalogEntryRecord[] {
    return entries.map((entry) => ({
      id: makeId('cat', source.id, entry.name, entry.repo, entry.path ?? ''),
      sourceId: source.id,
      name: entry.name,
      description: entry.description ?? null,
      repo: resolveRegistryRepo(source.locator, entry.repo),
      ref: entry.ref ?? null,
      path: entry.path ?? null,
      adapterHint: entry.target ?? entry.adapterHint ?? null,
      tags: entry.tags ?? [],
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }));
  }

  private catalogEntriesFromInspection(
    sourceId: string,
    locator: string,
    report: InspectionReport,
  ): CatalogEntryRecord[] {
    return listInstallableEntries(report).map((entry) => ({
      id: makeId('cat', sourceId, entry.name, entry.relativePath),
      sourceId,
      name: entry.name,
      description: null,
      repo: locator,
      ref: null,
      path: entry.relativePath,
      adapterHint: entry.adapter,
      tags: [entry.adapter, entry.kind],
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }));
  }

  private annotateInspectionForRequest(
    report: InspectionReport,
    options: { skill?: string | undefined; target?: AdapterId | undefined },
  ): InspectionReport {
    if (!options.skill && !options.target) {
      return report;
    }

    const matchingEntries = listInstallableEntries(report).filter(
      (entry) =>
        (!options.skill ||
          matchesCatalogEntrySelector(
            {
              id: '',
              sourceId: '',
              name: entry.name,
              description: null,
              repo: report.locator,
              ref: null,
              path: entry.relativePath,
              adapterHint: entry.adapter,
              tags: [],
              metadata: {},
              createdAt: '',
              updatedAt: '',
            },
            options.skill,
          )) &&
        (!options.target || entry.adapter === options.target),
    );
    const request = [
      options.skill ? `skill "${options.skill}"` : null,
      options.target ? `target "${options.target}"` : null,
    ]
      .filter(Boolean)
      .join(' with ');

    return {
      ...report,
      warnings:
        matchingEntries.length > 0
          ? report.warnings
          : [...report.warnings, `No detected entry satisfies ${request}.`],
    };
  }

  private async classifySource(locator: string): Promise<SourceKind> {
    const kind = classifyLocator(locator);
    if (kind !== 'local') {
      return kind;
    }

    const resolved = path.resolve(this.normalizeLocator(locator, kind));
    const stats = await fs.stat(resolved).catch(() => null);
    if (!stats) {
      throw new AgentPmError(`Path does not exist: ${resolved}`);
    }
    if (stats.isFile()) {
      return 'registry';
    }
    return 'local';
  }

  private normalizeLocator(locator: string, kind: SourceKind): string {
    const trimmed = locator.trim();
    if (trimmed === 'skills.sh' || trimmed === 'www.skills.sh') {
      return 'https://skills.sh';
    }
    if (trimmed === 'skillshub.wtf') {
      return 'https://skillshub.wtf';
    }
    if (trimmed.startsWith('registry+https://')) {
      return trimmed.slice('registry+'.length);
    }
    if (trimmed.startsWith('registry:')) {
      return trimmed.slice('registry:'.length);
    }
    if (trimmed.startsWith('github:')) {
      const repo = trimmed
        .slice('github:'.length)
        .replace(/^\/+/, '')
        .replace(/\.git$/i, '');
      return `https://github.com/${repo}.git`;
    }
    if (trimmed.startsWith('local:')) {
      const localPath = trimmed.slice('local:'.length);
      return path.resolve(this.expandHomePath(localPath));
    }
    if (kind === 'local' || (kind === 'registry' && !locator.includes('://'))) {
      return path.resolve(this.expandHomePath(locator));
    }
    return trimmed;
  }

  private expandHomePath(locator: string): string {
    if (locator === '~') {
      return os.homedir();
    }
    if (locator.startsWith(`~${path.sep}`) || locator.startsWith('~/')) {
      return path.join(os.homedir(), locator.slice(2));
    }
    return locator;
  }

  private findSourceByToken(token: string): SourceRecord | null {
    const exact = this.db.getSourceByLocator(token);
    if (exact) {
      return exact;
    }

    return (
      this.db.listSources().find((source) => {
        const normalizedToken = this.normalizeLocator(token, source.kind);
        return (
          source.displayName === token ||
          source.id === token ||
          source.locator === normalizedToken ||
          source.normalizedLocator === normalizedToken ||
          slugify(source.displayName) === token
        );
      }) ?? null
    );
  }

  private async ensureConfiguredSources(
    sourceSpecs: ManifestSourceSpec[],
  ): Promise<ConfiguredSourceBinding[]> {
    const bindings: ConfiguredSourceBinding[] = [];
    for (const sourceSpec of sourceSpecs) {
      const source =
        (sourceSpec.id ? this.findSourceByToken(sourceSpec.id) : null) ??
        this.findSourceByToken(sourceSpec.locator);
      if (source) {
        bindings.push({ spec: sourceSpec, source });
        continue;
      }

      const added = await this.addSource(sourceSpec.locator);
      bindings.push({ spec: sourceSpec, source: added.source });
    }
    return bindings;
  }

  private matchesConfiguredSourceToken(
    binding: ConfiguredSourceBinding,
    token: string,
  ): boolean {
    const aliases = [
      binding.spec.id,
      binding.spec.locator,
      binding.source.id,
      binding.source.locator,
      binding.source.normalizedLocator,
      binding.source.displayName,
      slugify(binding.source.displayName),
    ].filter((value): value is string => Boolean(value));

    return aliases.some((alias) => alias === token);
  }

  private resolveConfiguredSourceToken(
    token: string,
    orderedSources: ConfiguredSourceBinding[],
  ): string {
    const binding = orderedSources.find((candidate) =>
      this.matchesConfiguredSourceToken(candidate, token),
    );
    if (binding) {
      return binding.source.id;
    }

    throw new AgentPmError(
      `Configured source not found in agentpm.yaml sources: ${token}`,
    );
  }

  private resolveSourceForConfiguredSkill(
    items: string[],
    orderedSources: ConfiguredSourceBinding[],
    target?: AdapterId,
  ): string {
    for (const binding of orderedSources) {
      const entries = this.db.listCatalogEntriesBySource(binding.source.id);
      if (
        items.some((item) =>
          entries.some(
            (entry) =>
              matchesCatalogEntrySelector(entry, item) &&
              matchesCatalogEntryTarget(entry, target),
          ),
        )
      ) {
        return binding.source.id;
      }
    }

    const selectors = items.length > 0 ? items.join(', ') : '(none)';
    const targetSummary = target ? ` for target "${target}"` : '';
    throw new AgentPmError(
      `No configured source contains requested skill selector(s)${targetSummary}: ${selectors}`,
    );
  }

  private findProjectInstall(
    name: string,
    scope: InstallScope,
    workspaceRoot: string | undefined,
  ): InstallRecord | null {
    const expectedRoot =
      scope === 'workspace'
        ? path.resolve(workspaceRoot ?? this.cwd)
        : this.cwd;
    return (
      this.db
        .listInstallsByName(name)
        .find(
          (install) =>
            install.scope === scope &&
            path.resolve(install.scopeRoot) === expectedRoot,
        ) ?? null
    );
  }

  private findProjectInstallBySourcePath(
    sourceRelativePath: string,
    scope: InstallScope,
    workspaceRoot: string | undefined,
  ): InstallRecord | null {
    const expectedRoot =
      scope === 'workspace'
        ? path.resolve(workspaceRoot ?? this.cwd)
        : this.cwd;
    return (
      this.db
        .listInstalls()
        .find(
          (install) =>
            install.scope === scope &&
            path.resolve(install.scopeRoot) === expectedRoot &&
            install.sourceRelativePath === sourceRelativePath,
        ) ?? null
    );
  }

  private runtimeEntryFromInstall(
    layer: RuntimeContextEntry['layer'],
    install: InstallRecord,
  ): RuntimeContextEntry {
    const source = this.db.getSource(install.sourceId);
    return {
      layer,
      name: install.name,
      sourceId: install.sourceId,
      sourceLocator: source?.locator ?? install.contentLocator,
      adapter: install.adapter,
      sourceRelativePath: install.sourceRelativePath,
      targetPath: install.targetPath,
      linkTarget: install.linkTarget,
      scope: install.scope,
      warnings: [],
    };
  }

  private resolveTemporaryRuntimeEntry(
    name: string,
    orderedSources: ConfiguredSourceBinding[],
  ): RuntimeContextEntry {
    const sources =
      orderedSources.length > 0
        ? orderedSources.map((binding) => binding.source)
        : this.db.listSources();
    for (const source of sources) {
      const entry = this.db
        .listCatalogEntriesBySource(source.id)
        .find((candidate) => matchesCatalogEntrySelector(candidate, name));
      if (entry) {
        return {
          layer: 'temporary',
          name: entry.name,
          sourceId: source.id,
          sourceLocator: source.locator,
          adapter: entry.adapterHint,
          sourceRelativePath: entry.path,
          targetPath: null,
          linkTarget: null,
          scope: null,
          warnings: [],
        };
      }
    }

    return {
      layer: 'temporary',
      name,
      sourceId: null,
      sourceLocator: null,
      adapter: null,
      sourceRelativePath: null,
      targetPath: null,
      linkTarget: null,
      scope: null,
      warnings: [
        `Temporary skill "${name}" is not indexed in resolved sources.`,
      ],
    };
  }

  private async recordGeneratedTargetInLocalGitExclude(
    install: InstallRecord,
  ): Promise<void> {
    if (install.scope === 'global') {
      return;
    }

    const scopeRoot = path.resolve(install.scopeRoot);
    const targetPath = path.resolve(install.targetPath);
    const relativePath = path.relative(scopeRoot, targetPath);
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      return;
    }

    const gitDir = path.join(scopeRoot, '.git');
    const gitStats = await fs.stat(gitDir).catch(() => null);
    if (!gitStats?.isDirectory()) {
      return;
    }

    const excludePath = path.join(gitDir, 'info', 'exclude');
    const excludeEntry = `${toPosixPath(relativePath)}/`;
    const existing = await fs.readFile(excludePath, 'utf8').catch(() => '');
    if (existing.split(/\r?\n/).includes(excludeEntry)) {
      return;
    }

    await ensureDir(path.dirname(excludePath));
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const header = existing.includes('# AgentPM generated targets')
      ? ''
      : '# AgentPM generated targets\n';
    await fs.appendFile(
      excludePath,
      `${prefix}${header}${excludeEntry}\n`,
      'utf8',
    );
  }

  private async ensureGitignored(
    scopeRoot: string,
    targetPath: string,
    yesOption?: boolean,
  ): Promise<void> {
    const gitDir = path.join(scopeRoot, '.git');
    const gitStats = await fs.stat(gitDir).catch(() => null);
    if (!gitStats?.isDirectory()) {
      return;
    }

    const relativePath = path.relative(scopeRoot, targetPath);
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      return;
    }

    const firstSegment = relativePath.replace(/\\/g, '/').split('/')[0] ?? '';
    if (!firstSegment || !firstSegment.startsWith('.')) {
      return;
    }

    const gitignorePath = path.join(scopeRoot, '.gitignore');
    const existing = await fs.readFile(gitignorePath, 'utf8').catch(() => '');

    const lines = existing.split(/\r?\n/);
    const isIgnored = lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed === firstSegment ||
        trimmed === `${firstSegment}/` ||
        trimmed === `/${firstSegment}/` ||
        trimmed === `/${firstSegment}`
      );
    });

    if (isIgnored) {
      return;
    }

    let shouldAdd = false;
    if (yesOption) {
      shouldAdd = true;
    } else if (this.prompts.confirm) {
      shouldAdd = await this.prompts.confirm(
        `Would you like to add "${firstSegment}/" to your .gitignore?`,
        [
          `AgentPM manages links inside "${firstSegment}/" which should not be committed to Git.`,
        ],
      );
    } else {
      shouldAdd = true;
    }

    if (shouldAdd) {
      const prefix =
        existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      const header = existing.includes('# AgentPM')
        ? ''
        : '\n# AgentPM managed folders\n';
      await fs.appendFile(
        gitignorePath,
        `${prefix}${header}${firstSegment}/\n`,
        'utf8',
      );
    }
  }

  private async isGitTrackedPath(
    scopeRoot: string,
    targetPath: string,
  ): Promise<boolean> {
    const gitDir = path.join(scopeRoot, '.git');
    const gitStats = await fs.stat(gitDir).catch(() => null);
    if (!gitStats?.isDirectory()) {
      return false;
    }

    const relativePath = path.relative(scopeRoot, targetPath);
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      return false;
    }

    try {
      await execFileAsync(
        'git',
        ['ls-files', '--error-unmatch', toPosixPath(relativePath)],
        {
          cwd: scopeRoot,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async prepareInspectionTarget(
    locator: string,
    kind: SourceKind,
    options: { sourceId?: string | null } = {},
  ): Promise<PreparedContent> {
    if (kind === 'local') {
      const normalized = path.resolve(locator);
      const localGit = await isLocalGitRepository(normalized);
      const report = await inspectRepository(normalized, normalized, 'local');
      return {
        report,
        contentKind: localGit ? 'git' : 'local',
        contentLocator: normalized,
        contentRef: null,
        revision: localGit
          ? await resolveGitRevision(normalized, undefined, this.env)
          : null,
        repoRoot: normalized,
        cacheKey: null,
      };
    }

    return this.prepareGitContent(locator, {
      sourceId: options.sourceId ?? null,
      sparsePaths: [],
      requireFullCheckout: true,
    });
  }

  private async resolveSourceForInstall(
    sourceToken: string,
    addSource = false,
  ): Promise<SourceRecord> {
    const existing = this.findSourceByToken(sourceToken);
    if (existing) {
      return existing;
    }

    const kind = await this.classifySource(sourceToken);
    const normalizedLocator = this.normalizeLocator(sourceToken, kind);
    if (addSource) {
      return (await this.addSource(normalizedLocator)).source;
    }

    if (this.prompts.confirm) {
      const shouldAdd = await this.prompts.confirm(
        'Add this repo as an AgentPM source and continue?',
        [normalizedLocator],
      );
      if (shouldAdd) {
        return (await this.addSource(normalizedLocator)).source;
      }
    }

    throw new AgentPmError(
      `Source ${displayNameFromLocator(normalizedLocator)} is not configured. Re-run with --add-source or add it first using "agentpm source add ${normalizedLocator}".`,
    );
  }

  private async prepareGitContent(
    locator: string,
    options: {
      sourceId: string | null;
      ref?: string | null | undefined;
      revision?: string | null | undefined;
      sparsePaths: string[];
      requireFullCheckout?: boolean | undefined;
    },
  ): Promise<PreparedContent> {
    const requestedRef =
      options.revision ?? options.ref ?? null;
    const cacheKey = makeId('cache', locator, requestedRef ?? 'HEAD');
    const cacheBasePath = this.cacheBasePath(cacheKey);
    const existingCache = this.db.getCacheRepo(cacheKey);
    const installCount = this.db.countInstallsForCacheKey(cacheKey);
    const requireFullCheckout = Boolean(options.requireFullCheckout);
    const hasFullCheckout =
      existingCache?.metadata.fullCheckout === true;

    if (requireFullCheckout && existingCache && !hasFullCheckout) {
      if (installCount > 0) {
        const release = await createTemporaryGitRelease(
          locator,
          [],
          undefined,
          this.env,
        );
        const report = await inspectRepository(release.releasePath, locator, 'git');
        return {
          report,
          contentKind: 'git',
          contentLocator: locator,
          contentRef: requestedRef,
          revision: release.revision,
          repoRoot: release.releasePath,
          cacheKey: null,
          cleanup: async () => cleanupTemporaryRelease(release.releasePath),
        };
      }

      await fs.rm(cacheBasePath, { recursive: true, force: true });
      this.db.deleteCacheRepo(cacheKey);
    }

    const sparsePaths = requireFullCheckout
      ? []
      : normalizeSparsePaths(options.sparsePaths);
    let release = await materializeGitRelease({
      locator,
      basePath: cacheBasePath,
      sparsePaths,
      ref: options.ref,
      revision: options.revision ?? null,
      env: this.env,
    });
    let report = await inspectRepository(release.releasePath, locator, 'git');

    if (!requireFullCheckout && sparsePaths.length > 0) {
      const detectedEntries = listInstallableEntries(report);
      if (detectedEntries.length === 0) {
        if (installCount > 0) {
          const fallback = await createTemporaryGitRelease(
            locator,
            [],
            options.ref ?? undefined,
            this.env,
          );
          report = await inspectRepository(fallback.releasePath, locator, 'git');
          return {
            report,
            contentKind: 'git',
            contentLocator: locator,
            contentRef: requestedRef,
            revision: fallback.revision,
            repoRoot: fallback.releasePath,
            cacheKey: null,
            cleanup: async () => cleanupTemporaryRelease(fallback.releasePath),
          };
        }

        await fs.rm(cacheBasePath, { recursive: true, force: true });
        this.db.deleteCacheRepo(cacheKey);
        release = await materializeGitRelease({
          locator,
          basePath: cacheBasePath,
          sparsePaths: [],
          ref: options.ref,
          revision: options.revision ?? null,
          env: this.env,
        });
        report = await inspectRepository(release.releasePath, locator, 'git');
      }
    }

    const metadata = {
      ...(existingCache?.metadata ?? {}),
      fullCheckout:
        requireFullCheckout ||
        existingCache?.metadata.fullCheckout === true ||
        sparsePaths.length === 0,
      sparsePaths,
    };
    this.db.saveCacheRepo({
      cacheKey,
      sourceId: options.sourceId ?? existingCache?.sourceId ?? null,
      locator,
      kind: 'git',
      basePath: cacheBasePath,
      currentRevision: release.revision,
      isGit: true,
      layoutSignature: report.layoutSignature,
      metadata,
      updatedAt: nowIso(),
    });

    return {
      report,
      contentKind: 'git',
      contentLocator: locator,
      contentRef: requestedRef,
      revision: release.revision,
      repoRoot: release.releasePath,
      cacheKey,
    };
  }

  private async resolveSelections(
    names: string[],
    options: InstallOptions,
  ): Promise<Array<{ source: SourceRecord; entry: CatalogEntryRecord }>> {
    const forcedSource = options.from
      ? await this.resolveSourceForInstall(options.from, options.addSource)
      : null;
    const requestedNames =
      options.skills && options.skills.length > 0 ? options.skills : names;

    if (forcedSource) {
      const entries = this.db
        .listCatalogEntriesBySource(forcedSource.id)
        .filter((entry) => matchesCatalogEntryTarget(entry, options.target));

      if (entries.length === 0) {
        const targetSummary = options.target ? ` for ${options.target}` : '';
        throw new AgentPmError(
          `No installable entries${targetSummary} were found in source ${forcedSource.displayName}. Run "agentpm source skills ${forcedSource.id}" or "agentpm inspect ${forcedSource.locator}" for details.`,
        );
      }

      if (options.all) {
        const filtered = entries.filter(
          (entry) =>
            requestedNames.length === 0 ||
            requestedNames.some((skillSelector) =>
              matchesCatalogEntrySelector(entry, skillSelector),
            ),
        );
        if (filtered.length === 0) {
          const targetSummary = options.target ? ` for ${options.target}` : '';
          throw new AgentPmError(
            `No requested skills${targetSummary} were found in source ${forcedSource.displayName}.`,
          );
        }
        return filtered.map((entry) => ({ source: forcedSource, entry }));
      }

      if (requestedNames.length > 0) {
        return this.resolveNamedSelectionsFromSource(
          forcedSource,
          entries,
          requestedNames,
          options.target,
        );
      }

      if (entries.length === 1) {
        return [{ source: forcedSource, entry: entries[0]! }];
      }

      if (this.prompts.selectMany) {
        const selected = await this.prompts.selectMany(
          `Choose skills to install from ${forcedSource.displayName}:`,
          entries.map((entry) => ({
            label: entry.name,
            description: `${entry.adapterHint ?? 'unknown'}  ${entry.path ?? entry.repo}`,
            value: entry,
          })),
        );
        if (selected.length === 0) {
          return [];
        }
        return selected.map((entry) => ({ source: forcedSource, entry }));
      }

      const available = entries
        .map((entry) => `  - ${entry.name} (${entry.path ?? entry.repo})`)
        .join('\n');
      throw new AgentPmError(
        `Multiple installable entries were found in source ${forcedSource.displayName}. Re-run interactively, pass --skill <name>, or use --all.\n\nAvailable entries:\n${available}`,
      );
    }

    const sources = this.db.listSources();
    if (sources.length === 0) {
      throw new AgentPmError(
        'No sources have been added yet. Use "agentpm source add" first.',
      );
    }

    if (options.all) {
      const sourceToken = names[0];
      let source = sourceToken ? this.findSourceByToken(sourceToken) : null;
      if (!source) {
        if (!this.prompts.selectOne) {
          throw new AgentPmError(
            'Installing all entries requires a source argument or an interactive TTY.',
          );
        }
        source = await this.prompts.selectOne(
          'Choose a source to install from:',
          sources.map((candidate) => ({
            label: candidate.displayName,
            description: candidate.locator,
            value: candidate,
          })),
        );
      }

      const entries = this.db
        .listCatalogEntriesBySource(source.id)
        .filter(
          (entry) =>
            (!options.skills ||
              options.skills.length === 0 ||
              options.skills.some((skillSelector) =>
                matchesCatalogEntrySelector(entry, skillSelector),
              )) &&
            matchesCatalogEntryTarget(entry, options.target),
        );
      if (entries.length === 0) {
        throw new AgentPmError(
          `No installable entries found for source ${source.displayName}.`,
        );
      }
      return entries.map((entry) => ({ source, entry }));
    }

    if (names.length === 1 && options.skills && options.skills.length > 0) {
      const source = this.findSourceByToken(names[0]!);
      if (source) {
        const entries = this.db
          .listCatalogEntriesBySource(source.id)
          .filter(
            (entry) =>
              Boolean(
                options.skills?.some((skillSelector) =>
                  matchesCatalogEntrySelector(entry, skillSelector),
                ),
              ) && matchesCatalogEntryTarget(entry, options.target),
          );
        if (entries.length === 0) {
          const targetSummary = options.target ? ` for ${options.target}` : '';
          throw new AgentPmError(
            `No requested skills${targetSummary} were found in source ${source.displayName}.`,
          );
        }
        return entries.map((entry) => ({ source, entry }));
      }
    }

    if (requestedNames.length === 0) {
      if (!this.prompts.selectOne) {
        throw new AgentPmError(
          'No install target supplied. Re-run interactively or provide a skill name.',
        );
      }

      const allEntries = this.db.listCatalogEntries();
      if (allEntries.length === 0) {
        throw new AgentPmError(
          'No catalog entries are indexed yet. Add a source first.',
        );
      }

      const entry = await this.prompts.selectOne(
        'Choose an entry to install:',
        allEntries.map((candidate) => {
          const source = this.db.getSource(candidate.sourceId);
          return {
            label: candidate.name,
            description: source
              ? `${source.displayName} · ${candidate.repo}`
              : candidate.repo,
            value: candidate,
          };
        }),
      );
      const source = this.db.getSource(entry.sourceId);
      if (!source) {
        throw new AgentPmError(
          `Missing source for catalog entry ${entry.name}`,
        );
      }
      return [{ source, entry }];
    }

    const selections: Array<{
      source: SourceRecord;
      entry: CatalogEntryRecord;
    }> = [];
    for (const requestedName of requestedNames) {
      const matches = this.db
        .listCatalogEntries()
        .filter(
          (entry) =>
            matchesCatalogEntrySelector(entry, requestedName) &&
            matchesCatalogEntryTarget(entry, options.target),
        );
      if (matches.length === 0) {
        const targetSummary = options.target
          ? ` for target "${options.target}"`
          : '';
        throw new AgentPmError(
          `No catalog entry named "${requestedName}"${targetSummary} found.`,
        );
      }

      let entry = matches[0]!;
      if (matches.length > 1) {
        if (!this.prompts.selectOne) {
          throw new AgentPmError(
            `Multiple catalog entries named "${requestedName}" found. Re-run interactively.`,
          );
        }
        entry = await this.prompts.selectOne(
          `Choose which "${requestedName}" entry to install:`,
          matches.map((candidate) => {
            const source = this.db.getSource(candidate.sourceId);
            return {
              label: `${candidate.name} (${source?.displayName ?? candidate.sourceId})`,
              description: candidate.repo,
              value: candidate,
            };
          }),
        );
      }

      const source = this.db.getSource(entry.sourceId);
      if (!source) {
        throw new AgentPmError(
          `Missing source for catalog entry ${entry.name}`,
        );
      }
      selections.push({ source, entry });
    }

    return selections;
  }

  private async resolveNamedSelectionsFromSource(
    source: SourceRecord,
    entries: CatalogEntryRecord[],
    selectors: string[],
    target?: AdapterId,
  ): Promise<Array<{ source: SourceRecord; entry: CatalogEntryRecord }>> {
    const selections: Array<{ source: SourceRecord; entry: CatalogEntryRecord }> =
      [];
    for (const selector of selectors) {
      const matches = entries.filter((entry) =>
        matchesCatalogEntrySelector(entry, selector),
      );
      if (matches.length === 0) {
        const targetSummary = target ? ` for target "${target}"` : '';
        throw new AgentPmError(
          `No catalog entry named "${selector}"${targetSummary} found in source ${source.displayName}.`,
        );
      }

      let entry = matches[0]!;
      if (matches.length > 1) {
        if (!this.prompts.selectOne) {
          const available = matches
            .map(
              (candidate) =>
                `  - ${candidate.name} (${candidate.path ?? candidate.repo})`,
            )
            .join('\n');
          throw new AgentPmError(
            `Multiple entries named "${selector}" were found in source ${source.displayName}. Re-run interactively or use a more specific path selector.\n\nMatches:\n${available}`,
          );
        }
        entry = await this.prompts.selectOne(
          `Choose which "${selector}" entry to install from ${source.displayName}:`,
          matches.map((candidate) => ({
            label: candidate.name,
            description: `${candidate.adapterHint ?? 'unknown'}  ${candidate.path ?? candidate.repo}`,
            value: candidate,
          })),
        );
      }

      selections.push({ source, entry });
    }

    return selections;
  }

  private async resolveScope(scope?: InstallScope): Promise<InstallScope> {
    if (scope) {
      return scope;
    }

    if (this.prompts.selectOne) {
      return this.prompts.selectOne('Choose an install scope:', [
        { label: 'Project', description: this.cwd, value: 'project' as const },
        {
          label: 'Global',
          description: 'Install into your home directory native target',
          value: 'global' as const,
        },
        {
          label: 'Workspace',
          description: 'Install into a workspace root',
          value: 'workspace' as const,
        },
      ]);
    }

    return 'project';
  }

  private async prepareContentForEntry(
    entry: CatalogEntryRecord,
    source: SourceRecord,
    overrides: {
      ref?: string | null | undefined;
      revision?: string | null | undefined;
    },
  ): Promise<PreparedContent> {
    const contentLocator = this.resolveContentLocator(entry.repo);
    const requestedRef =
      overrides.revision ?? overrides.ref ?? entry.ref ?? null;
    const contentKind = await this.resolveContentKind(contentLocator);

    if (contentKind === 'local') {
      return {
        report: await inspectRepository(
          contentLocator,
          contentLocator,
          'local',
        ),
        contentKind,
        contentLocator,
        contentRef: requestedRef,
        revision: null,
        repoRoot: contentLocator,
        cacheKey: null,
      };
    }
    return this.prepareGitContent(contentLocator, {
      sourceId: source.id,
      ref: requestedRef,
      revision: overrides.revision ?? null,
      sparsePaths: [entry.path ?? '', ...DEFAULT_DISCOVERY_PATHS],
    });
  }

  private async prepareGitCandidateFromInstall(
    install: InstallRecord,
    revision: string,
  ): Promise<PreparedContent> {
    const cacheKey = makeId(
      'cache',
      install.contentLocator,
      install.contentRef ?? 'HEAD',
    );
    const release = await materializeGitRelease({
      locator: install.contentLocator,
      basePath: this.cacheBasePath(cacheKey),
      sparsePaths: normalizeSparsePaths([install.sourceRelativePath]),
      ref: install.contentRef,
      revision,
      env: this.env,
    });
    return {
      report: await inspectRepository(
        release.releasePath,
        install.contentLocator,
        'git',
      ),
      contentKind: 'git',
      contentLocator: install.contentLocator,
      contentRef: install.contentRef,
      revision: release.revision,
      repoRoot: release.releasePath,
      cacheKey,
    };
  }

  private resolveContentLocator(locator: string): string {
    if (
      locator.includes('://') ||
      locator.includes('@') ||
      locator.endsWith('.git')
    ) {
      return locator;
    }
    return path.resolve(locator);
  }

  private async resolveContentKind(locator: string): Promise<ContentKind> {
    if (inferContentKind(locator) === 'git') {
      return 'git';
    }
    return (await isLocalGitRepository(locator)) ? 'git' : 'local';
  }

  private filterInstallsByName(names?: string[]): InstallRecord[] {
    if (!names || names.length === 0) {
      return this.db.listInstalls();
    }
    const requested = new Set(names);
    return this.db
      .listInstalls()
      .filter((install) => requested.has(install.name));
  }

  private async previewLocalInstallUpdate(
    install: InstallRecord,
    source: SourceRecord | null,
  ): Promise<UpdatePreview> {
    const currentPath = path.join(
      install.contentLocator,
      install.sourceRelativePath,
    );
    const currentExists = await pathExists(currentPath);
    const currentRevision = currentExists
      ? await computeTreeSignature(currentPath)
      : null;
    return {
      install,
      source,
      changed: currentRevision !== install.installedRevision,
      currentRevision: install.installedRevision,
      candidateRevision: currentRevision,
      diff: [],
      risk: currentExists ? 'safe' : 'breaking',
      warnings: currentExists
        ? ['Live local folder install; detailed diff is not available.']
        : ['Source path is missing.'],
      nextLinkTarget: currentExists ? currentPath : null,
    };
  }
}

function resolveRegistryRepo(registryLocator: string, repo: string): string {
  if (repo.includes('://') || repo.includes('@') || repo.endsWith('.git')) {
    return repo;
  }

  if (registryLocator.includes('://')) {
    return new URL(repo, registryLocator).toString();
  }

  return path.resolve(path.dirname(registryLocator), repo);
}
