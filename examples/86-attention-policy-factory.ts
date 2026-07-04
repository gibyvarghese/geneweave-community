/**
 * Example 86 — DB-driven attention policy factory for live agents.
 *
 * Phase 4 of the DB-Driven Live-Agents Runtime. Demonstrates the three
 * attention policy kinds and how the factory resolves a DB row into a live
 * `AttentionPolicy` instance.
 *
 * Three resolution paths:
 *
 *   1. heuristic  — `kind = 'heuristic'`, inbox-first priority order.
 *      Resolves to `createStandardAttentionPolicy()` (or cron-backed if
 *      `restMinutes` is configured in `config_json`).
 *
 *   2. cron       — `kind = 'cron'`, fixed-schedule rest at a configured
 *      cron interval. Optionally processes inbox between rests.
 *
 *   3. model      — `kind = 'model'`, LLM decides per tick. Falls back to
 *      the standard heuristic when no `Model` is supplied to the factory.
 *
 * For each policy we:
 *   a. Synthesise a `live_attention_policies` row (without touching the DB).
 *   b. Call `resolveAttentionPolicy(row, opts)` from the runtime package.
 *   c. Build a minimal `AttentionContext` with inbox / backlog entries.
 *   d. Call `policy.decide(context, execCtx)` and print the chosen action.
 *
 * We also demonstrate `resolveAttentionPolicyFromDb()` against the real DB to
 * show the end-to-end async path (reads the seeded 'heuristic.inbox-first'
 * row from `live_attention_policies`).
 *
 * Finally, we show the `resolveAgentAttentionPolicy()` geneweave bridge with a
 * synthetic agent row that has `attention_policy_key` set.
 *
 * Run:
 *   npx tsx examples/86-attention-policy-factory.ts
 */

import { SQLiteAdapter } from '../apps/geneweave/src/db-sqlite.js';
import {
  resolveAttentionPolicy,
  resolveAttentionPolicyFromDb,
  type AttentionPolicyRowLike,
} from '@weaveintel/live-agents-runtime';
import {
  resolveAgentAttentionPolicy,
  type AgentAttentionFieldsRow,
} from '../apps/geneweave/src/live-agents/agent-attention-resolver.js';
import type { AttentionContext } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';

// ---------------------------------------------------------------------------
// Minimal execution context stub (enough to satisfy the interface)
// ---------------------------------------------------------------------------

