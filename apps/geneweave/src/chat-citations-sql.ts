/**
 * chat-citations-sql.ts — "Cite sources" in chat (m138).
 *
 * Brings the notes "Ask your workspace" VERIFIED-citation engine to the chat surface. This is a thin
 * composition layer:
 *   • it REUSES `createNoteWorkspaceService(...).askWorkspace(...)` — the exact retrieve → cited-prompt →
 *     parse → VERIFY pipeline the notes feature already ships (so a chat citation is proven to exist in its
 *     source, character-for-character; hallucinated quotes are dropped there);
 *   • it REUSES the pure grounding helpers from `@weaveintel/notes` (answerCitationCoverage,
 *     enforceCitationStrictness) to score how well the answer is backed and to honour the admin strictness
 *     dial; and
 *   • it PERSISTS the answer as a normal chat message plus a durable `message_citations` row per verified
 *     citation, so the grounding survives a reload and the agent/audit can see exactly what was cited.
 */
import { newUUIDv7 } from './lib/uuid.js';
import { answerCitationCoverage, enforceCitationStrictness, type Citation, type CitedSource } from '@weaveintel/retrieval';
import { createNoteWorkspaceService } from './note-workspace-sql.js';
import type { DatabaseAdapter } from './db.js';
import type { MessageCitationRow, TenantChatCitationsRow } from './db-types/adapter-me.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

const VALID_SCOPES = new Set(['all', 'notes', 'runs']);

const DEFAULT_CONFIG = (tenantId: string): TenantChatCitationsRow => ({
  tenant_id: tenantId, enabled: 1, min_citations: 1, scope: 'all', max_sources: 6, updated_at: '',
});

export interface CitedChatAnswer {
  ok: boolean;
  error?: string;
  userMessageId?: string;
  messageId?: string;
  answer: string;
  citations: Citation[];
  sources: CitedSource[];
  /** Did the answer meet the workspace's grounding bar (enforceCitationStrictness)? */
  grounded: boolean;
  /** Plain reason when not grounded (e.g. "not backed by anything in your workspace"). */
  groundingNote?: string;
}

