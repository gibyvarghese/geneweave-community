/**
 * accessibility-sql.ts — per-tenant accessibility defaults for streaming answers (m140).
 *
 * Small config service shared by the client-facing GET (/api/me/accessibility) and the Builder admin CRUD.
 * The announce mode drives the accessible live-region policy (@weaveintel/collab stream-announce);
 * reduced_motion is a workspace default layered on top of each person's OS "reduce motion" (always respected).
 */
import type { DatabaseAdapter } from './db.js';
import type { TenantAccessibilityRow } from './db-types/adapter-me.js';

const VALID_MODES = new Set(['summary', 'live', 'off']);
const DEFAULT_CONFIG = (tenantId: string): TenantAccessibilityRow => ({ tenant_id: tenantId, announce_mode: 'summary', reduced_motion: 0, always_show_focus: 0, confirm_destructive: 1, show_skeletons: 1, updated_at: '' });

export function createAccessibilityService(db: DatabaseAdapter) {
  async function getConfig(tenantId: string): Promise<TenantAccessibilityRow> {
    return (await db.getTenantAccessibility(tenantId)) ?? DEFAULT_CONFIG(tenantId);
  }
  async function updateConfig(tenantId: string, patch: Partial<TenantAccessibilityRow>): Promise<TenantAccessibilityRow> {
    const cur = await getConfig(tenantId);
    const next: TenantAccessibilityRow = {
      tenant_id: tenantId,
      announce_mode: typeof patch.announce_mode === 'string' && VALID_MODES.has(patch.announce_mode) ? patch.announce_mode : cur.announce_mode,
      reduced_motion: patch.reduced_motion !== undefined ? (patch.reduced_motion ? 1 : 0) : cur.reduced_motion,
      always_show_focus: patch.always_show_focus !== undefined ? (patch.always_show_focus ? 1 : 0) : cur.always_show_focus,
      confirm_destructive: patch.confirm_destructive !== undefined ? (patch.confirm_destructive ? 1 : 0) : cur.confirm_destructive,
      show_skeletons: patch.show_skeletons !== undefined ? (patch.show_skeletons ? 1 : 0) : cur.show_skeletons,
      updated_at: '',
    };
    await db.upsertTenantAccessibility(next);
    return next;
  }
  return { getConfig, updateConfig };
}

export type AccessibilityService = ReturnType<typeof createAccessibilityService>;
