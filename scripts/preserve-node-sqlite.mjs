import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function expand(pattern) {
  if (!pattern.includes('*')) {
    return [pattern];
  }

  const directory = path.dirname(pattern);
  const suffix = path.basename(pattern).replace('*', '');
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(suffix)).map((entry) => path.join(directory, entry));
}

const files = (await Promise.all(process.argv.slice(2).map((pattern) => expand(pattern)))).flat();

await Promise.all(
  files.map(async (file) => {
    let content = await readFile(file, 'utf8');
    const next = content.replaceAll(' from "sqlite"', ' from "node:sqlite"');
    if (next !== content) {
      await writeFile(file, next);
    }
  }),
);
