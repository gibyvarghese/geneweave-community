/**
 * answer-versions-sql.ts — Regenerate an assistant answer, keeping version history (m139).
 *
 * Reuses the pure variant model in `@weaveintel/collab` (makeVariantStack / addVariant / selectVariant
 * / variantLabel) so the "stack of answers with an active pointer" logic is shared + unit-tested, and reuses
 * the platform's EXISTING routing quality signal (recordChatFeedbackSignal, signal='regenerate') so a
 * regenerate already teaches the model-routing loop that the reader wasn't satisfied.
 *
 * Persistence model: `messages` always holds the ACTIVE answer (so the normal transcript, search, export and
 * RAG are unchanged), while `message_variants` is the append-only history for that turn, anchored by
 * `group_id = the assistant message id`. Switching versions just re-points the messages row at a stored
 * variant — nothing is ever lost.
 */
import { newUUIDv7 } from './lib/uuid.js';
import {
  makeVariantStack, addVariant, selectVariant as selectInStack, variantLabel,
  type AnswerVariant,
} from '@weaveintel/collab';
import { recordChatFeedbackSignal } from './routing-feedback.js';
import type { DatabaseAdapter } from './db.js';
import type { MessageVariantRow, TenantAnswerVersionsRow } from './db-types/adapter-me.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

const DEFAULT_CONFIG = (tenantId: string): TenantAnswerVersionsRow => ({ tenant_id: tenantId, enabled: 1, max_variants: 5, updated_at: '' });

export interface VariantView { id: string; content: string; model: string | null; provider: string | null; reason: string | null }
export interface VersionsResult { ok: boolean; error?: string; messageId?: string; content?: string; variants: VariantView[]; activeIndex: number; label: { index: number; total: number; text: string; show: boolean } }

function metaOf(row: { metadata?: string | null } | undefined): Record<string, unknown> {
  try { return row?.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {}; } catch { return {}; }
}

