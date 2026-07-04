/**
 * Kaggle trace-retrieval tools — exposes paginated, run-scoped reads over
 * `kgl_run_steps`, `kgl_run_events`, and `tool_audit_events` so the
 * strategist's ReAct loop can pull its own past on demand instead of
 * carrying full ReAct history in every prompt.
 *
 * --- HARD SCOPING INVARIANT ---
 * Every tool here closes over a SINGLE `runId` resolved at prepare-time
 * from the agent's mesh id. The LLM cannot pass a runId argument; even if
 * it tries, the value is ignored. Tools NEVER touch other competition
 * runs (running or completed), even ones executing in parallel on other
 * meshes.
 *
 * This is the lazy-retrieval lever (L10) from `docs/COST_CONTROL_PLAN.md`
 * — it makes prompt-history compaction safe by giving the agent a way to
 * fetch back-history when (and only when) it actually needs it.
 */

import {
  weaveToolRegistry as createToolRegistry,
  weaveTool as defineTool,
  type ToolRegistry,
} from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { KglRunEventRow, KglRunStepRow, ToolAuditEventRow } from '../../db-types.js';

export interface KaggleTraceToolsOptions {
  /** The ONLY run id these tools may read from. Must be the strategist's
   *  current `kgl_competition_runs` row. Resolved upstream from the agent's
   *  mesh id at prepare time. */
  runId: string;
  /** DB adapter — required. */
  db: DatabaseAdapter;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Hard cap on rows returned by any single trace call. Default 25.
   *  Exists to prevent the LLM from blowing the prompt budget by asking
   *  for "everything". */
  maxRowsPerCall?: number;
}

/** Compact projection of a step row — only fields useful for LLM
 *  decision-making, with previews truncated. */
function projectStep(row: KglRunStepRow, maxPreviewBytes = 600): Record<string, unknown> {
  return {
    id: row.id,
    stepIndex: row.step_index,
    role: row.role,
    title: row.title,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summary: row.summary,
    inputPreview: truncate(row.input_preview, maxPreviewBytes),
    outputPreview: truncate(row.output_preview, maxPreviewBytes),
  };
}

function projectEvent(row: KglRunEventRow, includePayload = false): Record<string, unknown> {
  return {
    id: row.id,
    stepId: row.step_id,
    kind: row.kind,
    agentId: row.agent_id,
    toolKey: row.tool_key,
    summary: row.summary,
    createdAt: row.created_at,
    ...(includePayload && row.payload_json ? { payload: safeParse(row.payload_json) } : {}),
  };
}

