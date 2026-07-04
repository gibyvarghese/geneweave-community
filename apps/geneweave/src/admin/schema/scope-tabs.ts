/**
 * GeneWeave — admin/schema/scope-tabs.ts
 *
 * Admin UI tab definitions for the agentic scope isolation tables (m75).
 *
 * Five tabs are registered under the "Scope Isolation" group in the admin SPA:
 *
 *   agent-scopes              — named domain boundaries (full CRUD)
 *   scope-cross-policies      — cross-scope delegation rules (full CRUD)
 *   scope-skill-assignments   — maps skill IDs to scopes (list + create + delete)
 *   scope-live-agent-assignments — maps live mesh roles to scopes (list + create + delete)
 *   scope-access-log          — immutable audit trail (read-only list)
 *
 * Field types match column semantics precisely:
 *   - boolean SQLite integers → type: 'checkbox', save: 'bool'
 *   - integer columns         → type: 'number',   save: 'int'
 *   - enum columns            → options: [...]
 *   - JSON columns            → textarea: true,    save: 'json'
 *   - read-only columns       → readonly: true
 */

import type { AdminTabDef } from '@weaveintel/core';

/** Scope names available as select options in dropdown fields. */
const SCOPE_OPTIONS = ['system', 'analytics', 'kaggle', 'code', 'browser', 'voice', 'memory'];

/** Scope names + wildcard for cross-policy "to_scope" field. */
const SCOPE_OPTIONS_WITH_WILDCARD = [...SCOPE_OPTIONS, '*'];

