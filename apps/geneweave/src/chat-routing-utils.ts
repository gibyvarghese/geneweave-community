/**
 * GeneWeave chat — model routing and cache policy resolution
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import { createLogger } from '@weaveintel/core';
import type { CachePolicy, ModelHealth, OutputModality, RoutingToolDescriptor as ToolDescriptor } from '@weaveintel/core';

const logger = createLogger('chat-routing');
import { SmartModelRouter } from '@weaveintel/routing';
import type { ModelCostInfo, ModelQualityInfo } from '@weaveintel/routing';
import type { ModelCapabilityRow, TaskTypeInferenceHints } from '@weaveintel/core';
import type { TaskInferenceHintsMap } from '@weaveintel/routing';
import { resolvePolicy } from '@weaveintel/cache';
import { FALLBACK_PRICING } from './chat-runtime.js';
import type { DatabaseAdapter } from './db.js';
import { SqliteDecisionStore } from './sqlite-decision-store.js';
import { getCapabilityMatrixCache } from './capability-matrix-cache.js';
import { pickExperimentCandidate } from './routing-experiments.js';

// ── Model routing ────────────────────────────────────────────

export interface RouteModelOpts {
  provider?: string;
  model?: string;
  /** Phase 2: explicit task key override (takes priority over inference). */
  taskType?: string;
  /** Phase 2: tools the agent will use (used for tool-pattern inference). */
  tools?: ToolDescriptor[];
  /** Phase 2: skill metadata for inference. */
  skill?: { key?: string; category?: string; tags?: string[] };
  /** Phase 2: user prompt text (used for keyword-based inference). */
  prompt?: string;
  /** Phase 2: agent default task type from agents.default_task_type. */
  agentDefaultTaskType?: string | null;
  /** Phase 2: required output modality for filtering. */
  outputModality?: OutputModality;
  /** Phase 2: per-call cost ceiling in USD. */
  maxCostPerCall?: number;
  /** Phase 2: trace correlation IDs. */
  tenantId?: string | null;
  agentId?: string | null;
  workflowStepId?: string | null;
}

/**
 * Select model + provider using the active routing policy from the DB.
 * Returns null if no enabled policy exists (caller falls back to default).
 */
