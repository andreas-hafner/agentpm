import path from 'node:path';

import yaml from 'js-yaml';

import { pathExists, readTextFile } from '@agentpm/fs';
import {
  AgentPmError,
  type RegistryIndexEntry,
  type RegistryIndexFile,
  isHttpUrl,
} from '@agentpm/shared';

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new AgentPmError('Registry entries must be objects.');
  }
  return value as Record<string, unknown>;
}

function coerceEntry(entry: Record<string, unknown>): RegistryIndexEntry {
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const adapterHint =
    entry.adapterHint === 'generic' || entry.adapterHint === 'codex' || entry.adapterHint === 'claude'
      ? entry.adapterHint
      : undefined;

  if (typeof entry.name !== 'string' || typeof entry.repo !== 'string') {
    throw new AgentPmError('Registry entries must include string "name" and "repo" fields.');
  }

  return {
    name: entry.name,
    description: typeof entry.description === 'string' ? entry.description : undefined,
    repo: entry.repo,
    ref: typeof entry.ref === 'string' ? entry.ref : undefined,
    path: typeof entry.path === 'string' ? entry.path : undefined,
    adapterHint,
    tags,
  };
}

function parseRegistryContent(locator: string, content: string): RegistryIndexFile {
  const extension = path.extname(locator).toLowerCase();
  const parsed: unknown = extension === '.json' ? JSON.parse(content) : yaml.load(content);

  if (Array.isArray(parsed)) {
    return {
      version: 1,
      entries: parsed.map((entry) => coerceEntry(toRecord(entry))),
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new AgentPmError('Registry index must be an object or array.');
  }

  const record = parsed as Record<string, unknown>;
  const entries = Array.isArray(record.entries) ? record.entries : [];
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    entries: entries.map((entry) => coerceEntry(toRecord(entry))),
  };
}

export async function loadRegistryIndex(locator: string): Promise<RegistryIndexFile> {
  const content = await readRegistryLocator(locator);
  return parseRegistryContent(locator, content);
}

export async function readRegistryLocator(locator: string): Promise<string> {
  if (isHttpUrl(locator)) {
    const response = await fetch(locator);
    if (!response.ok) {
      throw new AgentPmError(`Failed to fetch registry index: ${locator} (${response.status})`);
    }
    return response.text();
  }

  const absolutePath = path.resolve(locator);
  if (!(await pathExists(absolutePath))) {
    throw new AgentPmError(`Registry index not found: ${absolutePath}`);
  }
  return readTextFile(absolutePath);
}
