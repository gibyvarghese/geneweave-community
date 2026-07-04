/**
 * Example 120 — Phase 6: Live Artifacts & MCP Connectivity
 *
 * Demonstrates the Phase 6 Live Artifacts system in geneWeave:
 *
 *   1. Create an artifact via emit_artifact tool
 *   2. Promote it to "live" using the Admin API (POST /live-config)
 *   3. GET /api/artifacts/:id/render — render endpoint injects the refresh toolbar
 *   4. POST /api/artifacts/:id/refresh — inline refreshFn updates artifact data
 *   5. Cache TTL guard — skip refresh if recently refreshed
 *   6. Admin PATCH/DELETE live-config management
 *   7. (Optional) weaveAgent emits a live artifact using live API keys
 *
 * Runs without any API keys (Sections 1–6 use fake model + temp SQLite DB).
 * Section 7 is skipped unless OPENAI_API_KEY or ANTHROPIC_API_KEY is set.
 *
 * Run: npx tsx examples/120-live-artifacts.ts
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

// Use source directly so we pick up the latest live artifact methods (not pre-built dist)
import { SQLiteAdapter } from '../apps/geneweave/src/db-sqlite.js';
import { createToolRegistry } from '../apps/geneweave/src/tools.js';
import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import { weaveFakeModel } from '@weaveintel/testing';

// ─── Shared helpers ───────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
function ok(label: string, v = true) {
  if (v) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}
function makeTempDb() { return join(tmpdir(), `ex120-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }

type FakeAuthCtx = { userId: string; email: string; sessionId: string; csrfToken: string; persona: string; tenantId: null };
function userAuthCtx(userId: string): FakeAuthCtx {
  return { userId, email: `${userId}@example.com`, sessionId: `sess-${userId}`, csrfToken: 'tok', persona: 'tenant_user', tenantId: null };
}
function adminAuthCtx(): FakeAuthCtx {
  return { userId: 'admin', email: 'admin@example.com', sessionId: 'sess-admin', csrfToken: 'tok', persona: 'platform_admin', tenantId: null };
}

// ─── Section 1: Create artifact, promote to live, render with toolbar ─────────

console.log('\n── Section 1: Create + promote + render with live toolbar ──────────────────');

{
  const dbPath = makeTempDb();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  // Import route factories
  const { Router, json: jsonHelper, readBody } = await import('../apps/geneweave/src/server-core.js');
  const { registerArtifactRoutes } = await import('../apps/geneweave/src/routes/artifacts.js');
  const { registerArtifactRoutes: registerAdminRoutes } = await import('../apps/geneweave/src/admin/api/artifacts.js');

  // Track refresh calls
  let refreshCalls = 0;
  const userRouter = new Router();
  registerArtifactRoutes(userRouter, db, {
    refreshFn: async (_artifact, _args) => {
      refreshCalls++;
      return { data: `# Live Report\n\nGenerated at: ${new Date().toISOString()}\nRefresh #${refreshCalls}` };
    },
  });

  const adminRouter = new Router();
  registerAdminRoutes(adminRouter, db, { json: jsonHelper, readBody, requireDetailedDescription: () => null });

  // Mount both routers in a single test server (prefix routing)
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const isAdmin = url.pathname.startsWith('/api/admin/');
    const router = isAdmin ? adminRouter : userRouter;
    const matched = router.match(req.method ?? 'GET', url.pathname);
    if (!matched) { res.writeHead(404); res.end(); return; }
    const ctx = isAdmin ? adminAuthCtx() : userAuthCtx('demo-user');
    await matched.route.handler(req, res, matched.params, ctx as never);
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  // 1a. Save an artifact via admin (simulating agent output)
  const registry = await createToolRegistry(['emit_artifact'], [], {
    actorPersona: 'tenant_user',
    currentUserId: 'demo-user',
    artifactSave: async (input) => { const row = await db.saveArtifact!(input); return { id: row.id, version: row.version }; },
  });
  const model = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{
          id: 'tc-ex120-1',
          function: {
            name: 'emit_artifact',
            arguments: JSON.stringify({ name: 'market-report.md', type: 'markdown', data: '# Market Report\n\nInitial snapshot.' }),
          },
        }],
      },
      { content: 'Market report artifact emitted.' },
    ],
  });
  const agent = weaveAgent({ model, tools: registry, name: 'demo-agent', maxSteps: 3 });
  await agent.run(weaveContext({ userId: 'demo-user' }), { messages: [{ role: 'user', content: 'Generate a market report.' }] });

  // Grab the created artifact
  const artifacts = await db.listArtifacts!({ userId: 'demo-user' });
  ok('artifact created by weaveAgent', artifacts.length > 0);
  const artifactId = artifacts[0]!.id;

  // 1b. Promote to live via admin API
  const promoteRes = await fetch(`${base}/api/admin/artifacts/${artifactId}/live-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshIntervalSeconds: 30, cacheTtlSeconds: 5 }),
  });
  const promoteText = await promoteRes.text();
  if (promoteRes.status !== 201) console.error('  [debug] POST /live-config:', promoteRes.status, promoteText.slice(0, 200));
  ok('POST /live-config returns 201', promoteRes.status === 201);
  const promoted = JSON.parse(promoteText) as { liveConfig?: { refresh_interval_seconds: number } };
  ok('live config has correct interval', promoted.liveConfig?.refresh_interval_seconds === 30);

  // 1c. Render endpoint injects the live toolbar
  const renderRes = await fetch(`${base}/api/artifacts/${artifactId}/render`);
  ok('render returns 200', renderRes.status === 200);
  const renderHtml = await renderRes.text();
  ok('rendered HTML contains live-toolbar', renderHtml.includes('live-toolbar'));
  ok('rendered HTML contains LIVE badge', renderHtml.includes('LIVE'));
  ok('rendered HTML contains refresh endpoint', renderHtml.includes(`/api/artifacts/${artifactId}/refresh`));
  ok('CSP includes connect-src self for refresh fetch()', renderRes.headers.get('content-security-policy')?.includes("connect-src 'self'") ?? false);

  // 1d. Trigger refresh (outside TTL — cache_ttl=5, last_refreshed_at is null)
  const refreshRes = await fetch(`${base}/api/artifacts/${artifactId}/refresh`, { method: 'POST' });
  ok('POST /refresh returns 200', refreshRes.status === 200);
  const refreshBody = await refreshRes.json() as { fromCache: boolean; version: number; refreshedAt: string };
  ok('refresh returns fromCache:false (first refresh)', !refreshBody.fromCache);
  ok('refresh returns refreshedAt timestamp', !!refreshBody.refreshedAt);
  ok('refreshFn was called once', refreshCalls === 1);

  // Verify data was updated in DB
  const updated = await db.getArtifact!(artifactId);
  ok('artifact data updated after refresh', updated?.data_text?.includes('Live Report') ?? false);

  // 1e. Trigger again — should be from cache (within 5-second TTL)
  const cachedRes = await fetch(`${base}/api/artifacts/${artifactId}/refresh`, { method: 'POST' });
  ok('second refresh returns 200', cachedRes.status === 200);
  const cachedBody = await cachedRes.json() as { fromCache: boolean };
  ok('second refresh returns fromCache:true (within TTL)', cachedBody.fromCache);
  ok('refreshFn NOT called again', refreshCalls === 1);

  await new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  await db.close();
  rmSync(dbPath, { force: true });
}

// ─── Section 2: Admin live config CRUD lifecycle ──────────────────────────────

console.log('\n── Section 2: Admin live config CRUD lifecycle ─────────────────────────────');

{
  const dbPath = makeTempDb();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();
  const { Router, json: jsonHelper, readBody } = await import('../apps/geneweave/src/server-core.js');
  const { registerArtifactRoutes: registerAdminRoutes } = await import('../apps/geneweave/src/admin/api/artifacts.js');
  const adminRouter = new Router();
  registerAdminRoutes(adminRouter, db, { json: jsonHelper, readBody, requireDetailedDescription: () => null });
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = adminRouter.match(req.method ?? 'GET', url.pathname);
    if (!m) { res.writeHead(404); res.end(); return; }
    await m.route.handler(req, res, m.params, adminAuthCtx() as never);
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const artifact = await db.saveArtifact!({ name: 'crud.md', type: 'markdown', mimeType: 'text/markdown', data: '# CRUD', scope: 'session', userId: 'u1' });

  // GET before create → 404
  const getEmpty = await fetch(`${base}/api/admin/artifacts/${artifact.id}/live-config`);
  ok('GET live-config 404 before creation', getEmpty.status === 404);

  // POST → 201
  const createRes = await fetch(`${base}/api/admin/artifacts/${artifact.id}/live-config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshIntervalSeconds: 60, cacheTtlSeconds: 15 }),
  });
  ok('POST live-config returns 201', createRes.status === 201);

  // GET after create → 200
  const getRes = await fetch(`${base}/api/admin/artifacts/${artifact.id}/live-config`);
  ok('GET live-config returns 200 after creation', getRes.status === 200);
  const getBody = await getRes.json() as { liveConfig: { refresh_interval_seconds: number; cache_ttl_seconds: number } };
  ok('GET returns correct interval', getBody.liveConfig.refresh_interval_seconds === 60);
  ok('GET returns correct TTL', getBody.liveConfig.cache_ttl_seconds === 15);

  // PATCH → 200
  const patchRes = await fetch(`${base}/api/admin/artifacts/${artifact.id}/live-config`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cacheTtlSeconds: 99 }),
  });
  ok('PATCH live-config returns 200', patchRes.status === 200);
  const patchBody = await patchRes.json() as { liveConfig: { cache_ttl_seconds: number; refresh_interval_seconds: number } };
  ok('PATCH updates cacheTtlSeconds', patchBody.liveConfig.cache_ttl_seconds === 99);
  ok('PATCH leaves refreshIntervalSeconds unchanged', patchBody.liveConfig.refresh_interval_seconds === 60);

  // live-refresh admin endpoint
  const adminRefresh = await fetch(`${base}/api/admin/artifacts/${artifact.id}/live-refresh`, { method: 'POST' });
  ok('POST /live-refresh returns 200', adminRefresh.status === 200);

  // DELETE → 200
  const delRes = await fetch(`${base}/api/admin/artifacts/${artifact.id}/live-config`, { method: 'DELETE' });
  ok('DELETE live-config returns 200', delRes.status === 200);

  // GET after delete → 404
  const getAfterDel = await fetch(`${base}/api/admin/artifacts/${artifact.id}/live-config`);
  ok('GET live-config 404 after deletion', getAfterDel.status === 404);

  await new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  await db.close();
  rmSync(dbPath, { force: true });
}

// ─── Section 3: render-live endpoint with live toolbar ────────────────────────

console.log('\n── Section 3: Admin render-live endpoint ────────────────────────────────────');

{
  const dbPath = makeTempDb();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();
  const { Router, json: jsonHelper, readBody } = await import('../apps/geneweave/src/server-core.js');
  const { registerArtifactRoutes: registerAdminRoutes } = await import('../apps/geneweave/src/admin/api/artifacts.js');
  const adminRouter = new Router();
  registerAdminRoutes(adminRouter, db, { json: jsonHelper, readBody, requireDetailedDescription: () => null });
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = adminRouter.match(req.method ?? 'GET', url.pathname);
    if (!m) { res.writeHead(404); res.end(); return; }
    await m.route.handler(req, res, m.params, adminAuthCtx() as never);
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const artifact = await db.saveArtifact!({ name: 'live-demo.md', type: 'markdown', mimeType: 'text/markdown', data: '# Live Demo\n\nData refreshed in real-time.', scope: 'session', userId: 'admin' });
  await db.saveLiveArtifactConfig!({ artifactId: artifact.id, refreshIntervalSeconds: 30 });

  const res = await fetch(`${base}/api/admin/artifacts/${artifact.id}/render-live`);
  ok('render-live returns 200', res.status === 200);
  const html = await res.text();
  ok('render-live injects live toolbar', html.includes('live-toolbar'));
  ok('render-live has LIVE badge', html.includes('LIVE'));
  ok('render-live has auto-refresh script', html.includes('INTERVAL_MS = 30000'));
  ok('render-live has markdown content', html.includes('marked') || html.includes('Live Demo'));
  ok('CSP allows connect-src self', res.headers.get('content-security-policy')?.includes("connect-src 'self'") ?? false);

  // Static artifact (no live config) → no toolbar
  const staticArtifact = await db.saveArtifact!({ name: 'static.md', type: 'markdown', mimeType: 'text/markdown', data: '# Static', scope: 'session', userId: 'admin' });
  const staticRes = await fetch(`${base}/api/admin/artifacts/${staticArtifact.id}/render-live`);
  ok('render-live for static artifact returns 200', staticRes.status === 200);
  const staticHtml = await staticRes.text();
  ok('static render-live has NO live toolbar', !staticHtml.includes('live-toolbar'));

  await new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  await db.close();
  rmSync(dbPath, { force: true });
}

// ─── Section 4: Negative tests — auth guards ─────────────────────────────────

console.log('\n── Section 4: Auth guards on live endpoints ─────────────────────────────────');

{
  const dbPath = makeTempDb();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();
  const { Router } = await import('../apps/geneweave/src/server-core.js');
  const { registerArtifactRoutes } = await import('../apps/geneweave/src/routes/artifacts.js');
  const router = new Router();
  registerArtifactRoutes(router, db);

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = router.match(req.method ?? 'GET', url.pathname);
    if (!m) { res.writeHead(404); res.end(); return; }
    await m.route.handler(req, res, m.params, null); // no auth
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const r1 = await fetch(`${base}/api/artifacts/any-id/refresh`, { method: 'POST' });
  ok('POST /refresh 401 without auth', r1.status === 401);

  await new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  await db.close();
  rmSync(dbPath, { force: true });
}

// ─── Section 5: Live LLM with real API keys (optional) ────────────────────────

console.log('\n── Section 5: Live LLM test (optional — requires API keys) ─────────────────');

const openaiKey = process.env['OPENAI_API_KEY'];
const anthropicKey = process.env['ANTHROPIC_API_KEY'];

if (!openaiKey && !anthropicKey) {
  console.log('  ⓘ Skipped — no OPENAI_API_KEY or ANTHROPIC_API_KEY found in env');
} else {
  const dbPath = makeTempDb();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  let capturedId: string | null = null;
  const registry = await createToolRegistry(['emit_artifact'], [], {
    actorPersona: 'tenant_user',
    artifactSave: async (input) => {
      const row = await db.saveArtifact!(input);
      capturedId = row.id;
      return { id: row.id, version: row.version };
    },
  });

  let model: import('@weaveintel/core').Model;
  let modelLabel: string;
  if (openaiKey) {
    const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
    model = weaveOpenAIModel('gpt-4o-mini', { apiKey: openaiKey });
    modelLabel = 'gpt-4o-mini';
  } else {
    const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');
    model = weaveAnthropicModel('claude-haiku-4-5-20251001', { apiKey: anthropicKey! });
    modelLabel = 'claude-haiku-4-5-20251001';
  }

  console.log(`  Using model: ${modelLabel}`);
  const agent = weaveAgent({ model, tools: registry, name: 'live-demo', maxSteps: 4 });
  await agent.run(weaveContext({ userId: 'live-demo-user' }), {
    messages: [{ role: 'user', content: 'Generate a brief cryptocurrency market summary as a markdown artifact named "crypto-summary.md". Use the emit_artifact tool.' }],
  });

  ok('live agent created artifact', capturedId !== null);
  if (capturedId) {
    // Promote to live
    await db.saveLiveArtifactConfig!({ artifactId: capturedId, refreshIntervalSeconds: 60, cacheTtlSeconds: 10 });
    const config = await db.getLiveArtifactConfig!(capturedId);
    ok('live config created for live agent artifact', config !== null);
    ok('live config has 60s interval', config?.refresh_interval_seconds === 60);

    // Touch refresh
    await db.touchLiveArtifactRefresh!(capturedId);
    const touched = await db.getLiveArtifactConfig!(capturedId);
    ok('touchLiveArtifactRefresh incremented count', touched?.refresh_count === 1);
    console.log(`  Artifact ID: ${capturedId}`);
    console.log(`  Render URL: /api/artifacts/${capturedId}/render (would show live toolbar)`);
  }

  await db.close();
  rmSync(dbPath, { force: true });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(64)}`);
console.log(`Example 120 — Phase 6: Live Artifacts`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('FAIL'); process.exit(1); }
else { console.log('PASS'); }
