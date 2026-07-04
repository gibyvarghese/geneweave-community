// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 5 — background memory ("second brain") service.
 *
 * As notes are created and updated, a background job quietly distils DURABLE memories from them —
 * facts, preferences, decisions, people, commitments — and stores them in the user's personal memory
 * (the SAME @weaveintel/memory store the chat assistant already recalls from, so it "understands" you
 * across notes and chats). Recall is TEMPORALLY AWARE: newer + more important + more relevant memories
 * surface first (the Generative-Agents recency × importance × relevance scoring), and memories that
 * have been superseded are excluded.
 *
 * Reuses: `@weaveintel/notes` pure helpers (buildMemoryExtractionPrompt / parseMemoryExtraction /
 * dedupeAgainstExisting / relativeWhen), `createGeneWeaveMemoryStore` (the app's MemoryStore over the
 * existing memory tables), `fusedMemorySearch` (extended here with recency + importance), and the
 * guardrail embedding model. Owner-scoped + tenant-isolated; the note is treated as untrusted data.
 */
import { newUUIDv7, weaveContext, type MemoryEntry, type MemoryStore, type MemoryQuery, type ExecutionContext } from '@weaveintel/core';
import { fusedMemorySearch } from '@weaveintel/memory';
import {
  buildMemoryExtractionPrompt, parseMemoryExtraction, memoryKey, dedupeAgainstExisting, relativeWhen,
  extractPlainText, type NoteMemory,
} from '@weaveintel/notes';
import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from './db-types/adapter.js';
import type { NoteAccess } from './note-coedit-sql.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';

/**
 * A DEDICATED, full-fidelity SQLite memory store for the note-derived "second brain". Unlike the shared
 * chat memory store (which routes through a pgvector backend that drops metadata + timestamps), this
 * reads/writes the SQLite `semantic_memory` table directly with `source='note'`, preserving createdAt +
 * importance + kind/subject/noteId provenance so recall is genuinely temporal + attributable, and so
 * "forget" actually deletes. Note memories live in their own space; the recall tool + UI read it here.
 */
function createNoteMemoryStore(db: DatabaseAdapter): MemoryStore {
  const rowToEntry = (row: { id: string; user_id: string; tenant_id?: string | null; content: string; source?: string; embedding?: string | null; metadata?: string | null; created_at?: string }): MemoryEntry => {
    let meta: Record<string, unknown> = {}; try { meta = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {}; } catch { /* */ }
    let embedding: number[] | undefined; try { embedding = row.embedding ? JSON.parse(row.embedding) as number[] : undefined; } catch { /* */ }
    return {
      id: row.id, type: 'semantic', content: row.content, metadata: meta,
      ...(embedding ? { embedding } : {}),
      createdAt: typeof meta['createdAt'] === 'string' ? meta['createdAt'] as string : (row.created_at ?? ''),
      userId: row.user_id, ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
      ...(typeof meta['importance'] === 'number' ? { importance: meta['importance'] as number } : {}),
    };
  };
  return {
    async write(_ctx: ExecutionContext, entries: MemoryEntry[]): Promise<void> {
      for (const e of entries) {
        if (!e.userId) continue;
        const meta = { ...e.metadata, ...(typeof e.importance === 'number' ? { importance: e.importance } : {}), ...(e.createdAt ? { createdAt: e.createdAt } : {}) };
        await db.saveSemanticMemory({ id: e.id, userId: e.userId, content: e.content, memoryType: 'semantic', source: 'note', ...(e.embedding ? { embedding: Array.from(e.embedding) as number[] } : {}), metadata: JSON.stringify(meta), ...(e.tenantId ? { tenantId: e.tenantId } : {}) });
      }
    },
    async query(ctx: ExecutionContext, opts: MemoryQuery): Promise<MemoryEntry[]> {
      if (opts.type && opts.type !== 'semantic') return [];
      if (opts.filter?.types && !opts.filter.types.includes('semantic')) return [];
      const userId = opts.filter?.userId ?? ctx.userId;
      if (!userId) return [];
      const limit = opts.topK ?? 20;
      let rows: Array<Parameters<typeof rowToEntry>[0]>;
      if (opts.embedding || opts.query) rows = await db.searchSemanticMemory({ userId, query: opts.query ?? '', limit, ...(opts.embedding ? { queryEmbedding: Array.from(opts.embedding) as number[] } : {}) }) as never;
      else rows = await db.listSemanticMemory(userId, limit) as never;
      return rows.filter((r) => (r.source ?? 'note') === 'note').map(rowToEntry);
    },
    async delete(ctx: ExecutionContext, ids: string[]): Promise<void> {
      const userId = ctx.userId; if (!userId) return;
      for (const id of ids) { try { await db.deleteSemanticMemory(id, userId); } catch { /* best-effort */ } }
    },
    async clear(ctx: ExecutionContext): Promise<void> { const userId = ctx.userId; if (userId) { try { await db.clearUserSemanticMemory(userId); } catch { /* */ } } },
  };
}

