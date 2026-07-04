import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';
import { buildSupervisorAdditionalTools } from './chat.js';

function makeTempDbPath(): string {
  return `/tmp/geneweave-agents-test-${Date.now()}-${randomUUID()}.db`;
}

async function newSeededDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(makeTempDbPath());
  await db.initialize();
  await db.seedDefaultData();
  return db;
}

describe('Phase 1B — agents + agent_tools persistence', () => {
  it('seeds the global default supervisor row', async () => {
    const db = await newSeededDb();
    const list = await db.listSupervisorAgents({});
    const seeded = list.find((row) => row.id === 'agent-supervisor-default');
    expect(seeded, 'global default supervisor must be seeded').toBeDefined();
    expect(seeded?.is_default).toBe(1);
    expect(seeded?.tenant_id).toBeNull();
    expect(seeded?.include_utility_tools).toBe(1);
    await db.close();
  });

  it('CRUDs supervisor agents and replaces tool allocations atomically', async () => {
    const db = await newSeededDb();
    const id = `agent-${randomUUID()}`;
    await db.createSupervisorAgent(
      {
        id,
        tenant_id: null,
        category: 'analytics',
        name: 'analytics-supervisor',
        display_name: 'Analytics',
        description: 'analytics supervisor',
        system_prompt: null,
        default_timezone: 'UTC',
        include_utility_tools: 1,
        is_default: 0,
        enabled: 1,
      },
      [{ tool_name: 'datetime' }, { tool_name: 'math_eval' }],
    );

    expect((await db.getSupervisorAgent(id))?.name).toBe('analytics-supervisor');
    expect((await db.listAgentTools(id)).map((t) => t.tool_name).sort()).toEqual(['datetime', 'math_eval']);

    await db.setAgentTools(id, [
      { tool_name: 'datetime' },
      { tool_name: 'unit_convert' },
      { tool_name: 'plan' },
    ]);
    expect((await db.listAgentTools(id)).map((t) => t.tool_name).sort()).toEqual(['datetime', 'plan', 'unit_convert']);

    await db.updateSupervisorAgent(id, { description: 'updated' });
    expect((await db.getSupervisorAgent(id))?.description).toBe('updated');

    await db.deleteSupervisorAgent(id);
    expect(await db.getSupervisorAgent(id)).toBeNull();
    await db.close();
  });

  it('resolveSupervisorAgent honors precedence: skill pin → tenant+category → global+category → default', async () => {
    const db = await newSeededDb();

    const globalCatId = `agent-${randomUUID()}`;
    await db.createSupervisorAgent({
      id: globalCatId,
      tenant_id: null,
      category: 'analytics',
      name: 'global-analytics',
      display_name: null,
      description: null,
      system_prompt: null,
      default_timezone: null,
      include_utility_tools: 1,
      is_default: 0,
      enabled: 1,
    });

    const tenantId = 'tenant-acme';
    const tenantCatId = `agent-${randomUUID()}`;
    await db.createSupervisorAgent({
      id: tenantCatId,
      tenant_id: tenantId,
      category: 'analytics',
      name: 'acme-analytics',
      display_name: null,
      description: null,
      system_prompt: null,
      default_timezone: null,
      include_utility_tools: 1,
      is_default: 0,
      enabled: 1,
    });

    expect((await db.resolveSupervisorAgent({ tenantId, category: 'analytics' }))?.agent.id).toBe(tenantCatId);
    expect((await db.resolveSupervisorAgent({ tenantId: 'tenant-other', category: 'analytics' }))?.agent.id).toBe(globalCatId);
    expect((await db.resolveSupervisorAgent({ category: 'no-such-category' }))?.agent.id).toBe('agent-supervisor-default');

    const pinId = `agent-${randomUUID()}`;
    await db.createSupervisorAgent({
      id: pinId,
      tenant_id: null,
      category: 'pinned',
      name: 'pinned-supervisor',
      display_name: null,
      description: null,
      system_prompt: null,
      default_timezone: null,
      include_utility_tools: 0,
      is_default: 0,
      enabled: 1,
    });
    await db.createSkill({
      id: 'skill-pin-test',
      name: 'pin-test',
      description: 'pinned skill',
      category: 'analytics',
      trigger_patterns: '[]',
      instructions: 'do stuff',
      tool_names: null,
      examples: null,
      tags: null,
      priority: 10,
      version: '1.0.0',
      enabled: 1,
      tool_policy_key: 'default',
      supervisor_agent_id: pinId,
    });

    const r4 = await db.resolveSupervisorAgent({ tenantId, category: 'analytics', skillId: 'skill-pin-test' });
    expect(r4?.agent.id).toBe(pinId);
    expect(r4?.agent.include_utility_tools).toBe(0);
    await db.close();
  });

  it('disabled agents are skipped during resolution', async () => {
    const db = await newSeededDb();
    await db.createSupervisorAgent({
      id: `agent-${randomUUID()}`,
      tenant_id: null,
      category: 'ops',
      name: 'disabled-ops',
      display_name: null,
      description: null,
      system_prompt: null,
      default_timezone: null,
      include_utility_tools: 1,
      is_default: 0,
      enabled: 0,
    });
    const r = await db.resolveSupervisorAgent({ category: 'ops' });
    expect(r?.agent.id).toBe('agent-supervisor-default');
    await db.close();
  });
});

describe('Phase 2 — buildSupervisorAdditionalTools', () => {
  it('returns undefined when resolved is null', async () => {
    const reg = await buildSupervisorAdditionalTools(null, {});
    expect(reg).toBeUndefined();
  });

  it('returns undefined when resolved has no tools', async () => {
    const db = await newSeededDb();
    const resolved = await db.resolveSupervisorAgent({ category: 'no-such' });
    expect(resolved?.agent.id).toBe('agent-supervisor-default');
    expect(resolved?.tools).toEqual([]);
    const reg = await buildSupervisorAdditionalTools(resolved, {});
    expect(reg).toBeUndefined();
    await db.close();
  });

  it('builds a registry containing allocated builtin tools', async () => {
    const db = await newSeededDb();
    const id = `agent-${randomUUID()}`;
    await db.createSupervisorAgent(
      {
        id,
        tenant_id: null,
        category: 'utility-only',
        name: 'utility-sup',
        display_name: null,
        description: null,
        system_prompt: null,
        default_timezone: null,
        include_utility_tools: 1,
        is_default: 0,
        enabled: 1,
      },
      [
        { tool_name: 'datetime', allocation: 'default' },
        { tool_name: 'calculator', allocation: 'default' },
        { tool_name: 'web_search', allocation: 'forbidden' },
      ],
    );
    const resolved = await db.resolveSupervisorAgent({ category: 'utility-only' });
    expect(resolved?.tools.length).toBe(3);
    const reg = await buildSupervisorAdditionalTools(resolved, {});
    expect(reg).toBeDefined();
    const names = reg!.list().map((t) => t.schema.name).sort();
    // forbidden allocation must be excluded
    expect(names).not.toContain('web_search');
    expect(names).toContain('datetime');
    expect(names).toContain('calculator');
    await db.close();
  });
});
