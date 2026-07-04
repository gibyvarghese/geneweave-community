/**
 * Example 85 — DB-driven model routing for live agents.
 *
 * Demonstrates the three resolution paths driven by the `model_*` columns on
 * `live_agents`, using the unified Phase 2 API (`weaveAgentOverlayResolver`
 * from `@weaveintel/live-agents-runtime`):
 *
 *   1. Default       — no columns set → base resolver wins.
 *   2. Capability    — `model_capability_json` set → overlay merges hints
 *                      into ctx.capability, base resolver picks a model.
 *   3. Pinned        — `model_pinned_id` set → `loadPinnedModel` runs,
 *                      base resolver is bypassed (replay / reproducibility).
 *
 * Each successful resolution appends an audit row to `live_run_events`
 * (`kind = 'model.resolved'`) via the overlay's `appendAuditEvent` hook.
 *
 * Re-uses the inbox-triage demo mesh from examples/82-define-mesh-via-db.ts.
 *
 * Run:
 *   npx tsx examples/85-agent-model-routing.ts
 */
import { SQLiteAdapter } from '../apps/geneweave/src/db-sqlite.js';
import { newUUIDv7 } from '../apps/geneweave/src/lib/uuid.js';
import { weaveAgentOverlayResolver } from '@weaveintel/live-agents-runtime';
import type { Model } from '@weaveintel/core';
import type { ModelResolver } from '@weaveintel/live-agents';

/**
 * Tiny stub Model — keeps the example free of provider creds. We only
 * inspect `info.modelId` at the end to confirm the right path was taken.
 */
function fakeModel(label: string): Model {
  return {
    info: {
      providerId: 'fake',
      modelId: label,
      kind: 'chat',
      contextWindow: 8000,
      capabilities: [],
    },
    capabilities: [],
    async generate() {
      return {
        content: `[${label}] would respond`,
        finishReason: 'stop' as const,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Model;
}

async function main(): Promise<void> {
  const db = new SQLiteAdapter('./geneweave.db');
  await db.initialize();

  const meshDef = await db.getLiveMeshDefinitionByKey('inbox-triage');
  if (!meshDef) {
    console.error('Mesh "inbox-triage" not found. Run examples/82-define-mesh-via-db.ts first.');
    process.exit(1);
  }
  const meshes = await db.listLiveMeshes({ meshDefId: meshDef.id });
  const liveMesh = meshes[0];
  if (!liveMesh) {
    console.error('No provisioned mesh — run example 82 first.');
    process.exit(1);
  }
  const agents = await db.listLiveAgents({ meshId: liveMesh.id });
  const responder = agents.find((a) => a.role_key === 'responder');
  if (!responder) {
    console.error('Responder agent missing — run example 82 first.');
    process.exit(1);
  }

  const run = await db.createLiveRun({
    id: newUUIDv7(),
    mesh_id: liveMesh.id,
    tenant_id: null,
    run_key: `phase35-demo-${Date.now()}`,
    label: 'Phase 3.5 model routing demo',
    status: 'RUNNING',
    stop_requested: 0,
    started_at: new Date().toISOString(),
    completed_at: null,
    summary: null,
    context_json: null,
  });
  console.log(`Opened run ${run.id}`);

  // ── Base resolver: capability spec → routed stub model. The overlay
  //    delegates to this for the "default" and "capability" paths.
  const baseResolver: ModelResolver = {
    async resolve(ctx) {
      const task = (ctx.capability?.task as string | undefined) ?? 'generic';
      const policyKey = ctx.capability?.hints?.['policyKey'] as string | undefined;
      const tag = policyKey ? `${task}+${policyKey}` : task;
      return fakeModel(`routed/${tag}`);
    },
  };

  // ── Overlay: reads model_* columns per tick and either pins, merges
  //    capability hints, or passes through to the base.
  const overlay = weaveAgentOverlayResolver({
    base: baseResolver,
    getAgentRow: async (agentId) => db.getLiveAgent(agentId),
    loadPinnedModel: async (modelId) => fakeModel(`pinned/${modelId}`),
    appendAuditEvent: async (ev) => {
      await db.appendLiveRunEvent(ev);
    },
    newId: newUUIDv7,
  });

  const resolve = (agentId: string) =>
    overlay.resolve({ agentId, role: 'responder', runId: run.id });

  // ── Path A: no model_* columns set → DEFAULT (delegates to base) ──
  console.log('\n── Path A: default ──');
  await db.updateLiveAgent(responder.id, {
    model_capability_json: null,
    model_routing_policy_key: null,
    model_pinned_id: null,
  });
  let model = await resolve(responder.id);
  console.log(`  modelId=${model?.info.modelId}`);

  // ── Path B: capability spec → ROUTED via overlay → base ──
  console.log('\n── Path B: capability ──');
  await db.updateLiveAgent(responder.id, {
    model_capability_json: JSON.stringify({
      task: 'reasoning',
      toolUse: true,
      minContextTokens: 32000,
    }),
    model_routing_policy_key: 'cost-optimised',
  });
  model = await resolve(responder.id);
  console.log(`  modelId=${model?.info.modelId}`);

  // ── Path C: pinned id → bypass base resolver ──
  console.log('\n── Path C: pinned ──');
  await db.updateLiveAgent(responder.id, {
    model_pinned_id: 'gpt-4o-2024-08-06',
  });
  model = await resolve(responder.id);
  console.log(`  modelId=${model?.info.modelId}`);

  // ── Audit trail ──
  console.log('\n── live_run_events for this run ──');
  const events = await db.listLiveRunEvents({ runId: run.id });
  for (const ev of events) {
    console.log(`  [${ev.kind}] ${ev.summary}  payload=${ev.payload_json}`);
  }

  // ── Reset overrides so re-runs of example 82 keep clean state ──
  await db.updateLiveAgent(responder.id, {
    model_capability_json: null,
    model_routing_policy_key: null,
    model_pinned_id: null,
  });
  await db.updateLiveRun(run.id, {
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
    summary: 'Phase 3.5 demo complete',
  });

  await db.close();
  console.log('\nPhase 3.5 demo complete ✔');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
