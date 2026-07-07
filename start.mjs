#!/usr/bin/env node
import 'dotenv/config';
// Run the geneWeave distribution. All configuration comes from environment variables
// (see .env.example). This boots the API + UI server and, on first run, can bootstrap
// a platform admin so you have someone to sign in as.
//
//   node start.mjs
//
import { createGeneWeave, hashPassword } from '@weaveintel/geneweave-api';
import { randomUUID } from 'node:crypto';

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`✗ Missing required env: ${name}`); process.exit(1); }
  return v;
}

const port = Number(process.env.PORT) || 3500;

// Providers: enable whichever API keys are present.
const providers = {};
if (process.env.OPENAI_API_KEY) providers.openai = { apiKey: process.env.OPENAI_API_KEY };
if (process.env.ANTHROPIC_API_KEY) providers.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY };
if (process.env.GOOGLE_API_KEY) providers.google = { apiKey: process.env.GOOGLE_API_KEY };
if (Object.keys(providers).length === 0) {
  console.error('✗ Set at least one provider key: OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY');
  process.exit(1);
}
const defaultProvider = process.env.GENEWEAVE_DEFAULT_PROVIDER || (providers.openai ? 'openai' : providers.anthropic ? 'anthropic' : 'google');
const defaultModel = process.env.GENEWEAVE_DEFAULT_MODEL || (defaultProvider === 'openai' ? 'gpt-4o-mini' : defaultProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'gemini-2.0-flash');

const app = await createGeneWeave({
  port,
  host: process.env.HOST || '127.0.0.1',
  jwtSecret: required('JWT_SECRET'),
  database: process.env.WEAVE_DB === 'postgres'
    ? { type: 'postgres', connectionString: required('DATABASE_URL') }
    : { type: 'sqlite', path: process.env.DB_PATH || process.env.WEAVE_DB_PATH || './geneweave.db' },
  providers,
  defaultProvider,
  defaultModel,
  corsOrigin: process.env.CORS_ORIGIN || undefined,
});

// First-run admin bootstrap (opt-in). Creates a verified platform_admin the first time
// this email is seen, so a fresh deployment has someone who can reach the admin/Builder
// pages. Safe to leave set: it never overwrites an existing user.
const adminEmail = process.env.GENEWEAVE_ADMIN_EMAIL;
const adminPassword = process.env.GENEWEAVE_ADMIN_PASSWORD;
if (adminEmail && adminPassword) {
  const existing = await app.db.getUserByEmail(adminEmail);
  if (!existing) {
    const id = randomUUID();
    await app.db.createUser({
      id, email: adminEmail, name: process.env.GENEWEAVE_ADMIN_NAME || 'Administrator',
      passwordHash: await hashPassword(adminPassword), persona: 'platform_admin',
    });
    await app.db.markUserEmailVerified(id);
    console.log(`✓ bootstrapped platform_admin: ${adminEmail}`);
  }
}

console.log(`\n  geneWeave is running → http://localhost:${port}`);
console.log(`  provider: ${defaultProvider} · model: ${defaultModel}\n`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { try { await app.stop(); } finally { process.exit(0); } });
}
