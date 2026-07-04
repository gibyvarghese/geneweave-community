/**
 * Phase 6 — `weaveLiveMeshFromDb` single-call hydration demo
 * --------------------------------------------------------------------
 * Phase 6 introduces ONE function that boots an entire live-agents mesh
 * from DB rows: handler registry, model resolver, attention policy, and
 * the heartbeat supervisor are all wired in a single call.
 *
 * Before Phase 6 (apps/geneweave/src/live-agents/generic-supervisor-boot.ts):
 *   ~150 LOC of bespoke composition per app.
 *
 * After Phase 6:
 *   ```
 *   const handle = await weaveLiveMeshFromDb(db, {
 *     store,
 *     modelResolver,
 *     extraHandlerKinds,
 *   });
 *   // ... later
 *   await handle.stop();
 *   ```
 *
 * This example uses an in-memory stub DB and `weaveInMemoryStateStore`,
 * so it runs end-to-end with no SQLite, no LLM, no external services.
 *
 * Run:
 *   npx tsx examples/96-live-agents-phase6-mesh-from-db.ts
 */

import { weaveInMemoryStateStore } from '@weaveintel/live-agents';
import type { TaskHandler } from '@weaveintel/live-agents';
import {
  weaveLiveMeshFromDb,
  weaveLiveAgentFromDb,
  type LiveAgentsDb,
  type SingleAgentReaderDb,
} from '@weaveintel/live-agents-runtime';
import type { HandlerKindRegistration } from '@weaveintel/live-agents-runtime';

// ─── 1. Build a tiny in-memory DB ────────────────────────────

interface Mesh {
  id: string;
  status: string;
}
interface Agent {
  id: string;
  mesh_id: string;
  role_key: string;
  name: string;
  status: string;
  attention_policy_key: string | null;
}
interface Binding {
  id: string;
  agent_id: string;
  handler_kind: string;
  config_json: string | null;
  enabled: number;
}

const meshes: Mesh[] = [{ id: 'demo-mesh', status: 'ACTIVE' }];
const agents: Agent[] = [
  {
    id: 'agent-discoverer',
    mesh_id: 'demo-mesh',
    role_key: 'discoverer',
    name: 'Discoverer',
    status: 'ACTIVE',
    attention_policy_key: null,
  },
  {
    id: 'agent-summariser',
    mesh_id: 'demo-mesh',
    role_key: 'summariser',
    name: 'Summariser',
    status: 'ACTIVE',
    attention_policy_key: null,
  },
];
const bindings: Binding[] = [
  {
    id: 'b-discoverer',
    agent_id: 'agent-discoverer',
    handler_kind: 'demo.echo',
    config_json: '{"phase":"discovery"}',
    enabled: 1,
  },
  {
    id: 'b-summariser',
    agent_id: 'agent-summariser',
    handler_kind: 'demo.echo',
    config_json: '{"phase":"summary"}',
    enabled: 1,
  },
];

// Stub satisfies the methods the boot-existing-mesh path actually invokes.
// All other LiveAgentsDb methods are unused in this demo and return [] / null.
const noop = async (): Promise<void> => undefined;
const stubDb = {
  listLiveMeshes: async () =>
    meshes
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({ id: m.id, tenant_id: null, name: m.id, status: m.status })),
  listLiveAgents: async ({ meshId, status }: { meshId?: string; status?: string }) =>
    agents
      .filter((a) => (meshId ? a.mesh_id === meshId : true))
      .filter((a) => (status ? a.status === status : true)),
  listLiveAgentHandlerBindings: async ({
    agentId,
    enabledOnly,
  }: {
    agentId?: string;
    enabledOnly?: boolean;
  }) =>
    bindings
      .filter((b) => (agentId ? b.agent_id === agentId : true))
      .filter((b) => (enabledOnly ? b.enabled === 1 : true)),
  listLiveRuns: async () => [],
  listLiveRunSteps: async () => [],
  updateLiveRunStep: noop,
  appendLiveRunEvent: noop,
  listLiveAgentToolBindings: async () => [],
  getToolConfig: async () => null,
  getLiveAttentionPolicyByKey: async () => null,
  getLiveMeshDefinition: async () => null,
  getLiveMeshDefinitionByKey: async () => null,
  listLiveAgentDefinitions: async () => [],
  listLiveMeshDelegationEdges: async () => [],
  listToolConfigs: async () => [],
  createLiveMesh: noop,
  createLiveAgent: noop,
  createLiveAgentHandlerBinding: noop,
  createLiveAgentToolBinding: noop,
} as unknown as LiveAgentsDb;

// ─── 2. Define a custom handler kind ─────────────────────────

const echoKind: HandlerKindRegistration = {
  kind: 'demo.echo',
  description:
    'Echoes the binding config back into the run summary. Demo-only.',
  factory: (ctx): TaskHandler => async () => {
    const phase = (ctx.binding.config['phase'] as string | undefined) ?? '?';
    ctx.log(`tick → phase=${phase}`);
    return { completed: true, summaryProse: `${ctx.agent.roleKey}: ${phase}` };
  },
};

// ─── 3. Boot the mesh in one call ────────────────────────────

async function main(): Promise<void> {
  console.log('─── weaveLiveMeshFromDb (boot existing) ───');
  const store = weaveInMemoryStateStore();
  const handle = await weaveLiveMeshFromDb(stubDb, {
    store,
    extraHandlerKinds: [echoKind],
    intervalMs: 60_000, // long interval — demo doesn't need a real tick
    refreshMs: 60_000,
    logger: (m) => console.log(`  [mesh] ${m}`),
  });

  console.log(
    `  registered handler kinds: ${handle.handlerRegistry.kinds().sort().join(', ')}`,
  );
  console.log(`  provisioned: ${handle.provisioned ? 'yes' : 'no (boot only)'}`);

  await handle.stop();
  console.log('  stopped cleanly\n');

  // ─── 4. Hydrate one agent and invoke it directly ─────────────
  console.log('─── weaveLiveAgentFromDb (single agent) ───');
  const singleDb = stubDb as unknown as SingleAgentReaderDb;
  const single = await weaveLiveAgentFromDb(singleDb, 'agent-discoverer', {
    extraHandlerKinds: [echoKind],
    logger: (m) => console.log(`  [single] ${m}`),
  });
  console.log(`  agent role: ${single.agent.roleKey}`);
  console.log(`  binding kind: ${single.binding.handlerKind}`);
  console.log(`  binding config: ${JSON.stringify(single.binding.config)}`);

  // The handler is fully runnable — caller drives it with their own
  // Action + ActionExecutionContext. We only verify it exists.
  console.log(`  handler is callable: ${typeof single.handler === 'function'}`);
}

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
