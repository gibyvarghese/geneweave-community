/**
 * Phase K3 — Kaggle admin CRUD routes
 *
 * Three projection tables surface here:
 *  - kaggle_competitions_tracked  (operator's watchlist)
 *  - kaggle_approaches            (candidate modeling approaches per competition)
 *  - kaggle_runs                  (kernel push + submission lifecycle)
 *
 * Source of truth for evidence + agent decisions remains @weaveintel/core/contracts
 * and live-agents StateStore. These admin routes are the operator window into
 * what GeneWeave has materialized.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { KglCompetitionRunRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { materializeKaggleRun, replayKaggleRun, type MaterializeKaggleRunInput } from '../../lib/kaggle.js';
import { createDbBackedIdempotencyStore } from '../../lib/durable-idempotency-store.js';
import type { ExecutionContext, RunLog } from '@weaveintel/core';

// Phase B (Durable consumers): admin Kaggle run replays now share the
// `idempotency_records` table, so duplicate requests with the same
// Idempotency-Key return the original row across process restarts.
// 24h window matches the original ttlMs.

const COMP_BASE = '/api/admin/kaggle-competitions';
const APP_BASE  = '/api/admin/kaggle-approaches';
const RUN_BASE  = '/api/admin/kaggle-runs';
const KGL_RUN_BASE = '/api/admin/kaggle-competition-runs';

function makeId(prefix: string): string {
  return `${prefix}-${newUUIDv7().slice(-8)}`;
}

// ─── Competitions Tracked ──────────────────────────────────────────────────

export function registerKaggleCompetitionRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(COMP_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const status = url.searchParams.get('status') ?? undefined;
    const items = await db.listKaggleCompetitionsTracked({
      ...(status ? { status } : {}),
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });
    json(res, 200, { 'kaggle-competitions': items });
  }, { auth: true });

  router.get(`${COMP_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getKaggleCompetitionTracked(params['id']!);
    if (!item) { json(res, 404, { error: 'Tracked competition not found' }); return; }
    json(res, 200, { 'kaggle-competition': item });
  }, { auth: true });

  router.post(COMP_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['competition_ref']) { json(res, 400, { error: 'competition_ref required' }); return; }
    const id = makeId('kgl-comp');
    await db.upsertKaggleCompetitionTracked({
      id,
      tenant_id: (body['tenant_id'] as string | null) ?? null,
      competition_ref: body['competition_ref'] as string,
      title: (body['title'] as string | null) ?? null,
      category: (body['category'] as string | null) ?? null,
      deadline: (body['deadline'] as string | null) ?? null,
      reward: (body['reward'] as string | null) ?? null,
      url: (body['url'] as string | null) ?? null,
      status: (body['status'] as string) ?? 'watching',
      notes: (body['notes'] as string | null) ?? null,
      last_synced_at: (body['last_synced_at'] as string | null) ?? null,
    });
    const item = await db.getKaggleCompetitionTracked(id);
    json(res, 201, { 'kaggle-competition': item });
  }, { auth: true, csrf: true });

  router.put(`${COMP_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getKaggleCompetitionTracked(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tracked competition not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of ['tenant_id','competition_ref','title','category','deadline','reward','url','status','notes','last_synced_at']) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    await db.updateKaggleCompetitionTracked(params['id']!, fields as never);
    const item = await db.getKaggleCompetitionTracked(params['id']!);
    json(res, 200, { 'kaggle-competition': item });
  }, { auth: true, csrf: true });

  router.del(`${COMP_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteKaggleCompetitionTracked(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── Approaches ────────────────────────────────────────────────────────────

export function registerKaggleApproachRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(APP_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const competitionRef = url.searchParams.get('competition_ref') ?? undefined;
    const status         = url.searchParams.get('status') ?? undefined;
    const items = await db.listKaggleApproaches({
      ...(competitionRef ? { competitionRef } : {}),
      ...(status ? { status } : {}),
      limit:  Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });
    json(res, 200, { 'kaggle-approaches': items });
  }, { auth: true });

  router.get(`${APP_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getKaggleApproach(params['id']!);
    if (!item) { json(res, 404, { error: 'Approach not found' }); return; }
    json(res, 200, { 'kaggle-approach': item });
  }, { auth: true });

  router.post(APP_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['competition_ref']) { json(res, 400, { error: 'competition_ref required' }); return; }
    if (!body['summary'])         { json(res, 400, { error: 'summary required' });         return; }
    const id = makeId('kgl-app');
    const sourceKernelRefs = body['source_kernel_refs'] != null
      ? (typeof body['source_kernel_refs'] === 'string' ? body['source_kernel_refs'] as string : JSON.stringify(body['source_kernel_refs']))
      : null;
    await db.createKaggleApproach({
      id,
      tenant_id: (body['tenant_id'] as string | null) ?? null,
      competition_ref: body['competition_ref'] as string,
      summary: body['summary'] as string,
      expected_metric: (body['expected_metric'] as string | null) ?? null,
      model: (body['model'] as string | null) ?? null,
      source_kernel_refs: sourceKernelRefs,
      embedding: null,
      status: (body['status'] as string) ?? 'draft',
      created_by: (body['created_by'] as string | null) ?? null,
    });
    const item = await db.getKaggleApproach(id);
    json(res, 201, { 'kaggle-approach': item });
  }, { auth: true, csrf: true });

  router.put(`${APP_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getKaggleApproach(params['id']!);
    if (!existing) { json(res, 404, { error: 'Approach not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of ['tenant_id','competition_ref','summary','expected_metric','model','status','created_by']) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    if (body['source_kernel_refs'] !== undefined) {
      fields['source_kernel_refs'] = body['source_kernel_refs'] != null
        ? (typeof body['source_kernel_refs'] === 'string' ? body['source_kernel_refs'] : JSON.stringify(body['source_kernel_refs']))
        : null;
    }
    await db.updateKaggleApproach(params['id']!, fields as never);
    const item = await db.getKaggleApproach(params['id']!);
    json(res, 200, { 'kaggle-approach': item });
  }, { auth: true, csrf: true });

  router.del(`${APP_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteKaggleApproach(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── Runs ──────────────────────────────────────────────────────────────────

export function registerKaggleRunRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;
  const kaggleRunIdempotency = createDbBackedIdempotencyStore(db);

  router.get(RUN_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const competitionRef = url.searchParams.get('competition_ref') ?? undefined;
    const approachId     = url.searchParams.get('approach_id') ?? undefined;
    const status         = url.searchParams.get('status') ?? undefined;
    const items = await db.listKaggleRuns({
      ...(competitionRef ? { competitionRef } : {}),
      ...(approachId ? { approachId } : {}),
      ...(status ? { status } : {}),
      limit:  Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });
    json(res, 200, { 'kaggle-runs': items });
  }, { auth: true });

  router.get(`${RUN_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getKaggleRun(params['id']!);
    if (!item) { json(res, 404, { error: 'Run not found' }); return; }
    json(res, 200, { 'kaggle-run': item });
  }, { auth: true });

  router.post(RUN_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
    if (idempotencyKey) {
      const cached = await kaggleRunIdempotency.check(`kaggle-runs:${idempotencyKey}`);
      if (cached.isDuplicate) {
        json(res, 201, cached.previousResult);
        return;
      }
    }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['competition_ref']) { json(res, 400, { error: 'competition_ref required' }); return; }
    const id = makeId('kgl-run');
    const validatorReport = body['validator_report'] != null
      ? (typeof body['validator_report'] === 'string' ? body['validator_report'] as string : JSON.stringify(body['validator_report']))
      : null;
    await db.createKaggleRun({
      id,
      tenant_id: (body['tenant_id'] as string | null) ?? null,
      competition_ref: body['competition_ref'] as string,
      approach_id: (body['approach_id'] as string | null) ?? null,
      contract_id: (body['contract_id'] as string | null) ?? null,
      replay_trace_id: (body['replay_trace_id'] as string | null) ?? null,
      mesh_id: (body['mesh_id'] as string | null) ?? null,
      agent_id: (body['agent_id'] as string | null) ?? null,
      kernel_ref: (body['kernel_ref'] as string | null) ?? null,
      submission_id: (body['submission_id'] as string | null) ?? null,
      public_score: (body['public_score'] as number | null) ?? null,
      validator_report: validatorReport,
      status: (body['status'] as string) ?? 'queued',
      started_at: (body['started_at'] as string | null) ?? null,
      completed_at: (body['completed_at'] as string | null) ?? null,
    });
    const item = await db.getKaggleRun(id);
    const payload = { 'kaggle-run': item };
    if (idempotencyKey) {
      await kaggleRunIdempotency.record(`kaggle-runs:${idempotencyKey}`, payload);
    }
    json(res, 201, payload);
  }, { auth: true, csrf: true });

  router.put(`${RUN_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getKaggleRun(params['id']!);
    if (!existing) { json(res, 404, { error: 'Run not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of ['tenant_id','competition_ref','approach_id','contract_id','replay_trace_id','mesh_id','agent_id','kernel_ref','submission_id','public_score','status','started_at','completed_at']) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    if (body['validator_report'] !== undefined) {
      fields['validator_report'] = body['validator_report'] != null
        ? (typeof body['validator_report'] === 'string' ? body['validator_report'] : JSON.stringify(body['validator_report']))
        : null;
    }
    await db.updateKaggleRun(params['id']!, fields as never);
    const item = await db.getKaggleRun(params['id']!);
    json(res, 200, { 'kaggle-run': item });
  }, { auth: true, csrf: true });

  router.del(`${RUN_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteKaggleRun(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ─── Phase K4: Run detail (run + competition + approach + artifact) ──
  router.get(`${RUN_BASE}/:id/detail`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getKaggleRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Run not found' }); return; }
    const [competitions, approach, artifact] = await Promise.all([
      db.listKaggleCompetitionsTracked({ limit: 1000 }),
      run.approach_id ? db.getKaggleApproach(run.approach_id) : Promise.resolve(null),
      db.getKaggleRunArtifactByRunId(run.id),
    ]);
    const competition = competitions.find(c => c.competition_ref === run.competition_ref) ?? null;
    let contractReport: unknown = null;
    let runLogPreview: unknown = null;
    if (artifact) {
      try { contractReport = JSON.parse(artifact.contract_report_json); } catch { /* leave null */ }
      try {
        const log = JSON.parse(artifact.replay_run_log_json) as RunLog;
        runLogPreview = { executionId: log.executionId, status: log.status, stepCount: log.steps?.length ?? 0 };
      } catch { /* leave null */ }
    }
    json(res, 200, {
      run, competition, approach, artifact,
      contractReport, runLogPreview,
    });
  }, { auth: true });

  // ─── Phase K4: Materialize (chat hook + admin tooling entry point) ──
  // POST body: { competitionRef, approachId?, kernelRef, kernelOutputUrl?,
  //   submissionCsvSha256?, submissionId?, publicScore?, leaderboardJson?,
  //   validatorReport?, runLog }
  router.post(`${RUN_BASE}/materialize`, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['competitionRef'] || typeof body['competitionRef'] !== 'string') {
      json(res, 400, { error: 'competitionRef required' }); return;
    }
    if (!body['kernelRef'] || typeof body['kernelRef'] !== 'string') {
      json(res, 400, { error: 'kernelRef required' }); return;
    }
    const runLog = body['runLog'] as RunLog | undefined;
    if (!runLog || typeof runLog !== 'object' || !runLog.executionId || !Array.isArray(runLog.steps)) {
      json(res, 400, { error: 'runLog with {executionId, steps[]} required' }); return;
    }
    const input: MaterializeKaggleRunInput = {
      db,
      competitionRef: body['competitionRef'] as string,
      ...(body['runId'] ? { runId: body['runId'] as string } : {}),
      ...(body['tenantId'] !== undefined ? { tenantId: body['tenantId'] as string | null } : {}),
      ...(body['approachId'] !== undefined ? { approachId: body['approachId'] as string | null } : {}),
      ...(body['meshId'] !== undefined ? { meshId: body['meshId'] as string | null } : {}),
      ...(body['agentId'] !== undefined ? { agentId: body['agentId'] as string | null } : {}),
      ...(body['submissionId'] !== undefined ? { submissionId: body['submissionId'] as string | null } : {}),
      ...(body['status'] ? { status: body['status'] as string } : {}),
      evidenceInput: {
        kernelRef: body['kernelRef'] as string,
        ...(body['kernelOutputUrl'] ? { kernelOutputUrl: body['kernelOutputUrl'] as string } : {}),
        ...(body['submissionCsvSha256'] ? { submissionCsvSha256: body['submissionCsvSha256'] as string } : {}),
        ...(typeof body['publicScore'] === 'number' ? { publicScore: body['publicScore'] as number } : {}),
        ...(body['leaderboardJson'] ? { leaderboardJson: body['leaderboardJson'] as Record<string, unknown> } : {}),
        ...(body['validatorReport'] ? { validatorReport: body['validatorReport'] as Record<string, unknown> } : {}),
      },
      runLog,
    };
    const result = await materializeKaggleRun(input);
    json(res, 201, result);
  }, { auth: true, csrf: true });

  // ─── Phase K4: Replay (deterministic re-execution from stored RunLog) ──
  router.post(`${RUN_BASE}/:id/replay`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getKaggleRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Run not found' }); return; }
    const ctx: ExecutionContext = { executionId: `replay-${newUUIDv7().slice(-8)}`, metadata: { source: 'admin-replay' } };
    try {
      const result = await replayKaggleRun({ db, runId: run.id, ctx });
      json(res, 200, {
        runId: run.id,
        status: result.status,
        matchRate: result.matchRate,
        totalDurationMs: result.totalDurationMs,
        steps: result.steps.map(s => ({ index: s.index, name: s.name, match: s.match, error: s.replayed.error ?? null })),
      });
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }, { auth: true, csrf: true });
}

