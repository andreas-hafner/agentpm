import { describe, expect, test } from 'vitest';

import {
  resolveTargetAddArgs,
  suggestTargetId,
} from '../apps/cli/src/target-add';

describe('target add CLI helpers', () => {
  test('derives the default target id from the repo name', () => {
    expect(suggestTargetId('https://github.com/travelhawk/skills-vault')).toBe(
      'skills-vault',
    );
    expect(suggestTargetId('travelhawk/skills-vault')).toBe('skills-vault');
  });

  test('keeps an explicit id when both id and locator are provided', async () => {
    await expect(
      resolveTargetAddArgs('origin', 'travelhawk/skills-vault', {
        isInteractive: false,
        promptForId: () => Promise.resolve('ignored'),
      }),
    ).resolves.toEqual({
      id: 'origin',
      locator: 'travelhawk/skills-vault',
    });
  });

  test('prompts for a missing target id and recommends the repo basename', async () => {
    const promptedDefaults: string[] = [];
    await expect(
      resolveTargetAddArgs(
        'https://github.com/travelhawk/skills-vault',
        undefined,
        {
          isInteractive: true,
          promptForId: (defaultId) => {
            promptedDefaults.push(defaultId);
            return Promise.resolve('');
          },
        },
      ),
    ).resolves.toEqual({
      id: 'skills-vault',
      locator: 'https://github.com/travelhawk/skills-vault',
    });
    expect(promptedDefaults).toEqual(['skills-vault']);
  });

  test('fails clearly in non-interactive mode when the target id is missing', async () => {
    await expect(
      resolveTargetAddArgs('travelhawk/skills-vault', undefined, {
        isInteractive: false,
        promptForId: () => Promise.resolve('ignored'),
      }),
    ).rejects.toThrow('Target ID is required in non-interactive mode');
  });
});
