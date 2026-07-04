/**
 * DB-backed `TriggerStore` for the GeneWeave SQLite adapter. Maps
 * snake_case row shape ←→ camelCase package shape (`Trigger`,
 * `TriggerInvocation`) and JSON-serialises filter/inputMap/source/
 * target/metadata at the boundary so the package stays DB-agnostic.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type {
  Trigger,
  TriggerInvocation,
  TriggerStore,
  TriggerSourceKind,
  TriggerTargetKind,
  TriggerInvocationStatus,
  ListInvocationsFilter,
} from '@weaveintel/triggers';
import type { DatabaseAdapter, TriggerRow, TriggerInvocationRow } from '../db-types.js';

function safeParseJson(s: string | null | undefined): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}
function rowToTrigger(row: TriggerRow): Trigger {
  const filterRaw = safeParseJson(row.filter_expr) as { expression?: unknown } | undefined;
  const inputMapRaw = safeParseJson(row.input_map) as Record<string, string> | undefined;
  const metadataRaw = safeParseJson(row.metadata) as Record<string, unknown> | undefined;
  return {
    id: row.id,
    key: row.key,
    enabled: row.enabled === 1,
    source: {
      kind: row.source_kind as TriggerSourceKind,
      config: (safeParseJson(row.source_config) as Record<string, unknown> | undefined) ?? {},
    },
    target: {
      kind: row.target_kind as TriggerTargetKind,
      config: (safeParseJson(row.target_config) as Record<string, unknown> | undefined) ?? {},
    },
    ...(filterRaw && filterRaw.expression !== undefined ? { filter: { expression: filterRaw.expression } } : {}),
    ...(inputMapRaw ? { inputMap: inputMapRaw } : {}),
    ...(row.rate_limit_per_minute != null ? { rateLimit: { perMinute: row.rate_limit_per_minute } } : {}),
    ...(metadataRaw ? { metadata: metadataRaw } : {}),
  };
}

function rowToInvocation(row: TriggerInvocationRow): TriggerInvocation {
  const ev = safeParseJson(row.source_event) as Record<string, unknown> | undefined;
  return {
    id: row.id,
    triggerId: row.trigger_id,
    firedAt: new Date(row.fired_at).getTime(),
    sourceKind: row.source_kind as TriggerSourceKind,
    status: row.status as TriggerInvocationStatus,
    ...(row.target_ref != null ? { targetRef: row.target_ref } : {}),
    ...(row.error_message != null ? { errorMessage: row.error_message } : {}),
    ...(ev ? { sourceEvent: ev } : {}),
  };
}

export function createDbTriggerStore(db: DatabaseAdapter): TriggerStore {
  return {
    async list(): Promise<Trigger[]> {
      const rows = await db.listTriggers();
      return rows.map(rowToTrigger);
    },
    async get(id: string): Promise<Trigger | null> {
      const row = await db.getTrigger(id);
      return row ? rowToTrigger(row) : null;
    },
    async getByKey(key: string): Promise<Trigger | null> {
      const row = await db.getTriggerByKey(key);
      return row ? rowToTrigger(row) : null;
    },
    async save(t: Trigger): Promise<void> {
      const existing = await db.getTrigger(t.id);
      const filterJson = t.filter ? JSON.stringify({ expression: t.filter.expression }) : null;
      const inputMapJson = t.inputMap ? JSON.stringify(t.inputMap) : null;
      const metadataJson = t.metadata ? JSON.stringify(t.metadata) : null;
      const sourceConfigJson = JSON.stringify(t.source.config ?? {});
      const targetConfigJson = JSON.stringify(t.target.config ?? {});
      const rate = t.rateLimit?.perMinute ?? null;
      if (existing) {
        await db.updateTrigger(t.id, {
          key: t.key,
          enabled: t.enabled ? 1 : 0,
          source_kind: t.source.kind,
          source_config: sourceConfigJson,
          filter_expr: filterJson,
          target_kind: t.target.kind,
          target_config: targetConfigJson,
          input_map: inputMapJson,
          rate_limit_per_minute: rate,
          metadata: metadataJson,
        });
      } else {
        await db.createTrigger({
          id: t.id,
          key: t.key,
          enabled: t.enabled ? 1 : 0,
          source_kind: t.source.kind,
          source_config: sourceConfigJson,
          filter_expr: filterJson,
          target_kind: t.target.kind,
          target_config: targetConfigJson,
          input_map: inputMapJson,
          rate_limit_per_minute: rate,
          metadata: metadataJson,
        });
      }
    },
    async delete(id: string): Promise<void> {
      await db.deleteTrigger(id);
    },
    async recordInvocation(inv: TriggerInvocation): Promise<void> {
      await db.insertTriggerInvocation({
        id: inv.id,
        trigger_id: inv.triggerId,
        fired_at: new Date(inv.firedAt).toISOString(),
        source_kind: inv.sourceKind,
        status: inv.status,
        target_ref: inv.targetRef ?? null,
        error_message: inv.errorMessage ?? null,
        source_event: inv.sourceEvent ? JSON.stringify(inv.sourceEvent) : null,
      });
    },
    async listInvocations(filter?: ListInvocationsFilter): Promise<TriggerInvocation[]> {
      const rows = await db.listTriggerInvocations({
        ...(filter?.triggerId ? { triggerId: filter.triggerId } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.limit !== undefined ? { limit: filter.limit } : {}),
        ...(filter?.offset !== undefined ? { offset: filter.offset } : {}),
      });
      return rows.map(rowToInvocation);
    },
    async listByOwner(principalId: string): Promise<Trigger[]> {
      const all = await db.listTriggers();
      return all
        .map(rowToTrigger)
        .filter((t) => t.ownerPrincipalId === principalId);
    },
  };
}
