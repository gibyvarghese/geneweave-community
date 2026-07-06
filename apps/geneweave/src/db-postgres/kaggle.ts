// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `IKaggleStore` domain slice of the geneWeave `DatabaseAdapter` — hypothesis
 * validation (budget envelopes, hypotheses, sub-claims, verdicts, evidence events, agent dialogue
 * turns) plus the Kaggle projections (tracked competitions, approaches, runs, run artifacts,
 * competition rubrics, validation results, leaderboard scores, live-mesh index, discussion bot
 * settings/log, the competition run ledger + steps/events), the heartbeat-tick / live-mesh-message
 * readers over the live-agents `la_entities` StateStore, and the role capability matrix.
 *
 * Each method mirrors the SQLite implementation in `db-sqlite.ts` statement-for-statement: identical
 * SQL, same column order, same return shapes. SQLite-isms are translated per the porting convention —
 * `?`→`$n`, `datetime('now')`→`${ctx.now}`, text `ORDER BY`→`COLLATE "C"` (byte order; NOT applied to
 * numeric score/index columns), `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`,
 * `INSERT ... ON CONFLICT DO UPDATE` for upserts, and `json_extract(c,'$.x')`→`(c::json->>'x')`.
 * Booleans are INTEGER 0/1 (numbers); JSON columns are TEXT pass-through; INTEGER columns are BIGINT
 * in the schema but read back as numbers (int8 parser); every value is a bound parameter.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  SvBudgetEnvelopeRow,
  SvHypothesisStatus,
  SvHypothesisRow,
  SvSubClaimRow,
  SvVerdictRow,
  SvEvidenceEventRow,
  SvAgentTurnRow,
  KaggleCompetitionTrackedRow,
  KaggleApproachRow,
  KaggleRunRow,
  KaggleRunArtifactRow,
  KaggleDiscussionSettingsRow,
  KaggleDiscussionPostRow,
  KaggleCompetitionRubricRow,
  KaggleValidationResultRow,
  KaggleLeaderboardScoreRow,
  KglRunStatus,
  KglCompetitionRunRow,
  KglRunStepRow,
  KglRunEventRow,
} from '../db-types/kaggle.js';
import type { LiveMeshMessageView } from '../db-types/live-agents.js';