export const SCOPE_ADMIN_TABS: Record<string, AdminTabDef> = {

  // ── agent_scopes ───────────────────────────────────────────────────────────
  'agent-scopes': {
    singular: 'Agent Scope',
    apiPath: 'admin/agent-scopes',
    listKey: 'agent-scopes',
    cols: ['id', 'display_name', 'sandboxed', 'max_delegation_depth', 'audit_level', 'enabled'],
    fields: [
      {
        key: 'id',
        label: 'Scope ID (lowercase, kebab-case — used as the scope name in policies and log entries, e.g. "analytics")',
        placeholder: 'analytics',
        helpText: 'Immutable after creation. Must be lowercase alphanumeric with hyphens or underscores.',
      },
      {
        key: 'display_name',
        label: 'Display Name (shown in admin UI and logs)',
        placeholder: 'Data Analytics',
      },
      {
        key: 'description',
        label: 'Description (model-facing — explains what work belongs in this scope)',
        textarea: true,
        rows: 4,
      },
      {
        key: 'sandboxed',
        label: 'Sandboxed (when enabled, scope violations are BLOCKED; when disabled, violations are audit-only)',
        type: 'checkbox',
        save: 'bool',
        default: true,
      },
      {
        key: 'max_delegation_depth',
        label: 'Max Delegation Depth (maximum A2A hops allowed originating from this scope; 0 = no cross-scope delegation)',
        type: 'number',
        save: 'int',
        default: 5,
        helpText: 'Set to 1 for leaf scopes (memory, voice). Set to 10 for system orchestration.',
      },
      {
        key: 'audit_level',
        label: 'Audit Level — controls verbosity of scope events written to scope_access_log',
        options: ['none', 'log', 'alert'],
        default: 'log',
        helpText: '"none" = no logging, "log" = standard events, "alert" = logs + raises a security alert.',
      },
      {
        key: 'enabled',
        label: 'Enabled (disabled scopes are excluded from runtime policy lookups)',
        type: 'checkbox',
        save: 'bool',
        default: true,
      },
    ],
  },

  // ── scope_cross_policies ───────────────────────────────────────────────────
  'scope-cross-policies': {
    singular: 'Cross-Scope Policy',
    apiPath: 'admin/scope-cross-policies',
    listKey: 'scope-cross-policies',
    cols: ['id', 'from_scope', 'to_scope', 'allowed', 'requires_a2a', 'max_delegation_depth', 'audit_level', 'enabled'],
    fields: [
      {
        key: 'id',
        label: 'Policy ID (auto-generated if blank, e.g. "pol-ana-kag")',
        placeholder: 'pol-analytics-kaggle',
        helpText: 'Unique identifier. Leave blank to auto-generate.',
      },
      {
        key: 'from_scope',
        label: 'From Scope — the scope that wants to delegate',
        options: SCOPE_OPTIONS,
        helpText: 'The source scope initiating the cross-scope call.',
      },
      {
        key: 'to_scope',
        label: 'To Scope — the scope being delegated into ("*" = wildcard, matches any scope not covered by a specific rule)',
        options: SCOPE_OPTIONS_WITH_WILDCARD,
        helpText: 'Use "*" as a default catch-all. Specific from/to pairs take precedence over wildcards.',
      },
      {
        key: 'allowed',
        label: 'Allowed (when unchecked, this delegation is EXPLICITLY DENIED regardless of other rules)',
        type: 'checkbox',
        save: 'bool',
        default: false,
        helpText: 'The analytics→kaggle policy should have this UNCHECKED to enforce the isolation boundary.',
      },
      {
        key: 'requires_a2a',
        label: 'Requires A2A Protocol (when checked, delegation MUST use a signed CrossScopeToken via A2A; direct calls are blocked)',
        type: 'checkbox',
        save: 'bool',
        default: true,
        helpText: 'Enforce A2A for all allowed cross-scope calls to prevent confused-deputy attacks.',
      },
      {
        key: 'max_delegation_depth',
        label: 'Max Delegation Depth (maximum number of cross-scope hops for this specific policy; 0 = deny)',
        type: 'number',
        save: 'int',
        default: 1,
        helpText: 'Caps the delegation chain length. Set to 0 only for explicit-deny policies.',
      },
      {
        key: 'conditions_json',
        label: 'Conditions JSON (optional — ScopePolicyCondition[] array for context-dependent allow/deny)',
        textarea: true,
        rows: 3,
        save: 'json',
        helpText: 'Advanced: leave blank for unconditional policies. JSON array of condition objects.',
        placeholder: '[]',
      },
      {
        key: 'audit_level',
        label: 'Audit Level — overrides the source scope\'s audit_level for events matching this policy',
        options: ['none', 'log', 'alert'],
        default: 'log',
        helpText: 'Use "alert" for sensitive deny policies (e.g. analytics→kaggle).',
      },
      {
        key: 'enabled',
        label: 'Enabled (disabled policies are ignored by the runtime scope registry)',
        type: 'checkbox',
        save: 'bool',
        default: true,
      },
    ],
  },

  // ── scope_skill_assignments ────────────────────────────────────────────────
  'scope-skill-assignments': {
    singular: 'Skill→Scope Assignment',
    apiPath: 'admin/scope-skill-assignments',
    listKey: 'scope-skill-assignments',
    cols: ['id', 'scope_id', 'skill_id'],
    fields: [
      {
        key: 'scope_id',
        label: 'Scope ID — the scope this skill belongs to',
        options: SCOPE_OPTIONS,
        helpText: 'Determines which scope context is required to activate this skill.',
      },
      {
        key: 'skill_id',
        label: 'Skill ID — the A2A skill or internal skill identifier (e.g. "data-pipeline")',
        placeholder: 'data-pipeline',
        helpText: 'Must match the skill\'s ID in a2a_skills or the built-in SKILL_SCOPE_MAP.',
      },
    ],
  },

  // ── scope_live_agent_assignments ───────────────────────────────────────────
  'scope-live-agent-assignments': {
    singular: 'Live Agent→Scope Assignment',
    apiPath: 'admin/scope-live-agent-assignments',
    listKey: 'scope-live-agent-assignments',
    cols: ['id', 'scope_id', 'mesh_key', 'role_key'],
    fields: [
      {
        key: 'scope_id',
        label: 'Scope ID — the scope this live agent mesh/role belongs to',
        options: SCOPE_OPTIONS,
        helpText: 'e.g. "kaggle" for all roles in the Kaggle competition mesh.',
      },
      {
        key: 'mesh_key',
        label: 'Mesh Key — the live agent mesh identifier (e.g. "kaggle", "sv-science")',
        placeholder: 'kaggle',
        helpText: 'Matches live_mesh_definitions.mesh_key.',
      },
      {
        key: 'role_key',
        label: 'Role Key — specific role within the mesh (leave blank or use "" for catch-all covering all roles)',
        placeholder: 'discoverer',
        helpText: 'Empty string = catch-all: applies to any role in this mesh not covered by a specific row. Named roles (e.g. "discoverer") take precedence over catch-all.',
      },
    ],
  },

  // ── scope_access_log (read-only) ───────────────────────────────────────────
  'scope-access-log': {
    singular: 'Scope Access Event',
    apiPath: 'admin/scope-access-log',
    listKey: 'scope-access-log',
    readOnly: true,
    cols: ['created_at', 'event_type', 'allowed', 'from_scope', 'to_scope', 'skill_id', 'tool_name', 'session_id', 'reason'],
    fields: [
      {
        key: 'id',
        label: 'Event ID',
        readonly: true,
      },
      {
        key: 'event_type',
        label: 'Event Type',
        readonly: true,
        helpText: '"skill_activation" | "cross_scope_delegation" | "tool_invocation" | "violation"',
      },
      {
        key: 'from_scope',
        label: 'From Scope',
        readonly: true,
      },
      {
        key: 'to_scope',
        label: 'To Scope',
        readonly: true,
      },
      {
        key: 'skill_id',
        label: 'Skill ID',
        readonly: true,
      },
      {
        key: 'tool_name',
        label: 'Tool Name',
        readonly: true,
      },
      {
        key: 'session_id',
        label: 'Session ID',
        readonly: true,
      },
      {
        key: 'task_id',
        label: 'Task ID',
        readonly: true,
      },
      {
        key: 'user_id',
        label: 'User ID',
        readonly: true,
      },
      {
        key: 'allowed',
        label: 'Allowed (1 = permitted, 0 = blocked)',
        readonly: true,
        helpText: 'This is an immutable audit log. Rows cannot be modified or deleted.',
      },
      {
        key: 'reason',
        label: 'Reason',
        readonly: true,
      },
      {
        key: 'delegation_chain_json',
        label: 'Delegation Chain (JSON)',
        textarea: true,
        rows: 3,
        readonly: true,
      },
      {
        key: 'created_at',
        label: 'Created At',
        readonly: true,
      },
    ],
  },
};
