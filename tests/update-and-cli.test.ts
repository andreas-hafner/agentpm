import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { copyDir, git, initFixtureGitRepo, makeTempDir, writeFile } from './helpers';

const execFileAsync = promisify(execFile);

describe('update and cli flows', () => {
  test('detects and applies updates from a local git source', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-git-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
    initFixtureGitRepo(repoDir);

    const service = new AgentPmService({ cwd: projectDir, env: { AGENTPM_HOME: homeDir } });
    try {
      await service.addSource(repoDir);
      await service.install(['skill-a'], { scope: 'project' });

      await writeFile(path.join(repoDir, '.codex', 'skills', 'skill-a', 'SKILL.md'), '# Skill A\n\nUpdated.\n');
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-m', 'update skill');

      const previews = await service.previewUpdates({ names: ['skill-a'] });
      expect(previews[0]?.changed).toBe(true);

      await service.update({ names: ['skill-a'], apply: true, yes: true });
      const content = await fs.readFile(path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'), 'utf8');
      expect(content).toContain('Updated.');
    } finally {
      service.close();
    }
  }, 15000);

  test('prints CLI help through tsx', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts', '--help'], {
      cwd: path.resolve('.'),
    });
    expect(stdout).toContain('Git-native skill and agent asset manager');
    expect(stdout).toContain('source');
    expect(stdout).toContain('install');
  }, 15000);
});
