import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m135 — geneWeave UI rebuild: per-tenant Appearance / branding (white-label).
 *
 * A workspace (tenant) can re-brand geneWeave: its display name, a logo, a brand accent colour, corner
 * style, fonts, default colour-scheme (system/light/dark) and Pro/Creative default. The brand is applied
 * as CSS custom properties at runtime and is **accessibility-enforced** by @weaveintel/tokens — a brand
 * colour that fails WCAG-AA on a theme's background is dropped and that theme falls back to the accessible
 * default, so a tenant can never ship an inaccessible re-brand. Stored per tenant; edited in the Builder
 * (Appearance surface); the assistant can also apply it via the set_workspace_appearance tool.
 *
 *   - tenant_appearance — one row per tenant (brand fields + override), owner is the tenant admin.
 *   - the set_workspace_appearance tool in tool_catalog, granted to the weaveNotes Editor agent.
 * Idempotent.
 */
export function applyM135TenantAppearance(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_appearance (
      tenant_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      brand_name TEXT,
      logo_svg TEXT,
      color_scheme TEXT NOT NULL DEFAULT 'system',
      variant TEXT NOT NULL DEFAULT 'pro',
      accent TEXT,
      on_accent TEXT,
      corner_style TEXT NOT NULL DEFAULT 'soft',
      font_display TEXT,
      font_body TEXT,
      density TEXT NOT NULL DEFAULT 'comfortable',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Register the set_workspace_appearance tool + grant it to the weaveNotes Editor agent.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
         id, name, description, category, risk_level, requires_approval,
         max_execution_ms, rate_limit_per_min, enabled,
         tool_key, version, side_effects, tags, source, credential_id,
         config, allocation_class, created_at, updated_at
       ) VALUES (?, ?, ?, 'appearance', 'external-side-effect', 1, 30000, 10, 1, ?, '1.0', 1, ?, 'builtin', NULL, '{}', 'general', datetime('now'), datetime('now'))`,
    ).run(
      'note00000-0000-4000-8000-000000000022', 'Set workspace appearance',
      'Change this workspace’s look & feel: colour scheme (light/dark/system), the Pro vs Creative default, a brand accent colour, corner style, or density. Use when the user asks to "switch to dark mode", "use our brand colour #hex", "make it feel more creative", or "round the corners". Brand colours are checked for accessibility and safely ignored if they fail contrast. Requires workspace-admin rights.',
      'set_workspace_appearance',
      JSON.stringify(['appearance', 'branding', 'theme', 'admin']),
    );
  } catch { /* ignore */ }
  try {
    const row = db.prepare(`SELECT tool_names FROM worker_agents WHERE name = 'weavenotes_editor'`).get() as { tool_names?: string } | undefined;
    if (row) {
      let names: string[]; try { names = JSON.parse(row.tool_names ?? '[]'); } catch { names = []; }
      db.prepare(`UPDATE worker_agents SET tool_names = ? WHERE name = 'weavenotes_editor'`).run(JSON.stringify([...new Set([...names, 'set_workspace_appearance'])]));
    }
  } catch { /* ignore */ }
}
