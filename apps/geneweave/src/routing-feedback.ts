/**
 * GeneWeave — anyWeave Task-Aware Routing Phase 5: Feedback Loop
 *
 * Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md §13 Phase 5
 *
 * Four signal channels feed into model_capability_scores via this module:
 *   1. eval        — recordEvalSignal()       (call from eval-run completion)
 *   2. chat        — recordChatFeedbackSignal() (call from POST /api/messages/:id/feedback)
 *   3. cache       — recordCacheQualitySignal() (call from cache admission scorer)
 *   4. production  — recordProductionSignal() (call from chat engine post-completion)
 *
 * recordCapabilitySignal() is the unified entry point: appends to
 * routing_capability_signals and updates production_signal_score using a
 * running mean. The benchmark quality_score is preserved separately.
 *
 * runRoutingRegressionJob() runs once a day, computes 7d vs 30d rolling
 * averages from signals, emits routing_surface_items on regressions, and
 * auto-disables capability rows on >20% drops.
 */

import { createLogger } from '@weaveintel/core';
import type { DatabaseAdapter, RoutingCapabilitySignalRow, ModelCapabilityScoreRow } from './db-types.js';
import { newUUIDv7 } from './lib/uuid.js';

const logger = createLogger('routing-feedback');

export type SignalSource = 'eval' | 'chat' | 'cache' | 'production';