export interface MemoryExtractResult { ok: boolean; error?: string; added?: number; skipped?: boolean; reason?: string }
export interface RecalledMemory { id: string; content: string; kind?: string; subject?: string; importance?: number; whenLabel?: string; noteId?: string; score: number }

function hashText(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

export interface NoteMemoryConfig {
  enabled: boolean;
  importanceThreshold: number; // 0–1: only store memories at/above this salience
  maxPerNote: number;
  recallCount: number;
  decayHalfLifeDays: number;
}
const DEFAULT_CFG: NoteMemoryConfig = { enabled: true, importanceThreshold: 0.3, maxPerNote: 8, recallCount: 5, decayHalfLifeDays: 30 };

export function createNoteMemoryService(
  db: DatabaseAdapter,
  opts: { generate?: NoteAiGenerate; config?: () => Promise<Partial<NoteMemoryConfig>>; now?: () => number } = {},
) {
  const now = opts.now ?? (() => Date.now());
  const store = createNoteMemoryStore(db);
  const cfg = async (): Promise<NoteMemoryConfig> => ({ ...DEFAULT_CFG, ...(opts.config ? await opts.config() : {}) });

  async function embed(text: string, access: { ownerId: string; tenantId?: string | null }): Promise<number[] | null> {
    const model = getActiveGuardrailEmbeddingModel();
    if (!model || !text.trim()) return null;
    try {
      const ctx = weaveContext({ userId: access.ownerId, tenantId: access.tenantId ?? undefined });
      const res = await model.embed(ctx, { input: [text.slice(0, 2000)] });
      const v = res.embeddings[0];
      return Array.isArray(v) ? [...v] : null;
    } catch { return null; }
  }

  function noteText(note: { title?: string; doc_json?: string }): string {
    let body = ''; try { body = extractPlainText(JSON.parse(note.doc_json ?? '{}')); } catch { body = ''; }
    return `${note.title ?? ''}\n${body}`.trim();
  }

  return {
    /**
     * Distil durable memories from a note and store the novel ones. Idempotent per content version:
     * if the note is unchanged since the last extraction it is skipped; if it changed, the note's
     * prior memories are replaced (keeping memory in sync with the note). Owner-scoped.
     */
    async extractFromNote(input: { noteId: string; access: NoteAccess; force?: boolean }): Promise<MemoryExtractResult> {
      if (!opts.generate) return { ok: false, error: 'AI is not configured on this server' };
      const c = await cfg();
      if (!c.enabled) return { ok: false, error: 'Background memory is disabled' };
      const note = await db.getNote(input.noteId, input.access.ownerId) as { title?: string; doc_json?: string; is_template?: number } | null;
      if (!note) return { ok: false, error: 'note not found' };
      if (note.is_template) return { ok: true, skipped: true, reason: 'template' };
      const text = noteText(note);
      if (text.length < 20) return { ok: true, skipped: true, reason: 'too short' };
      const hash = hashText(text);

      const state = await db.getNoteMemoryState?.(input.noteId, input.access.ownerId);
      if (state && state.content_hash === hash && !input.force) return { ok: true, skipped: true, reason: 'unchanged' };
      // The note changed (or is new): drop its prior memories so memory stays in sync with the note.
      if (state?.memory_ids_json) {
        try { const ids = JSON.parse(state.memory_ids_json) as string[]; if (ids.length) await store.delete(weaveContext({ userId: input.access.ownerId }), ids); } catch { /* */ }
      }

      const prompt = buildMemoryExtractionPrompt({ title: note.title ?? '', text, maxChars: 8000, max: c.maxPerNote });
      let reply = '';
      try { reply = await opts.generate({ system: prompt.system, user: prompt.user, userId: input.access.ownerId, tenantId: input.access.tenantId ?? null, temperature: 0, maxTokens: 800 }); }
      catch (e) { return { ok: false, error: `extraction failed: ${(e as Error).message}` }; }
      let memories: NoteMemory[] = parseMemoryExtraction(reply).filter((m) => m.importance >= c.importanceThreshold).slice(0, c.maxPerNote);

      // Dedup against what we already know about this user (exact/normalised key).
      let existingKeys = new Set<string>();
      try {
        const existing = await store.query(weaveContext({ userId: input.access.ownerId }), { type: 'semantic', topK: 500, filter: { userId: input.access.ownerId, ...(input.access.tenantId ? { tenantId: input.access.tenantId } : {}) } });
        existingKeys = new Set(existing.map((e) => memoryKey(e.content)));
      } catch { /* best-effort */ }
      memories = dedupeAgainstExisting(memories, existingKeys);
      if (!memories.length) { await db.upsertNoteMemoryState?.({ note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId ?? null, content_hash: hash, memory_ids_json: '[]', memory_count: 0, last_extracted_at: new Date(now()).toISOString() }); return { ok: true, added: 0 }; }

      // Embed + write to the shared memory store, tagged with note provenance.
      const ts = new Date(now()).toISOString();
      const entries: MemoryEntry[] = [];
      for (const m of memories) {
        const vec = await embed(m.content, input.access);
        entries.push({
          id: newUUIDv7(), type: 'semantic', content: m.content,
          metadata: { source: 'note', noteId: input.noteId, kind: m.kind, ...(m.subject ? { subject: m.subject } : {}), importance: m.importance },
          ...(vec ? { embedding: vec } : {}),
          createdAt: ts, validAt: ts,
          userId: input.access.ownerId, ...(input.access.tenantId ? { tenantId: input.access.tenantId } : {}),
          importance: m.importance,
        });
      }
      try { await store.write(weaveContext({ userId: input.access.ownerId }), entries); }
      catch (e) { return { ok: false, error: `store write failed: ${(e as Error).message}` }; }

      await db.upsertNoteMemoryState?.({ note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId ?? null, content_hash: hash, memory_ids_json: JSON.stringify(entries.map((e) => e.id)), memory_count: entries.length, last_extracted_at: ts });
      try { await db.recordNoteActivity?.({ id: newUUIDv7(), note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId ?? null, action: 'updated', actor: 'ai', summary: `Remembered ${entries.length} thing${entries.length === 1 ? '' : 's'} from this note`, detail_json: JSON.stringify({ via: 'background_memory', count: entries.length }), created_at: ts }); } catch { /* */ }
      return { ok: true, added: entries.length };
    },

    /**
     * Temporally-aware recall: the memories most relevant to a query (or the current note), ranked by
     * relevance × recency × importance, with superseded memories excluded. The user's "second brain".
     */
    async recall(input: { userId: string; tenantId?: string | null; query: string; limit?: number }): Promise<RecalledMemory[]> {
      const c = await cfg();
      const q = (input.query ?? '').trim();
      if (!q) return [];
      const ctx = weaveContext({ userId: input.userId, tenantId: input.tenantId ?? undefined });
      const vec = await embed(q, { ownerId: input.userId, tenantId: input.tenantId ?? null });
      const results = await fusedMemorySearch(store, ctx, {
        query: q, ...(vec ? { embedding: vec } : {}), topK: input.limit ?? c.recallCount,
        userId: input.userId, ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        semanticWeight: 0.5, keywordWeight: 0.15, recencyWeight: 0.2, importanceWeight: 0.15,
        halfLifeMs: c.decayHalfLifeDays * 24 * 3600 * 1000, nowMs: now(), excludeSuperseded: true,
      });
      return results.map((r) => {
        const md = r.entry.metadata ?? {};
        const createdMs = Date.parse(r.entry.validAt ?? r.entry.createdAt ?? '');
        return {
          id: r.entry.id, content: r.entry.content, score: r.score,
          ...(typeof md['kind'] === 'string' ? { kind: md['kind'] as string } : {}),
          ...(typeof md['subject'] === 'string' ? { subject: md['subject'] as string } : {}),
          ...(typeof r.entry.importance === 'number' ? { importance: r.entry.importance } : {}),
          ...(typeof md['noteId'] === 'string' ? { noteId: md['noteId'] as string } : {}),
          ...(Number.isFinite(createdMs) ? { whenLabel: relativeWhen(createdMs, now()) } : {}),
        };
      });
    },

    /** List the user's note-derived memories (for the manage/forget UI). Newest first. */
    async list(input: { userId: string; tenantId?: string | null; limit?: number }): Promise<RecalledMemory[]> {
      const ctx = weaveContext({ userId: input.userId, tenantId: input.tenantId ?? undefined });
      let rows: MemoryEntry[] = [];
      try { rows = await store.query(ctx, { type: 'semantic', topK: input.limit ?? 100, filter: { userId: input.userId, ...(input.tenantId ? { tenantId: input.tenantId } : {}) } }); } catch { rows = []; }
      return rows
        .filter((e) => e.metadata?.['source'] === 'note')
        .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))
        .map((e) => {
          const md = e.metadata ?? {}; const createdMs = Date.parse(e.validAt ?? e.createdAt ?? '');
          return { id: e.id, content: e.content, score: 0, ...(typeof md['kind'] === 'string' ? { kind: md['kind'] as string } : {}), ...(typeof md['subject'] === 'string' ? { subject: md['subject'] as string } : {}), ...(typeof e.importance === 'number' ? { importance: e.importance } : {}), ...(typeof md['noteId'] === 'string' ? { noteId: md['noteId'] as string } : {}), ...(Number.isFinite(createdMs) ? { whenLabel: relativeWhen(createdMs, now()) } : {}) };
        });
    },

    /** Forget a memory by id (owner-scoped delete). */
    async forget(input: { userId: string; id: string }): Promise<{ ok: boolean }> {
      try { await store.delete(weaveContext({ userId: input.userId }), [input.id]); return { ok: true }; } catch { return { ok: false }; }
    },

    /** Agent-tool entry: recall what the assistant knows about a topic (for a normal chat). */
    async agentRecall(args: { userId: string; tenantId?: string | null; query: string; limit?: number }): Promise<{ ok: boolean; count: number; memories: Array<{ content: string; kind?: string; when?: string }> }> {
      const items = await this.recall({ userId: args.userId, tenantId: args.tenantId ?? null, query: args.query, ...(args.limit ? { limit: args.limit } : {}) });
      return { ok: true, count: items.length, memories: items.map((m) => ({ content: m.content, ...(m.kind ? { kind: m.kind } : {}), ...(m.whenLabel ? { when: m.whenLabel } : {}) })) };
    },

    /**
     * Background pass: extract memories from notes that changed since we last processed them. Owner +
     * tenant come from each note row. Budget-bounded (maxNotes). Called by the background job on a timer.
     */
    async runDue(maxNotes = 20): Promise<{ processed: number; added: number }> {
      const c = await cfg();
      if (!c.enabled) return { processed: 0, added: 0 };
      const pending = await db.listNotesNeedingMemoryExtraction?.(maxNotes) ?? [];
      let added = 0, processed = 0;
      for (const n of pending) {
        processed++;
        try {
          const r = await this.extractFromNote({ noteId: n.id, access: { noteId: n.id, ownerId: n.owner_user_id, tenantId: n.tenant_id ?? null, role: 'owner' } });
          if (r.ok && r.added) added += r.added;
        } catch { /* best-effort per note */ }
      }
      return { processed, added };
    },
  };
}

export type NoteMemoryService = ReturnType<typeof createNoteMemoryService>;
