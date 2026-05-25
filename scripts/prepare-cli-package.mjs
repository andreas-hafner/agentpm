import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRoot = path.join(root, 'apps', 'cli');

await copyFile(path.join(root, 'README.md'), path.join(cliRoot, 'README.md'));
await copyFile(path.join(root, 'LICENSE'), path.join(cliRoot, 'LICENSE'));
