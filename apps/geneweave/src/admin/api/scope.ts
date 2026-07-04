/**
 * GeneWeave — admin/api/scope.ts
 *
 * Admin CRUD routes for the 5 agentic scope isolation tables introduced in m75:
 *
 *   agent_scopes              — named domain boundaries (analytics, kaggle, code, …)
 *   scope_cross_policies      — rules governing cross-scope delegation
 *   scope_skill_assignments   — skill ID → scope mappings (join table, composite PK)
 *   scope_live_agent_assignments — live mesh+role → scope mappings (join table, composite PK)
 *   scope_access_log          — immutable audit log (read-only via admin)
 *
 * All write routes require authentication AND a CSRF token (auth: true, csrf: true).
 * The scope_access_log is intentionally read-only — no POST/PUT/DELETE endpoints exist.
 *
 * Scope ID encoding for join tables:
 *   scope_skill_assignments:       id = "{scope_id}::{skill_id}"
 *   scope_live_agent_assignments:  id = "{scope_id}::{mesh_key}::{role_key}"
 */

import { randomUUID } from 'crypto';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

/** Valid scope names for use in dropdowns and validation. */
const KNOWN_SCOPES = ['system', 'analytics', 'kaggle', 'code', 'browser', 'voice', 'memory'] as const;
const KNOWN_AUDIT_LEVELS = ['none', 'log', 'alert'] as const;

function boolToInt(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === 1 || v === 0) return v;
  return v ? 1 : 0;
}

/**
 * Register all scope isolation admin routes.
 *
 * Routes registered:
 *   GET/POST         /api/admin/agent-scopes
 *   GET/PUT/DELETE   /api/admin/agent-scopes/:id
 *   GET/POST         /api/admin/scope-cross-policies
 *   GET/PUT/DELETE   /api/admin/scope-cross-policies/:id
 *   GET/POST/DELETE  /api/admin/scope-skill-assignments
 *   DELETE           /api/admin/scope-skill-assignments/:id
 *   GET/POST         /api/admin/scope-live-agent-assignments
 *   DELETE           /api/admin/scope-live-agent-assignments/:id
 *   GET              /api/admin/scope-access-log  (read-only)
 */
