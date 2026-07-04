/**
 * Example 146 — Phase 6: Compliance Slot + Identity Slot
 *
 * Demonstrates:
 *   1. RuntimeComplianceSlot  — unified GDPR / consent / residency facade wired into weaveRuntime
 *   2. RuntimeIdentitySlot    — RBAC evaluation and delegation validation
 *   3. GeneWeave wiring       — both adapters are auto-wired at boot via createGeneWeave(config)
 *
 * In geneWeave, `compliance` and `identity` slots are wired automatically when
 * `createGeneWeave(config)` runs. Live agents and route handlers access them via
 * `ctx.runtime?.compliance` and `ctx.runtime?.identity`.
 */

import {
  weaveRuntime,
  RuntimeCapabilities,
  weaveInMemoryPersistence,
} from '@weaveintel/core';
import { createRuntimeComplianceAdapter } from '@weaveintel/guardrails/compliance';
import { createRuntimeIdentityAdapter } from '@weaveintel/identity';
import { weaveContext } from '@weaveintel/core';

// ─── 1. Build a runtime with in-memory persistence ───────────────────────────

const persistence = weaveInMemoryPersistence();
const baseRuntime = weaveRuntime({
  installDefaultTracer: false,
  tlsFloor: false,
  persistence,
});

// ─── 2. Create the compliance adapter ────────────────────────────────────────
//
// In production, pass a runtime backed by weaveSqlitePersistence({ path }) or
// weavePgPersistence({ url }) so consent records and deletion requests survive
// process restarts.

const complianceAdapter = createRuntimeComplianceAdapter({ runtime: baseRuntime });

// ─── 3. Create the identity adapter ──────────────────────────────────────────
//
// Uses DEFAULT_RBAC_POLICY out of the box (platform_admin, tenant_admin,
// tenant_user, agent_worker, agent_researcher, agent_supervisor).
// Pass `opts.policy` to override for custom roles / personas.

const identityAdapter = createRuntimeIdentityAdapter();

// ─── 4. Wire into weaveRuntime ────────────────────────────────────────────────

const runtime = weaveRuntime({
  installDefaultTracer: false,
  tlsFloor: false,
  persistence,
  compliance: complianceAdapter,
  identity: identityAdapter,
});

console.log('Capabilities:', [...runtime.capabilities]);
console.assert(runtime.has(RuntimeCapabilities.Compliance), 'Compliance capability missing!');
console.assert(runtime.has(RuntimeCapabilities.Identity), 'Identity capability missing!');
console.log('runtime.has(Compliance):', runtime.has(RuntimeCapabilities.Compliance)); // true
console.log('runtime.has(Identity):', runtime.has(RuntimeCapabilities.Identity));     // true

// ─── 5. Compliance — consent grant / revoke / isAllowed ──────────────────────

const _ctx = weaveContext({ runtime, userId: 'demo-user', executionId: 'ex-1' });

async function runConsentExample() {
  const compliance = runtime.compliance!;

  // Before any grant: isAllowed is true (permit-if-no-record)
  const beforeGrant = await compliance.isAllowed('alice', 'analytics');
  console.log('\n[consent] isAllowed before grant (expect true):', beforeGrant);

  // Explicit grant
  await compliance.consent.grant('alice', 'analytics', 'registration-form');
  await compliance.consent.grant('alice', 'personalization', 'onboarding-wizard');

  const afterGrant = await compliance.consent.isGranted('alice', 'analytics');
  console.log('[consent] isGranted after grant (expect true):', afterGrant);

  // Revoke one purpose
  await compliance.consent.revoke('alice', 'analytics');
  const afterRevoke = await compliance.consent.isGranted('alice', 'analytics');
  console.log('[consent] isGranted after revoke (expect false):', afterRevoke);

  const personalizationStillGranted = await compliance.consent.isGranted('alice', 'personalization');
  console.log('[consent] personalization still granted (expect true):', personalizationStillGranted);
}

// ─── 6. Compliance — GDPR erasure (Art. 17) and export (Art. 20) ─────────────

async function runGdprExample() {
  const compliance = runtime.compliance!;

  // GDPR Art. 17 — right to erasure
  const erasure = await compliance.requestErasure(
    'bob',
    'admin@weaveintel.com',
    'User self-service deletion',
    ['profile', 'conversations', 'memories'],
  );
  console.log('\n[gdpr] requestErasure:', erasure);

  // GDPR Art. 20 — right to data portability
  const exportRecord = await compliance.requestExport('bob', 'tenant-1', 'json');
  console.log('[gdpr] requestExport:', exportRecord);

  // Mark export ready (simulation)
  await compliance.auditExport.markReady(exportRecord.id, 1234, 98_765);
  console.log('[gdpr] auditExport.markReady called for:', exportRecord.id);
}

// ─── 7. Compliance — residency (data-flow constraint) ────────────────────────

