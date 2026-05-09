import path from 'node:path';

import { listChildDirectories, pathExists, walkFiles } from '@agentpm/fs';
import {
  AgentPmError,
  stableHash,
  toPosixPath,
  type AdapterCompatibility,
  type AdapterId,
  type AdapterUpdateResult,
  type DetectedEntry,
  type DetectedGroup,
  type DetectedScript,
  type InspectionReport,
  type InstallMapping,
  type InstallRecord,
  type SourceKind,
} from '@agentpm/shared';

export interface SkillAdapter {
  id: AdapterId;
  detect(rootPath: string): Promise<DetectedGroup[]>;
  scoreCompatibility(report: InspectionReport): AdapterCompatibility;
  install(entry: DetectedEntry, scopeRoot: string): InstallMapping;
  update(record: InstallRecord, report: InspectionReport): AdapterUpdateResult;
  remove(record: InstallRecord): string[];
  validate(report: InspectionReport, entry: DetectedEntry): string[];
}

interface LayoutDefinition {
  adapter: AdapterId;
  label: string;
  relativeRoot: string;
  kind: DetectedGroup['kind'];
}

const LAYOUTS: LayoutDefinition[] = [
  { adapter: 'codex', label: 'Codex skills', relativeRoot: '.codex/skills', kind: 'skill' },
  { adapter: 'claude', label: 'Claude agents', relativeRoot: '.claude/agents', kind: 'agent' },
  { adapter: 'generic', label: 'Generic skills', relativeRoot: '.agents/skills', kind: 'skill' },
  { adapter: 'generic', label: 'Generic skills', relativeRoot: 'skills', kind: 'skill' },
  { adapter: 'generic', label: 'Subagents', relativeRoot: 'subagents', kind: 'subagent' },
];

const SCRIPT_PATTERNS = [/^install\.(sh|ps1|js|mjs|cjs|ts)$/i];
const ENTRY_MARKERS: Record<DetectedGroup['kind'], string[]> = {
  skill: ['SKILL.md'],
  subagent: ['SKILL.md'],
  agent: ['README.md', 'AGENT.md', 'CLAUDE.md'],
};

function isNestedWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath.length > 0 && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function findEntryDirectories(files: string[], layout: LayoutDefinition, absoluteRoot: string): string[] {
  const markerPaths = files
    .filter((filePath) => ENTRY_MARKERS[layout.kind].includes(path.basename(filePath)))
    .map((filePath) => path.dirname(filePath))
    .filter((directoryPath) => directoryPath !== absoluteRoot)
    .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length);

  const entries: string[] = [];
  for (const directoryPath of markerPaths) {
    if (entries.some((entryPath) => isNestedWithin(entryPath, directoryPath))) {
      continue;
    }
    entries.push(directoryPath);
  }

  return entries;
}

async function detectGroupsForLayout(rootPath: string, layout: LayoutDefinition): Promise<DetectedGroup[]> {
  const absoluteRoot = path.join(rootPath, layout.relativeRoot);
  if (!(await pathExists(absoluteRoot))) {
    return [];
  }

  const files = await walkFiles(absoluteRoot);
  const entryDirectories = findEntryDirectories(files, layout, absoluteRoot);
  const fallbackDirectories = entryDirectories.length === 0 ? await listChildDirectories(absoluteRoot) : [];
  const resolvedDirectories =
    entryDirectories.length > 0 ? entryDirectories : fallbackDirectories.map((directory) => path.join(absoluteRoot, directory));

  const entries: DetectedEntry[] = resolvedDirectories.map((directoryPath) => ({
    name: path.basename(directoryPath),
    relativePath: toPosixPath(path.relative(rootPath, directoryPath)),
    rootRelativePath: toPosixPath(path.relative(absoluteRoot, directoryPath)),
    adapter: layout.adapter,
    kind: layout.kind,
    warnings: [],
  }));

  if (entries.length === 0) {
    return [];
  }

  return [
    {
      adapter: layout.adapter,
      label: layout.label,
      relativeRoot: layout.relativeRoot,
      kind: layout.kind,
      nativeTargetRelativeRoot: layout.relativeRoot,
      confidence: 100,
      entries: entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    },
  ];
}

function flattenEntries(groups: DetectedGroup[]): DetectedEntry[] {
  return groups.flatMap((group) => group.entries);
}

function buildCompatibility(adapter: AdapterId, groups: DetectedGroup[]): AdapterCompatibility {
  const matchingGroups = groups.filter((group) => group.adapter === adapter);
  if (matchingGroups.length === 0) {
    return {
      adapter,
      compatible: false,
      score: 0,
      reasons: ['No matching native layout detected.'],
    };
  }

  const scoreByAdapter: Record<AdapterId, number> = {
    codex: 100,
    claude: 100,
    generic: 85,
  };

  return {
    adapter,
    compatible: true,
    score: scoreByAdapter[adapter],
    reasons: [`Detected ${matchingGroups.length} matching layout root(s).`],
  };
}

