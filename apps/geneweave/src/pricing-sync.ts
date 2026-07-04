/**
 * @weaveintel/geneweave — Model Pricing Sync
 *
 * Fetches available models from provider APIs (using configured API keys)
 * and populates the model_pricing table with known pricing data.
 *
 * Provider API capabilities:
 *  - OpenAI:    GET /v1/models → lists model IDs (no pricing in response)
 *  - Anthropic: GET /v1/models → lists model IDs (no pricing in response)
 *
 * Since neither provider exposes pricing via API, we maintain a built-in
 * pricing registry and use the API to discover which models are accessible
 * with the configured API key.
 */

import { hardenedFetch } from '@weaveintel/core';
import { ollamaFetch } from '@weaveintel/provider-ollama';
import type { DatabaseAdapter, ModelPricingRow } from './db.js';

// ─── Built-in pricing registry ───────────────────────────────
// Source of truth for known pricing (per 1M tokens) and quality scores.
// Updated periodically. The sync process uses this to populate the DB.

interface KnownModelPricing {
  displayName: string;
  input: number;
  output: number;
  quality: number;
}

const OPENAI_PRICING_REGISTRY: Record<string, KnownModelPricing> = {
  'gpt-4o':           { displayName: 'GPT-4o',         input: 2.50,  output: 10.00, quality: 0.90 },
  'gpt-4o-mini':      { displayName: 'GPT-4o Mini',    input: 0.15,  output: 0.60,  quality: 0.75 },
  'gpt-4.1':          { displayName: 'GPT-4.1',        input: 2.00,  output: 8.00,  quality: 0.90 },
  'gpt-4.1-mini':     { displayName: 'GPT-4.1 Mini',   input: 0.40,  output: 1.60,  quality: 0.75 },
  'gpt-4.1-nano':     { displayName: 'GPT-4.1 Nano',   input: 0.10,  output: 0.40,  quality: 0.60 },
  'o3':               { displayName: 'o3',              input: 2.00,  output: 8.00,  quality: 0.85 },
  'o3-mini':          { displayName: 'o3 Mini',         input: 1.10,  output: 4.40,  quality: 0.75 },
  'o4-mini':          { displayName: 'o4 Mini',         input: 1.10,  output: 4.40,  quality: 0.75 },
  'gpt-4-turbo':      { displayName: 'GPT-4 Turbo',    input: 10.00, output: 30.00, quality: 0.88 },
  'gpt-4':            { displayName: 'GPT-4',           input: 30.00, output: 60.00, quality: 0.88 },
  'gpt-3.5-turbo':    { displayName: 'GPT-3.5 Turbo',  input: 0.50,  output: 1.50,  quality: 0.65 },
};

const ANTHROPIC_PRICING_REGISTRY: Record<string, KnownModelPricing> = {
  'claude-opus-4-7':             { displayName: 'Claude Opus 4.7',      input: 15.00, output: 75.00, quality: 0.95 },
  'claude-sonnet-4-6':           { displayName: 'Claude Sonnet 4.6',    input: 3.00,  output: 15.00, quality: 0.87 },
  'claude-haiku-4-5-20251001':   { displayName: 'Claude Haiku 4.5',     input: 0.80,  output: 4.00,  quality: 0.72 },
  'claude-3-5-sonnet-20241022':  { displayName: 'Claude 3.5 Sonnet',    input: 3.00,  output: 15.00, quality: 0.85 },
  'claude-3-5-haiku-20241022':   { displayName: 'Claude 3.5 Haiku',     input: 1.00,  output: 5.00,  quality: 0.70 },
  'claude-3-opus-20240229':      { displayName: 'Claude 3 Opus',        input: 15.00, output: 75.00, quality: 0.92 },
  'claude-3-sonnet-20240229':    { displayName: 'Claude 3 Sonnet',      input: 3.00,  output: 15.00, quality: 0.82 },
  'claude-3-haiku-20240307':     { displayName: 'Claude 3 Haiku',       input: 0.25,  output: 1.25,  quality: 0.68 },
};

// Google Gemini — public list pricing per 1M tokens (USD).
const GOOGLE_PRICING_REGISTRY: Record<string, KnownModelPricing> = {
  'gemini-2.5-pro':         { displayName: 'Gemini 2.5 Pro',        input: 1.25,   output: 10.00, quality: 0.92 },
  'gemini-2.5-flash':       { displayName: 'Gemini 2.5 Flash',      input: 0.30,   output: 2.50,  quality: 0.82 },
  'gemini-2.5-flash-lite':  { displayName: 'Gemini 2.5 Flash Lite', input: 0.10,   output: 0.40,  quality: 0.72 },
  'gemini-2.0-flash':       { displayName: 'Gemini 2.0 Flash',      input: 0.10,   output: 0.40,  quality: 0.78 },
  'gemini-1.5-pro':         { displayName: 'Gemini 1.5 Pro',        input: 1.25,   output: 5.00,  quality: 0.85 },
  'gemini-1.5-flash':       { displayName: 'Gemini 1.5 Flash',      input: 0.075,  output: 0.30,  quality: 0.72 },
  'gemini-1.5-flash-8b':    { displayName: 'Gemini 1.5 Flash 8B',   input: 0.0375, output: 0.15,  quality: 0.65 },
  'text-embedding-004':     { displayName: 'Gemini Embeddings 004', input: 0.025,  output: 0,     quality: 0.70 },
};

