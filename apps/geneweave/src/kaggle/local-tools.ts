/**
 * ./index.js — local container-backed scoring helpers
 *
 * These helpers wrap @weaveintel/sandbox's ContainerExecutor so the
 * `kaggle.local.score_cv` MCP tool can run a sandboxed Python scorer
 * (CV with sklearn / pandas) without exposing the host shell or network.
 *
 * The runner image is the placeholder digest declared in
 * KAGGLE_RUNNER_IMAGE_DIGEST. Operators must replace it with the digest
 * produced from `runner/Dockerfile` and add the entry to their
 * @weaveintel/sandbox ImagePolicy via `kaggleRunnerImagePolicyEntry()`.
 */

import { createHash } from 'node:crypto';
import type {
  ContainerExecutor,
  ContainerRunSpec,
  ImagePolicyEntry,
} from '@weaveintel/sandbox';

/**
 * Placeholder image digest. Replace with the sha256 produced when the
 * `runner/Dockerfile` in this package is built and pushed.
 *
 * Kept as a 64-char zero hash so that callers who forget to override it get
 * a clear ImageNotAllowed error from ContainerExecutor instead of silently
 * pulling a tag.
 */
export const KAGGLE_RUNNER_IMAGE_DIGEST =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

/** Resource limits applied to every kaggle.local.* container run. */
export const KAGGLE_RUNNER_LIMITS = {
  cpuMillis: 4000,
  memoryMB: 4096,
  wallTimeSeconds: 300,
  stdoutBytes: 4 * 1024 * 1024,
  stderrBytes: 1 * 1024 * 1024,
} as const;

/**
 * Returns an ImagePolicyEntry for the Kaggle local runner image. Operators
 * compose this into their @weaveintel/sandbox ImagePolicy.
 */
export function kaggleRunnerImagePolicyEntry(
  digest: string = KAGGLE_RUNNER_IMAGE_DIGEST,
): ImagePolicyEntry {
  return {
    digest,
    description: 'weaveintel/kaggle-runner — local CV scoring + submission validation (Python 3.11, sklearn, pandas)',
    networkAllowList: [], // pure local compute, no network
    resourceCeiling: {
      cpuMillis: KAGGLE_RUNNER_LIMITS.cpuMillis,
      memoryMB: KAGGLE_RUNNER_LIMITS.memoryMB,
      wallTimeSeconds: KAGGLE_RUNNER_LIMITS.wallTimeSeconds,
    },
    envAllowList: [], // no env passthrough — credentials never reach the container
  };
}

function reproducibilityHash(imageDigest: string, stdin: string): string {
  return createHash('sha256').update(imageDigest).update('\x00').update(stdin).digest('hex');
}

// ─── Tool inputs / outputs ───────────────────────────────────

export interface ScoreCvInput {
  /** CSV training data (header + rows). */
  trainCsv: string;
  /** Name of the target column inside trainCsv. */
  targetColumn: string;
  /** Sklearn-style metric key. Examples: accuracy, roc_auc, neg_log_loss, f1, rmse. */
  metric: string;
  /** Number of CV folds. Default 5. */
  folds?: number;
  /** Model name. Runner v0.2.0+ understands: logistic_regression, random_forest, gradient_boosting, lightgbm, xgboost. */
  model?: string;
  /** Optional fit kwargs forwarded to the model constructor. */
  modelKwargs?: Record<string, unknown>;
  /** Optional integer seed for reproducibility. Default 42. */
  randomState?: number;
  /** When true (runner v0.2.0+ default), capture OOF predictions for downstream blending. */
  captureOof?: boolean;
}

export interface ScoreCvResult {
  cvScore: number;
  foldScores: number[];
  metric: string;
  model: string;
  durationMs: number;
  /** Out-of-fold predictions aligned to training-row order. Present when runner ≥ 0.2.0 and captureOof != false. */
  oofPredictions?: number[];
}

export interface ValidateSubmissionContainerInput {
  /** Raw submission CSV content. */
  csvContent: string;
  /** Required headers in order. */
  expectedHeaders: string[];
  /** Optional ID column for duplicate / coverage checks. */
  idColumn?: string;
  /** Optional expected row count. */
  expectedRowCount?: number;
}

export interface ValidateSubmissionContainerResult {
  valid: boolean;
  rows: number;
  headers: string[];
  errors: string[];
  warnings: string[];
}

// ─── Blend (Phase K7a) ────────────────────────────────────────

/** Metrics supported by the blend optimizer. */
export type BlendMetric = 'auc' | 'rmse' | 'logloss';

