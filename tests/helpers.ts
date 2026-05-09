import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function copyDir(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
}

export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
  });
}

export function initFixtureGitRepo(repoPath: string): void {
  git(repoPath, 'init', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'AgentPM Tests');
  git(repoPath, 'config', 'user.email', 'tests@example.com');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'initial');
}

export async function writeFile(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, 'utf8');
}
