/**
 * Example 79 — Kaggle Live-Agents Mesh end-to-end (Phase K5)
 *
 * NOTE (API drift): the bespoke `bootKaggleMesh` / `buildKaggleMeshTemplate`
 * helpers were removed. Runtime mesh provisioning now goes through the generic
 * `provisionMesh` from `@weaveintel/live-agents-runtime`, driven by a
 * `live_mesh_definitions` row keyed `'kaggle'` — which needs a real DB. The
 * kaggle barrel still re-exports the *domain* governance primitives (capability
 * matrix, bridge, bridge topics), so this example demonstrates the same
 * governance contract by provisioning a minimal mesh directly into an in-memory
 * StateStore:
 *
 *   1. Mesh + 6 role agents + a single Kaggle credentials account + 6
 *      capability-scoped bindings (one per role) + optional cross-mesh bridge.
 *   2. Inspect what was provisioned (agents, account, bindings, bridge).
 *   3. Verify dual-control list contains submit + kernel.push.
 *   4. Verify capability matrix per role (e.g. only submitter can submit).
 *   5. Revoke one binding (validator) and confirm immediate effect.
 *
 * No model calls, no real Kaggle API calls — this example demonstrates the
 * provisioning + governance contract that operators control via
 * /api/admin/kaggle-mesh-* admin routes in GeneWeave.
 */

import { weaveInMemoryStateStore } from '@weaveintel/live-agents';
import type { Account, AccountBinding, LiveAgent, Mesh } from '@weaveintel/live-agents';
import {
  buildKaggleBridge,
  bindingConstraintsFor,
  KAGGLE_CAPABILITY_MATRIX,
  KAGGLE_BRIDGE_TOPICS,
  type KaggleAgentRole,
} from '../apps/geneweave/src/live-agents/kaggle/index.js';

