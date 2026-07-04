import type { AdminTabDef } from '@weaveintel/core';

/**
 * Admin UI tab definitions for A2A (Agent-to-Agent) protocol configuration.
 *
 * The `a2a-skills` tab drives the CRUD form rendered by the generic admin UI.
 * Field definitions map directly to the `a2a_skills` DB table columns.
 */
export const A2A_ADMIN_TABS: Record<string, AdminTabDef> = {
  'a2a-skills': {
    singular: 'A2A Skill',
    apiPath: 'admin/a2a-skills',
    listKey: 'skills',
    cols: ['id', 'name', 'mode', 'security_scopes', 'required_permission', 'sort_order', 'enabled'],
    fields: [
      {
        key: 'id',
        label: 'Skill ID (kebab-case, used in Agent Card and JWT scope claims)',
      },
      {
        key: 'name',
        label: 'Display Name (shown in Agent Card and admin UI)',
      },
      {
        key: 'description',
        label: 'Description (model-facing — purpose, scope, when to use)',
        textarea: true,
        rows: 4,
      },
      {
        key: 'mode',
        label: 'Execution Mode',
        options: ['agent', 'supervisor', 'ensemble'],
        default: 'agent',
      },
      {
        key: 'required_permission',
        label: 'Required RBAC Permission (blank = any authenticated user, e.g. agents:delegate)',
      },
      {
        key: 'security_scopes',
        label: 'Security Scopes (JSON array of OAuth2 scope tokens, e.g. ["a2a:chat"])',
        textarea: true,
        rows: 2,
        save: 'json',
      },
      {
        key: 'tags',
        label: 'Tags (JSON array for discovery, e.g. ["chat","tool-calling"])',
        textarea: true,
        rows: 2,
        save: 'json',
      },
      {
        key: 'examples',
        label: 'Example Prompts (JSON array shown in Agent Card)',
        textarea: true,
        rows: 4,
        save: 'json',
      },
      {
        key: 'input_modes',
        label: 'Input Modes (JSON array of MIME types, e.g. ["text/plain","audio/*","image/*"])',
        textarea: true,
        rows: 3,
        save: 'json',
      },
      {
        key: 'output_modes',
        label: 'Output Modes (JSON array of MIME types, e.g. ["text/plain"])',
        textarea: true,
        rows: 2,
        save: 'json',
      },
      {
        key: 'agent_tools',
        label: 'Agent Tools (JSON string[] — overrides mode defaults; null = use mode policy, e.g. ["web_search","cse_run_code","memory_recall"])',
        textarea: true,
        rows: 4,
        save: 'json',
      },
      {
        key: 'agent_workers',
        label: 'Agent Workers (JSON WorkerDef[] — required for supervisor/ensemble skills; defines code_executor, analyst, etc.)',
        textarea: true,
        rows: 6,
        save: 'json',
      },
      {
        key: 'sort_order',
        label: 'Sort Order (lower = appears first in Agent Card)',
        type: 'number',
        save: 'int',
        default: 0,
      },
      {
        key: 'enabled',
        label: 'Enabled (published in Agent Card)',
        type: 'checkbox',
        save: 'bool',
        default: true,
      },
    ],
  },
};
