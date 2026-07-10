/**
 * @weaveintel/geneweave — Admin Tool Policies routes
 *
 * Phase 2 CRUD endpoints for the operator-managed tool policy table.
 * Policies are resolved at runtime by DbToolPolicyResolver to gate
 * tool invocations with rate limits, approval gates, and risk level checks.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { ToolPolicyRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { guardCustomizable, guardKeyCollision } from './realm-guards.js';
import { buildTenantToolPolicyFork } from '../../tool-policy-realm.js';

export function registerToolPolicyRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // List all policies, OR — with ?tenantId= — the EFFECTIVE policy set for that tenant (its own forks
  // + a parent org's shared forks + the globals, nearest-owner-wins, canonical keys restored).
  router.get('/api/admin/tool-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    const policies = tenantId ? await db.resolveTenantEffectiveToolPolicies(tenantId) : await db.listToolPolicies();
    json(res, 200, { policies, ...(tenantId ? { tenantId } : {}) });
  }, { auth: true });

  router.get('/api/admin/tool-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policy = await db.getToolPolicy(params['id']!);
    if (!policy) { json(res, 404, { error: 'Tool policy not found' }); return; }
    json(res, 200, { policy });
  }, { auth: true });

  // ── Admin: Tenancy Realm — per-tenant tool-policy customization (content fork) ────────────────
  const POLICY_OVERRIDE_KEYS = ['description', 'applies_to', 'applies_to_risk_levels', 'approval_required', 'allowed_risk_levels', 'max_execution_ms', 'rate_limit_per_minute', 'max_concurrent', 'require_dry_run', 'log_input_output', 'persona_scope', 'active_hours_utc', 'expires_at', 'share_mode'] as const;
  const JSON_POLICY_KEYS = new Set(['applies_to', 'applies_to_risk_levels', 'allowed_risk_levels', 'persona_scope', 'active_hours_utc']);
  const BOOL_POLICY_KEYS = new Set(['approval_required', 'require_dry_run', 'log_input_output']);

  // Who-gets-what for a tenant: the effective policy + where it came from.
  router.get('/api/admin/tool-policies/:id/realm', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const base = await db.getToolPolicy(params['id']!);
    if (!base) { json(res, 404, { error: 'Tool policy not found' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    const logicalKey = base.logical_key ?? base.key;
    const effective = tenantId
      ? (await db.resolveTenantEffectiveToolPolicies(tenantId)).find((p) => (p.logical_key ?? p.key) === logicalKey) ?? base
      : base;
    const kind = effective.realm === 'tenant' ? (effective.owner_tenant_id === tenantId ? 'own_override' : 'inherited') : 'global';
    json(res, 200, { effective, provenance: { kind }, tenantId });
  }, { auth: true });

  // Create/replace a tenant's fork of this global policy.
  router.post('/api/admin/tool-policies/:id/customize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const global = await db.getToolPolicy(params['id']!);
    if (!global) { json(res, 404, { error: 'Tool policy not found' }); return; }
    if (global.realm === 'tenant') { json(res, 400, { error: 'Can only customize a global policy, not an existing tenant copy' }); return; }
    // D15: a deprecated global default may not gain new forks (existing forks keep working).
    if (!guardCustomizable(json, res, global)) return;
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const tenantId = body['tenantId'];
    if (typeof tenantId !== 'string' || !tenantId.trim()) { json(res, 400, { error: 'tenantId required' }); return; }
    const overrides: Record<string, unknown> = {};
    for (const k of POLICY_OVERRIDE_KEYS) {
      if (body[k] === undefined) continue;
      if (JSON_POLICY_KEYS.has(k)) overrides[k] = (body[k] !== null && typeof body[k] === 'object') ? JSON.stringify(body[k]) : body[k];
      else if (BOOL_POLICY_KEYS.has(k)) overrides[k] = body[k] ? 1 : 0;
      else overrides[k] = body[k];
    }
    const logicalKey = global.logical_key ?? global.key;
    const existing = (await db.listToolPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === tenantId && (p.logical_key ?? p.key) === logicalKey);
    if (existing) await db.deleteToolPolicy(existing.id);
    const fork = buildTenantToolPolicyFork(global, tenantId, overrides as Parameters<typeof buildTenantToolPolicyFork>[2]);
    await db.insertRealmToolPolicyRow(fork);
    const saved = await db.getToolPolicy(fork.id);
    json(res, 201, { fork: saved, replacedExisting: Boolean(existing) });
  }, { auth: true, csrf: true });

  // Revert: drop a tenant's policy fork so it falls back to the global built-in.
  router.del('/api/admin/tool-policies/:id/customize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const global = await db.getToolPolicy(params['id']!);
    if (!global) { json(res, 404, { error: 'Tool policy not found' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    const logicalKey = global.logical_key ?? global.key;
    const fork = (await db.listToolPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === tenantId && (p.logical_key ?? p.key) === logicalKey);
    if (!fork) { json(res, 404, { error: 'No customization for this tenant' }); return; }
    await db.deleteToolPolicy(fork.id);
    json(res, 200, { ok: true, reverted: fork.id });
  }, { auth: true, csrf: true });

  router.post('/api/admin/tool-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key']) { json(res, 400, { error: 'key required' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    // D17: if the caller can already SEE this logical key, they must Customize it, not create a twin.
    if (!await guardKeyCollision(json, res, db, 'tool_policies', String(body['key']), auth)) return;

    const id = newUUIDv7();
    await db.createToolPolicy({
      id,
      key: body['key'] as string,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      applies_to: body['applies_to'] ? JSON.stringify(body['applies_to']) : null,
      applies_to_risk_levels: body['applies_to_risk_levels'] ? JSON.stringify(body['applies_to_risk_levels']) : null,
      approval_required: body['approval_required'] ? 1 : 0,
      allowed_risk_levels: body['allowed_risk_levels'] ? JSON.stringify(body['allowed_risk_levels']) : null,
      max_execution_ms: (body['max_execution_ms'] as number) ?? null,
      rate_limit_per_minute: (body['rate_limit_per_minute'] as number) ?? null,
      max_concurrent: (body['max_concurrent'] as number) ?? null,
      require_dry_run: body['require_dry_run'] ? 1 : 0,
      log_input_output: body['log_input_output'] !== false ? 1 : 0,
      persona_scope: body['persona_scope'] ? JSON.stringify(body['persona_scope']) : null,
      active_hours_utc: body['active_hours_utc'] ? JSON.stringify(body['active_hours_utc']) : null,
      expires_at: (body['expires_at'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const policy = await db.getToolPolicy(id);
    json(res, 201, { policy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tool-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['applies_to'] !== undefined) fields['applies_to'] = Array.isArray(body['applies_to']) ? JSON.stringify(body['applies_to']) : body['applies_to'];
    if (body['applies_to_risk_levels'] !== undefined) fields['applies_to_risk_levels'] = Array.isArray(body['applies_to_risk_levels']) ? JSON.stringify(body['applies_to_risk_levels']) : body['applies_to_risk_levels'];
    if (body['approval_required'] !== undefined) fields['approval_required'] = body['approval_required'] ? 1 : 0;
    if (body['allowed_risk_levels'] !== undefined) fields['allowed_risk_levels'] = Array.isArray(body['allowed_risk_levels']) ? JSON.stringify(body['allowed_risk_levels']) : body['allowed_risk_levels'];
    if (body['max_execution_ms'] !== undefined) fields['max_execution_ms'] = body['max_execution_ms'];
    if (body['rate_limit_per_minute'] !== undefined) fields['rate_limit_per_minute'] = body['rate_limit_per_minute'];
    if (body['max_concurrent'] !== undefined) fields['max_concurrent'] = body['max_concurrent'];
    if (body['require_dry_run'] !== undefined) fields['require_dry_run'] = body['require_dry_run'] ? 1 : 0;
    if (body['log_input_output'] !== undefined) fields['log_input_output'] = body['log_input_output'] ? 1 : 0;
    if (body['persona_scope'] !== undefined) fields['persona_scope'] = Array.isArray(body['persona_scope']) ? JSON.stringify(body['persona_scope']) : body['persona_scope'];
    if (body['active_hours_utc'] !== undefined) fields['active_hours_utc'] = typeof body['active_hours_utc'] === 'object' ? JSON.stringify(body['active_hours_utc']) : body['active_hours_utc'];
    if (body['expires_at'] !== undefined) fields['expires_at'] = body['expires_at'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updateToolPolicy(params['id']!, fields as Partial<Omit<ToolPolicyRow, 'id' | 'created_at' | 'updated_at'>>);
    const policy = await db.getToolPolicy(params['id']!);
    json(res, 200, { policy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/tool-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteToolPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
