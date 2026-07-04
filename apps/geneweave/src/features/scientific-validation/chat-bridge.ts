/**
 * Hypothesis Validation — Chat Bridge
 *
 * Replaces the legacy `runner.ts` workflow engine. Uses the SAME building blocks
 * that `chat.ts` uses for its supervisor mode (`weaveSupervisor` + DB-loaded
 * `worker_agents` rows + policy-enforced tool registries) so SV deliberation
 * is now purely DB-driven.
 *
 * Design contract:
 *  - All agents come from `worker_agents` (loaded by `listEnabledWorkerAgents`)
 *  - All tools come from BUILTIN_TOOLS + tool_catalog rows
 *  - All system prompts come from the `prompts` table (sv.* keys for SV-specific
 *    workers; chat-supervisor instructions are built by the same DB policy
 *    prompts chat.ts uses)
 *  - Worker turns and tool calls are streamed to `hv_agent_turn` and
 *    `hv_evidence_event` via the agent event bus, so the UI's SSE endpoints
 *    keep working unchanged.
 *  - The supervisor's final output is parsed for a verdict JSON block which
 *    becomes a `hv_verdict` row.
 *
 * The runner contract (`startRun(input)` / `cancelRun(id)`) is preserved so the
 * existing route handlers (and the SV UI) require no changes beyond an import
 * swap.
 */

import { newUUIDv7 } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import {
  weaveContext,
  weaveEventBus,
  EventTypes,
} from '@weaveintel/core';
import type {
  Tool,
  Model,
  ToolRegistry,
  ExecutionContext,
  WeaveEvent,
} from '@weaveintel/core';
import { createPolicyEnforcedRegistry, noopAuditEmitter } from '@weaveintel/tools';
import type { ToolPolicyResolver, ToolAuditEmitter } from '@weaveintel/tools';
import { weaveToolRegistry } from '@weaveintel/core';

import type { DatabaseAdapter } from '../../db.js';
import type { WorkerAgentRow, SvClaimType } from '../../db-types.js';
import { SV_PROMPT_KEY } from './sv-seed.js';

/** Public input contract — same shape as the legacy runner used. */
export interface SVRunInput {
  hypothesisId: string;
  tenantId: string;
  userId: string;
  statement: string;
  domainTags: string[];
  budgetId: string;
}

export interface SVChatBridgeOptions {
  db: DatabaseAdapter;
  /** Reasoning model — used by the supervisor itself. */
  makeReasoningModel: () => Promise<Model>;
  /** Tool-calling model — used by every worker (literature, math, stat, sim, adversarial). */
  makeToolModel: () => Promise<Model>;
  /** Full tool map (BUILTIN_TOOLS spread). */
  toolMap: Record<string, Tool>;
  /** Optional policy resolver — when present, every tool call is gated + audited. */
  policyResolver?: ToolPolicyResolver;
  /** Optional audit emitter paired with the resolver. */
  auditEmitter?: ToolAuditEmitter;
}

/** Verdict labels emitted by the supervisor prompt. */
const VERDICT_MAP: Record<string, 'supported' | 'refuted' | 'inconclusive' | 'ill_posed' | 'out_of_scope'> = {
  SUPPORTED: 'supported',
  PARTIALLY_SUPPORTED: 'supported',
  CONTRADICTED: 'refuted',
  INSUFFICIENT_EVIDENCE: 'inconclusive',
  REQUIRES_REPLICATION: 'inconclusive',
};

/** Build a policy-enforced tool registry from a list of tool keys. */
function registryFromKeys(
  toolMap: Record<string, Tool>,
  keys: string[],
  opts: { policyResolver?: ToolPolicyResolver; auditEmitter?: ToolAuditEmitter; userId?: string; skillPolicyKey?: string },
): ToolRegistry {
  const registry = weaveToolRegistry();
  for (const k of keys) {
    const t = toolMap[k];
    if (t) registry.register(t);
  }
  if (opts.policyResolver) {
    return createPolicyEnforcedRegistry(registry, {
      resolver: opts.policyResolver,
      auditEmitter: opts.auditEmitter ?? noopAuditEmitter,
      resolutionContext: {
        skillPolicyKey: opts.skillPolicyKey ?? 'hypothesis_validation',
        userId: opts.userId,
      },
      // Resilience pipeline — SV tool calls participate in the same shared
      // endpoint state as chat tools (see RESILIENCE_PLAN Phase 3).
      resilience: { enabled: true, endpointPrefix: 'tool' },
    });
  }
  return registry;
}

