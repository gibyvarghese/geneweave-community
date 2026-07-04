// no-raw-fetch: allow (reason: `fetch` in pollRows is a closure parameter, not the global)
/**
 * Hypothesis Validation — HTTP route handlers
 *
 * Implements the full SV REST + SSE surface:
 *  POST   /api/sv/hypotheses                — submit hypothesis, start async workflow
 *  GET    /api/sv/hypotheses/:id            — fetch hypothesis + verdict
 *  GET    /api/sv/hypotheses/:id/events     — SSE evidence stream (Last-Event-ID supported)
 *  GET    /api/sv/hypotheses/:id/dialogue   — SSE agent-turn stream + verdict event
 *  POST   /api/sv/hypotheses/:id/cancel     — cancel in-progress run
 *  POST   /api/sv/hypotheses/:id/reproduce  — re-run from replay trace (new IDs)
 *  GET    /api/sv/verdicts/:id/bundle       — download verdict JSON bundle
 *
 * Status values: 'queued' | 'running' | 'verdict' | 'abandoned'
 * Terminal statuses (run over): 'verdict' | 'abandoned'
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import { createDurableIdempotencyStore, type DurableIdempotencyEntry } from '@weaveintel/resilience';
import type { DatabaseAdapter } from '../../../db.js';
import type { SVChatBridge, SVRunInput } from '../chat-bridge.js';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: { userId: string; tenantId?: string | null } | null,
) => Promise<void>;

type JsonHelper = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBodyHelper = (req: IncomingMessage) => Promise<string>;

interface Router {
  get(path: string, handler: RouteHandler, opts?: { auth?: boolean; csrf?: boolean }): void;
  post(path: string, handler: RouteHandler, opts?: { auth?: boolean; csrf?: boolean }): void;
}

const TERMINAL_STATUSES = new Set(['verdict', 'abandoned']);

function createDbBackedIdempotencyStore(db: DatabaseAdapter) {
  return createDurableIdempotencyStore(
    { ttlMs: 24 * 60 * 60 * 1000, maxEntries: 10_000 },
    {
      async get(key: string) {
        const record = await db.getIdempotencyRecordByKey(key);
        if (!record) return null;
        return {
          result: JSON.parse(record.result_json) as unknown,
          expiresAt: Date.parse(record.expires_at),
        };
      },
      async set(key: string, entry: DurableIdempotencyEntry) {
        await db.createIdempotencyRecord({
          id: newUUIDv7(),
          key,
          result_json: JSON.stringify(entry.result),
          expires_at: new Date(entry.expiresAt).toISOString(),
        });
      },
      async deleteExpired(nowMs: number) {
        await db.deleteExpiredIdempotencyRecords(new Date(nowMs).toISOString());
      },
      async trimOldest(maxEntries: number) {
        await db.trimIdempotencyRecords(maxEntries);
      },
      async clear() {
        await db.clearIdempotencyRecords();
      },
    },
  );
}

/** Send a single SSE frame. */
function sseFrame(res: ServerResponse, event: string, id: string, data: unknown): void {
  res.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** SSE keep-alive comment every 15 s. */
function startSSEKeepalive(res: ServerResponse): NodeJS.Timeout {
  return setInterval(() => { res.write(': ping\n\n'); }, 15_000);
}

/** Poll the DB for new rows after `lastId` for up to `maxWaitMs`. Yields rows as they arrive. */
async function* pollRows<T extends { id: string; created_at: string }>(
  fetch: (afterId: string | undefined) => Promise<T[]>,
  lastId: string | undefined,
  isTerminal: () => Promise<boolean>,
  pollIntervalMs = 1_000,
  maxWaitMs = 300_000,
): AsyncGenerator<T> {
  const deadline = Date.now() + maxWaitMs;
  let cursor = lastId;
  while (Date.now() < deadline) {
    const rows = await fetch(cursor);
    for (const row of rows) {
      cursor = row.id;
      yield row;
    }
    if (rows.length === 0) {
      if (await isTerminal()) return;
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }
}

export function registerSVRoutes(
  router: Router,
  db: DatabaseAdapter,
  json: JsonHelper,
  readBody: ReadBodyHelper,
  runner?: SVChatBridge,
): void {
  const iStore = createDbBackedIdempotencyStore(db);

  const getHv = (suffix: string, handler: RouteHandler, opts?: { auth?: boolean; csrf?: boolean }) => {
    router.get(`/api/sv${suffix}`, handler, opts);
    router.get(`/api/hv${suffix}`, handler, opts);
  };

  const postHv = (suffix: string, handler: RouteHandler, opts?: { auth?: boolean; csrf?: boolean }) => {
    router.post(`/api/sv${suffix}`, handler, opts);
    router.post(`/api/hv${suffix}`, handler, opts);
  };

  // ── GET /api/sv/hypotheses ──────────────────────────────────────────────
  getHv('/hypotheses', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = auth.tenantId ?? auth.userId;
    const rows = await db.listHypotheses(tenantId, 20, 0);
    json(res, 200, {
      hypotheses: rows.map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  }, { auth: true });

  // ── POST /api/sv/hypotheses ─────────────────────────────────────────────
  postHv('/hypotheses', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    // Idempotency-Key deduplication
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (idempotencyKey) {
      const check = await iStore.check(`hypotheses:${idempotencyKey}`);
      if (check.isDuplicate) { json(res, 201, check.previousResult); return; }
    }

    let body: {
      title?: string; statement?: string;
      domainTags?: string[]; budgetId?: string;
    };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: 'Invalid JSON body' }); return;
    }

    const { title, statement, domainTags = [], budgetId: rawBudgetId = '' } = body;
    if (!title || typeof title !== 'string') { json(res, 400, { error: 'title is required' }); return; }
    if (!statement || typeof statement !== 'string') { json(res, 400, { error: 'statement is required' }); return; }

    const id = newUUIDv7();
    const tenantId = (auth.tenantId ?? auth.userId) as string;

    // Resolve budget envelope: use caller-supplied id, or fall back to first available.
    let budgetId = rawBudgetId;
    if (!budgetId) {
      const envelopes = await db.listBudgetEnvelopes(tenantId);
      const fallback = envelopes[0] ?? (await db.listBudgetEnvelopes('system'))[0];
      if (!fallback) { json(res, 422, { error: 'No budget envelope available. Seed default data first.' }); return; }
      budgetId = fallback.id;
    }
    const traceId = newUUIDv7();
    const contractId = newUUIDv7();

    await db.createHypothesis({
      id,
      tenant_id: tenantId,
      submitted_by: auth.userId,
      title,
      statement,
      domain_tags: JSON.stringify(domainTags),
      budget_envelope_id: budgetId,
      status: 'queued',
      workflow_run_id: null,
      trace_id: traceId,
      contract_id: contractId,
    });

    // Fire-and-forget: start workflow asynchronously if runner is available.
    if (runner) {
      const runInput: SVRunInput = {
        hypothesisId: id,
        tenantId,
        userId: auth.userId,
        statement,
        domainTags,
        budgetId,
      };
      runner.startRun(runInput).catch((err: unknown) => {
        console.error('[sv] workflow run failed for hypothesis', id, err);
        db.updateHypothesisStatus(id, 'abandoned', new Date().toISOString()).catch(() => {});
      });
    }

    const responseBody = { id, status: 'queued', traceId, contractId };
    if (idempotencyKey) await iStore.record(`hypotheses:${idempotencyKey}`, responseBody);
    json(res, 201, responseBody);
  }, { auth: true, csrf: true });

  // ── GET /api/sv/hypotheses/:id ──────────────────────────────────────────
  getHv('/hypotheses/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const { id } = params;
    if (!id) { json(res, 400, { error: 'id required' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;

    const hypothesis = await db.getHypothesis(id, tenantId);
    if (!hypothesis) { json(res, 404, { error: 'Hypothesis not found' }); return; }

    const verdict = await db.getVerdictByHypothesis(hypothesis.id);

    json(res, 200, {
      hypothesis: {
        id: hypothesis.id,
        title: hypothesis.title,
        statement: hypothesis.statement,
        domainTags: JSON.parse(hypothesis.domain_tags ?? '[]') as string[],
        status: hypothesis.status,
        traceId: hypothesis.trace_id,
        contractId: hypothesis.contract_id,
        createdAt: hypothesis.created_at,
        updatedAt: hypothesis.updated_at,
      },
      verdict: verdict
        ? {
            id: verdict.id,
            verdict: verdict.verdict,
            confidenceLo: verdict.confidence_lo,
            confidenceHi: verdict.confidence_hi,
            limitations: verdict.limitations,
            emittedBy: verdict.emitted_by,
          }
        : null,
    });
  }, { auth: true });

  // ── GET /api/sv/hypotheses/:id/events (SSE) ─────────────────────────────
  getHv('/hypotheses/:id/events', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const { id } = params;
    if (!id) { json(res, 400, { error: 'id required' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;

    const hypothesis = await db.getHypothesis(id, tenantId);
    if (!hypothesis) { json(res, 404, { error: 'Hypothesis not found' }); return; }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? undefined;
    const ka = startSSEKeepalive(res);

    try {
      const isTerminal = async () => {
        const h = await db.getHypothesis(id, tenantId);
        return TERMINAL_STATUSES.has(h?.status ?? '');
      };
      for await (const row of pollRows(
        (afterId) => db.listEvidenceEvents(id, afterId, 50),
        lastEventId,
        isTerminal,
      )) {
        sseFrame(res, 'evidence', row['evidence_id'] as string, {
          stepId: row['step_id'],
          agentId: row['agent_id'],
          evidenceId: row['evidence_id'],
          kind: row['kind'],
          summary: row['summary'],
          sourceType: row['source_type'],
          toolKey: row['tool_key'],
          reproducibilityHash: row['reproducibility_hash'],
        });
      }
    } finally {
      clearInterval(ka);
      res.end();
    }
  }, { auth: true });

  // ── GET /api/sv/hypotheses/:id/dialogue (SSE) ──────────────────────────
  getHv('/hypotheses/:id/dialogue', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const { id } = params;
    if (!id) { json(res, 400, { error: 'id required' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;

    const hypothesis = await db.getHypothesis(id, tenantId);
    if (!hypothesis) { json(res, 404, { error: 'Hypothesis not found' }); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? undefined;
    const ka = startSSEKeepalive(res);

    try {
      const isTerminal = async () => {
        const h = await db.getHypothesis(id, tenantId);
        return TERMINAL_STATUSES.has(h?.status ?? '');
      };
      for await (const row of pollRows(
        (afterId) => db.listAgentTurns(id, afterId, 50),
        lastEventId,
        isTerminal,
      )) {
        sseFrame(res, 'turn', row.id, {
          roundIndex: row.round_index,
          fromAgent: row.from_agent,
          toAgent: row.to_agent,
          message: row.message,
          citesEvidenceIds: JSON.parse(row.cites_evidence_ids ?? '[]') as string[],
          dissent: row.dissent === 1,
        });
      }
      // Emit verdict event when run is complete
      const final = await db.getHypothesis(id, tenantId);
      if (final?.status === 'verdict') {
        const v = await db.getVerdictByHypothesis(id);
        if (v) {
          sseFrame(res, 'verdict', v.id, {
            verdictId: v.id,
            verdict: v.verdict,
            confidenceLo: v.confidence_lo,
            confidenceHi: v.confidence_hi,
          });
        }
      }
    } finally {
      clearInterval(ka);
      res.end();
    }
  }, { auth: true });

  // ── POST /api/sv/hypotheses/:id/cancel ──────────────────────────────────
  postHv('/hypotheses/:id/cancel', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const { id } = params;
    if (!id) { json(res, 400, { error: 'id required' }); return; }
    const tenantId = (auth.tenantId ?? auth.userId) as string;

    const hypothesis = await db.getHypothesis(id, tenantId);
    if (!hypothesis) { json(res, 404, { error: 'Hypothesis not found' }); return; }

    // Idempotent: already abandoned → 200
    if (hypothesis.status !== 'abandoned') {
      if (runner) await runner.cancelRun(id);
      else await db.updateHypothesisStatus(id, 'abandoned', new Date().toISOString());
    }

    json(res, 200, { id, status: 'abandoned' });
  }, { auth: true, csrf: true });

  // ── POST /api/sv/hypotheses/:id/reproduce ───────────────────────────────
  postHv('/hypotheses/:id/reproduce', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const { id } = params;
    if (!id) { json(res, 400, { error: 'id required' }); return; }

    // Idempotency-Key deduplication
    const reproduceKey = req.headers['idempotency-key'] as string | undefined;
    if (reproduceKey) {
      const check = await iStore.check(`reproduce:${reproduceKey}`);
      if (check.isDuplicate) { json(res, 201, check.previousResult); return; }
    }

    const tenantId = (auth.tenantId ?? auth.userId) as string;

    const original = await db.getHypothesis(id, tenantId);
    if (!original) { json(res, 404, { error: 'Hypothesis not found' }); return; }

    const newId = newUUIDv7();
    const newTraceId = newUUIDv7();
    const newContractId = newUUIDv7();

    await db.createHypothesis({
      id: newId,
      tenant_id: tenantId,
      submitted_by: auth.userId,
      title: `[Repro] ${original.title}`,
      statement: original.statement,
      domain_tags: original.domain_tags,
      budget_envelope_id: original.budget_envelope_id,
      status: 'queued',
      workflow_run_id: null,
      trace_id: newTraceId,
      contract_id: newContractId,
    });

    if (runner) {
      const domainTags = JSON.parse(original.domain_tags ?? '[]') as string[];
      const runInput: SVRunInput = {
        hypothesisId: newId,
        tenantId,
        userId: auth.userId,
        statement: original.statement,
        domainTags,
        budgetId: original.budget_envelope_id ?? '',
      };
      runner.startRun(runInput).catch((err: unknown) => {
        console.error('[sv] reproduce run failed for hypothesis', newId, err);
        db.updateHypothesisStatus(newId, 'abandoned', new Date().toISOString()).catch(() => {});
      });
    }

    const reproduceBody = { id: newId, originalId: id, status: 'queued', traceId: newTraceId };
    if (reproduceKey) await iStore.record(`reproduce:${reproduceKey}`, reproduceBody);
    json(res, 201, reproduceBody);
  }, { auth: true, csrf: true });

  // ── GET /api/sv/verdicts/:id/bundle ─────────────────────────────────────
  getHv('/verdicts/:id/bundle', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const { id } = params;
    if (!id) { json(res, 400, { error: 'id required' }); return; }

    const verdict = await db.getVerdictById(id);
    if (!verdict) { json(res, 404, { error: 'Verdict not found' }); return; }

    // Verify tenant ownership via the hypothesis
    const tenantId = (auth.tenantId ?? auth.userId) as string;
    const hypothesis = await db.getHypothesis(verdict.hypothesis_id, tenantId);
    if (!hypothesis) { json(res, 404, { error: 'Verdict not found' }); return; }

    // Gather sub-claims, evidence events and agent turns for the bundle
    const subClaims = await db.listSubClaims(verdict.hypothesis_id);
    const evidenceEvents = await db.listEvidenceEvents(verdict.hypothesis_id, undefined, 500);
    const agentTurns = await db.listAgentTurns(verdict.hypothesis_id, undefined, 500);

    const bundle = {
      schemaVersion: '1.0.0',
      hypothesis: {
        id: hypothesis.id,
        title: hypothesis.title,
        statement: hypothesis.statement,
        domainTags: JSON.parse(hypothesis.domain_tags ?? '[]') as string[],
        traceId: hypothesis.trace_id,
        contractId: hypothesis.contract_id,
        createdAt: hypothesis.created_at,
        updatedAt: hypothesis.updated_at,
      },
      verdict: {
        id: verdict.id,
        verdict: verdict.verdict,
        confidenceLo: verdict.confidence_lo,
        confidenceHi: verdict.confidence_hi,
        limitations: verdict.limitations,
        emittedBy: verdict.emitted_by,
        keyEvidenceIds: JSON.parse(verdict.key_evidence_ids ?? '[]') as string[],
        falsifiers: JSON.parse(verdict.falsifiers ?? '[]') as string[],
      },
      subClaims: subClaims.map(sc => ({
        id: sc.id,
        statement: sc.statement,
        claimType: sc.claim_type,
        testabilityScore: sc.testability_score,
      })),
      evidenceEvents: evidenceEvents.map(ev => ({
        evidenceId: ev['evidence_id'],
        stepId: ev['step_id'],
        agentId: ev['agent_id'],
        kind: ev['kind'],
        summary: ev['summary'],
        sourceType: ev['source_type'],
        toolKey: ev['tool_key'],
        reproducibilityHash: ev['reproducibility_hash'],
        createdAt: ev.created_at,
      })),
      agentTurns: agentTurns.map(t => ({
        id: t.id,
        roundIndex: t.round_index,
        fromAgent: t.from_agent,
        toAgent: t.to_agent,
        message: t.message,
        dissent: t.dissent === 1,
        createdAt: t.created_at,
      })),
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="verdict-${id}.json"`,
    });
    res.end(JSON.stringify(bundle, null, 2));
  }, { auth: true });
}

