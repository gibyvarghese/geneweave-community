/**
 * GeneWeave chat — redaction and post-eval helpers
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { ExecutionContext } from '@weaveintel/core';
import { weaveRedactor } from '@weaveintel/guardrails/redaction';
import { weaveEvalRunner } from '@weaveintel/testing/evals';
import type { DatabaseAdapter } from './db.js';

/** Tool names whose output is for internal reasoning only and should be excluded from tool-evidence filters. */
export const SUPERVISOR_INTERNAL_TOOLS = new Set(['think', 'plan', 'synthesize', 'reflect', 'log']);

// ── Redaction ───────────────────────────────────────────────

export async function applyRedaction(
  ctx: ExecutionContext,
  text: string,
  patterns: string[],
): Promise<{ redacted: string; wasModified: boolean; detections: Array<{ type: string; start: number; end: number }>; error?: string }> {
  try {
    const redactor = weaveRedactor({
      patterns: patterns.map((p) => ({ name: p, type: 'builtin' as const, builtinType: p })),
      reversible: true,
    });
    const result = await redactor.redact(ctx, text);
    return {
      redacted: result.redacted,
      wasModified: result.wasModified,
      detections: result.detections.map((d) => ({ type: d.type, start: d.start, end: d.end })),
    };
  } catch {
    return {
      redacted: text,
      wasModified: false,
      detections: [],
      error: 'redaction_failed',
    };
  }
}

// ── Post-eval ───────────────────────────────────────────────

export async function runPostEval(
  db: DatabaseAdapter,
  ctx: ExecutionContext,
  userId: string,
  chatId: string,
  input: string,
  output: string,
  latencyMs: number,
  cost: number,
  guardrailDecision?: 'allow' | 'warn' | 'deny',
): Promise<{ passed: number; failed: number; total: number; score: number } | { error: string }> {
  try {
    // The executor here is a pass-through: it re-surfaces the pre-computed
    // output from the call context so the assertion runner can score it.
    // A model-judge executor (calling an LLM to grade semantic quality) is
    // not yet wired — assertions are limited to structural checks (regex,
    // latency, cost, guardrail decision) until that is added.
    const runner = weaveEvalRunner({
      executor: async (_ctx, inp) => ({
        output: inp['output'] as string,
        guardrailDecision: inp['guardrailDecision'] as string,
      }),
    });

    const result = await runner.run(ctx, {
      name: 'chat_response_quality',
      description: 'Quick quality check on chat response',
      type: 'model',
      assertions: [
        { name: 'not_empty', type: 'regex', config: { pattern: '.+' } },
        { name: 'latency_ok', type: 'latency_threshold', config: { maxMs: 30_000 } },
        { name: 'cost_ok', type: 'cost_threshold', config: { maxCostUsd: 1.0 } },
        { name: 'safety', type: 'safety', config: { blockedPhrases: [] } },
        { name: 'guardrail_ok', type: 'guardrail_decision', config: { warnPenalty: 0.25, denyPenalty: 1.0 } },
      ],
    }, [
      { id: 'msg', input: { output, latencyMs, costUsd: cost, guardrailDecision: guardrailDecision ?? 'allow' }, expected: {} },
    ]);

    const info = {
      passed: result.passed,
      failed: result.failed,
      total: result.totalCases * result.results[0]!.assertions.length,
      score: result.avgScore ?? (result.passed / (result.passed + result.failed || 1)),
    };

    // Persist
    await db.recordEval({
      id: newUUIDv7(), userId, chatId,
      evalName: 'chat_response_quality',
      score: info.score, passed: info.passed, failed: info.failed, total: info.total,
      details: JSON.stringify(result.results[0]?.assertions),
    });

    return info;
  } catch {
    return { error: 'post_eval_failed' };
  }
}
