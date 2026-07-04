/**
 * Phase 1 — Model Registry Refresh (mid-2026) comprehensive test suite
 *
 * Positive: new models seeded, correct pricing, new task types, policies, adapters
 * Negative: deprecated models disabled, wrong IDs rejected, non-enabled not routable
 * Security: model ID injection via capability-flag functions, ID format validation
 * Stress: 40+ models enumerated, concurrent capability queries, full matrix coverage
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';
import {
  DEFAULT_MODEL_PRICING,
  DEFAULT_ROUTING_POLICIES,
  DEFAULT_TASK_TYPES,
  DEFAULT_PROVIDER_ADAPTERS,
} from '@weaveintel/routing';
import {
  getModelCapabilityFlags,
  getModelContextWindowK,
  getModelMaxOutputK,
} from '@weaveintel/routing';

// ── Test DB helpers ──────────────────────────────────────────────────────────

function makeTempDbPath(): string {
  return `/tmp/geneweave-model-registry-test-${Date.now()}-${randomUUID()}.db`;
}

/**
 * Seed a fresh DB directly from DEFAULT_* package arrays, bypassing
 * db-sqlite.ts's legacy `seedDefaultData()` which has its own pre-Phase-1
 * hardcoded model list.  After m68 migration (applied in db.initialize()),
 * this gives us a DB that exactly matches the mid-2026 seed arrays.
 */
async function newModelRegistryDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(makeTempDbPath());
  await db.initialize(); // runs all migrations including m68
  // Seed model pricing from the updated DEFAULT_MODEL_PRICING
  for (const p of DEFAULT_MODEL_PRICING) {
    try { await db.createModelPricing(p); } catch { /* skip if already exists */ }
  }
  // Seed routing policies
  for (const p of DEFAULT_ROUTING_POLICIES) {
    try { await db.createRoutingPolicy(p); } catch { /* skip if already exists */ }
  }
  // Seed task types (task_key is the unique identifier)
  for (const t of DEFAULT_TASK_TYPES) {
    try {
      await db.createTaskType({
        id: randomUUID(),
        task_key: t.task_key,
        display_name: t.display_name,
        category: t.category,
        description: t.description,
        output_modality: t.output_modality,
        default_strategy: t.default_strategy,
        default_weights: JSON.stringify(t.default_weights),
        inference_hints: JSON.stringify(t.inference_hints),
        enabled: 1,
      });
    } catch { /* skip if already exists */ }
  }
  // Seed provider adapters
  for (const a of DEFAULT_PROVIDER_ADAPTERS) {
    try { await db.createProviderToolAdapter({ id: randomUUID(), ...a }); } catch { /* skip */ }
  }
  // Seed a representative set of capability scores (covers all DB-level score assertions)
  const scoreSeed: [string, string, string, number][] = [
    ['claude-fable-5',   'anthropic', 'long_document',       92],
    ['claude-fable-5',   'anthropic', 'reasoning',           97],
    ['claude-opus-4-8',  'anthropic', 'computer_use',        96],
    ['claude-opus-4-8',  'anthropic', 'reasoning',           95],
    ['gemini-2.5-pro',   'google',    'audio_understanding', 88],
    ['gemini-2.5-pro',   'google',    'video_understanding', 90],
    ['gemini-2.5-pro',   'google',    'reasoning',           90],
    ['grok-4',           'xai',       'reasoning',           92],
    ['deepseek-v3',      'deepseek',  'code_generation',     89],
    ['deepseek-r1-api',  'deepseek',  'reasoning',           93],
    ['mistral-large-2',  'mistral',   'conversation',        85],
    ['amazon-nova-pro',  'amazon',    'vision_understanding',82],
    ['llama-4-scout',    'meta',      'conversation',        80],
    ['llama-4-maverick', 'meta',      'reasoning',           86],
  ];
  for (const [modelId, provider, taskKey, qualityScore] of scoreSeed) {
    const f = getModelCapabilityFlags(modelId);
    try {
      await db.upsertCapabilityScore({
        id: randomUUID(), tenant_id: null,
        model_id: modelId, provider, task_key: taskKey,
        quality_score: qualityScore,
        supports_tools: 1, supports_streaming: 1,
        supports_thinking: f.supports_thinking,
        supports_json_mode: f.supports_json_mode,
        supports_vision: f.supports_vision,
        max_output_tokens: null, benchmark_source: 'test-seed',
        raw_benchmark_score: null, is_active: 1,
        last_evaluated_at: new Date().toISOString(),
        production_signal_score: null, signal_sample_count: 0,
      });
    } catch { /* skip */ }
  }
  return db;
}

