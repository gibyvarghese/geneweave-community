/**
 * Migration m46 — Agenda items, agenda categories, notes and inline databases
 *
 * Five new tables:
 *
 *   agenda_categories — user-configurable categories (colour, icon) for agenda items.
 *     Pre-seeded with eight common personas (work/personal/health/finance/travel/family/learning/other).
 *
 *   agenda_items — unified personal calendar entries (appointments, deadlines, recurring
 *     events, reminders, follow-ups). Linked back to tasks, runs, and notes via FK-style
 *     text columns. Provenance JSON records the origin (email / chat / manual / agent).
 *
 *   notes — Notion-like block documents. doc_json holds a Tiptap/ProseMirror JSON
 *     document. Notes support nesting (parent_note_id), templates (is_template), and
 *     sensitivity labels (normal / confidential / restricted).
 *
 *   note_links — backlinks and @mentions within notes, targeting notes, runs, agenda
 *     items, or tasks. Enables the linked-references panel (WC7) and save-time extraction
 *     pipeline (WC8).
 *
 *   note_databases — saved filtered/sorted views over agenda_items, tasks, or a generic
 *     row table (source = 'generic'). Stores filter + sort + column config as JSON.
 *
 *   note_db_rows — generic key-value rows for note_databases with source = 'generic'.
 */

import type BetterSqlite3 from 'better-sqlite3';

export function applyM46AgendaNotes(db: BetterSqlite3.Database): void {
  // ── Agenda categories ──────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agenda_categories (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT,
      user_id      TEXT,
      name         TEXT NOT NULL,
      color        TEXT NOT NULL DEFAULT '#7C5CFC',
      icon         TEXT NOT NULL DEFAULT '◆',
      template_key TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Agenda items ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agenda_items (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      tenant_id        TEXT,
      title            TEXT NOT NULL,
      kind             TEXT NOT NULL DEFAULT 'event',
      category_id      TEXT,
      start_at         TEXT,
      end_at           TEXT,
      all_day          INTEGER NOT NULL DEFAULT 0,
      location         TEXT,
      description      TEXT,
      recurrence_rule  TEXT,
      status           TEXT NOT NULL DEFAULT 'confirmed',
      sensitivity      TEXT NOT NULL DEFAULT 'normal',
      amount           TEXT,
      currency         TEXT,
      provenance       TEXT,
      linked_task_id   TEXT,
      linked_run_id    TEXT,
      linked_note_id   TEXT,
      parent_item_id   TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agenda_items_user_start ON agenda_items(user_id, start_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agenda_items_user_kind  ON agenda_items(user_id, kind)`);

  // ── Notes ─────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id             TEXT PRIMARY KEY,
      owner_user_id  TEXT NOT NULL,
      tenant_id      TEXT,
      title          TEXT NOT NULL DEFAULT 'Untitled',
      icon           TEXT,
      cover          TEXT,
      parent_note_id TEXT,
      sensitivity    TEXT NOT NULL DEFAULT 'normal',
      doc_json       TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
      is_template    INTEGER NOT NULL DEFAULT 0,
      template_key   TEXT,
      favorite       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_user_parent ON notes(owner_user_id, parent_note_id)`);

  // ── Note links (backlinks / @mentions) ─────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_links (
      id          TEXT PRIMARY KEY,
      note_id     TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_links_note     ON note_links(note_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_links_target   ON note_links(target_kind, target_id)`);

  // ── Note databases (saved views) ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_databases (
      id             TEXT PRIMARY KEY,
      owner_user_id  TEXT NOT NULL,
      tenant_id      TEXT,
      name           TEXT NOT NULL,
      source         TEXT NOT NULL DEFAULT 'generic',
      view_type      TEXT NOT NULL DEFAULT 'table',
      filter_json    TEXT NOT NULL DEFAULT '{}',
      sort_json      TEXT NOT NULL DEFAULT '[]',
      columns_json   TEXT NOT NULL DEFAULT '[]',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Note database rows (generic rows for source='generic') ─────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_db_rows (
      id           TEXT PRIMARY KEY,
      database_id  TEXT NOT NULL,
      fields_json  TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_db_rows_db ON note_db_rows(database_id)`);

  // ── Default agenda categories (persona-seeded) ─────────────────────────────
  const seedCategories: Array<{ id: string; name: string; color: string; icon: string; key: string }> = [
    { id: 'cat-work',     name: 'Work',     color: '#3B82F6', icon: '💼', key: 'work' },
    { id: 'cat-personal', name: 'Personal', color: '#8B5CF6', icon: '⭐', key: 'personal' },
    { id: 'cat-health',   name: 'Health',   color: '#10B981', icon: '🏃', key: 'health' },
    { id: 'cat-finance',  name: 'Finance',  color: '#F59E0B', icon: '💰', key: 'finance' },
    { id: 'cat-travel',   name: 'Travel',   color: '#EC4899', icon: '✈️', key: 'travel' },
    { id: 'cat-family',   name: 'Family',   color: '#EF4444', icon: '🏠', key: 'family' },
    { id: 'cat-learning', name: 'Learning', color: '#06B6D4', icon: '📚', key: 'learning' },
    { id: 'cat-other',    name: 'Other',    color: '#6B7280', icon: '◆', key: 'other' },
  ];

  const insertCat = db.prepare(
    `INSERT OR IGNORE INTO agenda_categories (id, name, color, icon, template_key)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertManyCats = db.transaction((cats: typeof seedCategories) => {
    for (const c of cats) {
      insertCat.run(c.id, c.name, c.color, c.icon, c.key);
    }
  });
  insertManyCats(seedCategories);

  // ── Default note templates (persona-seeded) ────────────────────────────────
  const noteTemplates: Array<{ id: string; title: string; icon: string; key: string; doc: string }> = [
    {
      id: 'tmpl-meeting', key: 'meeting', title: 'Meeting Notes', icon: '📝',
      doc: JSON.stringify({ type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Meeting Notes' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Date: ' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Attendees' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Agenda' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Action Items' }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [] }] }] },
      ] }),
    },
    {
      id: 'tmpl-weekly', key: 'weekly', title: 'Weekly Review', icon: '📅',
      doc: JSON.stringify({ type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Weekly Review' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '✅ Wins this week' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '🚧 Still in progress' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '📌 Next week priorities' }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [] }] }] },
      ] }),
    },
    {
      id: 'tmpl-research', key: 'research', title: 'Research Note', icon: '🔬',
      doc: JSON.stringify({ type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Research Note' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '🎯 Question / Goal' }] },
        { type: 'paragraph', content: [] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '📖 Sources' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '💡 Findings' }] },
        { type: 'paragraph', content: [] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '🏁 Conclusions' }] },
        { type: 'paragraph', content: [] },
      ] }),
    },
  ];

  const insertTmpl = db.prepare(
    `INSERT OR IGNORE INTO notes (id, owner_user_id, title, icon, is_template, template_key, doc_json, sensitivity)
     VALUES (?, '_system', ?, ?, 1, ?, ?, 'normal')`,
  );
  const insertManyTmpls = db.transaction((tmpls: typeof noteTemplates) => {
    for (const t of tmpls) {
      insertTmpl.run(t.id, t.title, t.icon, t.key, t.doc);
    }
  });
  insertManyTmpls(noteTemplates);
}
