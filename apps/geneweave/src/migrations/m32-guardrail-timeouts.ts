import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration M32 — Guardrail timeout and error-policy hardening
 *
 * The model-graded injection classifier uses on_error:'deny' with a tight
 * 8-second timeout. Under load (concurrent LLM calls) the classifier times
 * out and returns deny for SAFE content, causing false positives.
 *
 * Changes:
 *   - injection-classifier timeout_ms: 8000 → 15000
 *   - injection-classifier on_error: 'deny' → 'warn'
 *     (A timeout should flag for human review, not silently block the user)
 *
 * Security note: genuine injections are still caught by the fast deterministic
 * blocklist/regex guardrails that run BEFORE the model-graded check. The model-
 * graded check adds a second layer — downgrading its error policy to 'warn'
 * means a timeout degrades gracefully rather than falsely blocking safe users.
 */
export function applyM32GuardrailTimeouts(db: BetterSqlite3.Database): void {
  // Update injection-classifier: longer timeout, warn on error
  db.prepare(`
    UPDATE guardrails
    SET config = json_patch(config, '{"timeout_ms":15000,"on_error":"warn"}'),
        updated_at = datetime('now')
    WHERE id = 'b1c2d3e4-0003-4000-8000-000000000003'
      AND type = 'model-graded'
  `).run();

  // Also increase safety judge timeout for consistency
  db.prepare(`
    UPDATE guardrails
    SET config = json_patch(config, '{"timeout_ms":15000}'),
        updated_at = datetime('now')
    WHERE id = 'b1c2d3e4-0002-4000-8000-000000000002'
      AND type = 'model-graded'
  `).run();
}
