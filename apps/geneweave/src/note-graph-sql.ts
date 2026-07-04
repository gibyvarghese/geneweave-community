// SPDX-License-Identifier: MIT
/**
 * geneWeave notes KNOWLEDGE GRAPH service (weaveNotes Phase 5).
 *
 * Connects notes into a browsable web of meaning — the Obsidian/Tana idea — by
 * combining three reusable package primitives with the existing note-link store:
 *
 *   1. `[[wiki-links]]` (`@weaveintel/notes` parseWikiLinks) → resolved to note ids →
 *      stored as `note_links` (target_kind 'note'), which gives **backlinks** for free.
 *   2. **Entities + relations** (`@weaveintel/extraction` extractKnowledgeGraph, LLM-backed)
 *      → stored per note in `note_entities` / `note_relations`.
 *   3. **Semantic "related notes"** — each note is embedded once (`note_embeddings`) and
 *      compared by cosine similarity (`@weaveintel/cache` cosineSimilarity), so we can
 *      surface connections even when there is no explicit link.
 *
 * Plus **unlinked mentions** (`@weaveintel/notes` findUnlinkedMentions): notes whose title
 * you typed without making a link — one-click candidates to wire up.
 *
 * `indexNote` re-derives all of a note's graph contribution (idempotent: it replaces
 * the note's entities/relations and re-points its auto-links). Everything is
 * owner-scoped + tenant-isolated.
 */
import { BlockDoc, pmToBlocks, blocksToMarkdown } from '@weaveintel/collab';
import { parseWikiLinks, findUnlinkedMentions, titleKey, extractPlainText, buildLinkSuggestions, linkifyFirstMention, canonicalizeEntityName, resolveEntities, chunk, type Note, type LinkSuggestion } from '@weaveintel/notes';
import { extractKnowledgeGraph } from '@weaveintel/extraction';
import { cosineSimilarity } from '@weaveintel/cache';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import { createHash } from 'node:crypto';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import type { NoteAccess } from './note-coedit-sql.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteEntityRow, NoteRelationRow, NoteEmbeddingRow } from './db-types/adapter-me.js';

type NoteGraphDb = DatabaseAdapter;

export interface IndexResult {
  ok: boolean;
  error?: string;
  /** Number of note→note wiki-links resolved + stored. */
  links: number;
  entities: number;
  relations: number;
  embedded: boolean;
}

export interface RelatedNote { noteId: string; title: string; score: number }
export interface BacklinkRef { noteId: string; title: string }
export interface GraphNode { id: string; label: string; kind: 'note' | 'entity'; type?: string }
export interface GraphEdge { source: string; target: string; label: string }

