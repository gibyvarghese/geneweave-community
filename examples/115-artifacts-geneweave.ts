/**
 * Example 115 — Phase 3: geneWeave Artifact Persistence, Admin API & Versioning
 *
 * This example demonstrates the full Phase 3 artifact stack in geneWeave:
 *
 *   1. SQLite persistence (m77 tables) via the DatabaseAdapter
 *   2. emit_artifact tool wired through weaveAgent (fake model, no API key)
 *   3. Admin API routes: list, get, version history, download, delete
 *   4. Artifact versioning: updateArtifact creates version records
 *   5. Retention / expiry: expireArtifacts removes past-retention artifacts
 *   6. Tenant artifact type settings: per-tenant type allowlists and emit toggle
 *   7. (Optional) Live LLM demo — set OPENAI_API_KEY or ANTHROPIC_API_KEY
 *
 * Runs without any API keys (Sections 1–6 use a fake model + temp SQLite DB).
 * Section 7 is skipped unless a live key is detected.
 *
 * Packages used:
 *   @weaveintel/geneweave-api — SQLiteAdapter, createToolRegistry
 *   @weaveintel/agents    — weaveAgent
 *   @weaveintel/core      — weaveContext
 *   @weaveintel/testing   — weaveFakeModel
 *   @weaveintel/artifacts — inferMimeType
 *   node:http             — minimal HTTP server for admin API tests
 *
 * Run: npx tsx examples/115-artifacts-geneweave.ts
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { SQLiteAdapter, createToolRegistry } from '@weaveintel/geneweave-api';
import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import { weaveFakeModel } from '@weaveintel/testing';
import { inferMimeType } from '@weaveintel/artifacts';

/* ─── Section header helpers ─────────────────────────────────────────────── */

function header(title: string): void {
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(68));
}
function ok(msg: string):   void { console.log(`  ✓ ${msg}`); }
function info(msg: string): void { console.log(`  ℹ ${msg}`); }
function fail(msg: string): void { console.log(`  ✗ ${msg}`); process.exitCode = 1; }

/* ─── Shared temp DB ─────────────────────────────────────────────────────── */

function makeTempDbPath(): string {
  return join(tmpdir(), `gw-example-115-${Date.now()}.db`);
}

/* ─── Minimal admin-route HTTP server ────────────────────────────────────── */

