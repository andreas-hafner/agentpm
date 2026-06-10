import {
  AgentPmError,
  displayNameFromLocator,
  normalizeGitHubRepoLocator,
  slugify,
} from '@agentpm/shared';

export function isGitLocatorToken(token: string): boolean {
  const normalized = normalizeGitHubRepoLocator(token.trim());
  return (
    normalized.startsWith('github:') ||
    normalized.includes('://') ||
    normalized.startsWith('git@') ||
    normalized.endsWith('.git')
  );
}

export function suggestTargetId(locator: string): string {
  return slugify(displayNameFromLocator(normalizeGitHubRepoLocator(locator)));
}

export async function resolveTargetAddArgs(
  firstArg: string,
  secondArg: string | undefined,
  options: {
    isInteractive: boolean;
    promptForId: (defaultId: string) => Promise<string>;
  },
): Promise<{ id: string; locator: string }> {
  if (secondArg) {
    return { id: firstArg.trim(), locator: secondArg.trim() };
  }

  if (!isGitLocatorToken(firstArg)) {
    throw new AgentPmError(
      'Expected "agentpm target add <id> <locator>" or "agentpm target add <locator>" with a Git target locator.',
    );
  }

  if (!options.isInteractive) {
    throw new AgentPmError(
      'Target ID is required in non-interactive mode. Use "agentpm target add <id> <locator>".',
    );
  }

  const locator = firstArg.trim();
  const defaultId = suggestTargetId(locator);
  const entered = await options.promptForId(defaultId);
  const id = entered.trim() || defaultId;
  if (!id) {
    throw new AgentPmError('Target name cannot be empty.');
  }
  return { id, locator };
}
