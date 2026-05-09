import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { copyDir, makeTempDir } from './helpers';

const fixturesRoot = path.resolve('tests/fixtures/repos');

describe('inspect and search', () => {
  test('detects codex layout from a local repo', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-codex-');
    await copyDir(path.join(fixturesRoot, 'codex'), repoDir);

    const service = new AgentPmService({ cwd: repoDir, env: { AGENTPM_HOME: homeDir } });
    try {
      const report = await service.inspect(repoDir);
      expect(report.installable).toBe(true);
      expect(report.groups[0]?.relativeRoot).toBe('.codex/skills');
      expect(report.groups[0]?.entries.map((entry) => entry.name)).toContain('skill-a');
    } finally {
      service.close();
    }
  });

  test('adds a registry source and exposes catalog search results', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const workspace = await makeTempDir('agentpm-workspace-');
    await copyDir(path.resolve('tests/fixtures/registry'), path.join(workspace, 'registry'));
    await copyDir(path.resolve('tests/fixtures/repos/codex'), path.join(workspace, 'repos', 'codex'));

    const service = new AgentPmService({ cwd: workspace, env: { AGENTPM_HOME: homeDir } });
    try {
      const added = await service.addSource(path.join(workspace, 'registry', 'index.yaml'));
      expect(added.indexedEntries).toBe(1);

      const results = service.search('registry-codex');
      expect(results.some((result) => result.name === 'registry-codex')).toBe(true);
    } finally {
      service.close();
    }
  });
});

