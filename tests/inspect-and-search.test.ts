import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';
import { classifyLocator } from '@agentpm/shared';

import {
  copyDir,
  git,
  initFixtureGitRepo,
  makeTempDir,
  writeFile,
} from './helpers';

const fixturesRoot = path.resolve('tests/fixtures/repos');
const CI_TEST_TIMEOUT = process.env.CI ? 30_000 : 15_000;

describe('inspect and search', () => {
  test('detects codex layout from a local repo', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-codex-');
    await copyDir(path.join(fixturesRoot, 'codex'), repoDir);

    const service = new AgentPmService({
      cwd: repoDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const report = await service.inspect(repoDir);
      expect(report.installable).toBe(true);
      expect(report.groups[0]?.relativeRoot).toBe('.codex/skills');
      expect(report.groups[0]?.entries.map((entry) => entry.name)).toContain(
        'skill-a',
      );
    } finally {
      service.close();
    }
  });

  test('adds a registry source and exposes catalog search results', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const workspace = await makeTempDir('agentpm-workspace-');
    await copyDir(
      path.resolve('tests/fixtures/registry'),
      path.join(workspace, 'registry'),
    );
    await copyDir(
      path.resolve('tests/fixtures/repos/codex'),
      path.join(workspace, 'repos', 'codex'),
    );

    const service = new AgentPmService({
      cwd: workspace,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const added = await service.addSource(
        path.join(workspace, 'registry', 'index.yaml'),
      );
      expect(added.indexedEntries).toBe(1);

      const results = service.search('registry-codex');
      expect(results.some((result) => result.name === 'registry-codex')).toBe(
        true,
      );
    } finally {
      service.close();
    }
  });

  test('does not treat skills.sh as a dedicated registry locator', () => {
    expect(classifyLocator('skills.sh')).toBe('local');
    expect(classifyLocator('https://skills.sh')).toBe('git');
    expect(classifyLocator('skillshub.wtf')).toBe('local');
    expect(classifyLocator('https://skillshub.wtf')).toBe('git');
  });

  test('refresh rebuilds a git source index after repository changes', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-git-source-');
    await copyDir(path.join(fixturesRoot, 'codex'), repoDir);
    initFixtureGitRepo(repoDir);

    const service = new AgentPmService({
      cwd: repoDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(repoDir);
      expect(service.search('new-skill')).toHaveLength(0);

      await writeFile(
        path.join(repoDir, '.codex', 'skills', 'new-skill', 'SKILL.md'),
        '# New Skill\n',
      );
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-m', 'add new skill');

      const results = await service.refreshSources();
      expect(results[0]?.indexedEntries).toBe(2);
      expect(
        service
          .search('new-skill')
          .some((result) => result.name === 'new-skill'),
      ).toBe(true);
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('detects plain skills folder repositories and install-script risk', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-plain-skills-');
    await writeFile(
      path.join(repoDir, 'skills', 'plain-skill', 'SKILL.md'),
      '# Plain Skill\n',
    );
    await writeFile(path.join(repoDir, 'scripts', 'install.sh'), '#!/bin/sh\n');

    const service = new AgentPmService({
      cwd: repoDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const report = await service.inspect(repoDir);
      expect(report.installable).toBe(true);
      expect(report.groups[0]?.relativeRoot).toBe('skills');
      expect(report.groups[0]?.entries[0]?.name).toBe('plain-skill');
      expect(report.scripts[0]?.relativePath).toBe('scripts/install.sh');
      expect(report.warnings).toContain(
        'Install scripts detected. AgentPM does not execute them automatically.',
      );
    } finally {
      service.close();
    }
  });
});
