/**
 * Phase K7d — Submission validator runner and leaderboard observer.
 *
 * Pure functions used by the validator + leaderboard-observer role handlers.
 * Kept here (and not inside role-handlers.ts) so they can be unit-tested
 * without spinning up a live-agents mesh.
 *
 * Competition-agnostic by construction:
 *   - Looks up the rubric for the inbound competition_ref.
 *   - If no rubric exists, calls inferRubricFromCompetition() to create
 *     one from Kaggle metadata (evaluationMetric, leaderboard, sample
 *     submission file). The auto-inferred rubric is persisted, then
 *     editable by operators in admin.
 *   - All checks degrade gracefully when individual rubric fields are
 *     null (e.g. missing expected_row_count → schema row-count check is
 *     skipped, not failed).
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { KaggleAdapter, KaggleCredentials } from '../kaggle/index.js';
import type { DatabaseAdapter } from '../db.js';
import type {
  KaggleCompetitionRubricRow,
  KaggleValidationResultRow,
  KaggleLeaderboardScoreRow,
} from '../db-types.js';
import { inferRubricFromCompetition } from './kaggle-rubric-inference.js';

export interface CvScoresArtifact {
  cv_metric?: string;
  cv_score?: number;
  cv_std?: number;
  baseline_score?: number;
  n_folds?: number;
}

export interface ValidationCheckInput {
  db: DatabaseAdapter;
  adapter: KaggleAdapter;
  credentials: KaggleCredentials;
  runId: string;
  competitionRef: string;
  tenantId?: string | null;
  kernelRef?: string | null;
  /** Output filenames produced by the kernel — used to verify submission.csv presence. */
  outputFiles: readonly string[];
  /** Parsed cv_scores.json contents (when the kernel emitted it). */
  cvScores?: CvScoresArtifact | null;
  /** Optional: parsed submission.csv stats when the runner fetched it. */
  submissionStats?: {
    rowCount: number;
    columnNames: string[];
    sha256?: string;
    /** Distribution summary by target column when available. */
    targetDistribution?: Record<string, number>;
  } | null;
}

export interface ValidationCheckResult {
  verdict: 'pass' | 'warn' | 'fail';
  rubric: KaggleCompetitionRubricRow;
  schemaCheckPassed: boolean | null;
  distributionCheckPassed: boolean | null;
  baselineCheckPassed: boolean | null;
  cvScore: number | null;
  cvStd: number | null;
  cvMetric: string | null;
  nFolds: number | null;
  violations: string[];
  summary: string;
  validationResultId: string;
}

/** Look up a rubric for the competition; auto-infer + persist when missing. */
export async function ensureRubricForCompetition(args: {
  db: DatabaseAdapter;
  adapter: KaggleAdapter;
  credentials: KaggleCredentials;
  competitionRef: string;
  tenantId?: string | null;
}): Promise<KaggleCompetitionRubricRow> {
  const { db, adapter, credentials, competitionRef, tenantId = null } = args;
  const existing = await db.getKaggleCompetitionRubricByRef(competitionRef, tenantId);
  if (existing) return existing;
  const { rubric } = await inferRubricFromCompetition({ adapter, credentials, competitionRef, tenantId });
  return db.upsertKaggleCompetitionRubric(rubric);
}

/** Run all validation checks. Persists one kaggle_validation_results row.
 *  Returns the structured verdict so the caller can decide hand-off. */