export function createChatCitationsService(db: DatabaseAdapter, opts: { aiGenerate?: NoteAiGenerate } = {}) {
  const workspace = createNoteWorkspaceService(db, opts.aiGenerate ? { aiGenerate: opts.aiGenerate } : {});

  async function getConfig(tenantId: string): Promise<TenantChatCitationsRow> {
    return (await db.getTenantChatCitations(tenantId)) ?? DEFAULT_CONFIG(tenantId);
  }

  async function updateConfig(tenantId: string, patch: Partial<TenantChatCitationsRow>): Promise<TenantChatCitationsRow> {
    const cur = await getConfig(tenantId);
    const next: TenantChatCitationsRow = {
      tenant_id: tenantId,
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
      min_citations: patch.min_citations !== undefined ? Math.max(0, Math.min(5, Math.floor(Number(patch.min_citations)) || 0)) : cur.min_citations,
      scope: typeof patch.scope === 'string' && VALID_SCOPES.has(patch.scope) ? patch.scope : cur.scope,
      max_sources: patch.max_sources !== undefined ? Math.max(1, Math.min(12, Math.floor(Number(patch.max_sources)) || 6)) : cur.max_sources,
      updated_at: '',
    };
    await db.upsertTenantChatCitations(next);
    return next;
  }

  /** Build the verified citation rows for storage from the engine's Citation[]. */
  function toRows(args: { messageId: string; chatId: string; userId: string; tenantId: string | null; citations: Citation[] }): MessageCitationRow[] {
    return args.citations.map((c) => ({
      id: newUUIDv7(), message_id: args.messageId, chat_id: args.chatId, user_id: args.userId, tenant_id: args.tenantId,
      n: c.n, source_id: c.sourceId, source_kind: c.sourceKind, source_title: c.sourceTitle,
      quote: c.quote, char_start: c.charStart, char_end: c.charEnd, created_at: '',
    }));
  }

  /**
   * Answer a question in a chat, grounded in the user's own workspace, with verified citations. Persists the
   * user turn + the assistant answer + one message_citations row per verified citation. Owner-scoping of the
   * chat is the caller's job (the route checks db.getChat first).
   */
  async function answerWithCitations(input: { userId: string; tenantId: string | null; chatId: string; question: string }): Promise<CitedChatAnswer> {
    const empty = { answer: '', citations: [] as Citation[], sources: [] as CitedSource[], grounded: false };
    const question = (input.question ?? '').trim();
    if (!question) return { ok: false, error: 'Empty question', ...empty };
    const cfg = await getConfig(input.tenantId ?? 'default');
    if (!cfg.enabled) return { ok: false, error: 'Cited answers are turned off for this workspace.', ...empty };
    if (!opts.aiGenerate) return { ok: false, error: 'No language model is configured.', ...empty };

    // Persist the user's turn first (so the transcript reads naturally even if generation fails).
    const userMessageId = newUUIDv7();
    await db.addMessage({ id: userMessageId, chatId: input.chatId, role: 'user', content: question });

    const result = await workspace.askWorkspace({
      userId: input.userId, tenantId: input.tenantId, query: question,
      scope: cfg.scope as 'all' | 'notes' | 'runs', limit: cfg.max_sources,
    });
    const coverage = answerCitationCoverage(result.answer, result.citations);
    const strict = enforceCitationStrictness(result.citations, cfg.min_citations);

    const messageId = newUUIDv7();
    await db.addMessage({
      id: messageId, chatId: input.chatId, role: 'assistant', content: result.answer,
      metadata: JSON.stringify({
        streamed: false, cited: true,
        citations: result.citations, sources: result.sources,
        grounded: strict.ok, groundingNote: strict.ok ? undefined : strict.reason,
        citationCoverage: coverage,
      }),
    });
    if (result.citations.length) {
      await db.insertMessageCitations(toRows({ messageId, chatId: input.chatId, userId: input.userId, tenantId: input.tenantId, citations: result.citations }));
    }

    return {
      ok: true, userMessageId, messageId,
      answer: result.answer, citations: result.citations, sources: result.sources,
      grounded: strict.ok, ...(strict.ok ? {} : { groundingNote: strict.reason }),
    };
  }

  /** Fetch the stored verified citations for a message (to hydrate the UI on reload). */
  async function getMessageCitations(messageId: string): Promise<Citation[]> {
    const rows = await db.listMessageCitations(messageId);
    return rows.map((r) => ({ n: r.n, sourceId: r.source_id, sourceKind: r.source_kind, sourceTitle: r.source_title, quote: r.quote, charStart: r.char_start, charEnd: r.char_end }));
  }

  /**
   * The `cite_sources` agent-tool entry point: a grounded, verified-citation answer over the user's own
   * workspace. Does NOT persist (the agent presents the result in its own reply); returns the answer, the
   * verified citations, and the sources so the assistant understands exactly which notes/chats it drew on.
   */
  async function agentCiteSources(args: { userId: string; tenantId?: string | null; question: string; limit?: number }): Promise<{ ok: boolean; error?: string; answer: string; grounded: boolean; citations: Array<{ n: number; sourceId: string; sourceKind: string; sourceTitle: string; quote: string }>; sources: Array<{ n: number; id: string; kind: string; title: string }> }> {
    if (!opts.aiGenerate) return { ok: false, error: 'No language model is configured.', answer: '', grounded: false, citations: [], sources: [] };
    const cfg = await getConfig(args.tenantId ?? 'default');
    const result = await workspace.askWorkspace({
      userId: args.userId, tenantId: args.tenantId ?? null, query: args.question,
      scope: cfg.scope as 'all' | 'notes' | 'runs', limit: args.limit ?? cfg.max_sources,
    });
    const strict = enforceCitationStrictness(result.citations, cfg.min_citations);
    return {
      ok: true, answer: result.answer, grounded: strict.ok,
      citations: result.citations.map((c) => ({ n: c.n, sourceId: c.sourceId, sourceKind: c.sourceKind, sourceTitle: c.sourceTitle, quote: c.quote })),
      sources: result.sources.map((s) => ({ n: s.n, id: s.id, kind: s.kind, title: s.title })),
    };
  }

  return { getConfig, updateConfig, answerWithCitations, getMessageCitations, agentCiteSources };
}

export type ChatCitationsService = ReturnType<typeof createChatCitationsService>;
