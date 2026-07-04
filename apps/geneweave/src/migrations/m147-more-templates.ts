import type BetterSqlite3 from 'better-sqlite3';
import { SYSTEM_TEMPLATES } from '../notes/templates.js';
import { safeExec } from './helpers.js';

/**
 * m147 — More note templates (Engineering / Product / Design / Knowledge / Personal + more Meetings/Planning).
 *
 * m111 seeded the original system templates. This round grows the catalogue with the kinds of documents teams
 * actually reach for — a Solution Architecture Document, Technical Design, ADR, Postmortem, PRD, Product
 * Roadmap, Customer Journey Map, Design Document, Retrospective, OKRs, SWOT, How-to, FAQ, and more — grouped
 * into richer categories. The template docs + metadata live in `@weaveintel/notes` SYSTEM_TEMPLATES (single
 * source of truth, shared with mobile); here we just SEED any not-yet-present template as a system-owned
 * `notes` row (deterministic id → INSERT OR IGNORE, so re-running is a no-op and existing ones are untouched).
 *
 * Idempotent.
 */
export function applyM147MoreTemplates(db: BetterSqlite3.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notes (id, owner_user_id, tenant_id, title, icon, parent_note_id, sensitivity, doc_json, is_template, template_key, favorite)
     VALUES (?, '_system', NULL, ?, ?, NULL, 'normal', ?, 1, ?, 0)`,
  );
  for (const tpl of SYSTEM_TEMPLATES) {
    try { insert.run(`note-tmpl-${tpl.key}`, tpl.title, tpl.icon, JSON.stringify(tpl.doc), tpl.key); } catch { /* ignore */ }
  }
}
