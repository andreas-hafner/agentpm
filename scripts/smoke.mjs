import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliBin = path.join(repoRoot, 'apps', 'cli', 'bin', 'agentpm.js');
const tempRoot = mkdtempSync(path.join(tmpdir(), 'agentpm-smoke-'));
const homeDir = path.join(tempRoot, 'home');
const projectDir = path.join(tempRoot, 'project');
const env = {
  ...process.env,
  AGENTPM_HOME: homeDir,
  NO_COLOR: '1',
};

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `agentpm ${args.join(' ')} failed with exit ${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return result.stdout;
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not include expected text: ${expected}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  execFileSync('git', ['init', '-b', 'main', projectDir], {
    stdio: 'ignore',
  });

  const sourcePath = path.join(tempRoot, 'source');
  cpSync(path.join(repoRoot, 'examples', 'repos', 'codex-sample'), sourcePath, {
    recursive: true,
  });
  execFileSync('git', ['init', '-b', 'main'], {
    cwd: sourcePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'AgentPM Smoke'], {
    cwd: sourcePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'smoke@example.com'], {
    cwd: sourcePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['add', '.'], { cwd: sourcePath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], {
    cwd: sourcePath,
    stdio: 'ignore',
  });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourcePath,
    encoding: 'utf8',
  }).trim();
  const registryPath = path.join(tempRoot, 'registry', 'index.yaml');
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(
    registryPath,
    [
      'version: 1',
      'entries:',
      '  - name: smoke-audio',
      '    description: Smoke test audio skill',
      `    repo: ${JSON.stringify(sourcePath)}`,
      '    ref: main',
      '    path: .codex/skills/audio-mastering',
      '    target: codex',
      '    tags:',
      '      - smoke',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    path.join(projectDir, 'agentpm.yaml'),
    [
      'sources:',
      '  - id: smoke-registry',
      `    locator: ${JSON.stringify(`registry:${registryPath}`)}`,
      'skills:',
      '  - name: smoke-audio-package',
      '    source: smoke-registry',
      '    target: codex',
      '    scope: project',
      '    ref: main',
      `    revision: ${revision}`,
      '    items:',
      '      - smoke-audio',
      '',
    ].join('\n'),
    'utf8',
  );

  const help = run(['--help']);
  assertIncludes(help, 'Project-aware AI skill orchestration', 'help output');

  const inspect = run(['inspect', sourcePath]);
  assertIncludes(inspect, 'Codex skills', 'inspect output');
  assertIncludes(inspect, 'audio-mastering', 'inspect output');
  assertIncludes(inspect, 'Trust', 'inspect output');
  assertIncludes(inspect, 'trusted (100/100)', 'inspect output');

  const sync = run(['sync'], { cwd: projectDir });
  assertIncludes(sync, 'Synced audio-mastering', 'sync output');

  const resolve = JSON.parse(run(['resolve', '--json'], { cwd: projectDir }));
  const projectEntry = resolve.layers.project.find(
    (entry) =>
      entry.name === 'smoke-audio' &&
      entry.sourceRelativePath === '.codex/skills/audio-mastering',
  );
  assert(projectEntry, 'resolve output did not include smoke-audio');
  assert(
    typeof projectEntry.targetPath === 'string' &&
      projectEntry.targetPath.endsWith(
        path.join('.codex', 'skills', 'audio-mastering'),
      ),
    'resolve output did not include the installed target path',
  );

  const exclude = readFileSync(
    path.join(projectDir, '.git', 'info', 'exclude'),
    'utf8',
  );
  assertIncludes(
    exclude,
    '.codex/skills/audio-mastering/',
    'local Git exclude',
  );

  const doctor = run(['doctor'], { cwd: projectDir });
  assertIncludes(doctor, 'Doctor found no issues.', 'doctor output');

  const pushRemotePath = path.join(tempRoot, 'push-remote');
  execFileSync('git', ['init', '--bare', pushRemotePath], { stdio: 'ignore' });

  // Add target to agentpm.yaml
  writeFileSync(
    path.join(projectDir, 'agentpm.yaml'),
    [
      'sources:',
      '  - id: smoke-registry',
      `    locator: ${JSON.stringify(`registry:${registryPath}`)}`,
      'targets:',
      '  - id: smoke-push',
      `    locator: ${JSON.stringify(pushRemotePath)}`,
      '    default: true',
      'skills:',
      '  - name: smoke-audio-package',
      '    source: smoke-registry',
      '    target: codex',
      '    scope: project',
      '    ref: main',
      `    revision: ${revision}`,
      '    items:',
      '      - smoke-audio',
      '',
    ].join('\n'),
    'utf8',
  );

  const push = run(['push', '-m', 'smoke test push'], { cwd: projectDir });
  assertIncludes(push, 'Pushed to', 'push output');
  assertIncludes(push, pushRemotePath, 'push output');

  console.log('Smoke test passed.');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
