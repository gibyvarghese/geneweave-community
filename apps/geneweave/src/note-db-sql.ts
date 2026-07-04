// SPDX-License-Identifier: MIT
/**
 * geneWeave note DATABASE service (weaveNotes Phase 6) — Notion-style tables with typed
 * properties, relations + rollups, multiple views, and AI column AUTO-FILL with citations.
 *
 * Reuses the pure model from `@weaveintel/notes` (parseSchema / coerceValue / validateRow /
 * computeRollup / VIEW_TYPES) and the AI primitive from `@weaveintel/extraction`
 * (autofillProperty). The database SCHEMA lives in `note_databases.columns_json` (a
 * `PropertyDef[]`); row values live in `note_db_rows.fields_json`; AI-filled cells also
 * record their citations under a reserved `_citations` key, so a human can verify what the
 * AI used instead of trusting it blindly (the mid-2026 best practice for AI auto-fill).
 *
 * Auto-fill gathers each row's context from three places — the PAGE (the row's own fields),
 * the WORKSPACE (related rows via the database's relations), and the WEB (a best-effort
 * `@weaveintel/tools/search` query) — labels every source, asks the model to fill the column
 * AND cite which sources it used, then coerces the value to the column type.
 *
 * Databases are owner-scoped (the existing `getNoteDatabase(id, userId)` gate).
 */
import { parseSchema, coerceValue, computeRollup, isViewType, type PropertyDef, type DatabaseViewType } from '@weaveintel/notes';
import { autofillProperty, type AutofillRow } from '@weaveintel/extraction';
import { createSearchRouter, type SearchProviderConfig } from '@weaveintel/tools/search';
import { redactText } from '@weaveintel/artifacts';
import { newUUIDv7 } from '@weaveintel/core';
import { createNoteSettingsService } from './note-settings-sql.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteDbRowRow } from './db-types/adapter-agenda-notes.js';

type NoteDbServiceDb = DatabaseAdapter;

const CITATIONS_KEY = '_citations';
const MAX_RELATED_PER_PROP = 5; // bound the related-row context fed into auto-fill

/**
 * Make an outbound web-search query PII-safe: scrub personal data (emails, phones, card/SSN-like
 * numbers) via the shared DLP redactor, drop the resulting `[REDACTED-…]` placeholders (they add no
 * search value), and report whether enough real signal remains to be worth searching. So a row's
 * personal data never leaves to the external search engine.
 */
export function piiSafeWebQuery(raw: string): { query: string; hadPii: boolean; usable: boolean } {
  const { text, redactions } = redactText(raw ?? '', 'pii');
  const cleaned = text.replace(/\[REDACTED-[A-Z-]+\]/g, ' ').replace(/\s+/g, ' ').trim();
  const usable = cleaned.replace(/[^A-Za-z0-9]/g, '').length >= 3;
  return { query: cleaned, hadPii: redactions > 0, usable };
}

export interface ViewRow { id: string; fields: Record<string, unknown>; rollups: Record<string, unknown>; citations: Record<string, Array<{ label: string; url?: string }>> }
export interface DatabaseView { id: string; name: string; viewType: DatabaseViewType; schema: PropertyDef[]; rows: ViewRow[] }

/** Parse a row's stored fields, splitting out the reserved citations map. */
function readRow(row: NoteDbRowRow): { fields: Record<string, unknown>; citations: Record<string, Array<{ label: string; url?: string }>> } {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(row.fields_json) as Record<string, unknown>; } catch { /* empty */ }
  const citations = (parsed[CITATIONS_KEY] && typeof parsed[CITATIONS_KEY] === 'object' ? parsed[CITATIONS_KEY] : {}) as Record<string, Array<{ label: string; url?: string }>>;
  const fields = { ...parsed }; delete fields[CITATIONS_KEY];
  return { fields, citations };
}

/** Build a best-effort web-search router (DuckDuckGo needs no key; Tavily/Brave if configured). */
function searchRouter() {
  const configs: Record<string, SearchProviderConfig> = {
    duckduckgo: { name: 'duckduckgo', enabled: process.env['SEARCH_DUCKDUCKGO_ENABLED'] !== '0', priority: 50 },
  };
  const tavily = process.env['TAVILY_API_KEY'];
  if (tavily) configs['tavily'] = { name: 'tavily', enabled: true, apiKey: tavily, priority: 30 };
  const brave = process.env['BRAVE_SEARCH_API_KEY'] ?? process.env['BRAVE_API_KEY'];
  if (brave) configs['brave'] = { name: 'brave', enabled: true, apiKey: brave, priority: 40 };
  return createSearchRouter({ configs, fallback: true });
}

