/**
 * Phase H — GeneWeave guardrails integration tests
 *
 * Covers all wiring added in the enterprise hardening pass:
 *
 *   1. W7  DB-backed revision store (guardrail_revisions table)
 *   2. Admin API write-through to revision store
 *   3. W4  Escalation policies loaded from DB and evaluated in chat pipeline
 *   4. W10 Input normaliser (homoglyphs/zero-width) applied in DB-driven pipeline
 *   5. W2  Model-graded evaluators run when a model is provided to the slot
 *   6. W9  Pipeline budget respected; model-graded skipped when exceeded
 *   7. Guardrail eval rows include escalation JSON when an escalation fires
 *   8. guardrails-slot filters out escalation_policy rows before evaluation
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUUIDv7, weaveContext, weaveRuntime } from '@weaveintel/core';
import { weaveFakeModel } from '@weaveintel/testing';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { geneweaveGuardrailsSlot } from './guardrails-slot.js';
import { evaluateGuardrails } from './chat-guardrail-eval-utils.js';
import { createSqliteRevisionStore } from './guardrail-revision-store.js';
import { trackGuardrailChange } from '@weaveintel/guardrails';

// ── Helpers ───────────────────────────────────────────────────

async function freshDb(): Promise<DatabaseAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-phaseH-'));
  return createDatabaseAdapter({ type: 'sqlite', path: join(dir, 'gw.db') });
}

// ── 1. DB-backed revision store ───────────────────────────────

describe('W7 — SqliteGuardrailRevisionStore', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('persists a revision and retrieves it', async () => {
    const store = createSqliteRevisionStore(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const guardrail = {
      id: 'g1', name: 'Test', type: 'blocklist' as const,
      stage: 'pre-execution' as const, enabled: true, config: { words: ['test'] },
    };

    const rev = await trackGuardrailChange(store, ctx, {
      guardrailId: 'g1', actor: 'admin', reason: 'Initial creation', snapshot: guardrail,
    });

    expect(rev.version).toBe(1);
    const history = await store.list('g1');
    expect(history).toHaveLength(1);
    expect(history[0]?.actor).toBe('admin');
    expect(history[0]?.reason).toBe('Initial creation');
  });

  it('auto-increments version on each change', async () => {
    const store = createSqliteRevisionStore(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const snap = { id: 'g2', name: 'G', type: 'blocklist' as const, stage: 'pre-execution' as const, enabled: true, config: {} };

    await trackGuardrailChange(store, ctx, { guardrailId: 'g2', actor: 'a', reason: 'v1', snapshot: snap });
    await trackGuardrailChange(store, ctx, { guardrailId: 'g2', actor: 'a', reason: 'v2', snapshot: snap, before: snap });

    const history = await store.list('g2');
    expect(history[0]?.version).toBe(1);
    expect(history[1]?.version).toBe(2);
  });

  it('stores the before snapshot', async () => {
    const store = createSqliteRevisionStore(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const before = { id: 'g3', name: 'Old', type: 'blocklist' as const, stage: 'pre-execution' as const, enabled: true, config: {} };
    const after = { ...before, name: 'New' };

    await trackGuardrailChange(store, ctx, { guardrailId: 'g3', actor: 'a', reason: 'rename', snapshot: after, before });
    const revs = await store.list('g3');
    expect(revs[0]?.before?.name).toBe('Old');
    expect(revs[0]?.snapshot.name).toBe('New');
  });

  it('atTime returns latest revision before a given time', async () => {
    const store = createSqliteRevisionStore(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const snap = { id: 'g4', name: 'G', type: 'blocklist' as const, stage: 'pre-execution' as const, enabled: true, config: {} };

    // Capture a timestamp clearly before either revision is created
    const beforeAny = new Date(Date.now() - 1000).toISOString();

    await trackGuardrailChange(store, ctx, { guardrailId: 'g4', actor: 'a', reason: 'v1', snapshot: snap });
    await trackGuardrailChange(store, ctx, { guardrailId: 'g4', actor: 'a', reason: 'v2', snapshot: snap, before: snap });

    // Before any revision: should be undefined
    expect(await store.atTime('g4', beforeAny)).toBeUndefined();
    // Far future: should be the latest (v2)
    const latest = await store.atTime('g4', '2099-12-31T23:59:59.000Z');
    expect(latest?.version).toBe(2);
    expect(latest?.reason).toBe('v2');
  });

  it('returns undefined for unknown guardrail', async () => {
    const store = createSqliteRevisionStore(db);
    expect(await store.atTime('nonexistent', new Date().toISOString())).toBeUndefined();
  });

  it('revision survives a DB restart on the same path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-phaseH-restart-'));
    const dbPath = join(dir, 'gw.db');
    const db1 = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    const store1 = createSqliteRevisionStore(db1);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const snap = { id: 'g5', name: 'G', type: 'blocklist' as const, stage: 'pre-execution' as const, enabled: true, config: {} };

    await trackGuardrailChange(store1, ctx, { guardrailId: 'g5', actor: 'ops', reason: 'persist-test', snapshot: snap });

    // Re-open DB
    const db2 = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    const store2 = createSqliteRevisionStore(db2);
    const history = await store2.list('g5');
    expect(history).toHaveLength(1);
    expect(history[0]?.reason).toBe('persist-test');
  });
});

// ── 2. Escalation policy from DB ─────────────────────────────

describe('W4 — Escalation policies from DB evaluated in chat pipeline', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  async function seedEscalation(minWarnCount: number, onEscalate: 'block' | 'require-approval') {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'Escalation: 2 cognitive warns',
      description: 'Block after 2 cognitive warns',
      type: 'escalation_policy',
      stage: 'pre',
      config: JSON.stringify({ min_warn_count: minWarnCount, categories: ['cognitive'], on_escalate: onEscalate }),
      priority: 50,
      enabled: 1,
    });
  }

  it('does not escalate when warn count is below threshold', async () => {
    await seedEscalation(3, 'block'); // threshold 3
    // Seed one cognitive-warn guardrail (sycophancy pattern → warns)
    await db.createGuardrail({
      id: newUUIDv7(), name: 'Pre syc', description: null,
      type: 'cognitive_check', stage: 'pre',
      config: JSON.stringify({ check: 'pre_sycophancy', pattern: '\\b(agree with me)\\b', warn_confidence: 0.62, allow_confidence: 0.86 }),
      priority: 65, enabled: 1,
    });

    const result = await evaluateGuardrails(db, 'chat-1', null, 'agree with me please', 'pre-execution');
    // 1 warn, threshold 3 → no escalation
    expect(result.escalation?.escalated).toBe(false);
    expect(result.decision).toBe('warn');
  });

  it('escalates and produces deny when threshold is met', async () => {
    await seedEscalation(1, 'block'); // threshold 1
    await db.createGuardrail({
      id: newUUIDv7(), name: 'Pre syc', description: null,
      type: 'cognitive_check', stage: 'pre',
      config: JSON.stringify({ check: 'pre_sycophancy', pattern: '\\b(agree with me)\\b', warn_confidence: 0.62, allow_confidence: 0.86 }),
      priority: 65, enabled: 1,
    });

    const result = await evaluateGuardrails(db, 'chat-1', null, 'agree with me please', 'pre-execution');
    expect(result.escalation?.escalated).toBe(true);
    expect(result.decision).toBe('deny');
  });

  it('escalation result is persisted in guardrail_evals', async () => {
    await seedEscalation(1, 'block');
    await db.createGuardrail({
      id: newUUIDv7(), name: 'Pre syc', description: null,
      type: 'cognitive_check', stage: 'pre',
      config: JSON.stringify({ check: 'pre_sycophancy', pattern: '\\b(agree with me)\\b', warn_confidence: 0.62, allow_confidence: 0.86 }),
      priority: 65, enabled: 1,
    });

    await evaluateGuardrails(db, 'chat-esc', null, 'agree with me', 'pre-execution');

    const evals = await db.listGuardrailEvals('chat-esc');
    expect(evals).toHaveLength(1);
    expect(evals[0]?.escalation).not.toBeNull();
    const escalation = JSON.parse(evals[0]!.escalation!);
    expect(escalation.escalated).toBe(true);
  });

  it('escalation_policy rows are excluded from pipeline evaluation', async () => {
    // The schema seeds baseline security guardrails (PII/SSRF/secret regex) at
    // init, so capture them first to prove the escalation policy is NOT added to
    // the evaluated set.
    const baselineIds = new Set((await db.listGuardrails()).map((g) => g.id));

    const escId = newUUIDv7();
    await db.createGuardrail({
      id: escId,
      name: 'Escalation: excluded from pipeline',
      description: null,
      type: 'escalation_policy',
      stage: 'pre',
      config: JSON.stringify({ min_warn_count: 1, categories: ['cognitive'], on_escalate: 'block' }),
      priority: 50,
      enabled: 1,
    });

    const result = await evaluateGuardrails(db, 'chat-x', null, 'safe input', 'pre-execution');
    // The escalation policy must NOT appear among the evaluated guardrail results.
    expect(result.results.map((r) => r.guardrailId)).not.toContain(escId);
    // Only baseline (non-escalation) guardrails were evaluated.
    expect(result.results.every((r) => baselineIds.has(r.guardrailId ?? ''))).toBe(true);
    // Safe input passes every baseline regex guardrail.
    expect(result.decision).toBe('allow');
  });
});

// ── 3. W10 Normaliser applied in DB-driven pipeline ───────────

describe('W10 — Homoglyph/zero-width normalisation in DB-backed pipeline', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('catches Cyrillic-obfuscated blocked word', async () => {
    // Cyrillic 'о' in "delete" → normaliser folds to 'o'
    await db.createGuardrail({
      id: newUUIDv7(), name: 'block-delete', description: null,
      type: 'blocklist', stage: 'pre',
      config: JSON.stringify({ words: ['delete'], action: 'deny' }),
      priority: 90, enabled: 1,
    });

    const slot = geneweaveGuardrailsSlot(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    // 'd' + Cyrillic 'е' + 'l' + Cyrillic 'е' + 'te' → after normalisation = 'delete'
    const r = await slot.checkToolCall!(ctx, { name: 'db_exec' }, { sql: 'dеlеte FROM users' });
    expect(r.allow).toBe(false);
  });

  it('catches zero-width obfuscated blocked word via evaluateGuardrails', async () => {
    await db.createGuardrail({
      id: newUUIDv7(), name: 'block-secret', description: null,
      type: 'blocklist', stage: 'pre',
      config: JSON.stringify({ words: ['classified'], action: 'deny' }),
      priority: 90, enabled: 1,
    });

    // Zero-width space (​) inserted between chars
    const r = await evaluateGuardrails(db, 'c1', null, 'clas​sified data', 'pre-execution');
    expect(r.decision).toBe('deny');
  });
});

// ── 4. guardrails-slot filters escalation_policy rows ─────────

describe('guardrails-slot — escalation_policy rows are filtered', () => {
  it('does not pass escalation_policy rows to the pipeline', async () => {
    const db = await freshDb();
    await db.createGuardrail({
      id: newUUIDv7(), name: 'Esc policy', description: null,
      type: 'escalation_policy', stage: 'pre',
      config: JSON.stringify({ min_warn_count: 1, on_escalate: 'block' }),
      priority: 50, enabled: 1,
    });

    const slot = geneweaveGuardrailsSlot(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    // Should allow — escalation_policy shouldn't be treated as a blocklist
    const r = await slot.checkToolCall!(ctx, { name: 'search' }, { q: 'anything' });
    expect(r.allow).toBe(true);
  });
});

// ── 5. W2 model-graded evaluator runs via slot ────────────────

describe('W2 — model-graded evaluator runs when model is provided via SlotOptions', () => {
  it('runs llm-judge when model is provided and guardrail is model-graded', async () => {
    const db = await freshDb();
    await db.createGuardrail({
      id: newUUIDv7(), name: 'LLM Judge', description: null,
      type: 'model-graded', stage: 'post',
      config: JSON.stringify({ rule: 'llm-judge', on_error: 'allow', timeout_ms: 3000 }),
      priority: 80, enabled: 1,
    });

    // Model scripted to deny
    const model = weaveFakeModel({
      responses: ['{"decision":"deny","confidence":0.98,"rationale":"Unsafe content detected"}'],
    });

    const slot = geneweaveGuardrailsSlot(db, { getModel: () => model });
    const ctx = weaveContext({ runtime: weaveRuntime() });

    const r = await slot.checkOutput!(ctx, 'this is unsafe content');
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('Unsafe content detected');
  });

  it('skips model-graded and allows when no model is provided (default)', async () => {
    const db = await freshDb();
    await db.createGuardrail({
      id: newUUIDv7(), name: 'LLM Judge', description: null,
      type: 'model-graded', stage: 'post',
      config: JSON.stringify({ rule: 'llm-judge', on_error: 'allow' }),
      priority: 80, enabled: 1,
    });

    const slot = geneweaveGuardrailsSlot(db); // no model
    const ctx = weaveContext({ runtime: weaveRuntime() });

    const r = await slot.checkOutput!(ctx, 'any content');
    expect(r.allow).toBe(true); // no model → placeholder allow
  });
});

// ── 6. W9 Pipeline budget respected ──────────────────────────

describe('W9 — Pipeline budget skips model-graded when exceeded', () => {
  it('skips model-graded guardrail when budgetMs: 0', async () => {
    const db = await freshDb();
    await db.createGuardrail({
      id: newUUIDv7(), name: 'Slow Judge', description: null,
      type: 'model-graded', stage: 'post',
      config: JSON.stringify({ rule: 'llm-judge', on_error: 'deny' }),
      priority: 80, enabled: 1,
    });

    // Model that would deny — but budget exhausted before it runs
    const model = weaveFakeModel({
      responses: ['{"decision":"deny","confidence":0.99,"rationale":"Would have fired"}'],
    });

    const slot = geneweaveGuardrailsSlot(db, { getModel: () => model, budgetMs: 0 });
    const ctx = weaveContext({ runtime: weaveRuntime() });

    const r = await slot.checkOutput!(ctx, 'any output');
    // Budget exhausted → model-graded skipped → allow
    expect(r.allow).toBe(true);
  });
});

// ── 7. evaluateGuardrails uses model from opts ────────────────

describe('evaluateGuardrails opts.model wired into pipeline', () => {
  it('passes model to pipeline so model-graded checks can fire', async () => {
    const db = await freshDb();
    await db.createGuardrail({
      id: newUUIDv7(), name: 'Judge', description: null,
      type: 'model-graded', stage: 'post',
      config: JSON.stringify({ rule: 'llm-judge', on_error: 'allow' }),
      priority: 80, enabled: 1,
    });

    const model = weaveFakeModel({
      responses: ['{"decision":"warn","confidence":0.75,"rationale":"Borderline content"}'],
    });

    const result = await evaluateGuardrails(
      db, 'c1', null, 'borderline output', 'post-execution',
      { assistantOutput: 'borderline output' },
      { model },
    );
    expect(result.decision).toBe('warn');
    expect(result.results.some(r => r.explanation === 'Borderline content')).toBe(true);
  });
});
