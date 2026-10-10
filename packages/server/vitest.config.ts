import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Each test file builds its own isolated database.
    pool: 'forks',
  },
});
