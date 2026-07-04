import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import { getActiveSemanticMemoryBackend } from '../../memory-pgvector.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Read-only admin views for semantic memory, entity memory, and
 * memory-extraction events. These are observation/audit surfaces — no create/
 * update routes are exposed. Deletion is permitted for GDPR-style erasure.
 */
export function registerMemoryViewRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  // ── Semantic Memory ────────────────────────────────────────────────────────

  router.get('/api/admin/semantic-memory', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const userId = url.searchParams.get('userId') ?? undefined;
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    // Prefer the active semantic memory backend (pgvector when configured) so
    // operators see the same rows the runtime actually reads/writes. Falls back
    // to the SQLite mirror when no backend is active or when the lookup fails.
    const backend = getActiveSemanticMemoryBackend();
    if (backend && userId) {
      try {
        const entries = await backend.list(userId, limit + offset);
        const items = entries.slice(offset, offset + limit).map((e) => ({
          id: e.id,
          user_id: userId,
          content: e.content,
          memory_type: e.memory_type,
          source: e.source,
          created_at: e.created_at,
        }));
        json(res, 200, { 'semantic-memory': items });
        return;
      } catch (err) {
        console.warn('[admin] semantic-memory backend list failed, falling back to db:', String(err));
      }
    }
    const items = await db.listAllSemanticMemory({ userId, limit, offset });
    json(res, 200, { 'semantic-memory': items });
  }, { auth: true });

  // DELETE /api/admin/semantic-memory/:userId/:id — admin erasure
  router.del('/api/admin/semantic-memory/:userId/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSemanticMemory(params['id']!, params['userId']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Entity Memory ──────────────────────────────────────────────────────────

  router.get('/api/admin/entity-memory', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const userId = url.searchParams.get('userId') ?? undefined;
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const items = await db.listAllEntityMemory({ userId, limit, offset });
    json(res, 200, { 'entity-memory': items });
  }, { auth: true });

  router.del('/api/admin/entity-memory/:userId/:entityName', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteEntity(params['userId']!, decodeURIComponent(params['entityName']!));
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Memory Extraction Events ───────────────────────────────────────────────

  router.get('/api/admin/memory-extraction-events', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const userId = url.searchParams.get('userId') ?? undefined;
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') ?? '100', 10));
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const items = await db.listAllMemoryExtractionEvents({ userId, limit, offset });
    json(res, 200, { 'memory-extraction-events': items });
  }, { auth: true });

  // ── Memory Extraction Rules (write routes — already have list/get) ────────
  // The extraction-rules write API is served by the existing admin/api/skills.ts
  // pattern. We expose an additional route here for convenience, mirroring the
  // memory-governance pattern so the admin-schema tab can use the standard CRUD
  // list + create + update + delete lifecycle.

  router.get('/api/admin/memory-extraction-rules', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listMemoryExtractionRules();
    json(res, 200, { 'memory-extraction-rules': items });
  }, { auth: true });

  router.get('/api/admin/memory-extraction-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rule = await db.getMemoryExtractionRule(params['id']!);
    if (!rule) { json(res, 404, { error: 'Rule not found' }); return; }
    json(res, 200, { 'memory-extraction-rule': rule });
  }, { auth: true });

  router.post('/api/admin/memory-extraction-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const { readBody } = helpers;
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['pattern']) { json(res, 400, { error: 'name and pattern required' }); return; }
    const newId = 'mer-' + newUUIDv7().slice(-8);
    await db.createMemoryExtractionRule({
      id: newId,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      rule_type: (body['rule_type'] as string) ?? 'entity_extraction',
      entity_type: (body['entity_type'] as string) ?? null,
      pattern: body['pattern'] as string,
      flags: (body['flags'] as string) ?? 'i',
      facts_template: body['facts_template']
        ? (typeof body['facts_template'] === 'string' ? body['facts_template'] : JSON.stringify(body['facts_template']))
        : null,
      priority: (body['priority'] as number) ?? 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const created = await db.getMemoryExtractionRule(newId);
    json(res, 201, { 'memory-extraction-rule': created });
  }, { auth: true, csrf: true });

  router.put('/api/admin/memory-extraction-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const { readBody } = helpers;
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    await db.updateMemoryExtractionRule(params['id']!, body as Parameters<typeof db.updateMemoryExtractionRule>[1]);
    const rules = await db.listMemoryExtractionRules();
    const rule = rules.find((r) => r.id === params['id']);
    json(res, 200, { 'memory-extraction-rule': rule ?? null });
  }, { auth: true, csrf: true });

  router.del('/api/admin/memory-extraction-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteMemoryExtractionRule(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
