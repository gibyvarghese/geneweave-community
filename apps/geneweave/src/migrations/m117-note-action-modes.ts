import type BetterSqlite3 from 'better-sqlite3';

/**
 * m117 — weaveNotes: per-tenant routing mode for each note AI action.
 *
 * A note AI action (draw a diagram, sketch ink, add an illustration, the one-stop "visualize", or
 * restructure the whole note) can be performed three ways:
 *   - `direct`     — call the note service directly (one focused LLM call; fastest).
 *   - `agent`      — run through the chat AGENT (it calls the note tool itself).
 *   - `supervisor` — run through the SUPERVISOR, which delegates to the weaveNotes Editor worker.
 *
 * This migration makes that choice CONFIGURABLE per tenant + per action (Builder-editable), so an
 * operator can, say, route diagrams through the supervisor for one tenant but keep them direct
 * (fast) for another. Resolution is: tenant-specific row → global ('') row → 'direct'.
 *
 * Seeds the GLOBAL defaults to match the shipped behaviour (diagram / ink / visual / restructure go
 * through the supervisor; an SVG illustration stays direct). A realistic image is never listed — its
 * generate_image tool is intentionally not agent-registered (it costs money), so it is always direct.
 * Idempotent (CREATE IF NOT EXISTS + INSERT OR IGNORE).
 */
export function applyM117NoteActionModes(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_action_modes (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL DEFAULT '',          -- '' = global default for the action
      action_key  TEXT NOT NULL,                     -- diagram | ink | illustration | visual | restructure
      mode        TEXT NOT NULL DEFAULT 'direct',    -- direct | agent | supervisor
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, action_key)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_action_modes_tenant ON note_action_modes(tenant_id)`);

  // Seed the global defaults (tenant_id '') to match the current shipped routing. Deterministic ids
  // keep INSERT OR IGNORE idempotent across re-runs.
  const seed = db.prepare(
    `INSERT OR IGNORE INTO note_action_modes (id, tenant_id, action_key, mode, updated_at)
       VALUES (?, '', ?, ?, datetime('now'))`,
  );
  const DEFAULTS: Array<{ id: string; action: string; mode: string }> = [
    { id: 'noteact00-0000-4000-8000-000000000001', action: 'diagram', mode: 'supervisor' },
    { id: 'noteact00-0000-4000-8000-000000000002', action: 'ink', mode: 'supervisor' },
    { id: 'noteact00-0000-4000-8000-000000000003', action: 'visual', mode: 'supervisor' },
    { id: 'noteact00-0000-4000-8000-000000000004', action: 'restructure', mode: 'supervisor' },
    { id: 'noteact00-0000-4000-8000-000000000005', action: 'illustration', mode: 'direct' },
  ];
  for (const d of DEFAULTS) {
    try { seed.run(d.id, d.action, d.mode); } catch { /* ignore */ }
  }
}
