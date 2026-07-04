/**
 * Example 145 — Phase 5: Runtime Memory Slot + Multi-Signal Retrieval
 *
 * Demonstrates:
 *   1. RuntimeMemorySlot  — unified memory facade wired into weaveRuntime
 *   2. SemanticMemory     — store & recall via vector similarity (or keyword fallback)
 *   3. WorkingMemory      — per-agent scratch state (patch, checkpoint, restore)
 *   4. fusedMemorySearch  — three-signal retrieval (semantic + keyword + entity)
 *   5. GeneWeave wiring   — runtime.memory backed by the existing chat memory DB
 *
 * In geneWeave these primitives are wired automatically at boot when
 * `createGeneWeave(config)` runs.
 */

import {
  weaveRuntime,
  RuntimeCapabilities,
  weaveInMemoryPersistence,
  weaveContext,
} from '@weaveintel/core';
import type { RuntimeMemorySlot } from '@weaveintel/core';
import {
  weaveSemanticMemory,
  weaveWorkingMemory,
  weaveEntityMemory,
  createRuntimeMemoryAdapter,
  fusedMemorySearch,
  weaveMemoryStore,
} from '@weaveintel/memory';

// ─── 1. Build the memory instances ───────────────────────────────────────────
//
// In production, replace `weaveMemoryStore()` with a durable backend:
//   weaveSqliteMemoryStore({ path: './agent-memory.db' })   — local
//   weavePgVectorMemoryStore({ url: process.env.PGVECTOR_URL })  — cloud
//
// Replace the no-op embedding model below with a real one:
//   const embeddingModel = openAI({ apiKey }).embeddingModel('text-embedding-3-small');

const memStore = weaveMemoryStore();   // in-memory for this example

const noopEmbeddingModel = {
  info: { provider: 'noop', modelId: 'noop-embed' } as const,
  async embed(_ctx: unknown, _req: { input: string[] }) {
    // zero-vector embeddings — for illustration only
    return { embeddings: _req.input.map(() => new Array(4).fill(0)) };
  },
};

const semanticMem = weaveSemanticMemory(noopEmbeddingModel as never, memStore);
const entityMem = weaveEntityMemory(memStore);
const workingMem = weaveWorkingMemory();

// ─── 2. Create the runtime memory adapter ────────────────────────────────────
//
// `createRuntimeMemoryAdapter` is a thin value-object wrapper. It satisfies
// the `RuntimeMemorySlot` interface so it can be passed to `weaveRuntime`.

const memoryAdapter: RuntimeMemorySlot = createRuntimeMemoryAdapter({
  semantic: semanticMem,
  working: workingMem,
  store: memStore,
  consolidate: async (userId) => {
    // In production: run weaveMemoryConsolidator here to distil episodic → semantic.
    console.log(`[consolidate] cold-path consolidation triggered for userId=${userId}`);
  },
});

// ─── 3. Wire into weaveRuntime ────────────────────────────────────────────────

const runtime = weaveRuntime({
  installDefaultTracer: false,
  tlsFloor: false,  // disabled for this local example (no outbound TLS)
  persistence: weaveInMemoryPersistence(),
  memory: memoryAdapter,
});

console.log('Capabilities:', [...runtime.capabilities]);
console.assert(runtime.has(RuntimeCapabilities.Memory), 'Memory capability missing!');
console.log('runtime.has(Memory):', runtime.has(RuntimeCapabilities.Memory));  // true

// ─── 4. SemanticMemory — store & recall ──────────────────────────────────────

const ctx = weaveContext({ runtime, userId: 'demo-user', executionId: 'ex-1' });

async function runSemanticExample() {
  await runtime.memory!.semantic.store(ctx, 'Alice lives in Paris and works as a data scientist.', {
    source: 'user',
  });
  await runtime.memory!.semantic.store(ctx, 'Alice prefers dark mode interfaces.');
  await runtime.memory!.semantic.store(ctx, 'Bob is a backend engineer in London.');

  const hits = await runtime.memory!.semantic.recall(ctx, 'Where does Alice live?', 3);
  console.log('\nSemanticMemory.recall("Where does Alice live?"):');
  for (const h of hits) {
    console.log('  •', h.content.slice(0, 80));
  }
}

// ─── 5. WorkingMemory — per-agent scratch state ───────────────────────────────

