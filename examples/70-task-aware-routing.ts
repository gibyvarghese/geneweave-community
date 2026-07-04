/**
 * Example 70 — anyWeave Phase 2: Task-Aware LLM Routing
 *
 * Demonstrates the SmartModelRouter task-aware extension end-to-end:
 *   - Task type inference from explicit hints, tools, prompt keywords
 *   - Model capability filter + capability-weighted scoring
 *   - Output modality filter
 *   - Per-call cost ceiling
 *   - Decision trace persistence in routing_decision_traces
 *
 * Run:
 *   npx tsx examples/70-task-aware-routing.ts
 *
 * Requires: ./geneweave.db with Phase 1 seed data (16 task types, 91 capability scores).
 */

import 'dotenv/config';
import { SQLiteAdapter } from '../apps/geneweave/dist/db-sqlite.js';
import { routeModel } from '../apps/geneweave/dist/chat-routing-utils.js';

async function main() {
  const dbPath = process.env['DATABASE_PATH'] ?? './geneweave.db';
  console.log(`\nUsing DB: ${dbPath}\n`);
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  const policies = await db.listRoutingPolicies();
  const active = policies.find(p => p.enabled);
  if (!active) {
    console.error('❌ No enabled routing_policies row. Run Phase 1 seed first.');
    process.exit(1);
  }
  console.log(`✓ Active policy: ${active.name} (${active.strategy})`);

  const taskTypes = await db.listTaskTypes();
  const capScores = await db.listCapabilityScores({ tenantId: null });
  console.log(`✓ ${taskTypes.length} task types, ${capScores.length} capability scores loaded\n`);

  // Build a candidate pool from capability scores (unique model:provider pairs).
  const seen = new Set<string>();
  const candidates: Array<{ id: string; provider: string }> = [];
  for (const r of capScores) {
    const key = `${r.provider}:${r.model_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ id: r.model_id, provider: r.provider });
  }
  console.log(`✓ ${candidates.length} unique candidate models\n`);

  const scenarios: Array<{ label: string; opts: Parameters<typeof routeModel>[3] }> = [
    {
      label: 'A) Code generation via tool inference (tools:["execute_code"])',
      opts: { tools: [{ name: 'execute_code' }], prompt: 'help me' },
    },
    {
      label: 'B) Classification via prompt inference',
      opts: { prompt: 'classify this email as spam or not spam' },
    },
    {
      label: 'C) Image generation via prompt + outputModality=image',
      opts: { prompt: 'draw a picture of a sunset over mountains', outputModality: 'image' },
    },
    {
      label: 'D) Explicit taskType=summarization overrides inference',
      opts: { taskType: 'summarization', prompt: 'classify this thing' },
    },
    {
      label: 'E) Cost ceiling $0.0001 — forces cheap models only',
      opts: { prompt: 'summarize this short note', maxCostPerCall: 0.0001 },
    },
    {
      label: 'F) Default text task (no hints)',
      opts: { prompt: 'hello, how are you today?' },
    },
  ];

  for (const sc of scenarios) {
    console.log(`\n── ${sc.label}`);
    const before = (await db.listRoutingDecisionTraces({ limit: 1 }))[0]?.decided_at ?? '';
    const result = await routeModel(db, candidates, [], sc.opts);
    if (!result) {
      console.log('  → NULL (router fell back)');
      continue;
    }
    console.log(`  → Selected: ${result.provider}:${result.modelId}`);
    if (result.taskKey) console.log(`    taskKey       = ${result.taskKey}`);
    if (result.inferenceSource) console.log(`    inference     = ${result.inferenceSource}`);

    const traces = await db.listRoutingDecisionTraces({ limit: 1 });
    const newest = traces[0];
    if (newest && newest.decided_at !== before) {
      console.log(`    trace_id      = ${newest.id}`);
      console.log(`    candidates    = ${(JSON.parse(newest.candidate_breakdown)?.candidates?.length ?? 0)}`);
    } else {
      console.log('    (no new trace persisted)');
    }
  }

  const totalTraces = await db.listRoutingDecisionTraces({ limit: 1000 });
  console.log(`\n✓ Total traces in DB: ${totalTraces.length}`);
  console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
