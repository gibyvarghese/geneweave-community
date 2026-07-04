/**
 * GeneWeave: persistence + bootstrap for `tenant_encryption_alert_config`.
 *
 * Bridges the package-level `AlertRule` shape with the DB row shape, and
 * seeds `DEFAULT_ALERT_RULES` against fleet scope (`tenant_id = NULL`) on
 * first boot so the admin dashboard isn't empty out of the box.
 *
 * Reusability: this module is geneweave-specific (it touches the SQLite
 * adapter), but every other host can write a similar shim — the contract
 * is just `AlertRule[]` in/out.
 */

import { newUUIDv7 } from '@weaveintel/core';
import { DEFAULT_ALERT_RULES, type AlertRule, type AlertRuleKind } from '@weaveintel/encryption';
import type { DatabaseAdapter, TenantEncryptionAlertConfigRow } from '../db-types.js';

export function rowToAlertRule(r: TenantEncryptionAlertConfigRow): AlertRule {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind as AlertRuleKind,
    threshold: r.threshold,
    windowMs: r.window_ms,
    enabled: r.enabled === 1,
    description: r.description,
  };
}

export async function listAlertRules(
  db: DatabaseAdapter,
  opts?: { tenantId?: string | null },
): Promise<AlertRule[]> {
  const rows = await db.listEncryptionAlertConfig(opts);
  return rows.map(rowToAlertRule);
}

export interface UpsertAlertRuleInput {
  readonly id?: string;
  readonly tenantId: string | null;
  readonly kind: AlertRuleKind;
  readonly threshold: number;
  readonly windowMs?: number | null;
  readonly enabled?: boolean;
  readonly description?: string | null;
}

export async function upsertAlertRule(
  db: DatabaseAdapter,
  input: UpsertAlertRuleInput,
): Promise<AlertRule> {
  const id = input.id ?? newUUIDv7();
  await db.upsertEncryptionAlertConfig({
    id,
    tenant_id: input.tenantId,
    kind: input.kind,
    threshold: input.threshold,
    window_ms: input.windowMs ?? null,
    enabled: (input.enabled ?? true) ? 1 : 0,
    description: input.description ?? null,
  });
  // Re-read so we get the canonical row (including any merged id from a unique
  // (tenant, kind) collision).
  const rows = await db.listEncryptionAlertConfig({ tenantId: input.tenantId });
  const found = rows.find((r) => r.kind === input.kind);
  if (!found) throw new Error(`upsertAlertRule: row missing after write for ${input.kind}`);
  return rowToAlertRule(found);
}

export async function deleteAlertRule(db: DatabaseAdapter, id: string): Promise<boolean> {
  return db.deleteEncryptionAlertConfig(id);
}

export interface SeedAlertRulesOptions {
  /** Tenant scope to seed against. Default: `null` (fleet-wide). */
  readonly tenantId?: string | null;
  /** Override the rule template list. */
  readonly rules?: readonly Omit<AlertRule, 'id' | 'tenantId'>[];
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Idempotently seed the default Phase 9 alert rules. Skips any `(tenantId, kind)`
 * pair that already has a row so operator edits are preserved across reboots.
 */
export async function seedDefaultAlertRules(
  db: DatabaseAdapter,
  opts: SeedAlertRulesOptions = {},
): Promise<{ inserted: number; existing: number }> {
  const tenantId = opts.tenantId ?? null;
  const rules = opts.rules ?? DEFAULT_ALERT_RULES;
  const existingRows = await db.listEncryptionAlertConfig({ tenantId });
  const existingKinds = new Set(existingRows.map((r) => r.kind));
  let inserted = 0;
  let existing = 0;
  for (const r of rules) {
    if (existingKinds.has(r.kind)) {
      existing++;
      continue;
    }
    await db.upsertEncryptionAlertConfig({
      id: newUUIDv7(),
      tenant_id: tenantId,
      kind: r.kind,
      threshold: r.threshold,
      window_ms: r.windowMs ?? null,
      enabled: r.enabled ? 1 : 0,
      description: r.description ?? null,
    });
    inserted++;
  }
  opts.log?.(`encryption alerts seeded`, { tenantId, inserted, existing });
  return { inserted, existing };
}
