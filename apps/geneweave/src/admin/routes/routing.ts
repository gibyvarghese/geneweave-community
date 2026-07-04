// SPDX-License-Identifier: MIT
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hardenedFetch, newUUIDv7 } from '@weaveintel/core';
import { cacheScopeKeyString } from '@weaveintel/cache';
import type { DatabaseAdapter } from '../../db.js';
import { validateDetailedDescription, toDbUpdate } from '../api/admin-route-helpers.js';
import { getActiveCacheInvalidator, emitCacheEvent, _resetInvalidationRulesCache, _resetCacheKeyVersionCache } from '../../cache-invalidator.js';
import { _resetToolCachePoliciesCache, getToolCacheStats } from '../../tool-cache-registry.js';
import { _resetStampedeConfigCache, getSingleflightStats } from '../../cache-stampede.js';
import {
  registerToolRoutes,
  registerToolPolicyRoutes,
  registerToolAuditRoutes,
  registerToolHealthRoutes,
  registerEndpointHealthRoutes,
  registerToolCredentialRoutes,
  registerToolSimulationRoutes,
  registerMCPGatewayClientRoutes,
  registerMCPGatewayActivityRoutes,
  registerSkillRoutes,
  registerWorkerAgentRoutes,
  registerSupervisorAgentRoutes,
  registerToolApprovalRequestRoutes,
  registerKaggleCompetitionRoutes,
  registerKaggleApproachRoutes,
  registerKaggleRunRoutes,
  registerKglCompetitionRunAdminRoutes,
  registerKaggleRunArtifactRoutes,
  registerArtifactRoutes,
  registerKaggleRubricRoutes,
  registerKaggleValidationResultRoutes,
  registerKaggleLeaderboardScoreRoutes,
  registerKaggleMeshRoutes,
  registerKaggleDiscussionRoutes,
  registerLiveMeshDefinitionRoutes,
  registerLiveAgentDefinitionRoutes,
  registerLiveMeshDelegationEdgeRoutes,
  registerLiveMeshRoutes,
  registerLiveMeshProvisionerRoutes,
  registerLiveAgentRoutes,
  registerLiveAgentHandlerBindingRoutes,
  registerLiveAgentToolBindingRoutes,
  registerLiveHandlerKindRoutes,
  registerLiveAttentionPolicyRoutes,
  registerLiveRunRoutes,
  registerLiveRunStepRoutes,
  registerLiveRunEventRoutes,
  registerGuardrailRoutes,
  registerRoutingRoutes,
  registerModelPricingRoutes,
  registerWorkflowRoutes,
  registerTaskPolicyRoutes,
  registerTaskContractRoutes,
  registerIdentityRuleRoutes,
  registerMemoryGovernanceRoutes,
  registerMemoryViewRoutes,
  registerMemoryEpisodicRoutes,
  registerMemoryProceduralRoutes,
  registerMemorySettingsRoutes,
  registerComplianceRuleRoutes,
  registerTaskTypeRoutes,
  registerCapabilityScoreRoutes,
  registerProviderToolAdapterRoutes,
  registerTaskTypeTenantOverrideRoutes,
  registerRoutingDecisionTraceRoutes,
  registerRoutingSimulatorRoutes,
  registerRoutingCapabilitySignalRoutes,
  registerMessageFeedbackRoutes,
  registerRoutingSurfaceItemRoutes,
  registerRoutingExperimentRoutes,
  registerCostByTaskRoutes,
  registerCapabilityPolicyBindingRoutes,
  registerCapabilityPackRoutes,
} from '../api/index.js';
import type { RouterLike } from '../api/types.js';

