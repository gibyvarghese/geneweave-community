/**
 * Phase 6 — DB-backed `IntelScoreProvider` for the kaggle live mesh.
 *
 * Computes a `[0, 1]` "intel maturity" score for the mesh's currently
 * running competition run from observable signals on `kgl_competition_run`
 * + `kgl_run_event`. Higher score = more accumulated context, so the
 * cost-governor's intel gate can safely drop the intel header / snippets
 * from the prepare() and rely on the model's existing context window.
 *
 * Reusability: this provider is geneweave-specific (it queries kaggle DB
 * tables). Other apps wire their own `IntelScoreProvider` against their
 * own signals; the `@weaveintel/cost-governor` package never depends on
 * geneweave types.
 *
 * Score formula (5 × 0.2 weighted features):
 *   +0.2 if `objective` is set on the run row
 *   +0.2 if `title`     is set on the run row
 *   +0.2 if any `step_completed` event has fired
 *   +0.2 if any `kernel_pushed`  event has fired
 *   +0.2 if `step_count >= 3` (the run has progressed past the first cycle)
 *
 * Returns `null` when there is no running competition_run for the mesh.
 * Throws are caught by the cost-governor wrapper and treated as `null`.
 */

import type { IntelScore, IntelScoreContext, IntelScoreProvider } from '@weaveintel/cost-governor';
import type { DatabaseAdapter } from '../db-types.js';

export interface DbIntelScoreProviderOptions {
  readonly db: DatabaseAdapter;
  readonly tenantId?: string | null;
  readonly log?: (msg: string) => void;
}

const NOTABLE_EVENT_KINDS = new Set(['step_completed', 'kernel_pushed']);

export function createDbIntelScoreProvider(opts: DbIntelScoreProviderOptions): IntelScoreProvider {
  const { db, tenantId, log } = opts;
  return {
    async compute(ctx: IntelScoreContext): Promise<IntelScore | null> {
      const meshId = ctx.meshId;
      if (!meshId) return null;

      let runs;
      try {
        runs = await db.listKglCompetitionRuns({
          status: 'running',
          ...(tenantId !== undefined ? { tenantId } : {}),
          limit: 50,
        });
      } catch (err) {
        log?.(`listKglCompetitionRuns threw: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }

      const run = runs.find((r) => r.mesh_id === meshId);
      if (!run) return null;

      let events;
      try {
        events = await db.listKglRunEvents(run.id, { limit: 500 });
      } catch (err) {
        log?.(`listKglRunEvents threw: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }

      const notable = new Set<string>();
      for (const e of events) {
        if (NOTABLE_EVENT_KINDS.has(e.kind)) notable.add(e.kind);
      }

      let score = 0;
      const reasons: string[] = [];
      if (run.objective) { score += 0.2; reasons.push('objective'); }
      if (run.title)     { score += 0.2; reasons.push('title'); }
      if (notable.has('step_completed')) { score += 0.2; reasons.push('step_completed'); }
      if (notable.has('kernel_pushed'))  { score += 0.2; reasons.push('kernel_pushed'); }
      if (run.step_count >= 3)           { score += 0.2; reasons.push('steps>=3'); }

      // Clamp to [0, 1] (defensive — formula already bounds it).
      const clamped = Math.max(0, Math.min(1, score));
      log?.(`intel-score mesh=${meshId} run=${run.id} score=${clamped.toFixed(2)} signals=[${reasons.join(',')}]`);
      return clamped;
    },
  };
}