/** ISO-8601-with-millis UTC text, matching SQLite `new Date().toISOString()`. */
const NOW_ISO_MS = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export function pgKaggleStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Budget envelopes ─────────────────────────────────────────────────────
    async createBudgetEnvelope(envelope: Omit<SvBudgetEnvelopeRow, 'created_at'>): Promise<void> {
      const { rows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (rows[0] as { now: string }).now;
      await ctx.query(
        `INSERT INTO hv_budget_envelope
           (id, tenant_id, name, max_llm_cents, max_sandbox_cents, max_wall_seconds,
            max_rounds, diminishing_returns_epsilon, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          envelope.id, envelope.tenant_id, envelope.name,
          envelope.max_llm_cents, envelope.max_sandbox_cents, envelope.max_wall_seconds,
          envelope.max_rounds, envelope.diminishing_returns_epsilon, now,
        ],
      );
    },

    async getBudgetEnvelope(id: string, tenantId: string): Promise<SvBudgetEnvelopeRow | null> {
      const { rows } = await ctx.query('SELECT * FROM hv_budget_envelope WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
      return (rows[0] as SvBudgetEnvelopeRow | undefined) ?? null;
    },

    async listBudgetEnvelopes(tenantId: string): Promise<SvBudgetEnvelopeRow[]> {
      const { rows } = await ctx.query('SELECT * FROM hv_budget_envelope WHERE tenant_id = $1 ORDER BY created_at COLLATE "C" DESC', [tenantId]);
      return rows as unknown as SvBudgetEnvelopeRow[];
    },

    // ─── Hypotheses ───────────────────────────────────────────────────────────
    async createHypothesis(hypothesis: Omit<SvHypothesisRow, 'created_at' | 'updated_at'>): Promise<void> {
      const { rows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (rows[0] as { now: string }).now;
      await ctx.query(
        `INSERT INTO hv_hypothesis
           (id, tenant_id, submitted_by, title, statement, domain_tags, status,
            budget_envelope_id, workflow_run_id, trace_id, contract_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          hypothesis.id, hypothesis.tenant_id, hypothesis.submitted_by,
          hypothesis.title, hypothesis.statement, hypothesis.domain_tags,
          hypothesis.status, hypothesis.budget_envelope_id,
          hypothesis.workflow_run_id ?? null, hypothesis.trace_id ?? null,
          hypothesis.contract_id ?? null, now, now,
        ],
      );
    },

    async getHypothesis(id: string, tenantId: string): Promise<SvHypothesisRow | null> {
      const { rows } = await ctx.query('SELECT * FROM hv_hypothesis WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
      return (rows[0] as SvHypothesisRow | undefined) ?? null;
    },

    async listHypotheses(tenantId: string, limit = 50, offset = 0): Promise<SvHypothesisRow[]> {
      const { rows } = await ctx.query('SELECT * FROM hv_hypothesis WHERE tenant_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2 OFFSET $3', [tenantId, limit, offset]);
      return rows as unknown as SvHypothesisRow[];
    },

    async updateHypothesisStatus(id: string, status: SvHypothesisStatus, updatedAt: string): Promise<void> {
      await ctx.query('UPDATE hv_hypothesis SET status = $1, updated_at = $2 WHERE id = $3', [status, updatedAt, id]);
    },

    async updateHypothesisWorkflowIds(
      id: string,
      opts: { workflowRunId?: string; traceId?: string; contractId?: string; updatedAt: string },
    ): Promise<void> {
      const sets: string[] = ['updated_at = $1'];
      const vals: unknown[] = [opts.updatedAt];
      if (opts.workflowRunId !== undefined) { sets.push(`workflow_run_id = $${vals.length + 1}`); vals.push(opts.workflowRunId); }
      if (opts.traceId !== undefined) { sets.push(`trace_id = $${vals.length + 1}`); vals.push(opts.traceId); }
      if (opts.contractId !== undefined) { sets.push(`contract_id = $${vals.length + 1}`); vals.push(opts.contractId); }
      vals.push(id);
      await ctx.query(`UPDATE hv_hypothesis SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    // ─── Sub-claims ───────────────────────────────────────────────────────────
    async createSubClaim(claim: Omit<SvSubClaimRow, 'created_at'>): Promise<void> {
      const { rows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (rows[0] as { now: string }).now;
      await ctx.query(
        `INSERT INTO hv_sub_claim
           (id, tenant_id, hypothesis_id, parent_sub_claim_id, statement, claim_type,
            testability_score, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          claim.id, claim.tenant_id, claim.hypothesis_id,
          claim.parent_sub_claim_id ?? null, claim.statement,
          claim.claim_type, claim.testability_score, now,
        ],
      );
    },

    async getSubClaim(id: string): Promise<SvSubClaimRow | null> {
      const { rows } = await ctx.query('SELECT * FROM hv_sub_claim WHERE id = $1', [id]);
      return (rows[0] as SvSubClaimRow | undefined) ?? null;
    },

    async listSubClaims(hypothesisId: string): Promise<SvSubClaimRow[]> {
      const { rows } = await ctx.query('SELECT * FROM hv_sub_claim WHERE hypothesis_id = $1 ORDER BY created_at COLLATE "C" ASC', [hypothesisId]);
      return rows as unknown as SvSubClaimRow[];
    },

    // ─── Verdicts ─────────────────────────────────────────────────────────────
    async createVerdict(verdict: Omit<SvVerdictRow, 'created_at'>): Promise<void> {
      const { rows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (rows[0] as { now: string }).now;
      await ctx.query(
        `INSERT INTO hv_verdict
           (id, tenant_id, hypothesis_id, verdict, confidence_lo, confidence_hi,
            key_evidence_ids, falsifiers, limitations, contract_id, replay_trace_id,
            emitted_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          verdict.id, verdict.tenant_id, verdict.hypothesis_id,
          verdict.verdict, verdict.confidence_lo, verdict.confidence_hi,
          verdict.key_evidence_ids, verdict.falsifiers, verdict.limitations,
          verdict.contract_id, verdict.replay_trace_id,
          verdict.emitted_by ?? 'supervisor', now,
        ],
      );
    },

    async getVerdictByHypothesis(hypothesisId: string): Promise<SvVerdictRow | null> {
      const { rows } = await ctx.query('SELECT * FROM hv_verdict WHERE hypothesis_id = $1', [hypothesisId]);
      return (rows[0] as SvVerdictRow | undefined) ?? null;
    },

    async getVerdictById(id: string): Promise<SvVerdictRow | null> {
      const { rows } = await ctx.query('SELECT * FROM hv_verdict WHERE id = $1', [id]);
      return (rows[0] as SvVerdictRow | undefined) ?? null;
    },

    // ─── Evidence events (SSE /events) ────────────────────────────────────────
    async createEvidenceEvent(event: Omit<SvEvidenceEventRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO hv_evidence_event
           (id, hypothesis_id, step_id, agent_id, evidence_id, kind, summary, source_type, tool_key, reproducibility_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${NOW_ISO_MS})`,
        [
          event.id, event.hypothesis_id, event.step_id, event.agent_id,
          event.evidence_id, event.kind, event.summary, event.source_type,
          event.tool_key ?? null, event.reproducibility_hash ?? null,
        ],
      );
    },

    async listEvidenceEvents(hypothesisId: string, afterId?: string, limit = 100): Promise<SvEvidenceEventRow[]> {
      if (afterId) {
        const { rows: anchorRows } = await ctx.query('SELECT created_at FROM hv_evidence_event WHERE id = $1', [afterId]);
        const anchor = anchorRows[0] as { created_at: string } | undefined;
        if (anchor) {
          const { rows } = await ctx.query(
            'SELECT * FROM hv_evidence_event WHERE hypothesis_id = $1 AND created_at > $2 ORDER BY created_at COLLATE "C" ASC LIMIT $3',
            [hypothesisId, anchor.created_at, limit],
          );
          return rows as unknown as SvEvidenceEventRow[];
        }
      }
      const { rows } = await ctx.query('SELECT * FROM hv_evidence_event WHERE hypothesis_id = $1 ORDER BY created_at COLLATE "C" ASC LIMIT $2', [hypothesisId, limit]);
      return rows as unknown as SvEvidenceEventRow[];
    },

    // ─── Agent dialogue turns (SSE /dialogue) ─────────────────────────────────
    async createAgentTurn(turn: Omit<SvAgentTurnRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO hv_agent_turn
           (id, hypothesis_id, round_index, from_agent, to_agent, message, cites_evidence_ids, dissent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${NOW_ISO_MS})`,
        [
          turn.id, turn.hypothesis_id, turn.round_index,
          turn.from_agent, turn.to_agent ?? null, turn.message,
          turn.cites_evidence_ids, turn.dissent ? 1 : 0,
        ],
      );
    },

    async listAgentTurns(hypothesisId: string, afterId?: string, limit = 200): Promise<SvAgentTurnRow[]> {
      if (afterId) {
        const { rows: anchorRows } = await ctx.query('SELECT created_at FROM hv_agent_turn WHERE id = $1', [afterId]);
        const anchor = anchorRows[0] as { created_at: string } | undefined;
        if (anchor) {
          const { rows } = await ctx.query(
            'SELECT * FROM hv_agent_turn WHERE hypothesis_id = $1 AND created_at > $2 ORDER BY created_at COLLATE "C" ASC LIMIT $3',
            [hypothesisId, anchor.created_at, limit],
          );
          return rows as unknown as SvAgentTurnRow[];
        }
      }
      const { rows } = await ctx.query('SELECT * FROM hv_agent_turn WHERE hypothesis_id = $1 ORDER BY created_at COLLATE "C" ASC LIMIT $2', [hypothesisId, limit]);
      return rows as unknown as SvAgentTurnRow[];
    },

    // ─── Phase K3: Kaggle projections ─────────────────────────────────────────
    async upsertKaggleCompetitionTracked(row: Omit<KaggleCompetitionTrackedRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_competitions_tracked
           (id, tenant_id, competition_ref, title, category, deadline, reward, url, status, notes, last_synced_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, ${ctx.now}, ${ctx.now})
         ON CONFLICT(tenant_id, competition_ref) DO UPDATE SET
           title=excluded.title,
           category=excluded.category,
           deadline=excluded.deadline,
           reward=excluded.reward,
           url=excluded.url,
           status=excluded.status,
           notes=excluded.notes,
           last_synced_at=excluded.last_synced_at,
           updated_at=${ctx.now}`,
        [
          row.id, row.tenant_id ?? null, row.competition_ref,
          row.title ?? null, row.category ?? null, row.deadline ?? null,
          row.reward ?? null, row.url ?? null, row.status,
          row.notes ?? null, row.last_synced_at ?? null,
        ],
      );
    },

    async getKaggleCompetitionTracked(id: string): Promise<KaggleCompetitionTrackedRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_competitions_tracked WHERE id = $1', [id]);
      return (rows[0] as KaggleCompetitionTrackedRow | undefined) ?? null;
    },

    async listKaggleCompetitionsTracked(opts: { status?: string; tenantId?: string | null; limit?: number; offset?: number } = {}): Promise<KaggleCompetitionTrackedRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.status)   { where.push(`status = $${params.length + 1}`); params.push(opts.status); }
      if (opts.tenantId !== undefined) {
        if (opts.tenantId === null) where.push('tenant_id IS NULL');
        else { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      }
      params.push(opts.limit ?? 100, opts.offset ?? 0);
      const sql = `SELECT * FROM kaggle_competitions_tracked${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KaggleCompetitionTrackedRow[];
    },

    async updateKaggleCompetitionTracked(id: string, patch: Partial<Omit<KaggleCompetitionTrackedRow, 'id' | 'created_at'>>): Promise<void> {
      const fields: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'updated_at') continue;
        fields.push(`${k} = $${params.length + 1}`);
        params.push(v ?? null);
      }
      if (fields.length === 0) return;
      fields.push(`updated_at = ${ctx.now}`);
      params.push(id);
      await ctx.query(`UPDATE kaggle_competitions_tracked SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
    },

    async deleteKaggleCompetitionTracked(id: string): Promise<void> {
      await ctx.query('DELETE FROM kaggle_competitions_tracked WHERE id = $1', [id]);
    },

    async createKaggleApproach(row: Omit<KaggleApproachRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_approaches
           (id, tenant_id, competition_ref, summary, expected_metric, model, source_kernel_refs, embedding, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${ctx.now}, ${ctx.now})`,
        [
          row.id, row.tenant_id ?? null, row.competition_ref,
          row.summary, row.expected_metric ?? null, row.model ?? null,
          row.source_kernel_refs ?? null, row.embedding ?? null,
          row.status, row.created_by ?? null,
        ],
      );
    },

    async getKaggleApproach(id: string): Promise<KaggleApproachRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_approaches WHERE id = $1', [id]);
      return (rows[0] as KaggleApproachRow | undefined) ?? null;
    },

    async listKaggleApproaches(opts: { competitionRef?: string; status?: string; tenantId?: string | null; limit?: number; offset?: number } = {}): Promise<KaggleApproachRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.competitionRef) { where.push(`competition_ref = $${params.length + 1}`); params.push(opts.competitionRef); }
      if (opts.status)         { where.push(`status = $${params.length + 1}`);          params.push(opts.status); }
      if (opts.tenantId !== undefined) {
        if (opts.tenantId === null) where.push('tenant_id IS NULL');
        else { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      }
      params.push(opts.limit ?? 100, opts.offset ?? 0);
      const sql = `SELECT * FROM kaggle_approaches${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KaggleApproachRow[];
    },

    async updateKaggleApproach(id: string, patch: Partial<Omit<KaggleApproachRow, 'id' | 'created_at'>>): Promise<void> {
      const fields: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'updated_at') continue;
        fields.push(`${k} = $${params.length + 1}`);
        params.push(v ?? null);
      }
      if (fields.length === 0) return;
      fields.push(`updated_at = ${ctx.now}`);
      params.push(id);
      await ctx.query(`UPDATE kaggle_approaches SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
    },

    async deleteKaggleApproach(id: string): Promise<void> {
      await ctx.query('DELETE FROM kaggle_approaches WHERE id = $1', [id]);
    },

    async createKaggleRun(row: Omit<KaggleRunRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_runs
           (id, tenant_id, competition_ref, approach_id, contract_id, replay_trace_id, mesh_id, agent_id,
            kernel_ref, submission_id, public_score, validator_report, status, started_at, completed_at,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, ${ctx.now}, ${ctx.now})`,
        [
          row.id, row.tenant_id ?? null, row.competition_ref,
          row.approach_id ?? null, row.contract_id ?? null, row.replay_trace_id ?? null,
          row.mesh_id ?? null, row.agent_id ?? null,
          row.kernel_ref ?? null, row.submission_id ?? null, row.public_score ?? null,
          row.validator_report ?? null, row.status,
          row.started_at ?? null, row.completed_at ?? null,
        ],
      );
    },

    async getKaggleRun(id: string): Promise<KaggleRunRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_runs WHERE id = $1', [id]);
      return (rows[0] as KaggleRunRow | undefined) ?? null;
    },

    async listKaggleRuns(opts: { competitionRef?: string; approachId?: string; status?: string; tenantId?: string | null; limit?: number; offset?: number } = {}): Promise<KaggleRunRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.competitionRef) { where.push(`competition_ref = $${params.length + 1}`); params.push(opts.competitionRef); }
      if (opts.approachId)     { where.push(`approach_id = $${params.length + 1}`);     params.push(opts.approachId); }
      if (opts.status)         { where.push(`status = $${params.length + 1}`);          params.push(opts.status); }
      if (opts.tenantId !== undefined) {
        if (opts.tenantId === null) where.push('tenant_id IS NULL');
        else { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      }
      params.push(opts.limit ?? 100, opts.offset ?? 0);
      const sql = `SELECT * FROM kaggle_runs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KaggleRunRow[];
    },

    async updateKaggleRun(id: string, patch: Partial<Omit<KaggleRunRow, 'id' | 'created_at'>>): Promise<void> {
      const fields: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'updated_at') continue;
        fields.push(`${k} = $${params.length + 1}`);
        params.push(v ?? null);
      }
      if (fields.length === 0) return;
      fields.push(`updated_at = ${ctx.now}`);
      params.push(id);
      await ctx.query(`UPDATE kaggle_runs SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
    },

    async deleteKaggleRun(id: string): Promise<void> {
      await ctx.query('DELETE FROM kaggle_runs WHERE id = $1', [id]);
    },

    // ─── Phase K4: Kaggle run artifacts ───────────────────────────────────────
    async upsertKaggleRunArtifact(row: Omit<KaggleRunArtifactRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_run_artifacts
           (id, run_id, contract_id, replay_trace_id, contract_report_json, replay_run_log_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, ${ctx.now})
         ON CONFLICT(run_id) DO UPDATE SET
           contract_id = excluded.contract_id,
           replay_trace_id = excluded.replay_trace_id,
           contract_report_json = excluded.contract_report_json,
           replay_run_log_json = excluded.replay_run_log_json`,
        [
          row.id, row.run_id, row.contract_id, row.replay_trace_id,
          row.contract_report_json, row.replay_run_log_json,
        ],
      );
    },

    async getKaggleRunArtifactByRunId(runId: string): Promise<KaggleRunArtifactRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_run_artifacts WHERE run_id = $1', [runId]);
      return (rows[0] as KaggleRunArtifactRow | undefined) ?? null;
    },

    async listKaggleRunArtifacts(opts: { limit?: number; offset?: number } = {}): Promise<KaggleRunArtifactRow[]> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_run_artifacts ORDER BY created_at COLLATE "C" DESC LIMIT $1 OFFSET $2', [opts.limit ?? 100, opts.offset ?? 0]);
      return rows as unknown as KaggleRunArtifactRow[];
    },

    async deleteKaggleRunArtifact(id: string): Promise<void> {
      await ctx.query('DELETE FROM kaggle_run_artifacts WHERE id = $1', [id]);
    },

    // ─── Phase K5: Kaggle live-agents mesh index ──────────────────────────────
    async upsertKaggleLiveMesh(row: { mesh_id: string; tenant_id: string; kaggle_username: string }): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_live_mesh_index (mesh_id, tenant_id, kaggle_username, created_at)
         VALUES ($1, $2, $3, ${ctx.now})
         ON CONFLICT(mesh_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           kaggle_username = excluded.kaggle_username`,
        [row.mesh_id, row.tenant_id, row.kaggle_username],
      );
    },

    async listKaggleLiveMeshes(opts: { tenantId?: string } = {}): Promise<Array<{ mesh_id: string; tenant_id: string; kaggle_username: string; created_at: string }>> {
      if (opts.tenantId) {
        const { rows } = await ctx.query('SELECT mesh_id, tenant_id, kaggle_username, created_at FROM kaggle_live_mesh_index WHERE tenant_id = $1 ORDER BY created_at COLLATE "C" DESC', [opts.tenantId]);
        return rows as unknown as Array<{ mesh_id: string; tenant_id: string; kaggle_username: string; created_at: string }>;
      }
      const { rows } = await ctx.query('SELECT mesh_id, tenant_id, kaggle_username, created_at FROM kaggle_live_mesh_index ORDER BY created_at COLLATE "C" DESC', []);
      return rows as unknown as Array<{ mesh_id: string; tenant_id: string; kaggle_username: string; created_at: string }>;
    },

    // ─── Phase K6: Kaggle discussion bot (kill switch + log) ──────────────────
    async getKaggleDiscussionSettings(tenantId: string): Promise<KaggleDiscussionSettingsRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_discussion_settings WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as KaggleDiscussionSettingsRow | undefined) ?? null;
    },

    async listKaggleDiscussionSettings(): Promise<KaggleDiscussionSettingsRow[]> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_discussion_settings ORDER BY tenant_id COLLATE "C"', []);
      return rows as unknown as KaggleDiscussionSettingsRow[];
    },

    async upsertKaggleDiscussionSettings(row: { tenant_id: string; discussion_enabled: number; notes?: string | null }): Promise<KaggleDiscussionSettingsRow> {
      const { rows: existingRows } = await ctx.query('SELECT id FROM kaggle_discussion_settings WHERE tenant_id = $1', [row.tenant_id]);
      const existing = existingRows[0] as { id: string } | undefined;
      const id = existing?.id ?? newUUIDv7();
      await ctx.query(
        `INSERT INTO kaggle_discussion_settings (id, tenant_id, discussion_enabled, notes, updated_at)
         VALUES ($1, $2, $3, $4, ${ctx.now})
         ON CONFLICT(tenant_id) DO UPDATE SET
           discussion_enabled = excluded.discussion_enabled,
           notes = excluded.notes,
           updated_at = ${ctx.now}`,
        [id, row.tenant_id, row.discussion_enabled ? 1 : 0, row.notes ?? null],
      );
      const { rows } = await ctx.query('SELECT * FROM kaggle_discussion_settings WHERE tenant_id = $1', [row.tenant_id]);
      return rows[0] as unknown as KaggleDiscussionSettingsRow;
    },

    async isKaggleDiscussionEnabledForTenant(tenantId: string): Promise<boolean> {
      const { rows } = await ctx.query('SELECT discussion_enabled FROM kaggle_discussion_settings WHERE tenant_id = $1', [tenantId]);
      const row = rows[0] as { discussion_enabled: number } | undefined;
      return row?.discussion_enabled === 1;
    },

    async recordKaggleDiscussionPost(row: Omit<KaggleDiscussionPostRow, 'posted_at'> & { posted_at?: string }): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_discussion_posts (
           id, tenant_id, competition_ref, topic_id, parent_topic_id, title,
           body_preview, url, status, contract_id, replay_trace_id, posted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, ${ctx.now}))
         ON CONFLICT DO NOTHING`,
        [
          row.id,
          row.tenant_id,
          row.competition_ref,
          row.topic_id,
          row.parent_topic_id,
          row.title,
          row.body_preview,
          row.url,
          row.status,
          row.contract_id,
          row.replay_trace_id,
          row.posted_at ?? null,
        ],
      );
    },

    async listKaggleDiscussionPosts(opts: { tenantId?: string; competitionRef?: string; limit?: number; offset?: number } = {}): Promise<KaggleDiscussionPostRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.tenantId) { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      if (opts.competitionRef) { where.push(`competition_ref = $${params.length + 1}`); params.push(opts.competitionRef); }
      params.push(opts.limit ?? 100, opts.offset ?? 0);
      const sql = `SELECT * FROM kaggle_discussion_posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY posted_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KaggleDiscussionPostRow[];
    },

    async getKaggleDiscussionPost(id: string): Promise<KaggleDiscussionPostRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_discussion_posts WHERE id = $1', [id]);
      return (rows[0] as KaggleDiscussionPostRow | undefined) ?? null;
    },

    // ─── Phase K7d — Submission validation ────────────────────────────────────
    async upsertKaggleCompetitionRubric(row: Omit<KaggleCompetitionRubricRow, 'created_at' | 'updated_at'>): Promise<KaggleCompetitionRubricRow> {
      // Upsert by (tenant_id, competition_ref). Mirrors the SQLite read-then-write path.
      const existing = await this.getKaggleCompetitionRubricByRef!(row.competition_ref, row.tenant_id ?? null);
      const { rows: nowRows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (nowRows[0] as { now: string }).now;
      if (existing) {
        await ctx.query(
          `UPDATE kaggle_competition_rubric SET
             metric_name = $1, metric_direction = $2, baseline_score = $3, target_score = $4,
             expected_row_count = $5, id_column = $6, id_range_min = $7, id_range_max = $8,
             target_column = $9, target_type = $10, expected_distribution_json = $11,
             sample_submission_sha256 = $12, inference_source = $13, auto_generated = $14,
             inferred_at = $15, notes = $16, updated_at = $17
           WHERE id = $18`,
          [
            row.metric_name, row.metric_direction, row.baseline_score, row.target_score,
            row.expected_row_count, row.id_column, row.id_range_min, row.id_range_max,
            row.target_column, row.target_type, row.expected_distribution_json,
            row.sample_submission_sha256, row.inference_source, row.auto_generated,
            row.inferred_at, row.notes, now,
            existing.id,
          ],
        );
        return (await this.getKaggleCompetitionRubric!(existing.id))!;
      }
      await ctx.query(
        `INSERT INTO kaggle_competition_rubric (
           id, tenant_id, competition_ref, metric_name, metric_direction,
           baseline_score, target_score, expected_row_count, id_column,
           id_range_min, id_range_max, target_column, target_type,
           expected_distribution_json, sample_submission_sha256, inference_source,
           auto_generated, inferred_at, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [
          row.id, row.tenant_id, row.competition_ref, row.metric_name, row.metric_direction,
          row.baseline_score, row.target_score, row.expected_row_count, row.id_column,
          row.id_range_min, row.id_range_max, row.target_column, row.target_type,
          row.expected_distribution_json, row.sample_submission_sha256, row.inference_source,
          row.auto_generated, row.inferred_at, row.notes, now, now,
        ],
      );
      return (await this.getKaggleCompetitionRubric!(row.id))!;
    },

    async getKaggleCompetitionRubric(id: string): Promise<KaggleCompetitionRubricRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_competition_rubric WHERE id = $1', [id]);
      return (rows[0] as KaggleCompetitionRubricRow | undefined) ?? null;
    },

    async getKaggleCompetitionRubricByRef(competitionRef: string, tenantId: string | null = null): Promise<KaggleCompetitionRubricRow | null> {
      const sql = tenantId
        ? `SELECT * FROM kaggle_competition_rubric WHERE competition_ref = $1 AND tenant_id = $2`
        : `SELECT * FROM kaggle_competition_rubric WHERE competition_ref = $1 AND tenant_id IS NULL`;
      const params: unknown[] = tenantId ? [competitionRef, tenantId] : [competitionRef];
      const { rows } = await ctx.query(sql, params);
      return (rows[0] as KaggleCompetitionRubricRow | undefined) ?? null;
    },

    async listKaggleCompetitionRubrics(opts: { competitionRef?: string; tenantId?: string | null; limit?: number; offset?: number } = {}): Promise<KaggleCompetitionRubricRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.competitionRef) { where.push(`competition_ref = $${params.length + 1}`); params.push(opts.competitionRef); }
      if (opts.tenantId !== undefined) {
        if (opts.tenantId === null) { where.push('tenant_id IS NULL'); }
        else { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      }
      params.push(opts.limit ?? 100, opts.offset ?? 0);
      const sql = `SELECT * FROM kaggle_competition_rubric ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KaggleCompetitionRubricRow[];
    },

    async updateKaggleCompetitionRubric(id: string, patch: Partial<Omit<KaggleCompetitionRubricRow, 'id' | 'created_at'>>): Promise<void> {
      const cols = Object.keys(patch);
      if (cols.length === 0) return;
      const params: unknown[] = cols.map((c) => (patch as Record<string, unknown>)[c]);
      const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const { rows: nowRows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (nowRows[0] as { now: string }).now;
      params.push(now);
      params.push(id);
      await ctx.query(`UPDATE kaggle_competition_rubric SET ${setSql}, updated_at = $${params.length - 1} WHERE id = $${params.length}`, params);
    },

    async deleteKaggleCompetitionRubric(id: string): Promise<void> {
      await ctx.query('DELETE FROM kaggle_competition_rubric WHERE id = $1', [id]);
    },

    async createKaggleValidationResult(row: Omit<KaggleValidationResultRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_validation_results (
           id, run_id, competition_ref, rubric_id, kernel_ref,
           schema_check_passed, distribution_check_passed, baseline_check_passed,
           cv_score, cv_std, cv_metric, n_folds,
           predicted_distribution_json, violations_json, verdict, summary, validated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          row.id, row.run_id, row.competition_ref, row.rubric_id, row.kernel_ref,
          row.schema_check_passed, row.distribution_check_passed, row.baseline_check_passed,
          row.cv_score, row.cv_std, row.cv_metric, row.n_folds,
          row.predicted_distribution_json, row.violations_json, row.verdict, row.summary, row.validated_at,
        ],
      );
    },

    async getKaggleValidationResult(id: string): Promise<KaggleValidationResultRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_validation_results WHERE id = $1', [id]);
      return (rows[0] as KaggleValidationResultRow | undefined) ?? null;
    },

    async listKaggleValidationResults(opts: { runId?: string; competitionRef?: string; verdict?: string; limit?: number; offset?: number } = {}): Promise<KaggleValidationResultRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.runId) { where.push(`run_id = $${params.length + 1}`); params.push(opts.runId); }
      if (opts.competitionRef) { where.push(`competition_ref = $${params.length + 1}`); params.push(opts.competitionRef); }
      if (opts.verdict) { where.push(`verdict = $${params.length + 1}`); params.push(opts.verdict); }
      params.push(opts.limit ?? 100, opts.offset ?? 0);
      const sql = `SELECT * FROM kaggle_validation_results ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KaggleValidationResultRow[];
    },

    async deleteKaggleValidationResult(id: string): Promise<void> {
      await ctx.query('DELETE FROM kaggle_validation_results WHERE id = $1', [id]);
    },

    async createKaggleLeaderboardScore(row: Omit<KaggleLeaderboardScoreRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_leaderboard_scores (
           id, run_id, competition_ref, submission_id,
           public_score, private_score, cv_lb_delta, percentile_estimate,
           rank_estimate, leaderboard_size, raw_status, observed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          row.id, row.run_id, row.competition_ref, row.submission_id,
          row.public_score, row.private_score, row.cv_lb_delta, row.percentile_estimate,
          row.rank_estimate, row.leaderboard_size, row.raw_status, row.observed_at,
        ],
      );
    },

    async getKaggleLeaderboardScore(id: string): Promise<KaggleLeaderboardScoreRow | null> {
      const { rows } = await ctx.query('SELECT * FROM kaggle_leaderboard_scores WHERE id = $1', [id]);
      return (rows[0] as KaggleLeaderboardScoreRow | undefined) ?? null;
    },

    async listKaggleLeaderboardScores(opts: { runId?: string; competitionRef?: string; limit?: number; offset?: number } = {}): Promise<KaggleLeaderboardScoreRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.runId) { where.push(`run_id = $${params.length + 1}`); params.push(opts.runId); }
      if (opts.competitionRef) { where.push(`competition_ref = $${params.length + 1}`); params.push(opts.competitionRef); }
      params.push(opts.limit ?? 100, opts.offset ?? 0);
      const sql = `SELECT * FROM kaggle_leaderboard_scores ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KaggleLeaderboardScoreRow[];
    },

    async deleteKaggleLeaderboardScore(id: string): Promise<void> {
      await ctx.query('DELETE FROM kaggle_leaderboard_scores WHERE id = $1', [id]);
    },

    // ─── Phase K8 — Kaggle competition run ledger ─────────────────────────────
    async createKglCompetitionRun(row: Omit<KglCompetitionRunRow, 'created_at' | 'updated_at' | 'step_count' | 'event_count'>): Promise<KglCompetitionRunRow> {
      const { rows: nowRows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (nowRows[0] as { now: string }).now;
      await ctx.query(
        `INSERT INTO kgl_competition_run (
           id, tenant_id, submitted_by, competition_ref, title, objective,
           mesh_id, status, step_count, event_count, summary,
           started_at, completed_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $9, $10, $11, $12, $13)`,
        [
          row.id, row.tenant_id, row.submitted_by, row.competition_ref,
          row.title ?? null, row.objective ?? null, row.mesh_id ?? null,
          row.status, row.summary ?? null,
          row.started_at ?? null, row.completed_at ?? null, now, now,
        ],
      );
      return (await this.getKglCompetitionRun!(row.id))!;
    },

    async getKglCompetitionRun(id: string, tenantId?: string | null): Promise<KglCompetitionRunRow | null> {
      const sql = tenantId
        ? `SELECT * FROM kgl_competition_run WHERE id = $1 AND tenant_id = $2`
        : `SELECT * FROM kgl_competition_run WHERE id = $1`;
      const params: unknown[] = tenantId ? [id, tenantId] : [id];
      const { rows } = await ctx.query(sql, params);
      return (rows[0] as KglCompetitionRunRow | undefined) ?? null;
    },

    async listKglCompetitionRuns(opts: { tenantId?: string | null; status?: KglRunStatus; competitionRef?: string; limit?: number; offset?: number } = {}): Promise<KglCompetitionRunRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.tenantId) { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      if (opts.status) { where.push(`status = $${params.length + 1}`); params.push(opts.status); }
      if (opts.competitionRef) { where.push(`competition_ref = $${params.length + 1}`); params.push(opts.competitionRef); }
      params.push(opts.limit ?? 50, opts.offset ?? 0);
      const sql = `SELECT * FROM kgl_competition_run ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KglCompetitionRunRow[];
    },

    async updateKglCompetitionRun(id: string, patch: Partial<Omit<KglCompetitionRunRow, 'id' | 'created_at'>>): Promise<void> {
      const fields: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        fields.push(`${k} = $${params.length + 1}`);
        params.push(v as unknown);
      }
      if (!fields.length) return;
      const { rows: nowRows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (nowRows[0] as { now: string }).now;
      fields.push(`updated_at = $${params.length + 1}`);
      params.push(now);
      params.push(id);
      await ctx.query(`UPDATE kgl_competition_run SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
    },

    async appendKglRunStep(row: Omit<KglRunStepRow, 'created_at' | 'updated_at'>): Promise<KglRunStepRow> {
      const { rows: nowRows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (nowRows[0] as { now: string }).now;
      await ctx.query(
        `INSERT INTO kgl_run_step (
           id, run_id, step_index, role, title, description, agent_id,
           status, started_at, completed_at, summary, input_preview, output_preview,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          row.id, row.run_id, row.step_index, row.role, row.title, row.description ?? null,
          row.agent_id ?? null, row.status, row.started_at ?? null, row.completed_at ?? null,
          row.summary ?? null, row.input_preview ?? null, row.output_preview ?? null, now, now,
        ],
      );
      await ctx.query('UPDATE kgl_competition_run SET step_count = step_count + 1, updated_at = $1 WHERE id = $2', [now, row.run_id]);
      const { rows } = await ctx.query('SELECT * FROM kgl_run_step WHERE id = $1', [row.id]);
      return rows[0] as unknown as KglRunStepRow;
    },

    async updateKglRunStep(id: string, patch: Partial<Omit<KglRunStepRow, 'id' | 'run_id' | 'created_at'>>): Promise<void> {
      const fields: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        fields.push(`${k} = $${params.length + 1}`);
        params.push(v as unknown);
      }
      if (!fields.length) return;
      const { rows: nowRows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (nowRows[0] as { now: string }).now;
      fields.push(`updated_at = $${params.length + 1}`);
      params.push(now);
      params.push(id);
      await ctx.query(`UPDATE kgl_run_step SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
    },

    async listKglRunSteps(runId: string): Promise<KglRunStepRow[]> {
      const { rows } = await ctx.query('SELECT * FROM kgl_run_step WHERE run_id = $1 ORDER BY step_index ASC, created_at COLLATE "C" ASC', [runId]);
      return rows as unknown as KglRunStepRow[];
    },

    async appendKglRunEvent(row: Omit<KglRunEventRow, 'created_at'>): Promise<KglRunEventRow> {
      const { rows: nowRows } = await ctx.query(`SELECT ${NOW_ISO_MS} AS now`, []);
      const now = (nowRows[0] as { now: string }).now;
      await ctx.query(
        `INSERT INTO kgl_run_event (
           id, run_id, step_id, kind, agent_id, tool_key, summary, payload_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.id, row.run_id, row.step_id ?? null, row.kind, row.agent_id ?? null,
          row.tool_key ?? null, row.summary, row.payload_json ?? null, now,
        ],
      );
      await ctx.query('UPDATE kgl_competition_run SET event_count = event_count + 1, updated_at = $1 WHERE id = $2', [now, row.run_id]);
      const { rows } = await ctx.query('SELECT * FROM kgl_run_event WHERE id = $1', [row.id]);
      return rows[0] as unknown as KglRunEventRow;
    },

    async listKglRunEvents(runId: string, opts: { afterId?: string; limit?: number } = {}): Promise<KglRunEventRow[]> {
      const where: string[] = ['run_id = $1'];
      const params: unknown[] = [runId];
      if (opts.afterId) { where.push(`id > $${params.length + 1}`); params.push(opts.afterId); }
      params.push(opts.limit ?? 200);
      const sql = `SELECT * FROM kgl_run_event WHERE ${where.join(' AND ')} ORDER BY id COLLATE "C" ASC LIMIT $${params.length}`;
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as KglRunEventRow[];
    },

    /**
     * Read recent heartbeat_tick rows for a single agent out of the live-agents StateStore
     * (la_entities, entity_type='heartbeat_tick'), ordered by scheduledFor desc. Used by the kaggle
     * heartbeat scheduler for backoff-on-failure / circuit-breaker logic.
     */
    async listRecentHeartbeatTicksForAgent(agentId: string, limit: number = 20): Promise<Array<{
      id: string;
      status: string;
      actionOutcomeStatus: string | null;
      actionOutcomeProse: string | null;
      scheduledFor: string;
      completedAt: string | null;
    }>> {
      const { rows } = await ctx.query(
        `SELECT payload_json FROM la_entities
         WHERE entity_type = 'heartbeat_tick'
           AND (payload_json::json->>'agentId') = $1
         ORDER BY (payload_json::json->>'scheduledFor') COLLATE "C" DESC
         LIMIT $2`,
        [agentId, limit],
      );
      const out: Array<{
        id: string;
        status: string;
        actionOutcomeStatus: string | null;
        actionOutcomeProse: string | null;
        scheduledFor: string;
        completedAt: string | null;
      }> = [];
      for (const r of rows as unknown as Array<{ payload_json: string }>) {
        try {
          const p = JSON.parse(r.payload_json) as Record<string, unknown>;
          out.push({
            id: String(p['id'] ?? ''),
            status: String(p['status'] ?? ''),
            actionOutcomeStatus: (p['actionOutcomeStatus'] as string | null) ?? null,
            actionOutcomeProse: (p['actionOutcomeProse'] as string | null) ?? null,
            scheduledFor: String(p['scheduledFor'] ?? ''),
            completedAt: (p['completedAt'] as string | null) ?? null,
          });
        } catch { /* skip malformed */ }
      }
      return out;
    },

    /**
     * Read inter-agent messages for a mesh out of the live-agents StateStore (la_entities,
     * entity_type='message'). Best-effort — returns [] when la_entities is empty or payload_json is
     * malformed.
     */
    async listLiveMeshMessages(meshId: string, opts: { limit?: number } = {}): Promise<LiveMeshMessageView[]> {
      const limit = opts.limit ?? 500;
      const { rows } = await ctx.query(
        `SELECT id, payload_json FROM la_entities
         WHERE entity_type = 'message'
         ORDER BY updated_at COLLATE "C" DESC
         LIMIT $1`,
        [limit],
      );
      const out: LiveMeshMessageView[] = [];
      for (const r of rows as unknown as Array<{ id: string; payload_json: string }>) {
        try {
          const p = JSON.parse(r.payload_json) as Record<string, unknown>;
          if (p['meshId'] !== meshId && p['fromMeshId'] !== meshId) continue;
          out.push({
            id: r.id,
            meshId: (p['meshId'] as string | null) ?? null,
            fromType: (p['fromType'] as string | null) ?? null,
            fromId: (p['fromId'] as string | null) ?? null,
            toType: (p['toType'] as string | null) ?? null,
            toId: (p['toId'] as string | null) ?? null,
            topic: (p['topic'] as string | null) ?? null,
            kind: (p['kind'] as string | null) ?? null,
            subject: (p['subject'] as string | null) ?? null,
            body: (p['body'] as string | null) ?? null,
            status: (p['status'] as string | null) ?? null,
            createdAt: (p['createdAt'] as string | null) ?? null,
            deliveredAt: (p['deliveredAt'] as string | null) ?? null,
            readAt: (p['readAt'] as string | null) ?? null,
            processedAt: (p['processedAt'] as string | null) ?? null,
          });
        } catch { /* ignore malformed row */ }
      }
      out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
      return out;
    },

    // ─── Kaggle role capability matrix (M45) ──────────────────────────────────
    async getKaggleRoleCapabilityMatrix(): Promise<Record<string, string[]>> {
      const { rows } = await ctx.query('SELECT role, capabilities FROM kaggle_role_capabilities', []);
      const result: Record<string, string[]> = {};
      for (const row of rows as unknown as Array<{ role: string; capabilities: string }>) {
        try { result[row.role] = JSON.parse(row.capabilities) as string[]; } catch { /* skip malformed */ }
      }
      return result;
    },

    async upsertKaggleRoleCapability(role: string, capabilities: string[], updatedBy: string | null): Promise<void> {
      await ctx.query(
        `INSERT INTO kaggle_role_capabilities (role, capabilities, updated_at, updated_by) VALUES ($1, $2, ${ctx.now}, $3)
         ON CONFLICT(role) DO UPDATE SET capabilities = excluded.capabilities, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [role, JSON.stringify(capabilities), updatedBy],
      );
    },
  };
}