async function main(): Promise<void> {
  const store = weaveInMemoryStateStore();
  const tenantId = 'demo-tenant';
  const humanOwnerId = 'human:demo-owner';
  const now = new Date().toISOString();

  console.log('━━━ Phase K5: Kaggle Live-Agents Mesh ━━━\n');

  // ─── 1. Provision a minimal mesh ─────────────────────────────────
  // Dual-control is required for the highest-risk Kaggle tools.
  const dualControlRequiredFor = ['kaggle.competitions.submit', 'kaggle.kernels.push'];

  const mesh: Mesh = {
    id: 'mesh-kaggle-demo',
    tenantId,
    name: 'Kaggle Research Mesh',
    charter: 'Autonomous Kaggle competition research + submission pipeline.',
    status: 'ACTIVE',
    dualControlRequiredFor,
    createdAt: now,
  };
  await store.saveMesh(mesh);

  const roles = Object.keys(KAGGLE_CAPABILITY_MATRIX) as KaggleAgentRole[];

  // 6 role-bound agents.
  const agents: LiveAgent[] = roles.map((role) => ({
    id: `agent-${role}`,
    meshId: mesh.id,
    name: `Kaggle ${role}`,
    role,
    contractVersionId: `contract-${role}-v1`,
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  }));
  for (const agent of agents) await store.saveAgent(agent);

  // A single Kaggle credentials account for the whole mesh.
  const account: Account = {
    id: 'acct-kaggle-demo',
    meshId: mesh.id,
    provider: 'kaggle',
    accountIdentifier: 'demo-user',
    description: 'Kaggle API credentials for the research mesh.',
    mcpServerRef: { url: 'http://localhost:8788/mcp', serverType: 'HTTP', discoveryHint: null },
    credentialVaultRef: 'env:KAGGLE_KEY',
    upstreamScopesDescription: 'Kaggle competitions + kernels + datasets.',
    ownerHumanId: humanOwnerId,
    status: 'ACTIVE',
    createdAt: now,
    revokedAt: null,
  };
  await store.saveAccount(account);

  // Per-role capability-scoped bindings (only humans may bind accounts).
  const bindings: Record<string, AccountBinding> = {};
  for (const role of roles) {
    const binding: AccountBinding = {
      id: `binding-${role}`,
      agentId: `agent-${role}`,
      accountId: account.id,
      purpose: `Kaggle access for the ${role} role.`,
      constraints: bindingConstraintsFor(role),
      grantedByHumanId: humanOwnerId,
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      revokedByHumanId: null,
      revocationReason: null,
    };
    await store.saveAccountBinding(binding);
    bindings[role] = binding;
  }

  console.log(`✓ Mesh provisioned: ${mesh.id}`);
  console.log(`  • status: ${mesh.status}`);
  console.log(`  • dualControlRequiredFor: ${JSON.stringify(mesh.dualControlRequiredFor)}\n`);

  // ─── 2. Inspect agents + bindings ─────────────────────────────────
  const savedAgents = await store.listAgents(mesh.id);
  console.log(`✓ ${savedAgents.length} role-bound agents:`);
  for (const a of savedAgents) {
    console.log(`  • ${a.id}  (contract: ${a.contractVersionId})`);
  }
  console.log();

  // ─── 3. Inspect single Kaggle account + per-role bindings ─────────
  const accounts = await store.listAccounts(mesh.id);
  console.log(`✓ ${accounts.length} Kaggle account(s):`);
  for (const acc of accounts) {
    console.log(`  • ${acc.id} → ${acc.accountIdentifier}@${acc.provider} (vault: ${acc.credentialVaultRef})`);
  }
  console.log();

  // ─── 4. Verify capability matrix per role ─────────────────────────
  console.log('✓ Capability matrix (which role can call which Kaggle tool):');
  for (const role of roles) {
    const caps = KAGGLE_CAPABILITY_MATRIX[role];
    console.log(`  • ${role.padEnd(12)} → ${caps.length === 0 ? '(no Kaggle tools)' : caps.join(', ')}`);
  }
  console.log();

  // ─── 5. Build a cross-mesh bridge (Kaggle → user mesh) ────────────
  const bridge = buildKaggleBridge({
    fromMeshId: mesh.id,
    toMeshId: 'mesh-user-demo',
    authorisedByHumanId: humanOwnerId,
    nowIso: now,
  });
  console.log(`✓ Cross-mesh bridge: ${bridge.fromMeshId} → ${bridge.toMeshId}`);
  console.log(`  • allowedTopics: ${JSON.stringify(bridge.allowedTopics)}`);
  console.log(`  • rateLimitPerHour: ${bridge.rateLimitPerHour}`);
  console.log(`  • topics constant matches: ${JSON.stringify([...KAGGLE_BRIDGE_TOPICS]) === JSON.stringify(bridge.allowedTopics)}\n`);

  // ─── 6. Revoke validator binding (immediate effect) ───────────────
  const validatorBinding = bindings['validator']!;
  console.log(`✓ Revoking binding for validator (${validatorBinding.id})...`);
  const revoked = await store.revokeAccountBinding(
    validatorBinding.id,
    humanOwnerId,
    'Demo: rotating credentials',
    new Date().toISOString(),
  );
  if (revoked && revoked.revokedAt) {
    console.log(`  • revokedAt: ${revoked.revokedAt}`);
    console.log(`  • revocationReason: ${revoked.revocationReason}`);
    console.log(`  • next tick will see revoked binding → validator stops working.\n`);
  }

  console.log('━━━ Done. ━━━');
  console.log('In production: operators manage all of this via the GeneWeave admin');
  console.log('UI under Kaggle → Live Meshes / Live Agents / Account Bindings /');
  console.log('Cross-Mesh Bridges. Provision via POST /api/admin/kaggle-mesh-provision.');
}

main().catch((err) => {
  console.error('Example 79 failed:', err);
  process.exit(1);
});
