/**
 * Phase K7d — Auto-infer a competition-agnostic submission rubric from
 * Kaggle metadata.
 *
 * Strategy:
 *   1. Pull KaggleCompetition (evaluationMetric, description).
 *   2. Map evaluationMetric string → metric_name + direction
 *      ('maximize' | 'minimize') via a lookup table covering every
 *      common Kaggle metric.
 *   3. Pull leaderboard. Use median public score (or top-decile when sample
 *      is small) as baseline_score; use the top-rank score as target_score.
 *      Direction governs which is "better."
 *   4. List competition files. Detect a likely sample-submission file by
 *      filename pattern (sample_submission*.csv, gender_submission.csv,
 *      submission_format.csv). Record the filename in `inference_source`
 *      so operators can audit the inference.
 *
 * Anything we can't infer is left null. The validator role is expected to
 * degrade gracefully when individual rubric fields are missing (e.g. no
 * expected_row_count → skip schema row-count check, only mark advisory).
 *
 * This helper is competition-agnostic by construction: it never hard-codes
 * a slug, target column, or row count. New competitions get a rubric on
 * first contact without operator intervention.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type {
  KaggleAdapter,
  KaggleCompetition,
  KaggleCredentials,
  KaggleLeaderboardEntry,
  KaggleCompetitionFile,
} from '../kaggle/index.js';
import type { KaggleCompetitionRubricRow } from '../db-types.js';

/** Lookup table for common Kaggle evaluation metrics → direction. */
const METRIC_DIRECTION: Record<string, 'maximize' | 'minimize'> = {
  // Maximize
  accuracy: 'maximize',
  auc: 'maximize',
  'roc-auc': 'maximize',
  'roc auc': 'maximize',
  'area under the roc curve': 'maximize',
  f1: 'maximize',
  'f1-score': 'maximize',
  'mean f1-score': 'maximize',
  'macro f1': 'maximize',
  'micro f1': 'maximize',
  'weighted f1': 'maximize',
  precision: 'maximize',
  recall: 'maximize',
  'mean average precision': 'maximize',
  'map@k': 'maximize',
  map: 'maximize',
  'mean average precision @ 5': 'maximize',
  ndcg: 'maximize',
  'mean iou': 'maximize',
  iou: 'maximize',
  'dice coefficient': 'maximize',
  dice: 'maximize',
  'r²': 'maximize',
  r2: 'maximize',
  'r-squared': 'maximize',
  'pearson correlation': 'maximize',
  'spearman correlation': 'maximize',
  // Minimize
  rmse: 'minimize',
  'root mean squared error': 'minimize',
  rmsle: 'minimize',
  'root mean squared logarithmic error': 'minimize',
  mse: 'minimize',
  'mean squared error': 'minimize',
  mae: 'minimize',
  'mean absolute error': 'minimize',
  'log loss': 'minimize',
  'logarithmic loss': 'minimize',
  logloss: 'minimize',
  'cross entropy': 'minimize',
  'multiclass log loss': 'minimize',
  'binary log loss': 'minimize',
  smape: 'minimize',
  mape: 'minimize',
  wape: 'minimize',
  quadratic_weighted_kappa: 'maximize', // Cohen's kappa, higher better
  'quadratic weighted kappa': 'maximize',
  'cohen kappa': 'maximize',
};

/** Sample-submission filename patterns (case-insensitive). */
const SAMPLE_SUBMISSION_PATTERNS = [
  /^sample_submission(\.csv)?$/i,
  /^submission_format(\.csv)?$/i,
  /^sampleSubmission(\.csv)?$/i,
  /^gender_submission(\.csv)?$/i, // Titanic
  /^submission_example(\.csv)?$/i,
];

export interface InferRubricInput {
  adapter: KaggleAdapter;
  credentials: KaggleCredentials;
  competitionRef: string;
  tenantId?: string | null;
  /** Pre-fetched competition object (optional — saves an API call). */
  competition?: KaggleCompetition;
}

export interface InferRubricResult {
  rubric: Omit<KaggleCompetitionRubricRow, 'created_at' | 'updated_at'>;
  warnings: string[];
}

/** Resolve metric direction from a free-text Kaggle evaluation string.
 *  Falls back to null when the metric is unrecognized — the validator will
 *  treat baseline checks as advisory in that case. */
