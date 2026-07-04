import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * M23 — Fix stale Claude model IDs across all seed-derived tables.
 *
 * The original seed used release-date suffixed IDs from the Anthropic beta
 * period. Provider packages use the stable, suffix-free model IDs that the
 * production API accepts. This migration updates all tables that store model
 * IDs so existing installations converge to the correct values.
 *
 * Table scope: model_pricing, routing_policies, tenant_configs,
 *              model_capability_scores, cost_policies.
 *
 * Idempotent: UPDATE … WHERE model_id = '…' is a no-op if already migrated.
 */
export function applyM23(db: BetterSqlite3.Database): void {
  const renames: Array<{ old: string; new: string }> = [
    { old: 'claude-sonnet-4-20250514', new: 'claude-sonnet-4-6' },
    { old: 'claude-opus-4-20250514',   new: 'claude-opus-4-7' },
    { old: 'claude-haiku-4-20250414',  new: 'claude-haiku-4-5-20251001' },
  ];

  for (const { old: oldId, new: newId } of renames) {
    // model_pricing — primary source of truth for pricing
    safeExec(db, `UPDATE model_pricing SET model_id = '${newId}' WHERE model_id = '${oldId}'`);

    // model_capability_scores — referenced by the anyWeave router
    safeExec(db, `UPDATE model_capability_scores SET model_id = '${newId}' WHERE model_id = '${oldId}'`);

    // routing_policies — fallback_model column is a model_id reference
    safeExec(db, `
      UPDATE routing_policies
      SET fallback_model = '${newId}'
      WHERE fallback_model = '${oldId}'
    `);

    // tenant_configs — allowed_models / denied_models are JSON arrays
    // Replace the old ID string within the JSON text. SQLite's json_each is
    // not universally available, so a safe string replace is used instead.
    safeExec(db, `
      UPDATE tenant_configs
      SET allowed_models = replace(allowed_models, '"${oldId}"', '"${newId}"')
      WHERE instr(allowed_models, '${oldId}') > 0
    `);
    safeExec(db, `
      UPDATE tenant_configs
      SET denied_models = replace(denied_models, '"${oldId}"', '"${newId}"')
      WHERE denied_models IS NOT NULL AND instr(denied_models, '${oldId}') > 0
    `);

    // cost_policies — allowed_models JSON array
    safeExec(db, `
      UPDATE cost_policies
      SET allowed_models = replace(allowed_models, '"${oldId}"', '"${newId}"')
      WHERE allowed_models IS NOT NULL AND instr(allowed_models, '${oldId}') > 0
    `);
  }
}
