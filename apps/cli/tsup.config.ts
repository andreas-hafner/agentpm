import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  external: ['node:sqlite'],
  noExternal: [/^@agentpm\//],
});
