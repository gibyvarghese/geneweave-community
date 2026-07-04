/**
 * @weaveintel/geneweave — Identity + persona auth tests
 */

import { describe, expect, it } from 'vitest';
import { canUseTool, normalizePersona, personaPermissions } from './rbac.js';
import { createToolRegistry } from './tools.js';
import { settingsFromRow } from './chat.js';
import type { ChatSettingsRow } from './db.js';

describe('GeneWeave identity/persona auth for agents + tools', () => {
  it('default denies tool use when persona is missing or invalid', () => {
    expect(canUseTool(undefined, 'web_search')).toBe(false);
    expect(canUseTool(null, 'calculator')).toBe(false);
    expect(canUseTool('not_a_real_persona', 'web_search')).toBe(false);
    expect(personaPermissions('not_a_real_persona')).toEqual([]);
  });

  it('allows and denies tools correctly for valid personas', () => {
    expect(canUseTool('tenant_user', 'web_search')).toBe(true);
    expect(canUseTool('tenant_user', 'browser_open')).toBe(false);

    expect(canUseTool('agent_researcher', 'browser_open')).toBe(true);
    expect(canUseTool('tenant_admin', 'browser_open')).toBe(true);
  });

  it('creates an empty registry when actor persona is missing/invalid', async () => {
    const noPersona = await createToolRegistry(['web_search', 'calculator'], undefined, { actorPersona: undefined });
    expect(noPersona.list().length).toBe(0);

    const invalidPersona = await createToolRegistry(['web_search', 'calculator'], undefined, { actorPersona: 'bad_persona' });
    expect(invalidPersona.list().length).toBe(0);
  });

  it('attaches the right tool access when actor persona is valid', async () => {
    const tenantUserRegistry = await createToolRegistry(
      ['web_search', 'browser_open', 'calculator'],
      undefined,
      { actorPersona: 'tenant_user' },
    );
    const tenantUserNames = tenantUserRegistry.list().map((t) => t.schema.name);

    expect(tenantUserNames).toContain('web_search');
    expect(tenantUserNames).toContain('calculator');
    expect(tenantUserNames).not.toContain('browser_open');

    const researcherRegistry = await createToolRegistry(
      ['web_search', 'browser_open', 'calculator'],
      undefined,
      { actorPersona: 'agent_researcher' },
    );
    const researcherNames = researcherRegistry.list().map((t) => t.schema.name);
    expect(researcherNames).toContain('web_search');
    expect(researcherNames).toContain('calculator');
    expect(researcherNames.length).toBeGreaterThanOrEqual(2);
  });

  it('normalizes worker personas and keeps agent identity usable', async () => {
    const row: ChatSettingsRow = {
      chat_id: 'chat-1',
      mode: 'supervisor',
      system_prompt: null,
      timezone: null,
      reasoning_enabled: 0,
      reasoning_effort: null,
      reasoning_budget_tokens: 0,
      enabled_tools: JSON.stringify(['web_search', 'browser_open']),
      redaction_enabled: 0,
      redaction_patterns: null,
      workers: JSON.stringify([
        { name: 'r1', description: 'Research worker', tools: ['web_search', 'browser_open'], persona: 'bad_persona' },
      ]),
      updated_at: new Date().toISOString(),
      reflect_enabled: 0,
      reflect_max_revisions: 1,
      reflect_criteria: null,
      verify_enabled: 0,
      verify_min_score: 0.7,
      verify_max_attempts: 1,
      supervisor_replan_on_failure: 0,
      supervisor_parallel_delegation: 0,
      ensemble_agents: null,
      ensemble_resolver: null,
      // P2 columns (m63)
      parallel_tool_calls: 1,
      context_strategy: null,
      context_max_tokens: null,
      context_window_size: 20,
      tool_retry_max_attempts: 0,
      tool_retry_backoff_ms: 200,
      tool_retry_max_backoff_ms: 10000,
      // P3 columns (m64)
      hitl_enabled: 0,
      hitl_require_all: 0,
      hitl_timeout_ms: 300000,
      handoffs_enabled: 0,
      // P4 columns (m65)
      graph_enabled: 0,
      graph_max_nodes: 500,
      graph_persist_enabled: 1,
      memory_context_enabled: 0,
      memory_context_max_chars: 4000,
      // P5 columns (m66)
      checkpoint_enabled: 0,
      checkpoint_interval_steps: 1,
      dynamic_workers_enabled: 0,
      max_dynamic_workers: 20,
      // P6 columns (m67)
      eval_pipeline_enabled: 0,
      eval_pipeline_stages: null,
      eval_pipeline_fail_fast: 1,
      cost_governor_enabled: 0,
      cost_governor_policy: null,
      compliance_enabled: 0,
      compliance_subject_id_field: null,
      compliance_enforce_consent: 1,
      vision_loop_enabled: 0,
    };

    const settings = settingsFromRow(row);
    expect(settings.workers[0]?.persona).toBe('agent_worker');

    const workerPersona = normalizePersona(settings.workers[0]?.persona, 'agent');
    const workerRegistry = await createToolRegistry(settings.workers[0]?.tools ?? [], undefined, {
      actorPersona: workerPersona,
    });
    const workerTools = workerRegistry.list().map((t) => t.schema.name);

    // agent_worker can still use normal tools even when incoming persona was invalid
    expect(workerTools).toContain('web_search');
    // but not browser automation tools by default
    expect(workerTools).not.toContain('browser_open');
  });
});
