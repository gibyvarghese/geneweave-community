/**
 * Geneweave-side cost-ledger plumbing for Phase 1 of COST_CONTROL_PLAN.md.
 *
 *  - DbCostLedgerSink   — implements `CostLedgerSink` over `live_run_events`
 *                         using `kind = 'cost.tick'` and `payload_json`.
 *  - DbPricingResolver  — implements `PricingResolver` over `model_pricing`
 *                         with a 60s TTL cache.
 *  - readCostBreakdown  — replays `cost.tick` rows for a runId and returns
 *                         the aggregated `CostBreakdown`.
 *
 * Best-effort throughout — sink failures and pricing errors never bubble
 * into the model/tool hot path.
 */

import type {
  CostLedgerEntry,
  CostLedgerSink,
  CostBreakdown,
  PricingRate,
  PricingResolver,
} from '@weaveintel/cost-governor';
import { aggregate } from '@weaveintel/cost-governor';
import type { DatabaseAdapter } from '../db-types.js';

export const COST_TICK_KIND = 'cost.tick';

export class DbCostLedgerSink implements CostLedgerSink {
  constructor(private readonly db: DatabaseAdapter) {}

  async append(entry: CostLedgerEntry): Promise<void> {
    try {
      await this.db.appendLiveRunEvent({
        id: entry.id,
        run_id: entry.runId,
        step_id: entry.stepId ?? null,
        kind: COST_TICK_KIND,
        agent_id: entry.agentId ?? null,
        tool_key: entry.source === 'tool' ? entry.subject : null,
        summary: `${entry.source}:${entry.subject} $${entry.costUsd.toFixed(6)}`,
        payload_json: JSON.stringify(entry),
      });
    } catch {
      /* swallow — observational layer must never break callers */
    }
  }
}

interface PricingCacheEntry { rate: PricingRate | null; expiresAt: number; }

export class DbPricingResolver implements PricingResolver {
  private readonly ttlMs: number;
  private readonly cache = new Map<string, PricingCacheEntry>();
  private rowsCache: { rows: Map<string, PricingRate>; expiresAt: number } | null = null;

  constructor(private readonly db: DatabaseAdapter, opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  async resolve(modelId: string): Promise<PricingRate | null> {
    const now = Date.now();
    const cached = this.cache.get(modelId);
    if (cached && cached.expiresAt > now) return cached.rate;

    const rate = await this.lookup(modelId, now);
    this.cache.set(modelId, { rate, expiresAt: now + this.ttlMs });
    return rate;
  }

  private async lookup(modelId: string, now: number): Promise<PricingRate | null> {
    if (!this.rowsCache || this.rowsCache.expiresAt <= now) {
      try {
        const rows = await this.db.listModelPricing();
        const map = new Map<string, PricingRate>();
        for (const r of rows) {
          if (!r.enabled) continue;
          const rate: PricingRate = {
            inputPerMillion: r.input_cost_per_1m,
            outputPerMillion: r.output_cost_per_1m,
          };
          map.set(r.model_id, rate);
          map.set(`${r.provider}:${r.model_id}`, rate);
        }
        this.rowsCache = { rows: map, expiresAt: now + this.ttlMs };
      } catch {
        return null;
      }
    }
    return this.rowsCache.rows.get(modelId) ?? null;
  }
}

/** Replay cost.tick rows for a run and aggregate them into a breakdown. */
export async function readCostBreakdown(
  db: DatabaseAdapter,
  runId: string,
  opts: { limit?: number } = {},
): Promise<CostBreakdown> {
  const events = await db.listLiveRunEvents({ runId, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
  const entries: CostLedgerEntry[] = [];
  for (const e of events) {
    if (e.kind !== COST_TICK_KIND || !e.payload_json) continue;
    try {
      const parsed = JSON.parse(e.payload_json) as CostLedgerEntry;
      if (parsed && typeof parsed.costUsd === 'number') entries.push(parsed);
    } catch {/* skip malformed */}
  }
  return aggregate(runId, entries);
}