// ─── Phase K4: Run Artifacts (read-only ledger view) ──────────────────────

const ART_BASE = '/api/admin/kaggle-run-artifacts';

export function registerKaggleRunArtifactRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get(ART_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const items = await db.listKaggleRunArtifacts({
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });
    // Don't blast big JSON payloads in list view; return previews only.
    const preview = items.map(a => ({
      id: a.id,
      run_id: a.run_id,
      contract_id: a.contract_id,
      replay_trace_id: a.replay_trace_id,
      created_at: a.created_at,
      contract_report_size: a.contract_report_json.length,
      replay_run_log_size: a.replay_run_log_json.length,
    }));
    json(res, 200, { 'kaggle-run-artifacts': preview });
  }, { auth: true });

  router.get(`${ART_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    // The list endpoint returns previews keyed by artifact id; the detail
    // endpoint key here is run_id for convenience (mirrors design doc §6).
    const item = await db.getKaggleRunArtifactByRunId(params['id']!);
    if (!item) { json(res, 404, { error: 'Artifact not found' }); return; }
    json(res, 200, { 'kaggle-run-artifact': item });
  }, { auth: true });
}

// ─── Phase K7d — Validator Rubrics, Validation Results, Leaderboard Scores ──

const RUBRIC_BASE = '/api/admin/kaggle-rubrics';
const VAL_BASE    = '/api/admin/kaggle-validation-results';
const LB_BASE     = '/api/admin/kaggle-leaderboard-scores';

export function registerKaggleRubricRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(RUBRIC_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const competitionRef = url.searchParams.get('competition_ref') ?? undefined;
    const tenantId = url.searchParams.get('tenant_id');
    const items = await db.listKaggleCompetitionRubrics({
      ...(competitionRef ? { competitionRef } : {}),
      ...(tenantId !== null ? { tenantId } : {}),
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });
    json(res, 200, { 'kaggle-rubrics': items });
  }, { auth: true });

  router.get(`${RUBRIC_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getKaggleCompetitionRubric(params['id']!);
    if (!item) { json(res, 404, { error: 'Rubric not found' }); return; }
    json(res, 200, { 'kaggle-rubric': item });
  }, { auth: true });

  router.post(RUBRIC_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['competition_ref']) { json(res, 400, { error: 'competition_ref required' }); return; }
    const id = makeId('kgl-rub');
    const row = await db.upsertKaggleCompetitionRubric({
      id,
      tenant_id: (body['tenant_id'] as string | null) ?? null,
      competition_ref: body['competition_ref'] as string,
      metric_name: (body['metric_name'] as string | null) ?? null,
      metric_direction: (body['metric_direction'] as 'maximize' | 'minimize' | null) ?? null,
      baseline_score: (body['baseline_score'] as number | null) ?? null,
      target_score: (body['target_score'] as number | null) ?? null,
      expected_row_count: (body['expected_row_count'] as number | null) ?? null,
      id_column: (body['id_column'] as string | null) ?? null,
      id_range_min: (body['id_range_min'] as number | null) ?? null,
      id_range_max: (body['id_range_max'] as number | null) ?? null,
      target_column: (body['target_column'] as string | null) ?? null,
      target_type: (body['target_type'] as string | null) ?? null,
      expected_distribution_json: (body['expected_distribution_json'] as string | null) ?? null,
      sample_submission_sha256: (body['sample_submission_sha256'] as string | null) ?? null,
      inference_source: (body['inference_source'] as string | null) ?? null,
      auto_generated: (body['auto_generated'] as number | undefined) ?? 0,
      inferred_at: (body['inferred_at'] as string | null) ?? null,
      notes: (body['notes'] as string | null) ?? null,
    });
    json(res, 201, { 'kaggle-rubric': row });
  }, { auth: true, csrf: true });

  router.put(`${RUBRIC_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getKaggleCompetitionRubric(params['id']!);
    if (!existing) { json(res, 404, { error: 'Rubric not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of [
      'tenant_id','competition_ref','metric_name','metric_direction',
      'baseline_score','target_score','expected_row_count','id_column',
      'id_range_min','id_range_max','target_column','target_type',
      'expected_distribution_json','sample_submission_sha256',
      'inference_source','auto_generated','inferred_at','notes',
    ]) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    await db.updateKaggleCompetitionRubric(params['id']!, fields as never);
    const item = await db.getKaggleCompetitionRubric(params['id']!);
    json(res, 200, { 'kaggle-rubric': item });
  }, { auth: true, csrf: true });

  router.del(`${RUBRIC_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteKaggleCompetitionRubric(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

export function registerKaggleValidationResultRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get(VAL_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const runId = url.searchParams.get('run_id') ?? undefined;
    const competitionRef = url.searchParams.get('competition_ref') ?? undefined;
    const verdict = url.searchParams.get('verdict') ?? undefined;
    const items = await db.listKaggleValidationResults({
      ...(runId ? { runId } : {}),
      ...(competitionRef ? { competitionRef } : {}),
      ...(verdict ? { verdict } : {}),
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });
    json(res, 200, { 'kaggle-validation-results': items });
  }, { auth: true });

  router.get(`${VAL_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getKaggleValidationResult(params['id']!);
    if (!item) { json(res, 404, { error: 'Validation result not found' }); return; }
    json(res, 200, { 'kaggle-validation-result': item });
  }, { auth: true });
}

export function registerKaggleLeaderboardScoreRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get(LB_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const runId = url.searchParams.get('run_id') ?? undefined;
    const competitionRef = url.searchParams.get('competition_ref') ?? undefined;
    const items = await db.listKaggleLeaderboardScores({
      ...(runId ? { runId } : {}),
      ...(competitionRef ? { competitionRef } : {}),
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });
    json(res, 200, { 'kaggle-leaderboard-scores': items });
  }, { auth: true });

  router.get(`${LB_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getKaggleLeaderboardScore(params['id']!);
    if (!item) { json(res, 404, { error: 'Leaderboard score not found' }); return; }
    json(res, 200, { 'kaggle-leaderboard-score': item });
  }, { auth: true });
}

// ─── Live Competition Runs (kgl_competition_run) ──────────────────────────
// Read-only operator surface over rows produced by POST /api/kaggle/competition-runs
// (the ▶ Start Live Run button on the Tracked Competitions tab). Each row is a
// top-level live-agents mesh run, distinct from the per-approach kaggle_runs
// kernel/submission ledger above.
export function registerKglCompetitionRunAdminRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get(KGL_RUN_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const url = new URL(req.url ?? '', 'http://x');
    const status = url.searchParams.get('status') as KglCompetitionRunRow['status'] | null;
    const competitionRef = url.searchParams.get('competition_ref') ?? undefined;
    const items = await db.listKglCompetitionRuns({
      tenantId,
      ...(status ? { status } : {}),
      ...(competitionRef ? { competitionRef } : {}),
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    });
    json(res, 200, { 'kaggle-competition-runs': items });
  }, { auth: true });

  router.get(`${KGL_RUN_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const item = await db.getKglCompetitionRun(params['id']!, tenantId);
    if (!item) { json(res, 404, { error: 'Competition run not found' }); return; }
    const steps = await db.listKglRunSteps(item.id);
    const events = await db.listKglRunEvents(item.id, { limit: 500 });
    // Best-effort enrich with agent roster + inter-agent dialogue. The mesh
    // may have been provisioned (live_meshes + live_agents rows) or just
    // raw StateStore (la_entities only) — handle both.
    const messages = item.mesh_id ? await db.listLiveMeshMessages(item.mesh_id, { limit: 500 }) : [];
    const agents = item.mesh_id ? await db.listLiveAgents({ meshId: item.mesh_id }) : [];
    const mesh = item.mesh_id ? await db.getLiveMesh(item.mesh_id) : null;
    json(res, 200, { 'kaggle-competition-run': item, steps, events, messages, agents, mesh });
  }, { auth: true });

  // ── Operator actions: cancel / pause / restart ───────────────────────
  // These are intentionally idempotent — repeat calls return the current
  // state without erroring. Pause/restart flip the owning live_mesh + each
  // live_agent so the heartbeat scheduler stops/resumes ticking the run.

  router.post(`${KGL_RUN_BASE}/:id/cancel`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const run = await db.getKglCompetitionRun(params['id']!, tenantId);
    if (!run) { json(res, 404, { error: 'Competition run not found' }); return; }
    const nowIso = new Date().toISOString();
    if (run.status !== 'abandoned' && run.status !== 'completed' && run.status !== 'failed') {
      await db.updateKglCompetitionRun(run.id, {
        status: 'abandoned',
        completed_at: nowIso,
        summary: run.summary ?? 'Cancelled by operator',
      });
    }
    if (run.mesh_id) {
      try { await db.updateLiveMesh(run.mesh_id, { status: 'PAUSED' }); } catch { /* ignore */ }
      try {
        const agents = await db.listLiveAgents({ meshId: run.mesh_id });
        for (const a of agents) {
          if (a.status === 'ACTIVE') await db.updateLiveAgent(a.id, { status: 'PAUSED' });
        }
      } catch { /* ignore */ }
    }
    const updated = await db.getKglCompetitionRun(run.id, tenantId);
    json(res, 200, { 'kaggle-competition-run': updated });
  }, { auth: true, csrf: true });

  router.post(`${KGL_RUN_BASE}/:id/pause`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const run = await db.getKglCompetitionRun(params['id']!, tenantId);
    if (!run) { json(res, 404, { error: 'Competition run not found' }); return; }
    if (!run.mesh_id) { json(res, 409, { error: 'Run has no mesh to pause' }); return; }
    try { await db.updateLiveMesh(run.mesh_id, { status: 'PAUSED' }); } catch { /* ignore */ }
    try {
      const agents = await db.listLiveAgents({ meshId: run.mesh_id });
      for (const a of agents) {
        if (a.status === 'ACTIVE') await db.updateLiveAgent(a.id, { status: 'PAUSED' });
      }
    } catch { /* ignore */ }
    const updated = await db.getKglCompetitionRun(run.id, tenantId);
    json(res, 200, { 'kaggle-competition-run': updated, paused: true });
  }, { auth: true, csrf: true });

  router.post(`${KGL_RUN_BASE}/:id/restart`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const run = await db.getKglCompetitionRun(params['id']!, tenantId);
    if (!run) { json(res, 404, { error: 'Competition run not found' }); return; }
    if (!run.mesh_id) { json(res, 409, { error: 'Run has no mesh to restart' }); return; }
    // Move terminal status back to running so the heartbeat picks it up.
    if (run.status !== 'running' && run.status !== 'queued') {
      await db.updateKglCompetitionRun(run.id, { status: 'running', completed_at: null });
    }
    try { await db.updateLiveMesh(run.mesh_id, { status: 'ACTIVE' }); } catch { /* ignore */ }
    try {
      const agents = await db.listLiveAgents({ meshId: run.mesh_id });
      for (const a of agents) {
        if (a.status !== 'ACTIVE' && a.status !== 'ARCHIVED') {
          await db.updateLiveAgent(a.id, { status: 'ACTIVE' });
        }
      }
    } catch { /* ignore */ }
    const updated = await db.getKglCompetitionRun(run.id, tenantId);
    json(res, 200, { 'kaggle-competition-run': updated, restarted: true });
  }, { auth: true, csrf: true });
}
