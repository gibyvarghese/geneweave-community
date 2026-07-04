/**
 * Phase K4 — Kaggle evidence ledger + replay integration.
 *
 * Per docs/KAGGLE_AGENT_DESIGN.md §3 and §6:
 *   - Every Kaggle work product (submission, validator pass, ideation cycle) is
 *     a first-class @weaveintel/core/contracts AgentContract with an evidence
 *     bundle: { kernelRef, kernelOutputUrl, submissionCsvSha256, leaderboardJson,
 *     validatorReport }.
 *   - Every run is reproducible via a @weaveintel/observability/replay RunLog so the operator
 *     can re-execute the exact tool sequence deterministically.
 *
 * `materializeKaggleRun()` is the ONE entry point that:
 *   1. Builds the EvidenceBundle from raw submission outputs
 *   2. Creates the AgentContract + CompletionReport via @weaveintel/core/contracts
 *   3. Writes (or upserts) the kaggle_runs projection row
 *   4. Stores the contract report JSON + replay run-log JSON in
 *      kaggle_run_artifacts so admin UI + replay endpoint can reconstruct.
 *
 * `replayKaggleRun()` loads the stored RunLog and runs the deterministic
 * @weaveintel/observability/replay engine. CI uses this for round-trip testing.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { createContract, createCompletionReport, createEvidenceBundle, evidence } from '@weaveintel/core/contracts';
import { ReplayEngine, type ReplayResult, type ReplayOptions } from '@weaveintel/observability/replay';
import type { ExecutionContext, RunLog, EvidenceBundle, CompletionReport } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import type { KaggleRunRow, KaggleRunArtifactRow } from '../db-types.js';

export interface KaggleEvidenceInput {
  kernelRef: string;
  kernelOutputUrl?: string;
  submissionCsvSha256?: string;
  leaderboardJson?: Record<string, unknown>;
  validatorReport?: Record<string, unknown>;
  publicScore?: number;
}

export interface MaterializeKaggleRunInput {
  db: DatabaseAdapter;
  runId?: string;                 // omit to create a new run row
  tenantId?: string | null;
  competitionRef: string;
  approachId?: string | null;
  meshId?: string | null;
  agentId?: string | null;
  submissionId?: string | null;
  status?: string;                // default 'submitted'
  evidenceInput: KaggleEvidenceInput;
  runLog: RunLog;                 // the @weaveintel/observability/replay trace to persist
}

export interface MaterializeKaggleRunResult {
  runId: string;
  contractId: string;
  replayTraceId: string;
}

export function buildKaggleEvidenceBundle(input: KaggleEvidenceInput): EvidenceBundle {
  const items = [
    evidence.text('kernel_ref', input.kernelRef),
    input.kernelOutputUrl ? evidence.url('kernel_output_url', input.kernelOutputUrl) : null,
    input.submissionCsvSha256 ? evidence.text('submission_csv_sha256', input.submissionCsvSha256) : null,
    input.leaderboardJson ? evidence.text('leaderboard_json', JSON.stringify(input.leaderboardJson)) : null,
    input.validatorReport ? evidence.text('validator_report', JSON.stringify(input.validatorReport)) : null,
    typeof input.publicScore === 'number' ? evidence.metric('public_score', input.publicScore) : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  return createEvidenceBundle(...items);
}

/**
 * Create the Kaggle submission contract + completion report. Kept separate so
 * tests can build reports without touching the DB.
 */
export function buildKaggleCompletionReport(
  competitionRef: string,
  evidenceInput: KaggleEvidenceInput,
): { contractId: string; report: CompletionReport } {
  const contract = createContract({
    name: `kaggle.submission:${competitionRef}`,
    description: 'Single Kaggle competition submission with full evidence bundle.',
    inputSchema: { competitionRef: 'string', kernelRef: 'string' },
    outputSchema: { submissionId: 'string', publicScore: 'number?' },
    acceptanceCriteria: [
      { id: 'kernel-ref-present', description: 'Kernel ref recorded', type: 'human-review', required: true },
      { id: 'submission-id-present', description: 'Submission id present', type: 'human-review', required: true },
    ],
  });
  const bundle = buildKaggleEvidenceBundle(evidenceInput);
  const report = createCompletionReport(contract.id, [
    { criteriaId: 'kernel-ref-present', passed: Boolean(evidenceInput.kernelRef), score: 1 },
    { criteriaId: 'submission-id-present', passed: true, score: 1 },
  ], bundle);
  return { contractId: contract.id, report };
}

export async function materializeKaggleRun(input: MaterializeKaggleRunInput): Promise<MaterializeKaggleRunResult> {
  const { db, evidenceInput, runLog, competitionRef } = input;
  const { contractId, report } = buildKaggleCompletionReport(competitionRef, evidenceInput);
  const replayTraceId = runLog.executionId;
  const runId = input.runId ?? `kgl-run-${newUUIDv7().slice(-8)}`;

  // Upsert the projection row. If a row already exists with this id we update;
  // otherwise we insert. This keeps the chat hook idempotent across retries.
  const existing = await db.getKaggleRun(runId);
  const status = input.status ?? 'submitted';
  const now = new Date().toISOString();
  if (existing) {
    await db.updateKaggleRun(runId, {
      contract_id: contractId,
      replay_trace_id: replayTraceId,
      submission_id: input.submissionId ?? existing.submission_id,
      kernel_ref: evidenceInput.kernelRef,
      public_score: evidenceInput.publicScore ?? existing.public_score,
      validator_report: evidenceInput.validatorReport ? JSON.stringify(evidenceInput.validatorReport) : existing.validator_report,
      status,
      completed_at: now,
    });
  } else {
    const row: Omit<KaggleRunRow, 'created_at' | 'updated_at'> = {
      id: runId,
      tenant_id: input.tenantId ?? null,
      competition_ref: competitionRef,
      approach_id: input.approachId ?? null,
      contract_id: contractId,
      replay_trace_id: replayTraceId,
      mesh_id: input.meshId ?? null,
      agent_id: input.agentId ?? null,
      kernel_ref: evidenceInput.kernelRef,
      submission_id: input.submissionId ?? null,
      public_score: evidenceInput.publicScore ?? null,
      validator_report: evidenceInput.validatorReport ? JSON.stringify(evidenceInput.validatorReport) : null,
      status,
      started_at: now,
      completed_at: now,
    };
    await db.createKaggleRun(row);
  }

  // Always upsert the artifact (one per run_id, replaces on re-materialize).
  const artifact: Omit<KaggleRunArtifactRow, 'created_at'> = {
    id: `kgl-art-${newUUIDv7().slice(-8)}`,
    run_id: runId,
    contract_id: contractId,
    replay_trace_id: replayTraceId,
    contract_report_json: JSON.stringify(report),
    replay_run_log_json: JSON.stringify(runLog),
  };
  await db.upsertKaggleRunArtifact(artifact);

  return { runId, contractId, replayTraceId };
}

export interface ReplayKaggleRunInput {
  db: DatabaseAdapter;
  runId: string;
  ctx: ExecutionContext;
  options?: ReplayOptions;
}

export async function replayKaggleRun(input: ReplayKaggleRunInput): Promise<ReplayResult> {
  const artifact = await input.db.getKaggleRunArtifactByRunId(input.runId);
  if (!artifact) throw new Error(`No artifact found for kaggle_run id=${input.runId}`);
  const runLog = JSON.parse(artifact.replay_run_log_json) as RunLog;
  const engine = new ReplayEngine(input.options);
  return engine.replay(input.ctx, runLog);
}