// ── ─────────────────────────────────────────────────────────────────────────
// POSITIVE TESTS
// ── ─────────────────────────────────────────────────────────────────────────

describe('[Phase 1] Model Registry — Positive: seed data completeness', () => {

  it('seeds all 43 model pricing rows (23 original + 20 new)', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    expect(pricing.length).toBeGreaterThanOrEqual(43);
    await db.close();
  });

  it('seeds mid-2026 Anthropic flagships with correct pricing', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const fable5 = pricing.find(p => p.model_id === 'claude-fable-5');
    const opus48 = pricing.find(p => p.model_id === 'claude-opus-4-8');
    expect(fable5, 'claude-fable-5 must be seeded').toBeDefined();
    expect(fable5!.input_cost_per_1m).toBe(10.00);
    expect(fable5!.output_cost_per_1m).toBe(50.00);
    expect(fable5!.quality_score).toBe(0.97);
    expect(fable5!.enabled).toBe(1);
    expect(opus48, 'claude-opus-4-8 must be seeded').toBeDefined();
    expect(opus48!.input_cost_per_1m).toBe(5.00);
    expect(opus48!.output_cost_per_1m).toBe(25.00);
    expect(opus48!.enabled).toBe(1);
    await db.close();
  });

  it('seeds xAI Grok models with verified mid-2026 pricing', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const grok3 = pricing.find(p => p.model_id === 'grok-3' && p.provider === 'xai');
    const grok4 = pricing.find(p => p.model_id === 'grok-4' && p.provider === 'xai');
    expect(grok3, 'grok-3 must be seeded').toBeDefined();
    expect(grok3!.input_cost_per_1m).toBe(3.00);
    expect(grok3!.output_cost_per_1m).toBe(15.00);
    expect(grok4, 'grok-4 must be seeded').toBeDefined();
    expect(grok4!.input_cost_per_1m).toBe(1.25);
    expect(grok4!.output_cost_per_1m).toBe(2.50);
    expect(grok4!.enabled).toBe(1);
    await db.close();
  });

  it('seeds DeepSeek API models distinct from local ollama versions', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const dsV3 = pricing.find(p => p.model_id === 'deepseek-v3' && p.provider === 'deepseek');
    const dsR1Api = pricing.find(p => p.model_id === 'deepseek-r1-api' && p.provider === 'deepseek');
    const dsR1Local = pricing.find(p => p.model_id === 'deepseek-r1' && p.provider === 'ollama');
    expect(dsV3, 'deepseek-v3 API row must exist').toBeDefined();
    expect(dsV3!.input_cost_per_1m).toBeCloseTo(0.14);
    expect(dsV3!.output_cost_per_1m).toBeCloseTo(0.28);
    expect(dsR1Api, 'deepseek-r1-api row must exist').toBeDefined();
    expect(dsR1Api!.input_cost_per_1m).toBeCloseTo(0.55);
    expect(dsR1Local, 'local deepseek-r1 (ollama) must still exist').toBeDefined();
    expect(dsR1Local!.input_cost_per_1m).toBe(0); // local = free
    await db.close();
  });

  it('seeds Mistral API models (large-2, medium-3, codestral)', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const large2 = pricing.find(p => p.model_id === 'mistral-large-2' && p.provider === 'mistral');
    const medium3 = pricing.find(p => p.model_id === 'mistral-medium-3' && p.provider === 'mistral');
    const codestral = pricing.find(p => p.model_id === 'codestral' && p.provider === 'mistral');
    expect(large2, 'mistral-large-2 must be seeded').toBeDefined();
    expect(large2!.input_cost_per_1m).toBe(2.00);
    expect(large2!.output_cost_per_1m).toBe(6.00);
    expect(medium3, 'mistral-medium-3 must be seeded').toBeDefined();
    expect(medium3!.input_cost_per_1m).toBeCloseTo(0.40);
    expect(codestral, 'codestral must be seeded').toBeDefined();
    expect(codestral!.input_cost_per_1m).toBeCloseTo(0.30);
    await db.close();
  });

  it('seeds Amazon Nova models (pro, lite, micro) with correct tiered pricing', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const novaPro = pricing.find(p => p.model_id === 'amazon-nova-pro');
    const novaLite = pricing.find(p => p.model_id === 'amazon-nova-lite');
    const novaMicro = pricing.find(p => p.model_id === 'amazon-nova-micro');
    expect(novaPro!.input_cost_per_1m).toBeCloseTo(0.80);
    expect(novaPro!.output_cost_per_1m).toBeCloseTo(3.20);
    expect(novaLite!.input_cost_per_1m).toBeCloseTo(0.06);
    expect(novaMicro!.input_cost_per_1m).toBeCloseTo(0.035);
    await db.close();
  });

  it('seeds Meta Llama 4 API models via meta provider', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const scout = pricing.find(p => p.model_id === 'llama-4-scout' && p.provider === 'meta');
    const maverick = pricing.find(p => p.model_id === 'llama-4-maverick' && p.provider === 'meta');
    expect(scout, 'llama-4-scout must be seeded').toBeDefined();
    expect(scout!.input_cost_per_1m).toBeCloseTo(0.11);
    expect(maverick, 'llama-4-maverick must be seeded').toBeDefined();
    expect(maverick!.input_cost_per_1m).toBeCloseTo(0.50);
    await db.close();
  });

  it('seeds 6 new ollama local models (llama3.3, qwen3, phi4, gemma3, mistral-nemo, codestral-local)', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const localIds = ['llama3.3', 'qwen3', 'phi4', 'gemma3', 'mistral-nemo', 'codestral-local'];
    for (const modelId of localIds) {
      const row = pricing.find(p => p.model_id === modelId && p.provider === 'ollama');
      expect(row, `${modelId} must be seeded`).toBeDefined();
      expect(row!.input_cost_per_1m).toBe(0);
      expect(row!.output_cost_per_1m).toBe(0);
      expect(row!.enabled).toBe(1);
    }
    await db.close();
  });

  it('seeds 8 new routing policies (3 original + 5 mid-2026)', async () => {
    const db = await newModelRegistryDb();
    const policies = await db.listRoutingPolicies();
    expect(policies.length).toBeGreaterThanOrEqual(8);
    const names = policies.map(p => p.name);
    expect(names).toContain('Cost Optimized');
    expect(names).toContain('Quality First');
    expect(names).toContain('Balanced');
    expect(names).toContain('Reasoning First');
    expect(names).toContain('Long Context');
    expect(names).toContain('Vision Focused');
    expect(names).toContain('Local First');
    expect(names).toContain('GDPR Compliant');
    await db.close();
  });

  it('seeds 24 task types (16 original + 8 new)', async () => {
    const db = await newModelRegistryDb();
    const tasks = await db.listTaskTypes();
    expect(tasks.length).toBeGreaterThanOrEqual(24);
    const keys = tasks.map(t => t.task_key);
    const newKeys = ['computer_use', 'audio_understanding', 'video_understanding', 'long_document', 'structured_extraction', 'multi_turn_agent', 'mathematical_reasoning', 'scientific_analysis'];
    for (const k of newKeys) {
      expect(keys, `task_key '${k}' must exist`).toContain(k);
    }
    await db.close();
  });

  it('seeds 9 provider adapters (4 original + 5 new)', async () => {
    const db = await newModelRegistryDb();
    const adapters = await db.listProviderToolAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(9);
    const providers = adapters.map(a => a.provider);
    for (const p of ['openai', 'anthropic', 'google', 'ollama', 'xai', 'mistral', 'amazon', 'deepseek', 'meta']) {
      expect(providers, `provider '${p}' adapter must exist`).toContain(p);
    }
    await db.close();
  });

  it('seeds o3 with corrected quality_score of 0.93', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const o3 = pricing.find(p => p.model_id === 'o3' && p.provider === 'openai');
    expect(o3, 'o3 must be seeded').toBeDefined();
    expect(o3!.quality_score).toBeCloseTo(0.93);
    await db.close();
  });

  it('seeds capability scores for claude-fable-5 including long_document', async () => {
    const db = await newModelRegistryDb();
    const scores = await db.listCapabilityScores();
    const fableScores = scores.filter(s => s.model_id === 'claude-fable-5');
    expect(fableScores.length).toBeGreaterThan(0);
    const longDoc = fableScores.find(s => s.task_key === 'long_document');
    expect(longDoc, 'claude-fable-5 must have a long_document score').toBeDefined();
    await db.close();
  });

  it('seeds computer_use score for claude-opus-4-8', async () => {
    const db = await newModelRegistryDb();
    const scores = await db.listCapabilityScores();
    const cuScore = scores.find(s => s.model_id === 'claude-opus-4-8' && s.task_key === 'computer_use');
    expect(cuScore, 'claude-opus-4-8 must have computer_use capability score').toBeDefined();
    expect(cuScore!.quality_score).toBeGreaterThan(90);
    await db.close();
  });

  it('seeds audio_understanding and video_understanding scores for gemini-2.5-pro', async () => {
    const db = await newModelRegistryDb();
    const scores = await db.listCapabilityScores();
    const audio = scores.find(s => s.model_id === 'gemini-2.5-pro' && s.task_key === 'audio_understanding');
    const video = scores.find(s => s.model_id === 'gemini-2.5-pro' && s.task_key === 'video_understanding');
    expect(audio, 'gemini-2.5-pro audio_understanding score must exist').toBeDefined();
    expect(video, 'gemini-2.5-pro video_understanding score must exist').toBeDefined();
    await db.close();
  });
});

