import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { git, makeTempDir, writeFile } from './helpers';

const CI_TEST_TIMEOUT = process.env.CI ? 30_000 : 15_000;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'AgentPM Tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'AgentPM Tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
};

function seedAndPushRepo(seedDir: string, remoteRepo: string): void {
  git(seedDir, 'init', '-b', 'main');
  git(seedDir, 'config', 'user.name', 'AgentPM Tests');
  git(seedDir, 'config', 'user.email', 'tests@example.com');
  git(seedDir, 'add', '.');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', remoteRepo);
  git(seedDir, 'push', 'origin', 'main');
}

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

async function listAllFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  }
  if (await pathExists(dir)) {
    await visit(dir);
  }
  return result;
}

const restoreHomeCallbacks: Array<() => void> = [];

afterEach(() => {
  while (restoreHomeCallbacks.length > 0) {
    restoreHomeCallbacks.pop()?.();
  }
});

function useFakeUserHome(fakeUserHome: string): void {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeUserHome;
  process.env.USERPROFILE = fakeUserHome;
  restoreHomeCallbacks.push(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  });
}

describe('deploy command', () => {
  test(
    'base mode "always" copies a changed file with a backup and leaves an unchanged file untouched',
    async () => {
      const configDir = await makeTempDir('agentpm-deploy-config-');
      const destDir = await makeTempDir('agentpm-deploy-dest-');
      const homeDir = await makeTempDir('agentpm-deploy-home-');

      await writeFile(path.join(configDir, 'files', 'changed.txt'), 'new content\n');
      await writeFile(path.join(configDir, 'files', 'unchanged.txt'), 'same content\n');
      await writeFile(path.join(destDir, 'changed.txt'), 'old content\n');
      await writeFile(path.join(destDir, 'unchanged.txt'), 'same content\n');

      const deployYamlPath = path.join(configDir, 'deploy.yaml');
      await writeFile(
        deployYamlPath,
        ['base:', '  - src: ./files', `    dest: ${destDir}`, '    mode: always', ''].join(
          '\n',
        ),
      );

      const service = new AgentPmService({ cwd: configDir, env: { AGENTPM_HOME: homeDir } });
      try {
        const result = await service.deploy({ config: deployYamlPath });

        expect(result.success).toBe(true);
        expect(result.dryRun).toBe(false);
        expect(await fs.readFile(path.join(destDir, 'changed.txt'), 'utf8')).toBe(
          'new content\n',
        );
        expect(await fs.readFile(path.join(destDir, 'unchanged.txt'), 'utf8')).toBe(
          'same content\n',
        );

        expect(
          result.actions.some((a) => a.includes('base backup') && a.includes('changed.txt')),
        ).toBe(true);
        expect(
          result.actions.some(
            (a) => a.includes('base copy') && a.includes('changed.txt') && a.includes('(changed)'),
          ),
        ).toBe(true);
        expect(
          result.actions.some(
            (a) =>
              a.includes('base skip') && a.includes('unchanged.txt') && a.includes('(unchanged)'),
          ),
        ).toBe(true);

        const backupsRoot = path.join(homeDir, 'backups');
        const firstRunBackups = await listAllFiles(backupsRoot);
        expect(firstRunBackups.some((f) => f.endsWith('changed.txt'))).toBe(true);
        expect(firstRunBackups.some((f) => f.endsWith('unchanged.txt'))).toBe(false);
        expect(firstRunBackups).toHaveLength(1);
        const backupRunDirsAfterFirst = (await fs.readdir(backupsRoot)).sort();

        // Second run: source and dest are now identical, so nothing should
        // be copied or backed up again.
        const second = await service.deploy({ config: deployYamlPath });
        expect(
          second.actions.every((a) => !a.includes('base backup') && !a.includes('base copy')),
        ).toBe(true);
        const backupRunDirsAfterSecond = (await fs.readdir(backupsRoot)).sort();
        expect(backupRunDirsAfterSecond).toEqual(backupRunDirsAfterFirst);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'base mode "if-missing" only writes when the destination does not already exist',
    async () => {
      const configDir = await makeTempDir('agentpm-deploy-config-');
      const destDir = await makeTempDir('agentpm-deploy-dest-');
      const homeDir = await makeTempDir('agentpm-deploy-home-');

      await writeFile(path.join(configDir, 'files', 'existing.txt'), 'new\n');
      await writeFile(path.join(configDir, 'files', 'missing.txt'), 'new\n');
      await writeFile(path.join(destDir, 'existing.txt'), 'old\n');

      const deployYamlPath = path.join(configDir, 'deploy.yaml');
      await writeFile(
        deployYamlPath,
        [
          'base:',
          '  - src: ./files',
          `    dest: ${destDir}`,
          '    mode: if-missing',
          '',
        ].join('\n'),
      );

      const service = new AgentPmService({ cwd: configDir, env: { AGENTPM_HOME: homeDir } });
      try {
        const result = await service.deploy({ config: deployYamlPath });

        expect(await fs.readFile(path.join(destDir, 'existing.txt'), 'utf8')).toBe('old\n');
        expect(await fs.readFile(path.join(destDir, 'missing.txt'), 'utf8')).toBe('new\n');
        expect(
          result.actions.some(
            (a) => a.includes('base skip') && a.includes('existing.txt') && a.includes('(exists)'),
          ),
        ).toBe(true);
        expect(
          result.actions.some(
            (a) => a.includes('base copy') && a.includes('missing.txt') && a.includes('(create)'),
          ),
        ).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'instructions concatenate header + sources + footer exactly and stay byte-stable across two runs',
    async () => {
      const configDir = await makeTempDir('agentpm-deploy-config-');
      const destDir = await makeTempDir('agentpm-deploy-dest-');
      const homeDir = await makeTempDir('agentpm-deploy-home-');
      const instructionsDest = path.join(destDir, 'INSTRUCTIONS.md');

      await writeFile(path.join(configDir, 'sources', 'a.md'), 'Line A\n');
      await writeFile(path.join(configDir, 'sources', 'b.md'), 'Line B\n');

      const deployYamlPath = path.join(configDir, 'deploy.yaml');
      await writeFile(
        deployYamlPath,
        [
          'instructions:',
          `  - dest: ${instructionsDest}`,
          '    header: HEADER',
          '    sources:',
          '      - ./sources/a.md',
          '      - ./sources/b.md',
          '    footer: FOOTER',
          '',
        ].join('\n'),
      );

      const service = new AgentPmService({ cwd: configDir, env: { AGENTPM_HOME: homeDir } });
      try {
        const first = await service.deploy({ config: deployYamlPath });
        const expected = 'HEADER\n\nLine A\n\nLine B\n\nFOOTER\n';
        expect(await fs.readFile(instructionsDest, 'utf8')).toBe(expected);
        expect(
          first.actions.some((a) => a.includes('instructions write') && a.includes('(create)')),
        ).toBe(true);

        const second = await service.deploy({ config: deployYamlPath });
        expect(await fs.readFile(instructionsDest, 'utf8')).toBe(expected);
        expect(
          second.actions.some(
            (a) => a.includes('instructions skip') && a.includes('(unchanged)'),
          ),
        ).toBe(true);
        expect(second.actions.every((a) => !a.includes('instructions write'))).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    '--dry-run reports planned actions without touching the filesystem or running pull/export',
    async () => {
      const configDir = await makeTempDir('agentpm-deploy-config-');
      const destDir = await makeTempDir('agentpm-deploy-dest-');
      const homeDir = await makeTempDir('agentpm-deploy-home-');
      const instructionsDest = path.join(destDir, 'INSTRUCTIONS.md');
      const exportDest = path.join(destDir, 'export-plugin');

      await writeFile(path.join(configDir, 'files', 'changed.txt'), 'new content\n');
      await writeFile(path.join(destDir, 'changed.txt'), 'old content\n');
      await writeFile(path.join(configDir, 'sources', 'a.md'), 'Line A\n');

      const deployYamlPath = path.join(configDir, 'deploy.yaml');
      await writeFile(
        deployYamlPath,
        [
          'base:',
          '  - src: ./files',
          `    dest: ${destDir}`,
          '    mode: always',
          'instructions:',
          `  - dest: ${instructionsDest}`,
          '    sources:',
          '      - ./sources/a.md',
          'pull:',
          '  from: does-not-exist-target',
          'export:',
          '  - layout: antigravity',
          `    dest: ${exportDest}`,
          '',
        ].join('\n'),
      );

      const service = new AgentPmService({ cwd: configDir, env: { AGENTPM_HOME: homeDir } });
      try {
        const result = await service.deploy({ config: deployYamlPath, dryRun: true });

        expect(result.dryRun).toBe(true);
        expect(result.success).toBe(true);

        // Nothing on disk changed.
        expect(await fs.readFile(path.join(destDir, 'changed.txt'), 'utf8')).toBe(
          'old content\n',
        );
        expect(await pathExists(instructionsDest)).toBe(false);
        expect(await pathExists(exportDest)).toBe(false);
        expect(await pathExists(path.join(homeDir, 'backups'))).toBe(false);

        expect(result.actions.some((a) => a.startsWith('[dry-run] base copy'))).toBe(true);
        expect(result.actions.some((a) => a.startsWith('[dry-run] instructions write'))).toBe(
          true,
        );
        expect(result.actions.some((a) => a.startsWith('[dry-run] pull planned'))).toBe(true);
        expect(result.actions.some((a) => a.startsWith('[dry-run] export planned'))).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'a consistency mismatch between the library and the checkout aborts the deploy',
    async () => {
      const configDir = await makeTempDir('agentpm-deploy-config-');
      const homeDir = await makeTempDir('agentpm-deploy-home-');
      const checkoutDir = await makeTempDir('agentpm-deploy-checkout-');

      await writeFile(
        path.join(homeDir, 'skills', 'demo', 'SKILL.md'),
        '# demo skill (library)\n',
      );
      await writeFile(
        path.join(checkoutDir, 'skills', 'demo', 'SKILL.md'),
        '# demo skill (stale checkout)\n',
      );

      const deployYamlPath = path.join(configDir, 'deploy.yaml');
      await writeFile(
        deployYamlPath,
        ['consistency:', `  library-vs: ${checkoutDir}`, ''].join('\n'),
      );

      const service = new AgentPmService({ cwd: configDir, env: { AGENTPM_HOME: homeDir } });
      try {
        await expect(service.deploy({ config: deployYamlPath })).rejects.toThrow(
          /Consistency check failed/,
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'a full run pulls skills/agents and exports a layout',
    async () => {
      const configDir = await makeTempDir('agentpm-deploy-config-');
      const homeDir = await makeTempDir('agentpm-deploy-home-');
      const fakeUserHome = await makeTempDir('agentpm-deploy-user-home-');
      const remoteDir = await makeTempDir('agentpm-deploy-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      const seedDir = path.join(remoteDir, 'seed');
      const exportDest = path.join(await makeTempDir('agentpm-deploy-export-'), 'plugin');

      git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
      await writeFile(path.join(seedDir, 'skills', 'demo', 'SKILL.md'), '# demo skill\n');
      await writeFile(path.join(seedDir, 'skills', 'other', 'SKILL.md'), '# other skill\n');
      await writeFile(
        path.join(seedDir, '.claude', 'agents', 'reviewer.md'),
        '---\nname: Reviewer\ndescription: Reviews code changes.\n---\nReview carefully.\n',
      );
      seedAndPushRepo(seedDir, remoteRepo);

      useFakeUserHome(fakeUserHome);

      const deployYamlPath = path.join(configDir, 'deploy.yaml');
      await writeFile(
        deployYamlPath,
        [
          'pull:',
          `  from: ${remoteRepo}`,
          '  target:',
          '    - claude',
          '  transform: codex-agents',
          '  agents: true',
          'export:',
          '  - layout: antigravity',
          `    dest: ${exportDest}`,
          '',
        ].join('\n'),
      );

      const service = new AgentPmService({
        cwd: configDir,
        env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
      });
      try {
        const result = await service.deploy({ config: deployYamlPath });

        expect(result.success).toBe(true);
        expect(
          result.actions.some((a) => a.startsWith('pull:') && a.includes(remoteRepo)),
        ).toBe(true);
        expect(
          result.actions.some((a) => a.startsWith('export:') && a.includes(exportDest)),
        ).toBe(true);

        const demoLink = path.join(fakeUserHome, '.claude', 'skills', 'demo');
        expect((await fs.lstat(demoLink)).isSymbolicLink()).toBe(true);
        const otherLink = path.join(fakeUserHome, '.claude', 'skills', 'other');
        expect((await fs.lstat(otherLink)).isSymbolicLink()).toBe(true);

        const agentFile = path.join(fakeUserHome, '.claude', 'agents', 'reviewer.md');
        expect(await fs.readFile(agentFile, 'utf8')).toContain('Review carefully.');

        const tomlPath = path.join(fakeUserHome, '.codex', 'agents', 'reviewer.toml');
        const toml = await fs.readFile(tomlPath, 'utf8');
        expect(toml).toContain(
          '# generated by agentpm from .claude/agents/reviewer.md - do not edit',
        );
        expect(toml).toContain('name = "reviewer"');

        expect(
          await fs.readFile(
            path.join(exportDest, 'templates', 'skills', 'demo', 'SKILL.md'),
            'utf8',
          ),
        ).toBe('# demo skill\n');
        const exportLink = path.join(exportDest, 'skills', 'demo', 'SKILL.md');
        expect((await fs.lstat(exportLink)).isSymbolicLink()).toBe(true);
        expect(
          await fs.readFile(path.join(exportDest, 'agents', 'reviewer.md'), 'utf8'),
        ).toBe('Review carefully.\n');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'an unknown key in the deploy config is rejected with a validation error naming the key',
    async () => {
      const configDir = await makeTempDir('agentpm-deploy-config-');
      const homeDir = await makeTempDir('agentpm-deploy-home-');

      const deployYamlPath = path.join(configDir, 'deploy.yaml');
      await writeFile(
        deployYamlPath,
        [
          'base:',
          '  - src: ./a',
          '    dest: ./b',
          '    mode: always',
          '    unknownKey: true',
          '',
        ].join('\n'),
      );

      const service = new AgentPmService({ cwd: configDir, env: { AGENTPM_HOME: homeDir } });
      try {
        await expect(service.deploy({ config: deployYamlPath })).rejects.toThrow(
          /Unknown key "unknownKey" in base\[0\]/,
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});
