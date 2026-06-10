import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { git, makeTempDir, writeFile } from './helpers';

const CI_TEST_TIMEOUT = process.env.CI ? 30_000 : 15_000;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'AgentPM Tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'AgentPM Tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
};

async function realpath(target: string): Promise<string> {
  return fs.realpath(target);
}

describe('canonical skill library', () => {
  test('push normalizes a native codex skill into the canonical skills/ folder', async () => {
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const verifyDir = path.join(remoteDir, 'verify');

    git(remoteDir, 'init', '--bare', remoteRepo);
    await writeFile(
      path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
      '# codex skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: await makeTempDir('agentpm-canon-home-') },
    });
    try {
      const result = await service.push({
        target: remoteRepo,
        path: 'skill-a',
        message: 'canonical push',
      });
      expect(result.entries).toEqual(['skills/skill-a']);

      git(remoteDir, 'clone', remoteRepo, verifyDir);
      expect(
        await fs.readFile(
          path.join(verifyDir, 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('# codex skill');
      // The original native path is not preserved in the destination.
      expect(
        await fs
          .stat(path.join(verifyDir, '.codex', 'skills', 'skill-a'))
          .catch(() => null),
      ).toBeNull();
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('push --preserve-layout keeps the native target-relative path', async () => {
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const verifyDir = path.join(remoteDir, 'verify');

    git(remoteDir, 'init', '--bare', remoteRepo);
    await writeFile(
      path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
      '# codex skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: await makeTempDir('agentpm-canon-home-') },
    });
    try {
      const result = await service.push({
        target: remoteRepo,
        path: 'skill-a',
        preserveLayout: true,
        message: 'native push',
      });
      expect(result.entries).toEqual(['.codex/skills/skill-a']);

      git(remoteDir, 'clone', remoteRepo, verifyDir);
      expect(
        await fs.readFile(
          path.join(verifyDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('# codex skill');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('pull materializes a canonical skill into multiple agents as symlinks to one library entry', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');

    // Build a canonical skills repository: skills/<name>/SKILL.md
    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, 'skills', 'demo', 'SKILL.md'),
      '# demo skill\n',
    );
    git(seedDir, 'init', '-b', 'main');
    git(seedDir, 'config', 'user.name', 'AgentPM Tests');
    git(seedDir, 'config', 'user.email', 'tests@example.com');
    git(seedDir, 'add', '.');
    git(seedDir, 'commit', '-m', 'seed');
    git(seedDir, 'remote', 'add', 'origin', remoteRepo);
    git(seedDir, 'push', 'origin', 'main');

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.pull({
        target: remoteRepo,
        agents: ['codex', 'claude', 'generic'],
        scope: 'project',
        yes: true,
      });

      expect(result.success).toBe(true);
      expect(result.skills).toEqual(['demo']);
      expect(result.installs).toHaveLength(3);

      const libraryEntry = path.join(homeDir, 'skills', 'demo');
      expect(
        await fs.readFile(path.join(libraryEntry, 'SKILL.md'), 'utf8'),
      ).toContain('# demo skill');

      const codexLink = path.join(projectDir, '.codex', 'skills', 'demo');
      const claudeLink = path.join(projectDir, '.claude', 'skills', 'demo');
      const genericLink = path.join(projectDir, '.agents', 'skills', 'demo');

      for (const link of [codexLink, claudeLink, genericLink]) {
        const stats = await fs.lstat(link);
        expect(stats.isSymbolicLink()).toBe(true);
        expect(await realpath(link)).toBe(await realpath(libraryEntry));
      }
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('adopt moves an existing skill into the library and fans it out to other agents', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');

    // A skill that currently only lives in the Claude agent directory.
    const originPath = path.join(envDir, '.claude', 'skills', 'helper');
    await writeFile(path.join(originPath, 'SKILL.md'), '# helper skill\n');

    const service = new AgentPmService({
      cwd: envDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.adopt(originPath, {
        agents: ['codex', 'generic'],
        yes: true,
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe('helper');

      const libraryEntry = path.join(homeDir, 'skills', 'helper');
      expect(
        await fs.readFile(path.join(libraryEntry, 'SKILL.md'), 'utf8'),
      ).toContain('# helper skill');

      // Origin is replaced by a managed symlink into the library.
      const originStats = await fs.lstat(originPath);
      expect(originStats.isSymbolicLink()).toBe(true);
      expect(await realpath(originPath)).toBe(await realpath(libraryEntry));

      // Other agents now symlink to the same single source of truth.
      const codexLink = path.join(envDir, '.codex', 'skills', 'helper');
      const genericLink = path.join(envDir, '.agents', 'skills', 'helper');
      for (const link of [codexLink, genericLink]) {
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        expect(await realpath(link)).toBe(await realpath(libraryEntry));
      }
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('fan-out skips a pre-existing unmanaged directory instead of aborting', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');

    const originPath = path.join(envDir, '.claude', 'skills', 'helper');
    await writeFile(path.join(originPath, 'SKILL.md'), '# helper skill\n');

    // Codex already has a real, unmanaged skill directory of the same name.
    const codexReal = path.join(envDir, '.codex', 'skills', 'helper');
    await writeFile(path.join(codexReal, 'SKILL.md'), '# pre-existing codex\n');

    const service = new AgentPmService({
      cwd: envDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.adopt(originPath, {
        agents: ['codex', 'generic'],
        yes: true,
      });

      expect(result.success).toBe(true);
      // Codex is skipped with a warning; its real content is left untouched.
      expect(result.warnings.some((w) => w.includes('codex'))).toBe(true);
      const codexStats = await fs.lstat(codexReal);
      expect(codexStats.isSymbolicLink()).toBe(false);
      expect(
        await fs.readFile(path.join(codexReal, 'SKILL.md'), 'utf8'),
      ).toContain('# pre-existing codex');

      // Generic still links to the library.
      const genericLink = path.join(envDir, '.agents', 'skills', 'helper');
      expect((await fs.lstat(genericLink)).isSymbolicLink()).toBe(true);
      expect(await realpath(genericLink)).toBe(
        await realpath(path.join(homeDir, 'skills', 'helper')),
      );
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);
});
