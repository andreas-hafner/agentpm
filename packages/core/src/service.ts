import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  stableHash,
  toPosixPath,
  type CacheRepoRecord,
  type CatalogEntryRecord,
  type ContentKind,
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
  type PushOptions,
  type PushResult,
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
  yes?: boolean | undefined;
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
  readonly paths: ServicePaths;
  readonly db: AgentPmDatabase;

  constructor(options: AgentPmServiceOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.env = { ...process.env, ...options.env };
    this.prompts = options.prompts ?? {};

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
    return path.join(this.paths.cacheDir, cacheKey.slice(0, 16));
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
          detectedEntries.find((entry) => {
            if (selector.relativePath) {
              return entry.relativePath === selector.relativePath;
            }
            return selector.name ? entry.name === selector.name : false;
          }) ??
          detectedEntries.find((entry) => entry.name === selection.entry.name);

        if (!detectedEntry) {
          const targetSummary = options.target
            ? ` for target "${options.target}"`
            : '';
          throw new AgentPmError(
            `Could not find installable entry "${selection.entry.name}"${targetSummary} in ${prepared.contentLocator}.`,
          );
        }

        const adapter = getAdapter(detectedEntry.adapter);
        const mapping = adapter.install(detectedEntry, scopeRoot);
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

        if (prepared.cacheKey) {
          const cacheRecord: CacheRepoRecord = {
            cacheKey: prepared.cacheKey,
            sourceId: selection.source.id,
            locator: prepared.contentLocator,
            kind: prepared.contentKind,
            basePath: this.cacheBasePath(prepared.cacheKey),
            currentRevision: prepared.revision,
            isGit: prepared.contentKind === 'git',
            layoutSignature: prepared.report.layoutSignature,
            metadata: {},
            updatedAt: nowIso(),
          };
          this.db.saveCacheRepo(cacheRecord);
        }

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
        installs.push(savedInstall);
      } finally {
        await prepared.cleanup?.();
      }
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
    }

    return previews;
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
      });
      installs.push(...created);
    }

    return installs;
  }

  async push(options: PushOptions = {}): Promise<PushResult> {
    await this.initialize();
    const loadedConfig = await loadProjectConfig(this.cwd);
    const target = await this.resolvePushTarget(options.target, loadedConfig);
    const skillPath = path.resolve(this.cwd, options.path ?? '.');

    if (target.kind === 'git') {
      return this.pushToGit(
        skillPath,
        target.locator,
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
    const targets = config?.manifest.targets ?? [];

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

    throw new AgentPmError(
      'No push target specified and no default target configured in agentpm.yaml.',
    );
  }

  private async pushToGit(
    skillPath: string,
    locator: string,
    message?: string,
    dryRun?: boolean,
  ): Promise<PushResult> {
    const warnings: string[] = [];
    if (dryRun) {
      return {
        success: true,
        targetLocator: locator,
        warnings: ['Dry run: would push to ' + locator],
      };
    }

    try {
      const remoteName = `target-${stableHash(locator).slice(0, 8)}`;
      await execFileAsync('git', ['remote', 'add', remoteName, locator], {
        cwd: skillPath,
      }).catch(async () => {
        await execFileAsync('git', ['remote', 'set-url', remoteName, locator], {
          cwd: skillPath,
        });
      });

      if (message) {
        await execFileAsync('git', ['add', '.'], { cwd: skillPath });
        await execFileAsync('git', ['commit', '-m', message], {
          cwd: skillPath,
        }).catch(() => {
          warnings.push('No changes to commit or commit failed.');
        });
      }

      const branchResult = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: skillPath },
      );
      const branch = branchResult.stdout.trim();

      await execFileAsync('git', ['push', remoteName, branch], {
        cwd: skillPath,
      });

      const revisionResult = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: skillPath,
      });

      return {
        success: true,
        targetLocator: locator,
        revision: revisionResult.stdout.trim(),
        warnings,
      };
    } catch (error) {
      throw new AgentPmError(
        `Git push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
          await resolveGitRevision(source.locator);
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
      if (!(await pathExists(install.targetPath))) {
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

  private async reindexSource(source: SourceRecord): Promise<AddSourceResult> {
    if (source.kind === 'registry') {
      const registry = await loadRegistryIndex(source.locator);
      const entries: CatalogEntryRecord[] = registry.entries.map((entry) => ({
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
      this.db.replaceCatalogEntries(source.id, entries);
      return { source, indexedEntries: entries.length };
    }

    const prepared = await this.prepareInspectionTarget(
      source.locator,
      source.kind,
    );
    try {
      const entries: CatalogEntryRecord[] = listInstallableEntries(
        prepared.report,
      ).map((entry) => ({
        id: makeId('cat', source.id, entry.name, entry.relativePath),
        sourceId: source.id,
        name: entry.name,
        description: null,
        repo: source.locator,
        ref: null,
        path: entry.relativePath,
        adapterHint: entry.adapter,
        tags: [entry.adapter, entry.kind],
        metadata: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }));
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
        revision: localGit ? await resolveGitRevision(normalized) : null,
        repoRoot: normalized,
        cacheKey: null,
      };
    }

    const release = await createTemporaryGitRelease(
      locator,
      DEFAULT_DISCOVERY_PATHS,
    );
    const report = await inspectRepository(release.releasePath, locator, 'git');
    return {
      report,
      contentKind: 'git',
      contentLocator: locator,
      contentRef: null,
      revision: release.revision,
      repoRoot: release.releasePath,
      cacheKey: null,
      cleanup: async () => cleanupTemporaryRelease(release.releasePath),
    };
  }

  private async resolveSelections(
    names: string[],
    options: InstallOptions,
  ): Promise<Array<{ source: SourceRecord; entry: CatalogEntryRecord }>> {
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

    const requestedNames =
      options.skills && options.skills.length > 0 ? options.skills : names;
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

    const cacheKey = makeId('cache', contentLocator, requestedRef ?? 'HEAD');
    const release = await materializeGitRelease({
      locator: contentLocator,
      basePath: this.cacheBasePath(cacheKey),
      sparsePaths: normalizeSparsePaths([
        entry.path ?? '',
        ...DEFAULT_DISCOVERY_PATHS,
      ]),
      ref: requestedRef,
      revision: overrides.revision ?? null,
    });

    return {
      report: await inspectRepository(
        release.releasePath,
        contentLocator,
        source.kind === 'local' ? 'local' : 'git',
      ),
      contentKind,
      contentLocator,
      contentRef: requestedRef,
      revision: release.revision,
      repoRoot: release.releasePath,
      cacheKey,
    };
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