export function registerAdminRoutingRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
  providers?: Record<string, { apiKey?: string }>,
  guardrailRevisionStore?: import('@weaveintel/core').GuardrailRevisionStore,
  runtime?: import('@weaveintel/core').WeaveRuntime,
): void {
  function requireDetailedDescription(
    description: unknown,
    kind: 'prompt' | 'tool' | 'skill' | 'agent',
    res: ServerResponse,
  ): string | null {
    const validation = validateDetailedDescription(description, kind);
    if (!validation.valid) {
      json(res, 400, { error: validation.error });
      return null;
    }
    return validation.description;
  }

  // ── Routing test ───────────────────────────────────────────

  router.get('/api/routing/active', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listRoutingPolicies();
    const active = policies.filter(p => p.enabled);
    json(res, 200, { active });
  });

  // ── Callable Capabilities (Tools, Skills, Worker Agents) ───

  const adminHelpers = { json, readBody, requireDetailedDescription };
  const adminHelpersWithProviders = { ...adminHelpers, providers };
  registerGuardrailRoutes(router, db, adminHelpers, guardrailRevisionStore, runtime);
  registerRoutingRoutes(router, db, adminHelpers);
  registerModelPricingRoutes(router, db, adminHelpersWithProviders);
  registerWorkflowRoutes(router, db, adminHelpers);
  registerTaskPolicyRoutes(router, db, adminHelpers);
  registerTaskContractRoutes(router, db, adminHelpers);
  registerIdentityRuleRoutes(router, db, adminHelpers);
  registerMemoryGovernanceRoutes(router, db, adminHelpers);
  registerMemoryViewRoutes(router, db, adminHelpers);
  registerMemoryEpisodicRoutes(router, db, adminHelpers);
  registerMemoryProceduralRoutes(router, db, adminHelpers);
  registerMemorySettingsRoutes(router, db, adminHelpers);
  registerComplianceRuleRoutes(router, db, adminHelpers);
  registerToolRoutes(router, db, adminHelpers);
  registerToolPolicyRoutes(router, db, adminHelpers);
  registerToolAuditRoutes(router, db, adminHelpers);
  registerToolHealthRoutes(router, db, adminHelpers);
  registerEndpointHealthRoutes(router, db, adminHelpers);
  registerToolCredentialRoutes(router, db, adminHelpers);
  registerToolSimulationRoutes(router, db, adminHelpers);
  registerMCPGatewayClientRoutes(router, db, adminHelpers);
  registerMCPGatewayActivityRoutes(router, db, adminHelpers);
  registerSkillRoutes(router, db, adminHelpers);
  registerWorkerAgentRoutes(router, db, adminHelpers);
  registerSupervisorAgentRoutes(router, db, adminHelpers);
  registerToolApprovalRequestRoutes(router, db, adminHelpers);
  registerCapabilityPolicyBindingRoutes(router, db, adminHelpers);
  registerCapabilityPackRoutes(router, db, adminHelpers);

  // ── Phase K3: Kaggle projection admin CRUD ───────────────
  registerKaggleCompetitionRoutes(router, db, adminHelpers);
  registerKaggleApproachRoutes(router, db, adminHelpers);
  registerKaggleRunRoutes(router, db, adminHelpers);
  registerKaggleRunArtifactRoutes(router, db, adminHelpers);
  registerArtifactRoutes(router, db, adminHelpers);
  registerKglCompetitionRunAdminRoutes(router, db, adminHelpers);

  // ── Phase K7d: Kaggle validator rubrics + validation results + leaderboard scores ──
  registerKaggleRubricRoutes(router, db, adminHelpers);
  registerKaggleValidationResultRoutes(router, db, adminHelpers);
  registerKaggleLeaderboardScoreRoutes(router, db, adminHelpers);

  // ── Phase K5: Kaggle live-agents mesh provisioning + observation ──
  registerKaggleMeshRoutes(router, db, adminHelpers);

  // ── Phase K6: Kaggle discussion bot kill switch + post log ───────
  registerKaggleDiscussionRoutes(router, db, adminHelpers);

  // ── Phase M21: framework-level live mesh definitions (DB-driven
  // mesh contracts, agent personas, delegation edges) ───────────────
  registerLiveMeshDefinitionRoutes(router, db, adminHelpers);
  registerLiveAgentDefinitionRoutes(router, db, adminHelpers);
  registerLiveMeshDelegationEdgeRoutes(router, db, adminHelpers);

  // ── Phase M22: DB-driven live-agents runtime ────────────────────
  // Catalog of handler kinds + attention policies (registries)
  registerLiveHandlerKindRoutes(router, db, adminHelpers);
  registerLiveAttentionPolicyRoutes(router, db, adminHelpers);
  // Provisioned meshes/agents + their handler & tool bindings
  registerLiveMeshRoutes(router, db, adminHelpers);
  // Phase 5: generic provisioner endpoint (POST /api/admin/live-meshes/provision).
  // Mounted on the same router so the path lives under the existing live-meshes
  // admin surface area without colliding with the CRUD routes (CRUD uses :id).
  registerLiveMeshProvisionerRoutes(router, db, adminHelpers);
  registerLiveAgentRoutes(router, db, adminHelpers);
  registerLiveAgentHandlerBindingRoutes(router, db, adminHelpers);
  registerLiveAgentToolBindingRoutes(router, db, adminHelpers);
  // Per-mesh runs ledger (header / steps / append-only events)
  registerLiveRunRoutes(router, db, adminHelpers);
  registerLiveRunStepRoutes(router, db, adminHelpers);
  registerLiveRunEventRoutes(router, db, adminHelpers);

  // ── anyWeave Phase 4: Task-aware routing admin API ───────
  registerTaskTypeRoutes(router, db, adminHelpers);
  registerCapabilityScoreRoutes(router, db, adminHelpers);
  registerProviderToolAdapterRoutes(router, db, adminHelpers);
  registerTaskTypeTenantOverrideRoutes(router, db, adminHelpers);
  registerRoutingDecisionTraceRoutes(router, db, adminHelpers);
  registerRoutingSimulatorRoutes(router, db, adminHelpers);

  // ── anyWeave Phase 5: Feedback loop ──────────────────────
  registerRoutingCapabilitySignalRoutes(router, db, adminHelpers);
  registerMessageFeedbackRoutes(router, db, adminHelpers);
  registerRoutingSurfaceItemRoutes(router, db, adminHelpers);

  // ── anyWeave Phase 6: Production hardening ───────────────
  registerRoutingExperimentRoutes(router, db, adminHelpers);
  registerCostByTaskRoutes(router, db, adminHelpers);
  // ── Workflow Runs ──────────────────────────────────────────

  router.get('/api/workflow-runs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const runs = await db.listWorkflowRuns();
    json(res, 200, { runs });
  });

  router.get('/api/workflow-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }
    json(res, 200, { run });
  });

  router.post('/api/workflow-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const workflow_id = body['workflow_id'] as string | undefined;
    const input = body['input'] as Record<string, unknown> | undefined;
    if (!workflow_id) { json(res, 400, { error: 'workflow_id is required' }); return; }
    const id = newUUIDv7();
    await db.createWorkflowRun({
      id,
      workflow_id,
      status: 'pending',
      state: JSON.stringify({ currentStepId: '', variables: input ?? {}, history: [] }),
      input: input ? JSON.stringify(input) : null,
      error: null,
      started_at: new Date().toISOString(),
    });
    json(res, 201, { ok: true, id });
  }, { auth: true, csrf: true });

  router.put('/api/workflow-runs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Partial<Omit<import('../../db.js').WorkflowRunRow, 'id' | 'started_at'>>;
    await db.updateWorkflowRun(params['id']!, body);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Guardrail Evaluations ──────────────────────────────────

  router.get('/api/guardrail-evals', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chatId = url.searchParams.get('chat_id') ?? undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const evals = await db.listGuardrailEvals(chatId, limit);
    json(res, 200, { evals });
  });

  // ── Memory Extraction Events ───────────────────────────────

  router.get('/api/memory-extraction-events', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chatId = url.searchParams.get('chat_id') ?? undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const events = await db.listMemoryExtractionEvents(chatId, limit);
    json(res, 200, { events });
  });

  router.get('/api/memory-extraction-events/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const event = await db.getMemoryExtractionEvent(params['id']!);
    if (!event) { json(res, 404, { error: 'Memory extraction event not found' }); return; }
    json(res, 200, { event });
  });

  // ── Admin: Cache Policies ──────────────────────────────────

  router.get('/api/admin/cache-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listCachePolicies();
    json(res, 200, { 'cache-policies': items });
  });

  router.get('/api/admin/cache-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getCachePolicy(params['id']!);
    if (!c) { json(res, 404, { error: 'Cache policy not found' }); return; }
    json(res, 200, { 'cache-policy': c });
  });

  router.post('/api/admin/cache-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createCachePolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      scope: (body['scope'] as string) ?? 'global',
      ttl_ms: (body['ttl_ms'] as number) ?? 300000,
      max_entries: (body['max_entries'] as number) ?? 1000,
      max_bytes: (body['max_bytes'] as number) ?? 0,
      bypass_patterns: body['bypass_patterns'] ? (typeof body['bypass_patterns'] === 'string' ? body['bypass_patterns'] as string : JSON.stringify(body['bypass_patterns'])) : '[]',
      output_bypass_patterns: body['output_bypass_patterns'] ? (typeof body['output_bypass_patterns'] === 'string' ? body['output_bypass_patterns'] as string : JSON.stringify(body['output_bypass_patterns'])) : '[]',
      invalidate_on: body['invalidate_on'] ? (typeof body['invalidate_on'] === 'string' ? body['invalidate_on'] as string : JSON.stringify(body['invalidate_on'])) : '[]',
      key_hashing: (body['key_hashing'] as string) === 'none' ? 'none' : 'sha256',
      tenant_isolation: body['tenant_isolation'] === false ? 0 : 1,
      cache_temperature_gate: typeof body['cache_temperature_gate'] === 'number' ? body['cache_temperature_gate'] as number : 0,
      swr_ms: typeof body['swr_ms'] === 'number' ? body['swr_ms'] as number : 0,
      negative_ttl_ms: typeof body['negative_ttl_ms'] === 'number' ? body['negative_ttl_ms'] as number : 0,
      eviction_policy: ['lru', 'lfu', 'fifo', 'tinylfu', 'gdsf'].includes(String(body['eviction_policy'])) ? String(body['eviction_policy']) : 'lru',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getCachePolicy(id);
    json(res, 201, { 'cache-policy': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/cache-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getCachePolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Cache policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['scope'] !== undefined) fields['scope'] = body['scope'];
    if (body['ttl_ms'] !== undefined) fields['ttl_ms'] = body['ttl_ms'];
    if (body['max_entries'] !== undefined) fields['max_entries'] = body['max_entries'];
    if (body['max_bytes'] !== undefined) fields['max_bytes'] = body['max_bytes'];
    if (body['bypass_patterns'] !== undefined) fields['bypass_patterns'] = typeof body['bypass_patterns'] === 'string' ? body['bypass_patterns'] : JSON.stringify(body['bypass_patterns']);
    if (body['output_bypass_patterns'] !== undefined) fields['output_bypass_patterns'] = typeof body['output_bypass_patterns'] === 'string' ? body['output_bypass_patterns'] : JSON.stringify(body['output_bypass_patterns']);
    if (body['invalidate_on'] !== undefined) fields['invalidate_on'] = typeof body['invalidate_on'] === 'string' ? body['invalidate_on'] : JSON.stringify(body['invalidate_on']);
    if (body['key_hashing'] !== undefined) fields['key_hashing'] = body['key_hashing'] === 'none' ? 'none' : 'sha256';
    if (body['tenant_isolation'] !== undefined) fields['tenant_isolation'] = body['tenant_isolation'] ? 1 : 0;
    if (body['cache_temperature_gate'] !== undefined) fields['cache_temperature_gate'] = body['cache_temperature_gate'];
    if (body['swr_ms'] !== undefined) fields['swr_ms'] = Math.max(0, Math.trunc(Number(body['swr_ms'])));
    if (body['negative_ttl_ms'] !== undefined) fields['negative_ttl_ms'] = Math.max(0, Math.trunc(Number(body['negative_ttl_ms'])));
    if (body['eviction_policy'] !== undefined) fields['eviction_policy'] = ['lru', 'lfu', 'fifo', 'tinylfu', 'gdsf'].includes(String(body['eviction_policy'])) ? String(body['eviction_policy']) : 'lru';
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateCachePolicy(params['id']!, toDbUpdate(fields));
    const item = await db.getCachePolicy(params['id']!);
    json(res, 200, { 'cache-policy': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/cache-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCachePolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Cache Settings (single global row — Phase 1 multi-tier topology) ──

  router.get('/api/admin/cache-settings', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const settings = await db.getCacheSettings();
    // Wrap the single row in an array for the generic schema-driven admin tab
    // (mirrors semantic-cache-config); keep `config` for any object consumer.
    json(res, 200, { 'cache-settings': settings ? [settings] : [], config: settings });
  });

  // ── Admin: Semantic Cache Config (Phase 4 single global row) ──

  router.get('/api/admin/semantic-cache-config', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const cfg = await db.getSemanticCacheConfig();
    // Array form powers the generic read/edit admin tab; `config` for direct use.
    json(res, 200, { 'semantic-cache-config': cfg ? [cfg] : [], config: cfg });
  });

  const applySemanticConfigUpdate = async (body: Record<string, unknown>) => {
    const fields: Record<string, unknown> = {};
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['embedding_model'] !== undefined) fields['embedding_model'] = String(body['embedding_model']).slice(0, 128);
    if (body['embedding_version'] !== undefined) fields['embedding_version'] = String(body['embedding_version']).slice(0, 64);
    if (body['similarity_threshold'] !== undefined) fields['similarity_threshold'] = Math.max(0, Math.min(1, Number(body['similarity_threshold'])));
    if (body['invalidation_radius'] !== undefined) fields['invalidation_radius'] = Math.max(0, Math.min(1, Number(body['invalidation_radius'])));
    if (body['max_entries'] !== undefined) fields['max_entries'] = Math.max(1, Math.trunc(Number(body['max_entries'])));
    if (body['ttl_ms'] !== undefined) fields['ttl_ms'] = Math.max(0, Math.trunc(Number(body['ttl_ms'])));
    if (body['scope'] !== undefined) fields['scope'] = ['global', 'tenant', 'user', 'session'].includes(String(body['scope'])) ? String(body['scope']) : 'user';
    if (body['bypass_patterns'] !== undefined) fields['bypass_patterns'] = typeof body['bypass_patterns'] === 'string' ? body['bypass_patterns'] : JSON.stringify(body['bypass_patterns']);
    if (body['verified_bounds'] !== undefined) fields['verified_bounds'] = body['verified_bounds'] ? 1 : 0;
    await db.updateSemanticCacheConfig(toDbUpdate(fields));
    // Invalidate the chat path's 60s config cache so the change takes effect now.
    try { const { _resetSemanticConfigCache } = await import('../../chat-semantic-utils.js'); _resetSemanticConfigCache(); } catch { /* ignore */ }
    return db.getSemanticCacheConfig();
  };

  const semanticConfigPut = async (req: any, res: any) => {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const cfg = await applySemanticConfigUpdate(body);
    json(res, 200, { 'semantic-cache-config': cfg });
  };
  router.put('/api/admin/semantic-cache-config', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await semanticConfigPut(req, res);
  }, { auth: true, csrf: true });
  router.put('/api/admin/semantic-cache-config/:id', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await semanticConfigPut(req, res);
  }, { auth: true, csrf: true });

  // ── Admin: Run Stream Config (Client Phase 0 single global row) ──

  router.get('/api/admin/run-stream-config', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const cfg = await db.getRunStreamConfig();
    json(res, 200, { 'run-stream-config': cfg ? [cfg] : [], config: cfg });
  });

  const applyRunStreamConfigUpdate = async (body: Record<string, unknown>) => {
    const fields: Record<string, unknown> = {};
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    // heartbeat: clamp to a sane floor so a 0ms interval can't busy-loop the SSE keepalive.
    if (body['heartbeat_ms'] !== undefined) fields['heartbeat_ms'] = Math.max(1000, Math.min(300_000, Math.trunc(Number(body['heartbeat_ms']))));
    if (body['max_reconnects'] !== undefined) fields['max_reconnects'] = Math.max(0, Math.min(100, Math.trunc(Number(body['max_reconnects']))));
    if (body['backoff_ms'] !== undefined) {
      // Accept a JSON string or an array; validate it is a non-empty list of
      // non-negative numbers before persisting (defence against malformed input).
      let arr: unknown;
      try { arr = typeof body['backoff_ms'] === 'string' ? JSON.parse(body['backoff_ms'] as string) : body['backoff_ms']; } catch { arr = undefined; }
      if (Array.isArray(arr) && arr.length > 0 && arr.every((n) => typeof n === 'number' && n >= 0 && n <= 600_000)) {
        fields['backoff_ms'] = JSON.stringify(arr.slice(0, 32));
      }
    }
    if (body['stall_timeout_ms'] !== undefined) fields['stall_timeout_ms'] = Math.max(0, Math.min(600_000, Math.trunc(Number(body['stall_timeout_ms']))));
    if (body['throttle_ms'] !== undefined) fields['throttle_ms'] = Math.max(0, Math.min(5000, Math.trunc(Number(body['throttle_ms']))));
    if (body['journal_retention_hours'] !== undefined) fields['journal_retention_hours'] = Math.max(0, Math.min(8760, Math.trunc(Number(body['journal_retention_hours']))));
    if (body['journal_max_events'] !== undefined) fields['journal_max_events'] = Math.max(0, Math.min(1_000_000, Math.trunc(Number(body['journal_max_events']))));
    if (body['resume_window_seconds'] !== undefined) fields['resume_window_seconds'] = Math.max(0, Math.min(86_400, Math.trunc(Number(body['resume_window_seconds']))));
    await db.updateRunStreamConfig(toDbUpdate(fields));
    // Invalidate the 60s config cache so the SSE keepalive + served config update now.
    try { const { _resetRunStreamConfigCache } = await import('../../chat-run-stream-utils.js'); _resetRunStreamConfigCache(); } catch { /* ignore */ }
    return db.getRunStreamConfig();
  };

  const runStreamConfigPut = async (req: any, res: any) => {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const cfg = await applyRunStreamConfigUpdate(body);
    json(res, 200, { 'run-stream-config': cfg });
  };
  router.put('/api/admin/run-stream-config', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await runStreamConfigPut(req, res);
  }, { auth: true, csrf: true });
  router.put('/api/admin/run-stream-config/:id', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await runStreamConfigPut(req, res);
  }, { auth: true, csrf: true });

  // ── Admin: weaveNotes Settings (Phase 0 single global config row) ──
  // The notes-AI capability config; validated through @weaveintel/notes so a value can never
  // be saved out of range or with an unknown tool. Edited via the Builder.
  const noteSettings = (async () => (await import('../../note-settings-sql.js')).createNoteSettingsService(db))();
  router.get('/api/admin/weavenotes-settings', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getWeaveNotesSettings();
    json(res, 200, { 'weavenotes-settings': row ? [row] : [], config: row });
  });
  const weaveNotesSettingsPut = async (req: any, res: any) => {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    // Map the admin form's snake_case columns → the camelCase config the validator expects.
    const partial: Record<string, unknown> = {};
    if (body['default_theme'] !== undefined) partial['defaultTheme'] = body['default_theme'];
    if (body['agency_color_enabled'] !== undefined) partial['agencyColorEnabled'] = body['agency_color_enabled'];
    if (body['ai_suggestions_require_approval'] !== undefined) partial['aiSuggestionsRequireApproval'] = body['ai_suggestions_require_approval'];
    if (body['activity_tracking_enabled'] !== undefined) partial['activityTrackingEnabled'] = body['activity_tracking_enabled'];
    if (body['activity_retention_days'] !== undefined) partial['activityRetentionDays'] = body['activity_retention_days'];
    if (body['max_ai_tokens_per_edit'] !== undefined) partial['maxAiTokensPerEdit'] = body['max_ai_tokens_per_edit'];
    if (body['ai_rate_per_min_per_user'] !== undefined) partial['aiRatePerMinPerUser'] = body['ai_rate_per_min_per_user'];
    if (body['local_model_for_sensitive'] !== undefined) partial['localModelForSensitive'] = body['local_model_for_sensitive'];
    if (body['live_cursors_enabled'] !== undefined) partial['liveCursorsEnabled'] = body['live_cursors_enabled'];
    if (body['ai_presence_enabled'] !== undefined) partial['aiPresenceEnabled'] = body['ai_presence_enabled'];
    if (body['diagrams_enabled'] !== undefined) partial['diagramsEnabled'] = body['diagrams_enabled'];
    if (body['ink_enabled'] !== undefined) partial['inkEnabled'] = body['ink_enabled'];
    if (body['illustration_enabled'] !== undefined) partial['illustrationEnabled'] = body['illustration_enabled'];
    if (body['image_generation_enabled'] !== undefined) partial['imageGenerationEnabled'] = body['image_generation_enabled'];
    if (body['image_model'] !== undefined) partial['imageModel'] = body['image_model'];
    if (body['visual_verify_enabled'] !== undefined) partial['visualVerifyEnabled'] = body['visual_verify_enabled'];
    if (body['visual_verify_threshold'] !== undefined) partial['visualVerifyThreshold'] = body['visual_verify_threshold'];
    if (body['visual_verify_max_retries'] !== undefined) partial['visualVerifyMaxRetries'] = body['visual_verify_max_retries'];
    if (body['image_verify_enabled'] !== undefined) partial['imageVerifyEnabled'] = body['image_verify_enabled'];
    if (body['image_verify_min_confidence'] !== undefined) partial['imageVerifyMinConfidence'] = body['image_verify_min_confidence'];
    if (body['citations_enabled'] !== undefined) partial['citationsEnabled'] = body['citations_enabled'];
    if (body['citation_max_sources'] !== undefined) partial['citationMaxSources'] = body['citation_max_sources'];
    if (body['query_expansion_enabled'] !== undefined) partial['queryExpansionEnabled'] = body['query_expansion_enabled'];
    if (body['query_expansion_variants'] !== undefined) partial['queryExpansionVariants'] = body['query_expansion_variants'];
    if (body['flashcards_enabled'] !== undefined) partial['flashcardsEnabled'] = body['flashcards_enabled'];
    if (body['daily_new_card_limit'] !== undefined) partial['dailyNewCardLimit'] = body['daily_new_card_limit'];
    if (body['fsrs_enabled'] !== undefined) partial['fsrsEnabled'] = body['fsrs_enabled'];
    if (body['fsrs_target_retention'] !== undefined) partial['fsrsTargetRetention'] = body['fsrs_target_retention'];
    if (body['translate_enabled'] !== undefined) partial['translateEnabled'] = body['translate_enabled'];
    if (body['db_autofill_web_search'] !== undefined) partial['dbAutofillWebSearch'] = body['db_autofill_web_search'];
    if (body['db_autofill_redact_pii'] !== undefined) partial['dbAutofillRedactPii'] = body['db_autofill_redact_pii'];
    if (body['image_provenance_enabled'] !== undefined) partial['imageProvenanceEnabled'] = body['image_provenance_enabled'];
    if (body['scheduled_agents_enabled'] !== undefined) partial['scheduledAgentsEnabled'] = body['scheduled_agents_enabled'];
    if (body['scheduled_agent_max_token_budget'] !== undefined) partial['scheduledAgentMaxTokenBudget'] = body['scheduled_agent_max_token_budget'];
    if (body['scheduled_agent_max_per_user'] !== undefined) partial['scheduledAgentMaxPerUser'] = body['scheduled_agent_max_per_user'];
    if (body['mcp_notes_enabled'] !== undefined) partial['mcpNotesEnabled'] = body['mcp_notes_enabled'];
    if (body['mcp_notes_allow_writes'] !== undefined) partial['mcpNotesAllowWrites'] = body['mcp_notes_allow_writes'];
    if (body['proactive_linking_enabled'] !== undefined) partial['proactiveLinkingEnabled'] = body['proactive_linking_enabled'];
    if (body['entity_resolution_enabled'] !== undefined) partial['entityResolutionEnabled'] = body['entity_resolution_enabled'];
    if (body['embedding_batch_size'] !== undefined) partial['embeddingBatchSize'] = body['embedding_batch_size'];
    if (body['voice_capture_enabled'] !== undefined) partial['voiceCaptureEnabled'] = body['voice_capture_enabled'];
    if (body['store_audio'] !== undefined) partial['storeAudio'] = body['store_audio'];
    if (body['transcription_language'] !== undefined) partial['transcriptionLanguage'] = body['transcription_language'];
    if (body['transcription_model'] !== undefined) partial['transcriptionModel'] = body['transcription_model'];
    if (body['max_recording_seconds'] !== undefined) partial['maxRecordingSeconds'] = body['max_recording_seconds'];
    if (body['background_memory_enabled'] !== undefined) partial['backgroundMemoryEnabled'] = body['background_memory_enabled'];
    if (body['memory_importance_threshold'] !== undefined) partial['memoryImportanceThreshold'] = body['memory_importance_threshold'];
    if (body['memory_max_per_note'] !== undefined) partial['memoryMaxPerNote'] = body['memory_max_per_note'];
    if (body['memory_recall_count'] !== undefined) partial['memoryRecallCount'] = body['memory_recall_count'];
    if (body['memory_decay_half_life_days'] !== undefined) partial['memoryDecayHalfLifeDays'] = body['memory_decay_half_life_days'];
    if (body['mobile_offline_enabled'] !== undefined) partial['mobileOfflineEnabled'] = body['mobile_offline_enabled'];
    if (body['mobile_ink_enabled'] !== undefined) partial['mobileInkEnabled'] = body['mobile_ink_enabled'];
    if (body['mobile_offline_note_limit'] !== undefined) partial['mobileOfflineNoteLimit'] = body['mobile_offline_note_limit'];
    if (body['desktop_offline_enabled'] !== undefined) partial['desktopOfflineEnabled'] = body['desktop_offline_enabled'];
    if (body['quick_capture_enabled'] !== undefined) partial['quickCaptureEnabled'] = body['quick_capture_enabled'];
    if (body['desktop_offline_note_limit'] !== undefined) partial['desktopOfflineNoteLimit'] = body['desktop_offline_note_limit'];
    if (body['export_enabled'] !== undefined) partial['exportEnabled'] = body['export_enabled'];
    if (body['allowed_export_formats'] !== undefined) {
      let arr: unknown = body['allowed_export_formats'];
      try { if (typeof arr === 'string') arr = JSON.parse(arr); } catch { arr = []; }
      partial['allowedExportFormats'] = arr;
    }
    if (body['enabled_ai_tools'] !== undefined) {
      let arr: unknown = body['enabled_ai_tools'];
      try { if (typeof arr === 'string') arr = JSON.parse(arr); } catch { arr = []; }
      partial['enabledAiTools'] = arr;
    }
    if (body['image_search_enabled'] !== undefined) partial['imageSearchEnabled'] = body['image_search_enabled'];
    if (body['image_search_provider'] !== undefined) partial['imageSearchProvider'] = body['image_search_provider'];
    if (body['image_search_require_attribution'] !== undefined) partial['imageSearchRequireAttribution'] = body['image_search_require_attribution'];
    if (body['image_search_allowed_licenses'] !== undefined) {
      let arr: unknown = body['image_search_allowed_licenses'];
      try { if (typeof arr === 'string') arr = JSON.parse(arr); } catch { arr = []; }
      partial['imageSearchAllowedLicenses'] = arr;
    }
    const { warnings } = await (await noteSettings).updateConfig(partial);
    const row = await db.getWeaveNotesSettings();
    json(res, 200, { 'weavenotes-settings': row, warnings });
  };
  router.put('/api/admin/weavenotes-settings', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await weaveNotesSettingsPut(req, res);
  }, { auth: true, csrf: true });
  router.put('/api/admin/weavenotes-settings/:id', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await weaveNotesSettingsPut(req, res);
  }, { auth: true, csrf: true });

  // ── Admin: weaveNotes Action Routing (per-tenant mode for each note AI action) ──
  // Multi-row CRUD: each row sets, for one (tenant, action), whether it runs direct / agent /
  // supervisor. tenant_id '' = the global default for that action. Resolution at call time:
  // tenant row → global row → 'direct'. Edited via the Builder (weaveNotes → Action Routing).
  const NOTE_ACTION_KEYS = ['diagram', 'ink', 'illustration', 'visual', 'restructure', 'find_image'];
  const NOTE_ACTION_MODE_VALUES = ['direct', 'agent', 'supervisor'];
  router.get('/api/admin/note-action-modes', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { 'note-action-modes': await db.listNoteActionModes() });
  });
  const readActionModeBody = async (req: any): Promise<{ tenant_id: string; action_key: string; mode: string } | { error: string }> => {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { return { error: 'Invalid JSON' }; }
    const action_key = String(body['action_key'] ?? '').trim();
    const mode = String(body['mode'] ?? 'direct').trim();
    const tenant_id = String(body['tenant_id'] ?? '').trim();
    if (!NOTE_ACTION_KEYS.includes(action_key)) return { error: `action_key must be one of: ${NOTE_ACTION_KEYS.join(', ')}` };
    if (!NOTE_ACTION_MODE_VALUES.includes(mode)) return { error: `mode must be one of: ${NOTE_ACTION_MODE_VALUES.join(', ')}` };
    return { tenant_id, action_key, mode };
  };
  router.post('/api/admin/note-action-modes', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const parsed = await readActionModeBody(req);
    if ('error' in parsed) { json(res, 400, { error: parsed.error }); return; }
    const id = `noteact-${parsed.tenant_id || 'global'}-${parsed.action_key}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    await db.createNoteActionMode({ id, ...parsed });
    // The upsert may have merged into an existing (tenant, action) row under its own id — return the
    // resolved row by key, not by our computed id.
    const row = (await db.listNoteActionModes()).find((r) => r.tenant_id === parsed.tenant_id && r.action_key === parsed.action_key) ?? null;
    json(res, 200, { 'note-action-modes': row });
  }, { auth: true, csrf: true });
  router.put('/api/admin/note-action-modes/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const parsed = await readActionModeBody(req);
    if ('error' in parsed) { json(res, 400, { error: parsed.error }); return; }
    await db.updateNoteActionMode(params['id']!, parsed);
    json(res, 200, { 'note-action-modes': await db.getNoteActionMode(params['id']!) });
  }, { auth: true, csrf: true });
  router.del('/api/admin/note-action-modes/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteNoteActionMode(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: weaveNotes Activity / Audit (Phase 0-B) ──────────────────────────────────────────
  // A read-only, TENANT-scoped compliance feed of every note action (who / what / when, user or AI),
  // with KEYSET pagination (stable on a live append-only log) + filters, plus a CSV/JSON/JSONL export.
  // Always scoped to the admin's own tenant (auth.tenantId) — never cross-tenant.
  const buildActivityQuery = (req: IncomingMessage): import('../../db-types/adapter-me.js').NoteActivityQuery => {
    const u = new URL(req.url ?? '', 'http://localhost');
    const q: import('../../db-types/adapter-me.js').NoteActivityQuery = {};
    const lim = Number.parseInt(u.searchParams.get('limit') ?? '', 10);
    if (Number.isFinite(lim)) q.limit = lim;
    for (const k of ['action', 'actor', 'userId', 'noteId', 'fromDate', 'toDate', 'beforeCreatedAt', 'beforeId'] as const) {
      const v = u.searchParams.get(k);
      if (v) (q as Record<string, unknown>)[k] = v;
    }
    return q;
  };
  router.get('/api/admin/note-activity', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const q = buildActivityQuery(req);
    q.limit = Math.max(1, Math.min(500, q.limit ?? 100));
    const rows = await db.listTenantNoteActivity(auth.tenantId ?? null, q);
    // Keyset cursor for the NEXT (older) page: pass back the last row's (created_at, id).
    const last = rows[rows.length - 1];
    const nextCursor = rows.length >= q.limit && last ? { beforeCreatedAt: last.created_at, beforeId: last.id } : null;
    json(res, 200, { 'note-activity': rows, nextCursor });
  }, { auth: true });
  router.get('/api/admin/note-activity/export', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const u = new URL(req.url ?? '', 'http://localhost');
    const format = (u.searchParams.get('format') ?? 'csv').toLowerCase();
    const q = buildActivityQuery(req);
    q.limit = Math.max(1, Math.min(10000, q.limit ?? 10000)); // bounded export
    const rows = await db.listTenantNoteActivity(auth.tenantId ?? null, q);
    const cols = ['created_at', 'actor', 'action', 'user_id', 'note_id', 'note_title', 'summary', 'id'] as const;
    if (format === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="note-activity.json"' });
      res.end(JSON.stringify(rows, null, 2)); return;
    }
    if (format === 'jsonl') { // one JSON object per line — SIEM/stream-friendly, constant memory
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="note-activity.jsonl"' });
      res.end(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); return;
    }
    // CSV (default). Quote everything; defeat CSV FORMULA INJECTION by prefixing a leading =,+,-,@ with '.
    const cell = (v: unknown): string => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell((r as unknown as Record<string, unknown>)[c])).join(','))].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="note-activity.csv"' });
    res.end(csv);
  }, { auth: true });

  // ── Admin: Agent Plan Cache Config (Phase 8 single global row) ──
  router.get('/api/admin/agent-plan-cache-config', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const cfg = await db.getAgentPlanCacheConfig();
    json(res, 200, { 'agent-plan-cache-config': cfg ? [cfg] : [], config: cfg });
  });
  const applyPlanConfigUpdate = async (body: Record<string, unknown>) => {
    const fields: Record<string, unknown> = {};
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['similarity_threshold'] !== undefined) fields['similarity_threshold'] = Math.max(0, Math.min(1, Number(body['similarity_threshold'])));
    if (body['min_steps'] !== undefined) fields['min_steps'] = Math.max(0, Math.trunc(Number(body['min_steps'])));
    if (body['max_entries'] !== undefined) fields['max_entries'] = Math.max(1, Math.trunc(Number(body['max_entries'])));
    if (body['ttl_ms'] !== undefined) fields['ttl_ms'] = Math.max(0, Math.trunc(Number(body['ttl_ms'])));
    if (body['scope'] !== undefined) fields['scope'] = ['global', 'tenant', 'user', 'session'].includes(String(body['scope'])) ? String(body['scope']) : 'user';
    if (body['embedding_model'] !== undefined) fields['embedding_model'] = String(body['embedding_model']).slice(0, 128);
    await db.updateAgentPlanCacheConfig(toDbUpdate(fields));
    // Reset the chat path's 60s plan-cache config cache so changes take effect now.
    try { const { _resetPlanCacheConfigCache } = await import('../../agent-plan-cache.js'); _resetPlanCacheConfigCache(); } catch { /* ignore */ }
    return db.getAgentPlanCacheConfig();
  };
  const planConfigPut = async (req: any, res: any) => {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const cfg = await applyPlanConfigUpdate(body);
    json(res, 200, { 'agent-plan-cache-config': cfg });
  };
  router.put('/api/admin/agent-plan-cache-config', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await planConfigPut(req, res);
  }, { auth: true, csrf: true });
  router.put('/api/admin/agent-plan-cache-config/:id', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await planConfigPut(req, res);
  }, { auth: true, csrf: true });
  // Phase 8 observability: live plan-cache hit/miss/store stats.
  router.get('/api/admin/plan-cache/stats', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const { getPlanCacheStats } = await import('../../agent-plan-cache.js');
    json(res, 200, { stats: getPlanCacheStats() });
  });

  // ── Admin: Cache Metrics (Phase 3 observability dashboard) ──

  router.get('/api/admin/cache-metrics', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const limit = Number(url.searchParams.get('limit') ?? '168') || 168;
    const summary = await db.getCacheMetrics(limit);
    const settings = await db.getCacheSettings();
    // Live, process-wide snapshot from the in-memory metrics sink (when wired).
    const live = runtime?.cache?.metrics?.snapshot?.() ?? null;
    json(res, 200, {
      'cache-metrics': summary.windows,           // list view (read-only admin tab)
      summary: summary.totals,                    // aggregate totals
      live,                                        // live process snapshot
      metricsEnabled: settings ? settings.metrics_enabled !== 0 : true,
    });
  });

  // ── Admin: Cache Invalidation (Phase 5) ─────────────────────

  // Manual / GDPR "Invalidate Now": clear everything, a tenant, or one user
  // (response + semantic). Body: { all?, tenantId?, userId?, prefix?, semantic? }.
  router.post('/api/admin/cache/invalidate', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || '{}'); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const inv = getActiveCacheInvalidator();
    if (!inv) { json(res, 200, { ok: true, cleared: 0, note: 'no active cache invalidator' }); return; }
    const semantic = body['semantic'] !== false; // default true
    if (body['all']) {
      const cleared = await inv.invalidate({ all: true, semantic });
      json(res, 200, { ok: true, scope: 'all', cleared });
      return;
    }
    const tenantId = (body['tenantId'] as string | undefined) ?? undefined;
    const userId = (body['userId'] as string | undefined) ?? undefined;
    let prefix = body['prefix'] as string | undefined;
    let semanticScope: string | undefined;
    if (!prefix && (tenantId || userId)) {
      if (userId) {
        const p = cacheScopeKeyString({ tenantId, userId, scope: 'user' });
        prefix = p + '||';
        semanticScope = p; // semantic entries are scoped `t=..|u=..`
      } else {
        prefix = cacheScopeKeyString({ tenantId, scope: 'tenant' }) + '|';
        semanticScope = cacheScopeKeyString({ tenantId, scope: 'tenant' });
      }
    }
    const cleared = await inv.invalidate({ prefix, semantic, semanticScope });
    json(res, 200, { ok: true, scope: userId ? 'user' : tenantId ? 'tenant' : 'prefix', prefix, cleared });
  }, { auth: true, csrf: true });

  // Cache Invalidation Rules CRUD
  router.get('/api/admin/cache-invalidation-rules', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { 'cache-invalidation-rules': await db.listCacheInvalidationRules() });
  });
  router.post('/api/admin/cache-invalidation-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['trigger']) { json(res, 400, { error: 'name and trigger required' }); return; }
    const id = newUUIDv7();
    await db.createCacheInvalidationRule({
      id, name: body['name'] as string, trigger: body['trigger'] as string,
      pattern: (body['pattern'] as string) ?? null,
      config: body['config'] ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : '{}',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    _resetInvalidationRulesCache();
    json(res, 201, { 'cache-invalidation-rule': await db.getCacheInvalidationRule(id) });
  }, { auth: true, csrf: true });
  router.put('/api/admin/cache-invalidation-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['trigger'] !== undefined) fields['trigger'] = body['trigger'];
    if (body['pattern'] !== undefined) fields['pattern'] = body['pattern'];
    if (body['config'] !== undefined) fields['config'] = typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateCacheInvalidationRule(params['id']!, toDbUpdate(fields));
    _resetInvalidationRulesCache();
    json(res, 200, { 'cache-invalidation-rule': await db.getCacheInvalidationRule(params['id']!) });
  }, { auth: true, csrf: true });
  router.del('/api/admin/cache-invalidation-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCacheInvalidationRule(params['id']!);
    _resetInvalidationRulesCache();
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Tool Cache Policies (Phase 6 opt-in tool-result caching) ──────────────
  router.get('/api/admin/tool-cache-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { 'tool-cache-policies': await db.listToolCachePolicies() });
  });
  router.post('/api/admin/tool-cache-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['tool_name']) { json(res, 400, { error: 'tool_name required' }); return; }
    const id = newUUIDv7();
    await db.createToolCachePolicy({
      id, tool_name: String(body['tool_name']).slice(0, 128),
      cacheable: body['cacheable'] === false ? 0 : 1,
      ttl_ms: Math.max(0, Math.trunc(Number(body['ttl_ms'] ?? 300_000))),
      enabled: body['enabled'] === false ? 0 : 1,
    });
    _resetToolCachePoliciesCache();
    json(res, 201, { 'tool-cache-policy': await db.getToolCachePolicy(id) });
  }, { auth: true, csrf: true });
  router.put('/api/admin/tool-cache-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['tool_name'] !== undefined) fields['tool_name'] = String(body['tool_name']).slice(0, 128);
    if (body['cacheable'] !== undefined) fields['cacheable'] = body['cacheable'] ? 1 : 0;
    if (body['ttl_ms'] !== undefined) fields['ttl_ms'] = Math.max(0, Math.trunc(Number(body['ttl_ms'])));
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateToolCachePolicy(params['id']!, toDbUpdate(fields));
    _resetToolCachePoliciesCache();
    json(res, 200, { 'tool-cache-policy': await db.getToolCachePolicy(params['id']!) });
  }, { auth: true, csrf: true });
  router.del('/api/admin/tool-cache-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteToolCachePolicy(params['id']!);
    _resetToolCachePoliciesCache();
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
  // Observability: live tool-cache hit/miss/entry stats.
  router.get('/api/admin/tool-cache/stats', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { stats: await getToolCacheStats() });
  });
  // Phase 7 observability: live singleflight stampede stats (flights/coalesced).
  router.get('/api/admin/stampede/stats', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { stats: getSingleflightStats() });
  });

  router.put('/api/admin/cache-settings', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['l2_enabled'] !== undefined) fields['l2_enabled'] = body['l2_enabled'] ? 1 : 0;
    if (body['l2_provider'] !== undefined) fields['l2_provider'] = body['l2_provider'] === 'redis' ? 'redis' : 'none';
    if (body['l1_max_entries'] !== undefined) fields['l1_max_entries'] = body['l1_max_entries'];
    if (body['l1_max_bytes'] !== undefined) fields['l1_max_bytes'] = body['l1_max_bytes'];
    if (body['l1_ttl_ms'] !== undefined) fields['l1_ttl_ms'] = body['l1_ttl_ms'];
    if (body['key_namespace'] !== undefined) fields['key_namespace'] = String(body['key_namespace']).slice(0, 128);
    if (body['global_version_token'] !== undefined) fields['global_version_token'] = String(body['global_version_token']).slice(0, 64);
    if (body['stampede_protection'] !== undefined) fields['stampede_protection'] = body['stampede_protection'] ? 1 : 0;
    if (body['metrics_enabled'] !== undefined) fields['metrics_enabled'] = body['metrics_enabled'] ? 1 : 0;
    // Phase 7 — eviction strategy & global negative-cache TTL.
    if (body['l1_eviction_policy'] !== undefined) fields['l1_eviction_policy'] = ['lru', 'lfu', 'fifo', 'tinylfu', 'gdsf'].includes(String(body['l1_eviction_policy'])) ? String(body['l1_eviction_policy']) : 'lru';
    if (body['l1_negative_ttl_ms'] !== undefined) fields['l1_negative_ttl_ms'] = Math.max(0, Math.trunc(Number(body['l1_negative_ttl_ms'])));
    await db.updateCacheSettings(toDbUpdate(fields));
    // Phase 5: bumping the global_version_token must take effect immediately —
    // reset the chat path's cached version so new requests use new keys.
    if (body['global_version_token'] !== undefined) _resetCacheKeyVersionCache();
    // Phase 7: stampede config (enabled + negative TTL) is read on the chat path
    // via a 60s cache — reset it so toggles take effect promptly.
    _resetStampedeConfigCache();
    const settings = await db.getCacheSettings();
    json(res, 200, { 'cache-settings': settings });
  }, { auth: true, csrf: true });

  // ── Admin: Memory Extraction Rules ────────────────────────

  router.get('/api/admin/memory-extraction-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const ruleType = url.searchParams.get('rule_type') ?? undefined;
    const items = await db.listMemoryExtractionRules(ruleType);
    json(res, 200, { 'memory-extraction-rules': items });
  });

  router.get('/api/admin/memory-extraction-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rule = await db.getMemoryExtractionRule(params['id']!);
    if (!rule) { json(res, 404, { error: 'Memory extraction rule not found' }); return; }
    json(res, 200, { 'memory-extraction-rule': rule });
  });

  router.post('/api/admin/memory-extraction-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['rule_type'] || !body['pattern']) {
      json(res, 400, { error: 'name, rule_type and pattern required' });
      return;
    }
    const id = newUUIDv7();
    await db.createMemoryExtractionRule({
      id,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      rule_type: body['rule_type'] as string,
      entity_type: ((body['entity_type'] as string) || '').trim() || null,
      pattern: body['pattern'] as string,
      flags: (body['flags'] as string) ?? null,
      facts_template: body['facts_template']
        ? (typeof body['facts_template'] === 'string' ? body['facts_template'] as string : JSON.stringify(body['facts_template']))
        : null,
      priority: (body['priority'] as number) ?? 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getMemoryExtractionRule(id);
    json(res, 201, { 'memory-extraction-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/memory-extraction-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMemoryExtractionRule(params['id']!);
    if (!existing) { json(res, 404, { error: 'Memory extraction rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['rule_type'] !== undefined) fields['rule_type'] = body['rule_type'];
    if (body['entity_type'] !== undefined) fields['entity_type'] = ((body['entity_type'] as string) || '').trim() || null;
    if (body['pattern'] !== undefined) fields['pattern'] = body['pattern'];
    if (body['flags'] !== undefined) fields['flags'] = body['flags'];
    if (body['facts_template'] !== undefined) {
      fields['facts_template'] = typeof body['facts_template'] === 'string' ? body['facts_template'] : JSON.stringify(body['facts_template']);
    }
    if (body['priority'] !== undefined) fields['priority'] = body['priority'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateMemoryExtractionRule(params['id']!, toDbUpdate(fields));
    const item = await db.getMemoryExtractionRule(params['id']!);
    json(res, 200, { 'memory-extraction-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/memory-extraction-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteMemoryExtractionRule(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Search Providers ────────────────────────────────

  router.get('/api/admin/search-providers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listSearchProviders();
    json(res, 200, { 'search-providers': items });
  });

  router.get('/api/admin/search-providers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getSearchProvider(params['id']!);
    if (!c) { json(res, 404, { error: 'Search provider not found' }); return; }
    json(res, 200, { 'search-provider': c });
  });

  router.post('/api/admin/search-providers', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['provider_type']) { json(res, 400, { error: 'name and provider_type required' }); return; }
    const id = newUUIDv7();
    await db.createSearchProvider({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      provider_type: body['provider_type'] as string,
      api_key: (body['api_key'] as string) ?? null,
      base_url: (body['base_url'] as string) ?? null,
      priority: (body['priority'] as number) ?? 0,
      options: body['options'] ? (typeof body['options'] === 'string' ? body['options'] as string : JSON.stringify(body['options'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getSearchProvider(id);
    json(res, 201, { 'search-provider': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/search-providers/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getSearchProvider(params['id']!);
    if (!existing) { json(res, 404, { error: 'Search provider not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['provider_type'] !== undefined) fields['provider_type'] = body['provider_type'];
    if (body['api_key'] !== undefined) fields['api_key'] = body['api_key'];
    if (body['base_url'] !== undefined) fields['base_url'] = body['base_url'];
    if (body['priority'] !== undefined) fields['priority'] = body['priority'];
    if (body['options'] !== undefined) fields['options'] = typeof body['options'] === 'string' ? body['options'] : JSON.stringify(body['options']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateSearchProvider(params['id']!, toDbUpdate(fields));
    const item = await db.getSearchProvider(params['id']!);
    json(res, 200, { 'search-provider': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/search-providers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSearchProvider(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: HTTP Endpoints ──────────────────────────────────

  router.get('/api/admin/http-endpoints', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listHttpEndpoints();
    json(res, 200, { 'http-endpoints': items });
  });

  router.get('/api/admin/http-endpoints/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getHttpEndpoint(params['id']!);
    if (!c) { json(res, 404, { error: 'HTTP endpoint not found' }); return; }
    json(res, 200, { 'http-endpoint': c });
  });

  router.post('/api/admin/http-endpoints', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['url']) { json(res, 400, { error: 'name and url required' }); return; }
    const id = newUUIDv7();
    await db.createHttpEndpoint({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      url: body['url'] as string, method: (body['method'] as string) ?? 'GET',
      auth_type: (body['auth_type'] as string) ?? null,
      auth_config: body['auth_config'] ? (typeof body['auth_config'] === 'string' ? body['auth_config'] as string : JSON.stringify(body['auth_config'])) : null,
      headers: body['headers'] ? (typeof body['headers'] === 'string' ? body['headers'] as string : JSON.stringify(body['headers'])) : null,
      body_template: (body['body_template'] as string) ?? null,
      response_transform: (body['response_transform'] as string) ?? null,
      retry_count: (body['retry_count'] as number) ?? 2,
      rate_limit_rpm: (body['rate_limit_rpm'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getHttpEndpoint(id);
    json(res, 201, { 'http-endpoint': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/http-endpoints/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getHttpEndpoint(params['id']!);
    if (!existing) { json(res, 404, { error: 'HTTP endpoint not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['url'] !== undefined) fields['url'] = body['url'];
    if (body['method'] !== undefined) fields['method'] = body['method'];
    if (body['auth_type'] !== undefined) fields['auth_type'] = body['auth_type'];
    if (body['auth_config'] !== undefined) fields['auth_config'] = typeof body['auth_config'] === 'string' ? body['auth_config'] : JSON.stringify(body['auth_config']);
    if (body['headers'] !== undefined) fields['headers'] = typeof body['headers'] === 'string' ? body['headers'] : JSON.stringify(body['headers']);
    if (body['body_template'] !== undefined) fields['body_template'] = body['body_template'];
    if (body['response_transform'] !== undefined) fields['response_transform'] = body['response_transform'];
    if (body['retry_count'] !== undefined) fields['retry_count'] = body['retry_count'];
    if (body['rate_limit_rpm'] !== undefined) fields['rate_limit_rpm'] = body['rate_limit_rpm'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateHttpEndpoint(params['id']!, toDbUpdate(fields));
    const item = await db.getHttpEndpoint(params['id']!);
    json(res, 200, { 'http-endpoint': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/http-endpoints/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteHttpEndpoint(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Social Accounts ─────────────────────────────────

  router.get('/api/admin/social-accounts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listSocialAccounts();
    json(res, 200, { 'social-accounts': items });
  });

  router.get('/api/admin/social-accounts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getSocialAccount(params['id']!);
    if (!c) { json(res, 404, { error: 'Social account not found' }); return; }
    json(res, 200, { 'social-account': c });
  });

  router.post('/api/admin/social-accounts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['platform']) { json(res, 400, { error: 'name and platform required' }); return; }
    const id = newUUIDv7();
    await db.createSocialAccount({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      platform: body['platform'] as string,
      api_key: (body['api_key'] as string) ?? null,
      api_secret: (body['api_secret'] as string) ?? null,
      access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
      base_url: (body['base_url'] as string) ?? null,
      options: body['options'] ? (typeof body['options'] === 'string' ? body['options'] as string : JSON.stringify(body['options'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getSocialAccount(id);
    json(res, 201, { 'social-account': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/social-accounts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getSocialAccount(params['id']!);
    if (!existing) { json(res, 404, { error: 'Social account not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['platform'] !== undefined) fields['platform'] = body['platform'];
    if (body['api_key'] !== undefined) fields['api_key'] = body['api_key'];
    if (body['api_secret'] !== undefined) fields['api_secret'] = body['api_secret'];
    if (body['base_url'] !== undefined) fields['base_url'] = body['base_url'];
    if (body['options'] !== undefined) fields['options'] = typeof body['options'] === 'string' ? body['options'] : JSON.stringify(body['options']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateSocialAccount(params['id']!, toDbUpdate(fields));
    const item = await db.getSocialAccount(params['id']!);
    json(res, 200, { 'social-account': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/social-accounts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSocialAccount(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Enterprise Connectors ───────────────────────────

  router.get('/api/admin/enterprise-connectors', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listEnterpriseConnectors();
    json(res, 200, { 'enterprise-connectors': items });
  });

  router.get('/api/admin/enterprise-connectors/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getEnterpriseConnector(params['id']!);
    if (!c) { json(res, 404, { error: 'Enterprise connector not found' }); return; }
    json(res, 200, { 'enterprise-connector': c });
  });

  router.post('/api/admin/enterprise-connectors', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['connector_type']) { json(res, 400, { error: 'name and connector_type required' }); return; }
    const id = newUUIDv7();
    await db.createEnterpriseConnector({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      connector_type: body['connector_type'] as string,
      base_url: (body['base_url'] as string) ?? null,
      auth_type: (body['auth_type'] as string) ?? null,
      auth_config: body['auth_config'] ? (typeof body['auth_config'] === 'string' ? body['auth_config'] as string : JSON.stringify(body['auth_config'])) : null,
      access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
      options: body['options'] ? (typeof body['options'] === 'string' ? body['options'] as string : JSON.stringify(body['options'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getEnterpriseConnector(id);
    json(res, 201, { 'enterprise-connector': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/enterprise-connectors/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getEnterpriseConnector(params['id']!);
    if (!existing) { json(res, 404, { error: 'Enterprise connector not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['connector_type'] !== undefined) fields['connector_type'] = body['connector_type'];
    if (body['base_url'] !== undefined) fields['base_url'] = body['base_url'];
    if (body['auth_type'] !== undefined) fields['auth_type'] = body['auth_type'];
    if (body['auth_config'] !== undefined) fields['auth_config'] = typeof body['auth_config'] === 'string' ? body['auth_config'] : JSON.stringify(body['auth_config']);
    if (body['options'] !== undefined) fields['options'] = typeof body['options'] === 'string' ? body['options'] : JSON.stringify(body['options']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['access_token'] !== undefined) fields['access_token'] = body['access_token'];
    if (body['refresh_token'] !== undefined) fields['refresh_token'] = body['refresh_token'];
    if (body['token_expires_at'] !== undefined) fields['token_expires_at'] = body['token_expires_at'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    await db.updateEnterpriseConnector(params['id']!, toDbUpdate(fields));
    const item = await db.getEnterpriseConnector(params['id']!);
    json(res, 200, { 'enterprise-connector': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/enterprise-connectors/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteEnterpriseConnector(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Tool Registry ───────────────────────────────────

  router.get('/api/admin/tool-registry', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listToolRegistry();
    json(res, 200, { 'tool-registry': items });
  });

  router.get('/api/admin/tool-registry/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getToolRegistryEntry(params['id']!);
    if (!c) { json(res, 404, { error: 'Tool registry entry not found' }); return; }
    json(res, 200, { 'tool-registry-entry': c });
  });

  router.post('/api/admin/tool-registry', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['package_name']) { json(res, 400, { error: 'name and package_name required' }); return; }
    const id = newUUIDv7();
    await db.createToolRegistryEntry({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      package_name: body['package_name'] as string, version: (body['version'] as string) ?? '1.0.0',
      category: (body['category'] as string) ?? 'custom', risk_level: (body['risk_level'] as string) ?? 'low',
      tags: body['tags'] ? (typeof body['tags'] === 'string' ? body['tags'] as string : JSON.stringify(body['tags'])) : null,
      config: body['config'] ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : null,
      requires_approval: body['requires_approval'] ? 1 : 0,
      max_execution_ms: (body['max_execution_ms'] as number) ?? null,
      rate_limit_per_min: (body['rate_limit_per_min'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getToolRegistryEntry(id);
    json(res, 201, { 'tool-registry-entry': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tool-registry/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolRegistryEntry(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool registry entry not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['package_name'] !== undefined) fields['package_name'] = body['package_name'];
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['risk_level'] !== undefined) fields['risk_level'] = body['risk_level'];
    if (body['tags'] !== undefined) fields['tags'] = typeof body['tags'] === 'string' ? body['tags'] : JSON.stringify(body['tags']);
    if (body['config'] !== undefined) fields['config'] = typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']);
    if (body['requires_approval'] !== undefined) fields['requires_approval'] = body['requires_approval'] ? 1 : 0;
    if (body['max_execution_ms'] !== undefined) fields['max_execution_ms'] = body['max_execution_ms'];
    if (body['rate_limit_per_min'] !== undefined) fields['rate_limit_per_min'] = body['rate_limit_per_min'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateToolRegistryEntry(params['id']!, toDbUpdate(fields));
    const item = await db.getToolRegistryEntry(params['id']!);
    json(res, 200, { 'tool-registry-entry': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/tool-registry/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteToolRegistryEntry(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Replay Scenarios ─────────────────────────────────

  router.get('/api/admin/replay-scenarios', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listReplayScenarios();
    json(res, 200, { 'replay-scenarios': items });
  });

  router.get('/api/admin/replay-scenarios/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getReplayScenario(params['id']!);
    if (!c) { json(res, 404, { error: 'Replay scenario not found' }); return; }
    json(res, 200, { 'replay-scenario': c });
  });

  router.post('/api/admin/replay-scenarios', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['golden_prompt'] || !body['golden_response']) { json(res, 400, { error: 'name, golden_prompt and golden_response required' }); return; }
    const id = newUUIDv7();
    await db.createReplayScenario({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      golden_prompt: body['golden_prompt'] as string, golden_response: body['golden_response'] as string,
      model: (body['model'] as string) ?? null, provider: (body['provider'] as string) ?? null,
      tags: body['tags'] ? (typeof body['tags'] === 'string' ? body['tags'] as string : JSON.stringify(body['tags'])) : null,
      acceptance_criteria: body['acceptance_criteria'] ? (typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] as string : JSON.stringify(body['acceptance_criteria'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getReplayScenario(id);
    json(res, 201, { 'replay-scenario': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/replay-scenarios/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getReplayScenario(params['id']!);
    if (!existing) { json(res, 404, { error: 'Replay scenario not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['golden_prompt'] !== undefined) fields['golden_prompt'] = body['golden_prompt'];
    if (body['golden_response'] !== undefined) fields['golden_response'] = body['golden_response'];
    if (body['model'] !== undefined) fields['model'] = body['model'];
    if (body['provider'] !== undefined) fields['provider'] = body['provider'];
    if (body['tags'] !== undefined) fields['tags'] = typeof body['tags'] === 'string' ? body['tags'] : JSON.stringify(body['tags']);
    if (body['acceptance_criteria'] !== undefined) fields['acceptance_criteria'] = typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] : JSON.stringify(body['acceptance_criteria']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateReplayScenario(params['id']!, toDbUpdate(fields));
    const item = await db.getReplayScenario(params['id']!);
    json(res, 200, { 'replay-scenario': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/replay-scenarios/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteReplayScenario(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Trigger Definitions ────────────────────────────

  router.get('/api/admin/trigger-definitions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listTriggerDefinitions();
    json(res, 200, { 'trigger-definitions': items });
  });

  router.get('/api/admin/trigger-definitions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getTriggerDefinition(params['id']!);
    if (!c) { json(res, 404, { error: 'Trigger definition not found' }); return; }
    json(res, 200, { 'trigger-definition': c });
  });

  router.post('/api/admin/trigger-definitions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['trigger_type']) { json(res, 400, { error: 'name and trigger_type required' }); return; }
    const id = newUUIDv7();
    await db.createTriggerDefinition({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      trigger_type: body['trigger_type'] as string,
      expression: (body['expression'] as string) ?? null,
      config: body['config'] ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : null,
      target_workflow: (body['target_workflow'] as string) ?? null,
      status: (body['status'] as string) ?? 'active',
      last_fired_at: null, fire_count: 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getTriggerDefinition(id);
    json(res, 201, { 'trigger-definition': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/trigger-definitions/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getTriggerDefinition(params['id']!);
    if (!existing) { json(res, 404, { error: 'Trigger definition not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['trigger_type'] !== undefined) fields['trigger_type'] = body['trigger_type'];
    if (body['expression'] !== undefined) fields['expression'] = body['expression'];
    if (body['config'] !== undefined) fields['config'] = typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']);
    if (body['target_workflow'] !== undefined) fields['target_workflow'] = body['target_workflow'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTriggerDefinition(params['id']!, toDbUpdate(fields));
    const item = await db.getTriggerDefinition(params['id']!);
    json(res, 200, { 'trigger-definition': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/trigger-definitions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteTriggerDefinition(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Tenant Configs ─────────────────────────────────

  router.get('/api/admin/tenant-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listTenantConfigs();
    json(res, 200, { 'tenant-configs': items });
  });

  router.get('/api/admin/tenant-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getTenantConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Tenant config not found' }); return; }
    json(res, 200, { 'tenant-config': c });
  });

  router.post('/api/admin/tenant-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['tenant_id']) { json(res, 400, { error: 'name and tenant_id required' }); return; }
    const id = newUUIDv7();
    await db.createTenantConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      tenant_id: body['tenant_id'] as string,
      scope: (body['scope'] as string) ?? 'tenant',
      allowed_models: body['allowed_models'] ? (typeof body['allowed_models'] === 'string' ? body['allowed_models'] as string : JSON.stringify(body['allowed_models'])) : null,
      denied_models: body['denied_models'] ? (typeof body['denied_models'] === 'string' ? body['denied_models'] as string : JSON.stringify(body['denied_models'])) : null,
      allowed_tools: body['allowed_tools'] ? (typeof body['allowed_tools'] === 'string' ? body['allowed_tools'] as string : JSON.stringify(body['allowed_tools'])) : null,
      max_tokens_daily: (body['max_tokens_daily'] as number) ?? null,
      max_cost_daily: (body['max_cost_daily'] as number) ?? null,
      max_tokens_monthly: (body['max_tokens_monthly'] as number) ?? null,
      max_cost_monthly: (body['max_cost_monthly'] as number) ?? null,
      features: body['features'] ? (typeof body['features'] === 'string' ? body['features'] as string : JSON.stringify(body['features'])) : null,
      config_overrides: body['config_overrides'] ? (typeof body['config_overrides'] === 'string' ? body['config_overrides'] as string : JSON.stringify(body['config_overrides'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getTenantConfig(id);
    json(res, 201, { 'tenant-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tenant-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getTenantConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tenant config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['tenant_id'] !== undefined) fields['tenant_id'] = body['tenant_id'];
    if (body['scope'] !== undefined) fields['scope'] = body['scope'];
    if (body['allowed_models'] !== undefined) fields['allowed_models'] = typeof body['allowed_models'] === 'string' ? body['allowed_models'] : JSON.stringify(body['allowed_models']);
    if (body['denied_models'] !== undefined) fields['denied_models'] = typeof body['denied_models'] === 'string' ? body['denied_models'] : JSON.stringify(body['denied_models']);
    if (body['allowed_tools'] !== undefined) fields['allowed_tools'] = typeof body['allowed_tools'] === 'string' ? body['allowed_tools'] : JSON.stringify(body['allowed_tools']);
    if (body['max_tokens_daily'] !== undefined) fields['max_tokens_daily'] = body['max_tokens_daily'];
    if (body['max_cost_daily'] !== undefined) fields['max_cost_daily'] = body['max_cost_daily'];
    if (body['max_tokens_monthly'] !== undefined) fields['max_tokens_monthly'] = body['max_tokens_monthly'];
    if (body['max_cost_monthly'] !== undefined) fields['max_cost_monthly'] = body['max_cost_monthly'];
    if (body['features'] !== undefined) fields['features'] = typeof body['features'] === 'string' ? body['features'] : JSON.stringify(body['features']);
    if (body['config_overrides'] !== undefined) fields['config_overrides'] = typeof body['config_overrides'] === 'string' ? body['config_overrides'] : JSON.stringify(body['config_overrides']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTenantConfig(params['id']!, toDbUpdate(fields));
    const item = await db.getTenantConfig(params['id']!);
    json(res, 200, { 'tenant-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/tenant-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteTenantConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Sandbox Policies ────────────────────────────────

  router.get('/api/admin/sandbox-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listSandboxPolicies();
    json(res, 200, { 'sandbox-policies': items });
  });

  router.get('/api/admin/sandbox-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getSandboxPolicy(params['id']!);
    if (!c) { json(res, 404, { error: 'Sandbox policy not found' }); return; }
    json(res, 200, { 'sandbox-policy': c });
  });

  router.post('/api/admin/sandbox-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createSandboxPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      max_cpu_ms: (body['max_cpu_ms'] as number) ?? null,
      max_memory_mb: (body['max_memory_mb'] as number) ?? null,
      max_duration_ms: (body['max_duration_ms'] as number) ?? 30000,
      max_output_bytes: (body['max_output_bytes'] as number) ?? null,
      allowed_modules: body['allowed_modules'] ? (typeof body['allowed_modules'] === 'string' ? body['allowed_modules'] as string : JSON.stringify(body['allowed_modules'])) : null,
      denied_modules: body['denied_modules'] ? (typeof body['denied_modules'] === 'string' ? body['denied_modules'] as string : JSON.stringify(body['denied_modules'])) : null,
      network_access: body['network_access'] ? 1 : 0,
      filesystem_access: (body['filesystem_access'] as string) ?? 'none',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getSandboxPolicy(id);
    json(res, 201, { 'sandbox-policy': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/sandbox-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getSandboxPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Sandbox policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['max_cpu_ms'] !== undefined) fields['max_cpu_ms'] = body['max_cpu_ms'];
    if (body['max_memory_mb'] !== undefined) fields['max_memory_mb'] = body['max_memory_mb'];
    if (body['max_duration_ms'] !== undefined) fields['max_duration_ms'] = body['max_duration_ms'];
    if (body['max_output_bytes'] !== undefined) fields['max_output_bytes'] = body['max_output_bytes'];
    if (body['allowed_modules'] !== undefined) fields['allowed_modules'] = typeof body['allowed_modules'] === 'string' ? body['allowed_modules'] : JSON.stringify(body['allowed_modules']);
    if (body['denied_modules'] !== undefined) fields['denied_modules'] = typeof body['denied_modules'] === 'string' ? body['denied_modules'] : JSON.stringify(body['denied_modules']);
    if (body['network_access'] !== undefined) fields['network_access'] = body['network_access'] ? 1 : 0;
    if (body['filesystem_access'] !== undefined) fields['filesystem_access'] = body['filesystem_access'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateSandboxPolicy(params['id']!, toDbUpdate(fields));
    const item = await db.getSandboxPolicy(params['id']!);
    json(res, 200, { 'sandbox-policy': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/sandbox-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSandboxPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Extraction Pipelines ────────────────────────────

  router.get('/api/admin/extraction-pipelines', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listExtractionPipelines();
    json(res, 200, { 'extraction-pipelines': items });
  });

  router.get('/api/admin/extraction-pipelines/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getExtractionPipeline(params['id']!);
    if (!c) { json(res, 404, { error: 'Extraction pipeline not found' }); return; }
    json(res, 200, { 'extraction-pipeline': c });
  });

  router.post('/api/admin/extraction-pipelines', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createExtractionPipeline({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      stages: body['stages'] ? (typeof body['stages'] === 'string' ? body['stages'] as string : JSON.stringify(body['stages'])) : '[]',
      input_mime_types: body['input_mime_types'] ? (typeof body['input_mime_types'] === 'string' ? body['input_mime_types'] as string : JSON.stringify(body['input_mime_types'])) : null,
      max_input_size_bytes: (body['max_input_size_bytes'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getExtractionPipeline(id);
    json(res, 201, { 'extraction-pipeline': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/extraction-pipelines/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getExtractionPipeline(params['id']!);
    if (!existing) { json(res, 404, { error: 'Extraction pipeline not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['stages'] !== undefined) fields['stages'] = typeof body['stages'] === 'string' ? body['stages'] : JSON.stringify(body['stages']);
    if (body['input_mime_types'] !== undefined) fields['input_mime_types'] = typeof body['input_mime_types'] === 'string' ? body['input_mime_types'] : JSON.stringify(body['input_mime_types']);
    if (body['max_input_size_bytes'] !== undefined) fields['max_input_size_bytes'] = body['max_input_size_bytes'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateExtractionPipeline(params['id']!, toDbUpdate(fields));
    const item = await db.getExtractionPipeline(params['id']!);
    json(res, 200, { 'extraction-pipeline': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/extraction-pipelines/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteExtractionPipeline(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Artifact Policies ───────────────────────────────

  router.get('/api/admin/artifact-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listArtifactPolicies();
    json(res, 200, { 'artifact-policies': items });
  });

  router.get('/api/admin/artifact-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getArtifactPolicy(params['id']!);
    if (!c) { json(res, 404, { error: 'Artifact policy not found' }); return; }
    json(res, 200, { 'artifact-policy': c });
  });

  router.post('/api/admin/artifact-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createArtifactPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      max_size_bytes: (body['max_size_bytes'] as number) ?? null,
      allowed_types: body['allowed_types'] ? (typeof body['allowed_types'] === 'string' ? body['allowed_types'] as string : JSON.stringify(body['allowed_types'])) : null,
      retention_days: (body['retention_days'] as number) ?? null,
      require_versioning: body['require_versioning'] ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getArtifactPolicy(id);
    json(res, 201, { 'artifact-policy': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/artifact-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getArtifactPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Artifact policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['max_size_bytes'] !== undefined) fields['max_size_bytes'] = body['max_size_bytes'];
    if (body['allowed_types'] !== undefined) fields['allowed_types'] = typeof body['allowed_types'] === 'string' ? body['allowed_types'] : JSON.stringify(body['allowed_types']);
    if (body['retention_days'] !== undefined) fields['retention_days'] = body['retention_days'];
    if (body['require_versioning'] !== undefined) fields['require_versioning'] = body['require_versioning'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateArtifactPolicy(params['id']!, toDbUpdate(fields));
    const item = await db.getArtifactPolicy(params['id']!);
    json(res, 200, { 'artifact-policy': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/artifact-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteArtifactPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Reliability Policies ────────────────────────────

  router.get('/api/admin/reliability-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listReliabilityPolicies();
    json(res, 200, { 'reliability-policies': items });
  });

  router.get('/api/admin/reliability-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getReliabilityPolicy(params['id']!);
    if (!c) { json(res, 404, { error: 'Reliability policy not found' }); return; }
    json(res, 200, { 'reliability-policy': c });
  });

  router.post('/api/admin/reliability-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createReliabilityPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      policy_type: (body['policy_type'] as string) ?? 'retry',
      max_retries: (body['max_retries'] as number) ?? null,
      initial_delay_ms: (body['initial_delay_ms'] as number) ?? null,
      max_delay_ms: (body['max_delay_ms'] as number) ?? null,
      backoff_multiplier: (body['backoff_multiplier'] as number) ?? null,
      max_concurrent: (body['max_concurrent'] as number) ?? null,
      queue_size: (body['queue_size'] as number) ?? null,
      strategy: (body['strategy'] as string) ?? null,
      ttl_ms: (body['ttl_ms'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getReliabilityPolicy(id);
    json(res, 201, { 'reliability-policy': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/reliability-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getReliabilityPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Reliability policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['policy_type'] !== undefined) fields['policy_type'] = body['policy_type'];
    if (body['max_retries'] !== undefined) fields['max_retries'] = body['max_retries'];
    if (body['initial_delay_ms'] !== undefined) fields['initial_delay_ms'] = body['initial_delay_ms'];
    if (body['max_delay_ms'] !== undefined) fields['max_delay_ms'] = body['max_delay_ms'];
    if (body['backoff_multiplier'] !== undefined) fields['backoff_multiplier'] = body['backoff_multiplier'];
    if (body['max_concurrent'] !== undefined) fields['max_concurrent'] = body['max_concurrent'];
    if (body['queue_size'] !== undefined) fields['queue_size'] = body['queue_size'];
    if (body['strategy'] !== undefined) fields['strategy'] = body['strategy'];
    if (body['ttl_ms'] !== undefined) fields['ttl_ms'] = body['ttl_ms'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateReliabilityPolicy(params['id']!, toDbUpdate(fields));
    const item = await db.getReliabilityPolicy(params['id']!);
    json(res, 200, { 'reliability-policy': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/reliability-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteReliabilityPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Collaboration Sessions ──────────────────────────

  router.get('/api/admin/collaboration-sessions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listCollaborationSessions();
    json(res, 200, { 'collaboration-sessions': items });
  });

  router.get('/api/admin/collaboration-sessions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getCollaborationSession(params['id']!);
    if (!c) { json(res, 404, { error: 'Collaboration session not found' }); return; }
    json(res, 200, { 'collaboration-session': c });
  });

  router.post('/api/admin/collaboration-sessions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createCollaborationSession({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      session_type: (body['session_type'] as string) ?? 'team',
      max_participants: (body['max_participants'] as number) ?? 10,
      presence_ttl_ms: (body['presence_ttl_ms'] as number) ?? 30000,
      auto_close_idle_ms: (body['auto_close_idle_ms'] as number) ?? null,
      handoff_enabled: body['handoff_enabled'] !== false ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getCollaborationSession(id);
    json(res, 201, { 'collaboration-session': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/collaboration-sessions/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getCollaborationSession(params['id']!);
    if (!existing) { json(res, 404, { error: 'Collaboration session not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['session_type'] !== undefined) fields['session_type'] = body['session_type'];
    if (body['max_participants'] !== undefined) fields['max_participants'] = body['max_participants'];
    if (body['presence_ttl_ms'] !== undefined) fields['presence_ttl_ms'] = body['presence_ttl_ms'];
    if (body['auto_close_idle_ms'] !== undefined) fields['auto_close_idle_ms'] = body['auto_close_idle_ms'];
    if (body['handoff_enabled'] !== undefined) fields['handoff_enabled'] = body['handoff_enabled'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateCollaborationSession(params['id']!, toDbUpdate(fields));
    const item = await db.getCollaborationSession(params['id']!);
    json(res, 200, { 'collaboration-session': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/collaboration-sessions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCollaborationSession(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Graph Configs ───────────────────────────────────

  router.get('/api/admin/graph-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listGraphConfigs();
    json(res, 200, { 'graph-configs': items });
  });

  router.get('/api/admin/graph-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getGraphConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Graph config not found' }); return; }
    json(res, 200, { 'graph-config': c });
  });

  router.post('/api/admin/graph-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createGraphConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      graph_type: (body['graph_type'] as string) ?? 'entity',
      max_depth: (body['max_depth'] as number) ?? 3,
      entity_types: body['entity_types'] != null ? (typeof body['entity_types'] === 'string' ? body['entity_types'] as string : JSON.stringify(body['entity_types'])) : null,
      relationship_types: body['relationship_types'] != null ? (typeof body['relationship_types'] === 'string' ? body['relationship_types'] as string : JSON.stringify(body['relationship_types'])) : null,
      auto_link: body['auto_link'] !== false ? 1 : 0,
      scoring_weights: body['scoring_weights'] != null ? (typeof body['scoring_weights'] === 'string' ? body['scoring_weights'] as string : JSON.stringify(body['scoring_weights'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getGraphConfig(id);
    json(res, 201, { 'graph-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/graph-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getGraphConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Graph config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['graph_type'] !== undefined) fields['graph_type'] = body['graph_type'];
    if (body['max_depth'] !== undefined) fields['max_depth'] = body['max_depth'];
    if (body['entity_types'] !== undefined) fields['entity_types'] = body['entity_types'] != null ? (typeof body['entity_types'] === 'string' ? body['entity_types'] : JSON.stringify(body['entity_types'])) : null;
    if (body['relationship_types'] !== undefined) fields['relationship_types'] = body['relationship_types'] != null ? (typeof body['relationship_types'] === 'string' ? body['relationship_types'] : JSON.stringify(body['relationship_types'])) : null;
    if (body['auto_link'] !== undefined) fields['auto_link'] = body['auto_link'] ? 1 : 0;
    if (body['scoring_weights'] !== undefined) fields['scoring_weights'] = body['scoring_weights'] != null ? (typeof body['scoring_weights'] === 'string' ? body['scoring_weights'] : JSON.stringify(body['scoring_weights'])) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateGraphConfig(params['id']!, toDbUpdate(fields));
    const item = await db.getGraphConfig(params['id']!);
    json(res, 200, { 'graph-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/graph-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteGraphConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Plugin Configs ──────────────────────────────────

  router.get('/api/admin/plugin-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listPluginConfigs();
    json(res, 200, { 'plugin-configs': items });
  });

  router.get('/api/admin/plugin-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getPluginConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Plugin config not found' }); return; }
    json(res, 200, { 'plugin-config': c });
  });

  router.post('/api/admin/plugin-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createPluginConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      plugin_type: (body['plugin_type'] as string) ?? 'community',
      package_name: (body['package_name'] as string) ?? 'unknown',
      version: (body['version'] as string) ?? '1.0.0',
      capabilities: body['capabilities'] != null ? (typeof body['capabilities'] === 'string' ? body['capabilities'] as string : JSON.stringify(body['capabilities'])) : null,
      trust_level: (body['trust_level'] as string) ?? 'community',
      auto_update: body['auto_update'] ? 1 : 0,
      config: body['config'] != null ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getPluginConfig(id);
    json(res, 201, { 'plugin-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/plugin-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPluginConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Plugin config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['plugin_type'] !== undefined) fields['plugin_type'] = body['plugin_type'];
    if (body['package_name'] !== undefined) fields['package_name'] = body['package_name'];
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['capabilities'] !== undefined) fields['capabilities'] = body['capabilities'] != null ? (typeof body['capabilities'] === 'string' ? body['capabilities'] : JSON.stringify(body['capabilities'])) : null;
    if (body['trust_level'] !== undefined) fields['trust_level'] = body['trust_level'];
    if (body['auto_update'] !== undefined) fields['auto_update'] = body['auto_update'] ? 1 : 0;
    if (body['config'] !== undefined) fields['config'] = body['config'] != null ? (typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config'])) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePluginConfig(params['id']!, toDbUpdate(fields));
    const item = await db.getPluginConfig(params['id']!);
    json(res, 200, { 'plugin-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/plugin-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePluginConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Scaffold Templates ────────────────────────────────

  router.get('/api/admin/scaffold-templates', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listScaffoldTemplates();
    json(res, 200, { 'scaffold-templates': items });
  });

  router.get('/api/admin/scaffold-templates/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getScaffoldTemplate(params['id']!);
    if (!c) { json(res, 404, { error: 'Scaffold template not found' }); return; }
    json(res, 200, { 'scaffold-template': c });
  });

  router.post('/api/admin/scaffold-templates', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createScaffoldTemplate({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      template_type: (body['template_type'] as string) ?? 'basic-agent',
      files: body['files'] != null ? (typeof body['files'] === 'string' ? body['files'] as string : JSON.stringify(body['files'])) : null,
      dependencies: body['dependencies'] != null ? (typeof body['dependencies'] === 'string' ? body['dependencies'] as string : JSON.stringify(body['dependencies'])) : null,
      dev_dependencies: body['dev_dependencies'] != null ? (typeof body['dev_dependencies'] === 'string' ? body['dev_dependencies'] as string : JSON.stringify(body['dev_dependencies'])) : null,
      variables: body['variables'] != null ? (typeof body['variables'] === 'string' ? body['variables'] as string : JSON.stringify(body['variables'])) : null,
      post_install: (body['post_install'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getScaffoldTemplate(id);
    json(res, 201, { 'scaffold-template': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/scaffold-templates/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getScaffoldTemplate(params['id']!);
    if (!existing) { json(res, 404, { error: 'Scaffold template not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['template_type'] !== undefined) fields['template_type'] = body['template_type'];
    if (body['files'] !== undefined) fields['files'] = body['files'] != null ? (typeof body['files'] === 'string' ? body['files'] : JSON.stringify(body['files'])) : null;
    if (body['dependencies'] !== undefined) fields['dependencies'] = body['dependencies'] != null ? (typeof body['dependencies'] === 'string' ? body['dependencies'] : JSON.stringify(body['dependencies'])) : null;
    if (body['dev_dependencies'] !== undefined) fields['dev_dependencies'] = body['dev_dependencies'] != null ? (typeof body['dev_dependencies'] === 'string' ? body['dev_dependencies'] : JSON.stringify(body['dev_dependencies'])) : null;
    if (body['variables'] !== undefined) fields['variables'] = body['variables'] != null ? (typeof body['variables'] === 'string' ? body['variables'] : JSON.stringify(body['variables'])) : null;
    if (body['post_install'] !== undefined) fields['post_install'] = body['post_install'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateScaffoldTemplate(params['id']!, toDbUpdate(fields));
    const item = await db.getScaffoldTemplate(params['id']!);
    json(res, 200, { 'scaffold-template': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/scaffold-templates/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteScaffoldTemplate(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Recipe Configs ──────────────────────────────────

  router.get('/api/admin/recipe-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listRecipeConfigs();
    json(res, 200, { 'recipe-configs': items });
  });

  router.get('/api/admin/recipe-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getRecipeConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Recipe config not found' }); return; }
    json(res, 200, { 'recipe-config': c });
  });

  router.post('/api/admin/recipe-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createRecipeConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      recipe_type: (body['recipe_type'] as string) ?? 'workflow',
      model: (body['model'] as string) ?? null,
      provider: (body['provider'] as string) ?? null,
      system_prompt: (body['system_prompt'] as string) ?? null,
      tools: body['tools'] != null ? (typeof body['tools'] === 'string' ? body['tools'] as string : JSON.stringify(body['tools'])) : null,
      guardrails: body['guardrails'] != null ? (typeof body['guardrails'] === 'string' ? body['guardrails'] as string : JSON.stringify(body['guardrails'])) : null,
      max_steps: body['max_steps'] != null ? Number(body['max_steps']) : 10,
      options: body['options'] != null ? (typeof body['options'] === 'string' ? body['options'] as string : JSON.stringify(body['options'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getRecipeConfig(id);
    json(res, 201, { 'recipe-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/recipe-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getRecipeConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Recipe config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['recipe_type'] !== undefined) fields['recipe_type'] = body['recipe_type'];
    if (body['model'] !== undefined) fields['model'] = body['model'];
    if (body['provider'] !== undefined) fields['provider'] = body['provider'];
    if (body['system_prompt'] !== undefined) fields['system_prompt'] = body['system_prompt'];
    if (body['tools'] !== undefined) fields['tools'] = body['tools'] != null ? (typeof body['tools'] === 'string' ? body['tools'] : JSON.stringify(body['tools'])) : null;
    if (body['guardrails'] !== undefined) fields['guardrails'] = body['guardrails'] != null ? (typeof body['guardrails'] === 'string' ? body['guardrails'] : JSON.stringify(body['guardrails'])) : null;
    if (body['max_steps'] !== undefined) fields['max_steps'] = Number(body['max_steps']);
    if (body['options'] !== undefined) fields['options'] = body['options'] != null ? (typeof body['options'] === 'string' ? body['options'] : JSON.stringify(body['options'])) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateRecipeConfig(params['id']!, toDbUpdate(fields));
    const item = await db.getRecipeConfig(params['id']!);
    json(res, 200, { 'recipe-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/recipe-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteRecipeConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Widget Configs ──────────────────────────────────

  router.get('/api/admin/widget-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listWidgetConfigs();
    json(res, 200, { 'widget-configs': items });
  });

  router.get('/api/admin/widget-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getWidgetConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Widget config not found' }); return; }
    json(res, 200, { 'widget-config': c });
  });

  router.post('/api/admin/widget-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createWidgetConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      widget_type: (body['widget_type'] as string) ?? 'table',
      default_options: body['default_options'] != null ? (typeof body['default_options'] === 'string' ? body['default_options'] as string : JSON.stringify(body['default_options'])) : null,
      allowed_contexts: body['allowed_contexts'] != null ? (typeof body['allowed_contexts'] === 'string' ? body['allowed_contexts'] as string : JSON.stringify(body['allowed_contexts'])) : null,
      max_data_points: body['max_data_points'] != null ? Number(body['max_data_points']) : null,
      refresh_interval_ms: body['refresh_interval_ms'] != null ? Number(body['refresh_interval_ms']) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getWidgetConfig(id);
    json(res, 201, { 'widget-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/widget-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWidgetConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Widget config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['widget_type'] !== undefined) fields['widget_type'] = body['widget_type'];
    if (body['default_options'] !== undefined) fields['default_options'] = body['default_options'] != null ? (typeof body['default_options'] === 'string' ? body['default_options'] : JSON.stringify(body['default_options'])) : null;
    if (body['allowed_contexts'] !== undefined) fields['allowed_contexts'] = body['allowed_contexts'] != null ? (typeof body['allowed_contexts'] === 'string' ? body['allowed_contexts'] : JSON.stringify(body['allowed_contexts'])) : null;
    if (body['max_data_points'] !== undefined) fields['max_data_points'] = body['max_data_points'] != null ? Number(body['max_data_points']) : null;
    if (body['refresh_interval_ms'] !== undefined) fields['refresh_interval_ms'] = body['refresh_interval_ms'] != null ? Number(body['refresh_interval_ms']) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateWidgetConfig(params['id']!, toDbUpdate(fields));
    const item = await db.getWidgetConfig(params['id']!);
    json(res, 200, { 'widget-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/widget-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWidgetConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Validation Rules ────────────────────────────────

  router.get('/api/admin/validation-rules', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listValidationRules();
    json(res, 200, { 'validation-rules': items });
  });

  router.get('/api/admin/validation-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getValidationRule(params['id']!);
    if (!c) { json(res, 404, { error: 'Validation rule not found' }); return; }
    json(res, 200, { 'validation-rule': c });
  });

  router.post('/api/admin/validation-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = newUUIDv7();
    await db.createValidationRule({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      rule_type: (body['rule_type'] as string) ?? 'required',
      target: (body['target'] as string) ?? 'agent-config',
      condition: body['condition'] != null ? (typeof body['condition'] === 'string' ? body['condition'] as string : JSON.stringify(body['condition'])) : null,
      severity: (body['severity'] as string) ?? 'error',
      message: (body['message'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getValidationRule(id);
    json(res, 201, { 'validation-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/validation-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getValidationRule(params['id']!);
    if (!existing) { json(res, 404, { error: 'Validation rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['rule_type'] !== undefined) fields['rule_type'] = body['rule_type'];
    if (body['target'] !== undefined) fields['target'] = body['target'];
    if (body['condition'] !== undefined) fields['condition'] = body['condition'] != null ? (typeof body['condition'] === 'string' ? body['condition'] : JSON.stringify(body['condition'])) : null;
    if (body['severity'] !== undefined) fields['severity'] = body['severity'];
    if (body['message'] !== undefined) fields['message'] = body['message'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateValidationRule(params['id']!, toDbUpdate(fields));
    const item = await db.getValidationRule(params['id']!);
    json(res, 200, { 'validation-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/validation-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteValidationRule(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Seed data ───────────────────────────────────────

  router.post('/api/admin/seed', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.seedDefaultData();
    json(res, 200, { ok: true, message: 'Default data seeded' });
  }, { auth: true, csrf: true });

  // ── Admin: Version / About ────────────────────────────────

  const FABRIC_CODENAMES = [
    'Aertex','Batiste','Calico','Damask','Etamine','Flannel','Gauze',
    'Habutai','Intarsia','Jersey','Knit','Linen','Muslin','Nankeen',
    'Organza','Percale','Rinzu','Satin','Taffeta','Ultrasuede',
    'Velvet','Wadmal','Zephyr',
  ];

  function fabricForMajor(major: number): string {
    return FABRIC_CODENAMES[major - 1] ?? `v${major}`;
  }

  const CURRENT_VERSION = '1.0.0';

  router.get('/api/admin/version', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const currentMajor = parseInt(CURRENT_VERSION.split('.')[0]!, 10);
    const result: Record<string, unknown> = {
      currentVersion: CURRENT_VERSION,
      codename: fabricForMajor(currentMajor),
      repoUrl: 'https://github.com/gibyvarghese/weaveintel',
    };

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await hardenedFetch(
        'https://api.github.com/repos/gibyvarghese/weaveintel/releases/latest',
        {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'geneweave' },
          signal: ctrl.signal,
        },
        { errorTag: 'geneweave-update-check', timeoutMs: 0, maxBytes: 0 },
      );
      clearTimeout(timer);
      if (resp.ok) {
        const data = (await resp.json()) as { tag_name?: string; html_url?: string };
        const tag = (data.tag_name ?? '').replace(/^v/, '');
        if (tag) {
          const latestMajor = parseInt(tag.split('.')[0]!, 10);
          result['latestVersion'] = tag;
          result['latestCodename'] = fabricForMajor(latestMajor);
          result['updateAvailable'] = tag !== CURRENT_VERSION;
          result['releaseUrl'] = data.html_url ?? null;
        }
      }
    } catch {
      /* GitHub unreachable — just return current info */
    }

    json(res, 200, result);
  });

  router.post('/api/admin/upgrade', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if ((process.env['GENEWEAVE_ALLOW_ADMIN_UPGRADE'] ?? '').toLowerCase() !== 'true') {
      json(res, 403, { error: 'Admin upgrade endpoint is disabled. Set GENEWEAVE_ALLOW_ADMIN_UPGRADE=true to enable.' });
      return;
    }

    const { execSync } = await import('node:child_process');
    const cwd = process.cwd();

    try {
      execSync('git pull origin main', { cwd, timeout: 60_000, stdio: 'pipe' });
      execSync('npm install', { cwd, timeout: 120_000, stdio: 'pipe' });
      execSync('npx turbo build', { cwd, timeout: 180_000, stdio: 'pipe' });
      json(res, 200, { ok: true, message: 'Upgrade complete. Restart the server to apply changes.' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: 'Upgrade failed', details: msg });
    }
  }, { auth: true, csrf: true });

}
