import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run TypeScript source tests, not pre-compiled dist/ artifacts.
    include: ['src/**/*.{test,spec}.ts'],
    // The default 5 s per-test / hook timeout is too tight for this suite's many booted-DB integration tests
    // when it runs under load: up to 4 forks (below) each do heavy SQLite migration + snapshot I/O on a
    // 2-core CI runner, so an I/O-bound test can momentarily exceed 5 s purely from contention (observed as
    // flaky timeouts across unrelated tests, including on `main`). A generous global ceiling keeps those as
    // correctness checks, not races; genuinely-hung tests still fail, just later.
    testTimeout: 20000,
    hookTimeout: 20000,
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
