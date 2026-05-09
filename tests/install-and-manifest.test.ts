import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { copyDir, initFixtureGitRepo, makeTempDir } from './helpers';

describe('install and manifest flows', () => {
  test('installs a local generic skill into project scope and writes a manifest', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const service = new AgentPmService({ cwd: projectDir, env: { AGENTPM_HOME: homeDir } });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['skill-b'], { scope: 'project' });
      expect(installs).toHaveLength(1);

      const targetPath = path.join(projectDir, '.agents', 'skills', 'skill-b');
      expect(await fs.lstat(targetPath)).toBeTruthy();

      const manifest = await service.initManifest();
      expect(manifest.manifest.installs[0]?.name).toBe('skill-b');

      const doctorIssues = await service.doctor();
      expect(doctorIssues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test('sync installs entries from agentpm.yaml into a second project', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectA = await makeTempDir('agentpm-project-a-');
    const projectB = await makeTempDir('agentpm-project-b-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const serviceA = new AgentPmService({ cwd: projectA, env: { AGENTPM_HOME: homeDir } });
    try {
      await serviceA.addSource(sourceDir);
      await serviceA.install(['skill-b'], { scope: 'project' });
      await serviceA.initManifest();
    } finally {
      serviceA.close();
    }

    await fs.copyFile(path.join(projectA, 'agentpm.yaml'), path.join(projectB, 'agentpm.yaml'));

    const serviceB = new AgentPmService({ cwd: projectB, env: { AGENTPM_HOME: homeDir } });
    try {
      const installs = await serviceB.syncManifest();
      expect(installs.some((install) => install.name === 'skill-b')).toBe(true);
      expect(await fs.lstat(path.join(projectB, '.agents', 'skills', 'skill-b'))).toBeTruthy();
    } finally {
      serviceB.close();
    }
  });

  test('installs a nested skill collection entry by path selector', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    const repoDir = path.resolve('tests/fixtures/repos/nested-skills');

    const service = new AgentPmService({ cwd: projectDir, env: { AGENTPM_HOME: homeDir } });
    try {
      const addedSource = await service.addSource(repoDir);
      expect(addedSource.indexedEntries).toBe(2);

      const installs = await service.install([addedSource.source.id], {
        scope: 'project',
        skills: ['.curated/openai-docs'],
      });

      expect(installs).toHaveLength(1);
      expect(installs[0]?.name).toBe('openai-docs');
      expect(installs[0]?.sourceRelativePath).toBe('skills/.curated/openai-docs');

      const installedPath = path.join(projectDir, 'skills', '.curated', 'openai-docs', 'SKILL.md');
      const installedContent = await fs.readFile(installedPath, 'utf8');
      expect(installedContent).toContain('Curated OpenAI docs skill');
    } finally {
      service.close();
    }
  });

  test('installs a git-backed source with a long AgentPM home path on Windows-safe cache paths', async () => {
    const homeRoot = await makeTempDir('agentpm-home-root-');
    const homeDir = path.join(homeRoot, `agentpm-home-${'x'.repeat(80)}`);
    const sourceDir = await makeTempDir('agentpm-source-git-');
    const projectDir = await makeTempDir('agentpm-project-');
    await fs.mkdir(homeDir, { recursive: true });
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    initFixtureGitRepo(sourceDir);

    const service = new AgentPmService({ cwd: projectDir, env: { AGENTPM_HOME: homeDir } });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['skill-b'], { scope: 'project' });
      expect(installs).toHaveLength(1);
      expect(await fs.lstat(path.join(projectDir, '.agents', 'skills', 'skill-b'))).toBeTruthy();
    } finally {
      service.close();
    }
  }, 15000);
});
