// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — L2 code baseline persistence + scan orchestration.
 *
 * The pure scanner (`code-scan.ts`) needs a BASE baseline to compare the live tree against. This stores that
 * baseline (the `source_baselines` manifest captured at install/upgrade time) in `upgrade_code_baseline`
 * (m174), and ties the pieces together:
 *   • capture the current tree as the baseline;
 *   • `code status` — a read-only two-way (or, given a release target, three-way) scan;
 *   • `code scan` — the same, but recorded as L2 `upgrade_details` under a run so the changes join the review
 *     queue (keep / defer / bulk, with a both-changed conflict banded P1).
 *
 * Written once against the framework's `SqlClient` seam so it serves SQLite and Postgres.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph, nowExpr } from './realm-sql.js';
import { generateSourceBaselines, type SourceBaseline } from './source-baselines.js';
import { codeStatus, recordCodeReview, type CodeStatusReport } from './code-scan.js';
import { beginUpgradeRun, finishUpgradeRun } from './upgrade-run-store.js';

const ROW_ID = 'singleton';

/**
 * The source-tree root the L2 scan operates on: `GENEWEAVE_SOURCE_ROOT` if set (a source deploy points it at
 * its checkout), else the application package directory (this module lives in its `src/`).
 * @returns the absolute source-tree root.
 */
export function defaultSourceRoot(): string {
  return process.env['GENEWEAVE_SOURCE_ROOT'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Capture the current source tree as the stored L2 baseline (overwriting any prior one).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param root the absolute source-tree root to hash.
 * @param at optional ISO timestamp override (tests).
 * @returns the digest + file count. Side effect: UPDATEs the singleton baseline row.
 */
export async function captureCodeBaseline(client: SqlClient, dialect: SqlDialect, root: string, at?: string): Promise<{ digest: string; fileCount: number }> {
  const baseline = generateSourceBaselines(root);
  await client.query(
    `UPDATE upgrade_code_baseline SET manifest_json = ${ph(dialect, 1)}, digest = ${ph(dialect, 2)}, captured_at = COALESCE(${ph(dialect, 3)}, ${nowExpr(dialect)}) WHERE id = '${ROW_ID}'`,
    [JSON.stringify(baseline), baseline.digest, at ?? null],
  );
  return { digest: baseline.digest, fileCount: Object.keys(baseline.files).length };
}

/**
 * Load the stored L2 baseline, or null if none has been captured.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the {@link SourceBaseline}, or null.
 */
export async function loadCodeBaseline(client: SqlClient, dialect: SqlDialect): Promise<SourceBaseline | null> {
  void dialect;
  const { rows } = await client.query(`SELECT manifest_json FROM upgrade_code_baseline WHERE id = '${ROW_ID}'`);
  const raw = (rows[0] as { manifest_json?: string | null } | undefined)?.manifest_json;
  if (!raw) return null;
  return JSON.parse(raw) as SourceBaseline;
}

/** A code-status result, or a not-captured sentinel. */
export type CodeStatusOutcome = (CodeStatusReport & { status: 'ok' }) | { status: 'no_baseline' };

/**
 * A read-only `code status`: compare the live tree against the stored baseline (and optionally a release
 * target). No writes.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param root the source-tree root to scan.
 * @param remote an optional release target baseline for a three-way scan.
 * @returns the report, or `{ status: 'no_baseline' }` if none was captured.
 */
export async function runCodeStatus(client: SqlClient, dialect: SqlDialect, root: string, remote?: SourceBaseline): Promise<CodeStatusOutcome> {
  const base = await loadCodeBaseline(client, dialect);
  if (!base) return { status: 'no_baseline' };
  return { status: 'ok', ...codeStatus(root, base, remote) };
}

/** The result of a persisted code scan. */
export type CodeScanOutcome = { status: 'ok'; runId: string; recorded: number; report: CodeStatusReport } | { status: 'no_baseline' };

/**
 * Scan the code tree and RECORD its changes as L2 review items under a new run — so code changes flow through
 * the same review queue as content.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param root the source-tree root to scan.
 * @param remote an optional release target baseline (three-way).
 * @param at optional timestamp override (tests).
 * @returns the run id, how many detail rows were recorded, and the report. Side effects: one upgrade_runs row
 *   (mode 'preview') + one upgrade_details per non-trivial file.
 */
export async function runCodeScan(client: SqlClient, dialect: SqlDialect, root: string, remote?: SourceBaseline, at?: string): Promise<CodeScanOutcome> {
  const outcome = await runCodeStatus(client, dialect, root, remote);
  if (outcome.status === 'no_baseline') return outcome;
  const { status: _s, ...report } = outcome;
  const runId = await beginUpgradeRun(client, dialect, { mode: 'preview', toVersion: 'code-scan', at });
  const recorded = await recordCodeReview(client, dialect, runId, report);
  await finishUpgradeRun(client, dialect, runId, { status: 'succeeded', summary: { codeConflicts: report.conflicts.length, codeChanges: recorded }, at });
  return { status: 'ok', runId, recorded, report };
}
