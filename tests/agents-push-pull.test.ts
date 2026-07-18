import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';
import {
  transformClaudeAgentToCodexToml,
  transformClaudeAgentToKimiSkill,
} from '@agentpm/adapters';

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

describe('agent push', () => {
  test('push --all copies a flat .claude/agents/*.md file alongside a canonical skill', async () => {
    const projectDir = await makeTempDir('agentpm-agents-project-');
    const remoteDir = await makeTempDir('agentpm-agents-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const verifyDir = path.join(remoteDir, 'verify');

    git(remoteDir, 'init', '--bare', remoteRepo);
    await writeFile(
      path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
      '# codex skill\n',
    );
    await writeFile(
      path.join(projectDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: Reviewer\ndescription: Reviews code changes.\n---\nReview carefully.\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: {
        ...GIT_ENV,
        AGENTPM_HOME: await makeTempDir('agentpm-agents-home-'),
      },
    });
    try {
      const result = await service.push({
        target: remoteRepo,
        all: true,
        message: 'push skill and agent',
      });
      expect(result.entries).toEqual(
        expect.arrayContaining(['.claude/agents/reviewer.md', 'skills/skill-a']),
      );

      git(remoteDir, 'clone', remoteRepo, verifyDir);
      expect(
        await fs.readFile(
          path.join(verifyDir, '.claude', 'agents', 'reviewer.md'),
          'utf8',
        ),
      ).toContain('Review carefully.');
      expect(
        await fs.readFile(
          path.join(verifyDir, 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('# codex skill');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('push --all succeeds for an agents-only workspace', async () => {
    const projectDir = await makeTempDir('agentpm-agents-only-project-');
    const remoteDir = await makeTempDir('agentpm-agents-only-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');

    git(remoteDir, 'init', '--bare', remoteRepo);
    await writeFile(
      path.join(projectDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: Reviewer\n---\nReview.\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: {
        ...GIT_ENV,
        AGENTPM_HOME: await makeTempDir('agentpm-agents-only-home-'),
      },
    });
    try {
      const result = await service.push({
        target: remoteRepo,
        all: true,
        message: 'agents only',
      });
      expect(result.entries).toEqual(['.claude/agents/reviewer.md']);
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);
});

describe('agent pull', () => {
  test('pull materializes a flat agent file into the project .claude/agents scope', async () => {
    const homeDir = await makeTempDir('agentpm-agents-home-');
    const projectDir = await makeTempDir('agentpm-agents-project-');
    const remoteDir = await makeTempDir('agentpm-agents-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');

    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, 'skills', 'demo', 'SKILL.md'),
      '# demo skill\n',
    );
    await writeFile(
      path.join(seedDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: Reviewer\ndescription: Reviews code changes.\n---\nReview carefully.\n',
    );
    seedAndPushRepo(seedDir, remoteRepo);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.pull({
        target: remoteRepo,
        agents: ['claude'],
        scope: 'project',
        yes: true,
      });

      expect(result.success).toBe(true);
      expect(result.skills).toEqual(['demo']);
      expect(result.agents).toEqual(['reviewer']);

      const agentFile = path.join(projectDir, '.claude', 'agents', 'reviewer.md');
      expect(await fs.readFile(agentFile, 'utf8')).toContain('Review carefully.');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('pull materializes a flat agent file into the global .claude/agents scope', async () => {
    const homeDir = await makeTempDir('agentpm-agents-home-');
    const envDir = await makeTempDir('agentpm-agents-env-');
    const fakeUserHome = await makeTempDir('agentpm-agents-user-home-');
    const remoteDir = await makeTempDir('agentpm-agents-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;

    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: Reviewer\n---\nReview.\n',
    );
    seedAndPushRepo(seedDir, remoteRepo);

    try {
      process.env.HOME = fakeUserHome;
      process.env.USERPROFILE = fakeUserHome;

      const service = new AgentPmService({
        cwd: envDir,
        env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
      });
      try {
        const result = await service.pull({
          target: remoteRepo,
          yes: true,
        });

        expect(result.success).toBe(true);
        expect(result.skills).toEqual([]);
        expect(result.agents).toEqual(['reviewer']);

        const agentFile = path.join(
          fakeUserHome,
          '.claude',
          'agents',
          'reviewer.md',
        );
        expect(await fs.readFile(agentFile, 'utf8')).toContain('Review.');
      } finally {
        service.close();
      }
    } finally {
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
    }
  }, CI_TEST_TIMEOUT);
});

describe('codex agent transform', () => {
  test('transforms Claude agent frontmatter and body into a Codex TOML profile', () => {
    const markdown = [
      '---',
      'name: Code Reviewer',
      'description: Reviews code changes for quality issues.',
      'effort: medium',
      '---',
      '',
      'You are a meticulous code reviewer.',
      '',
    ].join('\n');

    const result = transformClaudeAgentToCodexToml(markdown);

    expect(result.fileName).toBe('code_reviewer.toml');
    expect(result.toml).toContain(
      '# generated by agentpm from .claude/agents/code_reviewer.md - do not edit',
    );
    expect(result.toml).toContain('name = "code_reviewer"');
    expect(result.toml).toContain(
      'description = "Reviews code changes for quality issues."',
    );
    expect(result.toml).not.toContain('model =');
    expect(result.toml).not.toContain('model_reasoning_effort');
    expect(result.toml).toContain('sandbox_mode = "read-only"');
    expect(result.toml).toContain('developer_instructions = """');
    expect(result.toml).toContain('You are a meticulous code reviewer.');
  });

  test('defaults effort to high and honors an explicit workspace-write sandbox', () => {
    const markdown = ['---', 'name: helper', 'sandbox: workspace-write', '---', 'Body text.'].join(
      '\n',
    );
    const result = transformClaudeAgentToCodexToml(markdown);
    expect(result.toml).not.toContain('model_reasoning_effort');
    expect(result.toml).toContain('sandbox_mode = "workspace-write"');
  });

  test('escapes an embedded triple-quote in the body', () => {
    const markdown = ['---', 'name: helper', '---', 'Body with a """ literal.'].join('\n');
    const result = transformClaudeAgentToCodexToml(markdown);
    expect(result.toml).not.toMatch(/Body with a """ literal/);
    expect(result.toml).toContain('Body with a ""\\" literal.');
  });
});

describe('kimi agent transform', () => {
  test('transforms Claude agent frontmatter and body into a Kimi delegation skill', () => {
    const markdown = [
      '---',
      'name: Code Reviewer',
      'description: Reviews code changes for quality issues.',
      'tools: Read, Grep, Glob, Bash',
      '---',
      '',
      'You are a meticulous code reviewer.',
      '',
    ].join('\n');

    const result = transformClaudeAgentToKimiSkill(markdown);

    expect(result.dirName).toBe('agent-code-reviewer');
    expect(result.skillMd).toContain('name: agent-code-reviewer');
    expect(result.skillMd).toContain(
      'description: "Reviews code changes for quality issues."',
    );
    expect(result.skillMd).toContain(
      '<!-- generated by agentpm from .claude/agents/code-reviewer.md - do not edit -->',
    );
    expect(result.skillMd).toContain('subagent_type: "coder"');
    expect(result.skillMd).toContain('You are a meticulous code reviewer.');
  });

  test('maps a read-only tool set to the explore profile', () => {
    const markdown = [
      '---',
      'name: architect',
      'description: Plans changes.',
      'tools: Read, Grep, Glob',
      '---',
      'Plan carefully.',
    ].join('\n');
    const result = transformClaudeAgentToKimiSkill(markdown);
    expect(result.skillMd).toContain('subagent_type: "explore"');
  });

  test('defaults to coder without a tools field and escapes description quotes', () => {
    const markdown = [
      '---',
      'name: helper',
      `description: 'Says "hello": everyone'`,
      '---',
      'Body text.',
    ].join('\n');
    const result = transformClaudeAgentToKimiSkill(markdown);
    expect(result.skillMd).toContain('subagent_type: "coder"');
    expect(result.skillMd).toContain(
      'description: "Says \\"hello\\": everyone"',
    );
  });

  test('throws without a frontmatter name', () => {
    expect(() =>
      transformClaudeAgentToKimiSkill('---\ndescription: x\n---\nBody.'),
    ).toThrow(/frontmatter "name"/);
  });
});

describe('agent pull with codex-agents transform', () => {
  test('pull --transform codex-agents writes a Codex TOML profile alongside the native copy', async () => {
    const homeDir = await makeTempDir('agentpm-agents-home-');
    const projectDir = await makeTempDir('agentpm-agents-project-');
    const remoteDir = await makeTempDir('agentpm-agents-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');

    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: Reviewer\ndescription: Reviews code changes.\n---\nReview carefully.\n',
    );
    seedAndPushRepo(seedDir, remoteRepo);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.pull({
        target: remoteRepo,
        scope: 'project',
        yes: true,
        transform: 'codex-agents',
      });

      expect(result.agents).toEqual(['reviewer']);

      const tomlPath = path.join(projectDir, '.codex', 'agents', 'reviewer.toml');
      const toml = await fs.readFile(tomlPath, 'utf8');
      expect(toml).toContain(
        '# generated by agentpm from .claude/agents/reviewer.md - do not edit',
      );
      expect(toml).toContain('name = "reviewer"');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('pull --transform codex-agents skips a foreign, non-generated Codex TOML file and warns', async () => {
    const homeDir = await makeTempDir('agentpm-agents-home-');
    const projectDir = await makeTempDir('agentpm-agents-project-');
    const remoteDir = await makeTempDir('agentpm-agents-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');

    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: Reviewer\n---\nReview carefully.\n',
    );
    seedAndPushRepo(seedDir, remoteRepo);

    const foreignTomlPath = path.join(
      projectDir,
      '.codex',
      'agents',
      'reviewer.toml',
    );
    await writeFile(foreignTomlPath, '# hand-written profile\nname = "custom"\n');

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.pull({
        target: remoteRepo,
        scope: 'project',
        yes: true,
        transform: 'codex-agents',
      });

      expect(result.agents).toEqual(['reviewer']);
      expect(
        result.warnings.some(
          (warning) =>
            warning.includes('reviewer.toml') &&
            warning.includes('not generated by AgentPM'),
        ),
      ).toBe(true);
      expect(await fs.readFile(foreignTomlPath, 'utf8')).toBe(
        '# hand-written profile\nname = "custom"\n',
      );

      // The native .claude/agents copy still lands even when the transform is skipped.
      const agentFile = path.join(projectDir, '.claude', 'agents', 'reviewer.md');
      expect(await fs.readFile(agentFile, 'utf8')).toContain('Review carefully.');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);
});

describe('agent pull with kimi-agents transform', () => {
  test('pull with both transforms writes the Codex TOML and the Kimi delegation skill', async () => {
    const homeDir = await makeTempDir('agentpm-agents-home-');
    const projectDir = await makeTempDir('agentpm-agents-project-');
    const remoteDir = await makeTempDir('agentpm-agents-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');

    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: Reviewer\ndescription: Reviews code changes.\n---\nReview carefully.\n',
    );
    seedAndPushRepo(seedDir, remoteRepo);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.pull({
        target: remoteRepo,
        scope: 'project',
        yes: true,
        transform: ['codex-agents', 'kimi-agents'],
      });

      expect(result.agents).toEqual(['reviewer']);

      const toml = await fs.readFile(
        path.join(projectDir, '.codex', 'agents', 'reviewer.toml'),
        'utf8',
      );
      expect(toml).toContain('name = "reviewer"');

      const skillMd = await fs.readFile(
        path.join(projectDir, '.kimi-code', 'skills', 'agent-reviewer', 'SKILL.md'),
        'utf8',
      );
      expect(skillMd).toContain(
        '<!-- generated by agentpm from .claude/agents/reviewer.md - do not edit -->',
      );
      expect(skillMd).toContain('name: agent-reviewer');
      expect(skillMd).toContain('description: "Reviews code changes."');
      expect(skillMd).toContain('Review carefully.');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('pull --transform kimi-agents skips a foreign, non-generated SKILL.md and warns', async () => {
    const homeDir = await makeTempDir('agentpm-agents-home-');
    const projectDir = await makeTempDir('agentpm-agents-project-');
    const remoteDir = await makeTempDir('agentpm-agents-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');

    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: Reviewer\n---\nReview carefully.\n',
    );
    seedAndPushRepo(seedDir, remoteRepo);

    const foreignSkillPath = path.join(
      projectDir,
      '.kimi-code',
      'skills',
      'agent-reviewer',
      'SKILL.md',
    );
    await writeFile(
      foreignSkillPath,
      '---\nname: agent-reviewer\ndescription: hand-written\n---\nMine.\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.pull({
        target: remoteRepo,
        scope: 'project',
        yes: true,
        transform: 'kimi-agents',
      });

      expect(result.agents).toEqual(['reviewer']);
      expect(
        result.warnings.some(
          (warning) =>
            warning.includes('agent-reviewer/SKILL.md') &&
            warning.includes('not generated by AgentPM'),
        ),
      ).toBe(true);
      expect(await fs.readFile(foreignSkillPath, 'utf8')).toContain('Mine.');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);
});
