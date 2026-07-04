import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';

// Allowlists for memory metadata fields. Values outside these sets are
// silently normalised to the safe default to prevent injection / enumeration.
const ALLOWED_MEMORY_TYPES = new Set(['fact', 'preference', 'episode', 'entity', 'relationship', 'goal']);
const ALLOWED_MEMORY_SOURCES = new Set(['api', 'chat', 'user', 'system', 'import', 'skill']);

export function registerMemoryRoutes(router: Router, db: DatabaseAdapter): void {

  // ── Memory API ─────────────────────────────────────────────────────────────

  // Upsert a semantic memory. Accepts `content` or `text` as the content field,
  // plus optional `key`, `scope`, `memoryType`, `source`, `chatId`.
  router.post('/api/memory/upsert', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { content?: string; text?: string; key?: string; scope?: string; memoryType?: string; source?: string; chatId?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const content = (body.content ?? body.text ?? '').trim();
    if (!content) { json(res, 400, { error: 'content or text required' }); return; }
    const id = newUUIDv7();
    await db.saveSemanticMemory({
      id,
      userId: auth.userId,
      chatId: body.chatId,
      content,
      memoryType: ALLOWED_MEMORY_TYPES.has(body.memoryType ?? '') ? (body.memoryType ?? 'fact')
        : ALLOWED_MEMORY_TYPES.has(body.scope ?? '') ? (body.scope ?? 'fact') : 'fact',
      source: ALLOWED_MEMORY_SOURCES.has(body.key ?? '') ? (body.key ?? 'api')
        : ALLOWED_MEMORY_SOURCES.has(body.source ?? '') ? (body.source ?? 'api') : 'api',
    });
    json(res, 200, { id, ok: true });
  }, { auth: true, csrf: true });

  // Search semantic memories for the authenticated user.
  router.post('/api/memory/search', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { query?: string; limit?: number };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body.query || typeof body.query !== 'string' || !body.query.trim()) {
      json(res, 400, { error: 'query required' }); return;
    }
    const limit = typeof body.limit === 'number' ? Math.min(body.limit, 50) : 10;
    const results = await db.searchSemanticMemory({ userId: auth.userId, query: body.query.trim(), limit });
    json(res, 200, { results });
  }, { auth: true, csrf: true });

  // Forget memories matching a query or key. Accepts:
  //   { id }           — delete by exact ID
  //   { query, key }   — search by query then delete all matching entries
  // Returns 200 even if nothing was deleted (idempotent).
  router.post('/api/memory/forget', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { id?: string; query?: string; key?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (body.id) {
      await db.deleteSemanticMemory(body.id, auth.userId);
      json(res, 200, { ok: true, deleted: 1 }); return;
    }
    const searchTerm = body.query ?? body.key;
    if (!searchTerm) { json(res, 400, { error: 'id or query required' }); return; }
    const matches = await db.searchSemanticMemory({ userId: auth.userId, query: searchTerm, limit: 50 });
    let deleted = 0;
    for (const m of matches) {
      if (m.content.includes(searchTerm)) {
        await db.deleteSemanticMemory(m.id, auth.userId);
        deleted++;
      }
    }
    json(res, 200, { ok: true, deleted });
  }, { auth: true, csrf: true });

  // List all memories for the authenticated user (up to 100).
  router.get('/api/memory', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const memories = await db.listSemanticMemory(auth.userId, 100);
    json(res, 200, { memories });
  });

}
