/**
 * Example 83 — DB-driven handler registry (Phase 2 of the live-agents
 * runtime plan).
 *
 * Demonstrates the `@weaveintel/live-agents-runtime` package end-to-end
 * WITHOUT a database — every dependency (binding, agent info, state store,
 * model) is constructed inline so the example is self-contained and runs
 * with `npx tsx examples/83-handler-registry.ts`.
 *
 * What it shows:
 *   1. Build a `HandlerRegistry` and register the two built-in plugins.
 *   2. Plant a fake inbound TASK in an in-memory state store.
 *   3. Resolve the `deterministic.forward` plugin from a binding row,
 *      invoke its `TaskHandler`, and verify a new outbound message exists.
 *   4. Show the same registry resolving `agentic.react` with a stub Model
 *      so the LLM-driven path is also exercised end-to-end.
 *
 * In production (geneweave), the same registry is initialised at server
 * boot via `apps/geneweave/src/live-agents/handler-registry-boot.ts`, and
 * the bindings come from rows in `live_agent_handler_bindings`.
 */

import {
  createDefaultHandlerRegistry,
  type HandlerBinding,
  type HandlerAgentInfo,
  type HandlerContext,
  type DeterministicForwardContextExtras,
} from '@weaveintel/live-agents-runtime';
import {
  weaveInMemoryStateStore,
  type ActionExecutionContext,
  type Message,
  type LiveAgent,
  type TaskHandlerResult,
} from '@weaveintel/live-agents';
import type { Model, ModelRequest, ModelResponse, ExecutionContext, CapabilityId } from '@weaveintel/core';

// ─── Setup ────────────────────────────────────────────────────────────────

const registry = createDefaultHandlerRegistry();
console.log('Registered handler kinds:', registry.kinds());

const meshId = 'mesh-demo';
const agentInfo: HandlerAgentInfo = {
  id: 'agent-router',
  meshId,
  roleKey: 'router',
  name: 'Demo Router',
};
const liveAgent: LiveAgent = {
  id: agentInfo.id,
  meshId,
  name: agentInfo.name,
  role: agentInfo.roleKey,
  contractVersionId: 'contract-v1',
  status: 'ACTIVE',
  createdAt: new Date().toISOString(),
  archivedAt: null,
};

const stateStore = weaveInMemoryStateStore();

// Plant a fake inbound TASK so the handler has something to forward.
const inbound: Message = {
  id: 'msg-in-1',
  meshId,
  fromType: 'AGENT',
  fromId: 'agent-upstream',
  fromMeshId: meshId,
  toType: 'AGENT',
  toId: agentInfo.id,
  topic: null,
  kind: 'TASK',
  replyToMessageId: null,
  threadId: 'thr-1',
  contextRefs: [],
  contextPacketRef: null,
  expiresAt: null,
  priority: 'NORMAL',
  status: 'DELIVERED',
  deliveredAt: new Date().toISOString(),
  readAt: null,
  processedAt: null,
  createdAt: new Date().toISOString(),
  subject: 'New lead from website',
  body: 'Customer "Acme Co" filled the contact form. Email: foo@acme.test.',
};
await stateStore.saveMessage(inbound);

// ─── Demo 1: deterministic.forward ────────────────────────────────────────
//
// This binding tells the runtime: "for this agent, forward every inbound
// TASK to a specific downstream agent with a new subject line." No LLM call.

const forwardBinding: HandlerBinding = {
  id: 'binding-fwd-1',
  agentId: agentInfo.id,
  handlerKind: 'deterministic.forward',
  config: {
    outboundSubject: 'Triage: new lead',
    to: { type: 'AGENT', id: 'agent-triager' },
    bodyTemplate: 'Forwarded by {{from}}:\n\n{{body}}',
  },
};

const forwardCtx: HandlerContext & DeterministicForwardContextExtras = {
  binding: forwardBinding,
  agent: agentInfo,
  log: (m) => console.log(`[router] ${m}`),
  // Not needed for `AGENT` target type, but shown here for completeness:
  resolveAgentByRole: async () => null,
};

const forwardHandler = registry.build(forwardCtx);

const execCtx: ActionExecutionContext = {
  tickId: 'tick-1',
  nowIso: new Date().toISOString(),
  stateStore,
  agent: liveAgent,
  activeBindings: [],
};
// `ExecutionContext` is the cross-package telemetry / config bag — a stub
// is sufficient for this demo because deterministic.forward never calls
// out to the model or tool layers.
const xc = {} as ExecutionContext;

const fwdResult = await forwardHandler(
  { type: 'StartTask', backlogItemId: 'bli-1' },
  execCtx,
  xc,
);
console.log('forward result:', fwdResult);

// Verify the message landed.
const triagerInbox = await stateStore.listMessagesForRecipient('AGENT', 'agent-triager');
console.log('triager inbox length:', triagerInbox.length);
console.log('triager last message subject:', triagerInbox.at(-1)?.subject);

// ─── Demo 2: agentic.react with a stub model ──────────────────────────────
//
// This binding resolves `agentic.react`. To keep the example offline we
// inject a hand-written stub `Model` that returns a single canned response
// (no tool calls, no streaming). In geneweave the model is resolved via
// `@weaveintel/routing` from the agent persona's capability requirement.

const stubModel: Model = {
  info: {
    provider: 'stub',
    modelId: 'stub-model',
    capabilities: new Set<CapabilityId>(),
  },
  capabilities: new Set<CapabilityId>(),
  hasCapability: () => false,
  async generate(_ctx: ExecutionContext, _request: ModelRequest): Promise<ModelResponse> {
    return {
      id: 'stub-resp-1',
      content: 'Lead acknowledged. Will route to sales triage.',
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: 'stub-model',
    };
  },
};

const reactBinding: HandlerBinding = {
  id: 'binding-react-1',
  agentId: agentInfo.id,
  handlerKind: 'agentic.react',
  config: {
    fallbackPrompt: 'You are a CRM intake agent. Acknowledge new leads concisely.',
    maxSteps: 4,
  },
};

const reactCtx: HandlerContext = {
  binding: reactBinding,
  agent: agentInfo,
  log: (m) => console.log(`[router-llm] ${m}`),
  model: stubModel,
};

const reactHandler = registry.build(reactCtx);
// Handlers may return void or a TaskHandlerResult; narrow to the result shape.
const reactResult = (await reactHandler(
  { type: 'StartTask', backlogItemId: 'bli-2' },
  execCtx,
  xc,
)) as TaskHandlerResult | undefined;
console.log('react result:', {
  completed: reactResult?.completed,
  summary: reactResult?.summaryProse?.slice(0, 120),
});

console.log('\n✅ Phase 2 handler registry demo complete.');
