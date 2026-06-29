import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DiffEntry } from '@agentpm/shared';
import { AgentPmError, toPosixPath } from '@agentpm/shared';

const IGNORED_NAMES = new Set(['.git', 'node_modules', '.turbo', 'dist']);

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(targetPath: string): Promise<string> {
  return fs.readFile(targetPath, 'utf8');
}

export async function writeTextFile(targetPath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, 'utf8');
}

export async function listChildDirectories(rootPath: string): Promise<string[]> {
  if (!(await pathExists(rootPath))) {
    return [];
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function walkFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  if (await pathExists(rootPath)) {
    await visit(rootPath);
  }

  return files.sort();
}

export async function computeTreeSignature(rootPath: string): Promise<string> {
  const files = await walkFiles(rootPath);
  const hash = createHash('sha1');
  for (const filePath of files) {
    const relativePath = toPosixPath(path.relative(rootPath, filePath));
    hash.update(relativePath);
    hash.update(await fs.readFile(filePath));
  }
  return hash.digest('hex');
}

async function mapFiles(rootPath: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const filePath of await walkFiles(rootPath)) {
    const relativePath = toPosixPath(path.relative(rootPath, filePath));
    const content = await fs.readFile(filePath);
    const contentHash = createHash('sha1').update(content).digest('hex');
    result.set(relativePath, contentHash);
  }
  return result;
}

export async function diffTrees(previousRoot: string, nextRoot: string): Promise<DiffEntry[]> {
  const previous = await mapFiles(previousRoot);
  const next = await mapFiles(nextRoot);
  const paths = new Set([...previous.keys(), ...next.keys()]);
  const result: DiffEntry[] = [];

  for (const relativePath of [...paths].sort()) {
    const before = previous.get(relativePath);
    const after = next.get(relativePath);

    if (!before && after) {
      result.push({ kind: 'added', path: relativePath });
    } else if (before && !after) {
      result.push({ kind: 'removed', path: relativePath });
    } else if (before && after && before !== after) {
      result.push({ kind: 'changed', path: relativePath });
    }
  }

  return result;
}

export async function ensureManagedLink(linkPath: string, targetPath: string): Promise<void> {
  await ensureDir(path.dirname(linkPath));

  if (path.resolve(linkPath) === path.resolve(targetPath)) {
    throw new AgentPmError(`Refusing to create a managed link to itself: ${linkPath}`);
  }

  if (await pathExists(linkPath)) {
    const stats = await fs.lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      throw new AgentPmError(`Refusing to replace existing non-link path: ${linkPath}`);
    }

    const resolvedExisting = await fs.realpath(linkPath);
    const resolvedTarget = await fs.realpath(targetPath);
    if (resolvedExisting === resolvedTarget) {
      return;
    }

    throw new AgentPmError(`Refusing to replace existing link with different target: ${linkPath}`);
  }

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(targetPath, linkPath, linkType);
}

export async function removeManagedLink(linkPath: string): Promise<void> {
  if (await pathExists(linkPath)) {
    await fs.rm(linkPath, { recursive: true, force: true });
  }
}

export async function isBrokenLink(linkPath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      return false;
    }
    await fs.realpath(linkPath);
    return false;
  } catch {
    return true;
  }
}

export async function realpathOrNull(targetPath: string): Promise<string | null> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

