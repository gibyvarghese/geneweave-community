import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m145 — Internationalisation (Round 9).
 *
 * geneWeave's UI strings were all hardcoded English. This round adds a real i18n layer built on the pure
 * @weaveintel/core/i18n core (message catalog + BCP-47 fallback + ICU plurals). Each person already has an
 * interface-language preference (user_preferences.language, m136); now that preference actually re-labels the
 * app, and a workspace can offer languages beyond the two built in (English + Spanish) via AI-generated packs.
 *
 *  • tenant_locales — a per-workspace policy: the default language + which languages members may pick, plus
 *    whether the assistant should REPLY in the reader's interface language (off by default — a chat skill
 *    already matches the language the user writes in; this forces the workspace language regardless).
 *
 *  • tenant_ui_translations — AI-generated (or hand-edited) locale packs. An admin asks the assistant to
 *    "translate the app to French"; the translate_ui tool runs the base English catalog through the same
 *    faithful-translation engine the notes feature uses (packages/notes translate.ts — placeholder
 *    protection + injection spotlighting + verification) and stores the result here. GET /api/me/i18n then
 *    serves the effective messages (built-in base + built-in locale + this pack) to the web UI.
 *
 *  • translate_ui tool → a new weave_translator worker agent + the weaveNotes Editor, so localisation is a
 *    plain conversational request, fully audited like any other tool call.
 *
 * Idempotent.
 */
export function applyM145I18n(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_locales (
      tenant_id            TEXT PRIMARY KEY,
      default_locale       TEXT NOT NULL DEFAULT 'en',      -- the workspace's default UI language
      enabled_locales      TEXT NOT NULL DEFAULT '["en","es"]', -- JSON array of BCP-47 codes members may pick
      assistant_localized  INTEGER NOT NULL DEFAULT 0,      -- reply in the reader's interface language?
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_ui_translations (
      tenant_id     TEXT NOT NULL,
      locale        TEXT NOT NULL,                          -- BCP-47 code this pack covers
      messages_json TEXT NOT NULL DEFAULT '{}',             -- { key: translated string }
      source        TEXT NOT NULL DEFAULT 'ai',             -- 'ai' | 'manual'
      key_count     INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, locale)
    )
  `);

  // translate_ui — localise the app UI into a target language (reuses the notes translation engine).
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'i18n', 'safe', 0, 120000, 6, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000031', 'Translate the app UI',
      'Translate the geneWeave interface (menus, buttons, empty-state messages) into another language so the whole workspace can use the app in that language. Give a language like "French", "German", or "日本語"; it faithfully translates the built-in English labels, keeps product names and placeholders intact, verifies the result, and saves it as that workspace\'s language pack. After it runs, members who pick that language in their Account see the app relabelled. It only changes the workspace it is called from.',
      'translate_ui',
      JSON.stringify(['i18n', 'localization', 'language', 'translate']),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO worker_agents (id, name, display_name, job_profile, description, system_prompt, tool_names, persona, trigger_patterns, task_contract_id, max_retries, priority, category, enabled)
       VALUES (?, 'weave_translator', 'Localisation guide', 'i18n', ?, ?, ?, 'assistant', ?, NULL, 1, 30, 'general', 1)`,
    ).run(
      'note00000-0000-4000-8000-000000000032',
      'Translates the app interface into new languages on request and explains which languages the workspace offers.',
      'You help make the app available in more languages. When the user asks to translate the interface (e.g. "translate the app to French", "add German"), call translate_ui with the target language. Report back which language was added and that members can now pick it in Account → Language. Do not translate one label at a time — translate_ui handles the whole catalog. Never invent a language you were not asked for.',
      JSON.stringify(['translate_ui']),
      JSON.stringify(['translate the app', 'translate the interface', 'add a language', 'localize the app', 'app in french', 'app in spanish']),
    );
  } catch { /* ignore */ }

  for (const agentName of ['weavenotes_editor']) {
    try {
      const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = ?`).get(agentName) as { tool_names?: string } | undefined;
      if (row) {
        let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
        db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = ?`).run(JSON.stringify([...new Set([...names, 'translate_ui'])]), agentName);
      }
    } catch { /* ignore */ }
  }
}
