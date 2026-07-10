import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

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

interface Library {
  homeDir: string;
  fakeUserHome: string;
}

const restoreHomeCallbacks: Array<() => void> = [];

afterEach(() => {
  while (restoreHomeCallbacks.length > 0) {
    restoreHomeCallbacks.pop()?.();
  }
});

/**
 * Pulls two skills and one flat agent into an isolated global scope so each
 * test starts from a populated `~/.agentpm/skills` library and a recorded
 * `claude` agent install, without touching real home state.
 */
async function seedLibrary(): Promise<Library> {
  const homeDir = await makeTempDir('agentpm-export-home-');
  const fakeUserHome = await makeTempDir('agentpm-export-user-home-');
  const remoteDir = await makeTempDir('agentpm-export-remote-');
  const remoteRepo = path.join(remoteDir, 'skills.git');
  const seedDir = path.join(remoteDir, 'seed');

  git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
  await writeFile(
    path.join(seedDir, 'skills', 'demo', 'SKILL.md'),
    '# demo skill\n',
  );
  await writeFile(
    path.join(seedDir, 'skills', 'other', 'SKILL.md'),
    '# other skill\n',
  );
  await writeFile(
    path.join(seedDir, '.claude', 'agents', 'reviewer.md'),
    '---\nname: Reviewer\ndescription: Reviews code changes.\n---\nReview carefully.\n',
  );
  seedAndPushRepo(seedDir, remoteRepo);

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

  const service = new AgentPmService({
    cwd: fakeUserHome,
    env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
  });
  try {
    await service.pull({ target: remoteRepo, scope: 'global', yes: true });
  } finally {
    service.close();
  }

  return { homeDir, fakeUserHome };
}

function exportService(library: Library, extraEnv: NodeJS.ProcessEnv = {}) {
  return new AgentPmService({
    cwd: library.fakeUserHome,
    env: { ...GIT_ENV, AGENTPM_HOME: library.homeDir, ...extraEnv },
  });
}

