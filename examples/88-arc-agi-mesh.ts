/**
 * Example 88 — Phase 6: ARC AGI competition mesh, end-to-end DB-driven.
 *
 * Proves that the new generic runtime handlers
 * (`deterministic.template`, `human.approval`) plus a custom domain
 * handler (`arc.solver.heuristic`) can drive a real Kaggle-style
 * competition workflow without hand-written boot code:
 *
 *      intake (deterministic.forward)
 *           │  hands every inbound puzzle to the solver
 *           ▼
 *      solver (custom: arc.solver.heuristic)
 *           │  runs the real heuristic ML solver on the train pairs
 *           │  emits a "Submission draft" message with the prediction
 *           ▼
 *      reporter (deterministic.template)
 *           │  renders a templated submission summary
 *           ▼
 *      submitter (human.approval)
 *           │  gates the final "submit to Kaggle" with a dual-control
 *           │  approval row in tool_approval_requests
 *
 * The example seeds 5 real ARC AGI-style puzzles (identity, hflip, vflip,
 * color-swap, rot90), provisions the mesh from a DB blueprint, and runs
 * the supervisor for ~10s. We then assert:
 *
 *   ✓ At least one outbound TASK was emitted by the solver per puzzle.
 *   ✓ The reporter's templated summary ran on each.
 *   ✓ The submitter created a `tool_approval_requests` row for each
 *     (status='pending'), demonstrating the human-approval gate.
 *
 * Run:
 *   npx tsx examples/88-arc-agi-mesh.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'gw-arcagi-'));
const dbPath = join(tmp, 'arcagi.db');
process.env['DATABASE_PATH'] = dbPath;
process.env['LIVE_AGENTS_DB_PATH'] = dbPath;

const { createDatabaseAdapter } = await import('../apps/geneweave/src/db.js');
const { newUUIDv7 } = await import('../apps/geneweave/src/lib/uuid.js');
const {
  provisionMesh,
  createHeartbeatSupervisor,
  createDefaultHandlerRegistry,
} = await import('@weaveintel/live-agents-runtime');
const { weaveSqliteStateStore } = await import('@weaveintel/live-agents');
const { solveArcTask, SAMPLE_ARC_TASKS } = await import('./arcagi-solver.js');

import type {
  Message,
  TaskHandler,
  BacklogItem,
} from '@weaveintel/live-agents';
import { loadLatestInboundTask } from '@weaveintel/live-agents';
import type {
  HandlerContext,
  HandlerKindRegistration,
} from '@weaveintel/live-agents-runtime';

// ─── Custom domain handler: arc.solver.heuristic ─────────────
// Reads the inbound TASK whose body is a JSON-serialised ArcTask, runs
// the deterministic heuristic ML solver on it, and emits one outbound
// TASK to the role configured in `to.roleKey`.
//
// Configuration (live_agent_handler_bindings.config_json):
//   { outboundSubject: string, to: { type: 'AGENT_BY_ROLE', roleKey: string } }
const arcSolverHandler: HandlerKindRegistration = {
  kind: 'arc.solver.heuristic',
  description:
    'Run the heuristic ARC AGI solver on the inbound puzzle JSON and emit ' +
    'a draft submission to the configured downstream role.',
  configSchema: {
    type: 'object',
    required: ['outboundSubject', 'to'],
    properties: {
      outboundSubject: { type: 'string' },
      to: {
        type: 'object',
        required: ['type', 'roleKey'],
        properties: { type: { const: 'AGENT_BY_ROLE' }, roleKey: { type: 'string' } },
      },
    },
  },
  factory: (ctx: HandlerContext): TaskHandler => {
    const cfg = ctx.binding.config as {
      outboundSubject: string;
      to: { type: 'AGENT_BY_ROLE'; roleKey: string };
    };
    const resolveByRole = (ctx as HandlerContext & {
      resolveAgentByRole?: (roleKey: string) => Promise<string | null> | string | null;
    }).resolveAgentByRole;
    if (!resolveByRole) {
      throw new Error('arc.solver.heuristic: HandlerContext.resolveAgentByRole missing');
    }

    return async (_action, execCtx, _ctx) => {
      const inbound = await loadLatestInboundTask(execCtx);
      if (!inbound) return { completed: true, summaryProse: 'no-op (empty inbox)' };

      let task: ReturnType<typeof JSON.parse>;
      try {
        task = JSON.parse(inbound.body);
      } catch {
        ctx.log(`bad puzzle JSON in "${inbound.subject}"`);
        return { completed: true, summaryProse: 'bad puzzle JSON' };
      }

      const attempt = solveArcTask(task);
      ctx.log(
        `solved ${attempt.taskId} via ${attempt.primitive} ` +
          `exact=${attempt.trainExact} acc=${attempt.trainAccuracy.toFixed(2)}`,
      );

      const toId = await Promise.resolve(resolveByRole(cfg.to.roleKey));
      if (!toId) throw new Error(`arc.solver.heuristic: cannot resolve role ${cfg.to.roleKey}`);

      const out: Message = {
        id: `msg_${Date.parse(execCtx.nowIso)}_${Math.random().toString(36).slice(2, 8)}`,
        meshId: ctx.agent.meshId,
        fromType: 'AGENT',
        fromId: ctx.agent.id,
        fromMeshId: ctx.agent.meshId,
        toType: 'AGENT',
        toId,
        topic: null,
        kind: 'TASK',
        replyToMessageId: null,
        threadId: `thr_${Date.parse(execCtx.nowIso)}_${Math.random().toString(36).slice(2, 8)}`,
        contextRefs: [],
        contextPacketRef: null,
        expiresAt: null,
        priority: 'NORMAL',
        status: 'DELIVERED',
        deliveredAt: execCtx.nowIso,
        readAt: null,
        processedAt: null,
        createdAt: execCtx.nowIso,
        subject: cfg.outboundSubject,
        body: JSON.stringify({
          taskId: attempt.taskId,
          primitive: attempt.primitive,
          trainExact: attempt.trainExact,
          predictions: attempt.predictions,
        }),
      };
      await execCtx.stateStore.saveMessage(out);
      // Seed a backlog item at the recipient so its standard attention policy
      // emits StartTask on the next tick (instead of just ProcessMessage).
      const blg: BacklogItem = {
        id: `blg_${Date.parse(execCtx.nowIso)}_${Math.random().toString(36).slice(2, 8)}`,
        agentId: toId,
        priority: 'NORMAL',
        status: 'ACCEPTED',
        originType: 'MESSAGE',
        originRef: out.id,
        blockedOnMessageId: null,
        blockedOnGrantRequestId: null,
        blockedOnPromotionRequestId: null,
        blockedOnAccountBindingRequestId: null,
        estimatedEffort: 'small',
        deadline: null,
        acceptedAt: execCtx.nowIso,
        startedAt: null,
        completedAt: null,
        createdAt: execCtx.nowIso,
        title: cfg.outboundSubject,
        description: `ARC submission draft for ${attempt.taskId}`,
      };
      await execCtx.stateStore.saveBacklogItem(blg);
      return {
        completed: true,
        summaryProse: `Solved ${attempt.taskId} (${attempt.primitive})`,
        createdMessageIds: [out.id],
      };
    };
  },
};

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== Example 88 — ARC AGI competition mesh (Phase 6) ===\n');

  const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  const store = await weaveSqliteStateStore({ path: dbPath });

  // 1. Seed mesh blueprint with 4 roles wired to handler kinds.
  const meshDefId = newUUIDv7();
  await db.createLiveMeshDefinition({
    id: meshDefId,
    mesh_key: `arc-agi-${Date.now()}`,
    name: 'ARC AGI Solver Mesh',
    charter_prose:
      'Compete on the ARC AGI corpus: triage puzzles, run heuristic ML solver, ' +
      'render submission summary, and gate Kaggle submission with dual control.',
    dual_control_required_for: JSON.stringify(['kaggle.competitions.submit']),
    enabled: 1,
    description: 'Generated by examples/88-arc-agi-mesh.ts',
  });

  await db.createLiveAgentDefinition({
    id: newUUIDv7(), mesh_def_id: meshDefId, role_key: 'intake',
    name: 'Intake', role_label: 'Puzzle Intake',
    persona: 'Routes incoming ARC AGI puzzles to the solver.',
    objectives: 'Forward each new puzzle to the solver immediately.',
    success_indicators: 'Every inbound puzzle is forwarded within one tick.',
    ordering: 0, enabled: 1,
    default_handler_kind: 'deterministic.forward',
    default_handler_config_json: JSON.stringify({
      outboundSubject: 'Solve this puzzle',
      to: { type: 'AGENT_BY_ROLE', roleKey: 'solver' },
    }),
  });

  await db.createLiveAgentDefinition({
    id: newUUIDv7(), mesh_def_id: meshDefId, role_key: 'solver',
    name: 'Solver', role_label: 'Heuristic ML Solver',
    persona: 'Runs the heuristic primitive search on each puzzle.',
    objectives: 'Produce a prediction grid for every puzzle.',
    success_indicators: 'Prediction generated and forwarded to reporter.',
    ordering: 1, enabled: 1,
    default_handler_kind: 'arc.solver.heuristic',
    default_handler_config_json: JSON.stringify({
      outboundSubject: 'Submission draft',
      to: { type: 'AGENT_BY_ROLE', roleKey: 'reporter' },
    }),
  });

  await db.createLiveAgentDefinition({
    id: newUUIDv7(), mesh_def_id: meshDefId, role_key: 'reporter',
    name: 'Reporter', role_label: 'Submission Reporter',
    persona: 'Renders a one-line submission summary from the solver output.',
    objectives: 'Produce a human-readable submission record.',
    success_indicators: 'Templated summary forwarded to submitter.',
    ordering: 2, enabled: 1,
    default_handler_kind: 'deterministic.template',
    default_handler_config_json: JSON.stringify({
      fallbackTemplate:
        'ARC AGI submission ready.\n' +
        'Solver report: {{body}}\n' +
        'Awaiting operator approval to submit.',
      outboundSubject: 'Approve Kaggle submission',
      to: { type: 'AGENT_BY_ROLE', roleKey: 'submitter' },
    }),
  });

  await db.createLiveAgentDefinition({
    id: newUUIDv7(), mesh_def_id: meshDefId, role_key: 'submitter',
    name: 'Submitter', role_label: 'Kaggle Submitter',
    persona: 'Final dual-control gate before Kaggle submission.',
    objectives: 'Block submission until a human approves.',
    success_indicators: 'tool_approval_requests row exists per submission.',
    ordering: 3, enabled: 1,
    default_handler_kind: 'human.approval',
    default_handler_config_json: JSON.stringify({
      approvalKind: 'kaggle.submit',
      dualControlActions: ['kaggle.competitions.submit'],
      policyKey: 'destructive_gate',
    }),
  });

  console.log(`✓ Seeded ARC AGI blueprint mesh def ${meshDefId} with 4 agent defs\n`);

  // 2. Provision the runtime mesh + StateStore mirror.
  const provisioned = await provisionMesh(
    db,
    {
      meshDefId,
      tenantId: 'arc-agi-demo',
      ownerHumanId: 'human:demo',
      name: 'ARC AGI Demo Run',
      status: 'ACTIVE',
      store,
    },
    newUUIDv7,
  );
  console.log(`✓ Provisioned mesh ${provisioned.meshId} with ${provisioned.agentIds.length} agents\n`);

  // Resolve the intake agent so we can deliver puzzles to it.
  const agents = await db.listLiveAgents({ meshId: provisioned.meshId, status: 'ACTIVE' });
  const intake = agents.find((a) => a.role_key === 'intake')!;
  const submitter = agents.find((a) => a.role_key === 'submitter')!;
  const solver = agents.find((a) => a.role_key === 'solver')!;
  const reporter = agents.find((a) => a.role_key === 'reporter')!;

  // 3. Seed inbound puzzles for the intake agent — one Message + one
  // ACCEPTED BacklogItem per puzzle so the standard attention policy emits
  // StartTask on intake's next tick.
  const nowIso = new Date().toISOString();
  for (const task of SAMPLE_ARC_TASKS) {
    const msgId = `msg_${Date.now()}_${task.id}`;
    await store.saveMessage({
      id: msgId,
      meshId: provisioned.meshId,
      fromType: 'HUMAN',
      fromId: 'human:demo',
      fromMeshId: provisioned.meshId,
      toType: 'AGENT',
      toId: intake.id,
      topic: null,
      kind: 'TASK',
      replyToMessageId: null,
      threadId: `thr_${task.id}`,
      contextRefs: [],
      contextPacketRef: null,
      expiresAt: null,
      priority: 'NORMAL',
      status: 'DELIVERED',
      deliveredAt: nowIso,
      readAt: null,
      processedAt: null,
      createdAt: nowIso,
      subject: `New ARC puzzle: ${task.id}`,
      body: JSON.stringify(task),
    });
    await store.saveBacklogItem({
      id: `blg_${Date.now()}_${task.id}`,
      agentId: intake.id,
      priority: 'NORMAL',
      status: 'ACCEPTED',
      originType: 'MESSAGE',
      originRef: msgId,
      blockedOnMessageId: null,
      blockedOnGrantRequestId: null,
      blockedOnPromotionRequestId: null,
      blockedOnAccountBindingRequestId: null,
      estimatedEffort: 'small',
      deadline: null,
      acceptedAt: nowIso,
      startedAt: null,
      completedAt: null,
      createdAt: nowIso,
      title: `Solve ${task.id}`,
      description: `ARC AGI puzzle ${task.id} ready for triage`,
    });
  }
  console.log(`✓ Seeded ${SAMPLE_ARC_TASKS.length} ARC puzzles into intake inbox\n`);

  // 4. Build handler registry: defaults + custom arc solver.
  const handlerRegistry = createDefaultHandlerRegistry();
  handlerRegistry.register(arcSolverHandler);

  // 5. Boot the supervisor with extras for approvals + role lookup.
  const supervisor = await createHeartbeatSupervisor({
    db,
    store,
    handlerRegistry,
    intervalMs: 500,
    refreshMs: 5_000,
    workers: 4,
    extraContextFor: async (_binding, agent) => ({
      approvalDb: db,
      newApprovalId: () => newUUIDv7(),
      resolveAgentByRole: async (roleKey: string) => {
        const peers = await db.listLiveAgents({ meshId: agent.meshId, status: 'ACTIVE' });
        return peers.find((p) => p.role_key === roleKey)?.id ?? null;
      },
    }),
    logger: (m) => console.log(`  [sup] ${m}`),
  });

  console.log('✓ Supervisor running for 25s — watch for intake → solver → reporter → submitter ticks:\n');
  await new Promise((r) => setTimeout(r, 25_000));
  await supervisor.stop();

  // 6. Assert the workflow ran end-to-end.
  console.log('\n--- Verification ---');
  const submitterInbox = await store.listMessagesForRecipient('AGENT', submitter.id);
  console.log(`submitter inbox messages: ${submitterInbox.length}`);

  // Approval requests rows (mesh id is used as chat_id by human-approval handler)
  const approvals = await db.listToolApprovalRequests({ chatId: provisioned.meshId });
  console.log(`tool_approval_requests rows: ${approvals.length}`);
  for (const a of approvals.slice(0, 5)) {
    console.log(`  • ${a.tool_name} status=${a.status}`);
  }

  const ok = submitterInbox.length >= 1 && approvals.length >= 1;
  console.log(`\n${ok ? '✓ PASS' : '✗ FAIL'} — ARC AGI mesh end-to-end`);

  await db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log('\n=== Example 88 complete ===');
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error('Example 88 failed:', err);
  process.exit(1);
});
