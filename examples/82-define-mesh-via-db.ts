/**
 * Example 82 — Define a live-agents mesh purely via the database.
 *
 * This example demonstrates Phase 1 of the DB-Driven Live-Agents Runtime
 * (M22). It shows how an operator (or an external integration) can stand up
 * a brand-new mesh, complete with role personas, handler bindings, and tool
 * bindings, without touching any TypeScript code or restarting the server.
 *
 * What it does, end-to-end:
 *
 *  1. Opens the GeneWeave SQLite DB at `./geneweave.db` (the same DB the
 *     admin UI uses).
 *  2. Inserts a brand-new framework-level mesh contract ("inbox-triage")
 *     into `live_mesh_definitions` along with two role personas in
 *     `live_agent_definitions`.
 *  3. Provisions a runtime instance of that mesh by inserting a
 *     `live_meshes` row + two `live_agents` rows that reference the
 *     definitions above.
 *  4. Binds each agent to a handler kind (`agentic.react`) via
 *     `live_agent_handler_bindings`, picking config straight from the
 *     `live_handler_kinds` registry seeded on first boot.
 *  5. Optionally binds the triager agent to an MCP tool endpoint via
 *     `live_agent_tool_bindings`.
 *  6. Lists every row back so the reader can see the resulting state.
 *
 * Run with:
 *   npx tsx examples/82-define-mesh-via-db.ts
 *
 * Idempotent: re-running the example reuses the same mesh_key without
 * inserting duplicates.
 */
import { SQLiteAdapter } from '../apps/geneweave/src/db-sqlite.js';
import { newUUIDv7 } from '../apps/geneweave/src/lib/uuid.js';
import {
  seedLiveHandlerKinds,
  seedLiveAttentionPolicies,
} from '../apps/geneweave/src/live-agents/live-handler-kinds-seed.js';