function buildLayoutSignature(groups: DetectedGroup[], scripts: DetectedScript[]): string {
  return stableHash({
    groups: groups.map((group) => ({
      adapter: group.adapter,
      root: group.relativeRoot,
      entries: group.entries.map((entry) => entry.relativePath),
    })),
    scripts,
  });
}

function findCompatibleEntry(record: InstallRecord, report: InspectionReport): DetectedEntry | null {
  const exactMatch =
    flattenEntries(report.groups).find((entry) => entry.relativePath === record.sourceRelativePath) ?? null;

  if (exactMatch) {
    return exactMatch;
  }

  return (
    flattenEntries(report.groups).find((entry) => entry.name === record.name && entry.adapter === record.adapter) ?? null
  );
}

function createAdapter(id: AdapterId): SkillAdapter {
  return {
    id,
    async detect(rootPath: string): Promise<DetectedGroup[]> {
      const layouts = LAYOUTS.filter((layout) => layout.adapter === id);
      const groups = await Promise.all(layouts.map((layout) => detectGroupsForLayout(rootPath, layout)));
      return groups.flat();
    },
    scoreCompatibility(report: InspectionReport): AdapterCompatibility {
      return buildCompatibility(id, report.groups);
    },
    install(entry: DetectedEntry): InstallMapping {
      return {
        name: entry.name,
        adapter: entry.adapter,
        sourceRelativePath: entry.relativePath,
        sourceRootRelativePath: entry.relativePath.split('/').slice(0, -1).join('/'),
        targetRelativePath: entry.relativePath,
      };
    },
    update(record: InstallRecord, report: InspectionReport): AdapterUpdateResult {
      const exactMatch = flattenEntries(report.groups).find((entry) => entry.relativePath === record.sourceRelativePath);
      if (exactMatch) {
        return { risk: 'safe', nextRelativePath: exactMatch.relativePath, warnings: [] };
      }

      const remapped = findCompatibleEntry(record, report);
      if (remapped) {
        return {
          risk: 'remap',
          nextRelativePath: remapped.relativePath,
          warnings: ['Layout changed, but the entry can be remapped by name.'],
        };
      }

      return {
        risk: 'breaking',
        nextRelativePath: null,
        warnings: ['Previously installed entry was not found in the updated layout.'],
      };
    },
    remove(record: InstallRecord): string[] {
      return [record.targetPath];
    },
    validate(report: InspectionReport, entry: DetectedEntry): string[] {
      const matching = flattenEntries(report.groups).find((candidate) => candidate.relativePath === entry.relativePath);
      return matching ? [] : ['Entry is no longer present in the detected layout.'];
    },
  };
}

export const ADAPTERS: SkillAdapter[] = [createAdapter('generic'), createAdapter('codex'), createAdapter('claude')];

export function getAdapter(adapterId: AdapterId): SkillAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.id === adapterId);
  if (!adapter) {
    throw new AgentPmError(`Unknown adapter: ${adapterId}`);
  }
  return adapter;
}

export async function inspectRepository(
  repoPath: string,
  locator: string,
  sourceKind: SourceKind,
): Promise<InspectionReport> {
  const groups = (await Promise.all(ADAPTERS.map((adapter) => adapter.detect(repoPath)))).flat();
  const scripts = (await detectInstallScripts(repoPath)).sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );

  const warnings = scripts.length > 0 ? ['Install scripts detected. AgentPM does not execute them automatically.'] : [];
  if (groups.length === 0) {
    warnings.push('No supported native skill or agent layout was detected.');
  }

  const report: InspectionReport = {
    locator,
    sourceKind,
    resolvedPath: repoPath,
    groups,
    scripts,
    compatibleAdapters: [],
    installable: groups.some((group) => group.entries.length > 0),
    warnings,
    layoutSignature: buildLayoutSignature(groups, scripts),
  };

  report.compatibleAdapters = ADAPTERS.map((adapter) => adapter.scoreCompatibility(report)).sort(
    (left, right) => right.score - left.score,
  );

  return report;
}

export function listInstallableEntries(report: InspectionReport): DetectedEntry[] {
  return flattenEntries(report.groups);
}

export function findDetectedEntry(
  report: InspectionReport,
  selector: { name?: string | undefined; relativePath?: string | undefined },
): DetectedEntry | null {
  return (
    flattenEntries(report.groups).find((entry) => {
      if (selector.relativePath && entry.relativePath === selector.relativePath) {
        return true;
      }
      if (selector.name && entry.name === selector.name) {
        return true;
      }
      return false;
    }) ?? null
  );
}

export async function detectInstallScripts(rootPath: string): Promise<DetectedScript[]> {
  const files = await walkFiles(rootPath);
  return files
    .filter((filePath) => SCRIPT_PATTERNS.some((pattern) => pattern.test(path.basename(filePath))))
    .map((filePath) => ({
      name: path.basename(filePath),
      relativePath: toPosixPath(path.relative(rootPath, filePath)),
    }));
}
