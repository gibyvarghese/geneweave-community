/**
 * Workspace roles — RBAC surface parity (m143) — the client side.
 *
 * The server computes which UI areas THIS user should see (their persona's permissions AND the workspace's
 * per-tenant policy for optional member areas — see @weaveintel/identity canAccessArea + tenant_role_access).
 * The client just asks once and HIDES the areas it's told to, so a non-admin never sees admin controls that
 * would only 403 (that's confusing + leaks features). Loaded before the first render, so there's no flash.
 */
import { api } from './api.js';

let _access: { isAdmin: boolean; areas: Record<string, boolean> } | null = null;

export async function loadWorkspaceAccess(): Promise<void> {
  try {
    const res = await api.get('/api/me/workspace-access');
    if (!res || !(res as Response).ok) return;
    const d = await (res as Response).json() as { isAdmin?: boolean; areas?: Record<string, boolean> };
    _access = { isAdmin: !!d.isAdmin, areas: d.areas ?? {} };
  } catch { /* keep null → everything visible (safe default; nav still works) */ }
}

/** Should this user see a UI area? Unknown/not-yet-loaded → visible (the areas map only ever HIDES). */
export function canSeeArea(area: string): boolean {
  if (!_access) return true;
  return _access.areas[area] !== false;
}

/** Is the current user a workspace admin (tenant/platform admin)? */
export function isWorkspaceAdmin(): boolean {
  return _access?.isAdmin ?? false;
}