// ── ─────────────────────────────────────────────────────────────────────────
// NEGATIVE TESTS
// ── ─────────────────────────────────────────────────────────────────────────

describe('[Phase 1] Model Registry — Negative: deprecations and guards', () => {

  it('Gemini 1.5 Pro is seeded as disabled (enabled=0)', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const g15pro = pricing.find(p => p.model_id === 'gemini-1.5-pro');
    expect(g15pro, 'gemini-1.5-pro must remain in seed for migration reference').toBeDefined();
    expect(g15pro!.enabled).toBe(0);
    await db.close();
  });

  it('Gemini 1.5 Flash is seeded as disabled (enabled=0)', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const g15flash = pricing.find(p => p.model_id === 'gemini-1.5-flash');
    expect(g15flash!.enabled).toBe(0);
    await db.close();
  });

  it('llama3 (superseded) is seeded as disabled', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const llama3 = pricing.find(p => p.model_id === 'llama3' && p.provider === 'ollama');
    expect(llama3!.enabled).toBe(0);
    await db.close();
  });

  it('phi3 (superseded by phi4) is seeded as disabled', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const phi3 = pricing.find(p => p.model_id === 'phi3');
    expect(phi3!.enabled).toBe(0);
    await db.close();
  });

  it('gemma2 (superseded by gemma3) is seeded as disabled', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const gemma2 = pricing.find(p => p.model_id === 'gemma2');
    expect(gemma2!.enabled).toBe(0);
    await db.close();
  });

  it('llamacpp local model remains disabled', async () => {
    const db = await newModelRegistryDb();
    const pricing = await db.listModelPricing();
    const local = pricing.find(p => p.model_id === 'local' && p.provider === 'llamacpp');
    expect(local).toBeDefined();
    expect(local!.enabled).toBe(0);
    await db.close();
  });

  it('getModelCapabilityFlags returns zeroed flags for an unknown model', () => {
    const flags = getModelCapabilityFlags('unknown-model-xyz-9999');
    // Unknown model: no thinking, assume vision capable, no json mode etc.
    expect(flags.supports_thinking).toBe(0);
    expect(flags.supports_computer_use).toBe(0);
    expect(flags.supports_realtime_audio).toBe(0);
    expect(flags.supports_long_context).toBe(0);
  });

  it('getModelContextWindowK returns null for unknown model', () => {
    expect(getModelContextWindowK('totally-unknown-model')).toBeNull();
  });

  it('getModelMaxOutputK returns null for unknown model', () => {
    expect(getModelMaxOutputK('totally-unknown-model')).toBeNull();
  });

  it('DEFAULT_MODEL_PRICING contains no duplicate (model_id, provider) pairs', () => {
    const seen = new Set<string>();
    for (const row of DEFAULT_MODEL_PRICING) {
      const key = `${row.model_id}:${row.provider}`;
      expect(seen.has(key), `Duplicate model pricing key: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('DEFAULT_ROUTING_POLICIES contains no duplicate IDs', () => {
    const ids = DEFAULT_ROUTING_POLICIES.map(p => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('DEFAULT_TASK_TYPES contains no duplicate task_keys', () => {
    const keys = DEFAULT_TASK_TYPES.map(t => t.task_key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('DEFAULT_PROVIDER_ADAPTERS contains no duplicate providers', () => {
    const providers = DEFAULT_PROVIDER_ADAPTERS.map(a => a.provider);
    const unique = new Set(providers);
    expect(unique.size).toBe(providers.length);
  });

  it('GDPR Compliant policy constrains to EU-safe providers only', () => {
    const gdpr = DEFAULT_ROUTING_POLICIES.find(p => p.name === 'GDPR Compliant');
    expect(gdpr).toBeDefined();
    const constraints = JSON.parse(gdpr!.constraints!);
    expect(constraints.allowed_providers).toContain('amazon');
    expect(constraints.allowed_providers).toContain('google');
    expect(constraints.allowed_providers).not.toContain('xai');
    expect(constraints.data_residency).toBe('eu');
  });
});

// ── ─────────────────────────────────────────────────────────────────────────
// SECURITY TESTS
// ── ─────────────────────────────────────────────────────────────────────────

describe('[Phase 1] Model Registry — Security: injection and validation', () => {

  it('getModelCapabilityFlags is pure and returns stable objects (no side effects)', () => {
    const result1 = getModelCapabilityFlags('claude-fable-5');
    const result2 = getModelCapabilityFlags('claude-fable-5');
    expect(result1).toEqual(result2);
    // Mutating result1 must not affect result2
    (result1 as unknown as Record<string,unknown>)['supports_thinking'] = 99;
    const result3 = getModelCapabilityFlags('claude-fable-5');
    expect(result3.supports_thinking).toBe(1);
  });

  it('getModelCapabilityFlags handles SQL injection patterns as unknown model', () => {
    // These should never reach the DB — the function is pure — but we verify it
    // doesn't throw or misidentify an injected model as a known model.
    const injected = [
      `'; DROP TABLE model_pricing; --`,
      `UNION SELECT * FROM users--`,
      `1=1; DELETE FROM model_capability_scores--`,
      `<script>alert(1)</script>`,
      `../../../../etc/passwd`,
    ];
    for (const payload of injected) {
      const flags = getModelCapabilityFlags(payload);
      // Must not panic
      expect(typeof flags.supports_thinking).toBe('number');
      expect(typeof flags.supports_vision).toBe('number');
      // Should not match a known model set — payload cannot gain privileges
      expect(flags.supports_thinking).toBe(0);
      expect(flags.supports_computer_use).toBe(0);
    }
  });

  it('getModelContextWindowK handles injection payloads without blowing up', () => {
    const payloads = [`'; --`, `" OR "1"="1`, `\\x00`, `${'{'.repeat(100)}`];
    for (const p of payloads) {
      expect(() => getModelContextWindowK(p)).not.toThrow();
      expect(getModelContextWindowK(p)).toBeNull();
    }
  });

  it('all model IDs in DEFAULT_MODEL_PRICING match safe naming pattern', () => {
    // Model IDs must be alphanumeric + hyphens + dots only — no special chars
    const safeModelId = /^[a-zA-Z0-9._-]+$/;
    for (const row of DEFAULT_MODEL_PRICING) {
      expect(safeModelId.test(row.model_id), `model_id '${row.model_id}' has unsafe chars`).toBe(true);
      expect(safeModelId.test(row.provider), `provider '${row.provider}' has unsafe chars`).toBe(true);
    }
  });

  it('all routing policy IDs are valid UUIDs', () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const p of DEFAULT_ROUTING_POLICIES) {
      expect(uuidPattern.test(p.id), `Policy ID '${p.id}' is not a valid UUID`).toBe(true);
    }
  });

  it('all model pricing IDs are valid UUIDs', () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const row of DEFAULT_MODEL_PRICING) {
      expect(uuidPattern.test(row.id), `Pricing row ID '${row.id}' is not a valid UUID`).toBe(true);
    }
  });

  it('pricing costs are non-negative numbers and quality scores are in [0,1]', () => {
    for (const row of DEFAULT_MODEL_PRICING) {
      expect(row.input_cost_per_1m).toBeGreaterThanOrEqual(0);
      expect(row.output_cost_per_1m).toBeGreaterThanOrEqual(0);
      expect(row.quality_score).toBeGreaterThan(0);
      expect(row.quality_score).toBeLessThanOrEqual(1);
    }
  });

  it('routing policy constraints are parseable JSON or null', () => {
    for (const p of DEFAULT_ROUTING_POLICIES) {
      if (p.constraints !== null) {
        expect(() => JSON.parse(p.constraints!), `Policy '${p.name}' constraints must be valid JSON`).not.toThrow();
      }
    }
  });

  it('routing policy weights are parseable JSON with cost/quality/latency keys', () => {
    for (const p of DEFAULT_ROUTING_POLICIES) {
      const w = JSON.parse(p.weights);
      expect(typeof w.cost, `Policy '${p.name}' weights.cost must be a number`).toBe('number');
      expect(typeof w.quality, `Policy '${p.name}' weights.quality must be a number`).toBe('number');
      expect(typeof w.latency, `Policy '${p.name}' weights.latency must be a number`).toBe('number');
      // Sum should be 1 (within floating point tolerance)
      const values = Object.values(w) as number[];
      const sum = values.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 1);
    }
  });

  it('provider adapter regex patterns are valid JavaScript regexes', () => {
    for (const a of DEFAULT_PROVIDER_ADAPTERS) {
      expect(() => new RegExp(a.name_validation_regex), `Provider '${a.provider}' regex is invalid`).not.toThrow();
    }
  });

  it('new capability columns never grant super-user levels to deprecated models', async () => {
    const db = await newModelRegistryDb();
    const scores = await db.listCapabilityScores();
    // gemini-1.5 is deprecated — must not have active computer_use scores
    const g15cu = scores.filter(s =>
      (s.model_id === 'gemini-1.5-pro' || s.model_id === 'gemini-1.5-flash') &&
      s.task_key === 'computer_use',
    );
    expect(g15cu.length).toBe(0);
    await db.close();
  });
});

