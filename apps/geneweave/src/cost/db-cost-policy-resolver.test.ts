/**
 * Unit tests for DbCostPolicyResolver — focuses on the 5-step precedence
 * chain (agent → mesh → workflow → tenant → null) and validates that the
 * tenant fallback is reached when no narrower binding matches.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { SQLiteAdapter } from '../db-sqlite.js';
import { DbCostPolicyResolver } from './db-cost-policy-resolver.js';

function tmpDb(): string {
  return `/tmp/geneweave-cost-resolver-test-${Date.now()}-${randomUUID()}.db`;
}

const ECONOMY_POLICY_ID = '019700000-c057-7000-8000-000000000001';
const PERFORMANCE_POLICY_ID = '019700000-c057-7000-8000-000000000003';
const MAX_POLICY_ID = '019700000-c057-7000-8000-000000000004';

describe('DbCostPolicyResolver', () => {
  it('returns null when no bindings exist', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();
    const resolver = new DbCostPolicyResolver(db);
    const result = await resolver.resolve({ tenantId: 't1', meshId: 'm1', agentId: 'a1' });
    expect(result).toBeNull();
  });

  it('falls back to tenant binding when no narrower binding matches', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();

    const tenantId = 't-' + randomUUID();
    await db.createCapabilityPolicyBinding({
      id: randomUUID(),
      binding_kind: 'tenant',
      binding_ref: tenantId,
      policy_kind: 'cost_policy',
      policy_ref: ECONOMY_POLICY_ID,
      precedence: 5,
      enabled: 1,
    });

    const resolver = new DbCostPolicyResolver(db);
    const result = await resolver.resolve({
      tenantId,
      meshId: 'unbound-mesh',
      agentId: 'unbound-agent',
      workflowId: 'kaggle',
    });

    expect(result).not.toBeNull();
    expect(result!.source).toBe('tenant_default');
    expect(result!.policyId).toBe(ECONOMY_POLICY_ID);
    expect(result!.policy.tier).toBe('economy');
  });

  it('agent binding wins over mesh, workflow, and tenant', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();

    const tenantId = 't-' + randomUUID();
    const meshId = 'm-' + randomUUID();
    const agentId = 'a-' + randomUUID();

    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'tenant', binding_ref: tenantId,
      policy_kind: 'cost_policy', policy_ref: ECONOMY_POLICY_ID, precedence: 5, enabled: 1,
    });
    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'mesh', binding_ref: meshId,
      policy_kind: 'cost_policy', policy_ref: PERFORMANCE_POLICY_ID, precedence: 50, enabled: 1,
    });
    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'agent', binding_ref: agentId,
      policy_kind: 'cost_policy', policy_ref: MAX_POLICY_ID, precedence: 100, enabled: 1,
    });

    const resolver = new DbCostPolicyResolver(db);
    const result = await resolver.resolve({ tenantId, meshId, agentId });

    expect(result!.source).toBe('agent_binding');
    expect(result!.policyId).toBe(MAX_POLICY_ID);
    expect(result!.policy.tier).toBe('max');
  });

  it('mesh binding wins over workflow and tenant when no agent match', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();

    const tenantId = 't-' + randomUUID();
    const meshId = 'm-' + randomUUID();

    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'tenant', binding_ref: tenantId,
      policy_kind: 'cost_policy', policy_ref: ECONOMY_POLICY_ID, precedence: 5, enabled: 1,
    });
    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'workflow', binding_ref: 'kaggle',
      policy_kind: 'cost_policy', policy_ref: PERFORMANCE_POLICY_ID, precedence: 10, enabled: 1,
    });
    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'mesh', binding_ref: meshId,
      policy_kind: 'cost_policy', policy_ref: MAX_POLICY_ID, precedence: 50, enabled: 1,
    });

    const resolver = new DbCostPolicyResolver(db);
    const result = await resolver.resolve({ tenantId, meshId, workflowId: 'kaggle' });

    expect(result!.source).toBe('mesh_binding');
    expect(result!.policy.tier).toBe('max');
  });

  it('workflow binding wins over tenant when no agent/mesh match', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();

    const tenantId = 't-' + randomUUID();

    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'tenant', binding_ref: tenantId,
      policy_kind: 'cost_policy', policy_ref: ECONOMY_POLICY_ID, precedence: 5, enabled: 1,
    });
    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'workflow', binding_ref: 'kaggle',
      policy_kind: 'cost_policy', policy_ref: PERFORMANCE_POLICY_ID, precedence: 10, enabled: 1,
    });

    const resolver = new DbCostPolicyResolver(db);
    const result = await resolver.resolve({ tenantId, workflowId: 'kaggle' });

    expect(result!.source).toBe('workflow_binding');
    expect(result!.policy.tier).toBe('performance');
  });

  it('skips disabled tenant binding and returns null', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();

    const tenantId = 't-' + randomUUID();
    await db.createCapabilityPolicyBinding({
      id: randomUUID(), binding_kind: 'tenant', binding_ref: tenantId,
      policy_kind: 'cost_policy', policy_ref: ECONOMY_POLICY_ID, precedence: 5, enabled: 0,
    });

    const resolver = new DbCostPolicyResolver(db);
    const result = await resolver.resolve({ tenantId });
    expect(result).toBeNull();
  });

  it('returns null when ctx has no ids at all', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();
    const resolver = new DbCostPolicyResolver(db);
    expect(await resolver.resolve({})).toBeNull();
  });
});