function projectAudit(row: ToolAuditEventRow, maxPreviewBytes = 600): Record<string, unknown> {
  return {
    id: row.id,
    toolName: row.tool_name,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    chatId: row.chat_id,
    agentPersona: row.agent_persona,
    errorMessage: row.error_message,
    inputPreview: truncate(row.input_preview, maxPreviewBytes),
    outputPreview: truncate(row.output_preview, maxPreviewBytes),
    createdAt: row.created_at,
  };
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[+${s.length - max}b]`;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { _raw: json.slice(0, 200) };
  }
}

export function createKaggleTraceTools(opts: KaggleTraceToolsOptions): ToolRegistry {
  const { runId, db } = opts;
  const log = opts.log ?? (() => {});
  const maxRows = Math.max(1, Math.min(opts.maxRowsPerCall ?? 25, 100));

  if (!runId) {
    throw new Error('createKaggleTraceTools: runId is required (must be the strategist current run)');
  }

  const reg = createToolRegistry();

  reg.register(
    defineTool({
      name: 'kaggle_get_run_timeline',
      description:
        'Return a compact timeline of pipeline steps (discoverer/strategist/implementer/validator/etc.) for THE CURRENT competition run only. Use this to recall what phases have already completed and what their summaries said, instead of carrying full prior turns in your prompt. Optional `statusFilter` lets you focus on completed/failed/running steps; `lastN` caps results (default 10).',
      parameters: {
        type: 'object',
        properties: {
          statusFilter: {
            type: 'string',
            enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
            description: 'Optional. Only return steps matching this status.',
          },
          lastN: {
            type: 'number',
            description: `How many most-recent steps to return. Default 10, max ${maxRows}.`,
          },
        },
      },
      tags: ['kaggle', 'trace', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const lastN = Math.max(1, Math.min(Number(args['lastN'] ?? 10), maxRows));
        const statusFilter = args['statusFilter'] as KglRunStepRow['status'] | undefined;
        const allSteps = await db.listKglRunSteps(runId);
        const filtered = statusFilter ? allSteps.filter((s) => s.status === statusFilter) : allSteps;
        const recent = filtered.slice(-lastN);
        log(`kaggle_get_run_timeline: runId=${runId} returned ${recent.length}/${allSteps.length} steps`);
        return JSON.stringify(
          {
            runId,
            totalSteps: allSteps.length,
            returned: recent.length,
            steps: recent.map((s) => projectStep(s)),
          },
          null,
          2,
        );
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_failed_attempts',
      description:
        'Return only the FAILED steps + tool errors for THE CURRENT run, with previews of what failed and why (tool error_message, step output_preview). Use this when planning a retry to recall what kernels / probes / tool calls already failed and avoid repeating them. Cheaper than re-reading full ReAct history.',
      parameters: {
        type: 'object',
        properties: {
          lastN: {
            type: 'number',
            description: `Max number of failed records to return. Default 10, max ${maxRows}.`,
          },
        },
      },
      tags: ['kaggle', 'trace', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const lastN = Math.max(1, Math.min(Number(args['lastN'] ?? 10), maxRows));
        const steps = await db.listKglRunSteps(runId);
        const failedSteps = steps.filter((s) => s.status === 'failed');
        // Tool audit is platform-wide; we filter by chat_id === runId because
        // kaggle handlers persist chat_id = run.id when emitting audit rows.
        // If your install uses a different correlation key adjust here.
        const allAudits = await db.listToolAuditEvents({ chatId: runId, limit: 200 });
        const failedAudits = allAudits.filter(
          (a) => a.outcome === 'error' || a.outcome === 'denied' || a.outcome === 'rate_limited',
        );
        const failedRecords = [
          ...failedSteps.slice(-lastN).map((s) => ({ kind: 'step', record: projectStep(s) })),
          ...failedAudits.slice(-lastN).map((a) => ({ kind: 'tool_call', record: projectAudit(a) })),
        ];
        log(
          `kaggle_get_failed_attempts: runId=${runId} returned ${failedRecords.length} failures ` +
            `(steps=${failedSteps.length} audits=${failedAudits.length})`,
        );
        return JSON.stringify(
          {
            runId,
            failedStepsCount: failedSteps.length,
            failedToolCallsCount: failedAudits.length,
            failures: failedRecords.slice(0, lastN),
          },
          null,
          2,
        );
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_recent_events',
      description:
        'Stream recent events from THE CURRENT run only — kernel pushes, tool blocks, evidence, agent messages, logs. Filter by `kind` (e.g. "kernel_pushed", "tool_blocked", "agent_message"). Use when you need to know what JUST happened in the last few ticks without carrying full message history.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description:
              'Optional event-kind filter. Common values: kernel_pushed, tool_blocked, step_completed, agent_message, evidence.',
          },
          afterId: {
            type: 'string',
            description:
              'Optional UUID. Returns events strictly newer than this one (paginate forward).',
          },
          limit: {
            type: 'number',
            description: `Max events to return. Default 20, max ${maxRows}.`,
          },
        },
      },
      tags: ['kaggle', 'trace', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const limit = Math.max(1, Math.min(Number(args['limit'] ?? 20), maxRows));
        const kind = args['kind'] as string | undefined;
        const afterId = args['afterId'] as string | undefined;
        const events = await db.listKglRunEvents(runId, {
          ...(afterId ? { afterId } : {}),
          limit: kind ? Math.min(maxRows * 4, 200) : limit,
        });
        const filtered = kind ? events.filter((e) => e.kind === kind) : events;
        const sliced = filtered.slice(-limit);
        log(
          `kaggle_get_recent_events: runId=${runId} kind=${kind ?? '*'} returned ${sliced.length}/${events.length}`,
        );
        return JSON.stringify(
          {
            runId,
            returned: sliced.length,
            events: sliced.map((e) => projectEvent(e, false)),
          },
          null,
          2,
        );
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_event_details',
      description:
        'Fetch the full payload JSON for one event (by id) belonging to THE CURRENT run. Use after `kaggle_get_recent_events` or `kaggle_get_failed_attempts` flagged an event you need to inspect (e.g. the kernelRef returned by a prior push). Refuses event ids that do not belong to the current run.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'UUID of the event to expand.' },
        },
        required: ['eventId'],
      },
      tags: ['kaggle', 'trace', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const eventId = String(args['eventId'] ?? '').trim();
        if (!eventId) {
          return JSON.stringify({ error: 'eventId is required' });
        }
        // Listing the run's events is bounded by recent activity. We bump
        // the limit here because the operator may be inspecting an older
        // event, but we still cap at 500 to avoid unbounded scans.
        const events = await db.listKglRunEvents(runId, { limit: 500 });
        const found = events.find((e) => e.id === eventId);
        if (!found) {
          log(`kaggle_get_event_details: event ${eventId} not found in run ${runId} — refusing`);
          return JSON.stringify({
            error: 'event_not_in_current_run',
            message:
              'Refusing to disclose: this event id does not belong to the current competition run, or has been pruned.',
            runId,
          });
        }
        return JSON.stringify(projectEvent(found, true), null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_step_artifact',
      description:
        'Fetch the full output preview for one step (by id) of THE CURRENT run — useful when `kaggle_get_run_timeline` shows a step you want to read in full (e.g. the implementer\'s authored kernel source, the validator\'s verdict). Refuses step ids that do not belong to the current run.',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: 'UUID of the step to expand.' },
        },
        required: ['stepId'],
      },
      tags: ['kaggle', 'trace', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const stepId = String(args['stepId'] ?? '').trim();
        if (!stepId) {
          return JSON.stringify({ error: 'stepId is required' });
        }
        const steps = await db.listKglRunSteps(runId);
        const found = steps.find((s) => s.id === stepId);
        if (!found) {
          log(`kaggle_get_step_artifact: step ${stepId} not found in run ${runId} — refusing`);
          return JSON.stringify({
            error: 'step_not_in_current_run',
            message:
              'Refusing to disclose: this step id does not belong to the current competition run.',
            runId,
          });
        }
        return JSON.stringify(
          {
            runId,
            ...projectStep(found, /*maxPreviewBytes=*/ 4000),
          },
          null,
          2,
        );
      },
    }),
  );

  return reg;
}
