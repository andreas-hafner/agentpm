import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  isGeneratedCodexAgentFile,
  isGeneratedKimiAgentSkill,
  transformClaudeAgentToCodexToml,
  transformClaudeAgentToKimiSkill,
} from '@agentpm/adapters';
import type { AgentPmDatabase } from '@agentpm/db';
import { ensureDir, walkFiles } from '@agentpm/fs';
import {
  displayNameFromLocator,
  makeId,
  nowIso,
  toPosixPath,
  type AgentTransformId,
  type DetectedEntry,
  type InstallScope,
  type SourceRecord,
} from '@agentpm/shared';

const CLAUDE_AGENTS_ROOT = path.join('.claude', 'agents');
const CODEX_AGENTS_ROOT = path.join('.codex', 'agents');
const KIMI_SKILLS_ROOT = path.join('.kimi-code', 'skills');

export interface MaterializeAgentsParams {
  /** Absolute path to the checked-out canonical push target repository. */
  repoPath: string;
  /** Detected `kind === 'agent'` entries to materialize. */
  entries: DetectedEntry[];
  scopeRoot: string;
  scope: InstallScope;
  db: AgentPmDatabase;
  sourceLocator: string;
  /** Opt-in additional materializations, in addition to the native copy. */
  transform?: AgentTransformId | AgentTransformId[] | undefined;
}

/** Normalize the single-or-list transform option into a deduplicated list. */
export function normalizeAgentTransforms(
  transform: AgentTransformId | AgentTransformId[] | undefined,
): AgentTransformId[] {
  if (transform === undefined) {
    return [];
  }
  return [...new Set(Array.isArray(transform) ? transform : [transform])];
}

export interface MaterializeAgentsResult {
  agents: string[];
  warnings: string[];
}

