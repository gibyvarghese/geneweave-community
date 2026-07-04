// SPDX-License-Identifier: MIT
/**
 * suggested-prompts-sql.ts — Suggested / starter prompts service (m146, Round 10).
 *
 * Ties the pure @weaveintel/collab `suggested-prompts` core (candidate assembly + dedupe + rank +
 * sanitise) to the app + database. Two read paths + a write:
 *
 *   1. getSuggestions — the INSTANT path used by the empty chat (no LLM). Reads the per-tenant policy, gathers
 *      the reader's own recent notes + chats (owner-scoped) when allowed, folds in any cached AI starters, and
 *      runs the pure `selectSuggestions` to get the final ordered list (personalised first, then curated).
 *
 *   2. agentSuggestPrompts — the AI path (the suggest_prompts tool). Feeds the reader's recent note/chat
 *      TITLES (spotlighted as data) to the LLM, parses the returned starters, and CACHES them so the empty
 *      chat can show them instantly next time. Owner-scoped: it only ever reads the caller's own activity.
 *
 *   3. logClick — records which starter was picked (a lightweight "which suggestions help" signal).
 */
import {
  selectSuggestions, buildSuggestPromptsPrompt, parseSuggestedPromptsReply,
  type SuggestedPrompt, type RecentNoteSignal, type RecentChatSignal,
} from '@weaveintel/collab';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { TenantSuggestedPromptsRow } from './db-types/adapter-me.js';

const DEFAULT_TENANT = 'default';

function defaultConfig(tenantId: string): TenantSuggestedPromptsRow {
  return { tenant_id: tenantId, enabled: 1, use_recent_notes: 1, use_recent_chats: 1, use_ai: 1, max_curated: 4, max_personalized: 3, updated_at: '' };
}