export function registerScopeRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // ── agent_scopes ─────────────────────────────────────────────────────────

  /** List all scope definitions (including disabled) for the admin UI. */
  router.get('/api/admin/agent-scopes', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const scopes = await db.adminListScopes();
    json(res, 200, { 'agent-scopes': scopes });
  }, { auth: true });

  /** Get a single scope definition. */
  router.get('/api/admin/agent-scopes/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const scope = await db.getScope(params['id']!);
    if (!scope) { json(res, 404, { error: 'Scope not found' }); return; }
    json(res, 200, { 'agent-scope': scope });
  }, { auth: true });

  /** Create a new scope definition. */
  router.post('/api/admin/agent-scopes', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const id = (typeof body['id'] === 'string' ? body['id'].trim() : '') || '';
    const display_name = (typeof body['display_name'] === 'string' ? body['display_name'].trim() : '');

    if (!id) { json(res, 400, { error: 'id is required (e.g. "analytics")' }); return; }
    if (!display_name) { json(res, 400, { error: 'display_name is required' }); return; }
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
      json(res, 400, { error: 'id must be lowercase alphanumeric with hyphens/underscores' }); return;
    }

    const auditLevel = (typeof body['audit_level'] === 'string' ? body['audit_level'] : 'log');
    if (!KNOWN_AUDIT_LEVELS.includes(auditLevel as typeof KNOWN_AUDIT_LEVELS[number])) {
      json(res, 400, { error: `audit_level must be one of: ${KNOWN_AUDIT_LEVELS.join(', ')}` }); return;
    }

    await db.adminCreateScope({
      id,
      display_name,
      description: (typeof body['description'] === 'string' ? body['description'] : ''),
      sandboxed: boolToInt(body['sandboxed'] ?? 1),
      max_delegation_depth: typeof body['max_delegation_depth'] === 'number'
        ? Math.max(0, Math.floor(body['max_delegation_depth'] as number))
        : 5,
      audit_level: auditLevel,
      enabled: boolToInt(body['enabled'] ?? 1),
    });
    const created = await db.getScope(id);
    json(res, 201, { 'agent-scope': created });
  }, { auth: true, csrf: true });

  /** Update an existing scope definition. */
  router.put('/api/admin/agent-scopes/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getScope(params['id']!);
    if (!existing) { json(res, 404, { error: 'Scope not found' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const patch: Record<string, unknown> = {};
    if (body['display_name'] !== undefined) patch['display_name'] = String(body['display_name']).trim();
    if (body['description'] !== undefined) patch['description'] = String(body['description']);
    if (body['sandboxed'] !== undefined) patch['sandboxed'] = boolToInt(body['sandboxed']);
    if (body['max_delegation_depth'] !== undefined) {
      patch['max_delegation_depth'] = Math.max(0, Math.floor(Number(body['max_delegation_depth'])));
    }
    if (body['audit_level'] !== undefined) {
      const al = String(body['audit_level']);
      if (!KNOWN_AUDIT_LEVELS.includes(al as typeof KNOWN_AUDIT_LEVELS[number])) {
        json(res, 400, { error: `audit_level must be one of: ${KNOWN_AUDIT_LEVELS.join(', ')}` }); return;
      }
      patch['audit_level'] = al;
    }
    if (body['enabled'] !== undefined) patch['enabled'] = boolToInt(body['enabled']);

    await db.adminUpdateScope(params['id']!, patch as Parameters<typeof db.adminUpdateScope>[1]);
    const updated = await db.getScope(params['id']!);
    json(res, 200, { 'agent-scope': updated });
  }, { auth: true, csrf: true });

  /** Delete a scope definition. */
  router.del('/api/admin/agent-scopes/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getScope(params['id']!);
    if (!existing) { json(res, 404, { error: 'Scope not found' }); return; }
    await db.adminDeleteScope(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── scope_cross_policies ─────────────────────────────────────────────────

  /** List all cross-scope policies (including disabled) for the admin UI. */
  router.get('/api/admin/scope-cross-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.adminListScopePolicies();
    json(res, 200, { 'scope-cross-policies': policies });
  }, { auth: true });

  /** Get a single cross-scope policy by ID. */
  router.get('/api/admin/scope-cross-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policy = await db.adminGetScopePolicy(params['id']!);
    if (!policy) { json(res, 404, { error: 'Policy not found' }); return; }
    json(res, 200, { 'scope-cross-policy': policy });
  }, { auth: true });

  /** Create a new cross-scope policy. */
  router.post('/api/admin/scope-cross-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const from_scope = (typeof body['from_scope'] === 'string' ? body['from_scope'].trim() : '');
    const to_scope = (typeof body['to_scope'] === 'string' ? body['to_scope'].trim() : '');
    if (!from_scope) { json(res, 400, { error: 'from_scope is required' }); return; }
    if (!to_scope) { json(res, 400, { error: 'to_scope is required' }); return; }

    const auditLevel = (typeof body['audit_level'] === 'string' ? body['audit_level'] : 'log');
    if (!KNOWN_AUDIT_LEVELS.includes(auditLevel as typeof KNOWN_AUDIT_LEVELS[number])) {
      json(res, 400, { error: `audit_level must be one of: ${KNOWN_AUDIT_LEVELS.join(', ')}` }); return;
    }

    const id = (typeof body['id'] === 'string' && body['id'].trim()) ? body['id'].trim() : `pol-${randomUUID().slice(0, 8)}`;

    let conditions_json: string | null = null;
    if (body['conditions_json'] != null) {
      conditions_json = typeof body['conditions_json'] === 'string'
        ? body['conditions_json']
        : JSON.stringify(body['conditions_json']);
    }

    await db.adminCreateScopePolicy({
      id,
      from_scope,
      to_scope,
      allowed: boolToInt(body['allowed'] ?? 0),
      requires_a2a: boolToInt(body['requires_a2a'] ?? 1),
      max_delegation_depth: typeof body['max_delegation_depth'] === 'number'
        ? Math.max(0, Math.floor(body['max_delegation_depth'] as number))
        : 1,
      conditions_json,
      audit_level: auditLevel,
      enabled: boolToInt(body['enabled'] ?? 1),
    });
    const created = await db.adminGetScopePolicy(id);
    json(res, 201, { 'scope-cross-policy': created });
  }, { auth: true, csrf: true });

  /** Update an existing cross-scope policy. */
  router.put('/api/admin/scope-cross-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.adminGetScopePolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Policy not found' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const patch: Record<string, unknown> = {};
    if (body['from_scope'] !== undefined) patch['from_scope'] = String(body['from_scope']).trim();
    if (body['to_scope'] !== undefined) patch['to_scope'] = String(body['to_scope']).trim();
    if (body['allowed'] !== undefined) patch['allowed'] = boolToInt(body['allowed']);
    if (body['requires_a2a'] !== undefined) patch['requires_a2a'] = boolToInt(body['requires_a2a']);
    if (body['max_delegation_depth'] !== undefined) {
      patch['max_delegation_depth'] = Math.max(0, Math.floor(Number(body['max_delegation_depth'])));
    }
    if (body['conditions_json'] !== undefined) {
      patch['conditions_json'] = body['conditions_json'] != null
        ? (typeof body['conditions_json'] === 'string' ? body['conditions_json'] : JSON.stringify(body['conditions_json']))
        : null;
    }
    if (body['audit_level'] !== undefined) {
      const al = String(body['audit_level']);
      if (!KNOWN_AUDIT_LEVELS.includes(al as typeof KNOWN_AUDIT_LEVELS[number])) {
        json(res, 400, { error: `audit_level must be one of: ${KNOWN_AUDIT_LEVELS.join(', ')}` }); return;
      }
      patch['audit_level'] = al;
    }
    if (body['enabled'] !== undefined) patch['enabled'] = boolToInt(body['enabled']);

    await db.adminUpdateScopePolicy(params['id']!, patch as Parameters<typeof db.adminUpdateScopePolicy>[1]);
    const updated = await db.adminGetScopePolicy(params['id']!);
    json(res, 200, { 'scope-cross-policy': updated });
  }, { auth: true, csrf: true });

  /** Delete a cross-scope policy. */
  router.del('/api/admin/scope-cross-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.adminGetScopePolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Policy not found' }); return; }
    await db.adminDeleteScopePolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── scope_skill_assignments ───────────────────────────────────────────────

  /** List all skill→scope assignments. Each row has a synthetic `id` = `{scope_id}::{skill_id}`. */
  router.get('/api/admin/scope-skill-assignments', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const assignments = await db.adminListScopeSkillAssignments();
    json(res, 200, { 'scope-skill-assignments': assignments });
  }, { auth: true });

  /** Create a new skill→scope assignment. */
  router.post('/api/admin/scope-skill-assignments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const scope_id = (typeof body['scope_id'] === 'string' ? body['scope_id'].trim() : '');
    const skill_id = (typeof body['skill_id'] === 'string' ? body['skill_id'].trim() : '');
    if (!scope_id) { json(res, 400, { error: 'scope_id is required' }); return; }
    if (!skill_id) { json(res, 400, { error: 'skill_id is required' }); return; }

    await db.adminCreateScopeSkillAssignment(scope_id, skill_id);
    const compositeId = `${scope_id}::${skill_id}`;
    json(res, 201, { 'scope-skill-assignment': { id: compositeId, scope_id, skill_id } });
  }, { auth: true, csrf: true });

  /**
   * Delete a skill→scope assignment by composite ID.
   * The composite ID is `{scope_id}::{skill_id}` — URL-encode if needed.
   */
  router.del('/api/admin/scope-skill-assignments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const compositeId = decodeURIComponent(params['id']!);
    if (!compositeId.includes('::')) {
      json(res, 400, { error: 'Invalid assignment ID (expected scope_id::skill_id)' }); return;
    }
    await db.adminDeleteScopeSkillAssignment(compositeId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── scope_live_agent_assignments ──────────────────────────────────────────

  /** List all live-mesh→scope assignments. Each row has synthetic `id` = `{scope_id}::{mesh_key}::{role_key}`. */
  router.get('/api/admin/scope-live-agent-assignments', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const assignments = await db.adminListScopeLiveAgentAssignments();
    json(res, 200, { 'scope-live-agent-assignments': assignments });
  }, { auth: true });

  /** Create a new live-mesh→scope assignment. */
  router.post('/api/admin/scope-live-agent-assignments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const scope_id = (typeof body['scope_id'] === 'string' ? body['scope_id'].trim() : '');
    const mesh_key = (typeof body['mesh_key'] === 'string' ? body['mesh_key'].trim() : '');
    // role_key = '' means "all roles" (catch-all); allow empty string intentionally
    const role_key = (typeof body['role_key'] === 'string' ? body['role_key'].trim() : '');
    if (!scope_id) { json(res, 400, { error: 'scope_id is required' }); return; }
    if (!mesh_key) { json(res, 400, { error: 'mesh_key is required' }); return; }

    await db.adminCreateScopeLiveAgentAssignment(scope_id, mesh_key, role_key);
    const compositeId = `${scope_id}::${mesh_key}::${role_key}`;
    json(res, 201, { 'scope-live-agent-assignment': { id: compositeId, scope_id, mesh_key, role_key } });
  }, { auth: true, csrf: true });

  /**
   * Delete a live-mesh→scope assignment by composite ID.
   * The composite ID is `{scope_id}::{mesh_key}::{role_key}` — URL-encode if needed.
   */
  router.del('/api/admin/scope-live-agent-assignments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const compositeId = decodeURIComponent(params['id']!);
    const parts = compositeId.split('::');
    if (parts.length < 3) {
      json(res, 400, { error: 'Invalid assignment ID (expected scope_id::mesh_key::role_key)' }); return;
    }
    await db.adminDeleteScopeLiveAgentAssignment(compositeId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── scope_access_log (read-only) ──────────────────────────────────────────

  /**
   * List scope access log entries.
   *
   * Query params:
   *   limit         — max rows to return (default 100, max 500)
   *   sessionId     — filter to a specific session
   *   onlyViolations — '1' or 'true' to show only blocked events
   */
  router.get('/api/admin/scope-access-log', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limitRaw = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 100 : limitRaw), 500);
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const onlyViolations = url.searchParams.get('onlyViolations') === '1'
      || url.searchParams.get('onlyViolations') === 'true';

    const entries = await db.listScopeAccessLog({ limit, sessionId, onlyViolations });
    json(res, 200, { 'scope-access-log': entries });
  }, { auth: true });
}
