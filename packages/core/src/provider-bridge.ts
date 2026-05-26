import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AgentPmError } from '@agentpm/shared';

const execFileAsync = promisify(execFile);

const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export type ProviderId = 'skills.sh';

export interface ProviderSkillSearchResult {
  provider: ProviderId;
  name: string;
  source: string;
  installLocator: string;
  skillSelector: string;
  url: string | null;
  installs: string | null;
  description: string | null;
  raw: string;
}

export interface ProviderSkillInstallRequest {
  provider: ProviderId;
  source: string;
  installLocator: string;
  skills: string[];
  selector: string | null;
}

export type ProviderInstallInput =
  | {
      kind: 'request';
      request: ProviderSkillInstallRequest;
    }
  | {
      kind: 'query';
      provider: ProviderId;
      query: string;
    };

export function formatProviderSkillSelector(
  source: string,
  skill: string,
): string | null {
  const normalizedSkill = skill.trim();
  if (!normalizedSkill) {
    return null;
  }
  const normalizedSource = source.trim();
  const githubSource = normalizedSource.startsWith('github:')
    ? normalizedSource.slice('github:'.length)
    : normalizedSource;
  if (/^[^/\s]+\/[^/\s]+$/.test(githubSource)) {
    return `${githubSource}@${normalizedSkill}`;
  }
  return null;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

function normalizeProviderId(provider: string): ProviderId {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'skills' || normalized === 'skills.sh') {
    return 'skills.sh';
  }
  throw new AgentPmError(
    `Unsupported provider "${provider}". Supported providers: skills.sh`,
  );
}

function normalizeProviderSource(source: string): {
  source: string;
  installLocator: string;
} {
  const normalized = source.trim();
  if (!normalized) {
    throw new AgentPmError('A provider source is required.');
  }
  if (
    normalized.startsWith('github:') ||
    normalized.includes('://') ||
    normalized.startsWith('git@')
  ) {
    return {
      source: normalized,
      installLocator: normalized,
    };
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return {
      source: normalized,
      installLocator: `github:${normalized}`,
    };
  }
  return {
    source: normalized,
    installLocator: normalized,
  };
}

function isProviderSelectorCandidate(value: string): boolean {
  return /^([^/\s]+\/[^@\s]+)@([^\s]+)$/.test(value.trim());
}

function isProviderSourceCandidate(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.startsWith('github:') ||
    normalized.includes('://') ||
    normalized.startsWith('git@') ||
    /^[^/\s]+\/[^/\s]+$/.test(normalized)
  );
}

function parseProviderSelector(selector: string): {
  source: string;
  installLocator: string;
  skill: string;
} {
  const normalized = selector.trim();
  const match = normalized.match(/^([^/\s]+\/[^@\s]+)@([^\s]+)$/);
  if (!match) {
    throw new AgentPmError(
      'Expected a provider selector like "owner/repo@skill-name". Or pass a repo/path and use --skill <name>.',
    );
  }

  const source = match[1]!;
  const skill = match[2]!;
  return {
    source,
    installLocator: `github:${source}`,
    skill,
  };
}

async function runSkillsCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const commandArgs =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npx', 'skills', ...args]
      : ['skills', ...args];
  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      env: {
        ...process.env,
        ...env,
        DISABLE_TELEMETRY: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      maxBuffer: 1024 * 1024 * 10,
    });
    return stdout;
  } catch (error: unknown) {
    const details =
      error && typeof error === 'object' && 'stdout' in error
        ? String((error as { stdout?: string }).stdout ?? '')
        : '';
    if (details.trim()) {
      return details;
    }
    const reason =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'Could not run `npx skills`. Ensure Node.js and npm are installed and available on PATH.'
        : `Provider bridge command failed: ${error instanceof Error ? error.message : String(error)}`;
    throw new AgentPmError(details ? `${reason}\n\n${details}` : reason);
  }
}

export function parseSkillsProviderSearchOutput(
  output: string,
): ProviderSkillSearchResult[] {
  const cleaned = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (
    cleaned.length === 0 ||
    cleaned.some((line) => line.startsWith('No skills found for '))
  ) {
    return [];
  }

  const results: ProviderSkillSearchResult[] = [];
  for (const line of cleaned) {
    const normalizedLine = line.replace(/^└\s*/, '');
    const match = normalizedLine.match(
      /^([^/\s]+\/[^@\s]+@[^\s]+)\s+(.+?) installs$/i,
    );
    if (match) {
      const selector = match[1]!;
      const installs = match[2]!;
      const parsed = parseProviderSelector(selector);
      results.push({
        provider: 'skills.sh',
        name: parsed.skill,
        source: parsed.source,
        installLocator: parsed.installLocator,
        skillSelector: selector,
        url: null,
        installs,
        description: null,
        raw: normalizedLine,
      });
      continue;
    }

    const urlMatch = normalizedLine.match(/^https:\/\/\S+$/);
    if (urlMatch && results.length > 0) {
      results[results.length - 1]!.url = urlMatch[0];
    }
  }

  if (results.length === 0) {
    const preview = cleaned.slice(0, 5).join('\n');
    throw new AgentPmError(
      `skills.sh CLI returned unexpected search output.\n\n${preview}`,
    );
  }

  return results;
}

export async function searchProviderSkills(
  query: string,
  env: NodeJS.ProcessEnv,
  provider = 'skills.sh',
): Promise<ProviderSkillSearchResult[]> {
  const resolvedProvider = normalizeProviderId(provider);
  if (resolvedProvider !== 'skills.sh') {
    throw new AgentPmError(`Unsupported provider "${provider}".`);
  }
  if (!query.trim()) {
    throw new AgentPmError('A provider search query is required.');
  }
  const output = await runSkillsCli(['find', query.trim()], env);
  return parseSkillsProviderSearchOutput(output);
}

export function resolveProviderInstallRequest(
  sourceOrSelector: string,
  skills: string[] = [],
  provider = 'skills.sh',
): ProviderSkillInstallRequest {
  const resolvedProvider = normalizeProviderId(provider);
  if (resolvedProvider !== 'skills.sh') {
    throw new AgentPmError(`Unsupported provider "${provider}".`);
  }

  if (skills.length > 0) {
    const normalized = normalizeProviderSource(sourceOrSelector);
    return {
      provider: resolvedProvider,
      source: normalized.source,
      installLocator: normalized.installLocator,
      skills,
      selector: null,
    };
  }

  const parsed = parseProviderSelector(sourceOrSelector);
  return {
    provider: resolvedProvider,
    source: parsed.source,
    installLocator: parsed.installLocator,
    skills: [parsed.skill],
    selector: `${parsed.source}@${parsed.skill}`,
  };
}

export function resolveProviderInstallInput(
  sourceOrSelector: string,
  skills: string[] = [],
  provider = 'skills.sh',
): ProviderInstallInput {
  const resolvedProvider = normalizeProviderId(provider);
  const normalized = sourceOrSelector.trim();
  if (!normalized) {
    throw new AgentPmError('A provider install target or query is required.');
  }

  if (skills.length > 0 || isProviderSelectorCandidate(normalized)) {
    return {
      kind: 'request',
      request: resolveProviderInstallRequest(normalized, skills, provider),
    };
  }

  if (isProviderSourceCandidate(normalized)) {
    const source = normalizeProviderSource(normalized);
    return {
      kind: 'request',
      request: {
        provider: resolvedProvider,
        source: source.source,
        installLocator: source.installLocator,
        skills: [],
        selector: null,
      },
    };
  }

  return {
    kind: 'query',
    provider: resolvedProvider,
    query: normalized,
  };
}
