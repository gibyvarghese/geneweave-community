/**
 * Example 84 — Resolve an agent's tool surface from the database.
 *
 * Phase 3 of the DB-Driven Live-Agents Runtime in action: every tool the
 * agent can call is decided by `live_agent_tool_bindings` rows + the
 * operator-managed `tool_catalog`. No code-side capability matrix.
 *
 * What it does:
 *   1. Re-uses the "inbox-triage" demo mesh from examples/82-define-mesh-via-db.ts
 *      (run that example first if your DB is fresh).
 *   2. Ensures the responder agent has two tool bindings:
 *        a. A built-in `get_current_time` tool (catalog row, source='builtin').
 *        b. An inline MCP server URL.
 *   3. Resolves the responder's effective ToolRegistry via
 *      `buildToolRegistryForAgent()` — the geneweave bridge that wires the
 *      runtime-package binder into the existing `createToolRegistry` factory.
 *   4. Lists the resulting tool names and warnings.
 *
 * Run with:
 *   npx tsx examples/84-agent-tool-binding.ts
 *
 * Idempotent — re-running reuses existing rows.
 */
import { SQLiteAdapter } from '../apps/geneweave/src/db-sqlite.js';
import { newUUIDv7 } from '../apps/geneweave/src/lib/uuid.js';
import { syncToolCatalog } from '../apps/geneweave/src/tools.js';
import { buildToolRegistryForAgent } from '../apps/geneweave/src/live-agents/agent-tool-registry.js';

async function main(): Promise<void> {
  const db = new SQLiteAdapter('./geneweave.db');
  await db.initialize();
  // Make sure the operator catalog has a row for every BUILTIN_TOOLS key
  // (boot does this in production; we re-run for standalone safety).
  await syncToolCatalog(db);

  // ── 1. Locate the responder agent created by example 82 ─────────
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

  // ── 2. Ensure two tool bindings exist for the responder ─────────
  // (a) built-in tool catalog row → `datetime`
  const timeCatalog = await db.getToolCatalogByKey('datetime');
  if (!timeCatalog) {
    console.error('tool_catalog row for datetime not found.');
    process.exit(1);
  }

  const existingBindings = await db.listLiveAgentToolBindings({ agentId: responder.id });
  const hasBuiltinBinding = existingBindings.some((b) => b.tool_catalog_id === timeCatalog.id);
  if (!hasBuiltinBinding) {
    await db.createLiveAgentToolBinding({
      id: newUUIDv7(),
      agent_id: responder.id,
      tool_catalog_id: timeCatalog.id,
      mcp_server_url: null,
      capability_keys: JSON.stringify([]),
      enabled: 1,
    });
    console.log(`Bound responder → tool_catalog datetime (${timeCatalog.id})`);
  } else {
    console.log('Responder already bound to datetime.');
  }

  // (b) inline MCP server URL — example 82 may already have created one.
  const hasMcpBinding = existingBindings.some((b) => b.mcp_server_url);
  if (!hasMcpBinding) {
    await db.createLiveAgentToolBinding({
      id: newUUIDv7(),
      agent_id: responder.id,
      tool_catalog_id: null,
      mcp_server_url: 'http://localhost:9999/mcp', // dummy; will be skipped at connect time
      capability_keys: JSON.stringify([]),
      enabled: 1,
    });
    console.log('Bound responder → inline MCP url http://localhost:9999/mcp');
  }

  // ── 3. Resolve the agent's ToolRegistry from DB ─────────────────
  const result = await buildToolRegistryForAgent(db, responder.id, {
    actorPersona: 'agent_worker',
  });

  console.log('\n── Resolved agent tool surface ──');
  console.log('catalog entries  :', result.catalogEntries.length);
  console.log('  ', result.catalogEntries.map((c) => `${c.source}:${c.tool_key ?? c.name}`));
  console.log('builtin tool keys:', result.builtinToolKeys);
  console.log('warnings         :', result.warnings);

  if (result.registry) {
    const tools = result.registry.list();
    console.log('\nFinal registered tools (after policy / persona filtering):');
    for (const t of tools) {
      console.log(`  - ${t.schema.name}  (${t.schema.description?.slice(0, 60) ?? ''}...)`);
    }
  } else {
    console.log('\nNo registry built (no enabled bindings or all skipped).');
  }

  // ── 4. Demonstrate a disabled binding is skipped ───────────────
  console.log('\n── Disabled-binding diagnostics ──');
  const allBindings = await db.listLiveAgentToolBindings({ agentId: responder.id });
  const builtinBinding = allBindings.find((b) => b.tool_catalog_id === timeCatalog.id);
  if (builtinBinding) {
    await db.updateLiveAgentToolBinding(builtinBinding.id, { enabled: 0 });
    const reduced = await buildToolRegistryForAgent(db, responder.id, {
      actorPersona: 'agent_worker',
    });
    console.log(
      'after disabling datetime binding, builtin keys =',
      reduced.builtinToolKeys,
    );
    // Restore so the demo is idempotent.
    await db.updateLiveAgentToolBinding(builtinBinding.id, { enabled: 1 });
  }

  console.log('\n✅ Phase 3 tool binder demo complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
