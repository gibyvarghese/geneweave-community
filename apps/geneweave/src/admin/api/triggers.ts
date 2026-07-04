/**
 * @weaveintel/geneweave — Phase 3 Unified Triggers admin routes
 *
 *   GET    /api/admin/triggers
 *   GET    /api/admin/triggers/:id
 *   POST   /api/admin/triggers
 *   PUT    /api/admin/triggers/:id
 *   DELETE /api/admin/triggers/:id
 *   POST   /api/admin/triggers/:id/fire     (manual dispatch)
 *   GET    /api/admin/trigger-invocations   (audit log)
 *
 * Writes call `dispatcher.reload()` so source adapters (cron etc.)
 * pick up changes without a server restart. Manual dispatch routes
 * the payload through the in-process `ManualSourceAdapter` scoped to
 * the requested trigger via `onlyTriggerId`.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter, TriggerRow } from '../../db-types.js';
import type { TriggerDispatcher, ManualSourceAdapter } from '@weaveintel/triggers';

export interface TriggerRouterLike {
  get(path: string, handler: (req: any, res: any, params: any, auth: any) => Promise<void> | void, opts?: { auth?: boolean; csrf?: boolean }): void;
  post(path: string, handler: (req: any, res: any, params: any, auth: any) => Promise<void> | void, opts?: { auth?: boolean; csrf?: boolean }): void;
  put(path: string, handler: (req: any, res: any, params: any, auth: any) => Promise<void> | void, opts?: { auth?: boolean; csrf?: boolean }): void;
  del(path: string, handler: (req: any, res: any, params: any, auth: any) => Promise<void> | void, opts?: { auth?: boolean; csrf?: boolean }): void;
}

export interface TriggerRouteHelpers {
  json: (res: any, status: number, body: unknown) => void;
  readBody: (req: any) => Promise<string>;
}

export interface TriggerDispatcherHandle {
  dispatcher: TriggerDispatcher;
  manualSource: ManualSourceAdapter;
}

function toBool(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'string') return v === 'true' || v === '1' ? 1 : 0;
  return 1;
}

function jsonOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function parseJsonBody<T>(s: string): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

export function registerTriggerRoutes(
  router: TriggerRouterLike,
  db: DatabaseAdapter,
  helpers: TriggerRouteHelpers,
  handle: TriggerDispatcherHandle | undefined,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/triggers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTriggers();
    json(res, 200, { triggers: rows });
  }, { auth: true });

  router.get('/api/admin/triggers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'Missing id' }); return; }
    const row = await db.getTrigger(id);
    if (!row) { json(res, 404, { error: 'Not found' }); return; }
    json(res, 200, row);
  }, { auth: true });

  router.post('/api/admin/triggers', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const body = parseJsonBody<Partial<TriggerRow> & { source_config?: unknown; target_config?: unknown; filter_expr?: unknown; input_map?: unknown; metadata?: unknown }>(await readBody(req));
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body.key || typeof body.key !== 'string') { json(res, 400, { error: 'key required' }); return; }
    if (!body.source_kind || typeof body.source_kind !== 'string') { json(res, 400, { error: 'source_kind required' }); return; }
    if (!body.target_kind || typeof body.target_kind !== 'string') { json(res, 400, { error: 'target_kind required' }); return; }
    const id = body.id ?? newUUIDv7();
    try {
      const created = await db.createTrigger({
        id,
        key: body.key,
        enabled: toBool(body.enabled ?? true),
        source_kind: body.source_kind,
        source_config: jsonOrNull(body.source_config) ?? '{}',
        filter_expr: jsonOrNull(body.filter_expr),
        target_kind: body.target_kind,
        target_config: jsonOrNull(body.target_config) ?? '{}',
        input_map: jsonOrNull(body.input_map),
        rate_limit_per_minute: body.rate_limit_per_minute ?? null,
        metadata: jsonOrNull(body.metadata),
      });
      if (handle) await handle.dispatcher.reload();
      json(res, 201, created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 400, { error: msg });
    }
  }, { auth: true, csrf: true });

  router.put('/api/admin/triggers/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'Missing id' }); return; }
    const body = parseJsonBody<Partial<TriggerRow> & Record<string, unknown>>(await readBody(req));
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<TriggerRow> = {};
    if (body.key !== undefined) patch.key = String(body.key);
    if (body.enabled !== undefined) patch.enabled = toBool(body.enabled);
    if (body.source_kind !== undefined) patch.source_kind = String(body.source_kind);
    if (body.source_config !== undefined) patch.source_config = jsonOrNull(body.source_config) ?? '{}';
    if (body.filter_expr !== undefined) patch.filter_expr = jsonOrNull(body.filter_expr);
    if (body.target_kind !== undefined) patch.target_kind = String(body.target_kind);
    if (body.target_config !== undefined) patch.target_config = jsonOrNull(body.target_config) ?? '{}';
    if (body.input_map !== undefined) patch.input_map = jsonOrNull(body.input_map);
    if (body.rate_limit_per_minute !== undefined) {
      patch.rate_limit_per_minute = body.rate_limit_per_minute === null ? null : Number(body.rate_limit_per_minute);
    }
    if (body.metadata !== undefined) patch.metadata = jsonOrNull(body.metadata);
    await db.updateTrigger(id, patch);
    if (handle) await handle.dispatcher.reload();
    const row = await db.getTrigger(id);
    json(res, 200, row);
  }, { auth: true, csrf: true });

  const delMethod = router.del.bind(router);
  delMethod('/api/admin/triggers/:id', async (_req: any, res: any, params: any, auth: any) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'Missing id' }); return; }
    await db.deleteTrigger(id);
    if (handle) await handle.dispatcher.reload();
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  router.post('/api/admin/triggers/:id/fire', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!handle) { json(res, 503, { error: 'Trigger dispatcher not wired' }); return; }
    const id = params['id'];
    if (!id) { json(res, 400, { error: 'Missing id' }); return; }
    const row = await db.getTrigger(id);
    if (!row) { json(res, 404, { error: 'Not found' }); return; }
    const body = parseJsonBody<{ payload?: unknown }>(await readBody(req)) ?? {};
    const payload = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : { value: body.payload ?? null };
    try {
      const inv = await handle.dispatcher.dispatch(
        { sourceKind: 'manual', payload, observedAt: Date.now() },
        { onlyTriggerId: id },
      );
      json(res, 200, { invocations: inv });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: msg });
    }
  }, { auth: true, csrf: true });

  router.get('/api/admin/trigger-invocations', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL((req as { url?: string }).url ?? '/', 'http://x');
    const triggerId = url.searchParams.get('triggerId') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const rows = await db.listTriggerInvocations({
      ...(triggerId ? { triggerId } : {}),
      ...(status ? { status } : {}),
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    json(res, 200, { invocations: rows });
  }, { auth: true });
}