export function resolveMetricDirection(rawMetric: string | null | undefined): {
  metricName: string | null;
  direction: 'maximize' | 'minimize' | null;
} {
  if (!rawMetric) return { metricName: null, direction: null };
  const normalized = rawMetric.trim().toLowerCase();
  // Try exact then substring match.
  if (normalized in METRIC_DIRECTION) {
    return { metricName: rawMetric.trim(), direction: METRIC_DIRECTION[normalized] ?? null };
  }
  for (const [key, direction] of Object.entries(METRIC_DIRECTION)) {
    if (normalized.includes(key)) return { metricName: rawMetric.trim(), direction };
  }
  return { metricName: rawMetric.trim(), direction: null };
}

function pickSampleSubmissionFile(files: readonly KaggleCompetitionFile[]): KaggleCompetitionFile | null {
  for (const pattern of SAMPLE_SUBMISSION_PATTERNS) {
    const found = files.find((f) => pattern.test(f.name));
    if (found) return found;
  }
  return null;
}

/** Compute baseline_score (median) and target_score (top rank) from a
 *  Kaggle leaderboard, accounting for metric direction. Returns nulls when
 *  the leaderboard is empty or scores are all null. */
function summarizeLeaderboard(
  leaderboard: readonly KaggleLeaderboardEntry[],
  direction: 'maximize' | 'minimize' | null,
): { baseline: number | null; target: number | null } {
  const scores = leaderboard
    .map((e) => e.score)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  if (scores.length === 0) return { baseline: null, target: null };
  // Sort ascending so we can index the same way regardless of direction.
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? null;
  // For maximize: target = max; for minimize: target = min; default = max
  const target = direction === 'minimize' ? sorted[0] : sorted[sorted.length - 1];
  return { baseline: median, target: target ?? null };
}

export async function inferRubricFromCompetition(input: InferRubricInput): Promise<InferRubricResult> {
  const { adapter, credentials, competitionRef, tenantId = null } = input;
  const warnings: string[] = [];

  let competition = input.competition;
  if (!competition) {
    try {
      competition = await adapter.getCompetition(credentials, competitionRef);
    } catch (err) {
      warnings.push(`getCompetition failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { metricName, direction } = resolveMetricDirection(competition?.evaluationMetric);
  if (competition?.evaluationMetric && !direction) {
    warnings.push(`Unrecognized evaluation metric: "${competition.evaluationMetric}" — baseline checks will be advisory.`);
  }

  let baseline: number | null = null;
  let target: number | null = null;
  try {
    const lb = await adapter.getLeaderboard(credentials, competitionRef);
    const summary = summarizeLeaderboard(lb, direction);
    baseline = summary.baseline;
    target = summary.target;
  } catch (err) {
    warnings.push(`getLeaderboard failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let sampleFileName: string | null = null;
  try {
    const files = await adapter.listCompetitionFiles(credentials, competitionRef);
    const sample = pickSampleSubmissionFile(files);
    if (sample) sampleFileName = sample.name;
    else warnings.push('No sample submission file matched known patterns; schema checks will be advisory.');
  } catch (err) {
    warnings.push(`listCompetitionFiles failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const inferenceSourceParts: string[] = [];
  if (competition) inferenceSourceParts.push(`metric=${competition.evaluationMetric ?? 'n/a'}`);
  if (sampleFileName) inferenceSourceParts.push(`sample_file=${sampleFileName}`);
  if (baseline !== null) inferenceSourceParts.push(`baseline=median_lb`);
  if (target !== null) inferenceSourceParts.push(`target=top_lb`);

  const rubric: Omit<KaggleCompetitionRubricRow, 'created_at' | 'updated_at'> = {
    id: `kgl-rub-${newUUIDv7().slice(-8)}`,
    tenant_id: tenantId ?? null,
    competition_ref: competitionRef,
    metric_name: metricName,
    metric_direction: direction,
    baseline_score: baseline,
    target_score: target,
    expected_row_count: null,         // Requires sample CSV download — future iteration.
    id_column: null,                  // Requires sample CSV download — future iteration.
    id_range_min: null,
    id_range_max: null,
    target_column: null,
    target_type: null,
    expected_distribution_json: null,
    sample_submission_sha256: null,
    inference_source: inferenceSourceParts.length > 0 ? inferenceSourceParts.join('; ') : null,
    auto_generated: 1,
    inferred_at: new Date().toISOString(),
    notes: warnings.length > 0 ? `auto-inference warnings: ${warnings.join(' | ')}` : null,
  };

  return { rubric, warnings };
}