export function createSuggestedPromptsService(db: DatabaseAdapter, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  async function getConfig(tenantId: string | null): Promise<TenantSuggestedPromptsRow> {
    const id = tenantId ?? DEFAULT_TENANT;
    return (await db.getTenantSuggestedPrompts(id)) ?? defaultConfig(id);
  }

  async function updateConfig(tenantId: string | null, patch: Partial<TenantSuggestedPromptsRow>): Promise<TenantSuggestedPromptsRow> {
    const id = tenantId ?? DEFAULT_TENANT;
    const cur = await getConfig(id);
    const bit = (v: unknown, d: number) => (v === undefined ? d : (v ? 1 : 0));
    const int = (v: unknown, d: number, min: number, max: number) => {
      const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : d;
      return Math.max(min, Math.min(max, n));
    };
    const next: TenantSuggestedPromptsRow = {
      tenant_id: id,
      enabled: bit(patch.enabled, cur.enabled),
      use_recent_notes: bit(patch.use_recent_notes, cur.use_recent_notes),
      use_recent_chats: bit(patch.use_recent_chats, cur.use_recent_chats),
      use_ai: bit(patch.use_ai, cur.use_ai),
      max_curated: patch.max_curated !== undefined ? int(patch.max_curated, cur.max_curated, 0, 8) : cur.max_curated,
      max_personalized: patch.max_personalized !== undefined ? int(patch.max_personalized, cur.max_personalized, 0, 8) : cur.max_personalized,
      updated_at: '',
    };
    await db.upsertTenantSuggestedPrompts(next);
    return next;
  }

  /** Read the reader's recent notes + chats as personalisation signals (owner-scoped, bounded). */
  async function gatherSignals(userId: string, cfg: TenantSuggestedPromptsRow): Promise<{ notes: RecentNoteSignal[]; chats: RecentChatSignal[] }> {
    let notes: RecentNoteSignal[] = [];
    let chats: RecentChatSignal[] = [];
    if (cfg.use_recent_notes === 1) {
      try {
        const rows = await db.listNotes(userId, { limit: 12 });
        notes = rows.map((r) => ({ noteId: r.id, title: r.title || '', updatedAt: r.updated_at, favorite: r.favorite === 1 }));
      } catch { /* ignore */ }
    }
    if (cfg.use_recent_chats === 1) {
      try {
        const rows = await db.getUserChats(userId);
        chats = rows.slice(0, 8).map((r) => ({ chatId: r.id, title: r.title || '', updatedAt: r.updated_at }));
      } catch { /* ignore */ }
    }
    return { notes, chats };
  }

  /** The cached AI starters for this user (if allowed). */
  async function cachedAi(userId: string, cfg: TenantSuggestedPromptsRow): Promise<SuggestedPrompt[]> {
    if (cfg.use_ai !== 1) return [];
    try {
      const row = await db.getUserPromptSuggestions(userId);
      if (!row) return [];
      const arr = JSON.parse(row.prompts_json) as unknown;
      return Array.isArray(arr) ? (arr as SuggestedPrompt[]).filter((p) => p && typeof p.title === 'string' && typeof p.prompt === 'string') : [];
    } catch { return []; }
  }

  /** The INSTANT empty-chat list. Returns { enabled, prompts }. */
  async function getSuggestions(input: { userId: string; tenantId: string | null; limit?: number }): Promise<{ enabled: boolean; prompts: SuggestedPrompt[] }> {
    const cfg = await getConfig(input.tenantId);
    if (cfg.enabled !== 1) return { enabled: false, prompts: [] };
    const { notes, chats } = await gatherSignals(input.userId, cfg);
    const ai = await cachedAi(input.userId, cfg);
    const prompts = selectSuggestions({
      notes, chats, ai,
      maxCurated: cfg.max_curated,
      maxPersonalized: cfg.max_personalized,
      ...(input.limit ? { limit: input.limit } : {}),
    });
    return { enabled: true, prompts };
  }

  /** Record a click on a starter (append-only signal). */
  async function logClick(input: { userId: string; tenantId: string | null; promptId: string; title?: string; source?: string }): Promise<void> {
    const promptId = (input.promptId || '').slice(0, 200);
    if (!promptId) return;
    try {
      await db.insertPromptSuggestionEvent({
        id: newUUIDv7(), user_id: input.userId, tenant_id: input.tenantId ?? null,
        prompt_id: promptId, title: (input.title ?? '').slice(0, 200) || null, source: (input.source ?? '').slice(0, 20) || null,
        created_at: '',
      });
    } catch { /* best-effort */ }
  }

  /**
   * The suggest_prompts tool: generate fresh personalised starters from the user's recent activity via the
   * LLM, cache them, and return a summary. Owner-scoped.
   */
  async function agentSuggestPrompts(input: { userId: string; tenantId: string | null; generate: NoteAiGenerate; count?: number }): Promise<{ ok: boolean; error?: string; count: number; prompts: Array<{ title: string; prompt: string; category: string }> }> {
    const cfg = await getConfig(input.tenantId);
    if (cfg.use_ai !== 1) return { ok: false, error: 'AI-generated starters are turned off for this workspace.', count: 0, prompts: [] };
    const { notes, chats } = await gatherSignals(input.userId, cfg);
    const count = Math.max(1, Math.min(6, input.count ?? Math.max(1, cfg.max_personalized)));
    const prompt = buildSuggestPromptsPrompt({ notes, chats, count });
    let reply = '';
    try {
      reply = await input.generate({ system: prompt.system, user: prompt.user, userId: input.userId, tenantId: input.tenantId ?? null, temperature: 0.5, maxTokens: 700 });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'generation failed', count: 0, prompts: [] };
    }
    const parsed = parseSuggestedPromptsReply(reply, { max: count });
    if (!parsed.length) return { ok: false, error: 'the model returned no usable starters', count: 0, prompts: [] };

    // Re-id against a stable per-user namespace so click tracking + dedupe are consistent across refreshes.
    const stamped: SuggestedPrompt[] = parsed.map((p, i) => ({ ...p, id: `ai:${input.userId.slice(0, 8)}:${i}` }));
    try {
      await db.upsertUserPromptSuggestions({ user_id: input.userId, tenant_id: input.tenantId ?? null, prompts_json: JSON.stringify(stamped), generated_at: '' });
    } catch { /* cache is best-effort */ }
    void now;
    return { ok: true, count: stamped.length, prompts: stamped.map((p) => ({ title: p.title, prompt: p.prompt, category: p.category })) };
  }

  return { getConfig, updateConfig, getSuggestions, logClick, agentSuggestPrompts };
}

export type SuggestedPromptsService = ReturnType<typeof createSuggestedPromptsService>;

/** The suggest_prompts tool entry point (agent-callable). */
export function createSuggestPromptsTool(db: DatabaseAdapter, generate: NoteAiGenerate) {
  const svc = createSuggestedPromptsService(db);
  return {
    async suggestPrompts(args: { userId: string; tenantId?: string | null; count?: number }) {
      return svc.agentSuggestPrompts({ userId: args.userId, tenantId: args.tenantId ?? null, generate, ...(args.count ? { count: args.count } : {}) });
    },
  };
}
