/**
 * Migration M34 — Guardrail conditional triggers
 *
 * Adds two columns to the guardrails table:
 *   trigger_conditions TEXT  — JSON ConditionNode from @weaveintel/core.
 *                              NULL means "always run" (backward-compatible default).
 *   trigger_description TEXT — human-readable explanation shown in the admin panel.
 *
 * After adding the columns, seeds default trigger conditions for all
 * model-graded and context-sensitive guardrails from the design analysis.
 * Cheap deterministic checks (blocklists, regex, PII, budget) are left with
 * NULL so they continue to run on every message.
 *
 * Conditions are operator-editable at runtime via the admin panel — no deploy
 * required to change them. The pipeline reads conditions on every turn from
 * the DB via listGuardrails().
 */

import type BetterSqlite3 from 'better-sqlite3';

// ── Condition JSON for each seeded guardrail ───────────────────────────────

const CONDITIONS: Array<{ id: string; trigger_conditions: string; trigger_description: string }> = [
  // ── Model-graded: Prompt Injection Classifier (pre, 15s LLM call) ─────────
  {
    id: 'b1c2d3e4-0003-4000-8000-000000000003',
    trigger_conditions: JSON.stringify({
      any: [
        { input_has_code: true },
        { input_has_base64: true },
        { input_has_structured_data: true },
        { input_has_urls: true },
        { input_has_instruction_override: true },
        { persona: ['anonymous'] },
        { prior_has_injection_warn: true },
        { input_length_gt: 300 },
      ],
    }),
    trigger_description: 'Code / base64 / URLs / override phrase / anonymous user / long input / prior injection warn',
  },

  // ── Model-graded: LLM Safety Judge (post, 15s LLM call) ──────────────────
  {
    id: 'b1c2d3e4-0002-4000-8000-000000000002',
    trigger_conditions: JSON.stringify({
      any: [
        { chat_mode: ['agent', 'supervisor'] },
        { turn_has_tool_calls: true },
        { risk_level: ['high', 'critical'] },
        { output_length_gt: 500 },
        { prior_has_warn: true },
        { persona: ['anonymous'] },
      ],
    }),
    trigger_description: 'Agent/supervisor mode, tool calls, high risk, long output, prior warn, or anonymous user',
  },

  // ── Model-graded: Sycophancy Judge (post, 8s LLM call) ───────────────────
  {
    id: 'b1c2d3e4-0004-4000-8000-000000000004',
    trigger_conditions: JSON.stringify({
      any: [
        { input_has_validation_seeking: true },
        { all: [{ turn_number_gt: 3 }, { prior_has_cognitive_warn: true }] },
      ],
    }),
    trigger_description: 'Validation-seeking phrasing, or long session with prior cognitive warn',
  },

  // ── Model-graded: Semantic Grounding (post, 6s embedding call) ───────────
  {
    id: 'b1c2d3e4-0005-4000-8000-000000000005',
    trigger_conditions: JSON.stringify({
      all: [
        { output_has_factual_claims: true },
        { output_has_tool_evidence: false },
      ],
    }),
    trigger_description: 'Factual claims in output AND no tool evidence (tool-grounded answers skip this)',
  },

  // ── Model-graded: Content Moderation (post, 2s API call) ─────────────────
  {
    id: 'b1c2d3e4-0001-4000-8000-000000000001',
    trigger_conditions: JSON.stringify({
      any: [
        { persona: ['tenant_user', 'anonymous'] },
        { prior_has_warn: true },
      ],
    }),
    trigger_description: 'Non-admin user or prior warn — skip for internal admin-only sessions',
  },

  // ── Toxicity Filter (post, content_filter) ────────────────────────────────
  {
    id: '51586988-83b7-4780-a006-b3b86b76713f',
    trigger_conditions: JSON.stringify({
      any: [
        { persona: ['tenant_user', 'anonymous'] },
        { prior_has_warn: true },
      ],
    }),
    trigger_description: 'Non-admin user or prior warn',
  },

  // ── Hallucination Check (post, factuality/grounding-overlap) ──────────────
  {
    id: '8ae24528-463a-4dfa-9348-a2be5214de9f',
    trigger_conditions: JSON.stringify({
      all: [
        { output_has_factual_claims: true },
        { output_has_tool_evidence: false },
      ],
    }),
    trigger_description: 'Factual claims in output AND no tool evidence',
  },

  // ── Cognitive Pre: Sycophancy Pressure ────────────────────────────────────
  {
    id: '58897b64-39ca-457c-8e8b-8ce4ffc33aa5',
    trigger_conditions: JSON.stringify({
      any: [
        { input_has_validation_seeking: true },
        { turn_number_gt: 2 },
      ],
    }),
    trigger_description: 'Validation-seeking phrasing or turn > 2 in an ongoing conversation',
  },

  // ── Cognitive Pre: Confidence Gate ────────────────────────────────────────
  {
    id: '70469180-6265-47d8-82c6-ee3cec180bc6',
    trigger_conditions: JSON.stringify({
      any: [
        { risk_level: ['medium', 'high', 'critical'] },
        { chat_mode: ['agent', 'supervisor'] },
        { input_has_decision_language: true },
      ],
    }),
    trigger_description: 'Medium+ risk, agent/supervisor mode, or decision-style question',
  },

  // ── Cognitive Post: Grounding ─────────────────────────────────────────────
  {
    id: 'e6f04e4f-29bb-4081-a9e8-ef66dba939bf',
    trigger_conditions: JSON.stringify({
      all: [
        { output_has_factual_claims: true },
        { output_has_tool_evidence: false },
      ],
    }),
    trigger_description: 'Factual claims in output AND no tool evidence',
  },

  // ── Cognitive Post: Sycophancy Phrasing ───────────────────────────────────
  {
    id: 'f9e2ec15-8243-4884-9056-a5cf79af9800',
    trigger_conditions: JSON.stringify({
      any: [
        { input_has_validation_seeking: true },
        { prior_has_cognitive_warn: true },
      ],
    }),
    trigger_description: 'Validation-seeking input or prior cognitive warn this turn',
  },

  // ── Cognitive Post: Devils Advocate ───────────────────────────────────────
  {
    id: 'af3ed9ac-b3ca-4d10-bf80-678e4a750389',
    trigger_conditions: JSON.stringify({ input_has_decision_language: true }),
    trigger_description: 'Only when the original question was a decision/recommendation question',
  },

  // ── Cognitive Post: Confidence Gate ───────────────────────────────────────
  {
    id: '4ace09e3-5aa8-4761-8d7c-e56f81ae84dd',
    trigger_conditions: JSON.stringify({
      any: [
        { prior_has_cognitive_warn: true },
        { risk_level: ['medium', 'high', 'critical'] },
        { chat_mode: ['agent', 'supervisor'] },
      ],
    }),
    trigger_description: 'Prior cognitive warn, medium+ risk, or agent/supervisor mode',
  },

  // ── Regex: Indirect / Hypothetical Wrapper (pre) ──────────────────────────
  {
    id: 'c1000003-aaaa-4000-8000-000000000003',
    trigger_conditions: JSON.stringify({
      all: [
        { input_length_gt: 80 },
        { any: [{ turn_number_gt: 1 }, { input_has_structured_data: true }] },
      ],
    }),
    trigger_description: 'Message > 80 chars AND (not the first turn, or contains structured data)',
  },

  // ── Regex: Base64 Encoded Instruction (pre) ───────────────────────────────
  {
    id: 'c1000004-aaaa-4000-8000-000000000004',
    trigger_conditions: JSON.stringify({
      any: [
        { input_has_base64: true },
        { input_length_gt: 500 },
      ],
    }),
    trigger_description: 'Base64-like token detected or long message (> 500 chars)',
  },

  // ── Regex: Output False Certainty (post) ──────────────────────────────────
  {
    id: 'c3000001-aaaa-4000-8000-000000000001',
    trigger_conditions: JSON.stringify({
      any: [
        { output_has_advice: true },
        { output_length_gt: 200 },
      ],
    }),
    trigger_description: 'Advice/recommendation language in output or response > 200 chars',
  },
];

