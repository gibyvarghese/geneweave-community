import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { newUUIDv7 } from '../../lib/uuid.js';

/**
 * Routing Simulator (anyWeave Phase 4 / M16).
 *
 * Lets an operator preview which model the task-aware router would pick for
 * a given task, optionally writing the trace to routing_decision_traces so it
 * appears in the trace tab.
 *
 * Uses a self-contained, DB-driven scoring identical in shape to the runtime
 * scorer (cost, quality, capability) so operator-facing previews stay
 * grounded in the same data.
 *
 * POST /api/admin/routing-simulator
 *   body: {
 *     taskKey: string,
 *     tenantId?: string | null,
 *     weights?: { cost?, quality?, capability?, speed? },
 *     requireTools?: boolean,
 *     requireVision?: boolean,
 *     requireStreaming?: boolean,
 *     requireJsonMode?: boolean,
 *     persist?: boolean,
 *   }
 */
export function registerRoutingSimulatorRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.post('/api/admin/routing-simulator', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const taskKey = String(body['taskKey'] ?? '');
    if (!taskKey) { json(res, 400, { error: 'taskKey required' }); return; }
    const tenantParam = body['tenantId'];
    const tenantId = typeof tenantParam === 'string' && tenantParam !== '' ? tenantParam : null;

    const taskType = await db.getTaskType(taskKey);
    if (!taskType) { json(res, 404, { error: `Task type '${taskKey}' not found` }); return; }

    // Resolve weights: explicit > tenant override > task type default.
    let weights: { cost: number; speed: number; quality: number; capability: number };
    let weightSource: 'explicit' | 'tenant_override' | 'task_default' = 'task_default';
    try { weights = JSON.parse(taskType.default_weights); } catch { weights = { cost: 0.25, speed: 0.25, quality: 0.25, capability: 0.25 }; }

    if (tenantId) {
      const overrides = await db.listTaskTypeTenantOverrides({ tenantId, taskKey });
      const ov = overrides[0];
      if (ov?.weights) {
        try { weights = JSON.parse(ov.weights); weightSource = 'tenant_override'; } catch { /* keep default */ }
      }
    }
    const explicitWeights = body['weights'] as Record<string, number> | undefined;
    if (explicitWeights && typeof explicitWeights === 'object') {
      weights = {
        cost: Number(explicitWeights['cost'] ?? weights.cost),
        speed: Number(explicitWeights['speed'] ?? weights.speed),
        quality: Number(explicitWeights['quality'] ?? weights.quality),
        capability: Number(explicitWeights['capability'] ?? weights.capability),
      };
      weightSource = 'explicit';
    }

    // Load capability scores for this task. Fall back to global (NULL tenant)
    // when no tenant-scoped row exists for a given (model, provider).
    const tenantScores = tenantId ? await db.listCapabilityScores({ taskKey, tenantId }) : [];
    const globalScores = await db.listCapabilityScores({ taskKey, tenantId: null });
    const merged = new Map<string, typeof globalScores[number]>();
    for (const s of globalScores) merged.set(`${s.provider}::${s.model_id}`, s);
    for (const s of tenantScores) merged.set(`${s.provider}::${s.model_id}`, s);

    const requireTools = body['requireTools'] === true;
    const requireVision = body['requireVision'] === true;
    const requireStreaming = body['requireStreaming'] === true;
    const requireJsonMode = body['requireJsonMode'] === true;

    const filtered = [...merged.values()].filter(s => {
      if (!s.is_active) return false;
      if (requireTools && !s.supports_tools) return false;
      if (requireVision && !s.supports_vision) return false;
      if (requireStreaming && !s.supports_streaming) return false;
      if (requireJsonMode && !s.supports_json_mode) return false;
      return true;
    });

    // Pricing for cost dimension.
    const pricing = await db.listModelPricing();
    const priceMap = new Map(pricing.map(p => [`${p.provider}::${p.model_id}`, p]));
    const costs = filtered.map(s => {
      const p = priceMap.get(`${s.provider}::${s.model_id}`);
      return p ? p.input_cost_per_1m + p.output_cost_per_1m : null;
    });
    const validCosts = costs.filter((c): c is number => c !== null && c > 0);
    const maxCost = validCosts.length > 0 ? Math.max(...validCosts) : 1;

    // Compute per-candidate score.
    const candidates = filtered.map((s, i) => {
      const totalCost = costs[i];
      const costScore = totalCost == null || maxCost === 0 ? 0.5 : 1 - (totalCost / maxCost);
      const qualityScore = (s.quality_score ?? 0) / 100;       // normalise 0–100 → 0–1
      const capabilityScore = (s.quality_score ?? 0) / 100;     // capability == quality for this task
      // Speed proxy: presence of streaming + json mode (rough heuristic — DB-grounded benchmark TBD).
      const speedScore = (s.supports_streaming ? 0.5 : 0) + (s.supports_json_mode ? 0.5 : 0);

      const breakdown = {
        cost: costScore,
        speed: speedScore,
        quality: qualityScore,
        capability: capabilityScore,
      };
      const overall =
        breakdown.cost * weights.cost +
        breakdown.speed * weights.speed +
        breakdown.quality * weights.quality +
        breakdown.capability * weights.capability;

      return {
        modelId: s.model_id,
        provider: s.provider,
        capabilityScore: s.quality_score,
        supportsTools: !!s.supports_tools,
        supportsStreaming: !!s.supports_streaming,
        supportsVision: !!s.supports_vision,
        supportsJsonMode: !!s.supports_json_mode,
        estimatedCostPer1M: totalCost,
        breakdown,
        overall,
      };
    });
    candidates.sort((a, b) => b.overall - a.overall);

    const winner = candidates[0] ?? null;

    // Optional persistence to traces for downstream tab visibility.
    let traceId: string | null = null;
    if (body['persist'] === true && winner) {
      traceId = newUUIDv7();
      await db.insertRoutingDecisionTrace({
        id: traceId,
        tenant_id: tenantId,
        agent_id: null,
        workflow_step_id: null,
        task_key: taskKey,
        inference_source: 'simulator',
        selected_model_id: winner.modelId,
        selected_provider: winner.provider,
        selected_capability_score: winner.capabilityScore,
        weights_used: JSON.stringify(weights),
        candidate_breakdown: JSON.stringify(candidates.slice(0, 10)),
        tool_translation_applied: 0,
        source_provider: null,
        estimated_cost_usd: winner.estimatedCostPer1M ?? null,
      });
    }

    json(res, 200, {
      taskType,
      weightsUsed: weights,
      weightSource,
      filtersApplied: { requireTools, requireVision, requireStreaming, requireJsonMode },
      candidatesEvaluated: candidates.length,
      candidates: candidates.slice(0, 25),
      winner,
      traceId,
    });
  }, { auth: true, csrf: true });
}
