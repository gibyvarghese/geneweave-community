/**
 * Phase E — Ambient guardrails slot for `weaveRuntime`.
 *
 * Reads the DB-managed `guardrails` table and adapts it to the
 * `RuntimeGuardrailsSlot` structural contract from `@weaveintel/core`,
 * so the agent loop, workflow engine, and tool registry consult the
 * same operator-managed rules ambiently — no per-call-site wiring.
 *
 * Two layers of enforcement run inside `checkToolCall`:
 *
 * 1. Built-in risk gate (fast path, no DB access).
 *    Classifies the action string by verb pattern (or trusts the tool
 *    schema's declared `riskLevel`) and returns `{ allow: false }` for
 *    any level listed in `riskGate.denyOn` (default: `['critical']`).
 *    Tools in `riskGate.exemptTools` are skipped. Extra classification
 *    rules can be prepended via `riskGate.extraRules`.
 *
 * 2. DB-driven pipeline (existing behaviour).
 *    Loads all enabled guardrail rows whose stage matches, runs them
 *    through `createGuardrailPipeline`, and blocks on any `deny`.
 *    Warns pass through — the slot is a deny/allow gate, not a scoring
 *    layer; cognitive warn signals are surfaced by the chat pipeline.
 *
 * `checkOutput` runs the `post-execution` DB pipeline against the
 * model's terminal text. Deny → block; warn → pass through.
 *
 * Errors inside both layers are swallowed (allow-through) so a
 * malformed guardrail row or classification failure never crashes a
 * tick. The agent loop's own fail-closed semantics still apply if THIS
 * function throws — but it does not.
 */
import type { ExecutionContext, RiskLevel, RuntimeGuardrailsSlot, Model, ModerationModel, EmbeddingModel } from '@weaveintel/core';
import type { Guardrail, GuardrailResult } from '@weaveintel/core';
import { createGuardrailPipeline, hasDeny, getDenyReason, createRiskClassifier, type RiskRule } from '@weaveintel/guardrails';
import { normalizeGuardrail, stageMatches } from './chat-guardrail-utils.js';
import type { DatabaseAdapter } from './db.js';

// ---------------------------------------------------------------------------
// Public options — exported so callers can type-check their config.
// ---------------------------------------------------------------------------

export interface RiskGateOptions {
  /**
   * Whether the built-in risk gate runs. Default: true.
   * Set false to rely solely on DB-driven guardrail rows.
   */
  readonly enabled?: boolean;
  /**
   * Risk levels that cause `checkToolCall` to return `{ allow: false }`.
   * Default: `['critical']`. Add `'high'` to also block modification ops.
   */
  readonly denyOn?: ReadonlyArray<RiskLevel>;
  /**
   * Tool names exempt from risk gating (case-sensitive match on `schema.name`).
   * Use for internal tools where destructive ops have already been approved.
   */
  readonly exemptTools?: ReadonlyArray<string>;
  /**
   * Extra classification rules prepended to the defaults, evaluated in order.
   * First match wins, so these take precedence over the built-in verb patterns.
   * Example: `{ pattern: 'nuke|wipe|purge', level: 'critical', explanation: '...' }`
   */
  readonly extraRules?: ReadonlyArray<RiskRule>;
}

