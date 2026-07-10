/**
 * @weaveintel/geneweave — Admin Worker Agent routes
 *
 * Modular CRUD endpoints for worker agents.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { WorkerAgentRow } from '../../db-types.js';
import { buildTenantWorkerAgentFork } from '../../worker-agent-realm.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { guardCustomizable, guardKeyCollision } from './realm-guards.js';

export function registerWorkerAgentRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody, requireDetailedDescription } = helpers;

  // List all workers, OR — with ?tenantId= — the EFFECTIVE worker roster for that tenant (its own forks
  // + a parent org's shared forks + the globals, nearest-owner-wins, canonical names restored).
  router.get('/api/admin/worker-agents', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    const workerAgents = tenantId ? await db.resolveTenantEffectiveWorkerAgents(tenantId) : await db.listWorkerAgents();
    json(res, 200, { workerAgents, ...(tenantId ? { tenantId } : {}) });
  }, { auth: true });

  router.get('/api/admin/worker-agents/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const workerAgent = await db.getWorkerAgent(params['id']!);
    if (!workerAgent) { json(res, 404, { error: 'Worker agent not found' }); return; }
    json(res, 200, { workerAgent });
  }, { auth: true });

  // ── Admin: Tenancy Realm — per-tenant worker customization (content fork) ────────────────
  const WORKER_OVERRIDE_KEYS = ['display_name', 'job_profile', 'description', 'system_prompt', 'tool_names', 'persona', 'trigger_patterns', 'task_contract_id', 'category', 'share_mode'] as const;

  // Who-gets-what for a tenant: the effective worker + where it came from.
  router.get('/api/admin/worker-agents/:id/realm', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const base = await db.getWorkerAgent(params['id']!);
    if (!base) { json(res, 404, { error: 'Worker agent not found' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    const logicalKey = base.logical_key ?? base.name;
    const effective = tenantId
      ? (await db.resolveTenantEffectiveWorkerAgents(tenantId)).find((w) => (w.logical_key ?? w.name) === logicalKey) ?? base
      : base;
    const kind = effective.realm === 'tenant' ? (effective.owner_tenant_id === tenantId ? 'own_override' : 'inherited') : 'global';
    json(res, 200, { effective, provenance: { kind }, tenantId });
  }, { auth: true });

  // Create/replace a tenant's fork of this global worker.
  router.post('/api/admin/worker-agents/:id/customize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const global = await db.getWorkerAgent(params['id']!);
    if (!global) { json(res, 404, { error: 'Worker agent not found' }); return; }
    if (global.realm === 'tenant') { json(res, 400, { error: 'Can only customize a global worker, not an existing tenant copy' }); return; }
    // D15: a deprecated global default may not gain new forks (existing forks keep working).
    if (!guardCustomizable(json, res, global)) return;
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const tenantId = body['tenantId'];
    if (typeof tenantId !== 'string' || !tenantId.trim()) { json(res, 400, { error: 'tenantId required' }); return; }
    const overrides: Record<string, unknown> = {};
    for (const k of WORKER_OVERRIDE_KEYS) {
      if (body[k] === undefined) continue;
      // JSON columns (tool_names / trigger_patterns) → stringify.
      overrides[k] = (k === 'tool_names' || k === 'trigger_patterns') ? JSON.stringify(body[k]) : body[k];
    }
    const logicalKey = global.logical_key ?? global.name;
    const existing = (await db.listWorkerAgents()).find((w) => w.realm === 'tenant' && w.owner_tenant_id === tenantId && (w.logical_key ?? w.name) === logicalKey);
    if (existing) await db.deleteWorkerAgent(existing.id);
    const fork = buildTenantWorkerAgentFork(global, tenantId, overrides as Parameters<typeof buildTenantWorkerAgentFork>[2]);
    await db.insertRealmWorkerAgentRow(fork);
    const saved = await db.getWorkerAgent(fork.id);
    json(res, 201, { fork: saved, replacedExisting: Boolean(existing) });
  }, { auth: true, csrf: true });

  // Revert: drop a tenant's worker fork so it falls back to the global built-in.
  router.del('/api/admin/worker-agents/:id/customize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const global = await db.getWorkerAgent(params['id']!);
    if (!global) { json(res, 404, { error: 'Worker agent not found' }); return; }
    const tenantId = new URL(req.url ?? '', 'http://localhost').searchParams.get('tenantId');
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    const logicalKey = global.logical_key ?? global.name;
    const fork = (await db.listWorkerAgents()).find((w) => w.realm === 'tenant' && w.owner_tenant_id === tenantId && (w.logical_key ?? w.name) === logicalKey);
    if (!fork) { json(res, 404, { error: 'No customization for this tenant' }); return; }
    await db.deleteWorkerAgent(fork.id);
    json(res, 200, { ok: true, reverted: fork.id });
  }, { auth: true, csrf: true });

  router.post('/api/admin/worker-agents', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['description']) {
      json(res, 400, { error: 'name and description required' });
      return;
    }
    // D17: if the caller can already SEE this logical key, they must Customize it, not create a twin.
    if (!await guardKeyCollision(json, res, db, 'worker_agents', String(body['name']), auth)) return;
    const validatedDescription = requireDetailedDescription(body['description'], 'agent', res);
    if (!validatedDescription) return;

    const id = 'wa-' + newUUIDv7().slice(-8);
    await db.createWorkerAgent({
      id,
      name: body['name'] as string,
      display_name: (body['display_name'] as string) ?? null,
      job_profile: (body['job_profile'] as string) ?? null,
      description: validatedDescription,
      system_prompt: (body['system_prompt'] as string) ?? null,
      tool_names: body['tool_names'] ? JSON.stringify(body['tool_names']) : '[]',
      persona: (body['persona'] as string) ?? 'agent_worker',
      trigger_patterns: body['trigger_patterns'] ? JSON.stringify(body['trigger_patterns']) : '[]',
      task_contract_id: (body['task_contract_id'] as string) ?? null,
      max_retries: body['max_retries'] !== undefined ? Number(body['max_retries']) : 0,
      priority: body['priority'] !== undefined ? Number(body['priority']) : 0,
      category: (body['category'] as string) ?? 'general',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const workerAgent = await db.getWorkerAgent(id);
    json(res, 201, { workerAgent });
  }, { auth: true, csrf: true });

  router.put('/api/admin/worker-agents/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWorkerAgent(params['id']!);
    if (!existing) { json(res, 404, { error: 'Worker agent not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['display_name'] !== undefined) fields['display_name'] = body['display_name'];
    if (body['job_profile'] !== undefined) fields['job_profile'] = body['job_profile'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'agent', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['system_prompt'] !== undefined) fields['system_prompt'] = body['system_prompt'];
    if (body['tool_names'] !== undefined) fields['tool_names'] = body['tool_names'] ? JSON.stringify(body['tool_names']) : '[]';
    if (body['persona'] !== undefined) fields['persona'] = body['persona'];
    if (body['trigger_patterns'] !== undefined) fields['trigger_patterns'] = body['trigger_patterns'] ? JSON.stringify(body['trigger_patterns']) : '[]';
    if (body['task_contract_id'] !== undefined) fields['task_contract_id'] = body['task_contract_id'];
    if (body['max_retries'] !== undefined) fields['max_retries'] = Number(body['max_retries']);
    if (body['priority'] !== undefined) fields['priority'] = Number(body['priority']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updateWorkerAgent(params['id']!, fields as Partial<Omit<WorkerAgentRow, 'id' | 'created_at' | 'updated_at'>>);
    const workerAgent = await db.getWorkerAgent(params['id']!);
    json(res, 200, { workerAgent });
  }, { auth: true, csrf: true });

  router.del('/api/admin/worker-agents/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWorkerAgent(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
