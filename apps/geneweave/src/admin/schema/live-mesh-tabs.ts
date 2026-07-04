import type { AdminTabDef } from '@weaveintel/core';

/**
 * Phase M21 — Live Mesh Definitions admin tabs.
 *
 * Framework-level DB-driven definitions for any live-agents mesh. The
 * runtime (`bootKaggleMesh`, future `bootGenericMesh`) loads a snapshot
 * keyed by `mesh_key` ('kaggle', etc.) and uses the personas/edges/dual-
 * control gates from these tables instead of in-code constants.
 *
 *  - live-mesh-definitions     → one row per mesh contract
 *  - live-agent-definitions    → role personas inside a mesh
 *  - live-mesh-delegation-edges → who can delegate to whom
 */
export const LIVE_MESH_ADMIN_TABS: Record<string, AdminTabDef> = {
  'live-mesh-definitions': {
    singular: 'Live Mesh Definition',
    apiPath: 'admin/live-mesh-definitions',
    listKey: 'live-mesh-definitions',
    cols: ['mesh_key', 'name', 'enabled', 'updated_at'],
    fields: [
      { key: 'mesh_key', label: 'Mesh Key (unique, e.g. kaggle)' },
      { key: 'name', label: 'Display Name' },
      { key: 'description', label: 'Description', textarea: true },
      { key: 'charter_prose', label: 'Charter Prose (mesh-wide instructions)', textarea: true },
      {
        key: 'dual_control_required_for',
        label: 'Dual-Control Tools (JSON array of tool keys)',
        textarea: true,
        default: '[]',
      },
      { key: 'enabled', label: 'Enabled', options: ['true', 'false'], default: 'true' },
    ],
  },
  'live-agent-definitions': {
    singular: 'Live Agent Definition',
    apiPath: 'admin/live-agent-definitions',
    listKey: 'live-agent-definitions',
    cols: ['mesh_def_id', 'role_key', 'name', 'role_label', 'ordering', 'enabled'],
    fields: [
      { key: 'mesh_def_id', label: 'Mesh Definition ID (FK)' },
      { key: 'role_key', label: 'Role Key (e.g. discoverer)' },
      { key: 'name', label: 'Display Name' },
      { key: 'role_label', label: 'Role Label (model-facing)' },
      { key: 'persona', label: 'Persona (model-facing system prompt)', textarea: true },
      { key: 'objectives', label: 'Objectives', textarea: true },
      { key: 'success_indicators', label: 'Success Indicators', textarea: true },
      { key: 'ordering', label: 'Ordering (number)', default: '0' },
      { key: 'enabled', label: 'Enabled', options: ['true', 'false'], default: 'true' },
      // ─── Phase 3.5 — DB-driven model routing defaults (blueprint level) ───
      // These flow into `live_agents` rows when a mesh is provisioned but
      // can be overridden per runtime agent.
      {
        key: 'model_capability_json',
        label: 'Default Model Capability Spec (JSON, e.g. {"task":"reasoning","toolUse":true,"minContextTokens":32000}). Resolved via @weaveintel/routing.',
        textarea: true,
      },
      { key: 'model_routing_policy_key', label: 'Default Routing Policy Key (optional override)' },
      { key: 'model_pinned_id', label: 'Default Pinned Model ID (escape hatch — bypasses routing for reproducibility)' },
    ],
  },
  'live-mesh-delegation-edges': {
    singular: 'Delegation Edge',
    apiPath: 'admin/live-mesh-delegation-edges',
    listKey: 'live-mesh-delegation-edges',
    cols: ['mesh_def_id', 'from_role_key', 'to_role_key', 'relationship', 'ordering', 'enabled'],
    fields: [
      { key: 'mesh_def_id', label: 'Mesh Definition ID (FK)' },
      { key: 'from_role_key', label: 'From Role Key' },
      { key: 'to_role_key', label: 'To Role Key' },
      {
        key: 'relationship',
        label: 'Relationship',
        options: ['DIRECTS', 'COLLABORATES_WITH', 'REPORTS_TO'],
        default: 'DIRECTS',
      },
      { key: 'prose', label: 'Prose (model-facing description)', textarea: true },
      { key: 'ordering', label: 'Ordering (number)', default: '0' },
      { key: 'enabled', label: 'Enabled', options: ['true', 'false'], default: 'true' },
    ],
  },
};
