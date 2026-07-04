/**
 * answer-feedback-sql.ts — the Answer feedback + AI-transparency service (m137).
 *
 * This is a thin composition layer over TWO things that already exist:
 *   1. the platform's message-feedback store + routing learning loop (recordChatFeedbackSignal), which we
 *      EXTENDED (m137) to also carry a tiered down-vote reason (`categories`) and a `tenant_id`; and
 *   2. the pure taxonomy/validation/aggregation in `@weaveintel/collab` (message-feedback), so the
 *      API route, the agent tool, and the Builder admin all read/write feedback the same safe way.
 *
 * It adds the genuinely new per-tenant AI-transparency config (label / disclosure / content warnings).
 */
import type { DatabaseAdapter } from './db.js';
import type { TenantAiTransparencyRow } from './db-types/adapter-me.js';
import {
  summarizeMessageFeedback, sanitizeFeedbackCategories, signalToRating,
  FEEDBACK_CATEGORIES, type FeedbackRow, type FeedbackCategory,
} from '@weaveintel/collab';

const DEFAULT_TRANSPARENCY = (tenantId: string): TenantAiTransparencyRow => ({
  tenant_id: tenantId, show_ai_label: 1,
  disclosure_text: 'AI-generated — may be inaccurate. Check anything important.',
  content_warnings: 1, feedback_enabled: 1, updated_at: '',
});

function parseCategories(json: string | null): FeedbackCategory[] {
  return sanitizeFeedbackCategories((() => { try { return JSON.parse(json ?? '[]'); } catch { return []; } })());
}

export function createAnswerFeedbackService(db: DatabaseAdapter) {
  /** The signed-in user's own feedback across a chat (to hydrate the thumbs state in the UI). */
  async function getMineForChat(chatId: string, userId: string): Promise<Record<string, { signal: string; categories: FeedbackCategory[]; comment: string | null }>> {
    const rows = await db.listMessageFeedback({ chatId, userId, limit: 500 });
    // Feedback rows APPEND (each vote is its own row), so a person can have several per message. Take the
    // most recent as "my current vote". created_at has second granularity, so break ties on id — the ids are
    // UUIDv7 (time-ordered), so the lexically-largest id is the newest.
    rows.sort((a, b) => (b.created_at.localeCompare(a.created_at)) || b.id.localeCompare(a.id));
    const out: Record<string, { signal: string; categories: FeedbackCategory[]; comment: string | null }> = {};
    for (const r of rows) {
      if (out[r.message_id]) continue;
      out[r.message_id] = { signal: r.signal, categories: parseCategories(r.categories), comment: r.comment };
    }
    return out;
  }

  /** Aggregate feedback for a tenant (Builder admin + the agent tool). Never returns individual users. */
  async function summarize(tenantId: string | null, limit = 1000): Promise<ReturnType<typeof summarizeMessageFeedback> & { comments: Array<{ rating: string; comment: string }> }> {
    const rows = await db.listMessageFeedback({ ...(tenantId ? { tenantId } : {}), limit });
    const fbRows: FeedbackRow[] = [];
    for (const r of rows) {
      const rating = signalToRating(r.signal);
      if (rating) fbRows.push({ rating, categories: parseCategories(r.categories) });
    }
    const summary = summarizeMessageFeedback(fbRows);
    const comments = rows.filter((r) => r.comment).slice(0, 25).map((r) => ({ rating: signalToRating(r.signal) ?? r.signal, comment: r.comment! }));
    return { ...summary, comments };
  }

  async function getTransparency(tenantId: string): Promise<TenantAiTransparencyRow> {
    return (await db.getTenantAiTransparency(tenantId)) ?? DEFAULT_TRANSPARENCY(tenantId);
  }

  async function updateTransparency(tenantId: string, patch: Partial<TenantAiTransparencyRow>): Promise<TenantAiTransparencyRow> {
    const cur = await getTransparency(tenantId);
    const next: TenantAiTransparencyRow = {
      tenant_id: tenantId,
      show_ai_label: patch.show_ai_label !== undefined ? (patch.show_ai_label ? 1 : 0) : cur.show_ai_label,
      disclosure_text: typeof patch.disclosure_text === 'string' && patch.disclosure_text.trim() ? patch.disclosure_text.trim().slice(0, 300) : cur.disclosure_text,
      content_warnings: patch.content_warnings !== undefined ? (patch.content_warnings ? 1 : 0) : cur.content_warnings,
      feedback_enabled: patch.feedback_enabled !== undefined ? (patch.feedback_enabled ? 1 : 0) : cur.feedback_enabled,
      updated_at: '',
    };
    await db.upsertTenantAiTransparency(next);
    return next;
  }

  /** Agent tool entry point — a plain-language quality read-out (aggregates only). */
  async function agentReviewFeedback(args: { tenantId: string | null; limit?: number }): Promise<{
    total: number; up: number; down: number; satisfactionPct: number | null; topReasons: Array<{ reason: string; count: number }>;
  }> {
    const s = await summarize(args.tenantId ?? null, args.limit ?? 500);
    return {
      total: s.total, up: s.up, down: s.down,
      satisfactionPct: s.satisfaction === null ? null : Math.round(s.satisfaction * 100),
      topReasons: s.topCategories.slice(0, 5).map((c) => ({ reason: c.label, count: c.count })),
    };
  }

  return { getMineForChat, summarize, getTransparency, updateTransparency, agentReviewFeedback, categories: FEEDBACK_CATEGORIES };
}

export type AnswerFeedbackService = ReturnType<typeof createAnswerFeedbackService>;