function hashOf(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

/** Render a note's current content to plain text (for wiki-links, entities, embedding). */
function noteText(note: { doc_json?: string }, ownerId: string): { text: string; markdown: string } {
  let pm: unknown = { type: 'doc', content: [] };
  try { pm = JSON.parse(note.doc_json ?? '') as unknown; } catch { /* empty */ }
  const text = extractPlainText(pm);
  let markdown = text;
  try { markdown = blocksToMarkdown(BlockDoc.fromBlocks(`u:${ownerId}`, pmToBlocks(pm)).blocks()); } catch { /* fall back to plain text */ }
  return { text, markdown };
}

export function createNoteGraphService(db: NoteGraphDb, opts: { generate?: NoteAiGenerate; now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Embed text with the active embedding model (or null if none configured). */
  async function embed(text: string, access: NoteAccess): Promise<number[] | null> {
    const model = getActiveGuardrailEmbeddingModel();
    if (!model || !text.trim()) return null;
    try {
      const ctx = weaveContext({ userId: access.ownerId, tenantId: access.tenantId ?? undefined });
      const res = await model.embed(ctx, { input: [text.slice(0, 4000)] });
      const vec = res.embeddings[0];
      return Array.isArray(vec) ? [...vec] : null;
    } catch { return null; }
  }

  /**
   * Phase 3 — embed MANY texts in ONE model call (fixes the N+1 embedding cost). Returns a vector per
   * input, aligned by index; any that fail come back as null. Empty/whitespace inputs → null (no call).
   */
  async function embedMany(texts: string[], access: NoteAccess): Promise<Array<number[] | null>> {
    const model = getActiveGuardrailEmbeddingModel();
    if (!model) return texts.map(() => null);
    const idx: number[] = []; const inputs: string[] = [];
    texts.forEach((t, i) => { if (t && t.trim()) { idx.push(i); inputs.push(t.slice(0, 4000)); } });
    const out: Array<number[] | null> = texts.map(() => null);
    if (!inputs.length) return out;
    try {
      const ctx = weaveContext({ userId: access.ownerId, tenantId: access.tenantId ?? undefined });
      const res = await model.embed(ctx, { input: inputs });
      idx.forEach((originalIndex, j) => { const v = res.embeddings[j]; if (Array.isArray(v)) out[originalIndex] = [...v]; });
    } catch { /* whole batch failed → all null (caller can fall back) */ }
    return out;
  }

  return {
    /**
     * (Re)index a note into the knowledge graph: resolve its `[[wiki-links]]` to note
     * links, extract entities/relations (LLM), and embed it for semantic search.
     */
    async indexNote(input: { noteId: string; access: NoteAccess; extractGraph?: boolean }): Promise<IndexResult> {
      const note = await db.getNote(input.noteId, input.access.ownerId) as (Note | null);
      if (!note) return { ok: false, error: 'note not found', links: 0, entities: 0, relations: 0, embedded: false };
      const { text, markdown } = noteText(note, input.access.ownerId);

      // 1. Wiki-links → resolve to note ids by title → store as note→note links (idempotent).
      const allNotes = await db.listNotes(input.access.ownerId) as Note[];
      const byTitle = new Map<string, Note>();
      for (const n of allNotes) if (n.id !== input.noteId) byTitle.set(titleKey(n.title), n);
      const existing = await db.listNoteLinks(input.noteId);
      const linkedTargetIds = new Set(existing.filter((l) => l.target_kind === 'note').map((l) => l.target_id));
      let links = 0;
      for (const wl of parseWikiLinks(markdown)) {
        const target = byTitle.get(titleKey(wl.target));
        if (!target || linkedTargetIds.has(target.id)) continue;
        await db.createNoteLink({ id: newUUIDv7(), note_id: input.noteId, target_kind: 'note', target_id: target.id });
        linkedTargetIds.add(target.id);
        links++;
      }

      // 2. Entities + relations (LLM) — only when a generator is wired + requested.
      let entities = 0, relations = 0;
      if (opts.generate && input.extractGraph !== false) {
        const g = await extractKnowledgeGraph(text, (o) => opts.generate!({ ...o, userId: input.access.ownerId, tenantId: input.access.tenantId }));
        const ts = now();
        // Phase 3 — resolve spelling variants WITHIN this note so each stored entity carries a stable
        // canonical key + best display name (the graph then groups + connects notes by canonical key).
        const resolved = resolveEntities(g.entities.map((e) => ({ name: e.name, type: e.type })));
        const canonNameByKey = new Map(resolved.map((r) => [r.key, r.name]));
        const entRows: NoteEntityRow[] = g.entities.map((e) => {
          const canonical_key = canonicalizeEntityName(e.name);
          return { id: newUUIDv7(), note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId, name: e.name, name_key: e.name.toLowerCase(), type: e.type, created_at: ts, canonical_key, canonical_name: canonNameByKey.get(canonical_key) ?? e.name };
        });
        const relRows: NoteRelationRow[] = g.relations.map((r) => ({ id: newUUIDv7(), note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId, subject: r.subject, predicate: r.predicate, object: r.object, created_at: ts }));
        await db.replaceNoteEntities(input.noteId, entRows);
        await db.replaceNoteRelations(input.noteId, relRows);
        entities = entRows.length; relations = relRows.length;
      }

      // 3. Embedding for semantic "related notes" (skip when content unchanged).
      let embedded = false;
      const ch = hashOf(`${note.title}\n${text}`);
      const prior = await db.getNoteEmbedding(input.noteId);
      if (text.trim() && (!prior || prior.content_hash !== ch)) {
        const vec = await embed(`${note.title}\n${text}`, input.access);
        if (vec) {
          await db.upsertNoteEmbedding({ note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId, dim: vec.length, embedding_json: JSON.stringify(vec), content_hash: ch, title: note.title, updated_at: now() });
          embedded = true;
        }
      } else if (prior) {
        embedded = true;
      }

      return { ok: true, links, entities, relations, embedded };
    },

    /**
     * Semantic note SEARCH for an arbitrary query (the `find_related_notes` agent tool):
     * embed the query, cosine-rank the user's note embeddings, return the best matches.
     */
    async searchNotes(owner: { userId: string; tenantId?: string | null }, query: string, topK = 5): Promise<RelatedNote[]> {
      const access: NoteAccess = { noteId: '', ownerId: owner.userId, tenantId: owner.tenantId ?? null, role: 'owner' };
      const vec = await embed(query, access);
      if (!vec) return [];
      // SECURITY: tenant-scope the candidate embeddings (null-safe) — no cross-tenant related notes.
      const all = await db.listUserNoteEmbeddings(owner.userId, owner.tenantId ?? null);
      const scored: RelatedNote[] = [];
      for (const row of all) {
        try {
          const other = JSON.parse(row.embedding_json) as number[];
          if (other.length !== vec.length) continue;
          scored.push({ noteId: row.note_id, title: row.title ?? '(untitled)', score: cosineSimilarity(vec, other) });
        } catch { /* skip */ }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.filter((s) => s.score > 0.1).slice(0, topK);
    },

    /** Notes that link TO this note (backlinks), resolved to titles. */
    async backlinks(noteId: string, userId: string): Promise<BacklinkRef[]> {
      const rows = await db.listNoteBacklinks('note', noteId);
      const out: BacklinkRef[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.note_id)) continue; seen.add(r.note_id);
        const n = await db.getNote(r.note_id, userId) as Note | null;
        if (n) out.push({ noteId: n.id, title: n.title });
      }
      return out;
    },

    /** Notes whose title this note MENTIONS in prose but hasn't `[[linked]]` yet. */
    async unlinkedMentions(noteId: string, access: NoteAccess): Promise<Array<{ noteId: string; title: string; count: number }>> {
      const note = await db.getNote(noteId, access.ownerId) as Note | null;
      if (!note) return [];
      const { text, markdown } = noteText(note, access.ownerId);
      const all = await db.listNotes(access.ownerId) as Note[];
      const candidates = all.filter((n) => n.id !== noteId && !n.is_template).map((n) => ({ id: n.id, title: n.title }));
      const linkedTitleKeys = new Set(parseWikiLinks(markdown).map((w) => titleKey(w.target)));
      const found = findUnlinkedMentions(text, candidates, { excludeIds: new Set([noteId]), linkedTitleKeys });
      return found.map((m) => ({ noteId: m.id, title: m.title, count: m.count }));
    },

    /** Semantically related notes (cosine over note embeddings), best first. */
    async relatedNotes(noteId: string, access: NoteAccess, topK = 5): Promise<RelatedNote[]> {
      // The note we are relating-from is already tenant-checked by the caller's access; gate the
      // self-embedding by tenant too so a mismatched-tenant note id can't seed a cross-tenant query.
      const self = await db.getNoteEmbedding(noteId, access.tenantId ?? null);
      let vec: number[] | null = self ? (JSON.parse(self.embedding_json) as number[]) : null;
      if (!vec) {
        const note = await db.getNote(noteId, access.ownerId) as Note | null;
        if (!note) return [];
        vec = await embed(`${note.title}\n${noteText(note, access.ownerId).text}`, access);
      }
      if (!vec) return [];
      // SECURITY: tenant-scope the candidate embeddings (null-safe) — no cross-tenant related notes.
      const all = await db.listUserNoteEmbeddings(access.ownerId, access.tenantId ?? null);
      const scored: RelatedNote[] = [];
      for (const row of all) {
        if (row.note_id === noteId) continue;
        try {
          const other = JSON.parse(row.embedding_json) as number[];
          if (other.length !== vec.length) continue;
          scored.push({ noteId: row.note_id, title: row.title ?? '(untitled)', score: cosineSimilarity(vec, other) });
        } catch { /* skip malformed */ }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.filter((s) => s.score > 0.1).slice(0, topK);
    },

    /**
     * Phase 3 — PROACTIVE link suggestions for a note: the unlinked mentions it already contains
     * (verbatim, one-click) PLUS its semantically-related notes, merged + ranked + already-linked
     * targets removed. Surfaced live as the user writes.
     */
    async linkSuggestions(noteId: string, access: NoteAccess, opts: { max?: number } = {}): Promise<LinkSuggestion[]> {
      const note = await db.getNote(noteId, access.ownerId) as Note | null;
      if (!note) return [];
      const { text, markdown } = noteText(note, access.ownerId);
      const all = await db.listNotes(access.ownerId) as Note[];
      const candidates = all.filter((n) => n.id !== noteId && !n.is_template).map((n) => ({ id: n.id, title: n.title }));
      const linkedTitleKeys = new Set(parseWikiLinks(markdown).map((w) => titleKey(w.target)));
      const mentions = findUnlinkedMentions(text, candidates, { excludeIds: new Set([noteId]), linkedTitleKeys });
      let related: RelatedNote[] = [];
      try { related = await this.relatedNotes(noteId, access, 6); } catch { /* best-effort */ }
      return buildLinkSuggestions(mentions, related.filter((r) => !linkedTitleKeys.has(titleKey(r.title))), { linkedTitleKeys, max: opts.max ?? 8 });
    },

    /**
     * Phase 3 — accept a link suggestion: surgically wrap the FIRST unlinked mention of `targetTitle`
     * inside the note's content with a `[[wiki-link]]` (lossless — only the matched text node changes),
     * re-index so the backlink appears, and record the activity. Owner-scoped.
     */
    async applyLink(noteId: string, access: NoteAccess, targetTitle: string): Promise<{ ok: boolean; error?: string; linked?: boolean }> {
      const title = (targetTitle ?? '').trim();
      if (!title) return { ok: false, error: 'targetTitle required' };
      const note = await db.getNote(noteId, access.ownerId) as (Note & { doc_json?: string }) | null;
      if (!note) return { ok: false, error: 'note not found' };
      let doc: { type?: string; content?: unknown[] };
      try { doc = JSON.parse(note.doc_json ?? '') as { type?: string; content?: unknown[] }; } catch { return { ok: false, error: 'could not read the note' }; }

      // Walk the ProseMirror tree; linkify the FIRST text node that contains a plain (unbracketed)
      // whole-phrase occurrence of the title. Only that node's text changes → lossless.
      let changed = false;
      const visit = (node: unknown): void => {
        if (changed || !node || typeof node !== 'object') return;
        const n = node as { type?: string; text?: string; content?: unknown[] };
        if (typeof n.text === 'string' && n.text) {
          const r = linkifyFirstMention(n.text, title);
          if (r.changed) { n.text = r.text; changed = true; return; }
        }
        if (Array.isArray(n.content)) for (const c of n.content) visit(c);
      };
      visit(doc);
      if (!changed) return { ok: true, linked: false }; // the mention wasn't found as plain text

      await db.updateNote(noteId, access.ownerId, { doc_json: JSON.stringify(doc) } as never);
      try { await this.indexNote({ noteId, access }); } catch { /* backlinks refresh best-effort */ }
      try { await db.recordNoteActivity?.({ id: newUUIDv7(), note_id: noteId, user_id: access.ownerId, tenant_id: access.tenantId ?? null, action: 'updated', actor: 'ai', summary: `Linked “${title}”`, detail_json: JSON.stringify({ via: 'proactive_link', target: title }), created_at: new Date(now()).toISOString() }); } catch { /* */ }
      return { ok: true, linked: true };
    },

    /**
     * Phase 3 — GraphRAG BATCHED re-index of the whole workspace: (re)embed every note whose content
     * changed since last time, in ONE model call per batch (not one per note), and optionally refresh
     * the entity graph (canonical keys) for each note. Owner-scoped; safe to run repeatedly.
     */
    async reindexWorkspace(access: NoteAccess, params: { batchSize?: number; extractGraph?: boolean } = {}): Promise<{ notes: number; embedded: number; batches: number; entities: number }> {
      const all = await db.listNotes(access.ownerId) as Note[];
      const notes = all.filter((n) => !n.is_template);
      const toEmbed: Array<{ id: string; title: string; text: string; hash: string }> = [];
      for (const listed of notes) {
        // listNotes() omits doc_json for performance — fetch the full note so noteText() has content.
        const n = await db.getNote(listed.id, access.ownerId) as Note | null;
        if (!n) continue;
        const { text } = noteText(n, access.ownerId);
        if (!text.trim()) continue;
        const hash = hashOf(`${n.title}\n${text}`);
        const prior = await db.getNoteEmbedding(n.id, access.tenantId ?? null);
        if (!prior || prior.content_hash !== hash) toEmbed.push({ id: n.id, title: n.title, text, hash });
      }
      let embedded = 0, batches = 0;
      const size = Math.max(1, Math.min(64, params.batchSize ?? 16));
      for (const group of chunk(toEmbed, size)) {
        batches++;
        const vecs = await embedMany(group.map((g) => `${g.title}\n${g.text}`), access);
        for (let i = 0; i < group.length; i++) {
          const vec = vecs[i]; const g = group[i]!;
          if (!vec) continue;
          await db.upsertNoteEmbedding({ note_id: g.id, user_id: access.ownerId, tenant_id: access.tenantId ?? null, dim: vec.length, embedding_json: JSON.stringify(vec), content_hash: g.hash, title: g.title, updated_at: now() });
          embedded++;
        }
      }
      let entities = 0;
      if (params.extractGraph && opts.generate) {
        for (const n of notes) { try { entities += (await this.indexNote({ noteId: n.id, access })).entities; } catch { /* best-effort per note */ } }
      }
      return { notes: notes.length, embedded, batches, entities };
    },

    /**
     * Phase 3 — GraphRAG retrieval: notes that share a CANONICAL entity with this one (connected
     * through the same person/org/concept even if worded differently), ranked by how many they share.
     */
    async relatedByEntities(noteId: string, access: NoteAccess, topK = 5): Promise<Array<{ noteId: string; title: string; shared: number; via: string[] }>> {
      const mine = await db.listNoteEntities(noteId);
      const myKeys = new Map<string, string>();
      for (const e of mine) { const ck = (e.canonical_key && e.canonical_key.trim()) || e.name_key; if (ck) myKeys.set(ck, (e.canonical_name && e.canonical_name.trim()) || e.name); }
      if (!myKeys.size) return [];
      const all = await db.listUserNoteEntities(access.ownerId, access.tenantId ?? null);
      const byNote = new Map<string, Set<string>>();
      for (const e of all) {
        const ck = (e.canonical_key && e.canonical_key.trim()) || e.name_key;
        if (e.note_id === noteId || !myKeys.has(ck)) continue;
        const set = byNote.get(e.note_id) ?? new Set<string>();
        set.add(ck); byNote.set(e.note_id, set);
      }
      const out: Array<{ noteId: string; title: string; shared: number; via: string[] }> = [];
      for (const [nid, keys] of byNote) {
        const n = await db.getNote(nid, access.ownerId) as Note | null;
        if (!n) continue;
        out.push({ noteId: nid, title: n.title, shared: keys.size, via: [...keys].map((k) => myKeys.get(k)!).slice(0, 5) });
      }
      out.sort((a, b) => b.shared - a.shared || a.title.localeCompare(b.title));
      return out.slice(0, topK);
    },

    /**
     * The local knowledge graph around a note: nodes = this note + linked notes +
     * extracted entities; edges = links_to / mentions / typed relations. For the UI.
     */
    async graph(noteId: string, access: NoteAccess): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
      const note = await db.getNote(noteId, access.ownerId) as Note | null;
      if (!note) return { nodes: [], edges: [] };
      const nodes = new Map<string, GraphNode>();
      const edges: GraphEdge[] = [];
      const noteNodeId = `note:${noteId}`;
      nodes.set(noteNodeId, { id: noteNodeId, label: note.title, kind: 'note' });

      // Outbound + inbound note links.
      for (const l of await db.listNoteLinks(noteId)) {
        if (l.target_kind !== 'note') continue;
        const t = await db.getNote(l.target_id, access.ownerId) as Note | null;
        if (!t) continue;
        const tid = `note:${t.id}`;
        nodes.set(tid, { id: tid, label: t.title, kind: 'note' });
        edges.push({ source: noteNodeId, target: tid, label: 'links to' });
      }
      for (const b of await db.listNoteBacklinks('note', noteId)) {
        const s = await db.getNote(b.note_id, access.ownerId) as Note | null;
        if (!s) continue;
        const sid = `note:${s.id}`;
        nodes.set(sid, { id: sid, label: s.title, kind: 'note' });
        edges.push({ source: sid, target: noteNodeId, label: 'links to' });
      }
      // Entities mentioned by this note + their typed relations. Phase 3: group by the CANONICAL key
      // (so "OpenAI"/"OpenAI, Inc." are one node) and CONNECT other notes that mention the same entity.
      const entities = await db.listNoteEntities(noteId);
      const myCanon = new Map<string, string>(); // canonical key → display label
      for (const e of entities) {
        const ck = (e.canonical_key && e.canonical_key.trim()) || e.name_key;
        const label = (e.canonical_name && e.canonical_name.trim()) || e.name;
        const eid = `entity:${ck}`;
        if (!nodes.has(eid)) nodes.set(eid, { id: eid, label, kind: 'entity', type: e.type });
        edges.push({ source: noteNodeId, target: eid, label: 'mentions' });
        myCanon.set(ck, label);
      }
      // Cross-note connectivity (the GraphRAG payoff): for each entity this note mentions, surface a few
      // OTHER notes that mention the SAME canonical entity, as note→entity edges. Tenant-scoped.
      if (myCanon.size) {
        const all = await db.listUserNoteEntities(access.ownerId, access.tenantId ?? null);
        const perEntity = new Map<string, Set<string>>();
        for (const e of all) {
          const ck = (e.canonical_key && e.canonical_key.trim()) || e.name_key;
          if (e.note_id === noteId || !myCanon.has(ck)) continue;
          const set = perEntity.get(ck) ?? new Set<string>();
          if (set.size < 4) set.add(e.note_id); // cap fan-out per entity so the graph stays readable
          perEntity.set(ck, set);
        }
        for (const [ck, noteIds] of perEntity) {
          for (const otherId of noteIds) {
            const other = await db.getNote(otherId, access.ownerId) as Note | null;
            if (!other) continue;
            const oid = `note:${other.id}`;
            if (!nodes.has(oid)) nodes.set(oid, { id: oid, label: other.title, kind: 'note' });
            edges.push({ source: oid, target: `entity:${ck}`, label: 'mentions' });
          }
        }
      }
      for (const r of await db.listNoteRelations(noteId)) {
        const sid = `entity:${r.subject.toLowerCase()}`, oid = `entity:${r.object.toLowerCase()}`;
        if (!nodes.has(sid)) nodes.set(sid, { id: sid, label: r.subject, kind: 'entity' });
        if (!nodes.has(oid)) nodes.set(oid, { id: oid, label: r.object, kind: 'entity' });
        edges.push({ source: sid, target: oid, label: r.predicate.replace(/_/g, ' ') });
      }
      return { nodes: [...nodes.values()], edges };
    },
  };
}

export type NoteGraphService = ReturnType<typeof createNoteGraphService>;
