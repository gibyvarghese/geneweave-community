/** Kaggle Strategist — agentic LLM ReAct loop wrapper + deterministic preset rotator. */
import type { TaskHandler } from '@weaveintel/live-agents';
import type { KaggleCompetition } from '../../../kaggle/index.js';
import { createKaggleStrategistHandler } from '../strategist-agent.js';
import {
  competitionSlugFrom,
  emitToNextAgent,
  loadInboundTask,
  parseInboundJson,
  resolveCreds,
  tryResolvePlaybook,
  DEFAULT_MAX_ITERATIONS,
  type SharedHandlerContext,
} from './_shared.js';

/** Agentic strategist — wraps the package-level agentic handler and emits
 *  its final summary to the submitter so the pipeline-completion check still fires.
 *
 *  Per-tick model routing (Phase 5): the inner ReAct handler is rebuilt on
 *  every invocation with the model `opts.modelResolver` picks for the
 *  strategist's reasoning task. This lets the framework rotate models based
 *  on health/cost on every tick — when one provider rate-limits or runs out
 *  of credit, the next tick picks a different one. When `opts.plannerModel`
 *  is set (e.g. tests, single-model deployments) it is used as a static
 *  fallback whenever the resolver returns `undefined` or throws. */
export function createStrategistAgenticWithHandoff(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log } = ctx;
  if (!opts.plannerModel && !opts.modelResolver) {
    throw new Error(
      'createStrategistAgenticWithHandoff requires opts.plannerModel or opts.modelResolver',
    );
  }
  const creds = resolveCreds(opts);
  const maxSteps = opts.maxIterations ? Math.max(opts.maxIterations * 12, 40) : 60;

  // Build the inner handler factory once; the per-call wrapper resolves the
  // model fresh each tick so SmartModelRouter can rotate based on current
  // provider health. Per-tick overrides for L6-L9 (maxStepsCap,
  // reasoningEffortHint, toolOutputTruncator, budgetGate) are merged into
  // `phase7` and forwarded to the inner factory; when the resolver is
  // unset the boot-time scalar `opts.*` fields are used as-is.
  type Phase7Levers = {
    maxStepsCap?: number;
    reasoningEffortHint?: import('@weaveintel/cost-governor').ReasoningEffort;
    toolOutputTruncator?: import('@weaveintel/cost-governor').ToolOutputTruncator;
    budgetGate?: import('@weaveintel/cost-governor').CostBudgetGate;
  };
  const buildInner = (model: import('@weaveintel/core').Model, phase7: Phase7Levers = {}) => {
    const maxStepsCap = phase7.maxStepsCap ?? opts.maxStepsCap;
    const reasoningEffortHint = phase7.reasoningEffortHint ?? opts.reasoningEffortHint;
    const toolOutputTruncator = phase7.toolOutputTruncator ?? opts.toolOutputTruncator;
    const budgetGate = phase7.budgetGate ?? opts.budgetGate;
    return createKaggleStrategistHandler({
      model,
      adapter,
      credentials: creds,
      maxSteps,
      log,
      playbookResolver: opts.playbookResolver,
      ...(opts.policy ? { policy: opts.policy } : {}),
      ...(opts.onKernelPushed ? { onKernelPushed: opts.onKernelPushed } : {}),
      ...(opts.onToolBlocked ? { onToolBlocked: opts.onToolBlocked } : {}),
      ...(opts.traceToolsFactory ? { traceToolsFactory: opts.traceToolsFactory } : {}),
      ...(opts.costToolFilter ? { costToolFilter: opts.costToolFilter } : {}),
      ...(opts.intelGate ? { intelGate: opts.intelGate } : {}),
      ...(maxStepsCap !== undefined ? { maxStepsCap } : {}),
      ...(reasoningEffortHint ? { reasoningEffortHint } : {}),
      ...(toolOutputTruncator ? { toolOutputTruncator } : {}),
      ...(budgetGate ? { budgetGate } : {}),
    });
  };

  // (Inner handler is built per-tick to merge any per-tick L6-L9 overrides
  // returned by `opts.phase7Resolver`.)

  return async (action, context, execCtx) => {
    log(`[STRATEGIST-AGENTIC-ENTRY] mesh=${context.agent.meshId} agent=${context.agent.id}`);
    // Per-tick L6-L9 resolution. Bound to live (meshId, agentId) so an
    // operator-supplied mesh- or agent-scoped capability_policy_bindings row
    // overrides the workflow- or tenant-default policy on every tick. Falls
    // back to boot-time scalars on throw / unset.
    let phase7Levers: Phase7Levers = {};
    if (opts.phase7Resolver) {
      try {
        phase7Levers = await opts.phase7Resolver({
          meshId: context.agent.meshId,
          agentId: context.agent.id,
        });
      } catch (err) {
        log(
          `!! per-tick phase7Resolver failed; using boot-time scalars: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    let inner = opts.plannerModel ? buildInner(opts.plannerModel, phase7Levers) : null;
    if (opts.modelResolver) {
      try {
        const routed = await opts.modelResolver.resolve({
          role: 'strategist',
          agentId: context.agent.id,
          meshId: context.agent.meshId,
          capability: { task: 'reasoning' },
        });
        if (routed) {
          inner = buildInner(routed, phase7Levers);
          // Log the per-tick selection so operators can see SmartModelRouter
          // rotating models across ticks (especially useful when a provider
          // rate-limits and routing skips it on the next tick).
          const routedId =
            (routed as unknown as { id?: string }).id ??
            (routed as unknown as { modelId?: string }).modelId ??
            'unknown';
          log(`per-tick model resolved → ${routedId}`);
        }
      } catch (err) {
        log(
          `!! per-tick modelResolver failed; using static planner: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!inner) {
      return { completed: true, summaryProse: 'Strategist had no model available; skipped.' };
    }
    const result = await inner(action, context, execCtx);
    const summary = (result && 'summaryProse' in result && result.summaryProse) || 'Strategist agent finished.';
    // Phase-fix: hand off to implementer (not validator) so the kernel actually
    // gets authored before validation. Implementer parses the body as JSON
    // ({ competitionId, iteration, strategyLabel, history, ... }), so we must
    // produce that shape here — emitting only the LLM summary leaves implementer
    // with no competitionId and the run stalls. We extract competition context
    // from the same inbound the inner handler just consumed (either the
    // discoverer's `{ competitions: [...] }` or validator feedback that already
    // carries `competitionId`).
    const inbound = await loadInboundTask(context);
    const inboundJson = parseInboundJson(inbound?.body);
    let competitionId = (inboundJson['competitionId'] as string) ?? '';
    let title = (inboundJson['title'] as string) ?? '';
    let metric = (inboundJson['metric'] as string) ?? 'unknown';
    let lastIteration = Number(inboundJson['iteration'] ?? 0);
    const history =
      (inboundJson['history'] as Array<{ iteration: number; label: string; status: string }>) ?? [];
    if (!competitionId && Array.isArray((inboundJson as { competitions?: unknown }).competitions)) {
      const comps = (inboundJson as { competitions: Array<Record<string, unknown>> }).competitions;
      const first = comps[0];
      // Discoverer wraps each entry as { competition: {...}, intel: {...} }
      // but legacy/deterministic paths may emit a flat KaggleCompetition. Accept both.
      const comp = (first?.['competition'] as KaggleCompetition | undefined) ?? (first as KaggleCompetition | undefined);
      if (comp) {
        competitionId = comp.id;
        title = comp.title ?? title;
        metric = comp.evaluationMetric ?? metric;
        lastIteration = 0;
      }
    }
    // Agentic discoverer emits a free-text body whose first line is
    // `competitionId: <slug>` rather than JSON. Fall through to a regex
    // probe of the raw body so we still hand off cleanly in that mode.
    if (!competitionId && inbound?.body) {
      const m = inbound.body.match(/competitionId\s*:\s*([^\s\n]+)/i);
      if (m && m[1]) competitionId = m[1].trim();
    }
    // As a last resort, try to lift a slug out of the agentic summary itself
    // (the LLM frequently says "I will work on <slug>"). Match a `kaggle.com/competitions/<slug>` URL too.
    if (!competitionId) {
      const summaryStr = String(summary);
      const url = summaryStr.match(/competitions\/([a-z0-9-]+)/i);
      if (url && url[1]) competitionId = url[1];
    }
    if (!competitionId) {
      log('agentic strategist: no competitionId in inbound; cannot hand off to implementer.');
      return result ?? { completed: true };
    }
    const slug = competitionSlugFrom(competitionId);
    const playbook = await tryResolvePlaybook(opts.playbookResolver, slug, 0, {}, log);
    const maxIterations =
      Number(inboundJson['maxIterations']) ||
      playbook?.config.maxIterations ||
      opts.maxIterations ||
      DEFAULT_MAX_ITERATIONS;
    const iteration = lastIteration + 1;

    // Phase-fix (handoff data preservation): when the agentic strategist has
    // already pushed kernels via its own ReAct tool loop, the deterministic
    // implementer would skip (no playbook.solverTemplate for unknown comps)
    // and the kernels the strategist actually pushed would be lost. Parse the
    // machine-readable kernel block embedded by `summarizeKaggleRun` and route
    // it directly to the validator in the validator's expected shape.
    const kernel = parseKernelHandoffBlock(String(summary));
    if (kernel) {
      const validatorPayload = {
        competitionId,
        title,
        metric,
        iteration,
        maxIterations,
        playbookId: playbook?.skillId ?? null,
        playbookName: playbook?.name ?? null,
        strategyLabel: 'agentic',
        // Forward the submission contract from the playbook so the validator
        // picks the right branch (PATH A kernel_emits_file vs PATH B
        // kernel_is_submission). Without this, the validator defaults to
        // PATH A and rejects every kernel for live-API competitions.
        submissionWriter: playbook?.config.submissionWriter ?? null,
        submissionFormat: playbook?.config.submissionFormat ?? null,
        submissionFilename: playbook?.config.submissionFilename ?? null,
        kernelRef: kernel.kernelRef,
        kernelUrl: kernel.kernelUrl,
        kernelStatus: kernel.kernelStatus,
        failureMessage: kernel.failureMessage,
        outputFiles: kernel.outputFiles,
        logExcerpt: kernel.logExcerpt,
        agenticSummary: String(summary),
        history: [...history, { iteration, label: 'agentic', status: kernel.kernelStatus }],
      };
      await emitToNextAgent(
        context,
        'validator',
        `Iteration ${iteration} kernel result for ${competitionId} (agentic)`,
        JSON.stringify(validatorPayload, null, 2),
        'kaggle.implementer.kernel-result',
      );
      log(
        `agentic strategist: routed kernel ${kernel.kernelRef} (status=${kernel.kernelStatus}) ` +
          `directly to validator, bypassing implementer (no solverTemplate path).`,
      );
      return result ?? { completed: true };
    }

    // No kernel pushed by the strategist this tick — fall back to deterministic
    // implementer handoff so a playbook-driven solverTemplate (if any) can run.
    const approach = {
      competitionId,
      title,
      metric,
      iteration,
      maxIterations,
      playbookId: playbook?.skillId ?? null,
      playbookName: playbook?.name ?? null,
      strategyLabel: 'agentic',
      agenticSummary: String(summary),
      history,
    };
    await emitToNextAgent(
      context,
      'implementer',
      `Approach plan iteration ${iteration} for ${competitionId} (agentic)`,
      JSON.stringify(approach, null, 2),
      'kaggle.strategy.approach',
    );
    return result ?? { completed: true };
  };
}

/** Parse the `---KERNEL_HANDOFF_JSON---` block embedded by
 *  `summarizeKaggleRun` (in strategist-agent.ts). Returns null when the
 *  marker is absent (no kernel pushed this tick) or the JSON is malformed. */
interface ExtractedKernelResult {
  kernelRef: string;
  kernelUrl: string;
  kernelStatus: string;
  failureMessage: string | null;
  outputFiles: string[];
  logExcerpt: string;
}

function parseKernelHandoffBlock(summary: string): ExtractedKernelResult | null {
  const m = summary.match(
    /---KERNEL_HANDOFF_JSON---\s*([\s\S]*?)\s*---END_KERNEL_HANDOFF_JSON---/,
  );
  if (!m || !m[1]) return null;
  try {
    const parsed = JSON.parse(m[1]) as Partial<ExtractedKernelResult>;
    if (!parsed || typeof parsed.kernelRef !== 'string' || !parsed.kernelRef) return null;
    return {
      kernelRef: parsed.kernelRef,
      kernelUrl: typeof parsed.kernelUrl === 'string' ? parsed.kernelUrl : '',
      kernelStatus: typeof parsed.kernelStatus === 'string' ? parsed.kernelStatus : 'pushed',
      failureMessage:
        typeof parsed.failureMessage === 'string' && parsed.failureMessage.length > 0
          ? parsed.failureMessage
          : null,
      outputFiles: Array.isArray(parsed.outputFiles) ? parsed.outputFiles.map(String) : [],
      logExcerpt: typeof parsed.logExcerpt === 'string' ? parsed.logExcerpt : '',
    };
  } catch {
    return null;
  }
}

/** Deterministic strategist — branches on inbound shape:
 *   1. discovery payload `{ competitions: [...] }` → start iteration 1
 *   2. validator feedback `{ competitionId, iteration, history, ... }` → mutate or finish */
export function createStrategistDeterministic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, log } = ctx;
  return async (_action, context) => {
    const inbound = await loadInboundTask(context);
    if (!inbound) return { completed: true, summaryProse: 'Strategist had no inbound payload; skipped.' };

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(inbound.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }

    // Branch 1: discovery payload → start iteration 1.
    if (Array.isArray((parsed as { competitions?: unknown }).competitions)) {
      const comps = (parsed as { competitions: Array<Record<string, unknown>> }).competitions;
      const first = comps[0];
      // Deterministic discoverer wraps each entry as { competition, intel }.
      // Legacy callers may pass a flat KaggleCompetition. Accept both.
      const comp = (first?.['competition'] as KaggleCompetition | undefined) ?? (first as KaggleCompetition | undefined);
      if (!comp || !comp.id) return { completed: true, summaryProse: 'Strategist: empty competition list.' };
      const slug = competitionSlugFrom(comp.id);
      const playbook = await tryResolvePlaybook(opts.playbookResolver, slug, 0, {}, log);
      const maxIterations = playbook?.config.maxIterations ?? opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      const presetLabel = playbook?.config.strategyPresets?.[0]?.label ?? 'default';
      const approach = {
        competitionId: comp.id,
        title: comp.title,
        metric: comp.evaluationMetric ?? 'unknown',
        iteration: 1,
        maxIterations,
        playbookId: playbook?.skillId ?? null,
        playbookName: playbook?.name ?? null,
        strategyLabel: presetLabel,
        history: [] as Array<{ iteration: number; label: string; status: string }>,
      };
      await emitToNextAgent(
        context,
        'implementer',
        `Approach plan iteration 1 for ${comp.id}`,
        JSON.stringify(approach, null, 2),
        'kaggle.strategy.approach',
      );
      return {
        completed: true,
        summaryProse: `Strategist seeded iteration 1 for ${comp.id} with playbook=${playbook?.name ?? 'none'} preset=${presetLabel}; forwarded to implementer.`,
      };
    }

    // Branch 2: feedback from validator → mutate or finish.
    const competitionId = (parsed['competitionId'] as string) ?? 'unknown';
    const lastIteration = Number(parsed['iteration'] ?? 0);
    const lastStatus = (parsed['kernelStatus'] as string) ?? 'unknown';
    const history = (parsed['history'] as Array<{ iteration: number; label: string; status: string }>) ?? [];
    const slug = competitionSlugFrom(competitionId);
    const playbook = await tryResolvePlaybook(opts.playbookResolver, slug, 0, {}, log);
    const maxIterations =
      Number(parsed['maxIterations']) || playbook?.config.maxIterations || opts.maxIterations || DEFAULT_MAX_ITERATIONS;
    const nextIteration = lastIteration + 1;
    if (nextIteration > maxIterations) {
      log(`Strategist: max iterations reached (${maxIterations}); finishing.`);
      const finalPayload = { ...parsed, done: true };
      await emitToNextAgent(
        context,
        'validator',
        `Iteration loop complete for ${competitionId}`,
        JSON.stringify(finalPayload, null, 2),
        'kaggle.strategy.done',
      );
      return {
        completed: true,
        summaryProse: `Strategist completed ${maxIterations}-iteration loop for ${competitionId}; final status=${lastStatus}.`,
      };
    }
    const presets = playbook?.config.strategyPresets ?? [];
    const presetIdx = presets.length > 0 ? (nextIteration - 1) % presets.length : 0;
    const presetLabel = presets[presetIdx]?.label ?? `iteration-${nextIteration}`;
    const next = {
      competitionId,
      title: parsed['title'] ?? '',
      metric: parsed['metric'] ?? 'unknown',
      iteration: nextIteration,
      maxIterations,
      playbookId: playbook?.skillId ?? null,
      playbookName: playbook?.name ?? null,
      strategyLabel: presetLabel,
      history,
    };
    await emitToNextAgent(
      context,
      'implementer',
      `Approach plan iteration ${nextIteration} for ${competitionId}`,
      JSON.stringify(next, null, 2),
      'kaggle.strategy.approach',
    );
    return {
      completed: true,
      summaryProse: `Strategist mutated to preset ${presetLabel} for iteration ${nextIteration}; forwarded to implementer.`,
    };
  };
}
