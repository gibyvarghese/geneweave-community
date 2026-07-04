/** Kaggle Submission Validator — agentic (skill-driven ReAct) + deterministic. */
import { weaveLiveAgent, type TaskHandler } from '@weaveintel/live-agents';
import type { Model } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import {
  runSubmissionValidation,
  type CvScoresArtifact,
} from '../../../lib/kaggle-validator-runner.js';
import { createKaggleTools } from '../kaggle-tools.js';
import { withPerTickReadCache } from '../adapter-cache.js';
import {
  emitToNextAgent,
  loadInboundTask,
  parseInboundJson,
  resolveCreds,
  DEFAULT_MAX_ITERATIONS,
  type SharedHandlerContext,
} from './_shared.js';

/** Hardcoded id of the seeded `kaggle_validator` skill row. The agent's
 *  system prompt is loaded from the `instructions` column of this row so
 *  operators can edit the validator's behavior at runtime via /api/admin/skills
 *  without restarting the server. */
const KAGGLE_VALIDATOR_SKILL_ID = 'kgl00000-0000-4000-8002-000000000004';

/** Last-resort prompt used only when the DB skill row is missing or
 *  unreadable. Kept intentionally minimal — production always reads from DB. */
const FALLBACK_VALIDATOR_PROMPT = `You are a Kaggle submission validator. Branch on submissionWriter (in the inbound JSON) or infer it: PATH A — kernel_emits_file (default; competition has sample_submission.csv): use kaggle_list_competition_files + kaggle_get_competition_file (sample headers/rows) + kaggle_get_kernel_output (inlinedCsvFiles['submission.csv']) + kaggle_validate_submission. PATH B — kernel_is_submission (live-API/agent comps with no sample_submission.csv): use kaggle_get_kernel_output and verify (a) status=complete, (b) tail contains a score line like AGENT_RESULT/total_score=/final_score=/levels_completed=/SCORE:, (c) no unhandled Python traceback. Final line: PATH A pass "VALIDATION_VERDICT=pass rows=<N>"; PATH B pass "VALIDATION_VERDICT=pass rows=0 simulation=true"; fail "VALIDATION_VERDICT=fail reason=<short>".`;

/** Agentic mode: skill-driven ReAct loop that fetches the competition's
 *  expected submission contract and compares the kernel's CSV against it.
 *
 *  Workflow encoded in the `kaggle_validator` skill (DB row), tools wired
 *  here:
 *    - kaggle_list_competition_files
 *    - kaggle_get_competition_file (read sample_submission.csv headers/rows)
 *    - kaggle_get_kernel_output    (pull inlinedCsvFiles['submission.csv'])
 *    - kaggle_validate_submission  (deterministic header/row/id parity check)
 *
 *  After the agent completes, the handler:
 *    1. Best-effort persists evidence via runSubmissionValidation (rubric audit)
 *    2. Parses the agent's summary for VALIDATION_VERDICT={pass|fail}
 *    3. On pass → emit to submitter; on fail → emit back to strategist
 *
 *  No-op when no DB is wired or no model is available. */
