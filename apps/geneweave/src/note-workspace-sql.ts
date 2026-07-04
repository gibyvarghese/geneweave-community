// SPDX-License-Identifier: MIT
/**
 * geneWeave WORKSPACE RAG service (weaveNotes Phase 8).
 *
 * "Chat with your workspace": ask a question and get an answer grounded in YOUR own
 * content — your notes (embedded in Phase 5's `note_embeddings`) AND your past chat runs
 * (embedded here in `run_embeddings`) — with click-to-source CITATIONS so you can verify
 * every claim. This is retrieval-augmented generation (RAG) over the personal workspace.
 *
 * How it works:
 *   1. INDEX — each chat run's text output is embedded once into `run_embeddings`
 *      (idempotent via a content hash), the run-side twin of Phase 5 note embeddings.
 *   2. SEARCH — a query is embedded; we cosine-rank notes and runs SEPARATELY, then fuse
 *      the two ranked lists with Reciprocal Rank Fusion (`@weaveintel/notes`
 *      reciprocalRankFusion) so a result strong in either corpus surfaces fairly.
 *   3. CITE — the top hits become a numbered context block (`buildCitedContext`) the model
 *      answers FROM, citing "[n]"; the UI maps "[n]" back to the real note/run.
 *
 * Reuses: the active embedding model (`getActiveGuardrailEmbeddingModel`), cosine similarity
 * (`@weaveintel/cache`), the run-access chokepoint (`resolveRunAccess`), and the pure RAG
 * helpers from `@weaveintel/notes`. Everything is owner-scoped + tenant-isolated.
 */
import { cosineSimilarity } from '@weaveintel/cache';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import { extractPlainText, type Note } from '@weaveintel/notes';
import { buildCitedContext, reciprocalRankFusion, snippetAround, buildCitedAnswerPrompt, parseCitedAnswer, verifyCitations, buildQueryExpansionPrompt, parseExpandedQueries, type RagHit, type CitedSource, type CitableSource, type Citation } from '@weaveintel/retrieval';
import { createHash } from 'node:crypto';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import { resolveRunAccess } from './shared-session-sql.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { DatabaseAdapter } from './db-types.js';

type WorkspaceDb = DatabaseAdapter;

