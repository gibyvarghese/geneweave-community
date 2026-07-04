/**
 * Example 119 — Phase 5: Sandboxed Artifact Rendering
 *
 * Demonstrates the Phase 5 sandboxed render endpoint in geneWeave:
 *
 *   1. GET /api/artifacts/:id/render — server-side HTML per artifact type
 *   2. Type-specific renderers: markdown, code (hljs), JSON tree, CSV table,
 *      mermaid (CDN), React/JSX (Babel CDN), SVG, html passthrough
 *   3. CSP headers + iframe sandbox attributes for XSS isolation
 *   4. Admin render endpoint — GET /api/admin/artifacts/:id/render
 *   5. weaveAgent emits an artifact; render URL is immediately accessible
 *   6. (Optional) Live LLM demo — set OPENAI_API_KEY or ANTHROPIC_API_KEY
 *
 * Runs without any API keys (Sections 1–5 use a fake model + temp SQLite DB).
 * Section 6 is skipped unless a live key is detected.
 *
 * Run: npx tsx examples/119-artifact-sandbox-rendering.ts
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

// ─── Shared helpers ───────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
function ok(label: string, v = true) { if (v) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}`); failed++; } }
function makeTempDb() { return join(tmpdir(), `ex119-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }

type FakeAuthCtx = { userId: string; email: string; sessionId: string; csrfToken: string; persona: string; tenantId: null };
function userAuthCtx(userId: string): FakeAuthCtx {
  return { userId, email: `${userId}@example.com`, sessionId: `sess-${userId}`, csrfToken: 'tok', persona: 'tenant_user', tenantId: null };
}
function adminAuthCtx(): FakeAuthCtx {
  return { userId: 'admin', email: 'admin@example.local', sessionId: 'admin-sess', csrfToken: 'tok', persona: 'platform_admin', tenantId: null };
}

/* ─── Shared server builder ─────────────────────────────────────────────────

   We wire both /api/artifacts/* (user routes) and /api/admin/artifacts/*
   (admin routes) into the same HTTP server so sections can hit either prefix.
   Auth is simulated:
     • User routes: X-User-Id header → auth context with that userId
     • Admin routes: Authorization: Basic YWRtaW46YWRtaW4= (admin:admin) → admin auth
                     No header → null (triggers 401 inside the route handler)
*/
async function startServer(db: SQLiteAdapter): Promise<{ url: string; close: () => void }> {
  const { Router } = await import('../apps/geneweave/src/server-core.js');
  const { registerArtifactRoutes: regUser } = await import('../apps/geneweave/src/routes/artifacts.js');
  const { registerArtifactRoutes: regAdmin } = await import('../apps/geneweave/src/admin/api/artifacts.js');
  const { json: jsonHelper, readBody: readBodyHelper } = await import('../apps/geneweave/src/server-core.js');

  const userRouter = new Router();
  regUser(userRouter, db as never);

  const adminRouter = new Router();
  regAdmin(adminRouter, db as never, { json: jsonHelper, readBody: readBodyHelper, requireDetailedDescription: () => null });

  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');

    // Admin routes
    const adminMatch = adminRouter.match(req.method ?? 'GET', url.pathname);
    if (adminMatch) {
      const authHeader = req.headers['authorization'] as string | undefined;
      const isAdmin = authHeader?.startsWith('Basic ') &&
        Buffer.from(authHeader.slice(6), 'base64').toString() === 'admin:admin';
      const auth = isAdmin ? adminAuthCtx() : null;
      void adminMatch.route.handler(req, res, adminMatch.params, auth as never);
      return;
    }

    // User routes
    const userMatch = userRouter.match(req.method ?? 'GET', url.pathname);
    if (userMatch) {
      const uid = req.headers['x-user-id'] as string | undefined;
      const auth = uid ? userAuthCtx(uid) : null;
      void userMatch.route.handler(req, res, userMatch.params, auth as never);
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}`, close: () => srv.close() };
}

/* ═══ Section 1: Type-specific render output ════════════════════════════════ */

async function section1(serverUrl: string, db: SQLiteAdapter) {
  console.log('\nSection 1: Render endpoint — type-specific HTML output');

  const cases: Array<{
    label: string; type: string; mime: string; data: string;
    metadata?: Record<string, unknown>; mustContain: string[];
  }> = [
    {
      label: 'markdown', type: 'markdown', mime: 'text/markdown',
      data: '# Hello\n\n**Bold** and _italic_.',
      mustContain: ['marked', '# Hello'],
    },
    {
      label: 'code (python)', type: 'code', mime: 'text/x-python',
      data: 'def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n): a, b = b, a + b\n    return a',
      metadata: { language: 'python' },
      mustContain: ['highlight.js', 'language-python', 'fibonacci'],
    },
    {
      label: 'json', type: 'json', mime: 'application/json',
      data: '{"model":"claude-sonnet-4-6","tokens":1024,"cost":0.012}',
      mustContain: ['renderNode', 'claude-sonnet-4-6'],
    },
    {
      label: 'csv', type: 'csv', mime: 'text/csv',
      data: 'name,score,grade\nAlice,95,A\nBob,82,B\nCarla,90,A-',
      mustContain: ['<th>name</th>', '<th>score</th>', 'Alice', 'sort'],
    },
    {
      label: 'mermaid', type: 'mermaid', mime: 'text/x-mermaid',
      data: 'graph TD\n  A[User] --> B[weaveAgent]\n  B --> C[emit_artifact]\n  C --> D[(DB)]',
      mustContain: ['cdn.jsdelivr.net', 'mermaid', 'weaveAgent'],
    },
    {
      label: 'html', type: 'html', mime: 'text/html',
      data: '<p>Hello from <strong>artifact</strong></p>',
      mustContain: ['Content-Security-Policy', '<p>Hello from'],
    },
    {
      label: 'svg', type: 'svg', mime: 'image/svg+xml',
      data: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle r="40" cx="50" cy="50" fill="#4db6ff"/></svg>',
      mustContain: ['<svg', '<circle'],
    },
    {
      label: 'react', type: 'react', mime: 'text/typescript',
      data: 'const App = () => <div style={{color:"#4db6ff"}}>Hello from React</div>;',
      mustContain: ['babel', 'text/babel'],
    },
    {
      label: 'text', type: 'text', mime: 'text/plain',
      data: 'Line 1\nLine 2\nLine 3',
      mustContain: ['Line 1', 'Line 2'],
    },
  ];

  for (const c of cases) {
    const row = await db.saveArtifact!({
      name: `ex119.${c.type}`, type: c.type, mimeType: c.mime,
      data: c.data, scope: 'user', userId: 'u1', metadata: c.metadata,
    });
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`, {
      headers: { 'x-user-id': 'u1' },
    });
    const body = await res.text();
    ok(`${c.label} → 200`, res.status === 200);
    ok(`${c.label} → text/html`, res.headers.get('content-type')?.includes('text/html') ?? false);
    for (const needle of c.mustContain) {
      ok(`${c.label} → contains "${needle}"`, body.includes(needle));
    }
  }
}

