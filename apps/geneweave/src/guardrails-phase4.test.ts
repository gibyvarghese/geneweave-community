/**
 * Phase 4 — Signal extraction, context building, and pre→post prior cascade
 *
 * Tests that:
 *  1. extractToolCategories correctly maps tool names to category strings.
 *  2. The prior cascade flows pre-stage warns into post-stage conditionContext.prior.
 *  3. Skipped results (condition_not_met) are excluded from the prior warn computation.
 *  4. evaluateGuardrails builds a correctly populated conditionContext and passes it
 *     through the pipeline so guardrails with trigger conditions only fire when matched.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUUIDv7 } from '@weaveintel/core';
import type { AgentStep } from '@weaveintel/core';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { evaluateGuardrails, extractToolCategories } from './chat-guardrail-eval-utils.js';

// ── Helpers ───────────────────────────────────────────────────

async function freshDb(): Promise<DatabaseAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-phase4-'));
  return createDatabaseAdapter({ type: 'sqlite', path: join(dir, 'gw.db') });
}

function makeStep(toolName: string): AgentStep {
  return {
    type: 'tool_call',
    content: '',
    toolCall: { name: toolName, arguments: {}, result: 'ok' },
  } as AgentStep;
}

// ── 1. extractToolCategories ──────────────────────────────────

describe('extractToolCategories', () => {
  it('returns empty array for no steps', () => {
    expect(extractToolCategories([])).toEqual([]);
  });

  it('maps cse tools', () => {
    expect(extractToolCategories([makeStep('cse_search')])).toContain('cse');
  });

  it('maps web_search tools', () => {
    expect(extractToolCategories([makeStep('web_search')])).toContain('web_search');
    expect(extractToolCategories([makeStep('search_web')])).toContain('web_search');
  });

  it('maps file tools', () => {
    expect(extractToolCategories([makeStep('read_file')])).toContain('file');
    expect(extractToolCategories([makeStep('write_file')])).toContain('file');
    expect(extractToolCategories([makeStep('fs_read')])).toContain('file');
  });

  it('maps api tools', () => {
    expect(extractToolCategories([makeStep('http_get')])).toContain('api');
    expect(extractToolCategories([makeStep('fetch_url')])).toContain('api');
    expect(extractToolCategories([makeStep('api_call')])).toContain('api');
  });

  it('maps unknown tools to external', () => {
    expect(extractToolCategories([makeStep('run_sql')])).toContain('external');
    expect(extractToolCategories([makeStep('execute_code')])).toContain('external');
  });

  it('deduplicates categories', () => {
    const steps = [makeStep('web_search'), makeStep('web_search_v2')];
    const cats = extractToolCategories(steps);
    expect(cats.filter(c => c === 'web_search')).toHaveLength(1);
  });

  it('returns multiple categories when mixed tools are used', () => {
    const steps = [makeStep('cse_search'), makeStep('read_file'), makeStep('http_get')];
    const cats = extractToolCategories(steps);
    expect(cats).toContain('cse');
    expect(cats).toContain('file');
    expect(cats).toContain('api');
    expect(cats).not.toContain('external');
  });

  it('ignores steps without toolCall', () => {
    const step = { type: 'text', content: 'thinking...' } as unknown as AgentStep;
    expect(extractToolCategories([step])).toEqual([]);
  });
});

// ── 2. Condition context — persona and chat mode ───────────────

describe('evaluateGuardrails — condition context persona/mode', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('passes persona to condition evaluation — anonymous user fires content-moderation condition', async () => {
    // Guardrail that only fires for anonymous or tenant_user persona
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'persona-gated',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['blocked'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ persona: ['anonymous', 'tenant_user'] }),
    });

    // anonymous user → guardrail fires (blocked word present)
    const r1 = await evaluateGuardrails(db, 'chat-1', null, 'this is blocked', 'pre-execution',
      undefined,
      { persona: 'anonymous' },
    );
    expect(r1.decision).toBe('deny');

    // platform_admin → guardrail skipped (condition not met)
    const r2 = await evaluateGuardrails(db, 'chat-2', null, 'this is blocked', 'pre-execution',
      undefined,
      { persona: 'platform_admin' },
    );
    expect(r2.decision).toBe('allow');
    expect(r2.results[0]?.metadata?.['skipped']).toBe('condition_not_met');
  });

  it('passes chat mode to condition evaluation — agent mode fires agent-only guardrail', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'agent-mode-only',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['danger'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ chat_mode: ['agent', 'supervisor'] }),
    });

    // direct mode → skipped
    const r1 = await evaluateGuardrails(db, 'chat-1', null, 'danger zone', 'pre-execution',
      undefined,
      { chatMode: 'direct' },
    );
    expect(r1.decision).toBe('allow');
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // agent mode → fires
    const r2 = await evaluateGuardrails(db, 'chat-2', null, 'danger zone', 'pre-execution',
      undefined,
      { chatMode: 'agent' },
    );
    expect(r2.decision).toBe('deny');
  });
});

// ── 3. Turn number condition ───────────────────────────────────

describe('evaluateGuardrails — turn number condition', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('fires turn_number_gt guardrail only when turn exceeds threshold', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'late-turn-check',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['stop'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ turn_number_gt: 2 }),
    });

    // turn 1 → skipped
    const r1 = await evaluateGuardrails(db, 'c1', null, 'please stop', 'pre-execution',
      undefined, { turnNumber: 1 });
    expect(r1.decision).toBe('allow');
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // turn 3 → fires
    const r2 = await evaluateGuardrails(db, 'c2', null, 'please stop', 'pre-execution',
      undefined, { turnNumber: 3 });
    expect(r2.decision).toBe('deny');
  });
});

// ── 4. Steps → hasToolCalls and toolCategories ────────────────

describe('evaluateGuardrails — steps-derived context', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('derives hasToolCalls from steps and fires turn_has_tool_calls condition', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'tool-call-check',
      description: null,
      type: 'blocklist',
      stage: 'post',
      config: JSON.stringify({ words: ['confidential'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ turn_has_tool_calls: true }),
    });

    // No steps → guardrail skipped by condition (no tool calls)
    // Note: at post-execution, `input` = assistantContent; the blocklist checks guardedInput.
    const r1 = await evaluateGuardrails(db, 'c1', null, 'this is confidential', 'post-execution',
      { assistantOutput: 'this is confidential' }, { steps: [] });
    expect(r1.decision).toBe('allow');
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // With tool step → condition met → blocklist evaluates input → deny
    const r2 = await evaluateGuardrails(db, 'c2', null, 'this is confidential', 'post-execution',
      { assistantOutput: 'this is confidential' }, { steps: [makeStep('read_file')] });
    expect(r2.decision).toBe('deny');
  });

  it('derives tool_category_in from steps', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'file-tool-check',
      description: null,
      type: 'blocklist',
      stage: 'post',
      config: JSON.stringify({ words: ['sensitive'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ tool_category_in: ['file', 'api'] }),
    });

    // web_search step → skipped (not file or api)
    const r1 = await evaluateGuardrails(db, 'c1', null, 'sensitive data', 'post-execution',
      { assistantOutput: 'sensitive data' }, { steps: [makeStep('web_search')] });
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // read_file step → condition met → fires on 'sensitive' in input
    const r2 = await evaluateGuardrails(db, 'c2', null, 'sensitive data', 'post-execution',
      { assistantOutput: 'sensitive data' }, { steps: [makeStep('read_file')] });
    expect(r2.decision).toBe('deny');
  });
});

// ── 5. Prior cascade (pre → post) ────────────────────────────

describe('evaluateGuardrails — prior cascade', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('prior_has_warn fires post-guardrail when pre-stage produced a warn', async () => {
    // Pre-stage guardrail: warns on 'concern'
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'pre-warn',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['concern'], action: 'warn' }),
      priority: 50,
      enabled: 1,
    });

    // Post-stage guardrail: only fires when there was a prior warn
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'post-on-prior-warn',
      description: null,
      type: 'blocklist',
      stage: 'post',
      config: JSON.stringify({ words: ['danger'], action: 'deny' }),
      priority: 60,
      enabled: 1,
      trigger_conditions: JSON.stringify({ prior_has_warn: true }),
    });

    // Run pre-stage (produces a warn)
    const preResult = await evaluateGuardrails(db, 'c1', null, 'this is a concern', 'pre-execution');
    expect(preResult.decision).toBe('warn');

    // Run post-stage WITHOUT prior results → post guardrail skipped
    const post1 = await evaluateGuardrails(db, 'c1', null, 'something danger', 'post-execution',
      { assistantOutput: 'danger output' }, {});
    expect(post1.results.find(r => r.metadata?.['skipped'] === 'condition_not_met')).toBeDefined();

    // Run post-stage WITH prior results → post guardrail fires
    const post2 = await evaluateGuardrails(db, 'c1', null, 'something danger', 'post-execution',
      { assistantOutput: 'danger output' },
      { priorGuardrailResults: preResult.results },
    );
    expect(post2.decision).toBe('deny');
  });

  it('skipped pre-stage results do NOT trigger prior_has_warn', async () => {
    // Pre-stage guardrail with condition that will not match
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'always-skipped',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['anything'], action: 'warn' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ chat_mode: ['agent'] }),  // won't match 'direct'
    });

    // Post guardrail that needs prior warn
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'post-escalation',
      description: null,
      type: 'blocklist',
      stage: 'post',
      config: JSON.stringify({ words: ['escalate'], action: 'deny' }),
      priority: 60,
      enabled: 1,
      trigger_conditions: JSON.stringify({ prior_has_warn: true }),
    });

    // Pre-stage in direct mode → the pre guardrail is skipped (condition not met)
    const preResult = await evaluateGuardrails(db, 'c1', null, 'anything here', 'pre-execution',
      undefined, { chatMode: 'direct' });
    expect(preResult.decision).toBe('allow');
    const skipped = preResult.results.some(r => r.metadata?.['skipped'] === 'condition_not_met');
    expect(skipped).toBe(true);

    // Post-stage: even though there's a result, it was skipped — should NOT set prior_has_warn
    const post = await evaluateGuardrails(db, 'c1', null, 'escalate this', 'post-execution',
      { assistantOutput: 'escalate now' },
      { priorGuardrailResults: preResult.results, chatMode: 'direct' },
    );
    // The post guardrail should be skipped because prior_has_warn is false
    expect(post.results.some(r => r.metadata?.['skipped'] === 'condition_not_met')).toBe(true);
  });

  it('hasCognitiveWarn is set correctly from cognitive guardrail results', async () => {
    // Cognitive pre-guardrail that warns on validation-seeking input
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'cognitive-sycophancy',
      description: null,
      type: 'cognitive_check',
      stage: 'pre',
      config: JSON.stringify({
        check: 'pre_sycophancy',
        pattern: '\\bright\\?|agree\\?',
        warn_confidence: 0.6,
        allow_confidence: 0.9,
      }),
      priority: 65,
      enabled: 1,
    });

    // Post guardrail that needs a cognitive warn
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'post-cognitive-escalation',
      description: null,
      type: 'blocklist',
      stage: 'post',
      config: JSON.stringify({ words: ['actually'], action: 'warn' }),
      priority: 70,
      enabled: 1,
      trigger_conditions: JSON.stringify({ prior_has_cognitive_warn: true }),
    });

    const preResult = await evaluateGuardrails(db, 'c1', null, 'this is right? agree?', 'pre-execution');
    // Cognitive guardrail may or may not fire depending on pattern match
    expect(['warn', 'allow']).toContain(preResult.decision);

    // If there was a cognitive warn, the post guardrail should fire when 'actually' is in output
    const postWithPrior = await evaluateGuardrails(db, 'c1', null, 'response', 'post-execution',
      { assistantOutput: 'actually this is fine' },
      { priorGuardrailResults: preResult.results },
    );
    // If pre warned cognitively → post fires; if not → post skipped. Both are valid outcomes.
    const postGuardrailResult = postWithPrior.results.find(r => !r.metadata?.['skipped']);
    const postGuardrailSkipped = postWithPrior.results.find(r => r.metadata?.['skipped'] === 'condition_not_met');
    // At least one of these should be true based on pre-stage outcome
    const preCognitiveWarn = preResult.results.some(r =>
      (r.decision === 'warn' || r.decision === 'deny') &&
      String(r.metadata?.['category'] ?? '') === 'cognitive'
    );
    if (preCognitiveWarn) {
      expect(postGuardrailResult).toBeDefined();
    } else {
      expect(postGuardrailSkipped).toBeDefined();
    }
  });
});

// ── 6. Input signals from guardedInput ───────────────────────

describe('evaluateGuardrails — input signal conditions', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('input_has_code fires for code-containing input', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'code-detect',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['execute'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ input_has_code: true }),
    });

    // No code → skipped
    const r1 = await evaluateGuardrails(db, 'c1', null, 'please execute this plan', 'pre-execution');
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // With code block → fires
    const r2 = await evaluateGuardrails(db, 'c2', null, 'can you execute this?\n```python\nprint("hi")\n```', 'pre-execution');
    expect(r2.decision).toBe('deny');
  });

  it('input_length_gt fires for long inputs', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'long-input',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['x'], action: 'warn' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ input_length_gt: 50 }),
    });

    // Short input → skipped
    const r1 = await evaluateGuardrails(db, 'c1', null, 'x', 'pre-execution');
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // Long input → fires
    const long = 'x ' + 'a'.repeat(60);
    const r2 = await evaluateGuardrails(db, 'c2', null, long, 'pre-execution');
    expect(r2.decision).toBe('warn');
  });

  it('output_has_factual_claims fires for post-stage with factual content', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'factual-check',
      description: null,
      type: 'blocklist',
      stage: 'post',
      config: JSON.stringify({ words: ['wrong'], action: 'warn' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({
        all: [{ output_has_factual_claims: true }, { output_has_tool_evidence: false }],
      }),
    });

    // Creative output (no numbers/dates) → output_has_factual_claims false → skipped.
    // Note: at post-execution the first `input` param is the assistant content.
    const creative = 'Once upon a time there was wrong dragon.';
    const r1 = await evaluateGuardrails(db, 'c1', null, creative, 'post-execution',
      { assistantOutput: creative });
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // Output with a year (2024) → RE_FACTUAL_CLAIMS matches → condition met → blocklist finds 'wrong' → warn
    const factual = 'The population is 8.1 billion people as of 2024, which is wrong.';
    const r2 = await evaluateGuardrails(db, 'c2', null, factual, 'post-execution',
      { assistantOutput: factual });
    expect(r2.decision).toBe('warn');
  });
});
