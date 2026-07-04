/**
 * Phase 1 (COST_CONTROL_PLAN.md) — Cost ledger admin routes.
 *
 *   GET /api/admin/runs/:runId/cost-ledger        → CostBreakdown
 *   GET /api/admin/runs/:runId/cost-ledger/raw    → raw CostLedgerEntry[]
 *
 * Replays `cost.tick` rows from `live_run_events` and aggregates with
 * `aggregate(runId, entries)` from `@weaveintel/cost-governor`.
 */

import type { DatabaseAdapter } from '../../db-types.js';
import { COST_TICK_KIND, readCostBreakdown } from '../../cost/db-cost-ledger.js';
import type { CostLedgerEntry } from '@weaveintel/cost-governor';

export interface CostLedgerRouterLike {
  get(path: string, handler: (req: any, res: any, params: any, auth: any) => Promise<void> | void, opts?: { auth?: boolean; csrf?: boolean }): void;
}

export interface CostLedgerRouteHelpers {
  json: (res: any, status: number, body: unknown) => void;
}

export function registerCostLedgerRoutes(
  router: CostLedgerRouterLike,
  db: DatabaseAdapter,
  helpers: CostLedgerRouteHelpers,
): void {
  const { json } = helpers;

  router.get('/api/admin/runs/:runId/cost-ledger', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const runId = params['runId'];
    if (!runId) { json(res, 400, { error: 'Missing runId' }); return; }
    const breakdown = await readCostBreakdown(db, runId, { limit: 5000 });
    json(res, 200, breakdown);
  }, { auth: true });

  router.get('/api/admin/runs/:runId/cost-ledger/raw', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const runId = params['runId'];
    if (!runId) { json(res, 400, { error: 'Missing runId' }); return; }
    const events = await db.listLiveRunEvents({ runId, limit: 5000 });
    const entries: CostLedgerEntry[] = [];
    for (const e of events) {
      if (e.kind !== COST_TICK_KIND || !e.payload_json) continue;
      try {
        const parsed = JSON.parse(e.payload_json) as CostLedgerEntry;
        if (parsed && typeof parsed.costUsd === 'number') entries.push(parsed);
      } catch {/* skip malformed */}
    }
    json(res, 200, { runId, count: entries.length, entries });
  }, { auth: true });
}
