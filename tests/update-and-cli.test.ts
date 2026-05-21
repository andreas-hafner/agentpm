import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

async function writeGitGlobalIgnoreConfig(
  rootDir: string,
  patterns: string[],
): Promise<string> {
  const ignorePath = path.join(rootDir, 'global-ignore');
  const configPath = path.join(rootDir, 'gitconfig');
  await fs.writeFile(ignorePath, `${patterns.join('\n')}\n`, 'utf8');
  await fs.writeFile(
    configPath,
    `[core]\n    excludesfile = ${ignorePath.replace(/\\/g, '/')}\n`,
    'utf8',
  );
  return configPath;
}

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve('apps/cli/src/index.ts');
const tsxLoader = pathToFileURL(
  path.resolve('node_modules/tsx/dist/loader.mjs'),
).href;
const rootTsconfig = path.resolve('tsconfig.json');

async function runCli(
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  return execFileAsync(
    process.execPath,
    ['--import', tsxLoader, cliEntry, ...args],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        TSX_DISABLE_CACHE: '1',
        TSX_TSCONFIG_PATH: rootTsconfig,
      },
    },
  );
}

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

  test('CLI update prints a success message after applying changes', async () => {
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
    } finally {
      service.close();
    }

    await writeFile(
      path.join(repoDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
      '# Skill A\n\nUpdated by CLI.\n',
    );
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'update skill for cli');

    const { stdout } = await runCli(['update', 'skill-a', '--yes'], {
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    expect(stdout).toContain('Update complete');
    expect(stdout).toContain('1 item(s) updated');
    expect(
      await fs.readFile(
        path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Updated by CLI.');
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

  test('cache clean dry run reports unused caches without deleting them', async () => {
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
      await service.removeInstall('skill-a');

      const result = await service.cleanCache({ dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.removedEntries).toBeGreaterThan(0);
      expect(service.db.listCacheRepos()).toHaveLength(1);
    } finally {
      service.close();
    }
  }, 15000);

  test('cache clean preserves reusable push target repositories', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-push-project-');
    const remoteDir = await makeTempDir('agentpm-push-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const gitGlobalConfig = await writeGitGlobalIgnoreConfig(remoteDir, [
      '.agents/',
    ]);

    git(remoteDir, 'init', '--bare', remoteRepo);
    await writeFile(
      path.join(projectDir, '.agents', 'skills', 'skill-a', 'SKILL.md'),
      '# pushed skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: {
        AGENTPM_HOME: homeDir,
        GIT_AUTHOR_NAME: 'AgentPM Tests',
        GIT_AUTHOR_EMAIL: 'tests@example.com',
        GIT_COMMITTER_NAME: 'AgentPM Tests',
        GIT_COMMITTER_EMAIL: 'tests@example.com',
        GIT_CONFIG_GLOBAL: gitGlobalConfig,
      },
    });
    try {
      await service.push({
        target: remoteRepo,
        path: 'skill-a',
        message: 'Initial push',
      });

      const pushTargetCache = service.db
        .listCacheRepos()
        .find((repo) => repo.metadata.role === 'push-target');
      expect(pushTargetCache).toBeTruthy();

      const result = await service.cleanCache();
      expect(result.removedPaths).not.toContain(pushTargetCache!.basePath);
      expect(await fs.stat(pushTargetCache!.basePath)).toBeTruthy();
    } finally {
      service.close();
    }
  }, 15000);

  test('source add and install reuse a single cached checkout for the same git repo', async () => {
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
      const repoLocator = pathToFileURL(repoDir).href;
      await service.addSource(repoLocator);
      expect(service.db.listCacheRepos()).toHaveLength(1);

      const installs = await service.install(['skill-a'], { scope: 'project' });
      expect(installs).toHaveLength(1);
      expect(service.db.listCacheRepos()).toHaveLength(1);
      expect(service.db.listCacheRepos()[0]?.cacheKey).toBe(
        installs[0]?.cacheKey,
      );
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

  test('doctor can remove stale install records and deduplicates missing cache', async () => {
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
      const installs = await service.install(['skill-a'], { scope: 'project' });
      const cachePath = service.db.listCacheRepos()[0]!.basePath;
      await fs.rm(installs[0]!.targetPath, { recursive: true, force: true });
      await fs.rm(cachePath, { recursive: true, force: true });

      const issues = await service.doctor();
      expect(issues.some((issue) => issue.code === 'install-missing')).toBe(
        true,
      );
      expect(issues.some((issue) => issue.code === 'missing-cache')).toBe(
        false,
      );

      const actions = await service.planDoctorFixes(issues);
      expect(actions).toEqual([
        expect.objectContaining({
          code: 'remove-install-record',
          installId: installs[0]!.id,
        }),
      ]);

      const results = await service.applyDoctorFixes(actions);
      expect(results[0]?.applied).toBe(true);
      expect(service.listInstalls()).toHaveLength(0);
    } finally {
      service.close();
    }
  }, 15000);

  test('CLI search hints stale indexes and --refresh rebuilds them', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-git-source-');
    await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
    initFixtureGitRepo(repoDir);

    const service = new AgentPmService({
      cwd: repoDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(repoDir);
    } finally {
      service.close();
    }

    await writeFile(
      path.join(repoDir, '.codex', 'skills', 'new-skill', 'SKILL.md'),
      '# New Skill\n',
    );
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'add new skill');

    const stale = await runCli(['search', 'new-skill'], {
      cwd: repoDir,
      env: { AGENTPM_HOME: homeDir },
    });
    expect(stale.stdout).toContain('No matches found.');
    expect(stale.stdout).toContain('Indexes may be stale');

    const refreshed = await runCli(['search', 'new-skill', '--refresh'], {
      cwd: repoDir,
      env: { AGENTPM_HOME: homeDir },
    });
    expect(refreshed.stdout).toContain('Source Refresh');
    expect(refreshed.stdout).toContain('catalog  new-skill');
  }, 15000);

  test('prints CLI help through tsx', async () => {
    const { stdout } = await runCli(['--help'], {
      cwd: path.resolve('.'),
    });
    expect(stdout).toContain('Git-native skill and agent asset manager');
    expect(stdout).toContain('source');
    expect(stdout).toContain('install');
    expect(stdout).toContain('refresh');
    expect(stdout).toContain('cache');
    expect(stdout).toContain('search pdf --refresh');
    expect(stdout).toContain('cache clean --dry-run');
    expect(stdout).toContain('source skills');
    expect(stdout).toContain('install --from');
    expect(stdout).toContain('target add production');
  }, 15000);
});
