import { spawn } from 'node:child_process';
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
  env?: NodeJS.ProcessEnv | undefined;
}

export interface GitRelease {
  releasePath: string;
  revision: string;
}

export interface GitCommandResult {
  stdout: string;
}

export interface GitCommandOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  captureStdout?: boolean | undefined;
}

export function resolveReleasePath(basePath: string, revision: string): string {
  return path.join(basePath, 'r', revision.slice(0, 12));
}

export async function isLocalGitRepository(locator: string): Promise<boolean> {
  const gitDirectory = path.join(locator, '.git');
  return pathExists(gitDirectory);
}

function resolveGitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

export async function runGitCommand(
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const stdoutChunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: resolveGitEnv(options.env),
      stdio: options.captureStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      windowsHide: false,
    });

    if (options.captureStdout) {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutChunks.push(
          typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
        );
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new AgentPmError(`git ${args[0] ?? 'command'} failed with exit code ${code ?? 'unknown'}`));
    });
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
  };
}

export async function resolveGitRevision(
  locator: string,
  ref?: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  if (await isLocalGitRepository(locator)) {
    const repo = simpleGit(locator);
    const revision = await repo.revparse([ref ?? 'HEAD']);
    return revision.trim();
  }

  const target = ref ?? 'HEAD';
  const output = await runGitCommand(['ls-remote', locator, target], {
    env,
    captureStdout: true,
  });
  const firstLine = output.stdout
    .split('\n')
    .find((line) => line.trim().length > 0);
  const revision = firstLine?.split('\t')[0]?.trim();
  if (!revision) {
    throw new AgentPmError(`Could not resolve remote revision for ${locator}`);
  }
  return revision;
}

export async function materializeGitRelease(options: GitReleaseOptions): Promise<GitRelease> {
  await ensureDir(options.basePath);
  const targetRevision =
    options.revision ??
    (await resolveGitRevision(
      options.locator,
      options.ref ?? undefined,
      options.env,
    ));
  const releasePath = resolveReleasePath(options.basePath, targetRevision);
  if (await pathExists(releasePath)) {
    return { releasePath, revision: targetRevision };
  }

  await ensureDir(path.dirname(releasePath));
  const cloneArgs = ['--depth', '1', '--filter=blob:none', '--no-checkout'];
  if (options.ref && !isGitRevision(options.ref)) {
    cloneArgs.push('--branch', options.ref);
  }

  await runGitCommand(['clone', ...cloneArgs, options.locator, releasePath], {
    env: options.env,
  });

  const repo = simpleGit(releasePath);
  if (options.sparsePaths.length > 0) {
    await repo.raw(['sparse-checkout', 'init', '--cone']);
    await repo.raw(['sparse-checkout', 'set', ...options.sparsePaths]);
  }

  if (options.revision && isGitRevision(options.revision) && options.ref !== options.revision) {
    await runGitCommand(['fetch', 'origin', options.revision, '--depth', '1'], {
      cwd: releasePath,
      env: options.env,
    });
    await repo.checkout(['FETCH_HEAD']);
  } else if (options.ref && isGitRevision(options.ref)) {
    await runGitCommand(['fetch', 'origin', options.ref, '--depth', '1'], {
      cwd: releasePath,
      env: options.env,
    });
    await repo.checkout(['FETCH_HEAD']);
  } else {
    await repo.checkout(['HEAD']);
  }

  const revision = (await repo.revparse(['HEAD'])).trim();
  return { releasePath, revision };
}

export async function createTemporaryGitRelease(
  locator: string,
  sparsePaths: string[],
  ref?: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<GitRelease> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentpm-inspect-'));
  return materializeGitRelease({
    locator,
    basePath: tempRoot,
    sparsePaths,
    ref,
    env,
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
