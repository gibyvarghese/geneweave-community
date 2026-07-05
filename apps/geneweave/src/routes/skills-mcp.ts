// Skills MCP endpoint — exposes the workspace skill catalogue over MCP (read-only: list / search /
// get), plus per-user token management. Mirrors the notes MCP endpoint. Its own bearer-token auth
// (no cookie/CSRF); tokens live in user_mcp_tokens with service='skills'.

import type { Router } from '../server-core.js';
import { readBody } from '../server-core.js';
import type { DatabaseAdapter } from '../db.js';
import { createMcpSkillsServer } from '../mcp-skills-sql.js';

export function registerSkillsMcpRoutes(router: Router, db: DatabaseAdapter): void {
  const mcpSkills = createMcpSkillsServer(db);

  // The MCP endpoint itself (bearer-authenticated; JSON-RPC 2.0).
  router.post('/api/mcp/skills', async (req, res) => {
    const bearer = (req.headers['authorization'] as string | undefined) ?? '';
    const raw = await readBody(req).catch(() => '');
    const out = await mcpSkills.handleRequest(bearer, raw);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (out.status === 401) headers['WWW-Authenticate'] = 'Bearer realm="geneWeave Skills MCP"';
    res.writeHead(out.status, headers);
    res.end(out.body === null ? '' : JSON.stringify(out.body));
  }, { auth: false, csrf: false });

  // Per-user token management (cookie-authenticated).
  router.get('/api/me/skill-mcp-tokens', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tokens: mcpSkills.listTokens(auth.userId), endpoint: '/api/mcp/skills' }));
  }, { auth: true });

  router.post('/api/me/skill-mcp-tokens', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* */ }
    const created = mcpSkills.createToken({ userId: auth.userId, tenantId: auth.tenantId ?? null, name: typeof body['name'] === 'string' ? body['name'] : undefined });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...created, endpoint: '/api/mcp/skills' })); // `token` plaintext returned ONCE
  }, { auth: true });

  router.del('/api/me/skill-mcp-tokens/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    mcpSkills.revokeToken(params['id']!, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });
}
