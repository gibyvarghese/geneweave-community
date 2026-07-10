/**
 * Shared admin guards for the Tenancy Realm write path (Section D).
 *
 * Both rules apply identically to every realm family, so they live here rather than being re-typed in
 * each of the eleven route files:
 *
 *  • `guardCustomizable` (D15) — a DEPRECATED global default may not gain new forks. Tenants already on
 *    it keep resolving it; this only refuses to create another copy, and names the replacement if one
 *    was recorded. 409 Conflict.
 *
 *  • `guardKeyCollision` (D17) — "visible key ⇒ only Customize, never create". If the caller can already
 *    SEE a record under that logical key (a global, or an ancestor's shared fork), creating a second one
 *    would put two candidates under one logical key. Without this the composite unique index rejects it
 *    as an opaque 500; with it the caller gets a 409 that says which record to customize instead.
 *
 * Both return `true` when the request may proceed, and have already written the error response when not.
 */
import type { ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../../db.js';
import type { AuthContext } from '../../auth.js';
import { assertCustomizable } from '../../realm-governance.js';

type Json = (res: ServerResponse, status: number, data: unknown) => void;

/** D15: refuse to fork a deprecated global default. */
export function guardCustomizable(json: Json, res: ServerResponse, globalRow: object): boolean {
  const gate = assertCustomizable(globalRow as Record<string, unknown>);
  if (gate.ok) return true;
  json(res, 409, {
    error: gate.reason,
    ...(gate.supersededById ? { supersededById: gate.supersededById } : {}),
  });
  return false;
}

/**
 * D17: refuse to CREATE a record under a logical key the caller can already see — customize it instead.
 * The caller's realm context is their own tenant (a platform admin has none → the global context, where
 * only globals are visible, which is exactly right for "don't create a duplicate global").
 */
export async function guardKeyCollision(
  json: Json, res: ServerResponse, db: DatabaseAdapter,
  family: string, logicalKey: string, auth: AuthContext,
): Promise<boolean> {
  if (!logicalKey) return true; // nothing to collide with; the route's own validation reports the miss
  const collision = await db.checkRealmKeyCollision(family, logicalKey, auth.tenantId ?? null);
  if (!collision.collides) return true;
  json(res, 409, {
    error: collision.reason,
    ...(collision.visibleId ? { customizeId: collision.visibleId } : {}),
    ...(collision.visibleRealm ? { visibleRealm: collision.visibleRealm } : {}),
  });
  return false;
}
