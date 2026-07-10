// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — pinned-version enforcement at resolve time (Section D, item 14).
 *
 * The state overlay has always been able to record `pinnedVersion` for a (tenant, family, logicalKey):
 * "keep giving me version 3 of the built-in support prompt, even after you ship version 4." The column
 * was written, merged nearest-wins down the lineage by `resolveState` — and then **ignored**. Nothing
 * read it, so a pin silently did nothing.
 *
 * This closes that loop. `realm_versions` is an append-only log that stores the full `payload` of every
 * published default, so the pinned content genuinely exists and can be substituted back over the live
 * global row at resolve time.
 *
 * Semantics, deliberately narrow:
 *  • A pin applies to the SHARED default. A tenant with its own fork is already immune to upstream
 *    changes, so a fork wins and the pin is not applied over it (pinning is the no-fork alternative).
 *  • A pin naming a version that was never published is IGNORED (the tenant keeps the current default)
 *    rather than throwing — a stale pin must never take an assistant offline.
 *  • Only fields the family declares semantic are substituted; identity and realm columns never move.
 */
import { createSqlVersionLog, type SqlClient, type SqlDialect } from '@weaveintel/realm';
import { resolveRealmStates } from './realm-tenant-state.js';
import { realmFamily } from './realm-families.js';

/** One pin: the version to serve, and the historical semantic payload to serve it from. */
export interface PinnedContent {
  readonly version: number;
  readonly payload: Record<string, unknown>;
}

/**
 * The pinned content for each of `logicalKeys` that this tenant has pinned to a PUBLISHED version.
 * Keys with no pin, or a pin to a version that doesn't exist in the log, are simply absent from the map.
 * No tenant → no pins (globals are never pinned).
 */
export async function resolvePinnedVersions(
  client: SqlClient, dialect: SqlDialect, family: string, tenantId: string | null, logicalKeys: readonly string[],
): Promise<Map<string, PinnedContent>> {
  const out = new Map<string, PinnedContent>();
  if (!tenantId || logicalKeys.length === 0) return out;

  const states = await resolveRealmStates(client, dialect, family, tenantId, logicalKeys);
  const pinned: Array<[string, number]> = [];
  for (const [key, state] of states) {
    if (typeof state.pinnedVersion === 'number' && Number.isInteger(state.pinnedVersion) && state.pinnedVersion > 0) {
      pinned.push([key, state.pinnedVersion]);
    }
  }
  if (pinned.length === 0) return out;

  const log = createSqlVersionLog<Record<string, unknown>>({ client, dialect, table: 'realm_versions' });
  for (const [key, version] of pinned) {
    const found = await log.at(family, key, version);
    if (found) out.set(key, { version, payload: found.payload }); // absent version → ignore the stale pin
  }
  return out;
}

/**
 * Overlay a pinned historical payload onto a resolved row, replacing only the family's semantic fields.
 * Returns a new object; the input is not mutated. A row that is the tenant's OWN fork is returned
 * untouched — see the module note: a fork already opts out of upstream changes.
 */
export function applyPinnedContent<T extends object>(
  family: string, row: T, pinned: PinnedContent | undefined, tenantId: string | null,
): T {
  if (!pinned) return row;
  const raw = row as unknown as Record<string, unknown>;
  if (raw['realm'] === 'tenant' && raw['owner_tenant_id'] === tenantId) return row; // own fork wins over a pin
  const spec = realmFamily(family);
  const merged: Record<string, unknown> = { ...raw };
  for (const col of spec.semanticCols) {
    if (Object.hasOwn(pinned.payload, col)) {
      const v = pinned.payload[col];
      // The log stores parsed semantics (objects/arrays); the row columns are TEXT-JSON. Re-serialise
      // so downstream readers (which JSON.parse these columns) see the shape they expect.
      merged[col] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    }
  }
  merged['realm_pinned_version'] = pinned.version; // provenance breadcrumb for admin/debug surfaces
  return merged as unknown as T;
}