describe('export antigravity', () => {
  test(
    'full export writes templates, a relative symlink, and a stripped agent',
    async () => {
      const library = await seedLibrary();
      const destDir = path.join(
        await makeTempDir('agentpm-export-dest-'),
        'plugin',
      );

      const service = exportService(library);
      try {
        const result = await service.export({
          layout: 'antigravity',
          dest: destDir,
        });

        expect(result.success).toBe(true);
        expect(result.skills.sort()).toEqual(['demo', 'other']);
        expect(result.agents).toEqual(['reviewer']);
        expect(result.warnings).toEqual([]);

        expect(
          await fs.readFile(
            path.join(destDir, 'templates', 'skills', 'demo', 'SKILL.md'),
            'utf8',
          ),
        ).toBe('# demo skill\n');
        expect(
          await fs.readFile(
            path.join(destDir, 'templates', 'skills', 'other', 'SKILL.md'),
            'utf8',
          ),
        ).toBe('# other skill\n');

        const linkPath = path.join(destDir, 'skills', 'demo', 'SKILL.md');
        const linkStat = await fs.lstat(linkPath);
        expect(linkStat.isSymbolicLink()).toBe(true);
        expect(await fs.readlink(linkPath)).toBe(
          path.join('..', '..', 'templates', 'skills', 'demo', 'SKILL.md'),
        );
        expect(await fs.readFile(linkPath, 'utf8')).toBe('# demo skill\n');

        const agentContent = await fs.readFile(
          path.join(destDir, 'agents', 'reviewer.md'),
          'utf8',
        );
        expect(agentContent).toBe('Review carefully.\n');
        expect(agentContent).not.toContain('---');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'a second export run is idempotent',
    async () => {
      const library = await seedLibrary();
      const destDir = path.join(
        await makeTempDir('agentpm-export-dest-'),
        'plugin',
      );

      const service = exportService(library);
      try {
        const first = await service.export({ layout: 'antigravity', dest: destDir });
        const second = await service.export({ layout: 'antigravity', dest: destDir });

        expect(second.skills.sort()).toEqual(first.skills.sort());
        expect(second.agents).toEqual(first.agents);
        expect(second.warnings).toEqual([]);

        const linkPath = path.join(destDir, 'skills', 'demo', 'SKILL.md');
        const linkStat = await fs.lstat(linkPath);
        expect(linkStat.isSymbolicLink()).toBe(true);
        expect(await fs.readFile(linkPath, 'utf8')).toBe('# demo skill\n');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    '--skills limits the export to the requested skill names',
    async () => {
      const library = await seedLibrary();
      const destDir = path.join(
        await makeTempDir('agentpm-export-dest-'),
        'plugin',
      );

      const service = exportService(library);
      try {
        const result = await service.export({
          layout: 'antigravity',
          dest: destDir,
          skills: ['demo'],
        });

        expect(result.skills).toEqual(['demo']);
        expect(
          await fs
            .access(path.join(destDir, 'templates', 'skills', 'other'))
            .then(
              () => true,
              () => false,
            ),
        ).toBe(false);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'a foreign regular file at skills/<name>/SKILL.md is preserved and warned about',
    async () => {
      const library = await seedLibrary();
      const destDir = path.join(
        await makeTempDir('agentpm-export-dest-'),
        'plugin',
      );
      await writeFile(
        path.join(destDir, 'skills', 'demo', 'SKILL.md'),
        'hand-written content\n',
      );

      const service = exportService(library);
      try {
        const result = await service.export({
          layout: 'antigravity',
          dest: destDir,
          skills: ['demo'],
        });

        expect(result.skills).toEqual(['demo']);
        expect(
          result.warnings.some((warning) =>
            warning.includes('skills/demo/SKILL.md'),
          ),
        ).toBe(true);

        const foreignPath = path.join(destDir, 'skills', 'demo', 'SKILL.md');
        const stat = await fs.lstat(foreignPath);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(await fs.readFile(foreignPath, 'utf8')).toBe(
          'hand-written content\n',
        );

        // The template copy is still written/overwritten freely.
        expect(
          await fs.readFile(
            path.join(destDir, 'templates', 'skills', 'demo', 'SKILL.md'),
            'utf8',
          ),
        ).toBe('# demo skill\n');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    '--install warns and still succeeds when the agy binary is missing from PATH',
    async () => {
      const library = await seedLibrary();
      const destDir = path.join(
        await makeTempDir('agentpm-export-dest-'),
        'plugin',
      );

      const service = exportService(library, { PATH: '' });
      try {
        const result = await service.export({
          layout: 'antigravity',
          dest: destDir,
          install: true,
        });

        expect(result.success).toBe(true);
        expect(
          result.warnings.some(
            (warning) =>
              warning.includes('agy') && warning.includes('PATH'),
          ),
        ).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
  test(
    'falls back to a plain copy when symlinks are not permitted (EPERM)',
    async () => {
      const library = await seedLibrary();
      const destDir = path.join(
        await makeTempDir('agentpm-export-dest-'),
        'plugin',
      );

      const eperm = Object.assign(new Error('EPERM: operation not permitted'), {
        code: 'EPERM',
      });
      const symlinkSpy = vi.spyOn(fs, 'symlink').mockRejectedValue(eperm);

      const service = exportService(library);
      try {
        const result = await service.export({
          layout: 'antigravity',
          dest: destDir,
          skills: ['demo'],
        });

        expect(result.skills).toEqual(['demo']);
        expect(
          result.warnings.some((warning) => warning.includes('as a copy')),
        ).toBe(true);

        const filePath = path.join(destDir, 'skills', 'demo', 'SKILL.md');
        const stat = await fs.lstat(filePath);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(await fs.readFile(filePath, 'utf8')).toBe('# demo skill\n');
      } finally {
        symlinkSpy.mockRestore();
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'refreshes a stale copy-fallback file on re-export instead of warning',
    async () => {
      const library = await seedLibrary();
      const destDir = path.join(
        await makeTempDir('agentpm-export-dest-'),
        'plugin',
      );

      const eperm = Object.assign(new Error('EPERM: operation not permitted'), {
        code: 'EPERM',
      });
      const symlinkSpy = vi.spyOn(fs, 'symlink').mockRejectedValue(eperm);
      const firstService = exportService(library);
      try {
        await firstService.export({
          layout: 'antigravity',
          dest: destDir,
          skills: ['demo'],
        });
      } finally {
        symlinkSpy.mockRestore();
        firstService.close();
      }

      // The library skill evolves after the copy-fallback export.
      await fs.writeFile(
        path.join(library.homeDir, 'skills', 'demo', 'SKILL.md'),
        '# demo skill v2\n',
        'utf8',
      );

      const service = exportService(library);
      try {
        const result = await service.export({
          layout: 'antigravity',
          dest: destDir,
          skills: ['demo'],
        });

        expect(result.skills).toEqual(['demo']);
        expect(
          result.warnings.some((warning) => warning.includes('foreign')),
        ).toBe(false);
        expect(
          await fs.readFile(
            path.join(destDir, 'skills', 'demo', 'SKILL.md'),
            'utf8',
          ),
        ).toBe('# demo skill v2\n');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});