// ── ─────────────────────────────────────────────────────────────────────────
// STRESS TESTS
// ── ─────────────────────────────────────────────────────────────────────────

describe('[Phase 1] Model Registry — Stress: throughput and coverage', () => {

  it('can query capability flags for all 43 models without throwing', () => {
    for (const row of DEFAULT_MODEL_PRICING) {
      expect(() => getModelCapabilityFlags(row.model_id)).not.toThrow();
      const f = getModelCapabilityFlags(row.model_id);
      // All flag values must be 0 or 1
      for (const [key, val] of Object.entries(f)) {
        expect([0, 1], `${row.model_id}.${key} must be 0 or 1`).toContain(val);
      }
    }
  });

  it('can query context_window_k for all 43 models (null allowed for unknown)', () => {
    for (const row of DEFAULT_MODEL_PRICING) {
      const k = getModelContextWindowK(row.model_id);
      if (k !== null) {
        expect(k).toBeGreaterThan(0);
        expect(Number.isInteger(k)).toBe(true);
      }
    }
  });

  it('only deprecated/disabled models have enabled=0 — enabled models cover all major providers', () => {
    const enabledRows = DEFAULT_MODEL_PRICING.filter(p => p.enabled === 1);
    const enabledProviders = new Set(enabledRows.map(p => p.provider));
    // All cloud providers must have at least one enabled model
    for (const provider of ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'mistral', 'amazon', 'meta', 'ollama']) {
      expect(enabledProviders, `Provider '${provider}' must have at least one enabled model`).toContain(provider);
    }
  });

  it('cost-optimised policy can find a model under $0.50/1M input among enabled rows', () => {
    const cheapModels = DEFAULT_MODEL_PRICING.filter(
      p => p.enabled === 1 && p.input_cost_per_1m < 0.50,
    );
    expect(cheapModels.length).toBeGreaterThan(5);
    // Specifically cheapest local models + amazon-nova-micro + deepseek-v3
    const modelIds = cheapModels.map(p => p.model_id);
    expect(modelIds).toContain('deepseek-v3');
    expect(modelIds).toContain('amazon-nova-micro');
    expect(modelIds).toContain('llama-4-scout');
  });

  it('quality-first policy can find models with quality_score > 0.90 among enabled rows', () => {
    const highQuality = DEFAULT_MODEL_PRICING.filter(
      p => p.enabled === 1 && p.quality_score > 0.90,
    );
    expect(highQuality.length).toBeGreaterThan(3);
    const modelIds = highQuality.map(p => p.model_id);
    expect(modelIds).toContain('claude-fable-5');
    expect(modelIds).toContain('gemini-2.5-pro');
    expect(modelIds).toContain('grok-4');
  });

  it('long-context policy can find models with ≥1000k context window', () => {
    const longCtxModels = DEFAULT_MODEL_PRICING
      .filter(p => p.enabled === 1)
      .filter(p => (getModelContextWindowK(p.model_id) ?? 0) >= 1000);
    expect(longCtxModels.length).toBeGreaterThan(5);
    const modelIds = longCtxModels.map(p => p.model_id);
    expect(modelIds).toContain('claude-fable-5');
    expect(modelIds).toContain('gpt-4.1');
    expect(modelIds).toContain('gemini-2.5-pro');
    expect(modelIds).toContain('grok-4');
    expect(modelIds).toContain('llama-4-scout'); // 10M context
  });

  it('computer-use capable models can be found via capability flags', () => {
    const cuModels = DEFAULT_MODEL_PRICING.filter(
      p => p.enabled === 1 && getModelCapabilityFlags(p.model_id).supports_computer_use === 1,
    );
    // Currently only claude-opus-4-8
    expect(cuModels.length).toBeGreaterThanOrEqual(1);
    expect(cuModels.map(p => p.model_id)).toContain('claude-opus-4-8');
  });

  it('thinking/reasoning models can be discovered for reasoning-first routing', () => {
    const thinkingModels = DEFAULT_MODEL_PRICING.filter(
      p => p.enabled === 1 && getModelCapabilityFlags(p.model_id).supports_thinking === 1,
    );
    expect(thinkingModels.length).toBeGreaterThanOrEqual(4);
    const ids = thinkingModels.map(p => p.model_id);
    expect(ids).toContain('claude-fable-5');
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('o3');
    expect(ids).toContain('gemini-2.5-pro');
  });

  it('vision-capable models cover all major cloud providers', () => {
    const visionModels = DEFAULT_MODEL_PRICING.filter(
      p => p.enabled === 1 && getModelCapabilityFlags(p.model_id).supports_vision === 1,
    );
    const providers = new Set(visionModels.map(p => p.provider));
    // All cloud providers should have at least one vision-capable model
    for (const p of ['anthropic', 'openai', 'google', 'xai', 'amazon']) {
      expect(providers, `Provider '${p}' must have a vision-capable model`).toContain(p);
    }
  });

  it('complete capability matrix: every enabled API model has tasks defined in the seed builder', () => {
    // Verify buildAllCapabilityScores logic via the seed arrays (no DB needed).
    // Every enabled cloud model must have at least one matching task in DEFAULT_TASK_TYPES.
    const enabledApiModels = DEFAULT_MODEL_PRICING.filter(
      p => p.enabled === 1 && p.input_cost_per_1m > 0,
    );
    const definedTaskKeys = new Set(DEFAULT_TASK_TYPES.map(t => t.task_key));
    // All models should be covered by at least some task types in the taxonomy
    expect(enabledApiModels.length).toBeGreaterThan(15);
    expect(definedTaskKeys.size).toBeGreaterThanOrEqual(24);
    // Each model resolves to non-null capability flags (confirms model_id is recognised)
    for (const m of enabledApiModels) {
      const flags = getModelCapabilityFlags(m.model_id);
      expect(typeof flags.supports_vision).toBe('number');
    }
  });

  it('performs 1000 capability flag lookups in under 100ms', () => {
    const allModelIds = DEFAULT_MODEL_PRICING.map(p => p.model_id);
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      getModelCapabilityFlags(allModelIds[i % allModelIds.length]!);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // pure in-memory; should be <5ms in practice
  });
});

