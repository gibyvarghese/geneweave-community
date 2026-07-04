/**
 * GeneWeave chat — guardrail evaluation and human-task policy helpers
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 *
 * evaluateGuardrails now also:
 *   - Passes an optional Model to the pipeline so model-graded guardrails
 *     can run when a model reference is available.
 *   - Loads escalation_policy rows from the DB, evaluates them after the
 *     pipeline run, and persists the EscalationResult alongside the eval row.
 */

import { newUUIDv7, createLogger } from '@weaveintel/core';
import type { AgentStep, EscalationPolicy, Guardrail, GuardrailResult, GuardrailStage, Model } from '@weaveintel/core';

const logger = createLogger('chat-guardrail-eval');

// ── Tool-category extraction ────────────────────────────────────────────────
// Maps tool call names → the canonical category string used in condition trees.
// Categories mirror the design doc signal space: cse, web_search, api, file, external.

export function extractToolCategories(steps: AgentStep[]): string[] {
  const cats = new Set<string>();
  for (const s of steps) {
    const name = (s.toolCall?.name ?? '').toLowerCase();
    if (!name) continue;
    if (name.includes('cse')) cats.add('cse');
    else if (name.includes('search') || name.includes('web')) cats.add('web_search');
    else if (name.includes('file') || name.includes('read_file') || name.includes('write_file') || name.includes('fs_')) cats.add('file');
    else if (name.includes('http') || name.includes('fetch') || name.includes('request') || name.includes('api')) cats.add('api');
    else cats.add('external');
  }
  return [...cats];
}

// ── Preview PII scrubber ────────────────────────────────────────────────────
// Applied to the first 100 chars stored in guardrail_evals.input_preview so
// that PII never lands in the audit table even when per-chat redaction is off.
// Uses the same four patterns as DEFAULT_SETTINGS.redactionPatterns.
const PREVIEW_PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
  [/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[CREDIT_CARD]'],
];

function scrubPreview(text: string): string {
  let result = text;
  for (const [pattern, token] of PREVIEW_PII_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), token);
  }
  return result;
}

// ── Injection guardrail ID registry ────────────────────────────────────────
// Used to detect prior injection warns without relying on fragile string matching
// in explanations. Add new injection guardrail IDs here as they are seeded.
const INJECTION_GUARDRAIL_IDS = new Set([
  'b1c2d3e4-0003-4000-8000-000000000003', // Prompt Injection Classifier (model-graded)
  'c1000001-aaaa-4000-8000-000000000001', // Prompt Injection: Role-Play Bypass
  'c1000002-aaaa-4000-8000-000000000002', // Prompt Injection: God-Mode Bypass
  'c1000003-aaaa-4000-8000-000000000003', // Indirect/Hypothetical Wrapper
  'c1000004-aaaa-4000-8000-000000000004', // Base64 Encoded Instruction
  '7c8988ba-b7c9-4e52-8139-732e5c922a25', // Prompt Injection: Directive Override
  '0eb8ae21-e411-4dae-921f-3f91651619d9', // Prompt Injection: Prompt Exfiltration
]);
import { getActiveGuardrailJudgeModel, getActiveGuardrailModerationModel, getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import {
  createGuardrailPipeline,
  evaluateEscalation,
  hasDeny,
  hasWarning,
  getDenyReason,
  summarizeGuardrailResults,
  buildInputSignals,
  buildOutputSignals,
  type GuardrailCategorySummary,
  type GuardrailConditionContext,
  type EscalationContext,
} from '@weaveintel/guardrails';
import { PolicyEvaluator, createPolicy } from '@weaveintel/human-tasks';
import { normalizeGuardrail, stageMatches } from './chat-guardrail-utils.js';
import type { DatabaseAdapter } from './db.js';
import { resolveLimits } from './platform-limits.js';

// ── Escalation policy loading ───────────────────────────────

function parseEscalationPolicy(row: { id: string; name: string; description: string | null; config: string | null; enabled: number }): EscalationPolicy | null {
  if (!row.config) return null;
  try {
    const cfg = JSON.parse(row.config) as Record<string, unknown>;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      enabled: row.enabled === 1,
      trigger: {
        minWarnCount: typeof cfg['min_warn_count'] === 'number' ? cfg['min_warn_count'] : undefined,
        categories: Array.isArray(cfg['categories']) ? cfg['categories'] as string[] : undefined,
        riskLevels: Array.isArray(cfg['risk_levels']) ? cfg['risk_levels'] as EscalationPolicy['trigger']['riskLevels'] : undefined,
      },
      onEscalate: cfg['on_escalate'] === 'require-approval' ? 'require-approval' : 'block',
    };
  } catch {
    return null;
  }
}

