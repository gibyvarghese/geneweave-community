/**
 * Kaggle Competition Runner — per-run mesh + step-ledger orchestrator.
 *
 * Each run gets its own UUIDv7 mesh provisioned via the generic
 * `provisionMesh` from `@weaveintel/live-agents-runtime` (Phase C of the
 * kaggle DB-driven migration). The standard Kaggle pipeline (discoverer →
 * strategist → implementer → validator → submitter, with observer in
 * parallel) is seeded as ordered `kgl_run_step` rows so the UI can render a
 * readable flow timeline before any agent has actually executed.
 *
 * Real agent execution (agents reading the contracts, calling tools,
 * emitting evidence) flows through the existing chat surface and live-agents
 * heartbeat scheduler. As the runner's lifecycle hooks fire it appends rows
 * to `kgl_run_event`, which the SSE endpoint streams to the UI.
 */

import { newUUIDv7 } from '../../lib/uuid.js';
import type { DatabaseAdapter } from '../../db.js';
import { provisionMesh } from '@weaveintel/live-agents-runtime';
import { getKaggleLiveStore } from '../../live-agents/kaggle/store.js';

export interface KaggleRunInput {
  runId: string;
  tenantId: string;
  userId: string;
  competitionRef: string;
  title: string;
  objective: string;
}

interface PipelineStepSpec {
  role: string;
  title: string;
  description: string;
}

const KAGGLE_PIPELINE: ReadonlyArray<PipelineStepSpec> = [
  {
    role: 'discoverer',
    title: 'Discover & shortlist competitions',
    description: 'Scan Kaggle, score relevance vs operator brief, hand picks to the strategist.',
  },
  {
    role: 'strategist',
    title: 'Decompose approach',
    description: 'Choose model family, validation scheme, and deliverables. Approve approach for implementation.',
  },
  {
    role: 'implementer',
    title: 'Build & train kernels',
    description: 'Author notebook, run training inside the sandbox, capture artifacts.',
  },
  {
    role: 'validator',
    title: 'Validate kernel + submission',
    description: 'Re-run validation, confirm submission shape and rubric checks pass.',
  },
  {
    role: 'submitter',
    title: 'Submit to Kaggle',
    description: 'Push the validated submission via the Kaggle MCP and record the submission id.',
  },
  {
    role: 'observer',
    title: 'Watch leaderboard signal',
    description: 'Poll public leaderboard, surface CV↔LB delta to the strategist for the next iteration.',
  },
];

export class KaggleCompetitionRunner {
  constructor(private readonly db: DatabaseAdapter) {}

