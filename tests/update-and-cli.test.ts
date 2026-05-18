import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import {
  copyDir,
  git,
  initFixtureGitRepo,
  makeTempDir,
  writeFile,
} from './helpers';

const execFileAsync = promisify(execFile);

describe('update and cli flows', () => {
  test('detects and applies updates from a local git source', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-git-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
    initFixtureGitRepo(repoDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(repoDir);
      await service.install(['skill-a'], { scope: 'project' });

      await writeFile(
        path.join(repoDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
        '# Skill A\n\nUpdated.\n',
      );
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-m', 'update skill');

      const previews = await service.previewUpdates({ names: ['skill-a'] });
      expect(previews[0]?.changed).toBe(true);

      await service.update({ names: ['skill-a'], apply: true, yes: true });
      const content = await fs.readFile(
        path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
        'utf8',
      );
      expect(content).toContain('Updated.');
    } finally {
      service.close();
    }
  }, 15000);

  test('installs a specific git commit when a ref is pinned', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-git-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
    initFixtureGitRepo(repoDir);
    const firstRevision = git(repoDir, 'rev-parse', 'HEAD');

    await writeFile(
      path.join(repoDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
      '# Skill A\n\nUpdated after pin.\n',
    );
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'update after pin');

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(repoDir);
      const installs = await service.install(['skill-a'], {
        scope: 'project',
        ref: firstRevision,
      });

      expect(installs[0]?.installedRevision).toBe(firstRevision);
      const content = await fs.readFile(
        path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
        'utf8',
      );
      expect(content).not.toContain('Updated after pin.');
    } finally {
      service.close();
    }
  }, 15000);

  test('cache clean removes unused repository caches without clearing the index', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-git-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
    initFixtureGitRepo(repoDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(repoDir);
      await service.install(['skill-a'], { scope: 'project' });
      expect(service.db.listCacheRepos()).toHaveLength(1);

      await service.removeInstall('skill-a');
      const result = await service.cleanCache();

      expect(result.removedEntries).toBeGreaterThan(0);
      expect(service.db.listCacheRepos()).toHaveLength(0);
      expect(
        service.search('skill-a').some((entry) => entry.name === 'skill-a'),
      ).toBe(true);
    } finally {
      service.close();
    }
  }, 15000);

  test('doctor plans and applies a transparent fix for an unused missing source', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const added = await service.addSource(sourceDir);
      await fs.rm(sourceDir, { recursive: true, force: true });

      const issues = await service.doctor();
      expect(issues.some((issue) => issue.code === 'source-missing')).toBe(
        true,
      );

      const actions = await service.planDoctorFixes(issues);
      expect(actions).toEqual([
        expect.objectContaining({
          code: 'remove-source',
          sourceId: added.source.id,
        }),
      ]);
      expect(actions[0]?.description).toContain('Removing unreachable source');

      const results = await service.applyDoctorFixes(actions);
      expect(results[0]?.applied).toBe(true);
      expect(service.listSources()).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test('prints CLI help through tsx', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'apps/cli/src/index.ts', '--help'],
      {
        cwd: path.resolve('.'),
      },
    );
    expect(stdout).toContain('Git-native skill and agent asset manager');
    expect(stdout).toContain('source');
    expect(stdout).toContain('install');
    expect(stdout).toContain('refresh');
    expect(stdout).toContain('cache');
  }, 15000);
});
