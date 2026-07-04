/**
 * Example 73 — anyWeave Phase 5: Task-Aware Routing Feedback Loop
 *
 * Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md §13 Phase 5
 *
 * This example exercises the four signal channels that feed
 * `model_capability_scores.production_signal_score` and the daily
 * regression detector that emits `routing_surface_items`.
 *
 * Channels exercised:
 *   1. eval        — recordCapabilitySignal({ source: 'eval' })
 *   2. cache       — recordCapabilitySignal({ source: 'cache' })
 *   3. production  — recordCapabilitySignal({ source: 'production' })
 *   4. chat        — recordChatFeedbackSignal({ signal: 'thumbs_up' | … })
 *
 * Then we backfill 30 days of low-quality signals and call
 * runRoutingRegressionPass() directly to verify a `critical` surface
 * item is emitted and the capability row is auto-disabled.
 *
 * This example talks to SQLite directly — no HTTP server required.
 * It uses a temp DB so it never touches your local geneweave.db.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabaseAdapter } from '../apps/geneweave/src/db-sqlite.js';
import {
  recordCapabilitySignal,
  recordChatFeedbackSignal,
  runRoutingRegressionPass,
} from '../apps/geneweave/src/routing-feedback.js';
import { newUUIDv7 } from '../apps/geneweave/src/lib/uuid.js';

const MODEL_ID  = 'gpt-4o-mini';
const PROVIDER  = 'openai';
const TASK_KEY  = 'demo_summarisation';

function header(label: string): void {
  console.log('\n────────────────────────────────────────');
  console.log(label);
  console.log('────────────────────────────────────────');
}

(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gw-phase5-'));
  const dbPath = join(tmp, 'demo.db');
  const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });

  try {
    header('1. Seed a capability row (benchmark baseline)');
    const capId = newUUIDv7();
    await db.upsertCapabilityScore({
      id: capId,
      tenant_id: null,
      model_id: MODEL_ID,
      provider: PROVIDER,
      task_key: TASK_KEY,
      quality_score: 80,
      supports_tools: 1,
      supports_streaming: 1,
      supports_thinking: 0,
      supports_json_mode: 1,
      supports_vision: 0,
      max_output_tokens: 16384,
      benchmark_source: 'demo',
      raw_benchmark_score: 0.80,
      is_active: 1,
      last_evaluated_at: new Date().toISOString(),
      production_signal_score: null,
      signal_sample_count: 0,
    });
    const seeded = await db.listCapabilityScores({ modelId: MODEL_ID, taskKey: TASK_KEY });
    console.log(`  seeded: quality_score=${seeded[0]!.quality_score}  production_signal_score=${seeded[0]!.production_signal_score}  samples=${seeded[0]!.signal_sample_count}`);

    header('2. Eval bridge — recordCapabilitySignal(source=eval)');
    const r1 = await recordCapabilitySignal(db, {
      modelId: MODEL_ID, provider: PROVIDER, taskKey: TASK_KEY,
      source: 'eval', signalType: 'rouge_l', value: 88,
    });
    console.log(`  → production_signal_score=${r1.productionSignalScore}  samples=${r1.signalSampleCount}`);

    header('3. Cache bridge — recordCapabilitySignal(source=cache)');
    const r2 = await recordCapabilitySignal(db, {
      modelId: MODEL_ID, provider: PROVIDER, taskKey: TASK_KEY,
      source: 'cache', signalType: 'admission_quality', value: 75,
    });
    console.log(`  → production_signal_score=${r2.productionSignalScore}  samples=${r2.signalSampleCount}`);

    header('4. Production telemetry — recordCapabilitySignal(source=production)');
    const r3 = await recordCapabilitySignal(db, {
      modelId: MODEL_ID, provider: PROVIDER, taskKey: TASK_KEY,
      source: 'production', signalType: 'json_compliance', value: 95,
    });
    console.log(`  → production_signal_score=${r3.productionSignalScore}  samples=${r3.signalSampleCount}`);

    header('5. Chat feedback — recordChatFeedbackSignal(👍/👎/regenerate/copy)');
    for (const signal of ['thumbs_up', 'copy', 'regenerate', 'thumbs_down'] as const) {
      const r = await recordChatFeedbackSignal(db, {
        signal,
        messageId: newUUIDv7(),
        modelId: MODEL_ID, provider: PROVIDER, taskKey: TASK_KEY,
      });
      console.log(`  ${signal.padEnd(12)} → score=${r.productionSignalScore}  samples=${r.signalSampleCount}  feedbackId=${r.feedbackId.slice(0, 8)}…`);
    }

    const afterAll = await db.getCapabilityScore(capId);
    console.log(`\n  Final score after 7 signals: production_signal_score=${afterAll!.production_signal_score}  samples=${afterAll!.signal_sample_count}  (benchmark quality_score still=${afterAll!.quality_score})`);

    header('6. Backfill 30d of low-value signals → regression detector');
    // Backfill: 30 days of high signals (90), then last 7 days of low signals (20).
    // That should trip the >20% drop threshold and auto-disable the row.
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // Days [-30, -8] — high quality
    for (let d = 30; d >= 8; d--) {
      for (let i = 0; i < 3; i++) {
        await db.insertRoutingCapabilitySignal({
          id: newUUIDv7(), tenant_id: null,
          model_id: MODEL_ID, provider: PROVIDER, task_key: TASK_KEY,
          source: 'production', signal_type: 'json_compliance',
          value: 90, weight: 1.0,
          evidence_id: null, message_id: null, trace_id: null, metadata: null,
          created_at: new Date(now - d * DAY).toISOString(),
        });
      }
    }
    // Days [-7, -1] — collapsed quality
    for (let d = 7; d >= 1; d--) {
      for (let i = 0; i < 3; i++) {
        await db.insertRoutingCapabilitySignal({
          id: newUUIDv7(), tenant_id: null,
          model_id: MODEL_ID, provider: PROVIDER, task_key: TASK_KEY,
          source: 'production', signal_type: 'json_compliance',
          value: 20, weight: 1.0,
          evidence_id: null, message_id: null, trace_id: null, metadata: null,
          created_at: new Date(now - d * DAY).toISOString(),
        });
      }
    }
    const backfilled = await db.listRoutingCapabilitySignals({ modelId: MODEL_ID, taskKey: TASK_KEY, limit: 1000 });
    console.log(`  inserted ${backfilled.length - 7} backfill rows (plus the 7 from steps 2-5)`);

    header('7. Run regression pass');
    const result = await runRoutingRegressionPass(db);
    console.log(`  groupsEvaluated=${result.groupsEvaluated}  surfaceItemsEmitted=${result.surfaceItemsEmitted}  autoDisabled=${result.autoDisabled}  durationMs=${result.durationMs}`);

    header('8. Inspect surface items + auto-disable status');
    const surface = await db.listRoutingSurfaceItems({ modelId: MODEL_ID, taskKey: TASK_KEY });
    for (const s of surface) {
      console.log(`  • [${s.severity}] ${s.kind}  drop=${s.drop_pct}%  7d=${s.metric_7d}  30d=${s.metric_30d}  auto_disabled=${s.auto_disabled}`);
      console.log(`    "${s.message}"`);
    }
    const after = await db.getCapabilityScore(capId);
    console.log(`\n  capability row after pass: is_active=${after!.is_active}  (1 = active, 0 = auto-disabled)`);

    if (surface.length === 0) {
      console.error('\n  ✗ Expected at least one surface item');
      process.exit(1);
    }
    if (after!.is_active !== 0) {
      console.error('\n  ✗ Expected capability row to be auto-disabled (is_active=0)');
      process.exit(1);
    }
    console.log('\n  ✓ Phase 5 feedback loop end-to-end OK');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
