/**
 * m71-guardrails-2026
 *
 * Phase 4 Guardrails Modernization — mid-2026 compliance & agent-safety expansion.
 *
 * Changes:
 *   1. ADD COLUMN judge_model TEXT to guardrails
 *   2. ADD COLUMN compliance_framework TEXT to guardrails
 *   3. UPDATE sycophancy_judge priority 59 → 72 (raised above cognitive checks)
 *   4. UPDATE model-graded guardrails (b1c2d3e4-* series) to record judge_model
 *   5. INSERT 18 new guardrail rows across 5 categories:
 *       EU AI Act × 4, AI-Content × 4, Agent-Safety × 5, IP × 2, Residency × 3
 */
import type BetterSqlite3 from 'better-sqlite3';
import { GUARDRAILS_2026 } from '@weaveintel/guardrails';

const JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/** IDs of existing model-graded guardrails that should record judge_model. */
const MODEL_GRADED_IDS = [
  'b1c2d3e4-0001-4000-8000-000000000001', // Content Moderation
  'b1c2d3e4-0002-4000-8000-000000000002', // LLM Safety Judge
  'b1c2d3e4-0003-4000-8000-000000000003', // Prompt Injection Classifier
  'b1c2d3e4-0004-4000-8000-000000000004', // Sycophancy Judge
  'b1c2d3e4-0005-4000-8000-000000000005', // Semantic Grounding
];

export function applyM71Guardrails2026(db: BetterSqlite3.Database): void {
  // ── 1. Add new columns (idempotent: SQLite ADD COLUMN is a no-op if exists) ──

  const tableInfo = db
    .prepare("PRAGMA table_info('guardrails')")
    .all() as Array<{ name: string }>;
  const columnNames = tableInfo.map((c) => c.name);

  if (!columnNames.includes('judge_model')) {
    db.prepare('ALTER TABLE guardrails ADD COLUMN judge_model TEXT').run();
  }
  if (!columnNames.includes('compliance_framework')) {
    db.prepare('ALTER TABLE guardrails ADD COLUMN compliance_framework TEXT').run();
  }

  // ── 2. Raise sycophancy_judge priority 59 → 72 ───────────────────────────────

  db.prepare(
    `UPDATE guardrails
        SET priority = 72, updated_at = datetime('now')
      WHERE id = 'b1c2d3e4-0004-4000-8000-000000000004'
        AND priority = 59`,
  ).run();

  // ── 3. Stamp judge_model on existing model-graded guardrails ─────────────────

  const stampJudge = db.prepare(
    `UPDATE guardrails
        SET judge_model = ?, updated_at = datetime('now')
      WHERE id = ? AND judge_model IS NULL`,
  );
  for (const id of MODEL_GRADED_IDS) {
    stampJudge.run(JUDGE_MODEL, id);
  }

  // ── 4. Insert 18 new Phase 4 guardrail rows ───────────────────────────────────

  const insert = db.prepare(
    `INSERT OR IGNORE INTO guardrails
       (id, name, description, type, stage, config, priority, enabled,
        judge_model, compliance_framework, created_at, updated_at)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, datetime('now'), datetime('now'))`,
  );

  const insertAll = db.transaction(() => {
    for (const g of GUARDRAILS_2026) {
      insert.run(
        g.id,
        g.name,
        g.description,
        g.type,
        g.stage,
        g.config,
        g.priority,
        g.enabled,
        g.judge_model ?? null,
        g.compliance_framework ?? null,
      );
    }
  });

  insertAll();
}
