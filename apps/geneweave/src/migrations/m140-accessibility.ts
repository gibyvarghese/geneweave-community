import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m140 — Accessibility defaults for streaming answers (Round 3 tail / H18 + H19).
 *
 * A streaming AI answer is an accessibility trap: re-rendering the transcript every token makes a screen
 * reader re-read the whole conversation (announcement spam), and content that reflows as it grows shifts
 * controls under the pointer (layout shift). The fix is in the client, but WHAT a workspace announces by
 * default — and whether it damps motion — is a governance choice, so it lives here.
 *
 *  • tenant_accessibility — per-tenant defaults:
 *      - announce_mode: how a screen reader hears a streaming answer —
 *          'summary' (default: "Generating response…" then the whole answer once it's done — clean + quiet),
 *          'live'    (progressive: sentence-complete chunks as they arrive, throttled),
 *          'off'     (no live announcements).
 *      - reduced_motion: force motion-damping (disable typing/stream animations) for everyone in the
 *        workspace, on top of each person's own OS "reduce motion" setting (which is always respected).
 *
 * No tool/agent: this is a client accessibility default, not an assistant capability.
 *
 * Idempotent.
 */
export function applyM140Accessibility(db: BetterSqlite3.Database): void {
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_accessibility (
      tenant_id       TEXT PRIMARY KEY,
      announce_mode   TEXT NOT NULL DEFAULT 'summary',   -- 'summary' | 'live' | 'off'
      reduced_motion  INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