export interface BlendInput {
  /** OOF prediction matrix: outer = models, inner = samples (must be rectangular). */
  oofMatrix: number[][];
  /** True labels aligned to the inner sample axis. */
  yTrue: number[];
  /** Scoring metric used for the optimization. */
  metric: BlendMetric;
}

export interface BlendResult {
  /** Optimal weights (sum to 1, each in [0,1]) — same order as input oofMatrix rows. */
  weights: number[];
  /** Score of the optimal weighted blend (higher = better for AUC; lower = better for RMSE/LogLoss). */
  blendedScore: number;
  /** Score of the equal-weight (mean) baseline, for context. */
  baselineMeanScore: number;
  /** Score of the single best model, for context — proves the blend was worth running. */
  baselineBestSoloScore: number;
  modelCount: number;
  sampleCount: number;
  metric: BlendMetric;
  converged: boolean;
  iterations: number;
}

// ─── Helper: invoke a runner subcommand ──────────────────────

interface InvokeOptions {
  executor: ContainerExecutor;
  imageDigest: string;
  command: 'score_cv' | 'validate_submission' | 'blend' | 'adversarial_validation';
  payload: unknown;
}
// ─── Adversarial Validation (Phase K7b) ─────────────────────

export interface AdversarialValidationInput {
  /** Train matrix: samples × features. */
  trainMatrix: number[][];
  /** Test matrix: samples × features. */
  testMatrix: number[][];
  /** Optional feature names (for topFeatures). */
  featureNames?: string[];
  /** Metric: 'auc' | 'logloss' (default 'auc'). */
  metric?: 'auc' | 'logloss';
  /** How many top features to return. */
  topFeatures?: number;
}

export interface AdversarialValidationResult {
  auc: number;
  logloss: number;
  topFeatures: [string, number][];
  model: string;
  converged: boolean;
  iterations: number;
}

async function invokeRunner<T>(opts: InvokeOptions): Promise<T> {
  const stdin = JSON.stringify({ command: opts.command, payload: opts.payload });
  const spec: ContainerRunSpec = {
    imageDigest: opts.imageDigest,
    stdin,
    limits: { ...KAGGLE_RUNNER_LIMITS },
    reproducibilityHash: reproducibilityHash(opts.imageDigest, stdin),
  };
  const result = await opts.executor.execute(spec);
  if (result.exitCode !== 0) {
    throw new Error(
      `kaggle runner failed (exit=${result.exitCode}): ${result.stderr.slice(0, 1000)}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new Error(
      `kaggle runner produced non-JSON stdout: ${(err as Error).message}: ${result.stdout.slice(0, 500)}`,
    );
  }
}

// ─── Public helpers used by the MCP server ───────────────────

export interface KaggleLocalToolsOptions {
  executor: ContainerExecutor;
  /** Override the default placeholder digest. Required in production. */
  imageDigest?: string;
}

export interface KaggleLocalTools {
  scoreCv(input: ScoreCvInput): Promise<ScoreCvResult>;
  validateSubmissionInContainer(
    input: ValidateSubmissionContainerInput,
  ): Promise<ValidateSubmissionContainerResult>;
  /** Phase K7a: optimal weighted blend of N OOF prediction vectors. */
  blend(input: BlendInput): Promise<BlendResult>;
  /** Phase K7b: adversarial validation (train/test drift detection). */
  adversarialValidation(input: AdversarialValidationInput): Promise<AdversarialValidationResult>;
}

export function createKaggleLocalTools(opts: KaggleLocalToolsOptions): KaggleLocalTools {
  const imageDigest = opts.imageDigest ?? KAGGLE_RUNNER_IMAGE_DIGEST;
  return {
    async scoreCv(input) {
      return invokeRunner<ScoreCvResult>({
        executor: opts.executor,
        imageDigest,
        command: 'score_cv',
        payload: input,
      });
    },
    async validateSubmissionInContainer(input) {
      return invokeRunner<ValidateSubmissionContainerResult>({
        executor: opts.executor,
        imageDigest,
        command: 'validate_submission',
        payload: input,
      });
    },
    async blend(input) {
      return invokeRunner<BlendResult>({
        executor: opts.executor,
        imageDigest,
        command: 'blend',
        payload: input,
      });
    },
    async adversarialValidation(input) {
      return invokeRunner<AdversarialValidationResult>({
        executor: opts.executor,
        imageDigest,
        command: 'adversarial_validation',
        payload: input,
      });
    },
  };
}