export function createAnswerVersionsService(db: DatabaseAdapter, opts: { aiGenerate?: NoteAiGenerate } = {}) {
  async function getConfig(tenantId: string): Promise<TenantAnswerVersionsRow> {
    return (await db.getTenantAnswerVersions(tenantId)) ?? DEFAULT_CONFIG(tenantId);
  }
  async function updateConfig(tenantId: string, patch: Partial<TenantAnswerVersionsRow>): Promise<TenantAnswerVersionsRow> {
    const cur = await getConfig(tenantId);
    const next: TenantAnswerVersionsRow = {
      tenant_id: tenantId,
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
      max_variants: patch.max_variants !== undefined ? Math.max(2, Math.min(10, Math.floor(Number(patch.max_variants)) || 5)) : cur.max_variants,
      updated_at: '',
    };
    await db.upsertTenantAnswerVersions(next);
    return next;
  }

  function toView(r: MessageVariantRow): VariantView { return { id: r.id, content: r.content, model: r.model, provider: r.provider, reason: r.reason }; }

  /** Load the variant stack for a message (capped to the newest `max`), plus the active pointer. */
  async function loadStack(messageId: string, activeVariantId: string | null, max: number): Promise<{ views: VariantView[]; activeIndex: number }> {
    let rows = await db.listMessageVariants(messageId);
    if (rows.length > max) rows = rows.slice(rows.length - max); // keep the newest `max` (never lose the active — it's always newest or explicitly kept)
    const views = rows.map(toView);
    let activeIndex = views.findIndex((v) => v.id === activeVariantId);
    if (activeIndex < 0) activeIndex = views.length - 1;
    return { views, activeIndex };
  }

  function result(messageId: string, views: VariantView[], activeIndex: number): VersionsResult {
    const stack = makeVariantStack(views as AnswerVariant[], activeIndex);
    const label = variantLabel(stack);
    return { ok: true, messageId, content: views[activeIndex]?.content ?? '', variants: views, activeIndex, label: { index: label.index, total: label.total, text: label.text, show: label.show } };
  }

  /** List the stored versions for an assistant message (to hydrate the pager on load). `currentMeta` is the
   * owner-checked message's parsed metadata (holds which version is active). */
  async function listVersions(messageId: string, tenantId: string | null, currentMeta: Record<string, unknown>): Promise<VersionsResult> {
    const cfg = await getConfig(tenantId ?? 'default');
    const { views, activeIndex } = await loadStack(messageId, (currentMeta['variantActiveId'] as string) ?? null, cfg.max_variants);
    return result(messageId, views, activeIndex);
  }

  /**
   * Regenerate the answer for `messageId`: seed the original as version 1 (once), generate a fresh
   * alternative from the conversation so far, append it as the newest version + make it active.
   * `history` is the owner-checked transcript (oldest→newest) up to and INCLUDING the target assistant message.
   */
  async function regenerate(input: {
    userId: string; tenantId: string | null; chatId: string; messageId: string;
    history: Array<{ id: string; role: string; content: string; metadata?: string | null }>;
  }): Promise<VersionsResult> {
    const empty = { variants: [] as VariantView[], activeIndex: 0, label: { index: 0, total: 0, text: '', show: false } };
    if (!opts.aiGenerate) return { ok: false, error: 'No language model is configured.', ...empty };
    const cfg = await getConfig(input.tenantId ?? 'default');
    if (!cfg.enabled) return { ok: false, error: 'Regenerate is turned off for this workspace.', ...empty };

    const idx = input.history.findIndex((m) => m.id === input.messageId);
    const target = idx >= 0 ? input.history[idx]! : undefined;
    if (!target || target.role !== 'assistant') return { ok: false, error: 'Can only regenerate an assistant answer.', ...empty };

    // Seed the original version once, so history is complete the first time you regenerate.
    const existing = await db.listMessageVariants(input.messageId);
    const tMeta = metaOf(target);
    const seedRows: MessageVariantRow[] = [];
    if (existing.length === 0) {
      seedRows.push({ id: newUUIDv7(), group_id: input.messageId, chat_id: input.chatId, user_id: input.userId, tenant_id: input.tenantId, variant_index: 0, content: target.content, model: (tMeta['model'] as string) ?? null, provider: (tMeta['provider'] as string) ?? null, reason: 'original', created_at: '' });
    }

    // Build the conversation prompt from everything BEFORE the target answer.
    const priabout = input.history.slice(0, idx);
    const convo = priabout.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
    const system = 'You are geneWeave, a helpful AI assistant. Below is a conversation. Write a fresh, high-quality ALTERNATIVE to your most recent reply to the user\'s last message — a genuinely different take (different structure, emphasis, or wording) while staying correct and on-topic. Do not mention that this is a regeneration. Reply with ONLY the assistant message text.';
    const user = `${convo}\n\nYour previous reply (do NOT repeat it verbatim):\n${target.content}\n\nNow write your alternative reply:`;
    let fresh = '';
    try { fresh = (await opts.aiGenerate({ system, user, userId: input.userId, tenantId: input.tenantId, temperature: 0.9, maxTokens: 1200 })).trim(); } catch { fresh = ''; }
    if (!fresh) return { ok: false, error: 'Could not generate an alternative answer. Please try again.', ...empty };

    const nextIndex = (existing[existing.length - 1]?.variant_index ?? (seedRows.length - 1)) + 1;
    const model = (tMeta['model'] as string) ?? null;
    const provider = (tMeta['provider'] as string) ?? null;
    const newRow: MessageVariantRow = { id: newUUIDv7(), group_id: input.messageId, chat_id: input.chatId, user_id: input.userId, tenant_id: input.tenantId, variant_index: nextIndex, content: fresh, model, provider, reason: 'regenerate', created_at: '' };
    await db.insertMessageVariants([...seedRows, newRow]);

    // Point the live message at the new version + record which version is active in its metadata.
    const newMeta = { ...tMeta, regenerated: true, variantActiveId: newRow.id };
    await db.updateMessageContent(input.messageId, fresh, JSON.stringify(newMeta));

    // Feed the EXISTING routing quality signal — the reader asked again, a soft-negative on the prior answer.
    try {
      const taskKey = (tMeta['taskKey'] as string) || (tMeta['task_key'] as string) || null;
      await recordChatFeedbackSignal(db, { signal: 'regenerate', messageId: input.messageId, chatId: input.chatId, userId: input.userId, tenantId: input.tenantId, modelId: model, provider, taskKey });
    } catch { /* signal is additive */ }

    const { views, activeIndex } = await loadStack(input.messageId, newRow.id, cfg.max_variants);
    return result(input.messageId, views, activeIndex);
  }

  /** Switch the shown answer to version `index`, lossless — re-points the live message at that stored variant. */
  async function selectVariant(input: { userId: string; tenantId: string | null; chatId: string; messageId: string; index: number; currentMeta: Record<string, unknown> }): Promise<VersionsResult> {
    const empty = { variants: [] as VariantView[], activeIndex: 0, label: { index: 0, total: 0, text: '', show: false } };
    const cfg = await getConfig(input.tenantId ?? 'default');
    const { views } = await loadStack(input.messageId, null, cfg.max_variants);
    if (!views.length) return { ok: false, error: 'No versions to select.', ...empty };
    const stack = selectInStack(makeVariantStack(views as AnswerVariant[], views.length - 1), input.index);
    const chosen = views[stack.activeIndex]!;
    const newMeta = { ...input.currentMeta, variantActiveId: chosen.id };
    await db.updateMessageContent(input.messageId, chosen.content, JSON.stringify(newMeta));
    return result(input.messageId, views, stack.activeIndex);
  }

  return { getConfig, updateConfig, listVersions, regenerate, selectVariant };
}

export type AnswerVersionsService = ReturnType<typeof createAnswerVersionsService>;
