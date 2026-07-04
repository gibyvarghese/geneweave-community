/**
 * Migration m78 — Artifact Type Settings (Phase 2: Extended Type System)
 *
 * Introduces per-tenant artifact configuration:
 *
 *   tenant_artifact_settings   — Per-tenant allowlist of artifact types, size
 *                                limits, preview flags, and sandbox policy.
 *
 * Design decisions:
 *   - tenant_id = 'default' is the global fallback row seeded at boot.
 *   - allowed_types is JSON string[]; NULL = all 18 types permitted.
 *   - preview_enabled / sandbox_html let operators gate rich rendering per tenant.
 *   - Idempotent safe() helper mirrors the m77 pattern.
 *
 * Also updates the three seeded artifact_policies to include all Phase 2 types
 * (svg, mermaid, react, interactive, audio, video, spreadsheet) in their
 * allowed_types lists.
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

const ALL_ARTIFACT_TYPES = JSON.stringify([
  'text', 'markdown', 'csv', 'json', 'code',
  'html', 'pdf', 'report',
  'image', 'svg', 'diagram',
  'mermaid',
  'react', 'interactive',
  'audio', 'video',
  'spreadsheet',
  'custom',
]);

const STANDARD_TYPES = JSON.stringify([
  'text', 'markdown', 'csv', 'json', 'code',
  'html', 'pdf', 'report',
  'image', 'svg', 'diagram',
  'mermaid', 'react', 'interactive',
  'spreadsheet',
]);

const STRICT_TYPES = JSON.stringify(['text', 'json', 'csv', 'code', 'markdown']);

export function applyM78ArtifactTypeSettings(db: BetterSqlite3.Database): void {

  // ── 1. tenant_artifact_settings ──────────────────────────────────────────────
  safe(db, `
    CREATE TABLE IF NOT EXISTS tenant_artifact_settings (
      id                TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id         TEXT    NOT NULL UNIQUE,
      allowed_types     TEXT,           -- JSON string[] | NULL = all types
      max_size_bytes    INTEGER,        -- NULL = inherit from policy
      require_policy    INTEGER NOT NULL DEFAULT 0,
      preview_enabled   INTEGER NOT NULL DEFAULT 1,
      sandbox_html      INTEGER NOT NULL DEFAULT 1,
      emit_enabled      INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT
    )
  `);

  safe(db, `CREATE INDEX IF NOT EXISTS idx_tenant_artifact_settings_tenant ON tenant_artifact_settings(tenant_id)`);

  // ── 2. Seed default global row ────────────────────────────────────────────────
  const existing = db.prepare(`SELECT id FROM tenant_artifact_settings WHERE tenant_id = 'default'`).get();
  if (!existing) {
    db.prepare(`
      INSERT INTO tenant_artifact_settings
        (tenant_id, allowed_types, max_size_bytes, require_policy, preview_enabled, sandbox_html, emit_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('default', ALL_ARTIFACT_TYPES, 104857600, 0, 1, 1, 1);
  }

  // ── 3. Update seeded artifact_policies with Phase 2 types ────────────────────
  // Only update if the rows exist (they may have been deleted by an operator).
  const policyUpdates: Array<{ name: string; types: string }> = [
    { name: 'Standard',       types: STANDARD_TYPES },
    { name: 'Large Content',  types: ALL_ARTIFACT_TYPES },
    { name: 'Strict',         types: STRICT_TYPES },
  ];

  for (const { name, types } of policyUpdates) {
    try {
      db.prepare(`UPDATE artifact_policies SET allowed_types = ? WHERE name = ?`).run(types, name);
    } catch { /* table or row may not exist in test environments */ }
  }
}
