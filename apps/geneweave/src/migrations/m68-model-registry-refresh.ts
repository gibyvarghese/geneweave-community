/**
 * m68 — Model Registry Refresh (mid-2026)
 *
 * Phase 1 of the mid-2026 model registry audit.  All DDL is wrapped in
 * safeExec so this migration is fully idempotent.
 *
 * Changes:
 *   1. model_pricing — add context_window_k + max_output_tokens_k columns
 *   2. model_capability_scores — add supports_computer_use, supports_long_context,
 *      supports_realtime_audio columns
 *   3. Disable deprecated models: gemini-1.5-pro, gemini-1.5-flash (shutdown June 2026),
 *      llama3 (superseded by llama3.3), phi3 (superseded by phi4),
 *      gemma2 (superseded by gemma3)
 *   4. Backfill context_window_k for all known existing model_pricing rows
 *   5. Backfill supports_computer_use / supports_long_context /
 *      supports_realtime_audio for existing capability score rows
 *   6. Raise o3 quality_score from 0.85 → 0.93 (benchmark corrections post-audit)
 */

import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

export function applyM68ModelRegistryRefresh(db: BetterSqlite3.Database): void {

  // ── 1. DDL: new columns on model_pricing ────────────────────────────────────
  safeExec(db, `ALTER TABLE model_pricing ADD COLUMN context_window_k INTEGER`);
  safeExec(db, `ALTER TABLE model_pricing ADD COLUMN max_output_tokens_k INTEGER`);

  // ── 2. DDL: new capability flag columns on model_capability_scores ───────────
  safeExec(db, `ALTER TABLE model_capability_scores ADD COLUMN supports_computer_use INTEGER NOT NULL DEFAULT 0`);
  safeExec(db, `ALTER TABLE model_capability_scores ADD COLUMN supports_long_context INTEGER NOT NULL DEFAULT 0`);
  safeExec(db, `ALTER TABLE model_capability_scores ADD COLUMN supports_realtime_audio INTEGER NOT NULL DEFAULT 0`);

  // ── 3. Disable deprecated / shutdown models ──────────────────────────────────
  // Gemini 1.5 series: officially shutdown June 2026 — no longer callable
  db.prepare(
    `UPDATE model_pricing SET enabled = 0, updated_at = datetime('now')
     WHERE model_id IN ('gemini-1.5-pro', 'gemini-1.5-flash') AND provider = 'google'`,
  ).run();

  // Ollama legacy models superseded by newer versions
  db.prepare(
    `UPDATE model_pricing SET enabled = 0, updated_at = datetime('now')
     WHERE model_id IN ('llama3', 'phi3', 'gemma2') AND provider = 'ollama'`,
  ).run();

  // llamacpp direct-inference model: requires manual operator setup; keep disabled
  // by default (m01-m10 incorrectly seeded it as enabled=1).
  db.prepare(
    `UPDATE model_pricing SET enabled = 0, updated_at = datetime('now')
     WHERE model_id = 'local' AND provider = 'llamacpp'`,
  ).run();

  // ── 4. Backfill context_window_k for existing model_pricing rows ─────────────
  // Only update rows where context_window_k IS NULL to stay idempotent.
  const contextWindows: [number, string, string][] = [
    // [context_window_k, model_id, provider]
    // Anthropic
    [200,   'claude-sonnet-4-6',         'anthropic'],
    [200,   'claude-opus-4-7',           'anthropic'],
    [200,   'claude-haiku-4-5-20251001', 'anthropic'],
    [1000,  'claude-fable-5',            'anthropic'],
    [1000,  'claude-opus-4-8',           'anthropic'],
    // OpenAI
    [128,   'gpt-4o',                    'openai'],
    [128,   'gpt-4o-mini',               'openai'],
    [1000,  'gpt-4.1',                   'openai'],
    [1000,  'gpt-4.1-mini',              'openai'],
    [1000,  'gpt-4.1-nano',              'openai'],
    [200,   'o3',                        'openai'],
    [200,   'o4-mini',                   'openai'],
    // Google
    [1000,  'gemini-2.5-pro',            'google'],
    [1000,  'gemini-2.5-flash',          'google'],
    [1000,  'gemini-2.5-flash-lite',     'google'],
    [2000,  'gemini-1.5-pro',            'google'],
    [1000,  'gemini-1.5-flash',          'google'],
    // xAI
    [131,   'grok-3',                    'xai'],
    [1000,  'grok-4',                    'xai'],
    // DeepSeek
    [128,   'deepseek-v3',               'deepseek'],
    [164,   'deepseek-r1-api',           'deepseek'],
    // Mistral
    [128,   'mistral-large-2',           'mistral'],
    [128,   'mistral-medium-3',          'mistral'],
    [256,   'codestral',                 'mistral'],
    // Amazon
    [300,   'amazon-nova-pro',           'amazon'],
    [300,   'amazon-nova-lite',          'amazon'],
    [128,   'amazon-nova-micro',         'amazon'],
    // Meta API
    [10000, 'llama-4-scout',             'meta'],
    [512,   'llama-4-maverick',          'meta'],
    // Ollama / local
    [128,   'llama3.1',                  'ollama'],
    [8,     'llama3',                    'ollama'],
    [128,   'qwen2.5',                   'ollama'],
    [32,    'mistral',                   'ollama'],
    [128,   'phi3',                      'ollama'],
    [8,     'gemma2',                    'ollama'],
    [128,   'deepseek-r1',               'ollama'],
    [128,   'llama3.3',                  'ollama'],
    [128,   'qwen3',                     'ollama'],
    [128,   'phi4',                      'ollama'],
    [128,   'gemma3',                    'ollama'],
    [128,   'mistral-nemo',              'ollama'],
    [256,   'codestral-local',           'ollama'],
    [8,     'local',                     'llamacpp'],
  ];

  const updateCtx = db.prepare(
    `UPDATE model_pricing SET context_window_k = ? WHERE model_id = ? AND provider = ? AND context_window_k IS NULL`,
  );
  for (const [k, modelId, provider] of contextWindows) {
    updateCtx.run(k, modelId, provider);
  }

  // ── 5. Backfill max_output_tokens_k for existing model_pricing rows ──────────
  const maxOutputTokens: [number, string, string][] = [
    [64,  'claude-sonnet-4-6',         'anthropic'],
    [32,  'claude-opus-4-7',           'anthropic'],
    [8,   'claude-haiku-4-5-20251001', 'anthropic'],
    [64,  'claude-fable-5',            'anthropic'],
    [32,  'claude-opus-4-8',           'anthropic'],
    [16,  'gpt-4o',                    'openai'],
    [16,  'gpt-4o-mini',               'openai'],
    [32,  'gpt-4.1',                   'openai'],
    [32,  'gpt-4.1-mini',              'openai'],
    [32,  'gpt-4.1-nano',              'openai'],
    [100, 'o3',                        'openai'],
    [100, 'o4-mini',                   'openai'],
    [65,  'gemini-2.5-pro',            'google'],
    [65,  'gemini-2.5-flash',          'google'],
    [8,   'gemini-2.5-flash-lite',     'google'],
    [8,   'gemini-1.5-pro',            'google'],
    [8,   'gemini-1.5-flash',          'google'],
    [32,  'grok-3',                    'xai'],
    [32,  'grok-4',                    'xai'],
    [8,   'deepseek-v3',               'deepseek'],
    [64,  'deepseek-r1-api',           'deepseek'],
    [32,  'mistral-large-2',           'mistral'],
    [32,  'mistral-medium-3',          'mistral'],
    [32,  'codestral',                 'mistral'],
    [5,   'amazon-nova-pro',           'amazon'],
    [5,   'amazon-nova-lite',          'amazon'],
    [5,   'amazon-nova-micro',         'amazon'],
    [16,  'llama-4-scout',             'meta'],
    [16,  'llama-4-maverick',          'meta'],
  ];

  const updateMaxOut = db.prepare(
    `UPDATE model_pricing SET max_output_tokens_k = ? WHERE model_id = ? AND provider = ? AND max_output_tokens_k IS NULL`,
  );
  for (const [k, modelId, provider] of maxOutputTokens) {
    updateMaxOut.run(k, modelId, provider);
  }

  // ── 6. Quality-score corrections ────────────────────────────────────────────
  // o3 quality_score was seeded at 0.85; post-audit benchmarks show 0.93
  db.prepare(
    `UPDATE model_pricing SET quality_score = 0.93, updated_at = datetime('now')
     WHERE model_id = 'o3' AND provider = 'openai' AND quality_score < 0.90`,
  ).run();

  // ── 7. Backfill new capability columns on existing score rows ────────────────
  // claude-opus-4-8 supports computer-use
  db.prepare(
    `UPDATE model_capability_scores SET supports_computer_use = 1
     WHERE model_id = 'claude-opus-4-8' AND supports_computer_use = 0`,
  ).run();

  // gpt-4o supports realtime audio
  db.prepare(
    `UPDATE model_capability_scores SET supports_realtime_audio = 1
     WHERE model_id = 'gpt-4o' AND supports_realtime_audio = 0`,
  ).run();

  // Long-context capable models (≥ 512k window)
  const longContextModels = [
    'claude-fable-5', 'claude-opus-4-8',
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
    'gemini-1.5-pro', 'gemini-1.5-flash',
    'grok-4',
    'llama-4-scout', 'llama-4-maverick',
  ];
  const placeholders = longContextModels.map(() => '?').join(', ');
  db.prepare(
    `UPDATE model_capability_scores SET supports_long_context = 1
     WHERE model_id IN (${placeholders}) AND supports_long_context = 0`,
  ).run(...longContextModels);
}
