import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRoot = path.join(root, 'apps', 'cli');

await Promise.all([
  rm(path.join(cliRoot, 'README.md'), { force: true }),
  rm(path.join(cliRoot, 'LICENSE'), { force: true }),
]);
