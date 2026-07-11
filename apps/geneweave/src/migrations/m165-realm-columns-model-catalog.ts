import type BetterSqlite3 from 'better-sqlite3';
import { applyRealmColumns } from './realm-columns-helper.js';

/**
 * m165 — Realm columns on the model catalog: `model_pricing`, `task_type_definitions`,
 * `provider_tool_adapters` (Tenancy Realm — extend content-forking to routing inputs).
 *
 * These are the tables that tune how routing sees the world: a model's pricing/labels, a task type's
 * defaults, and how a provider's tool calls are shaped. Classifying them as realm originals lets a tenant
 * keep its own tuned copy without affecting anyone else.
 *
 *   • model_pricing keys on the (provider, model_id) pair — a COMPOSITE natural key, so logical_key is the
 *     concatenation `provider || '::' || model_id`. Excludes last_synced_at (sync state) + enabled.
 *   • task_type_definitions keys on `task_key`. Excludes enabled.
 *   • provider_tool_adapters keys on `provider`. Excludes enabled.
 *
 * Relabel, zero data movement. Idempotent. Postgres via regenerated schema.
 */
export const MODEL_PRICING_SEMANTIC_COLS = [
  'display_name', 'quality_score', 'source', 'prompt_cache_enabled', 'prompt_cache_min_tokens',
  'prompt_cache_ttl', 'output_modality', 'context_window_k', 'max_output_tokens_k',
] as const;

export const TASK_TYPE_SEMANTIC_COLS = [
  'display_name', 'category', 'description', 'output_modality', 'default_strategy', 'default_weights',
  'cost', 'speed', 'quality', 'capability', 'inference_hints',
] as const;

export const PROVIDER_TOOL_ADAPTER_SEMANTIC_COLS = [
  'display_name', 'adapter_module', 'tool_format', 'tool_call_response_format', 'tool_result_format',
  'system_prompt_location', 'name_validation_regex', 'max_tool_count',
] as const;

export function applyM165RealmColumnsModelCatalog(db: BetterSqlite3.Database): void {
  applyRealmColumns(db, 'model_pricing', `provider || '::' || model_id`, MODEL_PRICING_SEMANTIC_COLS);
  applyRealmColumns(db, 'task_type_definitions', 'task_key', TASK_TYPE_SEMANTIC_COLS);
  applyRealmColumns(db, 'provider_tool_adapters', 'provider', PROVIDER_TOOL_ADAPTER_SEMANTIC_COLS);
}
