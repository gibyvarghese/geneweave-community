/**
 * geneWeave — Cache Phase 2 integration tests (provider-native prompt caching).
 *
 * Verifies the per-model prompt-cache policy is wired at the app layer:
 *   - m84 migration adds prompt_cache columns with secure defaults;
 *   - create/update model_pricing round-trips the new fields;
 *   - loadModelPricing exposes the policy to the chat path;
 *   - planPromptCacheBreakpoints makes the right enable/skip decision from a
 *     model's policy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { applySeed } from './seed/index.js';
import { loadModelPricing } from './chat-pricing-utils.js';
import { planPromptCacheBreakpoints } from '@weaveintel/cache';

function tmpDb(): string {
  return join(tmpdir(), `gw-cache-phase2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('Cache Phase 2 — model_pricing prompt-cache policy', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); });
  afterEach(async () => { await db.close(); });

  it('migration adds prompt_cache columns with secure defaults', async () => {
    await db.createModelPricing({
      id: 'mp-test', model_id: 'claude-test', provider: 'anthropic', display_name: 'Claude Test',
      input_cost_per_1m: 3, output_cost_per_1m: 15, quality_score: 0.9, source: 'manual',
      last_synced_at: null, enabled: 1,
    } as any);
    const row = await db.getModelPricing('mp-test');
    expect(row).toBeTruthy();
    expect(row!.prompt_cache_enabled).toBe(1);
    expect(row!.prompt_cache_min_tokens).toBe(1024);
    expect(row!.prompt_cache_ttl).toBe('5m');
  });

  it('updateModelPricing round-trips the prompt-cache fields', async () => {
    await db.createModelPricing({
      id: 'mp-test2', model_id: 'gpt-test', provider: 'openai', display_name: null,
      input_cost_per_1m: 1, output_cost_per_1m: 2, quality_score: 0.8, source: 'manual',
      last_synced_at: null, enabled: 1,
    } as any);
    await db.updateModelPricing('mp-test2', { prompt_cache_enabled: 0, prompt_cache_min_tokens: 2048, prompt_cache_ttl: '1h' } as any);
    const row = await db.getModelPricing('mp-test2');
    expect(row!.prompt_cache_enabled).toBe(0);
    expect(row!.prompt_cache_min_tokens).toBe(2048);
    expect(row!.prompt_cache_ttl).toBe('1h');
  });

  it('loadModelPricing exposes the policy to the chat path', async () => {
    await db.createModelPricing({
      id: 'mp-test3', model_id: 'claude-policy', provider: 'anthropic', display_name: null,
      input_cost_per_1m: 3, output_cost_per_1m: 15, quality_score: 0.9, source: 'manual',
      last_synced_at: null, enabled: 1,
    } as any);
    await db.updateModelPricing('mp-test3', { prompt_cache_min_tokens: 512, prompt_cache_ttl: '1h' } as any);
    const { pricing } = await loadModelPricing(db, null);
    const p = pricing.get('claude-policy');
    expect(p?.promptCacheEnabled).toBe(true);
    expect(p?.promptCacheMinTokens).toBe(512);
    expect(p?.promptCacheTtl).toBe('1h');
  });
});

describe('Cache Phase 2 — seeded per-provider prompt-cache policy', () => {
  let db: SQLiteAdapter;
  // Use the full app seed path (applySeed = seedDefaultData + seedFramework), the
  // same one the running server uses, so anthropic/openai models are present.
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); await applySeed(db); });
  afterEach(async () => { await db.close(); });

  it('seeds model_pricing for all providers with the new columns populated', async () => {
    const rows = await db.listModelPricing();
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(r.prompt_cache_min_tokens).toBe(1024);
      expect(['5m', '1h']).toContain(r.prompt_cache_ttl);
      expect([0, 1]).toContain(r.prompt_cache_enabled);
    }
  });

  it('enables prompt caching for cloud providers (anthropic / openai / google)', async () => {
    const rows = await db.listModelPricing();
    const cloud = rows.filter(r => ['anthropic', 'openai', 'google'].includes(r.provider));
    expect(cloud.length).toBeGreaterThan(0);
    expect(cloud.every(r => r.prompt_cache_enabled === 1)).toBe(true);
  });

  it('disables prompt caching for local providers (ollama / llamacpp)', async () => {
    const rows = await db.listModelPricing();
    const local = rows.filter(r => ['ollama', 'llamacpp'].includes(r.provider));
    expect(local.length).toBeGreaterThan(0);
    expect(local.every(r => r.prompt_cache_enabled === 0)).toBe(true);
  });

  it('exposes the seeded policy to the chat path via loadModelPricing', async () => {
    const { pricing } = await loadModelPricing(db, null);
    const claude = pricing.get('claude-sonnet-4-6');
    expect(claude?.promptCacheEnabled).toBe(true);
    expect(claude?.promptCacheMinTokens).toBe(1024);
    const llama = pricing.get('llama3.1');
    expect(llama?.promptCacheEnabled).toBe(false);
  });

  it('upsert (pricing sync) seeds policy for a NEW model but preserves an operator override', async () => {
    // New model via upsert → derived policy (openai → enabled).
    await db.upsertModelPricing({
      id: 'mp-sync-new', model_id: 'gpt-5-test', provider: 'openai', display_name: 'GPT-5 Test',
      input_cost_per_1m: 5, output_cost_per_1m: 20, quality_score: 0.9, source: 'sync', last_synced_at: null, enabled: 1,
    } as any);
    const created = (await db.listModelPricing()).find(r => r.model_id === 'gpt-5-test');
    expect(created?.prompt_cache_enabled).toBe(1);

    // Operator disables it, then a re-sync must NOT re-enable it.
    await db.updateModelPricing(created!.id, { prompt_cache_enabled: 0 } as any);
    await db.upsertModelPricing({
      id: created!.id, model_id: 'gpt-5-test', provider: 'openai', display_name: 'GPT-5 Test v2',
      input_cost_per_1m: 4, output_cost_per_1m: 18, quality_score: 0.91, source: 'sync', last_synced_at: null, enabled: 1,
    } as any);
    const after = (await db.listModelPricing()).find(r => r.model_id === 'gpt-5-test');
    expect(after?.prompt_cache_enabled).toBe(0); // operator tuning survived the re-sync
    expect(after?.display_name).toBe('GPT-5 Test v2'); // but pricing fields updated
  });
});

describe('Cache Phase 2 — plan decision from model policy', () => {
  it('enables caching for a large prefix on a supported provider', () => {
    const plan = planPromptCacheBreakpoints({
      systemText: 'x'.repeat(8000), // ~2000 tokens
      minTokens: 1024,
      providerSupported: true,
      enabled: true,
    });
    expect(plan.enabled).toBe(true);
  });

  it('skips caching when the per-model policy disables it', () => {
    const plan = planPromptCacheBreakpoints({ systemText: 'x'.repeat(8000), enabled: false });
    expect(plan.enabled).toBe(false);
  });

  it('skips explicit caching for a non-Anthropic provider', () => {
    const plan = planPromptCacheBreakpoints({ systemText: 'x'.repeat(8000), providerSupported: false });
    expect(plan.enabled).toBe(false);
  });

  it('skips a sub-minimum prefix (default geneWeave system prompt is small)', () => {
    const plan = planPromptCacheBreakpoints({ systemText: 'You are geneWeave.', minTokens: 1024, providerSupported: true });
    expect(plan.enabled).toBe(false);
  });
});