async function startAdminServer(db: SQLiteAdapter): Promise<{ url: string; close: () => Promise<void> }> {
  const { Router, json: jsonHelper, readBody: readBodyHelper } = await import('../apps/geneweave/src/server-core.js');
  const { registerArtifactRoutes } = await import('../apps/geneweave/src/admin/api/artifacts.js');

  const router = new Router();
  registerArtifactRoutes(router, db as Parameters<typeof registerArtifactRoutes>[1], {
    json: jsonHelper,
    readBody: readBodyHelper,
    requireDetailedDescription: () => null,
  });

  const fakeAuth = {
    userId: 'example-admin', email: 'admin@example.local',
    sessionId: 'example-sess', csrfToken: 'token', persona: 'platform_admin', tenantId: null,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const matched = router.match(req.method ?? 'GET', url.pathname);
    if (!matched) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
    void matched.route.handler(req, res, matched.params, fakeAuth as Parameters<Parameters<typeof router.get>[1]>[3]);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((res, rej) => server.close(err => err ? rej(err) : res())),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 1 — SQLite persistence via DatabaseAdapter (m77 tables)
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateSQLitePersistence(): Promise<void> {
  header('1. SQLite Persistence (m77: artifacts + artifact_versions)');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  // saveArtifact writes to the 'artifacts' table and auto-creates a version-1 record.
  const row = await db.saveArtifact!({
    name: 'q3-analysis.json',
    type: 'json',
    mimeType: inferMimeType('json'),
    data: { quarter: 'Q3', revenue: 1_200_000, growth: 0.12 },
    sessionId: 'chat-001',
    userId: 'alice',
    agentId: 'analyst-agent',
    scope: 'session',
    tags: ['finance', 'q3', 'analysis'],
    metadata: { generatedBy: 'weaveAgent', confidence: 0.95 },
  });

  info(`Saved artifact id:      ${row.id}`);
  info(`Artifact name:          ${row.name}`);
  info(`Artifact type:          ${row.type}`);
  info(`Artifact version:       ${row.version}`);
  info(`Artifact session_id:    ${row.session_id}`);
  if (!row.id)          throw new Error('Expected non-empty id');
  if (row.version !== 1) throw new Error(`Expected version=1, got ${row.version}`);
  ok('saveArtifact() wrote to artifacts table with version=1');

  // Version record is created automatically by saveArtifact.
  const versions = await db.getArtifactVersions!(row.id);
  info(`\nVersion records after save: ${versions.length}`);
  if (versions.length !== 1 || versions[0]?.version !== 1) throw new Error('Expected 1 version record');
  ok('auto-created artifact_versions row for version 1');

  // listArtifacts with filters
  await db.saveArtifact!({ name: 'q3-code.py', type: 'code', mimeType: 'text/x-python', data: 'import pandas', userId: 'alice', scope: 'session' });
  const aliceArts = await db.listArtifacts!({ userId: 'alice' });
  info(`\nlistArtifacts({userId:'alice'}) → ${aliceArts.length} artifacts`);
  if (aliceArts.length < 2) throw new Error('Expected ≥2 artifacts for alice');
  ok('listArtifacts() filters by userId');

  const jsonOnly = await db.listArtifacts!({ type: 'json' });
  info(`listArtifacts({type:'json'}) → ${jsonOnly.length} artifacts`);
  if (!jsonOnly.every(a => a.type === 'json')) throw new Error('Expected only json type');
  ok('listArtifacts() filters by type');

  await db.close();
  try { rmSync(dbPath); } catch { /* ignore */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 2 — emit_artifact tool wired through weaveAgent (fake model)
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateEmitArtifactTool(): Promise<void> {
  header('2. emit_artifact Tool through weaveAgent (fake model)');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  // The fake model drives the agent to call emit_artifact with known arguments.
  const model = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'tc-001',
            function: {
              name: 'emit_artifact',
              arguments: JSON.stringify({
                name: 'market-analysis.md',
                type: 'markdown',
                data: '# Market Analysis\n\n## Summary\nQ3 2026 shows strong growth across all segments.\n\n## Key Metrics\n- Revenue: +12%\n- New users: +8,400\n- Churn: 2.1%',
                tags: ['analysis', 'q3', 'market'],
              }),
            },
          },
        ],
      },
      { content: 'The market analysis artifact has been saved.' },
    ],
  });

  // createToolRegistry with artifactSave wires emit_artifact to the DB.
  const registry = await createToolRegistry(['emit_artifact'], [], {
    actorPersona: 'tenant_user',
    artifactSave: async (input) => {
      const row = await db.saveArtifact!({ ...input, userId: 'demo-agent-user', sessionId: 'chat-demo-01' });
      return { id: row.id, version: row.version };
    },
  });

  const agent = weaveAgent({ model, tools: registry, name: 'analyst-agent', maxSteps: 5 });
  const result = await agent.run(weaveContext({ userId: 'demo-agent-user' }), {
    messages: [{ role: 'user', content: 'Generate a Q3 market analysis report.' }],
  });

  info(`Agent status: ${result.status}`);
  if (result.status !== 'completed') throw new Error(`Expected completed, got ${result.status}`);
  ok('weaveAgent ran to completion');

  const artifacts = await db.listArtifacts!({ userId: 'demo-agent-user' });
  info(`\nArtifacts saved by agent: ${artifacts.length}`);
  if (artifacts.length !== 1) throw new Error(`Expected 1 artifact, got ${artifacts.length}`);

  const art = artifacts[0]!;
  info(`  name:      ${art.name}`);
  info(`  type:      ${art.type}`);
  info(`  mime_type: ${art.mime_type}`);
  info(`  session:   ${art.session_id}`);
  info(`  size:      ${art.size_bytes} bytes`);

  if (art.type !== 'markdown') throw new Error(`Expected markdown, got ${art.type}`);
  if (art.mime_type !== 'text/markdown') throw new Error(`Expected text/markdown, got ${art.mime_type}`);
  if (art.session_id !== 'chat-demo-01') throw new Error('session_id mismatch');
  ok('emit_artifact stored artifact with correct type, MIME type, and session_id');

  // Tags are stored as JSON in the tags column
  const tags = JSON.parse(art.tags ?? '[]') as string[];
  if (!tags.includes('q3')) throw new Error('Expected tag "q3" in stored artifact');
  ok(`Tags stored: [${tags.join(', ')}]`);

  await db.close();
  try { rmSync(dbPath); } catch { /* ignore */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 3 — Admin API routes: list, get, versions, download, delete
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateAdminAPI(): Promise<void> {
  header('3. Admin API Routes (/api/admin/artifacts)');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  const { url, close } = await startAdminServer(db);
  info(`Admin server listening at ${url}`);

  // Seed some artifacts
  const md = await db.saveArtifact!({ name: 'report.md', type: 'markdown', mimeType: 'text/markdown', data: '# Report\nAll metrics look good.', scope: 'session', userId: 'api-user', sessionId: 'sess-api-001' });
  const csv = await db.saveArtifact!({ name: 'data.csv', type: 'csv', mimeType: 'text/csv', data: 'col1,col2\n1,2\n3,4', scope: 'session', userId: 'api-user', sessionId: 'sess-api-001' });
  const jsonArt = await db.saveArtifact!({ name: 'config.json', type: 'json', mimeType: 'application/json', data: '{"version":3}', scope: 'user', userId: 'api-user' });

  // --- 3a. GET /api/admin/artifacts — list all -------------------------
  const listRes = await fetch(`${url}/api/admin/artifacts`);
  if (listRes.status !== 200) throw new Error(`Expected 200, got ${listRes.status}`);
  const listBody = await listRes.json() as { artifacts: unknown[]; total: number; limit: number };
  info(`\nGET /api/admin/artifacts → ${listBody.artifacts.length} artifacts`);
  if (listBody.artifacts.length < 3) throw new Error('Expected ≥3 artifacts');
  ok('List endpoint returns all saved artifacts');

  // --- 3b. GET /api/admin/artifacts?type=csv — filter by type ---------
  const csvRes = await fetch(`${url}/api/admin/artifacts?type=csv`);
  const csvBody = await csvRes.json() as { artifacts: Array<{ type: string }> };
  info(`GET /api/admin/artifacts?type=csv → ${csvBody.artifacts.length} artifacts`);
  if (!csvBody.artifacts.every(a => a.type === 'csv')) throw new Error('Filter by type failed');
  ok('Type filter returns only csv artifacts');

  // --- 3c. GET /api/admin/artifacts/:id — single artifact -------------
  const getRes = await fetch(`${url}/api/admin/artifacts/${md.id}`);
  if (getRes.status !== 200) throw new Error(`Expected 200, got ${getRes.status}`);
  const getBody = await getRes.json() as { artifact: { id: string; name: string; session_id: string } };
  info(`\nGET /api/admin/artifacts/${md.id.slice(0,8)}… → name="${getBody.artifact.name}"`);
  if (getBody.artifact.id !== md.id) throw new Error('ID mismatch');
  if (getBody.artifact.session_id !== 'sess-api-001') throw new Error('session_id mismatch');
  ok('Single artifact endpoint returns correct fields including session_id');

  // --- 3d. GET /api/admin/artifacts/:id — 404 for unknown -------------
  const notFoundRes = await fetch(`${url}/api/admin/artifacts/does-not-exist`);
  info(`GET /api/admin/artifacts/does-not-exist → ${notFoundRes.status}`);
  if (notFoundRes.status !== 404) throw new Error(`Expected 404, got ${notFoundRes.status}`);
  ok('Unknown artifact returns 404');

  // --- 3e. GET /api/admin/artifacts/:id/download — raw content --------
  const dlRes = await fetch(`${url}/api/admin/artifacts/${md.id}/download`);
  if (dlRes.status !== 200) throw new Error(`Download failed: ${dlRes.status}`);
  const disposition = dlRes.headers.get('content-disposition') ?? '';
  const contentType = dlRes.headers.get('content-type') ?? '';
  const dlText = await dlRes.text();
  info(`\nGET /api/admin/artifacts/${md.id.slice(0,8)}…/download`);
  info(`  Content-Type:        ${contentType}`);
  info(`  Content-Disposition: ${disposition}`);
  info(`  Body (first 60):     ${dlText.slice(0, 60)}`);
  if (!contentType.includes('text/markdown')) throw new Error(`Wrong Content-Type: ${contentType}`);
  if (!disposition.includes('attachment')) throw new Error('Missing "attachment" in Content-Disposition');
  if (!disposition.includes('.md')) throw new Error('Expected .md extension in Content-Disposition');
  if (!dlText.includes('# Report')) throw new Error('Download body missing artifact content');
  ok('Download endpoint returns raw content with correct headers');

  // --- 3f. DELETE /api/admin/artifacts/:id ----------------------------
  const delRes = await fetch(`${url}/api/admin/artifacts/${csv.id}`, { method: 'DELETE' });
  if (delRes.status !== 200) throw new Error(`Delete failed: ${delRes.status}`);
  const delBody = await delRes.json() as { ok: boolean };
  info(`\nDELETE /api/admin/artifacts/${csv.id.slice(0,8)}… → ok=${delBody.ok}`);
  if (!delBody.ok) throw new Error('Delete returned ok=false');
  // Verify it's gone
  const afterDel = await fetch(`${url}/api/admin/artifacts/${csv.id}`);
  if (afterDel.status !== 404) throw new Error('Expected 404 after delete');
  ok('Delete removes artifact; subsequent GET returns 404');

  // Remaining artifacts: md (kept), json (kept), csv (deleted)
  const remaining = await db.listArtifacts!({});
  info(`\nRemaining artifacts after delete: ${remaining.length} (expected ≥2)`);
  if (remaining.some(a => a.id === csv.id)) throw new Error('Deleted artifact still in DB');
  ok(`${remaining.length} artifacts remain; deleted artifact is gone from DB`);

  await close();
  await db.close();
  try { rmSync(dbPath); } catch { /* ignore */ }
  void jsonArt;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 4 — Artifact versioning: updateArtifact + version history API
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateVersioning(): Promise<void> {
  header('4. Artifact Versioning (updateArtifact + /versions/:n)');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  const { url, close } = await startAdminServer(db);

  // Create v1
  const row = await db.saveArtifact!({
    name: 'architecture.mmd',
    type: 'mermaid',
    mimeType: 'text/x-mermaid',
    data: 'graph TD\n  Client-->API',
    scope: 'session',
    userId: 'ver-user',
  });
  info(`Created v1: id=${row.id.slice(0,8)}…, version=${row.version}`);
  if (row.version !== 1) throw new Error('Expected v1');
  ok('saveArtifact() creates artifact at version=1');

  // Update to v2
  const v2 = await db.updateArtifact!(row.id, { data: 'graph TD\n  Client-->API\n  API-->DB' }, 'Added DB node');
  info(`Updated to v2: version=${v2.version}`);
  if (v2.version !== 2) throw new Error('Expected v2');
  ok('updateArtifact() increments version to 2');

  // Update to v3
  const v3 = await db.updateArtifact!(row.id, { data: 'graph TD\n  Client-->API\n  API-->DB\n  API-->Cache' }, 'Added Cache node');
  if (v3.version !== 3) throw new Error('Expected v3');
  ok('updateArtifact() increments version to 3');

  // Version history via admin API
  const versRes = await fetch(`${url}/api/admin/artifacts/${row.id}/versions`);
  const versBody = await versRes.json() as { versions: Array<{ version: number; changelog: string | null }> };
  info(`\n/api/admin/artifacts/:id/versions → ${versBody.versions.length} versions`);
  versBody.versions.forEach(v => info(`  v${v.version}: changelog="${v.changelog}"`));
  if (versBody.versions.length !== 3) throw new Error(`Expected 3 versions, got ${versBody.versions.length}`);
  if (versBody.versions[1]?.changelog !== 'Added DB node') throw new Error('Changelog mismatch');
  ok('Admin versions endpoint returns all 3 versions with changelogs');

  // Retrieve specific version
  const v1Res = await fetch(`${url}/api/admin/artifacts/${row.id}/versions/1`);
  const v1Body = await v1Res.json() as { version: { version: number } };
  info(`\n/versions/1 → version=${v1Body.version.version}`);
  if (v1Body.version.version !== 1) throw new Error('Wrong version number');
  ok('Admin /versions/:n returns specific version record');

  // Latest artifact shows version=3
  const latestRes = await fetch(`${url}/api/admin/artifacts/${row.id}`);
  const latestBody = await latestRes.json() as { artifact: { version: number } };
  info(`Latest artifact version: ${latestBody.artifact.version} (expected 3)`);
  if (latestBody.artifact.version !== 3) throw new Error('Expected latest to be v3');
  ok('Admin artifact endpoint shows latest version (v3) after two updates');

  await close();
  await db.close();
  try { rmSync(dbPath); } catch { /* ignore */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 5 — Retention: expireArtifacts() removes past-retention artifacts
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateRetention(): Promise<void> {
  header('5. Artifact Retention (expireArtifacts)');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  // Create a policy with 7-day retention
  db.rawDb.prepare(`
    INSERT INTO artifact_policies (id, name, max_size_bytes, retention_days, require_versioning, enabled)
    VALUES ('retention-demo-policy', '7-day-retention', 10000000, 7, 0, 1)
  `).run();

  // Insert an artifact that is 10 days old (past retention)
  const oldId = `old-art-${Date.now()}`;
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  db.rawDb.prepare(`
    INSERT INTO artifacts (id, name, type, mime_type, data_text, size_bytes, version, scope, policy_id, created_at)
    VALUES (?, 'old-report', 'report', 'text/html', '<p>old</p>', 10, 1, 'session', 'retention-demo-policy', ?)
  `).run(oldId, tenDaysAgo);
  info(`Inserted artifact with created_at=${tenDaysAgo} (10 days ago)`);

  // Insert a fresh artifact with the same policy (should NOT be expired)
  const freshRow = await db.saveArtifact!({ name: 'fresh-report', type: 'report', mimeType: 'text/html', data: '<p>fresh</p>', policyId: 'retention-demo-policy', scope: 'session' });
  info(`Inserted fresh artifact id=${freshRow.id.slice(0,8)}…`);

  // Insert an artifact with no policy (no retention rule → never expires)
  const noPolicyRow = await db.saveArtifact!({ name: 'permanent', type: 'text', mimeType: 'text/plain', data: 'stays forever', scope: 'session' });

  // Run expireArtifacts — should remove only the 10-day-old one
  const deletedCount = await db.expireArtifacts!();
  info(`\nexpireArtifacts() deleted: ${deletedCount} artifact(s)`);
  if (deletedCount < 1) throw new Error('Expected ≥1 artifact to be expired');
  ok(`expireArtifacts() removed ${deletedCount} past-retention artifact(s)`);

  // Old artifact should be gone
  const oldRow = await db.getArtifact!(oldId);
  if (oldRow !== null) throw new Error('Expected old artifact to be deleted');
  ok('10-day-old artifact is gone from DB');

  // Fresh artifact should remain
  const freshStillExists = await db.getArtifact!(freshRow.id);
  if (!freshStillExists) throw new Error('Expected fresh artifact to still exist');
  ok('Fresh artifact is unaffected by expiry run');

  // No-policy artifact should remain
  const noPolicyStillExists = await db.getArtifact!(noPolicyRow.id);
  if (!noPolicyStillExists) throw new Error('Expected no-policy artifact to still exist');
  ok('Artifact without a policy is never expired');

  await db.close();
  try { rmSync(dbPath); } catch { /* ignore */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 6 — Tenant artifact type settings (emit_enabled, allowed_types)
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateTenantSettings(): Promise<void> {
  header('6. Tenant Artifact Settings (m78: per-tenant type allowlists)');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  // Access the extended DB methods via unknown cast (m78 methods)
  type DbEx = typeof db & {
    upsertTenantArtifactSettings: (tenantId: string, fields: Record<string, unknown>) => Promise<{ tenant_id: string; allowed_types: string | null; emit_enabled: number }>;
    getEffectiveTenantArtifactSettings: (tenantId: string) => Promise<{ tenant_id: string; allowed_types: string | null; emit_enabled: number } | null>;
  };
  const dbEx = db as unknown as DbEx;

  // --- 6a. Default row seeded by migration -----------------------------
  const defaults = await dbEx.getEffectiveTenantArtifactSettings('any-tenant');
  info(`Default row (fallback):  tenant_id="${defaults?.tenant_id}", emit_enabled=${defaults?.emit_enabled}`);
  if (!defaults) throw new Error('Expected default row from migration');
  if (defaults.tenant_id !== 'default') throw new Error('Expected tenant_id="default"');
  ok('m78 migration seeds a "default" row; unknown tenant falls back to it');

  // --- 6b. Tenant-specific row overrides default -----------------------
  await dbEx.upsertTenantArtifactSettings('enterprise-tenant', {
    allowed_types: JSON.stringify(['text', 'json', 'csv', 'markdown', 'report']),
    emit_enabled: 1,
    max_size_bytes: 5 * 1024 * 1024, // 5 MB
  });
  const tenantSettings = await dbEx.getEffectiveTenantArtifactSettings('enterprise-tenant');
  const allowedTypes = JSON.parse(tenantSettings?.allowed_types ?? '[]') as string[];
  info(`\nenterprise-tenant allowed_types: [${allowedTypes.join(', ')}]`);
  if (!allowedTypes.includes('json')) throw new Error('Expected json in allowed_types');
  if (allowedTypes.includes('react')) throw new Error('Expected react NOT in allowed_types');
  ok('Tenant-specific allowed_types restricts artifact types');

  // --- 6c. emit_artifact blocked by type policy (via tool) -------------
  const blockedRegistry = await createToolRegistry(['emit_artifact'], [], {
    actorPersona: 'tenant_user',
    artifactSave: async (input) => {
      const row = await db.saveArtifact!(input);
      return { id: row.id, version: row.version };
    },
    resolvedArtifactSettings: {
      allowed_types: allowedTypes,
      max_size_bytes: 5 * 1024 * 1024,
      emit_enabled: true,
      preview_enabled: true,
      sandbox_html: true,
    },
  });
  const tool = blockedRegistry.get('emit_artifact')!;
  const ctx = { userId: 'ent-user', chatId: 'chat-001' } as unknown as Parameters<typeof tool.invoke>[0];

  // HTML is NOT in allowed_types — should be blocked
  const htmlResult = await tool.invoke(ctx, { name: 'emit_artifact', arguments: { name: 'blocked.html', type: 'html', data: '<html/>' } });
  const htmlParsed = JSON.parse(typeof htmlResult === 'string' ? htmlResult : (htmlResult as { content: string }).content);
  info(`\nemit_artifact(type='html') → ok=${htmlParsed.ok}, error="${htmlParsed.error}"`);
  if (htmlParsed.ok) throw new Error('Expected html to be blocked');
  ok('HTML artifact blocked by enterprise tenant\'s allowlist');

  // JSON is in allowed_types — should succeed
  const jsonResult = await tool.invoke(ctx, { name: 'emit_artifact', arguments: { name: 'allowed.json', type: 'json', data: '{"status":"ok"}' } });
  const jsonParsed = JSON.parse(typeof jsonResult === 'string' ? jsonResult : (jsonResult as { content: string }).content);
  info(`emit_artifact(type='json') → ok=${jsonParsed.ok}, id=${jsonParsed.artifactId?.slice(0,8)}…`);
  if (!jsonParsed.ok) throw new Error(`Expected json to be allowed, got: ${jsonParsed.error}`);
  ok('JSON artifact allowed by enterprise tenant\'s allowlist');

  // --- 6d. emit_enabled=false blocks all types -------------------------
  const disabledRegistry = await createToolRegistry(['emit_artifact'], [], {
    actorPersona: 'tenant_user',
    artifactSave: async (input) => {
      const row = await db.saveArtifact!(input);
      return { id: row.id, version: row.version };
    },
    resolvedArtifactSettings: {
      allowed_types: null,
      max_size_bytes: null,
      emit_enabled: false,   // ← all emission disabled
      preview_enabled: false,
      sandbox_html: false,
    },
  });
  const disabledTool = disabledRegistry.get('emit_artifact')!;
  const disabledResult = await disabledTool.invoke(ctx, { name: 'emit_artifact', arguments: { name: 'any.txt', type: 'text', data: 'hello' } });
  const disabledParsed = JSON.parse(typeof disabledResult === 'string' ? disabledResult : (disabledResult as { content: string }).content);
  info(`\nemit_artifact(emit_enabled=false) → ok=${disabledParsed.ok}, error="${disabledParsed.error}"`);
  if (disabledParsed.ok) throw new Error('Expected emission to be blocked');
  ok('emit_enabled=false blocks all artifact types regardless of type allowlist');

  await db.close();
  try { rmSync(dbPath); } catch { /* ignore */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 7 — (Optional) Live LLM: real agent emits Phase 3 artifacts
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateLiveLLM(): Promise<void> {
  header('7. Live LLM Demo (Phase 3 agent emits multiple artifact types)');

  const OPENAI_KEY = process.env['OPENAI_API_KEY'];
  const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];

  if (!OPENAI_KEY && !ANTHROPIC_KEY) {
    console.log('  ⚠ Skipping — set OPENAI_API_KEY or ANTHROPIC_API_KEY to run this section.');
    return;
  }

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  const { url, close } = await startAdminServer(db);

  let model: Awaited<ReturnType<typeof import('@weaveintel/provider-openai').weaveOpenAIModel>>;
  if (OPENAI_KEY) {
    const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
    model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY });
    info('Using OpenAI gpt-4o-mini');
  } else {
    const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');
    model = weaveAnthropicModel('claude-haiku-4-5-20251001', { apiKey: ANTHROPIC_KEY! }) as typeof model;
    info('Using Anthropic claude-haiku-4-5');
  }

  const registry = await createToolRegistry(['emit_artifact'], [], {
    actorPersona: 'tenant_user',
    artifactSave: async (input) => {
      const row = await db.saveArtifact!({ ...input, userId: 'live-demo-user', sessionId: 'live-sess-001' });
      return { id: row.id, version: row.version };
    },
  });

  const agent = weaveAgent({ model, tools: registry, name: 'live-demo-agent', maxSteps: 12 });
  const prompt = `You are an AI assistant. Please use the emit_artifact tool to create the following 3 artifacts — call the tool once per artifact:

1. A markdown artifact named "project-status" with content:
   "# Project Status\n## Phase 3\n- [x] DB tables\n- [x] Admin API\n- [x] Tests"

2. A csv artifact named "team-scores" with content:
   "engineer,score,phase\nAlice,98,3\nBob,92,3\nCarol,95,3"

3. A mermaid artifact named "phase3-flow" with content:
   "graph TD\n  A[emit_artifact] --> B[SQLite m77]\n  B --> C[Admin API]\n  C --> D[Download]"

After saving all 3, respond with: "All 3 Phase 3 artifacts saved successfully."`;

  info('\nRunning live agent…');
  const startTime = Date.now();
  const result = await agent.run(weaveContext({ userId: 'live-demo-user' }), {
    messages: [{ role: 'user', content: prompt }],
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  info(`Agent completed in ${elapsed}s — status: ${result.status}`);
  if (result.status !== 'completed') throw new Error(`Expected completed, got ${result.status}`);

  // Admin API should see all artifacts
  const listRes = await fetch(`${url}/api/admin/artifacts`);
  const listBody = await listRes.json() as { artifacts: Array<{ name: string; type: string; size_bytes: number }> };
  info(`\nAdmin API list → ${listBody.artifacts.length} artifact(s)`);
  listBody.artifacts.forEach(a => info(`  ${a.type.padEnd(12)} ${a.name} (${a.size_bytes}B)`));

  if (listBody.artifacts.length < 2) throw new Error('Expected ≥2 artifacts from live agent');
  ok(`Live agent emitted ${listBody.artifacts.length} artifact(s) — all visible via admin API`);

  // Download one to verify content
  const mdArt = listBody.artifacts.find(a => a.type === 'markdown');
  if (mdArt) {
    const dlRes = await fetch(`${url}/api/admin/artifacts/${(mdArt as unknown as { id: string }).id}/download`);
    const dlText = await dlRes.text();
    info(`\nDownloaded "${mdArt.name}": ${dlText.slice(0, 120).replace(/\n/g, ' ')}`);
    ok('Download endpoint returns live agent artifact content');
  }

  await close();
  await db.close();
  try { rmSync(dbPath); } catch { /* ignore */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════════════════ */

async function main(): Promise<void> {
  console.log('\n@weaveintel/geneweave-api — Example 115');
  console.log('Phase 3: Artifact Persistence, Admin API & Versioning');

  await demonstrateSQLitePersistence();
  await demonstrateEmitArtifactTool();
  await demonstrateAdminAPI();
  await demonstrateVersioning();
  await demonstrateRetention();
  await demonstrateTenantSettings();
  await demonstrateLiveLLM();

  header('All Phase 3 sections complete');
  console.log('  ✓ Section 1: SQLite persistence — saveArtifact, listArtifacts (m77 tables)');
  console.log('  ✓ Section 2: emit_artifact tool via weaveAgent — fake model round-trip');
  console.log('  ✓ Section 3: Admin REST API — list, get, download, delete endpoints');
  console.log('  ✓ Section 4: Versioning — updateArtifact creates version records');
  console.log('  ✓ Section 5: Retention — expireArtifacts removes past-retention artifacts');
  console.log('  ✓ Section 6: Tenant settings — per-tenant type allowlists and emit toggle');
  console.log('  ✓ Section 7: Live LLM demo (skipped if no API key)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
