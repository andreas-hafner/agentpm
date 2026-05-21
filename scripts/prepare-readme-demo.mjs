import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const demoRoot = path.join(repoRoot, '.tmp', 'readme-demo');
const projectDir = path.join(demoRoot, 'proj');
const remoteDir = path.join(demoRoot, 'remote.git');
const homeDir = path.join(demoRoot, 'home');

rmSync(demoRoot, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });

execFileSync('git', ['init', '-b', 'main', projectDir], { stdio: 'ignore' });
execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });

writeFileSync(
  path.join(projectDir, 'agentpm.cmd'),
  ['@echo off', 'node "%~dp0..\\..\\..\\apps\\cli\\dist\\index.js" %*', ''].join(
    '\r\n',
  ),
  'utf8',
);

console.log('Demo workspace ready');
console.log(`project: ${projectDir}`);
console.log(`remote: ${remoteDir}`);
console.log(`home: ${homeDir}`);