function ensureAgentSource(db: AgentPmDatabase, locator: string): SourceRecord {
  const id = makeId('src', 'git', locator);
  const existing = db.getSource(id);
  if (existing) {
    return existing;
  }
  const now = nowIso();
  return db.upsertSource({
    id,
    kind: 'git',
    locator,
    normalizedLocator: locator,
    displayName: displayNameFromLocator(locator),
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
}

async function copyEntry(sourcePath: string, destPath: string): Promise<void> {
  await fs.rm(destPath, { recursive: true, force: true });

  const stats = await fs.stat(sourcePath);
  if (stats.isFile()) {
    await ensureDir(path.dirname(destPath));
    await fs.copyFile(sourcePath, destPath);
    return;
  }

  await ensureDir(destPath);
  const files = await walkFiles(sourcePath);
  for (const file of files) {
    const relative = path.relative(sourcePath, file);
    const out = path.join(destPath, relative);
    await ensureDir(path.dirname(out));
    await fs.copyFile(file, out);
  }
}

/**
 * Copy each detected `agent` entry from the canonical push target into
 * `<scopeRoot>/.claude/agents/<basename>` and record an install per entry.
 * Unlike skills, agents are copied (not symlinked): the copy is meant to be
 * committed as a regular project file.
 */
export async function materializeAgents(
  params: MaterializeAgentsParams,
): Promise<MaterializeAgentsResult> {
  const warnings: string[] = [];
  const agentNames: string[] = [];
  const transforms = normalizeAgentTransforms(params.transform);

  if (params.entries.length === 0) {
    return { agents: agentNames, warnings };
  }

  const source = ensureAgentSource(params.db, params.sourceLocator);

  for (const entry of params.entries) {
    const sourcePath = path.join(params.repoPath, entry.relativePath);
    const destName =
      entry.entryType === 'file'
        ? path.basename(entry.relativePath)
        : entry.name;
    const targetPath = path.join(
      params.scopeRoot,
      CLAUDE_AGENTS_ROOT,
      destName,
    );

    await copyEntry(sourcePath, targetPath);
    agentNames.push(entry.name);

    const now = nowIso();
    params.db.saveInstall({
      id: makeId(
        'inst',
        source.id,
        entry.name,
        params.scope,
        params.scopeRoot,
        'claude',
        'agent',
      ),
      name: entry.name,
      sourceId: source.id,
      catalogEntryId: null,
      adapter: 'claude',
      scope: params.scope,
      scopeRoot: params.scopeRoot,
      targetPath,
      linkTarget: sourcePath,
      sourceRelativePath: entry.relativePath,
      sourceRootRelativePath: toPosixPath(CLAUDE_AGENTS_ROOT),
      selectedItems: [entry.name],
      contentKind: 'git',
      contentLocator: params.sourceLocator,
      contentRef: null,
      cacheKey: null,
      installedRevision: null,
      layoutSignature: '',
      metadata: { agent: true, copy: true },
      createdAt: now,
      updatedAt: now,
    });

    if (transforms.length === 0) {
      continue;
    }
    if (entry.entryType !== 'file') {
      warnings.push(
        `Skipped agent transform for "${entry.name}": only flat .claude/agents/<name>.md entries can be transformed.`,
      );
      continue;
    }

    for (const transform of transforms) {
      const warning =
        transform === 'codex-agents'
          ? await applyCodexAgentTransform(params.scopeRoot, entry.name, sourcePath)
          : await applyKimiAgentTransform(params.scopeRoot, entry.name, sourcePath);
      if (warning) {
        warnings.push(warning);
      }
    }
  }

  return { agents: agentNames, warnings };
}

/**
 * Emit the Codex TOML profile for one agent file. Returns a warning string
 * instead of throwing; never overwrites a file AgentPM did not generate.
 */
async function applyCodexAgentTransform(
  scopeRoot: string,
  agentName: string,
  sourcePath: string,
): Promise<string | null> {
  try {
    const markdown = await fs.readFile(sourcePath, 'utf8');
    const { fileName, toml } = transformClaudeAgentToCodexToml(markdown);
    const tomlPath = path.join(scopeRoot, CODEX_AGENTS_ROOT, fileName);
    const existingToml = await fs.readFile(tomlPath, 'utf8').catch(() => null);
    if (existingToml !== null && !isGeneratedCodexAgentFile(existingToml)) {
      return `Skipped Codex transform for "${agentName}": ${toPosixPath(
        path.relative(scopeRoot, tomlPath),
      )} already exists and was not generated by AgentPM.`;
    }
    await ensureDir(path.dirname(tomlPath));
    await fs.writeFile(tomlPath, toml, 'utf8');
    return null;
  } catch (error) {
    return `Skipped Codex transform for "${agentName}": ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Emit the Kimi delegation skill for one agent file (Kimi Code has no custom
 * sub-agents; the role is emulated via a generated skill that instructs
 * delegation through Kimi's Agent tool). Returns a warning string instead of
 * throwing; never overwrites a skill AgentPM did not generate.
 */
async function applyKimiAgentTransform(
  scopeRoot: string,
  agentName: string,
  sourcePath: string,
): Promise<string | null> {
  try {
    const markdown = await fs.readFile(sourcePath, 'utf8');
    const { dirName, skillMd } = transformClaudeAgentToKimiSkill(markdown);
    const skillPath = path.join(scopeRoot, KIMI_SKILLS_ROOT, dirName, 'SKILL.md');
    const existingSkill = await fs.readFile(skillPath, 'utf8').catch(() => null);
    if (existingSkill !== null && !isGeneratedKimiAgentSkill(existingSkill)) {
      return `Skipped Kimi transform for "${agentName}": ${toPosixPath(
        path.relative(scopeRoot, skillPath),
      )} already exists and was not generated by AgentPM.`;
    }
    await ensureDir(path.dirname(skillPath));
    await fs.writeFile(skillPath, skillMd, 'utf8');
    return null;
  } catch (error) {
    return `Skipped Kimi transform for "${agentName}": ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}