// Local providers — zero-cost; quality is a rough heuristic operators can override.
const OLLAMA_PRICING_REGISTRY: Record<string, KnownModelPricing> = {
  'llama3.1':         { displayName: 'Llama 3.1 (local)',        input: 0, output: 0, quality: 0.72 },
  'llama3':           { displayName: 'Llama 3 (local)',          input: 0, output: 0, quality: 0.70 },
  'llama3.2':         { displayName: 'Llama 3.2 (local)',        input: 0, output: 0, quality: 0.70 },
  'llama3.2-vision':  { displayName: 'Llama 3.2 Vision (local)', input: 0, output: 0, quality: 0.70 },
  'llama4':           { displayName: 'Llama 4 (local)',          input: 0, output: 0, quality: 0.78 },
  'qwen2.5':          { displayName: 'Qwen 2.5 (local)',         input: 0, output: 0, quality: 0.74 },
  'qwen3':            { displayName: 'Qwen 3 (local)',           input: 0, output: 0, quality: 0.76 },
  'mistral':          { displayName: 'Mistral (local)',          input: 0, output: 0, quality: 0.68 },
  'mixtral':          { displayName: 'Mixtral (local)',          input: 0, output: 0, quality: 0.74 },
  'phi3':             { displayName: 'Phi 3 (local)',            input: 0, output: 0, quality: 0.65 },
  'phi3.5':           { displayName: 'Phi 3.5 (local)',          input: 0, output: 0, quality: 0.66 },
  'gemma2':           { displayName: 'Gemma 2 (local)',          input: 0, output: 0, quality: 0.66 },
  'deepseek-r1':      { displayName: 'DeepSeek R1 (local)',      input: 0, output: 0, quality: 0.80 },
  'llava':            { displayName: 'LLaVA (local)',            input: 0, output: 0, quality: 0.62 },
  'codellama':        { displayName: 'Code Llama (local)',       input: 0, output: 0, quality: 0.65 },
  'codestral':        { displayName: 'Codestral (local)',        input: 0, output: 0, quality: 0.70 },
  'starcoder2':       { displayName: 'StarCoder2 (local)',       input: 0, output: 0, quality: 0.65 },
  'nomic-embed-text': { displayName: 'Nomic Embed Text (local)', input: 0, output: 0, quality: 0.70 },
  'all-minilm':       { displayName: 'All MiniLM (local)',       input: 0, output: 0, quality: 0.60 },
  'gpt-oss':          { displayName: 'GPT-OSS (local)',          input: 0, output: 0, quality: 0.74 },
};

const LLAMACPP_PRICING_REGISTRY: Record<string, KnownModelPricing> = {
  'local': { displayName: 'llama.cpp local model', input: 0, output: 0, quality: 0.70 },
};

export interface SyncResult {
  provider: string;
  discovered: number;
  matched: number;
  upserted: number;
  errors: string[];
}

export interface PricingSyncReport {
  results: SyncResult[];
  totalUpserted: number;
  syncedAt: string;
}

