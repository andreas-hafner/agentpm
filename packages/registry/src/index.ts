import path from 'node:path';
import https from 'node:https';
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
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const adapterHint = coerceAdapterId(entry.adapterHint, 'adapterHint');
  const target = coerceAdapterId(entry.target, 'target');
  if (adapterHint && target && adapterHint !== target) {
    throw new AgentPmError(
      `Registry entry "${String(entry.name)}" has conflicting adapterHint and target values.`,
    );
  }

  if (typeof entry.name !== 'string' || typeof entry.repo !== 'string') {
    throw new AgentPmError(
      'Registry entries must include string "name" and "repo" fields.',
    );
  }

  return {
    name: entry.name,
    description:
      typeof entry.description === 'string' ? entry.description : undefined,
    repo: entry.repo,
    ref: typeof entry.ref === 'string' ? entry.ref : undefined,
    path: typeof entry.path === 'string' ? entry.path : undefined,
    adapterHint: adapterHint ?? target,
    target: target ?? adapterHint,
    tags,
  };
}

function coerceAdapterId(
  value: unknown,
  field: string,
): RegistryIndexEntry['adapterHint'] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === 'generic' || value === 'codex' || value === 'claude') {
    return value;
  }
  throw new AgentPmError(
    `Registry entry ${field} must be one of: codex, claude, generic.`,
  );
}

function parseRegistryContent(
  locator: string,
  content: string,
): RegistryIndexFile {
  const extension = path.extname(locator).toLowerCase();
  const parsed: unknown =
    extension === '.json' ? JSON.parse(content) : yaml.load(content);

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

function httpsGet(
  url: string,
  headers?: Record<string, string>,
  redirects = 5,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'agentpm/0.1.0', ...headers },
    };
    const req = https.get(opts, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirects <= 0) {
          reject(new AgentPmError(`Too many redirects fetching ${url}`));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).href;
        res.resume();
        resolve(httpsGet(redirectUrl, headers, redirects - 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(
            new AgentPmError(`Failed to fetch ${url} (${res.statusCode})`),
          );
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function registryTokenEnvName(locator: string): string {
  const host = new URL(locator).hostname
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `AGENTPM_REGISTRY_TOKEN_${host}`;
}

function getRegistryHeaders(
  locator: string,
): Record<string, string> | undefined {
  const hostToken = process.env[registryTokenEnvName(locator)];
  const token = hostToken || process.env.AGENTPM_REGISTRY_TOKEN;
  if (!token) {
    return undefined;
  }
  return { Authorization: `Bearer ${token}` };
}

export async function loadRegistryIndex(
  locator: string,
): Promise<RegistryIndexFile> {
  const content = await readRegistryLocator(locator);
  return parseRegistryContent(locator, content);
}

export async function readRegistryLocator(locator: string): Promise<string> {
  if (isHttpUrl(locator)) {
    return httpsGet(locator, getRegistryHeaders(locator));
  }

  const absolutePath = path.resolve(locator);
  if (!(await pathExists(absolutePath))) {
    throw new AgentPmError(`Registry index not found: ${absolutePath}`);
  }
  return readTextFile(absolutePath);
}