export function applyM34GuardrailConditions(db: BetterSqlite3.Database): void {
  // ── Schema: add columns (idempotent — SQLite ignores duplicate ADD COLUMN) ─
  const hasTriggerConditions = (db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('guardrails') WHERE name = 'trigger_conditions'")
    .get() as { n: number }).n > 0;

  if (!hasTriggerConditions) {
    db.prepare('ALTER TABLE guardrails ADD COLUMN trigger_conditions TEXT').run();
  }

  const hasTriggerDescription = (db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('guardrails') WHERE name = 'trigger_description'")
    .get() as { n: number }).n > 0;

  if (!hasTriggerDescription) {
    db.prepare('ALTER TABLE guardrails ADD COLUMN trigger_description TEXT').run();
  }

  // ── Seed: set conditions for context-sensitive guardrails ──────────────────
  // Only updates rows that exist and haven't had conditions set yet (trigger_conditions IS NULL).
  // This preserves any operator-edited conditions from a previous run.
  const update = db.prepare(`
    UPDATE guardrails
    SET trigger_conditions  = ?,
        trigger_description = ?,
        updated_at          = datetime('now')
    WHERE id = ?
      AND trigger_conditions IS NULL
  `);

  for (const { id, trigger_conditions, trigger_description } of CONDITIONS) {
    update.run(trigger_conditions, trigger_description, id);
  }
}