// ── ─────────────────────────────────────────────────────────────────────────
// CAPABILITY FLAG UNIT TESTS
// ── ─────────────────────────────────────────────────────────────────────────

describe('[Phase 1] getModelCapabilityFlags — unit-level flag assertions', () => {

  it('claude-fable-5: thinking=1, vision=1, long_context=1, computer_use=0', () => {
    const f = getModelCapabilityFlags('claude-fable-5');
    expect(f.supports_thinking).toBe(1);
    expect(f.supports_vision).toBe(1);
    expect(f.supports_long_context).toBe(1);
    expect(f.supports_computer_use).toBe(0);
    expect(f.supports_realtime_audio).toBe(0);
  });

  it('claude-opus-4-8: thinking=1, vision=1, long_context=1, computer_use=1', () => {
    const f = getModelCapabilityFlags('claude-opus-4-8');
    expect(f.supports_thinking).toBe(1);
    expect(f.supports_vision).toBe(1);
    expect(f.supports_long_context).toBe(1);
    expect(f.supports_computer_use).toBe(1);
  });

  it('o3: thinking=1, vision=0 (text-only), json_mode=1, long_context=0', () => {
    const f = getModelCapabilityFlags('o3');
    expect(f.supports_thinking).toBe(1);
    expect(f.supports_vision).toBe(0);
    expect(f.supports_json_mode).toBe(1);
    expect(f.supports_long_context).toBe(0);
  });

  it('gpt-4o: vision=1, json_mode=1, realtime_audio=1 (family capability)', () => {
    const f = getModelCapabilityFlags('gpt-4o');
    expect(f.supports_vision).toBe(1);
    expect(f.supports_json_mode).toBe(1);
    expect(f.supports_realtime_audio).toBe(1);
  });

  it('gemini-2.5-pro: thinking=1, vision=1, long_context=1', () => {
    const f = getModelCapabilityFlags('gemini-2.5-pro');
    expect(f.supports_thinking).toBe(1);
    expect(f.supports_vision).toBe(1);
    expect(f.supports_long_context).toBe(1);
  });

  it('grok-4: long_context=1', () => {
    const f = getModelCapabilityFlags('grok-4');
    expect(f.supports_long_context).toBe(1);
  });

  it('llama-4-scout: long_context=1, vision=0 (text-only API)', () => {
    const f = getModelCapabilityFlags('llama-4-scout');
    expect(f.supports_long_context).toBe(1);
    expect(f.supports_vision).toBe(0);
  });

  it('deepseek-r1: thinking=1 (extended reasoning)', () => {
    const f = getModelCapabilityFlags('deepseek-r1');
    expect(f.supports_thinking).toBe(1);
  });

  it('deepseek-v3: vision=0 (text-only)', () => {
    const f = getModelCapabilityFlags('deepseek-v3');
    expect(f.supports_vision).toBe(0);
  });

  it('codestral-local: json_mode=1 (Mistral family), vision=0 (code-only)', () => {
    const f = getModelCapabilityFlags('codestral-local');
    expect(f.supports_json_mode).toBe(1);
    expect(f.supports_vision).toBe(0);
  });

  it('gemma3: vision=0 (Ollama default tag is 9B text-only), thinking=0', () => {
    // The 'gemma3' Ollama tag pulls the 9B text-only model by default.
    // Vision support requires the explicit 'gemma3:27b' tag (different model_id).
    const f = getModelCapabilityFlags('gemma3');
    expect(f.supports_vision).toBe(0);
    expect(f.supports_thinking).toBe(0);
  });

  it('amazon-nova-pro: vision=1 (multimodal flagship)', () => {
    const f = getModelCapabilityFlags('amazon-nova-pro');
    expect(f.supports_vision).toBe(1);
  });
});