async function runWorkingMemoryExample() {
  const agentId = 'analyst-agent';

  const snap1 = await runtime.memory!.working.patch(ctx, agentId, [
    { op: 'set', key: 'currentTask', value: 'analyse Q3 report' },
    { op: 'set', key: 'progress', value: 0 },
  ]);
  console.log('\nWorkingMemory after patch:', snap1.content);

  await runtime.memory!.working.patch(ctx, agentId, [
    { op: 'set', key: 'progress', value: 42 },
  ]);

  const checkpoint = await runtime.memory!.working.checkpoint(ctx, agentId, { reason: 'mid-task' });
  console.log('Checkpoint id:', checkpoint.id);

  const current = await runtime.memory!.working.getCurrent(ctx, agentId);
  console.log('Current state:', current?.content);
}

// ─── 6. EntityMemory (via the raw store) ─────────────────────────────────────

async function runEntityExample() {
  await entityMem.upsertEntity(ctx, 'Alice', {
    role: 'data scientist',
    location: 'Paris',
  });

  const entity = await entityMem.getEntity(ctx, 'Alice');
  console.log('\nEntityMemory.getEntity("Alice"):', entity?.metadata);
}

// ─── 7. fusedMemorySearch — three-signal retrieval ───────────────────────────

async function runFusedSearch() {
  // Write a variety of entries into the store
  await memStore.write(ctx, [
    { id: 'sem-1', type: 'semantic', content: 'Alice lives in Paris', metadata: {}, createdAt: new Date().toISOString() },
    { id: 'sem-2', type: 'semantic', content: 'Bob works in London', metadata: {}, createdAt: new Date().toISOString() },
    { id: 'ep-1',  type: 'episodic', content: 'User mentioned a Paris trip next week', metadata: {}, createdAt: new Date().toISOString() },
    { id: 'ent-1', type: 'entity',   content: 'Paris', metadata: { entityType: 'location' }, createdAt: new Date().toISOString() },
  ]);

  const results = await fusedMemorySearch(runtime.memory!.store, ctx, {
    query: 'Paris',
    topK: 4,
    semanticWeight: 0.5,
    keywordWeight: 0.3,
    entityWeight: 0.2,
  });

  console.log('\nfusedMemorySearch("Paris"):');
  for (const { entry, score, signals } of results) {
    const sigStr = Object.entries(signals)
      .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
      .join(', ');
    console.log(`  • [score=${score.toFixed(3)}] [${sigStr}] ${entry.content.slice(0, 60)}`);
  }
}

// ─── 8. GeneWeave wiring reference ───────────────────────────────────────────
//
// In geneWeave (`apps/geneweave/src/index.ts`) the slot is wired at boot:
//
//   const runtimeMemoryStore = createGeneWeaveMemoryStore(db);
//   const semanticMem = guardrailEmbeddingModel
//     ? weaveSemanticMemory(guardrailEmbeddingModel, runtimeMemoryStore)
//     : createKeywordSemanticMemory(runtimeMemoryStore);
//   const memoryAdapter = createRuntimeMemoryAdapter({
//     semantic: semanticMem,
//     working: weaveWorkingMemory(),
//     store: runtimeMemoryStore,
//   });
//   const runtime = weaveRuntime({ ..., memory: memoryAdapter });
//
// Live agents access it via:
//   const mem = ctx.runtime?.memory;
//   const results = await fusedMemorySearch(mem.store, ctx, { query, userId });
//
// The chat path has a rich upgrade path:
//   import { buildFusedMemoryContext } from './chat-memory-utils.js';
//   const memCtx = await buildFusedMemoryContext(db, ctx, model, userId, query, runtime.memory);

console.log('\n=== Phase 5 — Runtime Memory Slot ===');

async function main() {
  await runSemanticExample();
  await runWorkingMemoryExample();
  await runEntityExample();
  await runFusedSearch();

  console.log(`
Phase 5 integration checklist:
  [✓] RuntimeMemorySlot    — interface in @weaveintel/core with semantic, working, store, consolidate
  [✓] RuntimeCapabilities.Memory — auto-advertised when slot is configured
  [✓] createRuntimeMemoryAdapter — in @weaveintel/memory
  [✓] fusedMemorySearch    — semantic + keyword + entity signals, normalised weighted sum
  [✓] GeneWeave bridge     — createGeneWeaveMemoryStore wraps existing DB adapter
  [✓] buildFusedMemoryContext — upgrade path in chat-memory-utils.ts
  [✓] weaveRuntime({ memory }) — wired in geneWeave index.ts at boot
`);
}

void main();
