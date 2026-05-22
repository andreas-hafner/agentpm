import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    pool: 'forks',
    testTimeout: process.env.CI ? 30_000 : 15_000,
    hookTimeout: process.env.CI ? 30_000 : 15_000,
  }
});

