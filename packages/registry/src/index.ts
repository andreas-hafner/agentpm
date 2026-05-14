import path from 'node:path';
import https from 'node:https';
import { setTimeout } from 'node:timers/promises';

import yaml from 'js-yaml';

import { pathExists, readTextFile } from '@agentpm/fs';
import {
  AgentPmError,
  type RegistryIndexEntry,
  type RegistryIndexFile,
  isHttpUrl,
  isSkillsHubLocator,
  isSkillsShLocator,
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
  const adapterHint =
    entry.adapterHint === 'generic' ||
    entry.adapterHint === 'codex' ||
    entry.adapterHint === 'claude'
      ? entry.adapterHint
      : undefined;

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
    adapterHint,
    tags,
  };
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

interface SkillsShSkill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: string;
  installUrl: string | null;
  url: string;
}

interface SkillsShResponse {
  data: SkillsShSkill[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    hasMore: boolean;
  };
}

function getSkillsShApiKey(): string | undefined {
  return (
    process.env.SKILLS_SH_API_KEY || process.env.SKILLS_API_KEY || undefined
  );
}

function resolveSkillsShApiUrl(locator: string): string {
  const url = new URL(locator);
  if (url.pathname.startsWith('/api/v1/')) {
    return url.href;
  }
  return `${url.protocol}//${url.host}/api/v1/skills`;
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

async function fetchSkillsShPage(
  apiUrl: string,
  page: number,
  perPage: number,
): Promise<SkillsShResponse> {
  const url = new URL(apiUrl);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  const apiKey = getSkillsShApiKey();
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const text = await httpsGet(url.href, headers);
    return JSON.parse(text) as SkillsShResponse;
  } catch (err: unknown) {
    if (err instanceof AgentPmError && err.message.includes('(401)')) {
      if (apiKey) {
        throw new AgentPmError(
          'skills.sh API rejected the API key. Check SKILLS_SH_API_KEY or request a new one at https://skills.sh/docs/api.',
        );
      }
      throw new AgentPmError(
        'skills.sh API returned 401. To use this source, set SKILLS_SH_API_KEY (request one at skills-api@vercel.com). ' +
          'Or add GitHub repos directly: agentpm source add https://github.com/owner/repo',
      );
    }
    throw err;
  }
}

function skillsShSkillToEntry(skill: SkillsShSkill): RegistryIndexEntry {
  const repo = skill.installUrl ?? `https://github.com/${skill.source}`;
  return {
    name: skill.slug,
    description: skill.name,
    repo,
    tags: ['skills-sh'],
  };
}

async function loadSkillsShIndex(locator: string): Promise<RegistryIndexFile> {
  const apiUrl = resolveSkillsShApiUrl(locator);
  const entries: RegistryIndexEntry[] = [];
  let page = 0;
  const perPage = 100;

  for (;;) {
    const body = await fetchSkillsShPage(apiUrl, page, perPage);
    for (const skill of body.data) {
      entries.push(skillsShSkillToEntry(skill));
    }
    if (!body.pagination.hasMore) {
      break;
    }
    page++;
  }

  return { version: 1, entries };
}

interface SkillsHubSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  repo: {
    githubOwner: string;
    githubRepoName: string;
  };
}

interface SkillsHubResponse {
  data: SkillsHubSkill[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

function resolveSkillsHubApiUrl(locator: string): string {
  const url = new URL(locator);
  if (url.pathname.startsWith('/api/v1/')) {
    return url.href;
  }
  return `${url.protocol}//${url.host}/api/v1/skills/search`;
}

async function fetchSkillsHubPage(
  apiUrl: string,
  page: number,
  limit: number,
): Promise<SkillsHubResponse> {
  const url = new URL(apiUrl);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(limit));
  const text = await httpsGet(url.href);
  return JSON.parse(text) as SkillsHubResponse;
}

async function loadSkillsHubIndex(locator: string): Promise<RegistryIndexFile> {
  const apiUrl = resolveSkillsHubApiUrl(locator);
  const entries: RegistryIndexEntry[] = [];
  let page = 1;
  const limit = 50;
  const maxPages = 20;

  for (;;) {
    const body = await fetchSkillsHubPage(apiUrl, page, limit);
    for (const skill of body.data) {
      entries.push({
        name: skill.slug,
        description: skill.name,
        repo: `https://github.com/${skill.repo.githubOwner}/${skill.repo.githubRepoName}`,
        tags: skill.tags.length > 0 ? skill.tags : ['skillshub'],
      });
    }
    if (!body.hasMore || page >= maxPages) {
      break;
    }
    page++;
    await setTimeout(500);
  }

  return { version: 1, entries };
}

export async function loadRegistryIndex(
  locator: string,
): Promise<RegistryIndexFile> {
  if (isSkillsShLocator(locator)) {
    return loadSkillsShIndex(locator);
  }
  if (isSkillsHubLocator(locator)) {
    return loadSkillsHubIndex(locator);
  }
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
