import type BetterSqlite3 from 'better-sqlite3';
import { applyRealmColumns } from './realm-columns-helper.js';

/**
 * m166 — Realm columns on the live-agent registries: `live_handler_kinds`, `live_attention_policies`
 * (Tenancy Realm — extend content-forking to the live-agent runtime registries).
 *
 * These define what kinds of live-agent handlers exist and how attention/scheduling policies behave. A
 * tenant can keep its own tuned copy (a custom attention policy, a handler-kind config) without changing
 * the global default.
 *
 *   • live_handler_kinds keys on `kind`.  • live_attention_policies keys on `key`.  Both exclude enabled.
 *
 * Relabel, zero data movement. Idempotent. Postgres via regenerated schema.
 */
export const LIVE_HANDLER_KIND_SEMANTIC_COLS = ['description', 'config_schema_json', 'source'] as const;
export const LIVE_ATTENTION_POLICY_SEMANTIC_COLS = ['kind', 'description', 'config_json'] as const;

export function applyM166RealmColumnsLiveRegistries(db: BetterSqlite3.Database): void {
  applyRealmColumns(db, 'live_handler_kinds', 'kind', LIVE_HANDLER_KIND_SEMANTIC_COLS);
  applyRealmColumns(db, 'live_attention_policies', 'key', LIVE_ATTENTION_POLICY_SEMANTIC_COLS);
}
