import type { SvBudgetEnvelopeRow, SvHypothesisStatus, SvHypothesisRow, SvSubClaimRow, SvVerdictRow, SvEvidenceEventRow, SvAgentTurnRow, KaggleCompetitionTrackedRow, KaggleApproachRow, KaggleRunRow, KaggleRunArtifactRow, KaggleDiscussionSettingsRow, KaggleDiscussionPostRow, KaggleCompetitionRubricRow, KaggleValidationResultRow, KaggleLeaderboardScoreRow, KglRunStatus, KglCompetitionRunRow, KglRunStepRow, KglRunEventRow } from './kaggle.js';
import type { LiveMeshMessageView } from './live-agents.js';

export interface IKaggleStore {
  // Budget envelopes
  createBudgetEnvelope(envelope: Omit<SvBudgetEnvelopeRow, 'created_at'>): Promise<void>;
  getBudgetEnvelope(id: string, tenantId: string): Promise<SvBudgetEnvelopeRow | null>;
  listBudgetEnvelopes(tenantId: string): Promise<SvBudgetEnvelopeRow[]>;

  // Hypotheses
  createHypothesis(hypothesis: Omit<SvHypothesisRow, 'created_at' | 'updated_at'>): Promise<void>;
  getHypothesis(id: string, tenantId: string): Promise<SvHypothesisRow | null>;
  listHypotheses(tenantId: string, limit?: number, offset?: number): Promise<SvHypothesisRow[]>;
  updateHypothesisStatus(id: string, status: SvHypothesisStatus, updatedAt: string): Promise<void>;
  updateHypothesisWorkflowIds(id: string, opts: { workflowRunId?: string; traceId?: string; contractId?: string; updatedAt: string }): Promise<void>;

  // Sub-claims
  createSubClaim(claim: Omit<SvSubClaimRow, 'created_at'>): Promise<void>;
  getSubClaim(id: string): Promise<SvSubClaimRow | null>;
  listSubClaims(hypothesisId: string): Promise<SvSubClaimRow[]>;

  // Verdicts
  createVerdict(verdict: Omit<SvVerdictRow, 'created_at'>): Promise<void>;
  getVerdictByHypothesis(hypothesisId: string): Promise<SvVerdictRow | null>;
  getVerdictById(id: string): Promise<SvVerdictRow | null>;

  // Evidence events
  createEvidenceEvent(event: Omit<SvEvidenceEventRow, 'created_at'>): Promise<void>;
  listEvidenceEvents(hypothesisId: string, afterId?: string, limit?: number): Promise<SvEvidenceEventRow[]>;

  // Agent dialogue turns
  createAgentTurn(turn: Omit<SvAgentTurnRow, 'created_at'>): Promise<void>;
  listAgentTurns(hypothesisId: string, afterId?: string, limit?: number): Promise<SvAgentTurnRow[]>;

  // Kaggle competitions
  upsertKaggleCompetitionTracked(row: Omit<KaggleCompetitionTrackedRow, 'created_at' | 'updated_at'>): Promise<void>;
  getKaggleCompetitionTracked(id: string): Promise<KaggleCompetitionTrackedRow | null>;
  listKaggleCompetitionsTracked(opts?: { status?: string; tenantId?: string | null; limit?: number; offset?: number }): Promise<KaggleCompetitionTrackedRow[]>;
  updateKaggleCompetitionTracked(id: string, patch: Partial<Omit<KaggleCompetitionTrackedRow, 'id' | 'created_at'>>): Promise<void>;
  deleteKaggleCompetitionTracked(id: string): Promise<void>;

  // Approaches
  createKaggleApproach(row: Omit<KaggleApproachRow, 'created_at' | 'updated_at'>): Promise<void>;
  getKaggleApproach(id: string): Promise<KaggleApproachRow | null>;
  listKaggleApproaches(opts?: { competitionRef?: string; status?: string; tenantId?: string | null; limit?: number; offset?: number }): Promise<KaggleApproachRow[]>;
  updateKaggleApproach(id: string, patch: Partial<Omit<KaggleApproachRow, 'id' | 'created_at'>>): Promise<void>;
  deleteKaggleApproach(id: string): Promise<void>;

  // Runs
  createKaggleRun(row: Omit<KaggleRunRow, 'created_at' | 'updated_at'>): Promise<void>;
  getKaggleRun(id: string): Promise<KaggleRunRow | null>;
  listKaggleRuns(opts?: { competitionRef?: string; approachId?: string; status?: string; tenantId?: string | null; limit?: number; offset?: number }): Promise<KaggleRunRow[]>;
  updateKaggleRun(id: string, patch: Partial<Omit<KaggleRunRow, 'id' | 'created_at'>>): Promise<void>;
  deleteKaggleRun(id: string): Promise<void>;

  // Run artifacts
  upsertKaggleRunArtifact(row: Omit<KaggleRunArtifactRow, 'created_at'>): Promise<void>;
  getKaggleRunArtifactByRunId(runId: string): Promise<KaggleRunArtifactRow | null>;
  listKaggleRunArtifacts(opts?: { limit?: number; offset?: number }): Promise<KaggleRunArtifactRow[]>;
  deleteKaggleRunArtifact(id: string): Promise<void>;

