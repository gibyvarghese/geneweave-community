import type { AdminTabDef } from '@weaveintel/core';

/**
 * Phase M22 — Live-Agents Runtime admin tabs.
 *
 * The four "what's actually live" tables (provisioned meshes, agents,
 * handler bindings, tool bindings), plus the runtime registries (handler
 * kinds, attention policies) and the per-mesh runs ledger (runs, steps,
 * events). Together with M21 these tabs make the live-agents framework
 * fully DB-driven.
 *
 * Read-only tabs (handler kinds, run steps, run events) hide the
 * Create/Edit/Delete UI but leave the GET/POST API untouched.
 */
export const LIVE_RUNTIME_ADMIN_TABS: Record<string, AdminTabDef> = {
  // ── Provisioned meshes & agents ────────────────────────────
  'live-meshes': {
    singular: 'Live Mesh',
    apiPath: 'admin/live-meshes',
    listKey: 'live-meshes',
    cols: ['name', 'mesh_def_id', 'tenant_id', 'status', 'updated_at'],
    fields: [
      { key: 'mesh_def_id', label: 'Mesh Definition ID (FK live_mesh_definitions.id)' },
      { key: 'tenant_id', label: 'Tenant ID (optional, scopes to one tenant)' },
      { key: 'name', label: 'Display Name' },
      {
        key: 'status',
        label: 'Status',
        options: ['ACTIVE', 'PAUSED', 'ARCHIVED'],
        default: 'ACTIVE',
      },
      { key: 'domain', label: 'Domain (optional, e.g. kaggle)' },
      {
        key: 'dual_control_required_for',
        label: 'Dual-Control Tools (JSON array of tool keys)',
        textarea: true,
        default: '[]',
      },
      { key: 'owner_human_id', label: 'Owner Human ID (optional)' },
      { key: 'mcp_server_ref', label: 'MCP Server Ref (optional)' },
      { key: 'account_id', label: 'Account Binding ID (optional)' },
      {
        key: 'context_json',
        label: 'Runtime Context (JSON)',
        textarea: true,
        default: '{}',
      },
    ],
  },
  'live-agents': {
    singular: 'Live Agent',
    apiPath: 'admin/live-agents',
    listKey: 'live-agents',
    cols: ['mesh_id', 'role_key', 'name', 'status', 'ordering', 'updated_at'],
    fields: [
      { key: 'mesh_id', label: 'Live Mesh ID (FK)' },
      { key: 'agent_def_id', label: 'Agent Definition ID (optional FK)' },
      { key: 'role_key', label: 'Role Key (unique per mesh)' },
      { key: 'name', label: 'Display Name' },
      { key: 'role_label', label: 'Role Label (model-facing)' },
      { key: 'persona', label: 'Persona (model-facing system prompt)', textarea: true },
      { key: 'objectives', label: 'Objectives (JSON array)', textarea: true, default: '[]' },
      { key: 'success_indicators', label: 'Success Indicators (JSON array)', textarea: true, default: '[]' },
      { key: 'attention_policy_key', label: 'Attention Policy Key (FK live_attention_policies.key)' },
      { key: 'contract_version_id', label: 'Contract Version ID (optional)' },
      {
        key: 'status',
        label: 'Status',
        options: ['ACTIVE', 'PAUSED', 'ARCHIVED'],
        default: 'ACTIVE',
      },
      { key: 'ordering', label: 'Ordering (number)', default: '0' },
      // ─── Phase 3.5 — DB-driven model routing per runtime agent ───
      {
        key: 'model_capability_json',
        label: 'Model Capability Spec (JSON, e.g. {"task":"reasoning","toolUse":true,"minContextTokens":32000}). Resolved via @weaveintel/routing.',
        textarea: true,
      },
      { key: 'model_routing_policy_key', label: 'Routing Policy Key (optional override; defaults to system policy)' },
      { key: 'model_pinned_id', label: 'Pinned Model ID (escape hatch for reproducibility — bypasses routing)' },
      // Phase 2 (DB-driven capability plan) — declarative `prepare()` recipe.
      // The runtime synthesises the agent's prepare function from this JSON
      // instead of hard-coding it inside a handler.
      {
        key: 'prepare_config_json',
        label: 'Prepare Config (JSON recipe). Example: {"systemPrompt":{"promptKey":"live-agent.observer"},"tools":"$auto","userGoal":{"from":"inbound.body"}}',
        textarea: true,
      },
    ],
  },
  'live-agent-handler-bindings': {
    singular: 'Agent Handler Binding',
    apiPath: 'admin/live-agent-handler-bindings',
    listKey: 'live-agent-handler-bindings',
    cols: ['agent_id', 'handler_kind', 'enabled', 'updated_at'],
    fields: [
      { key: 'agent_id', label: 'Live Agent ID (FK)' },
      {
        key: 'handler_kind',
        label: 'Handler Kind (must match live_handler_kinds.kind — currently implemented: agentic.react, deterministic.forward)',
      },
      { key: 'config_json', label: 'Handler Config (JSON — see live-handler-kinds.config_schema_json for shape)', textarea: true, default: '{}' },
      { key: 'enabled', label: 'Enabled', options: ['true', 'false'], default: 'true' },
    ],
  },
  'live-agent-tool-bindings': {
    singular: 'Agent Tool Binding',
    apiPath: 'admin/live-agent-tool-bindings',
    listKey: 'live-agent-tool-bindings',
    cols: ['agent_id', 'tool_catalog_id', 'mcp_server_url', 'enabled', 'updated_at'],
    fields: [
      { key: 'agent_id', label: 'Live Agent ID (FK live_agents.id)' },
      { key: 'tool_catalog_id', label: 'Tool Catalog ID (FK tool_catalog.id — set this OR mcp_server_url)' },
      { key: 'mcp_server_url', label: 'MCP Server URL (set this OR tool_catalog_id; auto-synthesised as inline mcp catalog row at runtime)' },
      {
        key: 'capability_keys',
        label: 'Allowed Capability Keys (JSON array, [] = all caps from the bound tool)',
        textarea: true,
        default: '[]',
      },
      { key: 'enabled', label: 'Enabled (toggle off to revoke the binding without deleting)', options: ['true', 'false'], default: 'true' },
    ],
  },

  // ── Runtime registries ─────────────────────────────────────
  'live-handler-kinds': {
    singular: 'Live Handler Kind',
    apiPath: 'admin/live-handler-kinds',
    listKey: 'live-handler-kinds',
    cols: ['kind', 'source', 'enabled', 'updated_at'],
    fields: [
      { key: 'kind', label: 'Kind (e.g. agentic.react)' },
      { key: 'description', label: 'Description', textarea: true },
      { key: 'config_schema_json', label: 'Config JSON Schema', textarea: true, default: '{}' },
      { key: 'source', label: 'Source', options: ['builtin', 'plugin'], default: 'plugin' },
      { key: 'enabled', label: 'Enabled', options: ['true', 'false'], default: 'true' },
    ],
  },
  'live-attention-policies': {
    singular: 'Live Attention Policy',
    apiPath: 'admin/live-attention-policies',
    listKey: 'live-attention-policies',
    cols: ['key', 'kind', 'enabled', 'updated_at'],
    fields: [
      { key: 'key', label: 'Key (unique, e.g. heuristic.inbox-first)' },
      { key: 'kind', label: 'Kind', options: ['heuristic', 'cron', 'model'], default: 'heuristic' },
      { key: 'description', label: 'Description', textarea: true },
      { key: 'config_json', label: 'Policy Config (JSON)', textarea: true, default: '{}' },
      { key: 'enabled', label: 'Enabled', options: ['true', 'false'], default: 'true' },
    ],
  },

  // ── Per-mesh runs ledger ───────────────────────────────────
  'live-runs': {
    singular: 'Live Run',
    apiPath: 'admin/live-runs',
    listKey: 'live-runs',
    cols: ['run_key', 'mesh_id', 'status', 'started_at', 'completed_at'],
    fields: [
      { key: 'mesh_id', label: 'Live Mesh ID (FK)' },
      { key: 'tenant_id', label: 'Tenant ID (optional)' },
      { key: 'run_key', label: 'Run Key (unique per mesh)' },
      { key: 'label', label: 'Label (human-readable)' },
      {
        key: 'status',
        label: 'Status',
        options: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
        default: 'RUNNING',
      },
      { key: 'started_at', label: 'Started At (ISO timestamp)' },
      { key: 'completed_at', label: 'Completed At (ISO timestamp, optional)' },
      { key: 'summary', label: 'Summary', textarea: true },
      { key: 'context_json', label: 'Context (JSON)', textarea: true, default: '{}' },
    ],
  },
  'live-run-steps': {
    singular: 'Live Run Step',
    apiPath: 'admin/live-run-steps',
    listKey: 'live-run-steps',
    cols: ['run_id', 'role_key', 'agent_id', 'status', 'started_at', 'completed_at'],
    readOnly: true,
    fields: [
      { key: 'run_id', label: 'Live Run ID (FK)' },
      { key: 'mesh_id', label: 'Live Mesh ID (FK)' },
      { key: 'agent_id', label: 'Live Agent ID (FK, optional)' },
      { key: 'role_key', label: 'Role Key' },
      { key: 'status', label: 'Status' },
      { key: 'started_at', label: 'Started At' },
      { key: 'completed_at', label: 'Completed At' },
      { key: 'summary', label: 'Summary', textarea: true },
      { key: 'payload_json', label: 'Payload (JSON)', textarea: true },
    ],
  },
  'live-run-events': {
    singular: 'Live Run Event',
    apiPath: 'admin/live-run-events',
    listKey: 'live-run-events',
    cols: ['run_id', 'kind', 'agent_id', 'created_at'],
    readOnly: true,
    fields: [
      { key: 'run_id', label: 'Live Run ID (FK)' },
      { key: 'agent_id', label: 'Live Agent ID (optional)' },
      { key: 'kind', label: 'Event Kind' },
      { key: 'summary', label: 'Summary', textarea: true },
      { key: 'payload_json', label: 'Payload (JSON)', textarea: true },
    ],
  },
};
