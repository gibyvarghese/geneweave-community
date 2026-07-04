/**
 * Example 74 — anyWeave Phase 6: Production Hardening
 *
 * Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md §13 Phase 6
 *
 * Demonstrates four production-hardening capabilities added in Phase 6:
 *   1. Capability matrix in-memory cache (60s TTL, configurable, invalidation hooks)
 *   2. safeTranslate circuit breaker around tool-schema translator (fail-open)
 *   3. A/B routing experiments (route N% of (task_key, tenant) traffic to candidate)
 *   4. Cost telemetry aggregation by task_key
 *
 * Plus a microbench: 10000 cache reads, asserting p99 < 2 ms.
 *
 * Runs against a fresh temp SQLite DB.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createDatabaseAdapter } from '../apps/geneweave/src/db-sqlite.js';
import {
  getCapabilityMatrixCache,
  resetCapabilityMatrixCache,
} from '../apps/geneweave/src/capability-matrix-cache.js';
import {
  safeTranslate,
  resetTranslatorBreaker,
  getTranslatorBreakerSnapshot,
} from '@weaveintel/tools/schema';
import type { ProviderToolAdapter } from '@weaveintel/tools/schema';
import { pickExperimentCandidate } from '../apps/geneweave/src/routing-experiments.js';
import { newUUIDv7 } from '../apps/geneweave/src/lib/uuid.js';

function header(label: string): void {
  console.log('\n────────────────────────────────────────');
  console.log(label);
  console.log('────────────────────────────────────────');
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!);
  return sorted[base]!;
}

(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gw-phase6-'));
  const dbPath = join(tmp, 'demo.db');
  const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });

  try {
    // ── Seed a model + capability + task type ──────────────────
    await db.upsertCapabilityScore({
      id: newUUIDv7(),
      tenant_id: null,
      model_id: 'gpt-4o-mini',
      provider: 'openai',
      task_key: 'demo_summarisation',
      quality_score: 80,
      supports_tools: 1, supports_streaming: 1, supports_thinking: 0,
      supports_json_mode: 1, supports_vision: 0, max_output_tokens: 16384,
      benchmark_source: 'demo', raw_benchmark_score: 0.80, is_active: 1,
      last_evaluated_at: new Date().toISOString(),
      production_signal_score: null, signal_sample_count: 0,
    });

    // ───────────────────────────────────────────────────────────
    header('1. Capability matrix cache — first read is a miss, second is a hit');
    resetCapabilityMatrixCache();
    const cache = getCapabilityMatrixCache();
    const t1 = performance.now();
    const rowsA = await cache.getCapabilityScores(db, null);
    const d1 = performance.now() - t1;
    const t2 = performance.now();
    const rowsB = await cache.getCapabilityScores(db, null);
    const d2 = performance.now() - t2;
    console.log(`  miss: ${rowsA.length} rows in ${d1.toFixed(3)} ms`);
    console.log(`  hit:  ${rowsB.length} rows in ${d2.toFixed(3)} ms`);
    console.log(`  stats:`, cache.stats());

    header('1b. Microbench — 10000 cache reads, asserting p99 < 2 ms');
    const samples: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const start = performance.now();
      await cache.getCapabilityScores(db, null);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p50 = quantile(samples, 0.50);
    const p95 = quantile(samples, 0.95);
    const p99 = quantile(samples, 0.99);
    console.log(`  p50=${p50.toFixed(4)} ms   p95=${p95.toFixed(4)} ms   p99=${p99.toFixed(4)} ms`);
    if (p99 < 2.0) console.log(`  ✓ p99 < 2 ms target met`);
    else console.log(`  ✗ p99 ≥ 2 ms target MISSED`);

    header('1c. Cache invalidation hook');
    cache.invalidateCapabilityScores();
    console.log(`  after invalidate:`, cache.stats());

    // ───────────────────────────────────────────────────────────
    header('2. safeTranslate circuit breaker (fails 5 → opens → cooldown)');
    resetTranslatorBreaker();
    const flakyAdapter: ProviderToolAdapter = {
      provider: 'flaky-demo',
      displayName: 'Flaky Demo',
      systemPromptLocation: 'system_message',
      nameValidationRegex: '^[a-z_]+$',
      maxToolCount: 64,
      translate() { throw new Error('upstream provider exploded'); },
      parseToolCall() { return []; },
      reshapeMessage(m) { return m; },
    };
    const goodAdapter: ProviderToolAdapter = {
      provider: 'good-demo',
      displayName: 'Good Demo',
      systemPromptLocation: 'system_message',
      nameValidationRegex: '^[a-z_]+$',
      maxToolCount: 64,
      translate(tools) { return tools.map((t) => ({ ok: true, name: t.name })); },
      parseToolCall() { return []; },
      reshapeMessage(m) { return m; },
    };
    const tool = { name: 'echo', description: 'echo', schema: { type: 'object' as const, properties: {} } };

    const warnings: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = safeTranslate([tool] as never, flakyAdapter, { onWarning: (m) => warnings.push(m) });
      console.log(`  attempt ${i + 1}: ok=${r.ok} reason=${r.error?.reason ?? '-'} tools=${r.tools.length}`);
    }
    console.log(`  warnings emitted: ${warnings.length}`);
    console.log(`  breaker snapshot:`, getTranslatorBreakerSnapshot());

    const ok = safeTranslate([tool] as never, goodAdapter);
    console.log(`  good adapter still works: ok=${ok.ok} translated=${ok.tools.length}`);

    // ───────────────────────────────────────────────────────────
    header('3. A/B routing experiment (10% candidate, deterministic RNG)');
    const expId = newUUIDv7();
    await db.createRoutingExperiment({
      id: expId,
      name: 'gpt-4o-mini → claude-3-5-haiku canary',
      description: '10% of demo_summarisation traffic to candidate',
      tenant_id: null,
      task_key: 'demo_summarisation',
      baseline_provider: 'openai',
      baseline_model_id: 'gpt-4o-mini',
      candidate_provider: 'anthropic',
      candidate_model_id: 'claude-3-5-haiku',
      traffic_pct: 10,
      status: 'active',
      metadata: null,
    });

    let candidateHits = 0;
    let baselineHits = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const pick = await pickExperimentCandidate(db, {
        taskKey: 'demo_summarisation',
        tenantId: null,
      });
      if (pick) candidateHits++;
      else baselineHits++;
    }
    console.log(`  draws=${N}  candidate=${candidateHits} (~${(candidateHits / N * 100).toFixed(1)}%)  baseline=${baselineHits}`);
    console.log(`  expected ~10% candidate; observed ${(candidateHits / N * 100).toFixed(1)}%`);

    // ───────────────────────────────────────────────────────────
    header('4. Cost telemetry — aggregate by task_key');
    const now = new Date();
    for (let i = 0; i < 25; i++) {
      await db.insertRoutingDecisionTrace({
        id: newUUIDv7(),
        tenant_id: null,
        agent_id: null,
        workflow_step_id: null,
        task_key: i < 15 ? 'demo_summarisation' : 'demo_extraction',
        inference_source: 'explicit',
        selected_model_id: i % 2 === 0 ? 'gpt-4o-mini' : 'claude-3-5-haiku',
        selected_provider: i % 2 === 0 ? 'openai' : 'anthropic',
        selected_capability_score: 80,
        weights_used: '{}',
        candidate_breakdown: '[]',
        tool_translation_applied: 0,
        source_provider: null,
        estimated_cost_usd: 0.001 + (i % 5) * 0.0002,
        decided_at: new Date(now.getTime() - i * 60_000).toISOString(),
      });
    }
    const agg = await db.aggregateCostByTask({});
    console.log(`  cost-by-task rows: ${agg.length}`);
    for (const row of agg) {
      console.log(`    task=${row.task_key}  model=${row.selected_provider}/${row.selected_model_id}  count=${row.invocation_count}  total=$${row.total_cost_usd.toFixed(6)}  avg=$${row.avg_cost_usd.toFixed(6)}`);
    }

    header('Phase 6 demo complete ✓');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})();
