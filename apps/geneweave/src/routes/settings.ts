import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { resolveLimits } from '../platform-limits.js';

export function registerSettingsRoutes(
  router: Router,
  db: DatabaseAdapter,
): void {

  // ── User preferences routes ────────────────────────────────

  router.get('/api/user/preferences', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prefs = await db.getUserPreferences(auth.userId);
    json(res, 200, { preferences: prefs ?? { default_mode: 'direct', theme: 'light', show_process_card: 1 } });
  });

  router.post('/api/user/preferences', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const mode = (body['default_mode'] as string) || 'direct';
    const theme = (body['theme'] as string) || 'light';
    const rawShow = body['show_process_card'];
    const showProcessCard = rawShow === undefined ? true : Boolean(rawShow);
    if (!['direct', 'agent', 'supervisor'].includes(mode)) {
      json(res, 400, { error: 'default_mode must be "direct", "agent", or "supervisor"' }); return;
    }
    if (!['light', 'dark'].includes(theme)) {
      json(res, 400, { error: 'theme must be "light" or "dark"' }); return;
    }
    await db.saveUserPreferences(auth.userId, mode, theme, showProcessCard);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Chat settings routes ───────────────────────────────────

  router.get('/api/chats/:chatId/settings', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const settings = await db.getChatSettings(chat.id);
    json(res, 200, {
      settings: settings ?? { chat_id: chat.id, mode: 'direct', system_prompt: null, timezone: null, enabled_tools: null, redaction_enabled: 0, redaction_patterns: null, workers: null },
    });
  });

  router.post('/api/chats/:chatId/settings', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const mode = (body['mode'] as string) || 'direct';
    if (!['direct', 'agent', 'supervisor', 'ensemble'].includes(mode)) {
      json(res, 400, { error: 'mode must be "direct", "agent", "supervisor", or "ensemble"' }); return;
    }

    // Apply tool policy: if enabledTools is a non-empty explicit array, use it.
    // Empty array [] or null/undefined means "use mode defaults" — this handles the
    // case where the UI auto-saves settings on chat creation before the user has
    // configured anything (createChat in api.ts sends enabledTools:[] from defaults).
    const toolPolicy = (() => {
      const explicit = body['enabledTools'];
      if (Array.isArray(explicit) && explicit.length > 0) {
        return explicit;
      }
      const DEFAULT_TOOLS: Record<string, string[]> = {
        direct: [],
        agent: ['emit_artifact', 'datetime', 'timezone_info', 'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list', 'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'reminder_create', 'reminder_list', 'reminder_cancel', 'calculator', 'json_format', 'text_analysis', 'memory_recall', 'memory_search', 'memory_remember', 'memory_forget', 'memory_list_entities', 'memory_list_episodes', 'memory_get_profile', 'web_search', 'cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'browser_open', 'browser_close', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_select', 'browser_type', 'browser_hover', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_detect_auth', 'browser_login', 'browser_save_cookies', 'browser_handoff_request', 'browser_handoff_resume'],
        supervisor: ['emit_artifact', 'datetime', 'timezone_info', 'calculator', 'json_format', 'text_analysis'],
      };
      return DEFAULT_TOOLS[mode] ?? [];
    })();

    const rawSystemPrompt = typeof body['systemPrompt'] === 'string' ? body['systemPrompt'] : undefined;
    if (rawSystemPrompt !== undefined) {
      const limits = await resolveLimits(db);
      if (rawSystemPrompt.length > limits.system_prompt_max_chars) {
        json(res, 400, { error: `systemPrompt exceeds maximum allowed length of ${limits.system_prompt_max_chars} characters` }); return;
      }
    }

    await db.saveChatSettings({
      chatId: chat.id,
      mode,
      systemPrompt: rawSystemPrompt,
      timezone: (body['timezone'] as string) ?? undefined,
      enabledTools: JSON.stringify(toolPolicy),
      redactionEnabled: !!body['redactionEnabled'],
      redactionPatterns: body['redactionPatterns'] ? JSON.stringify(body['redactionPatterns']) : undefined,
      workers: body['workers'] ? JSON.stringify(body['workers']) : undefined,
      // W1 — reflection
      reflectEnabled: body['reflectEnabled'] != null ? !!body['reflectEnabled'] : undefined,
      reflectMaxRevisions: body['reflectMaxRevisions'] != null ? Number(body['reflectMaxRevisions']) : undefined,
      reflectCriteria: (body['reflectCriteria'] as string) ?? undefined,
      // W2 — verify
      verifyEnabled: body['verifyEnabled'] != null ? !!body['verifyEnabled'] : undefined,
      verifyMinScore: body['verifyMinScore'] != null ? Number(body['verifyMinScore']) : undefined,
      verifyMaxAttempts: body['verifyMaxAttempts'] != null ? Number(body['verifyMaxAttempts']) : undefined,
      // W3 — supervisor
      supervisorReplanOnFailure: body['supervisorReplanOnFailure'] != null ? !!body['supervisorReplanOnFailure'] : undefined,
      supervisorParallelDelegation: body['supervisorParallelDelegation'] != null ? !!body['supervisorParallelDelegation'] : undefined,
      // W5 — ensemble
      ensembleAgents: body['ensembleAgents'] ? JSON.stringify(body['ensembleAgents']) : undefined,
      ensembleResolver: (body['ensembleResolver'] as string) ?? undefined,
      // Reasoning request (m92) — applies only to reasoning-capable models.
      reasoningEnabled: body['reasoningEnabled'] != null ? !!body['reasoningEnabled'] : undefined,
      reasoningEffort: ['low', 'medium', 'high'].includes(String(body['reasoningEffort'])) ? String(body['reasoningEffort']) : undefined,
      reasoningBudgetTokens: body['reasoningBudgetTokens'] != null ? Math.max(0, Math.min(60000, Math.trunc(Number(body['reasoningBudgetTokens'])))) : undefined,
    });

    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── User memory routes — users manage their own memory ────

  // GET /api/user/memory — returns all memory types for the authenticated user
  router.get('/api/user/memory', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '50', 10));
    const [entities, semantic, episodic, procedural, working] = await Promise.all([
      db.listEntities(auth.userId),
      db.listSemanticMemory(auth.userId, limit),
      db.listEpisodicMemory(auth.userId, limit),
      db.listProceduralMemory(auth.userId),
      db.listWorkingMemorySnapshots(auth.userId, Math.min(20, limit)),
    ]);
    json(res, 200, {
      entities: entities.map((e) => ({
        id: e.id,
        entityName: e.entity_name,
        entityType: e.entity_type,
        facts: (() => { try { return JSON.parse(e.facts) as Record<string, unknown>; } catch { return {}; } })(),
        confidence: e.confidence,
        source: e.source,
        updatedAt: e.updated_at,
      })),
      semantic: semantic.map((m) => ({
        id: m.id,
        content: m.content,
        memoryType: m.memory_type,
        source: m.source,
        createdAt: m.created_at,
      })),
      episodic: episodic.map((ep) => ({
        id: ep.id,
        messageRole: ep.message_role,
        content: ep.content,
        importance: ep.importance,
        tags: (() => { try { return ep.tags ? JSON.parse(ep.tags) as string[] : []; } catch { return []; } })(),
        consolidated: ep.consolidated === 1,
        createdAt: ep.created_at,
      })),
      procedural: procedural.map((p) => ({
        id: p.id,
        agentId: p.agent_id,
        instructionDelta: p.instruction_delta,
        status: p.status,
        confidence: p.confidence,
        proposedBy: p.proposed_by,
        appliedAt: p.applied_at,
        createdAt: p.created_at,
      })),
      working: working.map((w) => ({
        id: w.id,
        chatId: w.chat_id,
        agentId: w.agent_id,
        content: (() => { try { return JSON.parse(w.content) as Record<string, unknown>; } catch { return {}; } })(),
        savedAt: w.created_at,
      })),
    });
  });

  // DELETE /api/user/memory/semantic/:id — user deletes a single semantic memory
  router.del('/api/user/memory/semantic/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSemanticMemory(params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // DELETE /api/user/memory/entity/:entityName — user forgets an entity
  router.del('/api/user/memory/entity/:entityName', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteEntity(auth.userId, decodeURIComponent(params['entityName']!));
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // DELETE /api/user/memory/episodic/:id — user removes an episodic event
  router.del('/api/user/memory/episodic/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteEpisodicMemory(params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // DELETE /api/user/memory/working/:id — user deletes a working memory snapshot
  router.del('/api/user/memory/working/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWorkingMemorySnapshot(params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // DELETE /api/user/memory/all — full memory wipe (all types) for the user
  router.del('/api/user/memory/all', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await Promise.all([
      db.clearUserSemanticMemory(auth.userId),
      db.clearUserEntityMemory(auth.userId),
      db.clearUserEpisodicMemory(auth.userId),
      db.clearUserWorkingMemory(auth.userId),
    ]);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

}