async function main(): Promise<void> {
  const db = new SQLiteAdapter('./geneweave.db');
  await db.initialize();
  // Ensure runtime registries exist (in production these are seeded by
  // the GeneWeave server boot; we re-run them here for standalone use).
  await seedLiveHandlerKinds(db);
  await seedLiveAttentionPolicies(db);

  // ── 1. Mesh definition (framework-level) ────────────────────────
  const meshKey = 'inbox-triage';
  let meshDef = await db.getLiveMeshDefinitionByKey(meshKey);
  if (!meshDef) {
    meshDef = await db.createLiveMeshDefinition({
      id: newUUIDv7(),
      mesh_key: meshKey,
      name: 'Inbox Triage Mesh',
      charter_prose: 'Triage incoming customer inbox items: classify, draft a reply, escalate when unsure.',
      dual_control_required_for: JSON.stringify([]),
      enabled: 1,
      description: 'Demo mesh seeded by examples/82-define-mesh-via-db.ts',
    });
    console.log('Created mesh definition', meshDef.mesh_key);
  } else {
    console.log('Reusing existing mesh definition', meshDef.mesh_key);
  }

  // ── 2. Two role personas ────────────────────────────────────────
  const triagerRoleKey = 'triager';
  const responderRoleKey = 'responder';
  const existingAgents = await db.listLiveAgentDefinitions({ meshDefId: meshDef.id });
  const ensureAgentDef = async (
    role_key: string,
    name: string,
    role_label: string,
    persona: string,
    ordering: number,
  ) => {
    const found = existingAgents.find((a) => a.role_key === role_key);
    if (found) return found;
    return db.createLiveAgentDefinition({
      id: newUUIDv7(),
      mesh_def_id: meshDef!.id,
      role_key,
      name,
      role_label,
      persona,
      objectives: 'Drive resolution; never invent facts.',
      success_indicators: 'Each handled item has a contract row.',
      ordering,
      enabled: 1,
    });
  };
  const triagerDef = await ensureAgentDef('triager', 'Inbox Triager', 'Inbox Triager', 'Read each new inbox item and classify it as { ack | reply-needed | escalate }.', 10);
  const responderDef = await ensureAgentDef('responder', 'Customer Responder', 'Responder', 'Draft a polite, accurate response to inbox items the triager flagged as reply-needed.', 20);

  // ── 3. Provision a runtime mesh + agents ────────────────────────
  const liveMeshes = await db.listLiveMeshes({ meshDefId: meshDef.id });
  let liveMesh = liveMeshes[0];
  if (!liveMesh) {
    liveMesh = await db.createLiveMesh({
      id: newUUIDv7(),
      tenant_id: null,
      mesh_def_id: meshDef.id,
      name: 'Inbox Triage (demo)',
      status: 'ACTIVE',
      domain: 'support',
      dual_control_required_for: JSON.stringify([]),
      owner_human_id: null,
      mcp_server_ref: null,
      account_id: null,
      context_json: '{}',
    });
    console.log('Provisioned live mesh', liveMesh.id);
  }

  const provisioned = await db.listLiveAgents({ meshId: liveMesh.id });
  const ensureAgent = async (
    role_key: string,
    name: string,
    role_label: string,
    persona: string,
    ordering: number,
    agent_def_id: string,
  ) => {
    const found = provisioned.find((a) => a.role_key === role_key);
    if (found) return found;
    return db.createLiveAgent({
      id: newUUIDv7(),
      mesh_id: liveMesh!.id,
      agent_def_id,
      role_key,
      name,
      role_label,
      persona,
      objectives: '[]',
      success_indicators: '[]',
      attention_policy_key: 'heuristic.inbox-first',
      contract_version_id: null,
      status: 'ACTIVE',
      ordering,
      archived_at: null,
    });
  };
  const triager = await ensureAgent('triager', 'Inbox Triager', 'Triager', triagerDef.persona, 10, triagerDef.id);
  const responder = await ensureAgent('responder', 'Customer Responder', 'Responder', responderDef.persona, 20, responderDef.id);

  // ── 4. Handler bindings (agentic.react ships from the seed) ─────
  const handlerKind = await db.getLiveHandlerKindByKind('agentic.react');
  if (!handlerKind) throw new Error('Expected seeded handler kind agentic.react');

  const ensureHandlerBinding = async (agent_id: string) => {
    const existing = await db.listLiveAgentHandlerBindings({ agentId: agent_id });
    if (existing.length > 0) return existing[0];
    return db.createLiveAgentHandlerBinding({
      id: newUUIDv7(),
      agent_id,
      handler_kind: handlerKind.kind,
      config_json: JSON.stringify({ max_steps: 6 }),
      enabled: 1,
    });
  };
  await ensureHandlerBinding(triager.id);
  await ensureHandlerBinding(responder.id);

  // ── 5. (Optional) tool binding via MCP endpoint ─────────────────
  const responderTools = await db.listLiveAgentToolBindings({ agentId: responder.id });
  if (responderTools.length === 0) {
    await db.createLiveAgentToolBinding({
      id: newUUIDv7(),
      agent_id: responder.id,
      tool_catalog_id: null,
      mcp_server_url: 'http://localhost:3500/mcp', // gateway echo for the demo
      capability_keys: JSON.stringify([]),
      enabled: 1,
    });
  }

  // ── 6. Verify ──────────────────────────────────────────────────
  const summary = {
    mesh_definition: meshDef.mesh_key,
    live_mesh_id: liveMesh.id,
    agents: (await db.listLiveAgents({ meshId: liveMesh.id })).map((a) => ({
      role: a.role_key,
      handler_bindings: 0,
      tool_bindings: 0,
    })),
  };
  for (const a of summary.agents) {
    const agentRow = (await db.listLiveAgents({ meshId: liveMesh.id })).find((r) => r.role_key === a.role)!;
    a.handler_bindings = (await db.listLiveAgentHandlerBindings({ agentId: agentRow.id })).length;
    a.tool_bindings = (await db.listLiveAgentToolBindings({ agentId: agentRow.id })).length;
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log('Done. Open http://localhost:3500/admin → Live Agents to see all rows.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