// ─── Fetch models from OpenAI ────────────────────────────────

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  const res = await hardenedFetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, { errorTag: 'geneweave-pricing-sync' });
  if (!res.ok) {
    throw new Error(`OpenAI models API returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { data: Array<{ id: string }> };
  return body.data.map(m => m.id);
}

// ─── Fetch models from Anthropic ─────────────────────────────

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await hardenedFetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  }, { errorTag: 'geneweave-pricing-sync' });
  if (!res.ok) {
    throw new Error(`Anthropic models API returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { data: Array<{ id: string }> };
  return body.data.map(m => m.id);
}

// ─── Fetch models from Google Gemini ─────────────────────────

async function fetchGoogleModels(apiKey: string): Promise<string[]> {
  const res = await hardenedFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, undefined, { errorTag: 'geneweave-pricing-sync' });
  if (!res.ok) {
    throw new Error(`Google models API returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { models?: Array<{ name: string }> };
  // names look like "models/gemini-2.5-pro" — strip prefix
  return (body.models ?? []).map(m => m.name.replace(/^models\//, ''));
}

// ─── Fetch models from a local Ollama daemon ─────────────────

async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/api/tags';
  const res = await ollamaFetch(url, undefined, { maxBytes: 1 * 1024 * 1024 });
  if (!res.ok) {
    throw new Error(`Ollama tags API returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { models?: Array<{ name: string }> };
  return (body.models ?? []).map(m => m.name);
}

// ─── Match models against registry ───────────────────────────

function matchModels(
  discoveredIds: string[],
  registry: Record<string, KnownModelPricing>,
): Array<{ modelId: string; pricing: KnownModelPricing }> {
  const matches: Array<{ modelId: string; pricing: KnownModelPricing }> = [];
  for (const id of discoveredIds) {
    // Exact match
    if (registry[id]) {
      matches.push({ modelId: id, pricing: registry[id] });
      continue;
    }
    // Prefix match (e.g., 'gpt-4o-2024-08-06' → 'gpt-4o')
    for (const [registryId, pricing] of Object.entries(registry)) {
      if (id.startsWith(registryId + '-') || id.startsWith(registryId + ':')) {
        matches.push({ modelId: id, pricing });
        break;
      }
    }
  }
  return matches;
}

// ─── Main sync function ──────────────────────────────────────

export async function syncModelPricing(
  db: DatabaseAdapter,
  providers: Record<string, { apiKey?: string; baseUrl?: string }>,
): Promise<PricingSyncReport> {
  const results: SyncResult[] = [];
  let totalUpserted = 0;
  const syncedAt = new Date().toISOString();

  for (const [provider, config] of Object.entries(providers)) {
    const result: SyncResult = { provider, discovered: 0, matched: 0, upserted: 0, errors: [] };

    try {
      let discoveredIds: string[];
      let registry: Record<string, KnownModelPricing>;

      if (provider === 'openai') {
        if (!config.apiKey) {
          result.errors.push('Missing apiKey — skipped');
          results.push(result);
          continue;
        }
        discoveredIds = await fetchOpenAIModels(config.apiKey);
        registry = OPENAI_PRICING_REGISTRY;
      } else if (provider === 'anthropic') {
        if (!config.apiKey) {
          result.errors.push('Missing apiKey — skipped');
          results.push(result);
          continue;
        }
        discoveredIds = await fetchAnthropicModels(config.apiKey);
        registry = ANTHROPIC_PRICING_REGISTRY;
      } else if (provider === 'google' || provider === 'gemini') {
        if (!config.apiKey) {
          result.errors.push('Missing apiKey — skipped');
          results.push(result);
          continue;
        }
        discoveredIds = await fetchGoogleModels(config.apiKey);
        registry = GOOGLE_PRICING_REGISTRY;
      } else if (provider === 'ollama') {
        const baseUrl = config.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
        try {
          discoveredIds = await fetchOllamaModels(baseUrl);
        } catch (err: unknown) {
          // Local daemon may be offline — fall back to seeding the registry directly
          // so routing knows about typical local models.
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Ollama daemon unreachable at ${baseUrl} (${msg}) — seeding registry defaults`);
          discoveredIds = Object.keys(OLLAMA_PRICING_REGISTRY);
        }
        registry = OLLAMA_PRICING_REGISTRY;
      } else if (provider === 'llamacpp' || provider === 'llama-cpp') {
        // llama.cpp does not expose a discovery endpoint; seed the single registry entry.
        discoveredIds = Object.keys(LLAMACPP_PRICING_REGISTRY);
        registry = LLAMACPP_PRICING_REGISTRY;
      } else {
        result.errors.push(`Unknown provider "${provider}" — skipped`);
        results.push(result);
        continue;
      }

      result.discovered = discoveredIds.length;
      const matched = matchModels(discoveredIds, registry);
      result.matched = matched.length;

      // Pre-load existing rows so we can preserve operator edits (source='manual').
      const existing = await db.listModelPricing();
      const existingByKey = new Map<string, ModelPricingRow>();
      for (const r of existing) existingByKey.set(`${r.provider}::${r.model_id}`, r);

      for (const { modelId, pricing } of matched) {
        const key = `${provider}::${modelId}`;
        const prior = existingByKey.get(key);
        // Never overwrite operator-edited rows; refresh only the synced timestamp.
        if (prior && prior.source === 'manual') {
          await db.updateModelPricing(prior.id, { last_synced_at: syncedAt });
          continue;
        }
        const id = prior?.id ?? `mp-${provider}-${modelId}`.replace(/[^a-zA-Z0-9-]/g, '-');
        const row: Omit<ModelPricingRow, 'created_at' | 'updated_at'> = {
          id,
          model_id: modelId,
          provider,
          display_name: pricing.displayName,
          input_cost_per_1m: pricing.input,
          output_cost_per_1m: pricing.output,
          quality_score: pricing.quality,
          source: 'sync',
          last_synced_at: syncedAt,
          enabled: prior?.enabled ?? 1,
        };
        await db.upsertModelPricing(row);
        result.upserted++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(msg);
    }

    totalUpserted += result.upserted;
    results.push(result);
  }

  return { results, totalUpserted, syncedAt };
}
