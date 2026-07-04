import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run TypeScript source tests, not pre-compiled dist/ artifacts.
    include: ['src/**/*.{test,spec}.ts'],
    // Forks pool serializes file-system writes (geneweave-tasks.json) across workers.
    pool: 'forks',
    poolOptions: {
      forks: { minForks: 1, maxForks: 4 },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // reportsDirectory is resolved relative to the test root (the app directory).
      reportsDirectory: './coverage',
      all: true,
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.e2e.ts',
        'src/docs-html.ts',
        'src/ui-server.ts',
        'src/migrations/**',
        'src/features/**/evals/**',
      ],
      thresholds: {
        // Current baseline with pre-existing test failures excluded.
        // Raise by 2-3 points per quarter as test coverage improves.
        lines: 20,
        functions: 20,
        branches: 10,
        statements: 18,
      },
    },
  },
});
