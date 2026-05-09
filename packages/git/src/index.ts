import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureDir, pathExists } from '@agentpm/fs';
import { AgentPmError, isGitRevision, type ContentKind } from '@agentpm/shared';
import { simpleGit } from 'simple-git';

export const DEFAULT_DISCOVERY_PATHS = [
  '.codex',
  '.claude',
  '.agents',
  'skills',
  'subagents',
  'install.sh',
  'install.ps1',
  'install.js',
  'install.mjs',
];

export interface GitReleaseOptions {
  locator: string;
  basePath: string;
  sparsePaths: string[];
  ref?: string | null | undefined;
  revision?: string | null | undefined;
}

export interface GitRelease {
  releasePath: string;
  revision: string;
}

export function resolveReleasePath(basePath: string, revision: string): string {
  return path.join(basePath, 'r', revision.slice(0, 12));
}

export async function isLocalGitRepository(locator: string): Promise<boolean> {
  const gitDirectory = path.join(locator, '.git');
  return pathExists(gitDirectory);
}

export async function resolveGitRevision(locator: string, ref?: string | null): Promise<string> {
  if (await isLocalGitRepository(locator)) {
    const repo = simpleGit(locator);
    const revision = await repo.revparse([ref ?? 'HEAD']);
    return revision.trim();
  }

  const git = simpleGit();
  const target = ref ?? 'HEAD';
  const output = await git.listRemote([locator, target]);
  const firstLine = output.split('\n').find((line) => line.trim().length > 0);
  const revision = firstLine?.split('\t')[0]?.trim();
  if (!revision) {
    throw new AgentPmError(`Could not resolve remote revision for ${locator}`);
  }
  return revision;
}

export async function materializeGitRelease(options: GitReleaseOptions): Promise<GitRelease> {
  await ensureDir(options.basePath);
  const targetRevision = options.revision ?? (await resolveGitRevision(options.locator, options.ref ?? undefined));
  const releasePath = resolveReleasePath(options.basePath, targetRevision);
  if (await pathExists(releasePath)) {
    return { releasePath, revision: targetRevision };
  }

  await ensureDir(path.dirname(releasePath));
  const cloneArgs = ['--depth', '1', '--filter=blob:none', '--no-checkout'];
  if (options.ref && !isGitRevision(options.ref)) {
    cloneArgs.push('--branch', options.ref);
  }

  const git = simpleGit();
  await git.clone(options.locator, releasePath, cloneArgs);

  const repo = simpleGit(releasePath);
  if (options.sparsePaths.length > 0) {
    await repo.raw(['sparse-checkout', 'init', '--cone']);
    await repo.raw(['sparse-checkout', 'set', ...options.sparsePaths]);
  }

  if (options.revision && isGitRevision(options.revision) && options.ref !== options.revision) {
    await repo.fetch('origin', options.revision, { '--depth': 1 });
    await repo.checkout(['FETCH_HEAD']);
  } else if (options.ref && isGitRevision(options.ref)) {
    await repo.fetch('origin', options.ref, { '--depth': 1 });
    await repo.checkout(['FETCH_HEAD']);
  } else {
    await repo.checkout(['HEAD']);
  }

  const revision = (await repo.revparse(['HEAD'])).trim();
  return { releasePath, revision };
}

export async function createTemporaryGitRelease(locator: string, sparsePaths: string[], ref?: string | null): Promise<GitRelease> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentpm-inspect-'));
  return materializeGitRelease({
    locator,
    basePath: tempRoot,
    sparsePaths,
    ref,
  });
}

export function normalizeSparsePaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => entry.replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean))].sort();
}

export async function cleanupTemporaryRelease(releasePath: string): Promise<void> {
  const root = path.dirname(path.dirname(releasePath));
  await fs.rm(root, { recursive: true, force: true });
}

export function inferContentKind(locator: string): ContentKind {
  return locator.includes('://') || locator.endsWith('.git') || locator.includes('@') ? 'git' : 'local';
}
