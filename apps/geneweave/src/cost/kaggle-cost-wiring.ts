/**
 * Kaggle-specific cost-ledger wiring (Phase 1 of COST_CONTROL_PLAN.md).
 *
 * Builds a `ModelResolver` and a `ToolAuditEmitter` that wrap their inner
 * counterparts with cost-ledger emission scoped to the active Kaggle
 * competition run.
 *
 * Run-id resolution: live-agents only know about `meshId` and `agentId`.
 * Kaggle's runtime ledger lives in `kgl_competition_runs` keyed by `mesh_id`.
 * We maintain a tiny TTL cache so the per-tick lookup amortises to a single
 * `listKglCompetitionRuns` query every 30 s.
 */

import type {
  ModelResolver,
  ModelResolverContext,
} from '@weaveintel/live-agents';
import type { Model, ToolAuditEvent } from '@weaveintel/core';
import type { ToolAuditEmitter } from '@weaveintel/tools';
import {
  wrapModelWithCostLedger,
  wrapAuditEmitterWithCostLedger,
  type CostLedgerSink,
  type PricingResolver,
} from '@weaveintel/cost-governor';
import type { DatabaseAdapter } from '../db-types.js';
import { newUUIDv7 } from '../lib/uuid.js';

const RUN_LOOKUP_TTL_MS = 30_000;

/** Lazy mapper: meshId → kaggle competition run id (live runs only). */
class KaggleRunIdResolver {
  private byMesh = new Map<string, string>();
  private expiresAt = 0;
  private agentMeshCache = new Map<string, string | undefined>();

  constructor(private readonly db: DatabaseAdapter) {}

  async runIdForMesh(meshId: string): Promise<string | undefined> {
    await this.refreshIfStale();
    return this.byMesh.get(meshId);
  }

  async runIdForAgent(agentId: string): Promise<string | undefined> {
    let meshId = this.agentMeshCache.get(agentId);
    if (!this.agentMeshCache.has(agentId)) {
      try {
        const agent = await this.db.getLiveAgent?.(agentId);
        meshId = agent?.mesh_id ?? undefined;
      } catch {
        meshId = undefined;
      }
      this.agentMeshCache.set(agentId, meshId);
    }
    if (!meshId) return undefined;
    return this.runIdForMesh(meshId);
  }

  private async refreshIfStale(): Promise<void> {
    const now = Date.now();
    if (now < this.expiresAt) return;
    try {
      const runs = await this.db.listKglCompetitionRuns({ status: 'running' });
      const next = new Map<string, string>();
      for (const r of runs) {
        if (r.mesh_id) next.set(r.mesh_id, r.id);
      }
      this.byMesh = next;
    } catch {
      /* keep stale data */
    }
    this.expiresAt = now + RUN_LOOKUP_TTL_MS;
  }
}

export interface WrapKaggleResolversOptions {
  db: DatabaseAdapter;
  baseResolver: ModelResolver;
  auditInner: ToolAuditEmitter;
  sink: CostLedgerSink;
  pricing: PricingResolver;
}

export interface WrappedKaggleResolvers {
  modelResolver: ModelResolver;
  auditEmitter: ToolAuditEmitter;
}

/**
 * Compose the inner model resolver + audit emitter with cost-ledger
 * wrappers. All cost telemetry is best-effort: every failure inside the
 * mappers is swallowed so the underlying ReAct loop / tool call never
 * regresses.
 */
export function wrapKaggleResolversWithCostLedger(
  opts: WrapKaggleResolversOptions,
): WrappedKaggleResolvers {
  const { db, baseResolver, auditInner, sink, pricing } = opts;
  const runResolver = new KaggleRunIdResolver(db);

  const modelResolver: ModelResolver = {
    async resolve(ctx: ModelResolverContext): Promise<Model | undefined> {
      const inner = await baseResolver.resolve(ctx);
      if (!inner) return inner;
      let runId: string | undefined;
      if (ctx.meshId) runId = await runResolver.runIdForMesh(ctx.meshId);
      if (!runId && ctx.agentId) runId = await runResolver.runIdForAgent(ctx.agentId);
      if (!runId) return inner; // No cost tracking outside known runs.
      return wrapModelWithCostLedger(inner, {
        sink,
        pricing,
        newId: newUUIDv7,
        resolveContext: () => ({
          runId,
          ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
          ...(ctx.role    !== undefined ? { agentRole: ctx.role  } : {}),
        }),
      });
    },
  };

  const auditEmitter = wrapAuditEmitterWithCostLedger({
    inner: auditInner,
    sink,
    newId: newUUIDv7,
    resolveContext: async (event: ToolAuditEvent) => {
      const agentId = event.chatId; // kaggle wires chatId = agent.id
      if (!agentId) return null;
      const runId = await runResolver.runIdForAgent(agentId);
      if (!runId) return null;
      return {
        runId,
        agentId,
        ...(event.agentPersona !== undefined ? { agentRole: event.agentPersona } : {}),
      };
    },
  });

  return { modelResolver, auditEmitter };
}