// ── Guardrail evaluation ────────────────────────────────────

export interface EvaluateGuardrailsOpts {
  /** Optional model to pass into PipelineOptions for model-graded evaluators (W2/W3). */
  model?: Model;
  /** Optional pipeline budget in ms — skip model-graded checks if exceeded (W9). */
  budgetMs?: number;
  /** Max chars of input passed to the guardrail pipeline. Defaults to platform limit (8000). */
  maxInputChars?: number;
  /** Tenant ID used to resolve per-tenant limits. */
  tenantId?: string | null;
  // ── Condition context fields (used for conditional trigger evaluation) ──────
  /** User persona (e.g. 'tenant_user', 'anonymous', 'platform_admin'). Defaults to 'tenant_user'. */
  persona?: string;
  /** Whether the user account is newly created. Defaults to false. */
  isNewUser?: boolean;
  /** Chat mode (e.g. 'chat', 'agent', 'supervisor'). Defaults to 'chat'. */
  chatMode?: string;
  /** Turn number within the current conversation (1-based). Defaults to 1. */
  turnNumber?: number;
  /** Whether this turn contains tool calls. Defaults to false. */
  hasToolCalls?: boolean;
  /** Tool categories present in this turn (derived from steps if steps is provided). */
  toolCategories?: string[];
  /** Risk level from routing (e.g. 'low', 'medium', 'high', 'critical'). Defaults to 'low'. */
  riskLevel?: string;
  /** Prior guardrail results from the pre-stage run — drives the prior.* cascade into the post-stage context. */
  priorGuardrailResults?: GuardrailResult[];
  /** Agent steps from this turn. When provided, hasToolCalls and toolCategories are derived automatically. */
  steps?: AgentStep[];
}

