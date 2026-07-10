import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseFrontmatter } from '@agentpm/adapters';
import type { AgentPmDatabase } from '@agentpm/db';
import { ensureDir, listChildDirectories, pathExists } from '@agentpm/fs';
import { AgentPmError, slugify, toPosixPath } from '@agentpm/shared';

export interface ExportLayoutParams {
  /** Named layout to materialize (currently only `antigravity`). */
  layout: string;
  /** Destination directory the layout is materialized into. */
  dest: string;
  /** Skill names to export. Empty/undefined exports every library skill. */
  skills?: string[] | undefined;
  /** Also export managed agent installs. Defaults to true. */
  includeAgents: boolean;
  /** Run the layout's plugin installer against `dest` after a successful export. */
  install?: boolean | undefined;
  db: AgentPmDatabase;
  /** Absolute path to the canonical skill library (`~/.agentpm/skills`). */
  skillsLibraryDir: string;
  /** Environment the plugin installer subprocess inherits. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ExportLayoutResult {
  skills: string[];
  agents: string[];
  warnings: string[];
}

type LayoutExporter = (params: ExportLayoutParams) => Promise<ExportLayoutResult>;

async function exportSkills(
  params: ExportLayoutParams,
  warnings: string[],
): Promise<string[]> {
  const allNames = await listChildDirectories(params.skillsLibraryDir);
  const requested = params.skills?.filter((name) => name.length > 0);
  const names =
    requested && requested.length > 0
      ? allNames.filter((name) => requested.includes(name))
      : allNames;

  const exported: string[] = [];

  for (const name of names) {
    const skillSourcePath = path.join(params.skillsLibraryDir, name, 'SKILL.md');
    if (!(await pathExists(skillSourcePath))) {
      continue;
    }

    const templatePath = path.join(
      params.dest,
      'templates',
      'skills',
      name,
      'SKILL.md',
    );
    await ensureDir(path.dirname(templatePath));
    await fs.copyFile(skillSourcePath, templatePath);

    const linkPath = path.join(params.dest, 'skills', name, 'SKILL.md');
    const relativeLinkPath = toPosixPath(path.relative(params.dest, linkPath));
    const linkTarget = path.join('..', '..', 'templates', 'skills', name, 'SKILL.md');

    const existingStat = await fs.lstat(linkPath).catch(() => null);
    if (existingStat && !existingStat.isSymbolicLink()) {
      warnings.push(
        `Left "${relativeLinkPath}" untouched: a foreign file already exists there.`,
      );
      exported.push(name);
      continue;
    }

    if (existingStat?.isSymbolicLink()) {
      const currentTarget = await fs.readlink(linkPath);
      if (currentTarget === linkTarget) {
        exported.push(name);
        continue;
      }
      await fs.rm(linkPath, { force: true });
    }

    await ensureDir(path.dirname(linkPath));
    await fs.symlink(linkTarget, linkPath, 'file');
    exported.push(name);
  }

  return exported;
}

async function exportAgents(
  params: ExportLayoutParams,
  warnings: string[],
): Promise<string[]> {
  const agentInstalls = params.db
    .listInstalls()
    .filter(
      (install) =>
        install.adapter === 'claude' &&
        install.scope === 'global' &&
        install.metadata.agent === true,
    );

  const exported: string[] = [];

  for (const install of agentInstalls) {
    const markdown = await fs.readFile(install.targetPath, 'utf8').catch(() => null);
    if (markdown === null) {
      warnings.push(
        `Skipped agent "${install.name}": source file is missing at ${install.targetPath}.`,
      );
      continue;
    }

    const { data, body } = parseFrontmatter(markdown);
    const rawName = typeof data.name === 'string' && data.name.trim().length > 0
      ? data.name
      : install.name;
    const name = slugify(rawName);

    const agentPath = path.join(params.dest, 'agents', `${name}.md`);
    await ensureDir(path.dirname(agentPath));
    await fs.writeFile(agentPath, body, 'utf8');
    exported.push(name);
  }

  return exported;
}

async function runPluginInstall(
  dest: string,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('agy', ['plugin', 'install', dest], {
      env,
      stdio: 'inherit',
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        warnings.push(
          'Could not run `agy plugin install`: the "agy" binary was not found on PATH.',
        );
      } else {
        warnings.push(`\`agy plugin install\` failed: ${error.message}`);
      }
      resolve();
    });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        warnings.push(`\`agy plugin install\` exited with code ${code}.`);
      }
      resolve();
    });
  });
}

async function exportAntigravityLayout(
  params: ExportLayoutParams,
): Promise<ExportLayoutResult> {
  const warnings: string[] = [];
  const skills = await exportSkills(params, warnings);
  const agents = params.includeAgents ? await exportAgents(params, warnings) : [];

  if (params.install) {
    await runPluginInstall(params.dest, params.env ?? process.env, warnings);
  }

  return { skills, agents, warnings };
}

const LAYOUTS: Record<string, LayoutExporter> = {
  antigravity: exportAntigravityLayout,
};

export function listExportLayouts(): string[] {
  return Object.keys(LAYOUTS);
}

export async function exportLayout(
  params: ExportLayoutParams,
): Promise<ExportLayoutResult> {
  const exporter = LAYOUTS[params.layout];
  if (!exporter) {
    throw new AgentPmError(
      `Unknown export layout "${params.layout}". Available: ${listExportLayouts().join(', ')}.`,
    );
  }
  await ensureDir(params.dest);
  return exporter(params);
}