/* ═══ Section 2: CSP and security headers ═══════════════════════════════════ */

async function section2(serverUrl: string, db: SQLiteAdapter) {
  console.log('\nSection 2: CSP and security headers');

  const row = await db.saveArtifact!({
    name: 'csp-test.md', type: 'markdown', mimeType: 'text/markdown',
    data: '# CSP', scope: 'user', userId: 'u2',
  });

  const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`, {
    headers: { 'x-user-id': 'u2' },
  });
  const csp = res.headers.get('content-security-policy') ?? '';

  ok('CSP header present', !!csp);
  ok("CSP: default-src 'none'", csp.includes("default-src 'none'"));
  ok("CSP: script-src 'unsafe-inline'", csp.includes("'unsafe-inline'"));
  ok('CSP: cdn.jsdelivr.net allowed', csp.includes('cdn.jsdelivr.net'));
  ok('CSP: cdnjs.cloudflare.com allowed', csp.includes('cdnjs.cloudflare.com'));
  ok('X-Content-Type-Options: nosniff', res.headers.get('x-content-type-options') === 'nosniff');
  ok('X-Frame-Options: SAMEORIGIN', res.headers.get('x-frame-options') === 'SAMEORIGIN');
  ok('Cache-Control: private', res.headers.get('cache-control')?.includes('private') ?? false);
}

/* ═══ Section 3: Auth guards ════════════════════════════════════════════════ */

async function section3(serverUrl: string, db: SQLiteAdapter) {
  console.log('\nSection 3: Auth guards on render endpoint');

  const row = await db.saveArtifact!({
    name: 'secret.md', type: 'markdown', mimeType: 'text/markdown',
    data: '# Secret content', scope: 'user', userId: 'owner-user',
  });

  // No auth header
  const unauth = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`);
  ok('No auth → 401', unauth.status === 401);

  // Unknown artifact id
  const notFound = await fetch(`${serverUrl}/api/artifacts/nonexistent-id/render`, {
    headers: { 'x-user-id': 'owner-user' },
  });
  ok('Unknown id → 404', notFound.status === 404);

  // Wrong user (different userId → 403 because ownership check)
  const wrongUser = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`, {
    headers: { 'x-user-id': 'other-user' },
  });
  ok('Wrong user → 403', wrongUser.status === 403);

  // Owner can render
  const ownerRes = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`, {
    headers: { 'x-user-id': 'owner-user' },
  });
  ok('Owner → 200', ownerRes.status === 200);
}

