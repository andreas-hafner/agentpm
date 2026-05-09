import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findDetectedEntry, getAdapter, inspectRepository, listInstallableEntries } from '@agentpm/adapters';
import { ensureAgentPmHome, loadGlobalConfig, loadManifest, resolveScopeRoot, saveManifest } from '@agentpm/config';
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
  type CacheRepoRecord,
  type CatalogEntryRecord,
  type ContentKind,
  type DoctorIssue,
  type InstallRecord,
  type InstallScope,
  type InspectionReport,
  type ManifestFile,
  type PromptApi,
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

function normalizeCatalogSelector(selector: string): string {
  return selector.trim().replace(/\\/g, '/');
}

function matchesCatalogEntrySelector(entry: CatalogEntryRecord, selector: string): boolean {
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

  return entry.path === normalizedSelector || entry.path.endsWith(`/${normalizedSelector}`);
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

    const agentPmHome = this.env.AGENTPM_HOME ?? path.join(os.homedir(), '.agentpm');
    this.paths = {
      homeDir: agentPmHome,
      cacheDir: path.join(agentPmHome, 'cache'),
      dbPath: path.join(agentPmHome, 'agentpm.db'),
      globalConfigPath: path.join(agentPmHome, 'config.yaml'),
      manifestPath: path.join(this.cwd, 'agentpm.yaml'),
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
      throw new AgentPmError(`Cannot remove source "${source.displayName}" while installs still depend on it.`);
    }

    this.db.deleteSource(source.id);
  }

  async inspect(target: string): Promise<InspectionReport> {
    await this.initialize();
    const source = this.findSourceByToken(target);
    if (source && source.kind !== 'registry') {
      const prepared = await this.prepareInspectionTarget(source.locator, source.kind);
      try {
        return prepared.report;
      } finally {
        await prepared.cleanup?.();
      }
    }

    const kind = await this.classifySource(target);
    if (kind === 'registry') {
      throw new AgentPmError('Registry indexes are not inspectable as repositories.');
    }

    const prepared = await this.prepareInspectionTarget(target, kind);
    try {
      return prepared.report;
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

  async install(names: string[], options: InstallOptions = {}): Promise<InstallRecord[]> {
    await this.initialize();
    const globalConfig = await loadGlobalConfig(this.cwd, this.env);
    const scope = await this.resolveScope(options.scope);
    const scopeRoot = resolveScopeRoot(scope, this.cwd, globalConfig, options.workspaceRoot);
    const selections = await this.resolveSelections(names, options);
    const installs: InstallRecord[] = [];

    for (const selection of selections) {
      const prepared = await this.prepareContentForEntry(selection.entry, selection.source, {
        ref: options.ref,
        revision: options.revision,
      });

      try {
        const selector: { name?: string | undefined; relativePath?: string | undefined } = {
          name: selection.entry.name,
        };
        if (selection.entry.path) {
          selector.relativePath = selection.entry.path;
        }
        const detectedEntry =
          findDetectedEntry(prepared.report, selector) ??
          listInstallableEntries(prepared.report).find((entry) => entry.name === selection.entry.name);

        if (!detectedEntry) {
          throw new AgentPmError(`Could not find installable entry "${selection.entry.name}" in ${prepared.contentLocator}.`);
        }

        const adapter = getAdapter(detectedEntry.adapter);
        const mapping = adapter.install(detectedEntry, scopeRoot);
        const linkTarget = path.join(prepared.repoRoot, mapping.sourceRelativePath);
        const targetPath = path.join(scopeRoot, mapping.targetRelativePath);

        await ensureDir(path.dirname(targetPath));
        await ensureManagedLink(targetPath, linkTarget);

        const installedRevision =
          prepared.revision ??
          (prepared.contentKind === 'local' ? await computeTreeSignature(path.join(prepared.repoRoot, mapping.sourceRelativePath)) : null);

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

        const installId = makeId('inst', selection.source.id, mapping.name, scope, scopeRoot);
        installs.push(
          this.db.saveInstall({
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
            selectedItems: options.skills && options.skills.length > 0 ? options.skills : [mapping.name],
            contentKind: prepared.contentKind,
            contentLocator: prepared.contentLocator,
            contentRef: options.ref ?? selection.entry.ref ?? null,
            cacheKey: prepared.cacheKey,
            installedRevision,
            layoutSignature: prepared.report.layoutSignature,
            metadata: {},
            createdAt: nowIso(),
            updatedAt: nowIso(),
          }),
        );
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

      const candidateRevision = await resolveGitRevision(install.contentLocator, install.contentRef ?? undefined);
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

      const prepared = await this.prepareGitCandidateFromInstall(install, candidateRevision);
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

      if ((preview.risk === 'remap' || preview.risk === 'breaking') && !options.yes) {
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
      await ensureManagedLink(preview.install.targetPath, preview.nextLinkTarget);
      const nextSourceRelativePath =
        preview.install.contentKind === 'git' && preview.install.cacheKey && preview.candidateRevision
          ? path
              .relative(
                resolveReleasePath(this.cacheBasePath(preview.install.cacheKey), preview.candidateRevision),
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

  async removeInstall(name: string, options: RemoveInstallOptions = {}): Promise<InstallRecord> {
    await this.initialize();
    const installs = this.db.listInstallsByName(name);
    if (installs.length === 0) {
      throw new AgentPmError(`No install named "${name}" found.`);
    }

    let install = installs[0]!;
    if (installs.length > 1) {
      if (!this.prompts.selectOne) {
        throw new AgentPmError(`Multiple installs named "${name}" found. Re-run interactively to choose one.`);
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

    if (options.purge && install.cacheKey && this.db.countInstallsForCacheKey(install.cacheKey) === 0) {
      await fs.rm(this.cacheBasePath(install.cacheKey), { recursive: true, force: true });
    }

    return install;
  }

  async initManifest(): Promise<{ manifestPath: string; manifest: ManifestFile }> {
    await this.initialize();
    const installs = this.db
      .listInstalls()
      .filter((install) => install.scope !== 'global' && path.resolve(install.scopeRoot) === this.cwd);
    const sources = installs
      .map((install) => this.db.getSource(install.sourceId))
      .filter((source): source is SourceRecord => Boolean(source));

    const uniqueSources = [...new Map(sources.map((source) => [source.id, source])).values()];
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
        items: install.selectedItems.length > 0 ? install.selectedItems : [install.name],
        scope: install.scope === 'global' ? 'project' : install.scope,
        ref: install.contentRef ?? undefined,
        revision: install.installedRevision ?? undefined,
        adapter: install.adapter,
        workspaceRoot: install.scope === 'workspace' ? install.scopeRoot : undefined,
      })),
    };

    const manifestPath = await saveManifest(this.cwd, manifest);
    return { manifestPath, manifest };
  }

  async syncManifest(): Promise<InstallRecord[]> {
    await this.initialize();
    const manifest = await loadManifest(this.cwd);
    if (!manifest) {
      throw new AgentPmError(`No agentpm.yaml found in ${this.cwd}`);
    }

    for (const sourceSpec of manifest.sources) {
      if (!this.findSourceByToken(sourceSpec.id ?? sourceSpec.locator)) {
        await this.addSource(sourceSpec.locator);
      }
    }

    const installs: InstallRecord[] = [];
    for (const installSpec of manifest.installs) {
      const created = await this.install([installSpec.source], {
        scope: installSpec.scope,
        workspaceRoot: installSpec.workspaceRoot,
        skills: installSpec.items,
        ref: installSpec.ref ?? null,
        revision: installSpec.revision ?? null,
        yes: true,
      });
      installs.push(...created);
    }

    return installs;
  }

  async doctor(): Promise<DoctorIssue[]> {
    await this.initialize();
    const issues: DoctorIssue[] = [];

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
            remedy: error instanceof Error ? error.message : 'Verify network access and repository permissions.',
          });
        }
      }

      if (source.kind === 'registry' && this.db.listCatalogEntriesBySource(source.id).length === 0) {
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

      if (install.cacheKey && !(await pathExists(this.cacheBasePath(install.cacheKey)))) {
        issues.push({
          severity: 'error',
          code: 'missing-cache',
          installId: install.id,
          path: this.cacheBasePath(install.cacheKey),
          message: 'Cached release is missing.',
          remedy: 'Reinstall or update the entry to restore the cache.',
        });
      }

      if (install.contentKind === 'local' && !(await pathExists(install.contentLocator))) {
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
        adapterHint: entry.adapterHint ?? null,
        tags: entry.tags ?? [],
        metadata: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }));
      this.db.replaceCatalogEntries(source.id, entries);
      return { source, indexedEntries: entries.length };
    }

    const prepared = await this.prepareInspectionTarget(source.locator, source.kind);
    try {
      const entries: CatalogEntryRecord[] = listInstallableEntries(prepared.report).map((entry) => ({
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
      return { source, indexedEntries: entries.length, report: prepared.report };
    } finally {
      await prepared.cleanup?.();
    }
  }

  private async classifySource(locator: string): Promise<SourceKind> {
    const kind = classifyLocator(locator);
    if (kind !== 'local') {
      return kind;
    }

    const resolved = path.resolve(locator);
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
    if (kind === 'local' || (kind === 'registry' && !locator.includes('://'))) {
      return path.resolve(locator);
    }
    return locator.trim();
  }

  private findSourceByToken(token: string): SourceRecord | null {
    const exact = this.db.getSourceByLocator(token);
    if (exact) {
      return exact;
    }

    return this.db
      .listSources()
      .find((source) => source.displayName === token || source.id === token || slugify(source.displayName) === token) ?? null;
  }

  private async prepareInspectionTarget(locator: string, kind: SourceKind): Promise<PreparedContent> {
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

    const release = await createTemporaryGitRelease(locator, DEFAULT_DISCOVERY_PATHS);
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
      throw new AgentPmError('No sources have been added yet. Use "agentpm source add" first.');
    }

    if (options.all) {
      const sourceToken = names[0];
      let source = sourceToken ? this.findSourceByToken(sourceToken) : null;
      if (!source) {
        if (!this.prompts.selectOne) {
          throw new AgentPmError('Installing all entries requires a source argument or an interactive TTY.');
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
            !options.skills ||
            options.skills.length === 0 ||
            options.skills.some((skillSelector) => matchesCatalogEntrySelector(entry, skillSelector)),
        );
      if (entries.length === 0) {
        throw new AgentPmError(`No installable entries found for source ${source.displayName}.`);
      }
      return entries.map((entry) => ({ source, entry }));
    }

    if (names.length === 1 && options.skills && options.skills.length > 0) {
      const source = this.findSourceByToken(names[0]!);
      if (source) {
        const entries = this.db
          .listCatalogEntriesBySource(source.id)
          .filter((entry) => options.skills?.some((skillSelector) => matchesCatalogEntrySelector(entry, skillSelector)));
        if (entries.length === 0) {
          throw new AgentPmError(`No requested skills were found in source ${source.displayName}.`);
        }
        return entries.map((entry) => ({ source, entry }));
      }
    }

    const requestedNames = options.skills && options.skills.length > 0 ? options.skills : names;
    if (requestedNames.length === 0) {
      if (!this.prompts.selectOne) {
        throw new AgentPmError('No install target supplied. Re-run interactively or provide a skill name.');
      }

      const allEntries = this.db.listCatalogEntries();
      if (allEntries.length === 0) {
        throw new AgentPmError('No catalog entries are indexed yet. Add a source first.');
      }

      const entry = await this.prompts.selectOne(
        'Choose an entry to install:',
        allEntries.map((candidate) => {
          const source = this.db.getSource(candidate.sourceId);
          return {
            label: candidate.name,
            description: source ? `${source.displayName} · ${candidate.repo}` : candidate.repo,
            value: candidate,
          };
        }),
      );
      const source = this.db.getSource(entry.sourceId);
      if (!source) {
        throw new AgentPmError(`Missing source for catalog entry ${entry.name}`);
      }
      return [{ source, entry }];
    }

    const selections: Array<{ source: SourceRecord; entry: CatalogEntryRecord }> = [];
    for (const requestedName of requestedNames) {
      const matches = this.db.listCatalogEntries().filter((entry) => matchesCatalogEntrySelector(entry, requestedName));
      if (matches.length === 0) {
        throw new AgentPmError(`No catalog entry named "${requestedName}" found.`);
      }

      let entry = matches[0]!;
      if (matches.length > 1) {
        if (!this.prompts.selectOne) {
          throw new AgentPmError(`Multiple catalog entries named "${requestedName}" found. Re-run interactively.`);
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
        throw new AgentPmError(`Missing source for catalog entry ${entry.name}`);
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
        { label: 'Global', description: 'Install into your home directory native target', value: 'global' as const },
        { label: 'Workspace', description: 'Install into a workspace root', value: 'workspace' as const },
      ]);
    }

    return 'project';
  }

  private async prepareContentForEntry(
    entry: CatalogEntryRecord,
    source: SourceRecord,
    overrides: { ref?: string | null | undefined; revision?: string | null | undefined },
  ): Promise<PreparedContent> {
    const contentLocator = this.resolveContentLocator(entry.repo);
    const requestedRef = overrides.revision ?? overrides.ref ?? entry.ref ?? null;
    const contentKind = await this.resolveContentKind(contentLocator);

    if (contentKind === 'local') {
      return {
        report: await inspectRepository(contentLocator, contentLocator, 'local'),
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
      sparsePaths: normalizeSparsePaths([entry.path ?? '', ...DEFAULT_DISCOVERY_PATHS]),
      ref: requestedRef,
      revision: overrides.revision ?? null,
    });

    return {
      report: await inspectRepository(release.releasePath, contentLocator, source.kind === 'local' ? 'local' : 'git'),
      contentKind,
      contentLocator,
      contentRef: requestedRef,
      revision: release.revision,
      repoRoot: release.releasePath,
      cacheKey,
    };
  }

  private async prepareGitCandidateFromInstall(install: InstallRecord, revision: string): Promise<PreparedContent> {
    const cacheKey = makeId('cache', install.contentLocator, install.contentRef ?? 'HEAD');
    const release = await materializeGitRelease({
      locator: install.contentLocator,
      basePath: this.cacheBasePath(cacheKey),
      sparsePaths: normalizeSparsePaths([install.sourceRelativePath]),
      ref: install.contentRef,
      revision,
    });
    return {
      report: await inspectRepository(release.releasePath, install.contentLocator, 'git'),
      contentKind: 'git',
      contentLocator: install.contentLocator,
      contentRef: install.contentRef,
      revision: release.revision,
      repoRoot: release.releasePath,
      cacheKey,
    };
  }

  private resolveContentLocator(locator: string): string {
    if (locator.includes('://') || locator.includes('@') || locator.endsWith('.git')) {
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
    return this.db.listInstalls().filter((install) => requested.has(install.name));
  }

  private async previewLocalInstallUpdate(install: InstallRecord, source: SourceRecord | null): Promise<UpdatePreview> {
    const currentPath = path.join(install.contentLocator, install.sourceRelativePath);
    const currentExists = await pathExists(currentPath);
    const currentRevision = currentExists ? await computeTreeSignature(currentPath) : null;
    return {
      install,
      source,
      changed: currentRevision !== install.installedRevision,
      currentRevision: install.installedRevision,
      candidateRevision: currentRevision,
      diff: [],
      risk: currentExists ? 'safe' : 'breaking',
      warnings: currentExists ? ['Live local folder install; detailed diff is not available.'] : ['Source path is missing.'],
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