export async function runSubmissionValidation(input: ValidationCheckInput): Promise<ValidationCheckResult> {
  const rubric = await ensureRubricForCompetition({
    db: input.db,
    adapter: input.adapter,
    credentials: input.credentials,
    competitionRef: input.competitionRef,
    tenantId: input.tenantId ?? null,
  });

  const violations: string[] = [];

  // ── Schema check ────────────────────────────────────────
  // submission.csv (or submission.json) must exist in kernel outputs.
  const hasSubmissionFile = input.outputFiles.some((f) => f === 'submission.csv' || f === 'submission.json');
  let schemaCheckPassed: boolean | null = hasSubmissionFile;
  if (!hasSubmissionFile) violations.push('Kernel did not emit submission.csv or submission.json.');

  // Optional row-count check when both rubric and submissionStats supply it.
  if (input.submissionStats && rubric.expected_row_count != null) {
    if (input.submissionStats.rowCount !== rubric.expected_row_count) {
      schemaCheckPassed = false;
      violations.push(
        `Submission row count ${input.submissionStats.rowCount} does not match expected ${rubric.expected_row_count}.`,
      );
    }
  } else if (input.submissionStats == null) {
    // Caller didn't fetch submission stats — leave schemaCheckPassed advisory
    // (only the file-presence check above).
  }

  // ── Distribution check ──────────────────────────────────
  let distributionCheckPassed: boolean | null = null;
  if (input.submissionStats?.targetDistribution && rubric.expected_distribution_json) {
    try {
      const expected = JSON.parse(rubric.expected_distribution_json) as Record<string, number>;
      const actual = input.submissionStats.targetDistribution;
      // Compare proportions with tolerance.
      const totalExpected = Object.values(expected).reduce((a, b) => a + b, 0) || 1;
      const totalActual = Object.values(actual).reduce((a, b) => a + b, 0) || 1;
      let ok = true;
      for (const [k, ev] of Object.entries(expected)) {
        const ap = (actual[k] ?? 0) / totalActual;
        const ep = ev / totalExpected;
        if (Math.abs(ap - ep) > 0.15) {
          ok = false;
          violations.push(`Target distribution for "${k}" deviates >15% (expected ${ep.toFixed(3)}, got ${ap.toFixed(3)}).`);
        }
      }
      distributionCheckPassed = ok;
    } catch (err) {
      violations.push(`Could not parse expected_distribution_json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Baseline check ──────────────────────────────────────
  // Compare cv_score (if reported) against rubric.baseline_score honoring
  // metric_direction. Skipped (advisory) when cv_score or baseline are null.
  let baselineCheckPassed: boolean | null = null;
  const cvScore = input.cvScores?.cv_score ?? null;
  const cvStd = input.cvScores?.cv_std ?? null;
  const cvMetric = input.cvScores?.cv_metric ?? rubric.metric_name ?? null;
  const nFolds = input.cvScores?.n_folds ?? null;
  if (cvScore != null && rubric.baseline_score != null && rubric.metric_direction) {
    if (rubric.metric_direction === 'maximize') {
      baselineCheckPassed = cvScore >= rubric.baseline_score;
    } else {
      baselineCheckPassed = cvScore <= rubric.baseline_score;
    }
    if (!baselineCheckPassed) {
      violations.push(
        `CV score ${cvScore} does not beat baseline ${rubric.baseline_score} (direction=${rubric.metric_direction}).`,
      );
    }
  }

  // ── Verdict ─────────────────────────────────────────────
  // fail = schema is broken; warn = baseline/distribution violation; pass = all clear.
  let verdict: 'pass' | 'warn' | 'fail';
  if (schemaCheckPassed === false) verdict = 'fail';
  else if (baselineCheckPassed === false || distributionCheckPassed === false) verdict = 'warn';
  else verdict = 'pass';

  const validationResultId = `kgl-val-${newUUIDv7().slice(-8)}`;
  const summaryParts: string[] = [`verdict=${verdict}`];
  if (cvScore != null) summaryParts.push(`cv=${cvScore}`);
  if (rubric.baseline_score != null) summaryParts.push(`baseline=${rubric.baseline_score}`);
  if (rubric.metric_direction) summaryParts.push(`dir=${rubric.metric_direction}`);
  if (violations.length > 0) summaryParts.push(`violations=${violations.length}`);
  const summary = summaryParts.join(' | ');

  const row: Omit<KaggleValidationResultRow, 'created_at'> = {
    id: validationResultId,
    run_id: input.runId,
    competition_ref: input.competitionRef,
    rubric_id: rubric.id,
    kernel_ref: input.kernelRef ?? null,
    schema_check_passed: schemaCheckPassed === null ? null : schemaCheckPassed ? 1 : 0,
    distribution_check_passed: distributionCheckPassed === null ? null : distributionCheckPassed ? 1 : 0,
    baseline_check_passed: baselineCheckPassed === null ? null : baselineCheckPassed ? 1 : 0,
    cv_score: cvScore,
    cv_std: cvStd,
    cv_metric: cvMetric,
    n_folds: nFolds,
    predicted_distribution_json: input.submissionStats?.targetDistribution
      ? JSON.stringify(input.submissionStats.targetDistribution)
      : null,
    violations_json: violations.length > 0 ? JSON.stringify(violations) : null,
    verdict,
    summary,
    validated_at: new Date().toISOString(),
  };
  await input.db.createKaggleValidationResult(row);

  return {
    verdict,
    rubric,
    schemaCheckPassed,
    distributionCheckPassed,
    baselineCheckPassed,
    cvScore,
    cvStd,
    cvMetric,
    nFolds,
    violations,
    summary,
    validationResultId,
  };
}

export interface LeaderboardObservationInput {
  db: DatabaseAdapter;
  adapter: KaggleAdapter;
  credentials: KaggleCredentials;
  runId: string | null;
  competitionRef: string;
  /** Submission ref returned by kaggle.competitions.submit, if known. */
  submissionRef?: string | null;
  /** Most recent CV score for this run, if known — used to compute cv_lb_delta. */
  cvScore?: number | null;
}

export interface LeaderboardObservationResult {
  observed: boolean;
  publicScore: number | null;
  privateScore: number | null;
  cvLbDelta: number | null;
  rawStatus: string | null;
  scoreRowId: string | null;
}

/** Fetch latest submissions, find the matching one (by ref or first), and
 *  persist a kaggle_leaderboard_scores row. Idempotent-ish: writes a new row
 *  per observation tick so trends are preserved. */
export async function observeLeaderboardOnce(
  input: LeaderboardObservationInput,
): Promise<LeaderboardObservationResult> {
  const subs = await input.adapter.listSubmissions(input.credentials, input.competitionRef);
  if (!subs || subs.length === 0) {
    return { observed: false, publicScore: null, privateScore: null, cvLbDelta: null, rawStatus: null, scoreRowId: null };
  }
  const match = input.submissionRef
    ? subs.find((s) => s.ref === input.submissionRef) ?? subs[0]
    : subs[0];
  if (!match) {
    return { observed: false, publicScore: null, privateScore: null, cvLbDelta: null, rawStatus: null, scoreRowId: null };
  }

  const cvLbDelta =
    input.cvScore != null && typeof match.publicScore === 'number'
      ? input.cvScore - match.publicScore
      : null;

  let rankEstimate: number | null = null;
  let leaderboardSize: number | null = null;
  let percentileEstimate: number | null = null;
  try {
    const lb = await input.adapter.getLeaderboard(input.credentials, input.competitionRef);
    leaderboardSize = lb.length;
    if (typeof match.publicScore === 'number') {
      // Determine direction from rubric (best-effort).
      const rubric = await input.db.getKaggleCompetitionRubricByRef(input.competitionRef, null);
      const direction = rubric?.metric_direction ?? 'maximize';
      const rank = lb.filter((e) =>
        typeof e.score === 'number' && (direction === 'maximize'
          ? e.score > match.publicScore!
          : e.score < match.publicScore!),
      ).length + 1;
      rankEstimate = rank;
      percentileEstimate = leaderboardSize > 0 ? 1 - (rank - 1) / leaderboardSize : null;
    }
  } catch {
    // best-effort
  }

  const scoreRowId = `kgl-lb-${newUUIDv7().slice(-8)}`;
  const row: Omit<KaggleLeaderboardScoreRow, 'created_at'> = {
    id: scoreRowId,
    run_id: input.runId,
    competition_ref: input.competitionRef,
    submission_id: match.ref ?? null,
    public_score: match.publicScore ?? null,
    private_score: match.privateScore ?? null,
    cv_lb_delta: cvLbDelta,
    percentile_estimate: percentileEstimate,
    rank_estimate: rankEstimate,
    leaderboard_size: leaderboardSize,
    raw_status: match.status ?? null,
    observed_at: new Date().toISOString(),
  };
  await input.db.createKaggleLeaderboardScore(row);

  // Update kaggle_runs.public_score on the projection row.
  if (input.runId && match.publicScore != null) {
    try {
      await input.db.updateKaggleRun(input.runId, { public_score: match.publicScore });
    } catch {
      // best-effort
    }
  }

  return {
    observed: true,
    publicScore: match.publicScore ?? null,
    privateScore: match.privateScore ?? null,
    cvLbDelta,
    rawStatus: match.status ?? null,
    scoreRowId,
  };
}
