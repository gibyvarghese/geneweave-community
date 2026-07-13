// SPDX-License-Identifier: MIT
/**
 * geneWeave — server harness for E2E and local runs.
 *
 * `createGeneWeave` (apps/geneweave) is a library entry: it takes a config and starts a server. This harness
 * turns environment variables into that config and boots it, so the Playwright suite (which launches
 * `npx tsx deploy/server.ts` with PORT + DATABASE_PATH + JWT_SECRET + DEFAULT_PROVIDER/MODEL set) runs against
 * a real server on a fresh SQLite database. Providers fall back to the built-in `mock` when no API key is set,
 * so tests that don't need a real model (e.g. the Upgrade Center review queue) run offline.
 */
import { createGeneWeave } from '../apps/geneweave/src/index.js';

const provider = process.env['DEFAULT_PROVIDER']
  ?? (process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : process.env['OPENAI_API_KEY'] ? 'openai' : 'mock');
const apiKey = provider === 'anthropic' ? process.env['ANTHROPIC_API_KEY']
  : provider === 'openai' ? process.env['OPENAI_API_KEY'] : undefined;

const app = await createGeneWeave({
  port: Number(process.env['PORT'] ?? 3510),
  jwtSecret: process.env['JWT_SECRET'] ?? 'geneweave-e2e-secret',
  database: { type: 'sqlite', path: process.env['DATABASE_PATH'] ?? './geneweave.e2e.db' },
  providers: { [provider]: { apiKey: apiKey ?? 'mock-e2e-key' } },
  defaultProvider: provider,
  defaultModel: process.env['DEFAULT_MODEL'] ?? 'mock-model',
});
// eslint-disable-next-line no-console
console.log(`geneWeave server → http://127.0.0.1:${app.port}`);
