import type BetterSqlite3 from 'better-sqlite3';

// ── Migration registry ────────────────────────────────────────────────────────

/** A single named migration batch (a group of related schema changes). */
export interface MigrationBatch {
  /** Stable identifier used for logging and future idempotency tracking. */
  id: string;
  /** Human-readable description of what this batch covers. */
  description: string;
  /** Execute all schema changes in this batch against the given database. */
  run: (db: BetterSqlite3.Database) => void;
}

/**
 * Build a migration runner from an ordered list of batches.
 *
 * Batches are executed in the order they are registered. The runner is
 * immutable — the batch list is frozen after construction so callers cannot
 * accidentally mutate the order at runtime.
 */
export function createMigrationRunner(batches: MigrationBatch[]): {
  readonly batches: readonly MigrationBatch[];
  run(db: BetterSqlite3.Database): void;
} {
  const frozen = Object.freeze([...batches]);
  return {
    batches: frozen,
    run(db: BetterSqlite3.Database): void {
      for (const batch of frozen) batch.run(db);
    },
  };
}

// ── Low-level helper ──────────────────────────────────────────────────────────

export function safeExec(db: BetterSqlite3.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    // Log but continue — lets existing databases bootstrap past already-applied statements.
    console.warn('[migration] safeExec skipped statement:', (err as Error).message);
  }
}

// ── M16/M17 — Kaggle Phase K7b + K7c ────────────────────────────────────────
// Extracted from safeExec (where it was erroneously embedded and firing on every
// call). Call once at the end of applyM11_M18, after kaggle_runs exists.

export function applyKagglePhaseK7bK7c(db: BetterSqlite3.Database): void {
  // M16 — Phase K7b: add private_score, is_final_pick, finalized_at, cv_lb_gap
  const k7bAlters = [
    `ALTER TABLE kaggle_runs ADD COLUMN private_score REAL`,
    `ALTER TABLE kaggle_runs ADD COLUMN is_final_pick INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE kaggle_runs ADD COLUMN finalized_at TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN cv_lb_gap REAL`,
  ];
  for (const sql of k7bAlters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // M17 — Phase K7c: add kernel_ref, kernel_outputs, search_results
  const k7cAlters = [
    `ALTER TABLE kaggle_runs ADD COLUMN kernel_ref TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN kernel_outputs TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN search_results TEXT`,
  ];
  for (const sql of k7cAlters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
        id, name, description, category, risk_level, requires_approval,
        max_execution_ms, rate_limit_per_min, enabled,
        tool_key, version, side_effects, tags, source, credential_id,
        config, allocation_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'kaggle', 'read-only', 0, ?, 5, 0, ?, '0.3.0', 0, ?, 'mcp', NULL, ?, 'data', datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8000-000000000030',
      'Kaggle: Hyperparameter Search (kernel)',
      'Run hyperparameter search via Optuna in a Kaggle kernel. Pushes a notebook, polls for completion, and fetches best params and search history. Requires kaggle-runner image v0.3.0+.',
      600_000,
      'kaggle.kernel.optimize_hyperparams',
      JSON.stringify(['kaggle', 'mcp', 'kernel', 'optuna', 'search', 'hyperparam']),
      JSON.stringify({ endpoint: 'http://localhost:7421/mcp' }),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO skills (
        id, name, description, category, trigger_patterns, instructions,
        tool_names, examples, tags, priority, version, tool_policy_key,
        enabled, supervisor_agent_id, domain_sections, execution_contract,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, 60, '1.0', ?, 1, NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8002-000000000010',
      'kaggle_iterator',
      'Runs hyperparameter search using Optuna in a Kaggle kernel. Collaborates with implementer; spawns search jobs between approach generation and submission.',
      JSON.stringify(['hyperparameter search kaggle', 'optimize kaggle model', 'run optuna', 'tune kaggle hyperparameters', 'kaggle kernel optimize']),
      [
        'When to use: after approach generation, before submission, when the user or strategist requests hyperparameter optimization.',
        'When NOT to use: if the approach is already optimized, or the user declines search.',
        'Reasoning: hyperparameter search can yield significant performance gains with minimal manual effort.',
      ].join('\n'),
      JSON.stringify(['kaggle.kernel.optimize_hyperparams']),
      JSON.stringify(['kaggle', 'data-science', 'iterator', 'search', 'optuna', 'requires-intent-match']),
      'kaggle_read_only',
      JSON.stringify({ requiredOutputSubstrings: ['bestParams', 'searchHistory', 'kernelRef'] }),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
        id, name, description, category, risk_level, requires_approval,
        max_execution_ms, rate_limit_per_min, enabled,
        tool_key, version, side_effects, tags, source, credential_id,
        config, allocation_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'kaggle', 'read-only', 0, ?, NULL, 0, ?, '0.2.0', 0, ?, 'mcp', NULL, ?, 'data', datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8000-000000000029',
      'Kaggle: Adversarial Validation (sandboxed)',
      'Detect train/test distribution shift by fitting a classifier to distinguish train/test rows. Returns AUC, logloss, and top features by importance. Runs in a sandboxed Python container. No network, no credentials. Requires kaggle-runner image v0.2.0+ in the host ImagePolicy.',
      120_000,
      'kaggle.local.adversarial_validation',
      JSON.stringify(['kaggle', 'mcp', 'local', 'sandbox', 'drift', 'adversarial']),
      JSON.stringify({ endpoint: 'http://localhost:7421/mcp' }),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO skills (
        id, name, description, category, trigger_patterns, instructions,
        tool_names, examples, tags, priority, version, tool_policy_key,
        enabled, supervisor_agent_id, domain_sections, execution_contract,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, 80, '1.0', ?, 1, NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8002-000000000009',
      'kaggle_finalizer',
      'Picks the final 2 submissions for a Kaggle competition based on CV/LB gap and diversity. Sets is_final_pick=1 on the chosen kaggle_runs rows. Read-only — does not submit; hand off to kaggle_submitter for actual submission.',
      JSON.stringify(['finalize kaggle', 'pick final submissions', 'select final', 'finalize competition', 'choose final runs']),
      [
        'When to use: 24h before competition deadline, at least one submitted run exists. The user has asked to finalize or pick the best submissions.',
        'When NOT to use: no runs exist, or the deadline is not near, or the user wants to submit (hand off to kaggle_submitter).',
        'Reasoning: picking the right final submissions is critical for maximizing private LB placement. The skill picks (a) the highest CV run with gap near the median, and (b) the most diverse high-CV ensemble.',
        'Execution: compute cv_lb_gap for each run (public_score - cv_score), pick two: (1) highest CV with |gap| < median(gaps), (2) most diverse high-CV ensemble. Set is_final_pick=1 and finalized_at=now on both.',
        'Completion: report the chosen run ids, their CV/LB scores, and the rationale for each pick. State explicitly which is the "trust your CV" and which is the "diverse swing" choice.',
      ].join('\n'),
      JSON.stringify(['kaggle.local.adversarial_validation']),
      JSON.stringify(['kaggle', 'data-science', 'finalizer', 'selection', 'requires-intent-match']),
      'kaggle_read_only',
      JSON.stringify({ requiredOutputSubstrings: ['is_final_pick', 'cv_lb_gap', 'finalized_at'] }),
    );
  } catch { /* ignore */ }
}
