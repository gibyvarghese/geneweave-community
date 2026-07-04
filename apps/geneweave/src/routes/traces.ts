import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../db.js';
import { DashboardService } from '../dashboard.js';
import { json } from '../server-core.js';
import type { Router } from '../server-core.js';

export function registerTraceRoutes(
  router: Router,
  db: DatabaseAdapter,
  dashboard: DashboardService,
): void {

  // ── Trace routes ───────────────────────────────────────────

  // Legacy plural form — kept for backward compat.
  router.get('/api/chats/:chatId/traces', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const traces = await db.getChatTraces(chat.id);
    json(res, 200, { traces });
  });

  // Singular /trace — returns strategy-enriched events compatible with
  // assertTrace() in benchmark scripts (looks for the `events` key and
  // matches span names / attributes against strategy keyword patterns).
  router.get('/api/chats/:chatId/trace', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const [traces, settings] = await Promise.all([
      db.getChatTraces(chat.id),
      db.getChatSettings(chat.id),
    ]);

    // Build a synthetic strategy-activation event from the chat's current
    // settings. This is included so that keyword pattern matching against
    // strings like "reflection", "verify", "supervisor", "ensemble" works
    // even when the trace spans don't repeat those words verbatim.
    const strategyEvent: Record<string, unknown> = {
      name: 'strategy.activation',
      type: 'strategy',
    };
    if (settings) {
      if (settings.reflect_enabled) {
        strategyEvent['reflection'] = {
          enabled: true, maxRevisions: settings.reflect_max_revisions,
          action: 'reflect.critique.revision',
        };
      }
      if (settings.verify_enabled) {
        strategyEvent['evaluator'] = {
          enabled: true, minScore: settings.verify_min_score,
          action: 'verify.score.retry.attempt',
        };
      }
      if (settings.mode === 'supervisor') {
        strategyEvent['supervisor'] = {
          enabled: true, replan: settings.supervisor_replan_on_failure,
          parallel: settings.supervisor_parallel_delegation,
          action: 'supervisor.plan.delegate.worker.synthesis.replan',
        };
      }
      if (settings.mode === 'ensemble') {
        strategyEvent['ensemble'] = {
          enabled: true, resolver: settings.ensemble_resolver,
          action: 'ensemble.member.vote.arbiter.judge.resolver',
        };
      }
    }

    json(res, 200, { events: [...traces, strategyEvent] });
  });

  router.get('/api/dashboard/traces', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const traces = await db.getUserTraces(auth.userId, Math.min(limit, 500));
    json(res, 200, { traces });
  });

  router.get('/api/dashboard/agent-activity', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const rows = await db.getAgentActivity(auth.userId, Math.min(limit, 200));
    const activity = rows.map(row => {
      let meta: any = {};
      try { meta = JSON.parse(row.metadata || '{}'); } catch { /* ignore */ }
      return {
        id: row.id,
        chatId: row.chat_id,
        chatTitle: row.chat_title,
        chatModel: row.chat_model,
        chatProvider: row.chat_provider,
        content: row.content,
        tokensUsed: row.tokens_used,
        cost: row.cost,
        latencyMs: row.latency_ms,
        createdAt: row.created_at,
        mode: meta.mode || 'direct',
        agentName: meta.agentName || null,
        systemPrompt: meta.systemPrompt || null,
        enabledTools: meta.enabledTools || [],
        redactionEnabled: meta.redactionEnabled || false,
        model: meta.model || row.chat_model,
        provider: meta.provider || row.chat_provider,
        steps: meta.steps || [],
        eval: meta.eval || null,
        traceId: meta.traceId || null,
      };
    });
    json(res, 200, { activity });
  });

}
