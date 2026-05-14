import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  const sourcePath = path.join(repoRoot, 'examples', 'repos', 'codex-sample');
  writeFileSync(
    path.join(projectDir, 'agentpm.yaml'),
    [
      'sources:',
      `  - ${JSON.stringify(`local:${sourcePath}`)}`,
      'skills:',
      '  - audio-mastering',
      '',
    ].join('\n'),
    'utf8',
  );

  const help = run(['--help']);
  assertIncludes(help, 'Project-aware AI skill orchestration', 'help output');

  const inspect = run(['inspect', sourcePath]);
  assertIncludes(inspect, 'Codex skills', 'inspect output');
  assertIncludes(inspect, 'audio-mastering', 'inspect output');

  const sync = run(['sync'], { cwd: projectDir });
  assertIncludes(sync, 'Synced audio-mastering', 'sync output');

  const resolve = JSON.parse(run(['resolve', '--json'], { cwd: projectDir }));
  const projectEntry = resolve.layers.project.find(
    (entry) => entry.name === 'audio-mastering',
  );
  assert(projectEntry, 'resolve output did not include audio-mastering');
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

  console.log('Smoke test passed.');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