/* ═══ Section 4: Admin render endpoint ═════════════════════════════════════ */

async function section4(serverUrl: string, db: SQLiteAdapter) {
  console.log('\nSection 4: Admin render endpoint');

  const row = await db.saveArtifact!({
    name: 'report.md', type: 'markdown', mimeType: 'text/markdown',
    data: '# Executive Report\n\nQ3 revenue grew 18% YoY.', scope: 'session',
  });

  // No admin auth
  const unauth = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/render`);
  ok('Admin render — no auth → 401', unauth.status === 401);

  // With Basic admin credentials
  const adminRes = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/render`, {
    headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
  });
  const body = await adminRes.text();
  ok('Admin render → 200', adminRes.status === 200);
  ok('Admin render → text/html', adminRes.headers.get('content-type')?.includes('text/html') ?? false);
  ok('Admin render → marked CDN', body.includes('marked'));
  ok('Admin render → CSP header', !!adminRes.headers.get('content-security-policy'));
  ok('Admin render → artifact content', body.includes('Executive Report'));

  console.log(`\n  Admin preview URL: ${serverUrl}/api/admin/artifacts/${row.id}/render`);
}

/* ═══ Section 5: weaveAgent emits artifact → render URL live ══════════════ */

async function section5(serverUrl: string, db: SQLiteAdapter) {
  console.log('\nSection 5: weaveAgent emit_artifact → render endpoint');

  let savedRow: Awaited<ReturnType<NonNullable<typeof db.saveArtifact>>> | undefined;

  const artifactSave = async (input: Parameters<NonNullable<typeof db.saveArtifact>>[0]) => {
    const row = await db.saveArtifact!({ ...input, userId: 'agent-user' });
    savedRow = row;
    return row;
  };

  const registry = await createToolRegistry(['emit_artifact'], [], { artifactSave, actorPersona: 'tenant_user' });

  const model = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{
          id: 'tc-ex119',
          function: {
            name: 'emit_artifact',
            arguments: JSON.stringify({
              name: 'pipeline-metrics.json',
              type: 'json',
              data: JSON.stringify({
                pipeline: 'weaveintel-prod',
                p50_latency_ms: 142,
                p99_latency_ms: 890,
                error_rate: 0.0018,
                throughput_rps: 1247,
              }),
            }),
          },
        }],
      },
      { content: 'Pipeline metrics artifact saved.' },
    ],
  });

  const agent = weaveAgent({ model, tools: registry, name: 'ex119-agent', maxSteps: 4 });
  await agent.run(weaveContext({ userId: 'agent-user' }), {
    messages: [{ role: 'user', content: 'Emit a JSON artifact with pipeline performance metrics.' }],
  });

  ok('Agent emitted 1 artifact', !!savedRow);

  if (savedRow) {
    const res = await fetch(`${serverUrl}/api/artifacts/${savedRow.id}/render`, {
      headers: { 'x-user-id': 'agent-user' },
    });
    const body = await res.text();
    ok('Agent artifact render → 200', res.status === 200);
    ok('Agent artifact render → tree-view script', body.includes('renderNode'));
    ok('Agent artifact render → data in output', body.includes('weaveintel-prod'));

    console.log(`\n  Render URL: ${serverUrl}/api/artifacts/${savedRow.id}/render`);
    console.log('  Open in browser to explore the interactive JSON tree.');
  }
}

