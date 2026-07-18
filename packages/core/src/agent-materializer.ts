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
      let warning: string | null;
      switch (transform) {
        case 'codex-agents':
          warning = await applyCodexAgentTransform(
            params.scopeRoot,
            entry.name,
            sourcePath,
          );
          break;
        case 'kimi-agents':
          // destName === path.basename(entry.relativePath) here (entryType
          // === 'file' is guaranteed by the guard above): keying the Kimi
          // skill slug and provenance marker off the real, filesystem-unique
          // source filename avoids collisions between differently-formatted
          // frontmatter names and keeps the marker pointing at a file that
          // actually exists.
          warning = await applyKimiAgentTransform(
            params.scopeRoot,
            entry.name,
            sourcePath,
            destName,
          );
          break;
        default:
          // Defensive: normalizeAgentTransforms does not validate its input,
          // and MaterializeAgentsParams.transform is reachable from
          // untyped JS callers (e.g. AgentPmService.pull). Skip rather than
          // silently routing an unrecognized id to one of the transforms.
          warning = `Skipped unknown agent transform "${String(transform)}" for "${entry.name}".`;
      }
      if (warning) {
        warnings.push(warning);
      }
    }
  }

  return { agents: agentNames, warnings };
}

/**
 * Read `sourcePath`, run `transform` over its contents to produce a
 * generated file's destination-relative path and content, and write it
 * under `scopeRoot` - unless a foreign (non-AgentPM-generated) file already
 * exists there, in which case the write is skipped and a warning returned.
 * Shared by the Codex TOML and Kimi delegation-skill transforms, which
 * otherwise differ only in what they generate and how they recognize their
 * own output.
 */
async function applyAgentTransform(params: {
  scopeRoot: string;
  agentName: string;
  sourcePath: string;
  transformLabel: string;
  transform: (markdown: string) => { relPath: string; content: string };
  isGenerated: (content: string) => boolean;
}): Promise<string | null> {
  try {
    const markdown = await fs.readFile(params.sourcePath, 'utf8');
    const { relPath, content } = params.transform(markdown);
    const destPath = path.join(params.scopeRoot, relPath);
    const existing = await fs.readFile(destPath, 'utf8').catch(() => null);
    if (existing !== null && !params.isGenerated(existing)) {
      return `Skipped ${params.transformLabel} transform for "${params.agentName}": ${toPosixPath(
        path.relative(params.scopeRoot, destPath),
      )} already exists and was not generated by AgentPM.`;
    }
    await ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, content, 'utf8');
    return null;
  } catch (error) {
    return `Skipped ${params.transformLabel} transform for "${params.agentName}": ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/** Emit the Codex TOML profile for one agent file. */
function applyCodexAgentTransform(
  scopeRoot: string,
  agentName: string,
  sourcePath: string,
): Promise<string | null> {
  return applyAgentTransform({
    scopeRoot,
    agentName,
    sourcePath,
    transformLabel: 'Codex',
    transform: (markdown) => {
      const { fileName, toml } = transformClaudeAgentToCodexToml(markdown);
      return { relPath: path.join(CODEX_AGENTS_ROOT, fileName), content: toml };
    },
    isGenerated: isGeneratedCodexAgentFile,
  });
}

/**
 * Emit the Kimi delegation skill for one agent file (Kimi Code has no custom
 * sub-agents; the role is emulated via a generated skill that instructs
 * delegation through Kimi's Agent tool).
 */
function applyKimiAgentTransform(
  scopeRoot: string,
  agentName: string,
  sourcePath: string,
  sourceFileName: string,
): Promise<string | null> {
  return applyAgentTransform({
    scopeRoot,
    agentName,
    sourcePath,
    transformLabel: 'Kimi',
    transform: (markdown) => {
      const { dirName, skillMd } = transformClaudeAgentToKimiSkill(
        markdown,
        sourceFileName,
      );
      return {
        relPath: path.join(KIMI_SKILLS_ROOT, dirName, 'SKILL.md'),
        content: skillMd,
      };
    },
    isGenerated: isGeneratedKimiAgentSkill,
  });
}
