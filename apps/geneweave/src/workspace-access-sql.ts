/**
 * workspace-access-sql.ts — Workspace roles: RBAC surface parity + members (m143).
 *
 * Reuses the RBAC policy in `@weaveintel/identity` (canPersonaAccessArea via ./rbac) so the CLIENT can hide
 * admin controls a user can't use (surface parity) — the same policy the server already enforces. Adds a
 * per-tenant policy for the OPTIONAL member-visible areas, a members read-out (for the People view + the
 * assistant's list_workspace_members tool), and an admin-gated member role change.
 */
import { canPersonaAccessArea, isValidPersona, normalizePersona } from './rbac.js';
import type { DatabaseAdapter } from './db.js';
import type { TenantRoleAccessRow } from './db-types/adapter-me.js';

const ADMIN_PERSONAS = new Set(['tenant_admin', 'platform_admin']);
/** Roles a tenant admin may assign (they can't mint platform admins). */
const ASSIGNABLE_BY_TENANT_ADMIN = new Set(['tenant_admin', 'tenant_user']);
/** The optional areas whose member-visibility a tenant governs. */
const OPTIONAL_AREAS = ['dashboard', 'connectors', 'design'] as const;

const DEFAULT_CONFIG = (tenantId: string): TenantRoleAccessRow => ({ tenant_id: tenantId, member_dashboard: 1, member_connectors: 0, member_design: 1, updated_at: '' });

function roleLabel(persona: string): string {
  switch (persona) {
    case 'platform_admin': return 'Platform admin';
    case 'tenant_admin': return 'Admin';
    case 'tenant_user': return 'Member';
    default: return persona;
  }
}

export function createWorkspaceAccessService(db: DatabaseAdapter) {
  async function getConfig(tenantId: string): Promise<TenantRoleAccessRow> {
    return (await db.getTenantRoleAccess(tenantId)) ?? DEFAULT_CONFIG(tenantId);
  }
  async function updateConfig(tenantId: string, patch: Partial<TenantRoleAccessRow>): Promise<TenantRoleAccessRow> {
    const cur = await getConfig(tenantId);
    const next: TenantRoleAccessRow = {
      tenant_id: tenantId,
      member_dashboard: patch.member_dashboard !== undefined ? (patch.member_dashboard ? 1 : 0) : cur.member_dashboard,
      member_connectors: patch.member_connectors !== undefined ? (patch.member_connectors ? 1 : 0) : cur.member_connectors,
      member_design: patch.member_design !== undefined ? (patch.member_design ? 1 : 0) : cur.member_design,
      updated_at: '',
    };
    await db.upsertTenantRoleAccess(next);
    return next;
  }

  /**
   * The set of UI areas this user should SEE. = the RBAC policy (canPersonaAccessArea) AND, for the optional
   * member areas, the workspace's per-tenant policy. Admins always see the optional areas.
   */
  async function getEffectiveAccess(persona: string | null, tenantId: string | null): Promise<{ isAdmin: boolean; areas: Record<string, boolean> }> {
    const isAdmin = ADMIN_PERSONAS.has(persona ?? '');
    const cfg = await getConfig(tenantId ?? 'default');
    const memberAllows: Record<string, boolean> = { dashboard: cfg.member_dashboard === 1, connectors: cfg.member_connectors === 1, design: cfg.member_design === 1 };
    const areas: Record<string, boolean> = {};
    for (const area of ['home', 'chat', 'notes', 'calendar', 'design', 'dashboard', 'connectors', 'builder', 'admin']) {
      let visible = canPersonaAccessArea(persona, area);
      if (visible && !isAdmin && (OPTIONAL_AREAS as readonly string[]).includes(area)) visible = memberAllows[area] ?? true;
      areas[area] = visible;
    }
    return { isAdmin, areas };
  }

  /** The workspace members the caller may see (tenant-scoped). Emails only for admins. */
  async function listMembers(caller: { userId: string; tenantId: string | null; persona: string }): Promise<{ people: Array<{ id: string; name: string; email?: string; persona: string; role: string; is_you: boolean }>; canManage: boolean }> {
    const isPlatformAdmin = caller.persona === 'platform_admin';
    const canManage = ADMIN_PERSONAS.has(caller.persona);
    const users = await db.listUsers(isPlatformAdmin ? undefined : { tenantId: caller.tenantId ?? null });
    return {
      people: users.map((u) => ({
        id: u.id, name: u.name, ...(canManage ? { email: u.email } : {}),
        persona: u.persona, role: roleLabel(u.persona), is_you: u.id === caller.userId,
      })),
      canManage,
    };
  }

  /**
   * Change a member's role. Admin-only, same-tenant, with guardrails: a tenant admin may only assign
   * tenant_admin/tenant_user (never platform_admin); no one may change a platform_admin; you can't demote
   * yourself out of admin if you're the last admin in the workspace (avoid locking the workspace out).
   */
  async function changeMemberRole(input: { actor: { userId: string; tenantId: string | null; persona: string }; targetUserId: string; newPersona: string }): Promise<{ ok: boolean; error?: string; persona?: string; role?: string }> {
    if (!ADMIN_PERSONAS.has(input.actor.persona)) return { ok: false, error: 'Only a workspace admin can change roles.' };
    const target = await db.getUserById(input.targetUserId);
    if (!target) return { ok: false, error: 'Member not found.' };
    const isPlatformAdmin = input.actor.persona === 'platform_admin';
    if (!isPlatformAdmin && (target.tenant_id ?? null) !== (input.actor.tenantId ?? null)) return { ok: false, error: 'That member is not in your workspace.' };
    if (target.persona === 'platform_admin' && !isPlatformAdmin) return { ok: false, error: 'You cannot change a platform admin.' };
    const next = normalizePersona(input.newPersona, 'user');
    if (!isValidPersona(next)) return { ok: false, error: 'Unknown role.' };
    if (!isPlatformAdmin && !ASSIGNABLE_BY_TENANT_ADMIN.has(next)) return { ok: false, error: 'You can only set Admin or Member.' };

    // Guardrail: don't remove the LAST admin from the workspace.
    if (ADMIN_PERSONAS.has(target.persona) && !ADMIN_PERSONAS.has(next)) {
      const peers = await db.listUsers({ tenantId: input.actor.tenantId ?? null });
      const admins = peers.filter((u) => ADMIN_PERSONAS.has(u.persona));
      if (admins.length <= 1) return { ok: false, error: 'This is the workspace’s only admin — promote someone else first.' };
    }

    await db.updateUser(target.id, { persona: next });
    return { ok: true, persona: next, role: roleLabel(next) };
  }

  /** The list_workspace_members tool entry point — a plain read-out of the team for the assistant. */
  async function agentListMembers(args: { userId: string; tenantId?: string | null; persona?: string | null }): Promise<{ ok: boolean; total: number; admins: number; members: Array<{ name: string; role: string; email?: string; isYou: boolean }> }> {
    const r = await listMembers({ userId: args.userId, tenantId: args.tenantId ?? null, persona: args.persona ?? 'tenant_user' });
    return {
      ok: true,
      total: r.people.length,
      admins: r.people.filter((p) => ADMIN_PERSONAS.has(p.persona)).length,
      members: r.people.map((p) => ({ name: p.name, role: p.role, ...(p.email ? { email: p.email } : {}), isYou: p.is_you })),
    };
  }

  return { getConfig, updateConfig, getEffectiveAccess, listMembers, changeMemberRole, agentListMembers };
}

export type WorkspaceAccessService = ReturnType<typeof createWorkspaceAccessService>;