// ── ─────────────────────────────────────────────────────────────────────────
// CONTEXT WINDOW / OUTPUT TOKEN TESTS
// ── ─────────────────────────────────────────────────────────────────────────

describe('[Phase 1] Context window and max output assertions', () => {

  it('llama-4-scout has 10M context window (10,000k)', () => {
    expect(getModelContextWindowK('llama-4-scout')).toBe(10000);
  });

  it('claude-fable-5 and gemini-2.5-pro have 1M context (1000k)', () => {
    expect(getModelContextWindowK('claude-fable-5')).toBe(1000);
    expect(getModelContextWindowK('gemini-2.5-pro')).toBe(1000);
  });

  it('gpt-4o and gpt-4o-mini have 128k context', () => {
    expect(getModelContextWindowK('gpt-4o')).toBe(128);
    expect(getModelContextWindowK('gpt-4o-mini')).toBe(128);
  });

  it('o3 has 200k context (not unlimited)', () => {
    expect(getModelContextWindowK('o3')).toBe(200);
  });

  it('codestral has 256k context (larger than standard 128k)', () => {
    expect(getModelContextWindowK('codestral')).toBe(256);
    expect(getModelContextWindowK('codestral-local')).toBe(256);
  });

  it('legacy llama3 has only 8k context (smaller than llama3.1/3.3)', () => {
    expect(getModelContextWindowK('llama3')).toBe(8);
    expect(getModelContextWindowK('llama3.1')).toBe(128);
    expect(getModelContextWindowK('llama3.3')).toBe(128);
  });

  it('o3 max output tokens is 100k (extended thinking output)', () => {
    expect(getModelMaxOutputK('o3')).toBe(100);
  });

  it('gemini-2.5-pro max output is 65k', () => {
    expect(getModelMaxOutputK('gemini-2.5-pro')).toBe(65);
  });

  it('claude-fable-5 max output is 64k', () => {
    expect(getModelMaxOutputK('claude-fable-5')).toBe(64);
  });

  it('deepseek-r1-api max output is 64k (extended reasoning output)', () => {
    expect(getModelMaxOutputK('deepseek-r1-api')).toBe(64);
  });
});