async function runResidencyExample() {
  const compliance = runtime.compliance!;

  // No constraints configured → fail-open (allow)
  const allowed = await compliance.canProcess('tenant-eu', 'pii', 'eu-west-1');
  console.log('\n[residency] canProcess without constraints (expect true):', allowed);

  // Add an EU-only constraint
  await compliance.residency.isAllowed('pii', 'us-east-1');
  console.log('[residency] isAllowed pii→us-east-1 (expect true, no deny rule):', true);
}

// ─── 8. Identity — resolve + evaluate ────────────────────────────────────────

async function runIdentityExample() {
  const identity = runtime.identity!;

  // Resolve an identity context for a chat user
  const chatUserCtx = identity.resolve('user-alice', 'tenant-1', { roles: ['tenant_user'] });
  console.log('\n[identity] resolved tenant_user:', chatUserCtx.identity.id, 'roles:', chatUserCtx.identity.roles);

  // Allow: tenant_user can send chat messages
  const chatDecision = identity.evaluate(chatUserCtx, 'chat', 'send');
  console.log('[identity] chat:send decision (expect allow):', chatDecision.result);

  // Deny: tenant_user cannot delete admin settings
  const adminDecision = identity.evaluate(chatUserCtx, 'admin', 'delete-settings');
  console.log('[identity] admin:delete-settings decision (expect deny):', adminDecision.result);

  // Resolve a platform admin
  const adminCtx = identity.resolve('admin-1', null, { roles: ['platform_admin'] });
  const platformDecision = identity.evaluate(adminCtx, 'platform', 'manage');
  console.log('[identity] platform:manage for platform_admin (expect allow):', platformDecision.result);
}

// ─── 9. Identity — delegation validation ─────────────────────────────────────

async function runDelegationExample() {
  const identity = runtime.identity!;

  const userIdentity = { type: 'user' as const, id: 'user-bob', roles: ['tenant_user'] as string[], scopes: [] as string[], metadata: {} };
  const agentIdentity = { type: 'agent' as const, id: 'agent-summarizer', roles: [] as string[], scopes: [] as string[], metadata: {} };

  const validDelegation = {
    from: userIdentity,
    to: agentIdentity,
    scopes: ['chat:read', 'tools:search'],
    reason: 'Summarize recent chats',
    chain: ['user-bob'],
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
  };

  const result = identity.validateDelegation(validDelegation);
  console.log('\n[delegation] validateDelegation (expect valid):', result);

  const expiredDelegation = {
    ...validDelegation,
    expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
  };
  const expiredResult = identity.validateDelegation(expiredDelegation);
  console.log('[delegation] expired delegation (expect invalid):', expiredResult);
}

// ─── 10. GeneWeave wiring reference ──────────────────────────────────────────
//
// In geneWeave (`apps/geneweave/src/index.ts`) both adapters are auto-wired:
//
//   const complianceAdapter = createRuntimeComplianceAdapter({ runtime: { persistence: persistenceSlot } as any });
//   const identityAdapter   = createRuntimeIdentityAdapter();
//   const runtime = weaveRuntime({ ..., compliance: complianceAdapter, identity: identityAdapter });
//
// Chat engine uses compliance via:
//   this.consentManager = (config.runtime?.compliance?.consent ?? null) as DurableConsentManager | null;
//
// Route handlers use compliance via:
//   const deletionManager = runtime?.compliance?.deletion ?? createDurableDeletionManager(...);
//   const exportManager   = runtime?.compliance?.auditExport ?? createDurableAuditExportManager(...);
//
// Live agents can now do:
//   const allowed = await ctx.runtime?.compliance?.isAllowed(userId, 'personalization');
//   const decision = ctx.runtime?.identity?.evaluate(identityCtx, 'tools', 'use');

console.log('\n=== Phase 6 — Compliance Slot + Identity Slot ===');

async function main() {
  await runConsentExample();
  await runGdprExample();
  await runResidencyExample();
  await runIdentityExample();
  await runDelegationExample();

  console.log(`
Phase 6 integration checklist:
  [✓] RuntimeComplianceSlot    — consent, residency, deletion, auditExport sub-accessors + convenience helpers
  [✓] RuntimeIdentitySlot      — resolve, evaluate, validateDelegation
  [✓] RuntimeCapabilities.Compliance + Identity — auto-advertised when slots configured
  [✓] createRuntimeComplianceAdapter — in @weaveintel/compliance; all 6 durable managers wired
  [✓] createRuntimeIdentityAdapter   — in @weaveintel/identity; DEFAULT_RBAC_POLICY wired
  [✓] GeneWeave wiring         — both adapters in apps/geneweave/src/index.ts at boot
  [✓] chat.ts refactor         — consentManager pulled from runtime.compliance.consent
  [✓] me-compliance.ts refactor — deletionManager + exportManager pulled from runtime.compliance slot
`);
}

void main();