function hashOf(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

export interface WorkspaceSearchResult {
  query: string;
  /** A numbered context block to hand the model ("[1] … [2] …"). */
  context: string;
  /** The sources behind the context, with citation numbers + snippets. */
  sources: CitedSource[];
}

/** A cited "ask your workspace" answer: prose with [n] markers + VERIFIED character-level citations. */
export interface WorkspaceAskResult {
  query: string;
  answer: string;
  /** Each citation's quote provably exists in its source (hallucinated ones are dropped). */
  citations: Citation[];
  /** The numbered sources behind the answer (for the [n] list + snippets). */
  sources: CitedSource[];
}

export function createNoteWorkspaceService(db: WorkspaceDb, opts: { now?: () => number; aiGenerate?: NoteAiGenerate } = {}) {
  const now = opts.now ?? (() => Date.now());
  const settings = createNoteSettingsService(db);

  /** Embed text with the active embedding model (or null if none configured / empty). */
  async function embed(text: string, userId: string, tenantId?: string | null): Promise<number[] | null> {
    const model = getActiveGuardrailEmbeddingModel();
    if (!model || !text.trim()) return null;
    try {
      const ctx = weaveContext({ userId, tenantId: tenantId ?? undefined });
      const res = await model.embed(ctx, { input: [text.slice(0, 4000)] });
      const vec = res.embeddings[0];
      return Array.isArray(vec) ? [...vec] : null;
    } catch { return null; }
  }

  /** Concatenate a run's streamed text output (the `text.delta` events). */
  async function runOutputText(runId: string): Promise<string> {
    const events = await db.listUserRunEvents(runId);
    let out = '';
    for (const ev of events) {
      if (ev.kind !== 'text.delta') continue;
      try { const p = JSON.parse(ev.payload) as { delta?: unknown }; if (typeof p.delta === 'string') out += p.delta; } catch { /* skip */ }
    }
    return out.trim();
  }

  /** (Re)embed a single chat run's output into `run_embeddings` (idempotent). Owner/shared only. */
  async function indexRun(input: { runId: string; userId: string; tenantId?: string | null }): Promise<{ ok: boolean; embedded: boolean; error?: string }> {
    const access = await resolveRunAccess(db, input.runId, input.userId);
    if (!access) return { ok: false, embedded: false, error: 'run not found or not accessible' };
    const text = await runOutputText(input.runId);
    if (!text) return { ok: true, embedded: false };
    const title = (text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'Chat run').replace(/^#+\s*/, '').slice(0, 80);
    const ch = hashOf(text);
    const prior = await db.getRunEmbedding(input.runId);
    if (prior && prior.content_hash === ch) return { ok: true, embedded: true };
    const vec = await embed(`${title}\n${text}`, input.userId, input.tenantId);
    if (!vec) return { ok: true, embedded: false };
    await db.upsertRunEmbedding({
      run_id: input.runId, user_id: input.userId, tenant_id: input.tenantId ?? null,
      dim: vec.length, embedding_json: JSON.stringify(vec), content_hash: ch,
      title, content: text.slice(0, 8000), updated_at: now(),
    });
    return { ok: true, embedded: true };
  }

  /** Index the user's most recent runs (best-effort convenience for "reindex my workspace"). */
  async function reindexRuns(input: { userId: string; tenantId?: string | null; limit?: number }): Promise<{ indexed: number }> {
    const runs = await db.listUserRuns(input.userId, { status: 'completed', limit: Math.min(input.limit ?? 50, 200), offset: 0 });
    let indexed = 0;
    for (const r of runs) {
      const res = await indexRun({ runId: r.id, userId: input.userId, tenantId: input.tenantId ?? null });
      if (res.embedded) indexed++;
    }
    return { indexed };
  }

  /**
   * Search the workspace (notes + runs) for a query and return a CITED context block.
   * Notes come from Phase 5 `note_embeddings`; runs from `run_embeddings`. Each corpus is
   * cosine-ranked, then the two lists are fused (RRF) into one ranking.
   */
  /**
   * Work out the query variants to retrieve with. With QUERY EXPANSION on (config) and a model
   * available, ask the model to rephrase the question several ways AND write a hypothetical answer
   * (HyDE); we embed each so a hit matching ANY phrasing — or reading like the answer — surfaces.
   * Falls back to just the original query (no extra LLM call) when expansion is off or unavailable.
   */
  async function queryVariants(query: string, userId: string, tenantId?: string | null): Promise<string[]> {
    const cfg = await settings.getConfig();
    if (!cfg.queryExpansionEnabled || !opts.aiGenerate) return [query];
    try {
      const { system, user } = buildQueryExpansionPrompt(query, { n: cfg.queryExpansionVariants });
      const reply = await opts.aiGenerate({ system, user, userId, tenantId: tenantId ?? null, temperature: 0.3, maxTokens: 400 });
      const { variants, hypothetical } = parseExpandedQueries(reply, query, { max: cfg.queryExpansionVariants });
      // The hypothetical answer (HyDE) is embedded as one more retrieval probe.
      return hypothetical ? [...variants, hypothetical] : variants;
    } catch { return [query]; }
  }

  /** Retrieve the top fused hits (notes + runs) as RagHits carrying FULL text (for citation spans). */
  async function retrieve(input: { userId: string; tenantId?: string | null; query: string; limit?: number; scope?: 'all' | 'notes' | 'runs'; expand?: boolean }): Promise<RagHit[]> {
    const scope = input.scope ?? 'all';
    const limit = Math.max(1, Math.min(input.limit ?? 6, 12));

    // Build the query variants (expansion), then embed each into a retrieval probe vector.
    const queries = input.expand === false ? [input.query] : await queryVariants(input.query, input.userId, input.tenantId);
    const qvecs = (await Promise.all(queries.map((q) => embed(q, input.userId, input.tenantId)))).filter((v): v is number[] => Array.isArray(v) && v.length > 0);
    if (qvecs.length === 0) return [];

    // SECURITY: scope embeddings to the caller's tenant (null-safe) so workspace RAG can never
    // surface another tenant's notes, even if a user id were ever shared/migrated across tenants.
    // Parse each corpus's stored vectors ONCE, then rank against every query probe.
    const noteVecs: Array<{ id: string; title: string; vec: number[] }> = [];
    if (scope !== 'runs') {
      for (const row of await db.listUserNoteEmbeddings(input.userId, input.tenantId ?? null)) {
        try { const v = JSON.parse(row.embedding_json) as number[]; noteVecs.push({ id: row.note_id, title: row.title ?? '(untitled note)', vec: v }); } catch { /* skip */ }
      }
    }
    const runVecs: Array<{ id: string; title: string; content: string; vec: number[] }> = [];
    if (scope !== 'notes') {
      for (const row of await db.listUserRunEmbeddings(input.userId, input.tenantId ?? null)) {
        try { const v = JSON.parse(row.embedding_json) as number[]; runVecs.push({ id: row.run_id, title: row.title ?? 'Chat run', content: row.content ?? '', vec: v }); } catch { /* skip */ }
      }
    }

    // Per query probe, produce a ranked id-list for notes and for runs (kept separate by prefix),
    // tracking each item's BEST cosine across probes for the materialized score. RRF then fuses all
    // 2×(#probes) lists so an item ranked highly under several phrasings rises.
    const lists: Array<Array<{ id: string }>> = [];
    const bestNote = new Map<string, { title: string; score: number }>();
    const bestRun = new Map<string, { title: string; content: string; score: number }>();
    for (const qvec of qvecs) {
      const nr = noteVecs.filter((r) => r.vec.length === qvec.length).map((r) => ({ id: r.id, title: r.title, score: cosineSimilarity(qvec, r.vec) }))
        .filter((r) => r.score > 0.1).sort((a, b) => b.score - a.score).slice(0, limit);
      const rr = runVecs.filter((r) => r.vec.length === qvec.length).map((r) => ({ id: r.id, title: r.title, content: r.content, score: cosineSimilarity(qvec, r.vec) }))
        .filter((r) => r.score > 0.1).sort((a, b) => b.score - a.score).slice(0, limit);
      if (nr.length) lists.push(nr.map((r) => ({ id: `note:${r.id}` })));
      if (rr.length) lists.push(rr.map((r) => ({ id: `run:${r.id}` })));
      for (const r of nr) { const cur = bestNote.get(r.id); if (!cur || r.score > cur.score) bestNote.set(r.id, { title: r.title, score: r.score }); }
      for (const r of rr) { const cur = bestRun.get(r.id); if (!cur || r.score > cur.score) bestRun.set(r.id, { title: r.title, content: r.content, score: r.score }); }
    }
    const fused = reciprocalRankFusion(lists).slice(0, limit);

    // Materialize each fused hit into a RagHit (fetch note text on demand; runs carry content).
    const noteById = bestNote;
    const runById = bestRun;
    const hits: RagHit[] = [];
    for (const f of fused) {
      const [kind, id] = [f.id.slice(0, f.id.indexOf(':')), f.id.slice(f.id.indexOf(':') + 1)];
      if (kind === 'note') {
        const meta = noteById.get(id);
        const note = await db.getNote(id, input.userId) as (Note | null);
        if (!note) continue;
        let text = '';
        try { text = extractPlainText(JSON.parse(note.doc_json ?? '') as unknown); } catch { /* */ }
        hits.push({ id, kind: 'note', title: note.title || meta?.title || '(untitled note)', content: text, score: meta?.score ?? 0 });
      } else {
        const meta = runById.get(id);
        if (!meta) continue;
        hits.push({ id, kind: 'run', title: meta.title, content: meta.content, score: meta.score });
      }
    }

    return hits;
  }

  /** The numbered cited-context block + sources (the model answers FROM this and cites with "[n]"). */
  async function workspaceSearch(input: { userId: string; tenantId?: string | null; query: string; limit?: number; scope?: 'all' | 'notes' | 'runs' }): Promise<WorkspaceSearchResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 6, 12));
    const hits = await retrieve(input);
    const { context, sources } = buildCitedContext(hits, input.query, { maxSources: limit });
    return { query: input.query, context, sources };
  }

  /**
   * Phase 2 — "Ask your workspace" with VERIFIED character-level citations. Retrieves the top sources,
   * asks the model to answer FROM them and quote VERBATIM per claim, then VERIFIES every quote actually
   * appears in its source (dropping invented ones — the anti-hallucination control). The UI highlights
   * each verified quote in the source note on click. Returns an empty answer if no model / no sources.
   */
  async function askWorkspace(input: { userId: string; tenantId?: string | null; query: string; limit?: number; scope?: 'all' | 'notes' | 'runs' }): Promise<WorkspaceAskResult> {
    if (!opts.aiGenerate) return { query: input.query, answer: '', citations: [], sources: [] };
    const limit = Math.max(1, Math.min(input.limit ?? 6, 8));
    const hits = await retrieve(input);
    const { sources } = buildCitedContext(hits, input.query, { maxSources: limit });
    if (hits.length === 0) return { query: input.query, answer: 'I could not find anything about that in your notes or past chats.', citations: [], sources: [] };

    // Build the citable sources (numbered, with FULL text the model may quote + we verify against).
    const citables: CitableSource[] = hits.slice(0, limit).map((h, i) => ({ n: i + 1, id: h.id, kind: h.kind, title: h.title || '(untitled)', content: h.content }));
    const { system, user } = buildCitedAnswerPrompt(input.query, citables);
    const reply = await opts.aiGenerate({ system, user, userId: input.userId, tenantId: input.tenantId ?? null, temperature: 0.2, maxTokens: 1200 });
    const parsed = parseCitedAnswer(reply);
    const citations = verifyCitations(parsed.citations, citables); // hallucinated quotes dropped here
    return { query: input.query, answer: parsed.answer, citations, sources };
  }

  /**
   * The `workspace_search` agent-tool entry point: returns the numbered context + sources so
   * the model answers FROM the user's own content and cites with "[n]".
   */
  async function agentWorkspaceSearch(args: { userId: string; tenantId?: string | null; query: string; limit?: number }): Promise<{ ok: boolean; query: string; context: string; sources: Array<{ n: number; id: string; kind: string; title: string }> }> {
    const r = await workspaceSearch({ userId: args.userId, tenantId: args.tenantId ?? null, query: args.query, ...(args.limit ? { limit: args.limit } : {}) });
    return { ok: true, query: r.query, context: r.context, sources: r.sources.map((s) => ({ n: s.n, id: s.id, kind: s.kind, title: s.title })) };
  }

  return { indexRun, reindexRuns, workspaceSearch, askWorkspace, agentWorkspaceSearch, _snippetAround: snippetAround };
}

export type NoteWorkspaceService = ReturnType<typeof createNoteWorkspaceService>;