export async function routeModel(
  db: DatabaseAdapter,
  candidates: Array<{ id: string; provider: string }>,
  healthList: ModelHealth[],
  opts?: RouteModelOpts,
  blockedProviders?: Set<string>,
): Promise<{ provider: string; modelId: string; taskKey?: string; inferenceSource?: string; experimentId?: string; experimentName?: string } | null> {
  try {
    const policies = await db.listRoutingPolicies();
    const active = policies.find(p => p.enabled);
    if (!active) return null;

    // Pre-filter candidates from providers blocked at the account level (e.g. rate limited).
    const filteredCandidates = blockedProviders?.size
      ? candidates.filter(c => !blockedProviders.has(c.provider))
      : candidates;

    const routerCandidates = filteredCandidates.map(m => ({
      modelId: m.id,
      providerId: m.provider,
    }));

    if (routerCandidates.length === 0) return null;

    // Load pricing & quality from DB (falls back to hardcoded if DB is empty).
    // Phase 6: pricing/task-types/capability-scores all served from a 60 s TTL cache
    // to keep the per-turn routing path on the cache-hit fast path.
    const matrixCache = getCapabilityMatrixCache();
    const pricingRows = await matrixCache.getModelPricing(db);
    const pricingMap = new Map(pricingRows.filter(r => r.enabled).map(r => [`${r.provider}:${r.model_id}`, r]));

    // Cost data from DB model_pricing table
    const costs: ModelCostInfo[] = routerCandidates.map(c => {
      const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
      const fb = FALLBACK_PRICING[c.modelId];
      return {
        modelId: c.modelId,
        providerId: c.providerId,
        inputCostPer1M: row ? row.input_cost_per_1m : fb ? fb.input : 10,
        outputCostPer1M: row ? row.output_cost_per_1m : fb ? fb.output : 30,
      };
    });

    // Quality scores from DB model_pricing table
    const qualities: ModelQualityInfo[] = routerCandidates.map(c => {
      const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
      return {
        modelId: c.modelId,
        providerId: c.providerId,
        qualityScore: row ? row.quality_score : 0.7,
      };
    });

    // ── Phase 2: task-aware data ──────────────────────────────
    let capabilityRows: ModelCapabilityRow[] = [];
    const taskInferenceHints: TaskInferenceHintsMap = new Map();
    const modalityMap = new Map<string, OutputModality>();

    try {
      const taskTypes = await matrixCache.getTaskTypes(db);
      for (const t of taskTypes) {
        if (!t.enabled) continue;
        let raw: Record<string, unknown> = {};
        try { raw = JSON.parse(t.inference_hints) as Record<string, unknown>; } catch { /* ignore */ }
        // Normalize legacy seed shape: accept `keywords`/`tools`/`categories`/`tags`
        // as aliases for the spec field names.
        const hints: TaskTypeInferenceHints = {
          promptKeywords: (raw['promptKeywords'] as string[]) ?? (raw['keywords'] as string[]),
          toolPatterns: (raw['toolPatterns'] as string[]) ?? (raw['tools'] as string[]),
          skillCategories: (raw['skillCategories'] as string[]) ?? (raw['categories'] as string[]),
          skillTags: (raw['skillTags'] as string[]) ?? (raw['tags'] as string[]),
        };
        taskInferenceHints.set(t.task_key, hints);
      }
    } catch { /* table missing → graceful no-op */ }

    try {
      const scoreRows = await matrixCache.getCapabilityScores(db, opts?.tenantId ?? null);
      capabilityRows = scoreRows.map(r => ({
        modelId: r.model_id,
        providerId: r.provider,
        taskKey: r.task_key,
        qualityScore: r.quality_score,
        supportsTools: !!r.supports_tools,
        supportsStreaming: !!r.supports_streaming,
        supportsThinking: !!r.supports_thinking,
        supportsJsonMode: !!r.supports_json_mode,
        supportsVision: !!r.supports_vision,
        isActive: r.is_active === 1,
        tenantId: r.tenant_id,
      }));
      // Build modality map from model_pricing.output_modality if available
      for (const r of pricingRows) {
        const mod = (r as { output_modality?: string }).output_modality;
        if (mod) modalityMap.set(`${r.provider}:${r.model_id}`, mod as OutputModality);
      }
    } catch { /* table missing → graceful no-op */ }

    const decisionStore = new SqliteDecisionStore(db, {
      tenantId: opts?.tenantId ?? null,
      agentId: opts?.agentId ?? null,
      workflowStepId: opts?.workflowStepId ?? null,
      weights: active.weights ? safeParse(active.weights) : undefined,
    });

    const router = new SmartModelRouter({
      candidates: routerCandidates,
      costs,
      qualities,
      initialHealth: healthList,
      capabilityRows,
      taskInferenceHints,
      modalityMap,
      decisionStore,
    });

    const decision = await router.route(
      {
        prompt: opts?.prompt ?? '',
        context: {
          taskType: opts?.taskType,
          tools: opts?.tools,
          skill: opts?.skill,
          prompt: opts?.prompt,
          outputModality: opts?.outputModality,
          maxCostPerCall: opts?.maxCostPerCall,
          tenantId: opts?.tenantId ?? undefined,
          agentId: opts?.agentId ?? undefined,
        },
      },
      {
        id: active.id,
        name: active.name,
        strategy: active.strategy as any,
        constraints: active.constraints ? safeParse(active.constraints) : undefined,
        weights: active.weights ? safeParse(active.weights) : undefined,
        fallbackModelId: active.fallback_model ?? undefined,
        fallbackProviderId: active.fallback_provider ?? undefined,
        fallbackChain: (active as { fallback_chain?: string }).fallback_chain ? safeParse((active as { fallback_chain?: string }).fallback_chain!) : undefined,
        enabled: true,
      },
    );

    // Phase 6: A/B experiment override. If an active experiment matches the
    // resolved task_key + tenant tuple and the random draw lands inside its
    // traffic_pct window, swap the provider/model to the candidate.
    const decisionTaskKey = decision.taskMeta?.taskKey ?? opts?.taskType ?? null;
    const experimentPick = await pickExperimentCandidate(db, {
      taskKey: decisionTaskKey ?? undefined,
      tenantId: opts?.tenantId ?? null,
    });

    if (experimentPick) {
      // Only swap if the candidate model is in the eligible candidate set
      // (skipping silently if the candidate isn't actually deployed).
      const candidateExists = candidates.some(c => c.id === experimentPick.selectedModelId && c.provider === experimentPick.selectedProvider);
      if (candidateExists) {
        return {
          provider: experimentPick.selectedProvider,
          modelId: experimentPick.selectedModelId,
          taskKey: decision.taskMeta?.taskKey,
          inferenceSource: decision.taskMeta?.inferenceSource,
          experimentId: experimentPick.experimentId,
          experimentName: experimentPick.experimentName,
        };
      }
    }

    return {
      provider: decision.providerId,
      modelId: decision.modelId,
      taskKey: decision.taskMeta?.taskKey,
      inferenceSource: decision.taskMeta?.inferenceSource,
    };
  } catch (err) {
    logger.error('model routing failed, falling back to null', { err });
    return null;
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ── Cache policy resolution ──────────────────────────────────

/**
 * Resolve the best-matching cache policy from admin-configured policies.
 */
export async function resolveActiveCache(
  db: DatabaseAdapter,
  _mode: string,
): Promise<CachePolicy | null> {
  try {
    const rows = await db.listCachePolicies();
    const enabled = rows.filter(r => r.enabled);
    if (!enabled.length) return null;
    const policies: CachePolicy[] = enabled.map(r => ({
      id: r.id,
      name: r.name,
      scope: (r.scope as CachePolicy['scope']) ?? 'global',
      ttlMs: r.ttl_ms ?? 300_000,
      maxEntries: r.max_entries ?? 1000,
      maxBytes: r.max_bytes ?? 0,
      bypassPatterns: r.bypass_patterns ? JSON.parse(r.bypass_patterns) : [],
      outputBypassPatterns: r.output_bypass_patterns ? JSON.parse(r.output_bypass_patterns) : [],
      invalidateOnEvents: r.invalidate_on ? JSON.parse(r.invalidate_on) : [],
      // Phase 0 hardening — secure-by-default when columns are absent on legacy rows.
      keyHashing: (r.key_hashing as 'none' | 'sha256') ?? 'sha256',
      tenantIsolation: r.tenant_isolation == null ? true : !!r.tenant_isolation,
      temperatureGate: r.cache_temperature_gate ?? 0,
      // Phase 7 — stampede protection & cost-aware eviction knobs.
      swrMs: r.swr_ms ?? 0,
      negativeTtlMs: r.negative_ttl_ms ?? 0,
      evictionPolicy: (r.eviction_policy as CachePolicy['evictionPolicy']) ?? 'lru',
      enabled: true,
    }));
    return resolvePolicy(policies, {}) ?? null;
  } catch {
    return null;
  }
}
