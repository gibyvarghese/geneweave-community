/**
 * GeneWeave — anyWeave Phase 6: A/B routing experiment evaluator.
 *
 * Picks an active experiment that matches a (task_key, tenant_id) tuple, then
 * uses a uniform random draw to decide whether the request should be routed
 * to the candidate model instead of the baseline.
 *
 * Selection rules:
 *   - status must be 'active'
 *   - task_key must match (or experiment.task_key IS NULL → wildcard)
 *   - tenant_id must match (or experiment.tenant_id IS NULL → wildcard)
 *   - first matching experiment wins (most recently created first via list order)
 *   - Math.random() < (traffic_pct / 100) → candidate; else baseline.
 *
 * Returns null if no experiment matched or candidate was not selected.
 */

import type { DatabaseAdapter } from './db.js';
import type { RoutingExperimentRow } from './db-types.js';

export interface ExperimentPick {
  experimentId: string;
  experimentName: string;
  selectedProvider: string;
  selectedModelId: string;
  baselineProvider: string;
  baselineModelId: string;
  trafficPct: number;
  /** Random draw value in [0,1). */
  draw: number;
}

export interface ExperimentLookupOpts {
  taskKey: string | null | undefined;
  tenantId: string | null | undefined;
  /** Inject for deterministic tests; defaults to Math.random. */
  rng?: () => number;
}

export async function pickExperimentCandidate(
  db: DatabaseAdapter,
  opts: ExperimentLookupOpts,
): Promise<ExperimentPick | null> {
  let rows: RoutingExperimentRow[];
  try {
    const listOpts: { status: string; taskKey?: string; tenantId?: string | null } = { status: 'active' };
    if (opts.taskKey) listOpts.taskKey = opts.taskKey;
    if (opts.tenantId !== undefined) listOpts.tenantId = opts.tenantId ?? null;
    rows = await db.listRoutingExperiments(listOpts);
  } catch {
    return null;
  }
  if (rows.length === 0) return null;

  // Prefer most-specific match: tenant+task > tenant > task > wildcard.
  const score = (r: RoutingExperimentRow) =>
    (r.tenant_id ? 2 : 0) + (r.task_key ? 1 : 0);
  rows.sort((a, b) => score(b) - score(a));

  const exp = rows[0]!;
  const draw = (opts.rng ?? Math.random)();
  if (draw >= exp.traffic_pct / 100) return null;

  return {
    experimentId: exp.id,
    experimentName: exp.name,
    selectedProvider: exp.candidate_provider,
    selectedModelId: exp.candidate_model_id,
    baselineProvider: exp.baseline_provider,
    baselineModelId: exp.baseline_model_id,
    trafficPct: exp.traffic_pct,
    draw,
  };
}