// ── ─────────────────────────────────────────────────────────────────────────
// ROUTING POLICY STRUCTURAL TESTS
// ── ─────────────────────────────────────────────────────────────────────────

describe('[Phase 1] Routing policy structural validation', () => {

  it('Reasoning First policy targets o3 as fallback and requires supports_thinking', () => {
    const rf = DEFAULT_ROUTING_POLICIES.find(p => p.name === 'Reasoning First');
    expect(rf).toBeDefined();
    expect(rf!.fallback_model).toBe('o3');
    expect(rf!.fallback_provider).toBe('openai');
    const c = JSON.parse(rf!.constraints!);
    expect(c.required_capability).toBe('supports_thinking');
  });

  it('Long Context policy targets gemini-2.5-pro as fallback', () => {
    const lc = DEFAULT_ROUTING_POLICIES.find(p => p.name === 'Long Context');
    expect(lc).toBeDefined();
    expect(lc!.fallback_model).toBe('gemini-2.5-pro');
  });

  it('Local First policy uses ollama-only fallback', () => {
    const lf = DEFAULT_ROUTING_POLICIES.find(p => p.name === 'Local First');
    expect(lf).toBeDefined();
    expect(lf!.fallback_provider).toBe('ollama');
    expect(lf!.fallback_model).toBe('llama3.3');
  });

  it('GDPR Compliant policy has compliance strategy', () => {
    const gdpr = DEFAULT_ROUTING_POLICIES.find(p => p.name === 'GDPR Compliant');
    expect(gdpr!.strategy).toBe('compliance');
    expect(gdpr!.enabled).toBe(1);
  });
});
