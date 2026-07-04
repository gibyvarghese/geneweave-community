/**
 * Scientific Validation — Cost Regression Gate
 *
 * Queries the tool_audit_events table for the most recent SV corpus run window
 * and fails (exit 1) if total estimated model cost exceeds the configured threshold.
 *
 * Designed to run in CI after a corpus eval run has completed.
 *
 * Usage:
 *   npx tsx apps/geneweave/src/features/scientific-validation/evals/cost-gate.ts \
 *     --db ./data/geneweave.db \
 *     --threshold 5.00 \
 *     --window-minutes 120
 *
 * Options:
 *   --db               Path to the SQLite database file (default: ./data/geneweave.db)
 *   --threshold        Maximum allowed cost in USD per corpus run (default: 5.00)
 *   --window-minutes   Look-back window in minutes (default: 120)
 *   --verbose          Print per-tool cost breakdown
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// ── Cost model ─────────────────────────────────────────────────────────────────
// Approximate cost-per-1k-tokens for each model tier used by SV agents.
// These are conservative upper-bound estimates — actual prices vary by provider.
// Update when switching models.
const COST_PER_1K_TOKENS: Record<string, number> = {
  // GPT-4o class (reasoning/supervisor agents)
  reasoning: 0.005,
  // GPT-4o-mini class (tool/literature agents)
  tool: 0.00015,
  // Fallback for unknown agents
  default: 0.005,
};

// Rough estimate: each SV agent invocation exchanges ~2 k tokens on average
const AVG_TOKENS_PER_INVOCATION = 2000;

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return (idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined) ?? defaultValue;
}

const dbPath = getArg('--db', join(process.cwd(), 'data', 'geneweave.db'));
const thresholdUsd = parseFloat(getArg('--threshold', '5.00'));
const windowMinutes = parseInt(getArg('--window-minutes', '120'), 10);
const verbose = args.includes('--verbose');

// ── Tool audit event shape (subset) ──────────────────────────────────────────
interface AuditRow {
  tool_name: string;
  outcome: string;
  duration_ms: number | null;
  created_at: string;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function run(): void {
  if (!existsSync(dbPath)) {
    console.error(`[cost-gate] Database not found at: ${dbPath}`);
    console.error('[cost-gate] Pass --db <path> or run against a live DB path.');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });

  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const rows = db
    .prepare<string[]>(
      `SELECT tool_name, outcome, duration_ms, created_at
         FROM tool_audit_events
        WHERE created_at >= ?
        ORDER BY created_at DESC`,
    )
    .all(cutoff) as AuditRow[];

  db.close();

  if (rows.length === 0) {
    console.log(`[cost-gate] No tool audit events found in the last ${windowMinutes} minutes.`);
    console.log('[cost-gate] PASS — nothing to measure (did you run sv:eval first?)');
    process.exit(0);
  }

  // Group by tool_name and count invocations
  const invocationsByTool: Record<string, { count: number; successCount: number; avgDurationMs: number }> = {};
  for (const row of rows) {
    const entry = invocationsByTool[row.tool_name] ?? { count: 0, successCount: 0, avgDurationMs: 0 };
    entry.count++;
    if (row.outcome === 'success') entry.successCount++;
    entry.avgDurationMs = (entry.avgDurationMs * (entry.count - 1) + (row.duration_ms ?? 0)) / entry.count;
    invocationsByTool[row.tool_name] = entry;
  }

  // Estimate cost per tool
  let totalEstimatedUsd = 0;
  const breakdown: Array<{ tool: string; invocations: number; estimatedUsd: number }> = [];

  for (const [toolName, stats] of Object.entries(invocationsByTool)) {
    // Classify by tool name prefix to pick cost tier
    let tier: string = 'default';
    if (
      toolName.startsWith('arxiv') ||
      toolName.startsWith('pubmed') ||
      toolName.startsWith('semanticscholar') ||
      toolName.startsWith('scipy') ||
      toolName.startsWith('sympy') ||
      toolName.startsWith('r.') ||
      toolName.startsWith('pymc') ||
      toolName.startsWith('rdkit') ||
      toolName.startsWith('biopython') ||
      toolName.startsWith('networkx') ||
      toolName.startsWith('wolfram') ||
      toolName.startsWith('openalex') ||
      toolName.startsWith('crossref') ||
      toolName.startsWith('europepmc') ||
      toolName.startsWith('statsmodels')
    ) {
      tier = 'tool';
    } else if (
      toolName === 'decomposer' ||
      toolName === 'supervisor' ||
      toolName === 'adversarial'
    ) {
      tier = 'reasoning';
    }

    const costPer1k = COST_PER_1K_TOKENS[tier] ?? COST_PER_1K_TOKENS['default'] ?? 0.005;
    const estimatedUsd = (stats.count * AVG_TOKENS_PER_INVOCATION * costPer1k) / 1000;
    totalEstimatedUsd += estimatedUsd;
    breakdown.push({ tool: toolName, invocations: stats.count, estimatedUsd });
  }

  // Sort breakdown by cost descending for readability
  breakdown.sort((a, b) => b.estimatedUsd - a.estimatedUsd);

  console.log('[cost-gate] ─────────────────────────────────────────────────');
  console.log(`[cost-gate] Window       : last ${windowMinutes} minutes`);
  console.log(`[cost-gate] Total events : ${rows.length}`);
  console.log(`[cost-gate] Threshold    : $${thresholdUsd.toFixed(2)}`);
  console.log(`[cost-gate] Estimated    : $${totalEstimatedUsd.toFixed(4)}`);

  if (verbose) {
    console.log('[cost-gate] ─── Per-tool breakdown ──────────────────────────');
    for (const item of breakdown) {
      console.log(
        `[cost-gate]   ${item.tool.padEnd(36)} ${String(item.invocations).padStart(4)} calls  $${item.estimatedUsd.toFixed(4)}`,
      );
    }
  }

  console.log('[cost-gate] ─────────────────────────────────────────────────');

  if (totalEstimatedUsd > thresholdUsd) {
    console.error(
      `[cost-gate] FAIL — estimated cost $${totalEstimatedUsd.toFixed(4)} exceeds threshold $${thresholdUsd.toFixed(2)}`,
    );
    console.error('[cost-gate] Raise --threshold or optimise SV agent token budgets.');
    process.exit(1);
  }

  console.log(
    `[cost-gate] PASS — estimated cost $${totalEstimatedUsd.toFixed(4)} is within $${thresholdUsd.toFixed(2)} threshold`,
  );
  process.exit(0);
}

run();
