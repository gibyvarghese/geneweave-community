import { config as dotenvConfig } from 'dotenv';
import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load root .env so API keys are available before provider detection below
dotenvConfig({ path: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../.env') });

const managedPort = Number.parseInt(process.env['PLAYWRIGHT_PORT'] ?? '3510', 10);
const baseURL = process.env['BASE_URL'] ?? `http://127.0.0.1:${managedPort}`;
const managedDbPath = join(tmpdir(), `geneweave-playwright-${process.pid}.db`);
const workspaceDir = fileURLToPath(new URL('.', import.meta.url));
const useManagedServer = !process.env['BASE_URL'];

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: useManagedServer ? {
    command: 'npx tsx ../../deploy/server.ts',
    cwd: workspaceDir,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      PORT: String(managedPort),
      DATABASE_PATH: managedDbPath,
      NODE_ENV: 'test',
      PLAYWRIGHT_E2E: '1',
      GENEWEAVE_AUTH_RATE_WINDOW_MS: '600000',
      GENEWEAVE_REGISTER_IP_LIMIT: '100000',
      GENEWEAVE_REGISTER_EMAIL_LIMIT: '100000',
      GENEWEAVE_LOGIN_IP_LIMIT: '200000',
      GENEWEAVE_LOGIN_EMAIL_LIMIT: '200000',
      GENEWEAVE_LOGIN_MAX_BACKOFF_MS: '0',
      JWT_SECRET: process.env['JWT_SECRET'] ?? 'playwright-e2e-secret',
      DEFAULT_PROVIDER: process.env['DEFAULT_PROVIDER']
        ?? (process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : process.env['OPENAI_API_KEY'] ? 'openai' : 'mock'),
      DEFAULT_MODEL: process.env['DEFAULT_MODEL']
        ?? (process.env['ANTHROPIC_API_KEY'] ? 'claude-sonnet-4-6' : process.env['OPENAI_API_KEY'] ? 'gpt-4o-mini' : 'mock-model'),
    },
  } : undefined,
  projects: [{
    name: 'chromium',
    use: {
      browserName: 'chromium',
      // Fake mic/speaker so getUserMedia succeeds in headless mode
      launchOptions: {
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      },
      permissions: ['microphone'],
    },
  }],
});