function makeExecCtx(): ExecutionContext {
  return {
    // Most attention policies don't use execCtx — only model policies need it
    // for the LLM call.  A plain cast is fine for this demo.
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Minimal attention context helpers
// ---------------------------------------------------------------------------

function emptyContext(nowIso = new Date().toISOString()): AttentionContext {
  return { nowIso, inbox: [], backlog: [] } as unknown as AttentionContext;
}

function contextWithInbox(nowIso = new Date().toISOString()): AttentionContext {
  return {
    nowIso,
    inbox: [{ id: 'msg-1', status: 'PENDING', content: 'Hello, agent!', createdAt: nowIso }],
    backlog: [],
  } as unknown as AttentionContext;
}

function contextWithBacklog(nowIso = new Date().toISOString()): AttentionContext {
  return {
    nowIso,
    inbox: [],
    backlog: [{ id: 'task-1', status: 'IN_PROGRESS', title: 'Analyse data' }],
  } as unknown as AttentionContext;
}

// ---------------------------------------------------------------------------
// Synthetic DB rows — no real DB needed for the first three demos
// ---------------------------------------------------------------------------

/** heuristic.inbox-first — standard priority order, 15 min rest */
const heuristicRow: AttentionPolicyRowLike = {
  id: 'row-h1',
  key: 'heuristic.inbox-first',
  kind: 'heuristic',
  description: 'Inbox-first priority order, 15 min rest',
  config_json: '{}',
  enabled: 1,
};

/** heuristic.custom-rest — standard priority order, custom 5 min rest */
const heuristicCustomRestRow: AttentionPolicyRowLike = {
  id: 'row-h2',
  key: 'heuristic.custom-rest',
  kind: 'heuristic',
  description: 'Inbox-first with 5-minute rest interval',
  config_json: JSON.stringify({ restMinutes: 5 }),
  enabled: 1,
};

/** cron.hourly — pure rest sweep, no inbox processing, rests 60 min */
const cronHourlyRow: AttentionPolicyRowLike = {
  id: 'row-c1',
  key: 'cron.hourly',
  kind: 'cron',
  description: 'Hourly sweep agent — rests for 60 minutes then checks in',
  config_json: JSON.stringify({ cron: '0 */1 * * *', processInbox: false }),
  enabled: 1,
};

/** cron.inbox-with-hourly-rest — processes inbox, rests hourly when idle */
const cronInboxRow: AttentionPolicyRowLike = {
  id: 'row-c2',
  key: 'cron.inbox-with-hourly-rest',
  kind: 'cron',
  description: 'Process inbox immediately; rest for 60 min when idle',
  config_json: JSON.stringify({ cron: '0 */1 * * *', processInbox: true }),
  enabled: 1,
};

/** model.adaptive — LLM picks action every tick (no model supplied = fallback) */
const modelRow: AttentionPolicyRowLike = {
  id: 'row-m1',
  key: 'model.adaptive',
  kind: 'model',
  description: 'LLM-adaptive policy (falls back when no model supplied)',
  config_json: JSON.stringify({ maxInboxItems: 10, maxBacklogItems: 10, temperature: 0 }),
  enabled: 1,
};

// ---------------------------------------------------------------------------
// Main demo
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const execCtx = makeExecCtx();

  console.log('=== Example 86 — DB-driven Attention Policy Factory ===\n');

  // ── 1. Heuristic policy — inbox present ─────────────────────────────────
  {
    console.log('── 1. heuristic.inbox-first with pending inbox ──');
    const policy = resolveAttentionPolicy(heuristicRow, {});
    console.log(`  policy.key = ${policy.key}`);
    const action = await policy.decide(contextWithInbox(), execCtx);
    console.log(`  decide(inbox=1) → type=${action.type}`, 'messageId' in action ? `messageId=${action.messageId}` : '');
    console.log();
  }

  // ── 2. Heuristic policy — empty context → rest ──────────────────────────
  {
    console.log('── 2. heuristic.inbox-first — empty context ──');
    const policy = resolveAttentionPolicy(heuristicRow, {});
    const action = await policy.decide(emptyContext(), execCtx);
    console.log(`  decide(empty) → type=${action.type}`, 'nextTickAt' in action ? `nextTickAt=${action.nextTickAt}` : '');
    console.log();
  }

  // ── 3. Heuristic policy with custom restMinutes ──────────────────────────
  {
    console.log('── 3. heuristic.custom-rest (5-min rest) ──');
    const policy = resolveAttentionPolicy(heuristicCustomRestRow, {
      logger: (m) => console.log('  [factory]', m),
    });
    console.log(`  policy.key = ${policy.key}`);
    const action = await policy.decide(emptyContext(), execCtx);
    console.log(`  decide(empty) → type=${action.type}`, 'nextTickAt' in action ? `nextTickAt=${action.nextTickAt}` : '');
    console.log();
  }

  // ── 4. Cron policy — pure sweep (processInbox=false) ───────────────────
  {
    console.log('── 4. cron.hourly — pure sweep, processInbox=false ──');
    const policy = resolveAttentionPolicy(cronHourlyRow, {});
    console.log(`  policy.key = ${policy.key}`);
    // Even with inbox messages, a pure sweep policy should rest.
    const action = await policy.decide(contextWithInbox(), execCtx);
    console.log(`  decide(inbox=1) → type=${action.type}`, 'nextTickAt' in action ? `nextTickAt=${action.nextTickAt}` : '');
    console.log();
  }

  // ── 5. Cron policy — inbox-capable ─────────────────────────────────────
  {
    console.log('── 5. cron.inbox-with-hourly-rest — processInbox=true ──');
    const policy = resolveAttentionPolicy(cronInboxRow, {});
    console.log(`  policy.key = ${policy.key}`);
    // Has inbox — should process.
    const action1 = await policy.decide(contextWithInbox(), execCtx);
    console.log(`  decide(inbox=1) → type=${action1.type}`, 'messageId' in action1 ? `messageId=${action1.messageId}` : '');
    // No inbox — should rest.
    const action2 = await policy.decide(emptyContext(), execCtx);
    console.log(`  decide(empty)   → type=${action2.type}`, 'nextTickAt' in action2 ? `nextTickAt=${action2.nextTickAt}` : '');
    console.log();
  }

  // ── 6. Model policy — no model supplied → logged fallback ───────────────
  {
    console.log('── 6. model.adaptive — no model supplied (expected fallback) ──');
    const warnings: string[] = [];
    const policy = resolveAttentionPolicy(modelRow, {
      logger: (m) => { console.log('  [factory]', m); warnings.push(m); },
    });
    console.log(`  policy.key = ${policy.key}`);
    const action = await policy.decide(emptyContext(), execCtx);
    console.log(`  decide(empty) → type=${action.type}`);
    console.log(`  warnings emitted: ${warnings.length > 0 ? 'yes' : 'none (unexpected!)'}`);
    console.log();
  }

  // ── 7. resolveAttentionPolicyFromDb — reads from the real DB ────────────
  {
    console.log('── 7. resolveAttentionPolicyFromDb — live DB lookup ──');
    const db = new SQLiteAdapter('./geneweave.db');
    await db.initialize();

    // The seeded 'heuristic.inbox-first' row is created by seedLiveAttentionPolicies()
    // during geneweave startup (live-handler-kinds-seed.ts).
    const policy = await resolveAttentionPolicyFromDb(db, 'heuristic.inbox-first', {
      logger: (m) => console.log('  [factory]', m),
    });
    console.log(`  resolved key = ${policy.key}`);
    const action = await policy.decide(contextWithBacklog(), execCtx);
    console.log(`  decide(backlog=1) → type=${action.type}`, 'backlogItemId' in action ? `backlogItemId=${action.backlogItemId}` : '');

    // Try an unknown key → should fall back to standard.
    const fallback = await resolveAttentionPolicyFromDb(db, 'does.not.exist', {
      logger: (m) => console.log('  [factory fallback]', m),
    });
    console.log(`  resolved unknown key → key=${fallback.key} (expected 'standard-v1')`);
    console.log();

    // ── 8. resolveAgentAttentionPolicy — full geneweave bridge ──────────
    console.log('── 8. resolveAgentAttentionPolicy — geneweave bridge ──');

    const agentRow: AgentAttentionFieldsRow = {
      id: 'agent-demo-001',
      attention_policy_key: 'heuristic.inbox-first',
    };
    const policy2 = await resolveAgentAttentionPolicy(db, agentRow, {
      // No runId means no live_run_events row is appended (just resolves policy).
    });
    console.log(`  agent attention_policy_key = '${agentRow.attention_policy_key}'`);
    console.log(`  resolved policy.key = ${policy2.key}`);

    // Agent with no attention_policy_key → falls back to standard.
    const agentNoKey: AgentAttentionFieldsRow = { id: 'agent-demo-002', attention_policy_key: null };
    const policy3 = await resolveAgentAttentionPolicy(db, agentNoKey, {});
    console.log(`  agent with null key → policy.key = ${policy3.key} (expected 'standard-v1')`);
    console.log();
  }

  console.log('=== Done ===');
}

main().catch((err: unknown) => {
  console.error('Example 86 failed:', err);
  process.exit(1);
});