export interface SlotOptions {
  /**
   * Optional cap on action-string length passed into pre-execution
   * pipeline (avoids dumping massive args into regex evaluators).
   * Default: 4_000 chars.
   */
  readonly maxActionLen?: number;
  /**
   * Built-in risk classification gate applied inside `checkToolCall`
   * before the DB-driven pipeline. Classifies the action string by
   * verb pattern — or trusts the tool schema's declared `riskLevel` —
   * and denies if the resolved level appears in `riskGate.denyOn`.
   */
  readonly riskGate?: RiskGateOptions;
  /**
   * Optional model references for model-graded guardrail evaluators (W2/W3).
   * Use lazy getters so they can be wired after bootstrap resolves the models.
   * Only guards with `type: 'model-graded'` and the matching rule use these.
   */
  readonly getModel?: () => Model | undefined;
  readonly getModerationModel?: () => ModerationModel | undefined;
  readonly getEmbeddingModel?: () => EmbeddingModel | undefined;
  /** Pipeline budget in ms — skip remaining model-graded checks if exceeded (W9). */
  readonly budgetMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const VALID_RISK_LEVELS = new Set<RiskLevel>(['low', 'medium', 'high', 'critical']);

function normalizeSchemaRiskLevel(raw: string | undefined): RiskLevel | undefined {
  return raw && VALID_RISK_LEVELS.has(raw as RiskLevel) ? (raw as RiskLevel) : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function geneweaveGuardrailsSlot(
  db: DatabaseAdapter,
  opts: SlotOptions = {},
): RuntimeGuardrailsSlot {
  const maxActionLen = opts.maxActionLen ?? 4_000;
  const riskGateOpts = opts.riskGate ?? {};
  const riskGateEnabled = riskGateOpts.enabled !== false;
  const denyOn: ReadonlyArray<RiskLevel> = riskGateOpts.denyOn ?? ['critical'];
  const exemptTools = new Set(riskGateOpts.exemptTools ?? []);

  // Build the classifier once at slot construction time.
  // Extra rules are prepended so they take precedence over defaults.
  const classifier = createRiskClassifier(
    riskGateOpts.extraRules ? [...riskGateOpts.extraRules] : undefined,
  );

  // ── DB pipeline helpers ────────────────────────────────────────────────────

  async function loadEnabled(stage: 'pre-execution' | 'post-execution'): Promise<Guardrail[]> {
    try {
      const rows = await db.listGuardrails();
      return rows
        .filter((r) => r.enabled && r.type !== 'escalation_policy' && stageMatches(r.stage, stage))
        .map((r) => normalizeGuardrail(r, stage));
    } catch {
      return [];
    }
  }

  async function evaluate(
    guardrails: Guardrail[],
    input: string,
    stage: 'pre-execution' | 'post-execution',
  ): Promise<GuardrailResult[]> {
    if (guardrails.length === 0) return [];
    try {
      const pipeline = createGuardrailPipeline(guardrails, {
        shortCircuitOnDeny: true,
        model: opts.getModel?.(),
        moderationModel: opts.getModerationModel?.(),
        embeddingModel: opts.getEmbeddingModel?.(),
        budgetMs: opts.budgetMs,
      });
      return await pipeline.evaluate(input, stage, {
        userInput: input,
        action: input,
      });
    } catch {
      return [];
    }
  }

  // ── Slot implementation ────────────────────────────────────────────────────

  return {
    async checkInput(_ctx: ExecutionContext, input: string) {
      // Run the pre-execution DB pipeline against inbound user content
      // (after PII redaction). This is the pre-LLM gate that was previously
      // missing from the slot. Fail-open on any error.
      const guardrails = await loadEnabled('pre-execution');
      if (guardrails.length === 0) return { allow: true };
      const results = await evaluate(guardrails, input.slice(0, maxActionLen), 'pre-execution');
      if (hasDeny(results)) {
        return { allow: false, reason: getDenyReason(results) ?? 'input blocked by guardrail' };
      }
      return { allow: true };
    },

    async checkToolCall(_ctx: ExecutionContext, schema, args) {
      let argStr = '';
      try { argStr = JSON.stringify(args); } catch { argStr = '[unserialisable]'; }
      const action = `tool:${schema.name} args:${argStr}`.slice(0, maxActionLen);

      // Layer 1 — built-in risk gate (fast path, no DB access).
      if (riskGateEnabled && !exemptTools.has(schema.name)) {
        try {
          // Trust the tool schema's declared risk level when available;
          // fall back to classifying the action string.
          const level =
            normalizeSchemaRiskLevel(schema.riskLevel) ??
            (await classifier.classify(action)).level;

          if (denyOn.includes(level)) {
            const { explanation } = await classifier.classify(action);
            return {
              allow: false,
              reason: `Tool "${schema.name}" blocked by risk gate: ${level}-risk action detected. ${explanation}`,
            };
          }
        } catch {
          // Classification error — fail open; DB pipeline still runs.
        }
      }

      // Layer 2 — DB-driven pipeline (blocklist, regex, remaining guardrails).
      const guardrails = await loadEnabled('pre-execution');
      if (guardrails.length === 0) return { allow: true };
      const results = await evaluate(guardrails, action, 'pre-execution');
      if (hasDeny(results)) {
        return { allow: false, reason: getDenyReason(results) ?? `tool ${schema.name} blocked by guardrail` };
      }
      return { allow: true };
    },

    async checkOutput(_ctx: ExecutionContext, text) {
      const guardrails = await loadEnabled('post-execution');
      if (guardrails.length === 0) return { allow: true };
      const results = await evaluate(guardrails, text, 'post-execution');
      if (hasDeny(results)) {
        return { allow: false, reason: getDenyReason(results) ?? 'output blocked by guardrail' };
      }
      return { allow: true };
    },
  };
}