export function createNoteDbService(db: NoteDbServiceDb, opts: { generate?: NoteAiGenerate } = {}) {
  const settings = createNoteSettingsService(db);
  /** A render-ready view: schema + rows with computed rollups + citations. */
  async function view(databaseId: string, userId: string): Promise<DatabaseView | null> {
    const dbRow = await db.getNoteDatabase(databaseId, userId);
    if (!dbRow) return null;
    const schema = parseSchema(dbRow.columns_json);
    const rows = await db.listNoteDbRows(databaseId);

    // Pre-load related databases' rows so rollups can aggregate across relations.
    const relatedCache = new Map<string, NoteDbRowRow[]>();
    for (const p of schema) {
      if (p.type === 'relation' && p.relationDatabaseId && !relatedCache.has(p.relationDatabaseId)) {
        relatedCache.set(p.relationDatabaseId, await db.listNoteDbRows(p.relationDatabaseId));
      }
    }

    const viewRows: ViewRow[] = rows.map((r) => {
      const { fields, citations } = readRow(r);
      const rollups: Record<string, unknown> = {};
      for (const p of schema) {
        if (p.type !== 'rollup' || !p.rollup) continue;
        const relProp = schema.find((x) => x.key === p.rollup!.relationKey && x.type === 'relation');
        if (!relProp?.relationDatabaseId) { rollups[p.key] = null; continue; }
        const relatedIds = new Set((Array.isArray(fields[relProp.key]) ? fields[relProp.key] : []) as string[]);
        const relatedRows = (relatedCache.get(relProp.relationDatabaseId) ?? []).filter((rr) => relatedIds.has(rr.id)).map((rr) => readRow(rr).fields);
        rollups[p.key] = computeRollup(p.rollup, relatedRows);
      }
      return { id: r.id, fields, rollups, citations };
    });

    return { id: dbRow.id, name: dbRow.name, viewType: (isViewType(dbRow.view_type) ? dbRow.view_type : 'table'), schema, rows: viewRows };
  }

  /** Best-effort web search → labelled source snippets. */
  async function webSources(query: string, limit = 3): Promise<Array<{ id: string; label: string; url: string; text: string }>> {
    try {
      const res = await searchRouter().search({ query, limit });
      return res.results.slice(0, limit).map((r, i) => ({ id: `web:${i + 1}`, label: r.title, url: r.url, text: `${r.title}. ${r.snippet}` }));
    } catch { return []; }
  }

  /**
   * AI-fill a column for some/all rows. For each row, gather context (the row's own fields =
   * the PAGE, related rows = the WORKSPACE, and — when `useWeb` — web snippets), ask the model
   * to fill the column with citations, coerce the value to the column type, and persist it
   * (value in `fields_json`, citations under `_citations`). Returns the filled cells.
   */
  async function autofillColumn(input: { databaseId: string; userId: string; tenantId?: string | null; propertyKey: string; rowIds?: string[]; useWeb?: boolean }): Promise<{ ok: boolean; error?: string; code?: number; filled?: Array<{ rowId: string; value: unknown; citations: Array<{ label: string; url?: string }> }> }> {
    if (!opts.generate) return { ok: false, code: 501, error: 'AI features are not configured' };
    const dbRow = await db.getNoteDatabase(input.databaseId, input.userId);
    if (!dbRow) return { ok: false, code: 404, error: 'database not found' };
    const schema = parseSchema(dbRow.columns_json);
    const prop = schema.find((p) => p.key === input.propertyKey);
    if (!prop) return { ok: false, code: 400, error: `unknown property '${input.propertyKey}'` };
    if (prop.type === 'rollup' || prop.type === 'relation') return { ok: false, code: 400, error: `cannot auto-fill a ${prop.type} column` };

    let rows = await db.listNoteDbRows(input.databaseId);
    if (input.rowIds?.length) { const want = new Set(input.rowIds); rows = rows.filter((r) => want.has(r.id)); }
    if (rows.length === 0) return { ok: true, filled: [] };

    const cfg = await settings.getConfig();
    const allowWeb = input.useWeb && cfg.dbAutofillWebSearch; // per-call request AND governance gate

    // RELATION-AWARE: pre-load every related database's rows once, so a row's linked rows can be fed
    // in as context (e.g. fill a "Region" column from the related Company's HQ).
    const relationProps = schema.filter((p) => p.type === 'relation' && p.relationDatabaseId);
    const relatedCache = new Map<string, Map<string, Record<string, unknown>>>();
    for (const rp of relationProps) {
      const rid = rp.relationDatabaseId!;
      if (relatedCache.has(rid)) continue;
      const byId = new Map<string, Record<string, unknown>>();
      for (const rr of await db.listNoteDbRows(rid)) byId.set(rr.id, readRow(rr).fields);
      relatedCache.set(rid, byId);
    }
    const relatedTitle = (fields: Record<string, unknown>): string => String(fields['name'] ?? fields['title'] ?? Object.values(fields)[0] ?? 'related');

    // Build per-row context + a map from cited source id → {label,url} for that row.
    const titleProp = schema.find((p) => p.type === 'text');
    const afRows: AutofillRow[] = [];
    const sourceMaps = new Map<string, Map<string, { label: string; url?: string }>>();
    for (const r of rows) {
      const { fields } = readRow(r);
      const title = String((titleProp && fields[titleProp.key]) || fields['name'] || fields['title'] || '');
      const fieldLines = schema.filter((p) => p.type !== 'rollup' && p.type !== 'relation' && p.key !== input.propertyKey).map((p) => `${p.name}: ${JSON.stringify(fields[p.key] ?? null)}`).join('\n');
      const sources = new Map<string, { label: string; url?: string }>([['row', { label: 'this row' }]]);
      let context = `[row] Known fields for this row:\n${fieldLines}`;

      // Add the row's RELATED rows (linked records) as cited context.
      let relIdx = 0;
      for (const rp of relationProps) {
        const linkedIds = (Array.isArray(fields[rp.key]) ? fields[rp.key] : []) as string[];
        const byId = relatedCache.get(rp.relationDatabaseId!);
        if (!byId || linkedIds.length === 0) continue;
        for (const lid of linkedIds.slice(0, MAX_RELATED_PER_PROP)) {
          const rf = byId.get(lid); if (!rf) continue;
          const sid = `rel:${++relIdx}`;
          const summary = Object.entries(rf).filter(([k]) => k !== CITATIONS_KEY).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('; ').slice(0, 600);
          sources.set(sid, { label: `${rp.name} → ${relatedTitle(rf)}` });
          context += `\n\n[${sid}] Related (${rp.name}) "${relatedTitle(rf)}":\n${summary}`;
        }
      }

      if (allowWeb && (title || fieldLines)) {
        // PII-SAFE: scrub personal data out of the outbound query before it leaves to the search engine.
        const rawQuery = `${title} ${prop.name}`.trim();
        const safe = cfg.dbAutofillRedactPii ? piiSafeWebQuery(rawQuery) : { query: rawQuery, usable: true };
        if (safe.usable) {
          const web = await webSources(safe.query, 3);
          for (const w of web) { sources.set(w.id, { label: w.label, url: w.url }); context += `\n\n[${w.id}] ${w.text}`; }
        }
      }
      sourceMaps.set(r.id, sources);
      afRows.push({ rowId: r.id, title, context, sourceIds: [...sources.keys()] });
    }

    const cells = await autofillProperty({ property: { name: prop.name, type: prop.type, ...(prop.options ? { options: prop.options } : {}) }, rows: afRows, generate: opts.generate });

    // Persist each filled cell (coerced) + its resolved citations.
    const filled: Array<{ rowId: string; value: unknown; citations: Array<{ label: string; url?: string }> }> = [];
    for (const cell of cells) {
      const row = rows.find((r) => r.id === cell.rowId); if (!row) continue;
      const { fields, citations } = readRow(row);
      const value = coerceValue(cell.value, prop);
      const resolved = cell.citations.map((cid) => sourceMaps.get(cell.rowId)?.get(cid)).filter((c): c is { label: string; url?: string } => !!c);
      // A filled value necessarily came from the provided context; if the model didn't cite a
      // source, attribute it to the row itself (the always-present "page" source) so every
      // AI-filled cell carries at least one verifiable citation.
      if (resolved.length === 0 && value != null && sourceMaps.get(cell.rowId)?.has('row')) resolved.push(sourceMaps.get(cell.rowId)!.get('row')!);
      fields[input.propertyKey] = value;
      citations[input.propertyKey] = resolved;
      await db.updateNoteDbRow(cell.rowId, input.databaseId, JSON.stringify({ ...fields, [CITATIONS_KEY]: citations }));
      filled.push({ rowId: cell.rowId, value, citations: resolved });
    }
    return { ok: true, filled };
  }

  /** The agent-tool entry point (autofill_database): owner-scoped, returns a compact result. */
  async function agentAutofill(args: { userId: string; tenantId?: string | null; databaseId: string; propertyKey: string; useWeb?: boolean }): Promise<{ ok: boolean; error?: string; filled?: number }> {
    const r = await autofillColumn({ databaseId: args.databaseId, userId: args.userId, ...(args.tenantId != null ? { tenantId: args.tenantId } : {}), propertyKey: args.propertyKey, useWeb: args.useWeb ?? false });
    return r.ok ? { ok: true, filled: r.filled?.length ?? 0 } : { ok: false, ...(r.error ? { error: r.error } : {}) };
  }

  return { view, autofillColumn, agentAutofill, newRowId: () => newUUIDv7() };
}

export type NoteDbService = ReturnType<typeof createNoteDbService>;