/** Best-effort persist a worker turn (never throws). */
async function persistTurn(
  db: DatabaseAdapter,
  hypothesisId: string,
  fromAgent: string,
  message: string,
  opts: { roundIndex?: number; toAgent?: string; dissent?: boolean } = {},
): Promise<void> {
  try {
    await db.createAgentTurn({
      id: newUUIDv7(),
      hypothesis_id: hypothesisId,
      round_index: opts.roundIndex ?? 0,
      from_agent: fromAgent,
      to_agent: opts.toAgent ?? null,
      message,
      cites_evidence_ids: '[]',
      dissent: opts.dissent ? 1 : 0,
    });
  } catch {
    /* non-fatal — UI just won't see this turn */
  }
}

/** Best-effort persist an evidence event (never throws). */
async function persistEvidence(
  db: DatabaseAdapter,
  hypothesisId: string,
  agentId: string,
  kind: string,
  summary: string,
  opts: { toolKey?: string; stepId?: string } = {},
): Promise<void> {
  try {
    await db.createEvidenceEvent({
      id: newUUIDv7(),
      hypothesis_id: hypothesisId,
      step_id: opts.stepId ?? agentId,
      agent_id: agentId,
      evidence_id: newUUIDv7(),
      kind,
      summary: summary.slice(0, 500),
      source_type: opts.toolKey ? 'sandbox_tool_run' : 'model_inference',
      tool_key: opts.toolKey ?? null,
      reproducibility_hash: null,
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Bridge from the SV REST surface into chat.ts's supervisor mechanism.
 *
 * Each `startRun()` call:
 *  1. Loads SV worker rows from `worker_agents` (DB-driven).
 *  2. Builds a `weaveSupervisor` with those workers (same path chat.ts uses
 *     when delegating to general workers).
 *  3. Subscribes to AgentDelegation + ToolCallEnd events, persisting them to
 *     `hv_agent_turn` and `hv_evidence_event` so the live deliberation view
 *     keeps streaming.
 *  4. Parses the supervisor's final output for a JSON verdict block.
 */
export class SVChatBridge {
  private readonly db: DatabaseAdapter;
  private readonly makeReasoningModel: () => Promise<Model>;
  private readonly makeToolModel: () => Promise<Model>;
  private readonly toolMap: Record<string, Tool>;
  private readonly policyResolver?: ToolPolicyResolver;
  private readonly auditEmitter?: ToolAuditEmitter;

  constructor(opts: SVChatBridgeOptions) {
    this.db = opts.db;
    this.makeReasoningModel = opts.makeReasoningModel;
    this.makeToolModel = opts.makeToolModel;
    this.toolMap = opts.toolMap;
    this.policyResolver = opts.policyResolver;
    this.auditEmitter = opts.auditEmitter;
  }

  /** Async-launch a deliberation. Returns a synthetic run id immediately. */
  async startRun(input: SVRunInput): Promise<string> {
    const runId = newUUIDv7();
    await this.db.updateHypothesisStatus(input.hypothesisId, 'running', new Date().toISOString());
    // Fire-and-forget — caller already has the hypothesis row to poll.
    void this._executeDeliberation(input).catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[sv-bridge] deliberation failed for', input.hypothesisId, msg);
      // Always emit a final verdict (inconclusive) so status never stays 'running'.
      await this._emitInconclusiveVerdict(input, `Bridge error: ${msg.slice(0, 300)}`).catch(() => {});
    });
    return runId;
  }

  /** Cooperative cancel — flips status to 'abandoned'. */
  async cancelRun(hypothesisId: string): Promise<void> {
    await this.db.updateHypothesisStatus(hypothesisId, 'abandoned', new Date().toISOString());
  }

  // ─── Internal ─────────────────────────────────────────────

  private async _executeDeliberation(input: SVRunInput): Promise<void> {
    // 1. Load worker definitions from DB. We pull both 'general' workers (so the
    //    supervisor sees the same delegation pool chat.ts does) AND any workers
    //    tagged with the dedicated SV category (kept for ops visibility).
    const generalWorkers = await this.db.listEnabledWorkerAgents();
    const svWorkers = await this.db.listWorkerAgentsByCategory('hypothesis-validation');
    const allWorkers = dedupeById([...generalWorkers, ...svWorkers]);

    // 2. Build worker definitions for weaveSupervisor.
    const toolModel = await this.makeToolModel();
    const reasoningModel = await this.makeReasoningModel();
    const workerDefs = await Promise.all(
      allWorkers.map((row) => this._buildWorkerDef(row, toolModel, input)),
    );

    // 3. Optional decomposer — pre-seeds the sub_claims table from the prompt.
    await this._runDecomposer(input, reasoningModel).catch(() => {});

    // 4. Wire up the supervisor with an event bus that streams turns + evidence.
    const bus = weaveEventBus();
    const offDelegation = bus.on(EventTypes.AgentDelegation, (e: WeaveEvent) => {
      const worker = String(e.data['worker'] ?? 'unknown');
      const goal = String(e.data['goal'] ?? '');
      void persistTurn(this.db, input.hypothesisId, normalizeAgentName(worker), goal, {
        toAgent: 'supervisor',
      });
    });
    const offToolEnd = bus.on(EventTypes.ToolCallEnd, (e: WeaveEvent) => {
      const tool = String(e.data['tool'] ?? '');
      const result = String(e.data['result'] ?? '').slice(0, 500);
      // Skip the generic delegate tool — those are captured by AgentDelegation.
      if (!tool || tool === 'delegate_to_worker') return;
      void persistEvidence(this.db, input.hypothesisId, 'tool', 'tool_call', result, { toolKey: tool });
    });
    const offToolErr = bus.on(EventTypes.ToolCallError, (e: WeaveEvent) => {
      const tool = String(e.data['tool'] ?? '');
      const error = String(e.data['error'] ?? '').slice(0, 300);
      if (!tool) return;
      void persistEvidence(this.db, input.hypothesisId, 'tool', 'tool_error', `[${tool} failed] ${error}`, { toolKey: tool });
    });

    try {
      const supervisorPrompt = await this._loadSupervisorPrompt();
      const supervisor = weaveAgent({
        model: reasoningModel,
        workers: workerDefs,
        maxSteps: 12,
        name: 'sv-supervisor',
        systemPrompt: supervisorPrompt,
        bus,
      });
      const ctx: ExecutionContext = weaveContext({ tenantId: input.tenantId, userId: input.userId });
      const result = await supervisor.run(ctx, {
        messages: [
          {
            role: 'user',
            content: [
              `Validate the following hypothesis using the available specialist workers.`,
              `When done, emit a single JSON verdict block (no markdown fences) following the supervisor schema.`,
              ``,
              `Title: (none)`,
              `Statement: ${input.statement}`,
              `Domain tags: ${input.domainTags.join(', ') || '(none)'}`,
            ].join('\n'),
          },
        ],
        goal: `Validate hypothesis: ${input.statement}`,
      });

      const text = result.output ?? '';
      await persistTurn(this.db, input.hypothesisId, 'supervisor', text, { roundIndex: 2 });
      await this._parseAndPersistVerdict(input, text);
    } finally {
      offDelegation();
      offToolEnd();
      offToolErr();
    }
  }

  /** Build a `WorkerDefinition` (chat.ts pattern) from a DB worker row. */
  private async _buildWorkerDef(
    row: WorkerAgentRow,
    model: Model,
    input: SVRunInput,
  ): Promise<{ name: string; description: string; systemPrompt?: string; model: Model; tools?: ToolRegistry }> {
    let toolNames: string[] = [];
    try { toolNames = JSON.parse(row.tool_names) as string[]; } catch { /* keep empty */ }
    const tools = toolNames.length > 0
      ? registryFromKeys(this.toolMap, toolNames, {
          policyResolver: this.policyResolver,
          auditEmitter: this.auditEmitter,
          userId: input.userId,
        })
      : undefined;

    // Resolve the worker's system prompt: prefer the explicit row value; if
    // empty, fall back to the canonical sv.* prompt template stored in the
    // `prompts` table. This keeps prompt content single-sourced in DB without
    // duplicating templates onto every worker_agent row.
    let systemPrompt: string | undefined = row.system_prompt || undefined;
    if (!systemPrompt) {
      const shortName = row.name.startsWith('sv-') ? row.name.slice(3) : row.name;
      const promptKey = SV_PROMPT_KEY[shortName];
      if (promptKey) {
        try {
          const p = await this.db.getPromptByKey(promptKey);
          if (p?.template) systemPrompt = p.template;
        } catch { /* non-fatal */ }
      }
    }

    const displayName = (row.display_name?.trim() || row.name).trim();
    const jobProfile = (row.job_profile?.trim() || 'Worker Agent').trim();
    const description = [
      `Display Name: ${displayName}`,
      `Job Profile: ${jobProfile}`,
      row.description,
    ].filter(Boolean).join('\n');

    return {
      name: row.name,
      description,
      systemPrompt,
      model,
      tools,
    };
  }

  /** Resolve the supervisor's system prompt from the `prompts` table. */
  private async _loadSupervisorPrompt(): Promise<string | undefined> {
    try {
      const row = await this.db.getPromptByKey('sv.supervisor');
      return row?.template || undefined;
    } catch {
      return undefined;
    }
  }

  /** Best-effort decomposer pre-pass — populates `hv_sub_claim` rows. */
  private async _runDecomposer(input: SVRunInput, model: Model): Promise<void> {
    let prompt = '';
    try {
      const row = await this.db.getPromptByKey('sv.decomposer');
      prompt = row?.template ?? '';
    } catch { /* fall through */ }
    if (!prompt) return;

    // Use the model directly (no tools, single turn).
    const ctx = weaveContext({ tenantId: input.tenantId, userId: input.userId });
    const messages = [
      { role: 'system' as const, content: prompt },
      { role: 'user' as const, content: `Hypothesis: ${input.statement}\nDomain tags: ${input.domainTags.join(', ')}` },
    ];
    let text = '';
    try {
      const completion = await model.generate(ctx, { messages });
      text = completion.content ?? '';
    } catch { return; }
    await persistTurn(this.db, input.hypothesisId, 'decomposer', text);
    try {
      const parsed = JSON.parse(extractFinalJson(text) ?? text) as {
        subClaims?: Array<{ statement: string; claimType?: string; testabilityScore?: number }>;
      };
      for (const sc of parsed.subClaims ?? []) {
        await this.db.createSubClaim({
          id: newUUIDv7(),
          tenant_id: input.tenantId,
          hypothesis_id: input.hypothesisId,
          parent_sub_claim_id: null,
          claim_type: (sc.claimType ?? 'other') as SvClaimType,
          statement: sc.statement,
          testability_score: sc.testabilityScore ?? 0.5,
        });
      }
    } catch { /* non-fatal */ }
  }

  /** Parse the supervisor output for a verdict JSON object and persist. */
  private async _parseAndPersistVerdict(input: SVRunInput, text: string): Promise<void> {
    const json = extractFinalJson(text);
    let verdictJson: { verdict?: string; confidence?: number; summary?: string; reason?: string } = {};
    if (json) {
      try { verdictJson = JSON.parse(json); } catch { /* ignore */ }
    }
    if (verdictJson.verdict) {
      const mapped = VERDICT_MAP[verdictJson.verdict] ?? 'inconclusive';
      const conf = verdictJson.confidence ?? 0.5;
      await this.db.createVerdict({
        id: newUUIDv7(),
        tenant_id: input.tenantId,
        hypothesis_id: input.hypothesisId,
        verdict: mapped,
        confidence_lo: Math.max(0, conf - 0.1),
        confidence_hi: Math.min(1, conf + 0.1),
        key_evidence_ids: '[]',
        falsifiers: '[]',
        limitations: verdictJson.summary ?? '',
        contract_id: newUUIDv7(),
        replay_trace_id: newUUIDv7(),
        emitted_by: 'supervisor',
      });
      await this.db.updateHypothesisStatus(input.hypothesisId, 'verdict', new Date().toISOString());
      return;
    }
    await this._emitInconclusiveVerdict(input, verdictJson.reason ?? verdictJson.summary ?? 'Supervisor did not converge on a verdict.');
  }

  private async _emitInconclusiveVerdict(input: SVRunInput, limitations: string): Promise<void> {
    try {
      await this.db.createVerdict({
        id: newUUIDv7(),
        tenant_id: input.tenantId,
        hypothesis_id: input.hypothesisId,
        verdict: 'inconclusive',
        confidence_lo: 0.1,
        confidence_hi: 0.4,
        key_evidence_ids: '[]',
        falsifiers: '[]',
        limitations,
        contract_id: newUUIDv7(),
        replay_trace_id: newUUIDv7(),
        emitted_by: 'supervisor',
      });
    } catch { /* non-fatal */ }
    await this.db.updateHypothesisStatus(input.hypothesisId, 'verdict', new Date().toISOString()).catch(() => {});
  }
}

/** Find the trailing JSON object in a model output. Strips markdown fences. */
function extractFinalJson(text: string): string | null {
  let cursor = text.length;
  while (cursor > 0) {
    const open = text.lastIndexOf('{', cursor - 1);
    if (open < 0) return null;
    const tail = text.slice(open);
    const close = tail.lastIndexOf('}');
    if (close < 0) { cursor = open; continue; }
    const candidate = tail.slice(0, close + 1);
    try { JSON.parse(candidate); return candidate; } catch { cursor = open; }
  }
  return null;
}

/** Strip the conventional 'sv-' prefix so persisted turn rows match historical data. */
function normalizeAgentName(name: string): string {
  return name.replace(/^sv-/, '');
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