/* ═══ Section 6: Live LLM (optional) ═══════════════════════════════════════ */

async function section6(serverUrl: string, db: SQLiteAdapter) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const apiKey = openaiKey ?? anthropicKey;
  if (!apiKey) { console.log('\nSection 6: Live LLM — SKIPPED (set OPENAI_API_KEY or ANTHROPIC_API_KEY to run)'); return; }

  const modelId = openaiKey ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001';
  console.log(`\nSection 6: Live LLM (${modelId}) — emits markdown + JSON artifacts`);

  let model: import('@weaveintel/core').Model;
  if (openaiKey) {
    const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
    model = weaveOpenAIModel(modelId, { apiKey: openaiKey });
  } else {
    const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');
    model = weaveAnthropicModel(modelId, { apiKey: anthropicKey! });
  }

  let count = 0;
  const artifactSave = async (input: Parameters<NonNullable<typeof db.saveArtifact>>[0]) => {
    const row = await db.saveArtifact!({ ...input, userId: 'live-agent' });
    count++;
    return row;
  };

  const registry = await createToolRegistry(['emit_artifact'], [], { artifactSave, actorPersona: 'tenant_user' });

  const prompt = [
    'Please do two things:',
    '1. Emit a markdown artifact named "fibonacci.md" explaining the Fibonacci sequence in 2–3 sentences.',
    '2. Emit a JSON artifact named "fibonacci.json" with the first 10 Fibonacci numbers as an array under key "sequence".',
  ].join('\n');

  process.stdout.write('  Running live agent');
  const agent = weaveAgent({ model, tools: registry, name: 'ex119-live-agent', maxSteps: 8 });
  await agent.run(weaveContext({ userId: 'live-agent' }), {
    messages: [{ role: 'user', content: prompt }],
  });
  console.log(` done (${count} artifact(s) emitted)`);

  ok(`Live agent emitted at least 1 artifact`, count >= 1);

  const rows = await db.listArtifacts!({ userId: 'live-agent' });
  for (const row of rows) {
    const res = await fetch(`${serverUrl}/api/artifacts/${row.id}/render`, {
      headers: { 'x-user-id': 'live-agent' },
    });
    const body = await res.text();
    ok(`${row.type} artifact (${row.name}) renders → 200`, res.status === 200);
    ok(`${row.type} artifact has content`, body.length > 100);
    console.log(`  → ${serverUrl}/api/artifacts/${row.id}/render`);
  }
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

(async () => {
  console.log('=== Example 119: Phase 5 Sandboxed Artifact Rendering ===');

  const dbPath = makeTempDb();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  const { url, close } = await startServer(db);
  console.log(`\nServer: ${url}`);

  try {
    await section1(url, db);
    await section2(url, db);
    await section3(url, db);
    await section4(url, db);
    await section5(url, db);
    await section6(url, db);
  } finally {
    close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  }

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  if (failed > 0) process.exit(1);
})();