export async function evaluateGuardrails(
  db: DatabaseAdapter,
  chatId: string,
  messageId: string | null,
  input: string,
  stage: GuardrailStage,
  refs?: { userInput?: string; assistantOutput?: string; toolEvidence?: string },
  opts?: EvaluateGuardrailsOpts,
): Promise<{
  decision: 'allow' | 'deny' | 'warn';
  reason?: string;
  results: GuardrailResult[];
  cognitive?: GuardrailCategorySummary;
  escalation?: ReturnType<typeof evaluateEscalation> extends Promise<infer T> ? T : never;
  error?: string;
}> {
  try {
    const rows = await db.listGuardrails();
    const guardrailRows = rows.filter(r => r.enabled && r.type !== 'escalation_policy' && stageMatches(r.stage, stage));
    const escalationRows = rows.filter(r => r.enabled && r.type === 'escalation_policy');

    const guardrails: Guardrail[] = guardrailRows.map(r => normalizeGuardrail(r, stage));
    const escalationPolicies: EscalationPolicy[] = escalationRows
      .map(r => parseEscalationPolicy(r))
      .filter((p): p is EscalationPolicy => p !== null);

    // Truncate before pipeline so neither the normalizer nor the LLM judge
    // ever processes a pathologically large input (e.g. 100K-char flood inputs).
    const limits = await resolveLimits(db, opts?.tenantId);
    const maxInputChars = opts?.maxInputChars ?? limits.guardrail_input_max_chars;
    const guardedInput = input.length > maxInputChars ? input.slice(0, maxInputChars) : input;
    const guardedUserInput = (refs?.userInput ?? input).slice(0, maxInputChars);

    const judgeModel: Model | undefined = opts?.model ?? getActiveGuardrailJudgeModel();

    // Build condition context so trigger conditions gate guardrail execution.
    const prior = opts?.priorGuardrailResults ?? [];
    // Derive tool info: steps opt takes precedence over individual hasToolCalls/toolCategories opts.
    const resolvedSteps = opts?.steps;
    const hasToolCalls = resolvedSteps != null
      ? resolvedSteps.some(s => !!s.toolCall)
      : (opts?.hasToolCalls ?? false);
    const toolCategories = resolvedSteps != null
      ? extractToolCategories(resolvedSteps)
      : (opts?.toolCategories ?? []);

    // A result counts as a real warn/deny only if it was not skipped by condition evaluation.
    const activeWarns = prior.filter(r =>
      (r.decision === 'warn' || r.decision === 'deny') && !r.metadata?.['skipped'],
    );

    const conditionContext: GuardrailConditionContext = {
      user: { persona: opts?.persona ?? 'tenant_user', isNew: opts?.isNewUser ?? false },
      chat: { mode: opts?.chatMode ?? 'direct' },
      turn: { number: opts?.turnNumber ?? 1, hasToolCalls, toolCategories },
      risk: { level: opts?.riskLevel ?? 'low', verb: opts?.chatMode ?? 'direct' },
      prior: {
        hasWarn: activeWarns.length > 0,
        hasCognitiveWarn: activeWarns.some(r => String(r.metadata?.['category'] ?? '') === 'cognitive'),
        hasInjectionWarn: activeWarns.some(r => INJECTION_GUARDRAIL_IDS.has(r.guardrailId ?? '')),
      },
      input: buildInputSignals(guardedInput),
      output: refs?.assistantOutput != null
        ? buildOutputSignals(refs.assistantOutput, !!refs.toolEvidence)
        : null,
    };

    const hasInjectionGuardrails = guardrailRows.some(r => INJECTION_GUARDRAIL_IDS.has(r.id));

    const pipeline = createGuardrailPipeline(guardrails, {
      shortCircuitOnDeny: true,
      model: judgeModel,
      moderationModel: getActiveGuardrailModerationModel(),
      embeddingModel: getActiveGuardrailEmbeddingModel(),
      budgetMs: opts?.budgetMs,
      budgetExhaustedPolicy: hasInjectionGuardrails ? 'deny' : 'allow',
      conditionContext,
    });

    const results = guardrails.length > 0
      ? await pipeline.evaluate(guardedInput, stage, {
          userInput: guardedUserInput,
          assistantOutput: refs?.assistantOutput,
          toolEvidence: refs?.toolEvidence,
          action: guardedUserInput,
        })
      : [];

    const cognitive = summarizeGuardrailResults(results, 'cognitive') ?? undefined;

    // Evaluate escalation policies (W4)
    const escalationCtx: EscalationContext = { action: refs?.userInput ?? input, results };
    const escalation = await evaluateEscalation(results, escalationPolicies, escalationCtx);

    const decision = hasDeny(results) || escalation.decision === 'deny'
      ? 'deny' as const
      : hasWarning(results)
        ? 'warn' as const
        : 'allow' as const;
    const reason = getDenyReason(results) ?? (escalation.escalated ? escalation.reason : undefined);

    // Persist evaluation (includes escalation result)
    await db.createGuardrailEval({
      id: newUUIDv7(),
      chat_id: chatId,
      message_id: messageId,
      stage,
      input_preview: scrubPreview(input.slice(0, 100)),
      results: JSON.stringify(results),
      overall_decision: decision,
      escalation: escalation.escalated ? JSON.stringify(escalation) : null,
    });

    return { decision, reason, results, cognitive, escalation };
  } catch {
    const reason = stage === 'pre-execution'
      ? 'Guardrail evaluation failed before execution; request blocked.'
      : 'Guardrail evaluation failed after execution; treat response as unverified.';
    return {
      decision: stage === 'pre-execution' ? 'deny' : 'warn',
      reason,
      results: [],
      error: 'guardrail_evaluation_failed',
    };
  }
}

// ── Human-task policy evaluation ────────────────────────────

export async function evaluateTaskPolicies(
  db: DatabaseAdapter,
  steps: AgentStep[],
): Promise<Array<{ tool: string; policy: string; taskType: string; priority: string }>> {
  try {
    const rows = await db.listHumanTaskPolicies();
    const enabledRows = rows.filter(r => r.enabled);
    if (enabledRows.length === 0) return [];

    const evaluator = new PolicyEvaluator();
    for (const row of enabledRows) {
      evaluator.addPolicy(createPolicy({
        name: row.name,
        description: row.description ?? undefined,
        trigger: row.trigger,
        taskType: row.task_type as Parameters<typeof createPolicy>[0]['taskType'],
        defaultPriority: row.default_priority as Parameters<typeof createPolicy>[0]['defaultPriority'],
        slaHours: row.sla_hours ?? undefined,
        autoEscalateAfterHours: row.auto_escalate_after_hours ?? undefined,
        assignmentStrategy: row.assignment_strategy as Parameters<typeof createPolicy>[0]['assignmentStrategy'],
        assignTo: row.assign_to ?? undefined,
        enabled: true,
      }));
    }

    const checks: Array<{ tool: string; policy: string; taskType: string; priority: string }> = [];
    for (const step of steps) {
      if (step.toolCall) {
        const result = evaluator.check({ trigger: step.toolCall.name });
        if (result.required && result.policy) {
          checks.push({
            tool: step.toolCall.name,
            policy: result.policy.name,
            taskType: result.policy.taskType,
            priority: result.policy.defaultPriority,
          });
        }
      }
    }

    return checks;
  } catch (err) {
    logger.error('evaluateTaskPolicies error — returning empty checks', { err });
    return [];
  }
}