export function createValidatorAgentic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log } = ctx;
  if (!opts.db) {
    return async () => ({ completed: true, summaryProse: 'validator: no-op (no db wired)' });
  }
  if (!opts.plannerModel && !opts.modelResolver) {
    log('validator-agentic: no model or modelResolver wired — falling back to deterministic persistence only');
    return createValidatorDeterministic(ctx);
  }

  const creds = resolveCreds(opts);
  const db = opts.db;

  const buildInner = (model: Model) =>
    weaveLiveAgent({
      name: 'kaggle-validator',
      model,
      maxSteps: 24,
      log,
      ...(opts.policy ? { policy: opts.policy } : {}),
      onError: async (err) => {
        const text = err instanceof Error ? err.message : String(err);
        if (/rate limit/i.test(text) || /\b429\b/.test(text)) {
          log('validator: rate-limit detected; sleeping 65s before next attempt');
          await new Promise((r) => setTimeout(r, 65_000));
        }
      },
      prepare: async ({ inbound }) => {
        // Load DB-driven prompt fresh per tick so admin edits take effect
        // without restarting the supervisor.
        let systemPrompt = FALLBACK_VALIDATOR_PROMPT;
        try {
          const skill = await db.getSkill(KAGGLE_VALIDATOR_SKILL_ID);
          if (skill?.instructions) systemPrompt = skill.instructions;
        } catch (err) {
          log(`validator: getSkill failed, using fallback prompt: ${err instanceof Error ? err.message : String(err)}`);
        }
        const tools = createKaggleTools({ adapter: withPerTickReadCache(adapter), credentials: creds });
        const inboundBody = inbound?.body?.trim() ?? '';
        const userGoal =
          `Validate the Kaggle submission described in the message below. Extract competitionRef and kernelRef from the text, then run the validation workflow per your skill instructions. End your final answer with a single line of exactly:\n` +
          `  VALIDATION_VERDICT=pass rows=<N>\n` +
          `OR\n` +
          `  VALIDATION_VERDICT=fail reason=<short reason>\n\n` +
          `INBOUND MESSAGE:\n${inboundBody || '(empty)'}`;
        return { systemPrompt, tools, userGoal };
      },
    }).handler;

  const staticInner = opts.plannerModel ? buildInner(opts.plannerModel) : null;

  return async (action, context, execCtx) => {
    // Per-tick model resolution (Phase 5 parity with strategist).
    let inner = staticInner;
    if (opts.modelResolver) {
      try {
        const routed = await opts.modelResolver.resolve({
          role: 'validator',
          agentId: context.agent.id,
          meshId: context.agent.meshId,
          capability: { task: 'reasoning' },
        });
        if (routed) inner = buildInner(routed);
      } catch (err) {
        log(`validator: per-tick modelResolver failed; using static planner: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!inner) {
      return { completed: true, summaryProse: 'validator: no model available; skipped.' };
    }

    // Capture inbound payload for downstream emission AND for best-effort
    // rubric persistence (the parsed JSON path still works when the
    // strategist/implementer hands a structured payload).
    const inbound = await loadInboundTask(context);
    const inboundBody = inbound?.body ?? '';
    const parsed = parseInboundJson(inboundBody);

    // Run the LLM ReAct loop.
    const agentResult = await inner(action, context, execCtx);
    const agentSummary =
      (agentResult && 'summaryProse' in agentResult && agentResult.summaryProse) || '';
    const summaryStr = String(agentSummary);
    log(`validator-agentic: agent summaryBytes=${summaryStr.length}`);

    // Best-effort rubric-audit persistence (only when the inbound carried a
    // structured payload with competitionRef + outputs). Never blocks.
    const competitionRef =
      (parsed['competitionId'] as string | undefined) ?? (parsed['competitionRef'] as string | undefined);
    if (competitionRef) {
      const outputFiles = Array.isArray(parsed['outputFiles']) ? (parsed['outputFiles'] as string[]) : [];
      const kernelRef = (parsed['kernelRef'] as string | null | undefined) ?? null;
      const cvScores = (parsed['cvScores'] as CvScoresArtifact | undefined) ?? null;
      const runId = (parsed['runId'] as string | undefined) ?? `kgl-run-${newUUIDv7().slice(-8)}`;
      try {
        const result = await runSubmissionValidation({
          db,
          adapter,
          credentials: creds,
          runId,
          competitionRef,
          tenantId: opts.tenantId ?? null,
          kernelRef,
          outputFiles,
          cvScores,
        });
        log(
          `validator-agentic: rubric persisted verdict=${result.verdict} rubric=${result.rubric.id} violations=${result.violations.length}`,
        );
      } catch (err) {
        log(`validator-agentic: rubric persistence failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Parse the agent's verdict line and route accordingly.
    const verdictMatch = summaryStr.match(/VALIDATION_VERDICT=(pass|fail)/i);
    const verdict = (verdictMatch?.[1] ?? 'fail').toLowerCase();
    const iteration = Number(parsed['iteration'] ?? 0);
    const maxIterations = Number(parsed['maxIterations'] ?? opts.maxIterations ?? DEFAULT_MAX_ITERATIONS);

    // Build a JSON-valid forward body so the next handler (strategist or
    // submitter) can JSON.parse it cleanly. Previously we appended a
    // "--- VALIDATOR VERDICT ---" trailer which broke parseInboundJson and
    // caused the strategist's `lastIteration` to silently default to 0,
    // freezing the run at iteration=1 forever. Embed the verdict as a field
    // and preserve every key from the inbound payload (so iteration,
    // maxIterations, kernelRef, history, etc. round-trip).
    const forwardJson = {
      ...parsed,
      validatorVerdict: verdict,
      validatorVerdictLine: summaryStr.match(/VALIDATION_VERDICT=[^\n]*/i)?.[0] ?? null,
      validatorSummary: summaryStr,
    };

    if (verdict === 'pass') {
      await emitToNextAgent(
        context,
        'submitter',
        `Validated submission for ${competitionRef ?? 'unknown'} (iteration ${iteration})`,
        JSON.stringify(forwardJson, null, 2),
        'kaggle.validation.final',
      );
      return {
        completed: true,
        summaryProse: `Validator (agentic) PASSED iteration ${iteration}; forwarded to submitter. ${summaryStr.slice(0, 280)}`,
      };
    }

    // Verdict=fail or unparseable → bounce back to strategist for another
    // iteration (or stop if we're at max).
    if (iteration >= maxIterations) {
      log(`validator-agentic: fail at max iterations (${iteration}/${maxIterations}); not re-emitting.`);
      return {
        completed: true,
        summaryProse: `Validator (agentic) FAILED at max iterations (${iteration}/${maxIterations}). ${summaryStr.slice(0, 280)}`,
      };
    }
    await emitToNextAgent(
      context,
      'strategist',
      `Validation failed for ${competitionRef ?? 'unknown'} iteration ${iteration}`,
      JSON.stringify(forwardJson, null, 2),
      'kaggle.validation.iteration',
    );
    return {
      completed: true,
      summaryProse: `Validator (agentic) FAILED iteration ${iteration}; bounced to strategist. ${summaryStr.slice(0, 280)}`,
    };
  };
}

/** Deterministic mode: forwards mid-loop feedback to the strategist or
 *  finalizes by emitting to the submitter. Persists when DB is wired. */
export function createValidatorDeterministic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log } = ctx;
  return async (_action, context) => {
    const inbound = await loadInboundTask(context);
    if (!inbound) return { completed: true, summaryProse: 'Validator had no inbound payload; skipped.' };

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(inbound.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const iteration = Number(parsed['iteration'] ?? 0);
    const maxIterations = Number(parsed['maxIterations'] ?? DEFAULT_MAX_ITERATIONS);
    const done = parsed['done'] === true;
    const status = (parsed['kernelStatus'] as string) ?? 'unknown';
    const competitionId = (parsed['competitionId'] as string) ?? 'unknown';
    const submissionWriter = (parsed['submissionWriter'] as string | undefined) ?? 'kernel_emits_file';
    const isKernelAsSubmission = submissionWriter === 'kernel_is_submission';
    const outputFilesArr = Array.isArray(parsed['outputFiles']) ? (parsed['outputFiles'] as string[]) : [];
    const hasSubmissionFile = outputFilesArr.some((f) => f === 'submission.json' || f === 'submission.csv');
    // PATH B (kernel-as-submission / live-API): no submission.csv required.
    // Pass when kernel completed and the log tail looks scored.
    const kernelLogTail = (parsed['kernelLogTail'] as string | undefined) ?? (parsed['kernelOutput'] as string | undefined) ?? '';
    const hasScoreLine = /AGENT_RESULT|total_score\s*[:=]|final_score\s*=|levels_completed\s*=|^SCORE:|^SCORECARD:/im.test(kernelLogTail);
    const hasTraceback = /Traceback \(most recent call last\):/.test(kernelLogTail);
    const pathBPass = isKernelAsSubmission && status === 'complete' && (hasScoreLine || kernelLogTail === '') && !hasTraceback;

    if (opts.db && competitionId !== 'unknown') {
      const outputFiles = Array.isArray(parsed['outputFiles']) ? (parsed['outputFiles'] as string[]) : [];
      const kernelRef = (parsed['kernelRef'] as string | null | undefined) ?? null;
      const cvScores = (parsed['cvScores'] as CvScoresArtifact | undefined) ?? null;
      const runId = (parsed['runId'] as string | undefined) ?? `kgl-run-${newUUIDv7().slice(-8)}`;
      try {
        const creds = resolveCreds(opts);
        const result = await runSubmissionValidation({
          db: opts.db,
          adapter,
          credentials: creds,
          runId,
          competitionRef: competitionId,
          tenantId: opts.tenantId ?? null,
          kernelRef,
          outputFiles,
          cvScores,
        });
        log(`validator(persist): verdict=${result.verdict} rubric=${result.rubric.id} violations=${result.violations.length}`);
      } catch (err) {
        log(`validator(persist): failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (done || pathBPass || iteration >= maxIterations) {
      const verdictLine = pathBPass
        ? 'VALIDATION_VERDICT=pass rows=0 simulation=true'
        : `VALIDATION_VERDICT=${hasSubmissionFile ? 'pass' : 'fail'} rows=${hasSubmissionFile ? 'unknown' : '0'}`;
      const forwardBody = `${inbound.body}\n\n--- VALIDATOR VERDICT ---\n${verdictLine}`;
      await emitToNextAgent(
        context,
        'submitter',
        `Validated final payload for ${competitionId} after ${iteration} iteration(s)`,
        forwardBody,
        'kaggle.validation.final',
      );
      return {
        completed: true,
        summaryProse: `Validator finalized after iteration ${iteration} (status=${status}, submission=${hasSubmissionFile}, simulation=${pathBPass}); forwarded to submitter.`,
      };
    }

    await emitToNextAgent(
      context,
      'strategist',
      `Iteration ${iteration} feedback for ${competitionId}`,
      inbound.body,
      'kaggle.validation.iteration',
    );
    return {
      completed: true,
      summaryProse: `Validator forwarded iteration ${iteration} feedback to strategist (status=${status}, submission=${hasSubmissionFile}).`,
    };
  };
}