  async startRun(input: KaggleRunInput): Promise<void> {
    const { runId, tenantId, userId, competitionRef } = input;

    await this.db.updateKglCompetitionRun(runId, { status: 'running' });
    await this.appendEvent(runId, null, 'status_change', null, null, `Run started for ${competitionRef}.`);

    // Seed the canonical Kaggle pipeline as pending steps so the UI has a
    // structure to render immediately.
    const stepIds: string[] = [];
    let idx = 0;
    for (const spec of KAGGLE_PIPELINE) {
      const stepId = newUUIDv7();
      stepIds.push(stepId);
      await this.db.appendKglRunStep({
        id: stepId,
        run_id: runId,
        step_index: idx++,
        role: `kaggle_${spec.role}`,
        title: spec.title,
        description: spec.description,
        agent_id: null,
        status: 'pending',
        started_at: null,
        completed_at: null,
        summary: null,
        input_preview: null,
        output_preview: null,
      });
    }

    // Provision a fresh mesh for this run. Mesh id == `mesh-kaggle-<UUIDv7>`
    // so the live-agents store keeps every run's entities cleanly separated.
    let meshId: string | null = null;
    try {
      const store = await getKaggleLiveStore();
      const desiredMeshId = `mesh-kaggle-${newUUIDv7()}`;
      // Live-agents requires the principal id granting bindings to start with
      // `human:`, `user:`, or `admin:`. The auth.userId is a raw UUID, so
      // namespace it as a user principal here.
      const humanOwnerId = userId.startsWith('human:') || userId.startsWith('user:') || userId.startsWith('admin:')
        ? userId
        : `user:${userId}`;

      // Phase C — provision the per-run mesh from the DB blueprint
      // (`live_mesh_definitions` key 'kaggle' seeded by
      // `seedLiveMeshDefinitions`). The generic provisioner writes
      // `live_meshes` + `live_agents` + `live_agent_handler_bindings` +
      // `live_agent_tool_bindings` + the StateStore mirror (Mesh, Agents,
      // Contracts, DelegationEdges, Account, AccountBindings) in one call,
      // replacing the bespoke `bootKaggleMesh` + `mesh-template.ts` path.
      const result = await provisionMesh(
        this.db,
        {
          meshDefKey: 'kaggle',
          tenantId,
          ownerHumanId: humanOwnerId,
          name: desiredMeshId,
          status: 'ACTIVE',
          store,
          account: {
            provider: 'kaggle.com',
            accountIdentifier: process.env['KAGGLE_USERNAME'] ?? 'unknown',
            mcpServerUrl: process.env['KAGGLE_MCP_URL'] ?? 'http://localhost:7400',
            credentialVaultRef: 'env:KAGGLE_KEY',
            upstreamScopesDescription:
              'Kaggle REST API: list competitions/datasets/kernels, push kernels, submit to competitions. Counts against per-account 4/day submit cap.',
            description: `Kaggle credentials for ${process.env['KAGGLE_USERNAME'] ?? 'unknown'}`,
          },
          logger: (msg) => console.log('[kaggle-runner]', msg),
        },
        newUUIDv7,
      );
      meshId = result.meshId;
      await this.db.updateKglCompetitionRun(runId, { mesh_id: meshId });
      // Register the mesh in the admin index so the operator's
      // "Kaggle Live Meshes / Agents / Bindings / Bridges" tabs can list it.
      // Without this row, listKaggleLiveMeshes() returns nothing and the
      // admin pages render empty even after the StateStore has the entities.
      await this.db.upsertKaggleLiveMesh({
        mesh_id: meshId,
        tenant_id: tenantId,
        kaggle_username: process.env['KAGGLE_USERNAME'] ?? 'unknown',
      });
      await this.appendEvent(
        runId, null, 'mesh_provisioned', null, null,
        `Provisioned mesh ${meshId} with ${result.agentIds.length} agents and ${result.toolBindingIds.length} tool bindings.`,
        {
          meshId,
          agentIds: result.agentIds,
          handlerBindingIds: result.handlerBindingIds,
          toolBindingIds: result.toolBindingIds,
          accountId: result.accountId,
        },
      );

      // Seed the initial discoverer backlog item so the global Kaggle
      // heartbeat (`startKaggleHeartbeat` in index.ts) has work to claim
      // and starts ticking the pipeline. Without this, the discoverer's
      // attention policy would always return NoopRest and nothing would
      // run. Step status is intentionally left as 'pending' here — the
      // heartbeat's bridge transitions it to 'running' / 'completed' as
      // the agent actually executes.
      const meshAgents = await store.listAgents(meshId);
      const discovererAgent = meshAgents.find((a) => a.role === 'discoverer');
      if (!discovererAgent) {
        throw new Error(`provisioned mesh ${meshId} has no discoverer agent (blueprint missing role)`);
      }
      const seedNowIso = new Date().toISOString();
      await store.saveBacklogItem({
        id: `backlog-${discovererAgent.id}-initial-${Date.now()}`,
        agentId: discovererAgent.id,
        priority: 'NORMAL',
        status: 'PROPOSED',
        originType: 'SYSTEM',
        originRef: runId,
        blockedOnMessageId: null,
        blockedOnGrantRequestId: null,
        blockedOnPromotionRequestId: null,
        blockedOnAccountBindingRequestId: null,
        estimatedEffort: 'PT1H',
        deadline: null,
        acceptedAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: seedNowIso,
        title: input.title || `Discover competitions for ${input.competitionRef}`,
        description: `Operator brief: ${input.objective || '(none)'}\nPinned competition ref: ${input.competitionRef}.`,
      });
      await this.appendEvent(
        runId, stepIds[0] ?? null, 'backlog_seeded', discovererAgent.id, null,
        'Initial discoverer backlog item seeded; awaiting heartbeat.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendEvent(runId, null, 'mesh_provision_failed', null, null, `Mesh provisioning failed: ${message}`);
      await this.db.updateKglCompetitionRun(runId, {
        status: 'failed',
        summary: message,
        completed_at: new Date().toISOString(),
      });
    }
  }

  private async appendEvent(
    runId: string,
    stepId: string | null,
    kind: string,
    agentId: string | null,
    toolKey: string | null,
    summary: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.appendKglRunEvent({
      id: newUUIDv7(),
      run_id: runId,
      step_id: stepId,
      kind,
      agent_id: agentId,
      tool_key: toolKey,
      summary,
      payload_json: payload ? JSON.stringify(payload) : null,
    });
  }
}
