import { defineConfig } from 'vitest/config';

/**
 * Vitest config scoped to the geneWeave mobile **logic layer** (`src/lib/**`).
 *
 * The pure logic layer is framework-agnostic and runs in Node with no React /
 * React Native / expo present. The nested `src/lib/tsconfig.json` (which does
 * NOT `extends expo/tsconfig.base`) is the nearest tsconfig the esbuild
 * transformer resolves, so transpilation never depends on the on-device
 * `npx expo install` having been run.
 *
 * Run from the repo root:
 *   npx vitest run --config clients/mobile/vitest.config.ts
 */
export default defineConfig({
  root: __dirname,
  test: {
    include: ['src/lib/**/*.test.ts'],
    environment: 'node',
  },
});