  // Competition rubrics
  upsertKaggleCompetitionRubric(row: Omit<KaggleCompetitionRubricRow, 'created_at' | 'updated_at'>): Promise<KaggleCompetitionRubricRow>;
  getKaggleCompetitionRubric(id: string): Promise<KaggleCompetitionRubricRow | null>;
  getKaggleCompetitionRubricByRef(competitionRef: string, tenantId?: string | null): Promise<KaggleCompetitionRubricRow | null>;
  listKaggleCompetitionRubrics(opts?: { competitionRef?: string; tenantId?: string | null; limit?: number; offset?: number }): Promise<KaggleCompetitionRubricRow[]>;
  updateKaggleCompetitionRubric(id: string, patch: Partial<Omit<KaggleCompetitionRubricRow, 'id' | 'created_at'>>): Promise<void>;
  deleteKaggleCompetitionRubric(id: string): Promise<void>;
  createKaggleValidationResult(row: Omit<KaggleValidationResultRow, 'created_at'>): Promise<void>;
  getKaggleValidationResult(id: string): Promise<KaggleValidationResultRow | null>;
  listKaggleValidationResults(opts?: { runId?: string; competitionRef?: string; verdict?: string; limit?: number; offset?: number }): Promise<KaggleValidationResultRow[]>;
  deleteKaggleValidationResult(id: string): Promise<void>;
  createKaggleLeaderboardScore(row: Omit<KaggleLeaderboardScoreRow, 'created_at'>): Promise<void>;
  getKaggleLeaderboardScore(id: string): Promise<KaggleLeaderboardScoreRow | null>;
  listKaggleLeaderboardScores(opts?: { runId?: string; competitionRef?: string; limit?: number; offset?: number }): Promise<KaggleLeaderboardScoreRow[]>;
  deleteKaggleLeaderboardScore(id: string): Promise<void>;

  // Live-agents Kaggle mesh index
  upsertKaggleLiveMesh(row: { mesh_id: string; tenant_id: string; kaggle_username: string }): Promise<void>;
  listKaggleLiveMeshes(opts?: { tenantId?: string }): Promise<Array<{ mesh_id: string; tenant_id: string; kaggle_username: string; created_at: string }>>;

  // Discussion bot
  getKaggleDiscussionSettings(tenantId: string): Promise<KaggleDiscussionSettingsRow | null>;
  listKaggleDiscussionSettings(): Promise<KaggleDiscussionSettingsRow[]>;
  upsertKaggleDiscussionSettings(row: { tenant_id: string; discussion_enabled: number; notes?: string | null }): Promise<KaggleDiscussionSettingsRow>;
  isKaggleDiscussionEnabledForTenant(tenantId: string): Promise<boolean>;
  recordKaggleDiscussionPost(row: Omit<KaggleDiscussionPostRow, 'posted_at'> & { posted_at?: string }): Promise<void>;
  listKaggleDiscussionPosts(opts?: { tenantId?: string; competitionRef?: string; limit?: number; offset?: number }): Promise<KaggleDiscussionPostRow[]>;
  getKaggleDiscussionPost(id: string): Promise<KaggleDiscussionPostRow | null>;

  // Competition run ledger
  createKglCompetitionRun(row: Omit<KglCompetitionRunRow, 'created_at' | 'updated_at' | 'step_count' | 'event_count'>): Promise<KglCompetitionRunRow>;
  getKglCompetitionRun(id: string, tenantId?: string | null): Promise<KglCompetitionRunRow | null>;
  listKglCompetitionRuns(opts?: { tenantId?: string | null; status?: KglRunStatus; competitionRef?: string; limit?: number; offset?: number }): Promise<KglCompetitionRunRow[]>;
  updateKglCompetitionRun(id: string, patch: Partial<Omit<KglCompetitionRunRow, 'id' | 'created_at'>>): Promise<void>;
  appendKglRunStep(row: Omit<KglRunStepRow, 'created_at' | 'updated_at'>): Promise<KglRunStepRow>;
  updateKglRunStep(id: string, patch: Partial<Omit<KglRunStepRow, 'id' | 'run_id' | 'created_at'>>): Promise<void>;
  listKglRunSteps(runId: string): Promise<KglRunStepRow[]>;
  appendKglRunEvent(row: Omit<KglRunEventRow, 'created_at'>): Promise<KglRunEventRow>;
  listKglRunEvents(runId: string, opts?: { afterId?: string; limit?: number }): Promise<KglRunEventRow[]>;

  // Heartbeat ticks (for Kaggle backoff logic)
  listRecentHeartbeatTicksForAgent(agentId: string, limit?: number): Promise<Array<{ id: string; status: string; actionOutcomeStatus: string | null; actionOutcomeProse: string | null; scheduledFor: string; completedAt: string | null }>>;

  // Live mesh messages
  listLiveMeshMessages(meshId: string, opts?: { limit?: number }): Promise<LiveMeshMessageView[]>;

  // Role capability matrix (DB-configurable, fallback to code constants)
  getKaggleRoleCapabilityMatrix(): Promise<Record<string, string[]>>;
  upsertKaggleRoleCapability(role: string, capabilities: string[], updatedBy: string | null): Promise<void>;
}