export interface RecordSignalInput {
  modelId: string;
  provider: string;
  taskKey: string;
  source: SignalSource;
  signalType: string;
  /** 0–100 normalised score for this single signal. */
  value: number;
  /** Multiplier when blending into rolling average. Default 1.0. */
  weight?: number;
  tenantId?: string | null;
  evidenceId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RecordSignalResult {
  signalId: string;
  /** Capability row that was recomputed (null if no row matched and we skipped). */
  capabilityId: string | null;
  productionSignalScore: number | null;
  signalSampleCount: number;
}

const VALID_CHAT_SIGNALS = new Set(['thumbs_up', 'thumbs_down', 'regenerate', 'copy']);

/**
 * Map a chat UI signal to a 0–100 quality contribution.
 *   thumbs_up   →  90  (strong positive)
 *   copy        →  75  (mild positive — user found it useful)
 *   regenerate  →  35  (mild negative — output not good enough)
 *   thumbs_down →  10  (strong negative)
 */
export function chatSignalToValue(signal: string): number | null {
  switch (signal) {
    case 'thumbs_up':   return 90;
    case 'copy':        return 75;
    case 'regenerate':  return 35;
    case 'thumbs_down': return 10;
    default:            return null;
  }
}

/**
 * Append a signal and update the matching model_capability_scores row's
 * production_signal_score using an incremental running mean. The benchmark
 * `quality_score` is *not* mutated here — it remains the seeded baseline.
 */
export async function recordCapabilitySignal(
  db: DatabaseAdapter,
  input: RecordSignalInput,
): Promise<RecordSignalResult> {
  const signalId = newUUIDv7();
  await db.insertRoutingCapabilitySignal({
    id: signalId,
    tenant_id: input.tenantId ?? null,
    model_id: input.modelId,
    provider: input.provider,
    task_key: input.taskKey,
    source: input.source,
    signal_type: input.signalType,
    value: input.value,
    weight: input.weight ?? 1.0,
    evidence_id: input.evidenceId ?? null,
    message_id: input.messageId ?? null,
    trace_id: input.traceId ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });

  // Find capability row (tenant-specific first, then global default).
  const tenantRows = input.tenantId
    ? await db.listCapabilityScores({ tenantId: input.tenantId, modelId: input.modelId, provider: input.provider, taskKey: input.taskKey })
    : [];
  const globalRows = tenantRows.length > 0
    ? []
    : await db.listCapabilityScores({ tenantId: null, modelId: input.modelId, provider: input.provider, taskKey: input.taskKey });
  const cap: ModelCapabilityScoreRow | undefined = tenantRows[0] ?? globalRows[0];

  if (!cap) {
    return { signalId, capabilityId: null, productionSignalScore: null, signalSampleCount: 0 };
  }

  // Incremental running mean: newMean = oldMean + (value - oldMean) / (n + 1)
  const oldCount = cap.signal_sample_count ?? 0;
  const oldMean  = cap.production_signal_score ?? cap.quality_score; // bootstrap from benchmark
  const w        = input.weight ?? 1.0;
  const effectiveWeight = w / (oldCount + w);
  const newMean  = oldMean + (input.value - oldMean) * effectiveWeight;
  const newCount = oldCount + 1;

  await db.updateCapabilityScore(cap.id, {
    production_signal_score: Number(newMean.toFixed(2)),
    signal_sample_count: newCount,
    last_evaluated_at: new Date().toISOString(),
  });

  return {
    signalId,
    capabilityId: cap.id,
    productionSignalScore: Number(newMean.toFixed(2)),
    signalSampleCount: newCount,
  };
}

/**
 * Convenience: ingest a chat UI feedback signal (👍/👎/regenerate/copy).
 *
 * m137: `categories` carries the small fixed taxonomy of WHY an answer got a thumbs-down (see
 * @weaveintel/collab FEEDBACK_CATEGORIES) — stored alongside the signal so down-votes become an
 * actionable, aggregatable reason and not just a free-text comment. modelId/provider/taskKey are the resolved
 * routing decision; when they are present the feedback ALSO updates the model's production quality score
 * (the routing learning loop). When they are absent (e.g. a message whose decision wasn't snapshotted), the
 * raw feedback is still persisted — we simply skip the capability-signal update.
 */
export async function recordChatFeedbackSignal(
  db: DatabaseAdapter,
  input: { signal: string; messageId: string; modelId?: string | null; provider?: string | null; taskKey?: string | null; tenantId?: string | null; chatId?: string | null; userId?: string | null; comment?: string | null; categories?: string[] | null; },
): Promise<RecordSignalResult & { feedbackId: string }> {
  if (!VALID_CHAT_SIGNALS.has(input.signal)) {
    throw new Error(`Invalid chat feedback signal: ${input.signal}`);
  }
  const value = chatSignalToValue(input.signal);
  if (value === null) throw new Error(`No mapping for signal: ${input.signal}`);

  const feedbackId = newUUIDv7();
  await db.insertMessageFeedback({
    id: feedbackId,
    message_id: input.messageId,
    chat_id: input.chatId ?? null,
    user_id: input.userId ?? null,
    signal: input.signal,
    comment: input.comment ?? null,
    categories: input.categories && input.categories.length ? JSON.stringify(input.categories) : null,
    tenant_id: input.tenantId ?? null,
    model_id: input.modelId ?? null,
    provider: input.provider ?? null,
    task_key: input.taskKey ?? null,
  });

  // Feed the routing quality signal only when we have the resolved decision to attribute it to.
  if (input.modelId && input.provider && input.taskKey) {
    const sigResult = await recordCapabilitySignal(db, {
      modelId: input.modelId,
      provider: input.provider,
      taskKey: input.taskKey,
      source: 'chat',
      signalType: input.signal,
      value,
      tenantId: input.tenantId ?? null,
      messageId: input.messageId,
    });
    return { ...sigResult, feedbackId };
  }
  return { signalId: '', capabilityId: null, productionSignalScore: null, signalSampleCount: 0, feedbackId };
}

// ─── Regression detection ─────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const REGRESSION_INTERVAL_MS = DAY_MS;
const WARN_DROP_PCT = 10;
const CRITICAL_DROP_PCT = 20;
const MIN_SAMPLES_7D = 5;

interface WindowStats { mean: number | null; count: number; }

function computeWindow(rows: RoutingCapabilitySignalRow[], cutoffIso: string): WindowStats {
  const filtered = rows.filter((r) => r.created_at >= cutoffIso);
  if (filtered.length === 0) return { mean: null, count: 0 };
  let sum = 0; let weight = 0;
  for (const r of filtered) {
    const w = r.weight ?? 1.0;
    sum += r.value * w;
    weight += w;
  }
  return { mean: weight > 0 ? sum / weight : null, count: filtered.length };
}

interface RegressionGroupKey { tenantId: string | null; modelId: string; provider: string; taskKey: string; }

function groupSignals(rows: RoutingCapabilitySignalRow[]): Map<string, { key: RegressionGroupKey; rows: RoutingCapabilitySignalRow[] }> {
  const out = new Map<string, { key: RegressionGroupKey; rows: RoutingCapabilitySignalRow[] }>();
  for (const r of rows) {
    const k = `${r.tenant_id ?? '_'}|${r.model_id}|${r.provider}|${r.task_key}`;
    let entry = out.get(k);
    if (!entry) {
      entry = { key: { tenantId: r.tenant_id, modelId: r.model_id, provider: r.provider, taskKey: r.task_key }, rows: [] };
      out.set(k, entry);
    }
    entry.rows.push(r);
  }
  return out;
}

export interface RegressionRunResult {
  groupsEvaluated: number;
  surfaceItemsEmitted: number;
  autoDisabled: number;
  durationMs: number;
}

/**
 * Run one pass of the regression detection job. Computes 7d vs 30d rolling
 * averages, emits routing_surface_items on >10% drops, auto-disables on >20%.
 */
export async function runRoutingRegressionPass(db: DatabaseAdapter): Promise<RegressionRunResult> {
  const startedAt = Date.now();
  const now = new Date();
  const cutoff7  = new Date(now.getTime() - 7  * DAY_MS).toISOString();
  const cutoff30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();

  const rows = await db.listRoutingCapabilitySignals({ afterIso: cutoff30, limit: 5000 });
  if (rows.length >= 5000) {
    logger.warn('signal query returned 5000 rows (limit hit) — regression window may be operating on incomplete data. Consider raising the limit or purging old signals.');
  }
  const groups = groupSignals(rows);

  let emitted = 0;
  let disabled = 0;

  for (const { key, rows: grp } of groups.values()) {
    const w7  = computeWindow(grp, cutoff7);
    const w30 = computeWindow(grp, cutoff30);

    if (w7.count < MIN_SAMPLES_7D || w7.mean === null || w30.mean === null) continue;
    if (w30.mean <= 0) continue;

    const dropPct = ((w30.mean - w7.mean) / w30.mean) * 100;
    if (dropPct < WARN_DROP_PCT) continue;

    const severity = dropPct >= CRITICAL_DROP_PCT ? 'critical' : 'warning';
    const autoDisable = dropPct >= CRITICAL_DROP_PCT;

    // Auto-disable if critical: atomically flip is_active=0 on all matching
    // capability rows in a single DB transaction (M-9: non-atomic loop fix).
    if (autoDisable) {
      const caps = await db.listCapabilityScores({
        tenantId: key.tenantId,
        modelId: key.modelId,
        provider: key.provider,
        taskKey: key.taskKey,
      });
      if (caps.length > 0) {
        await db.bulkDisableCapabilityScores(caps.map((c) => c.id));
        disabled += caps.length;
      }
    }

    await db.insertRoutingSurfaceItem({
      id: newUUIDv7(),
      kind: autoDisable ? 'auto_disabled' : 'quality_regression',
      severity,
      model_id: key.modelId,
      provider: key.provider,
      task_key: key.taskKey,
      tenant_id: key.tenantId,
      message: `${key.provider}/${key.modelId} on task '${key.taskKey}' dropped ${dropPct.toFixed(1)}% (7d avg ${w7.mean.toFixed(1)} vs 30d avg ${w30.mean.toFixed(1)})${autoDisable ? ' — auto-disabled' : ''}`,
      metric_7d: Number(w7.mean.toFixed(2)),
      metric_30d: Number(w30.mean.toFixed(2)),
      drop_pct: Number(dropPct.toFixed(2)),
      sample_count_7d: w7.count,
      sample_count_30d: w30.count,
      auto_disabled: autoDisable ? 1 : 0,
      status: 'open',
      resolution_note: null,
    });
    emitted++;
  }

  return {
    groupsEvaluated: groups.size,
    surfaceItemsEmitted: emitted,
    autoDisabled: disabled,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Start the daily regression detection job. Returns a stop handle.
 */
export function startRoutingRegressionJob(db: DatabaseAdapter): { stop: () => void } {
  const handle = setInterval(() => {
    runRoutingRegressionPass(db).catch((err) => {
      process.stderr.write(`[RoutingRegressionJob] pass failed: ${err}\n`);
    });
  }, REGRESSION_INTERVAL_MS);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as NodeJS.Timeout).unref();
  }
  return { stop: () => clearInterval(handle) };
}
