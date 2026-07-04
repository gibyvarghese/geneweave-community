/**
 * @weaveintel/geneweave — Database schema barrel
 *
 * Assembles per-domain SQL fragments into the single `SCHEMA_SQL` constant
 * consumed by the SQLite adapter on startup. Import domain constants directly
 * from the individual schema-*.ts files when you only need one domain's DDL.
 *
 * Domain modules (each exports a `SCHEMA_*_SQL` constant):
 *   schema-users.ts       — users, sessions, idempotency_records, user_preferences
 *   schema-chat.ts        — chats, messages, metrics, traces, temporal_*
 *   schema-prompts.ts     — prompts, prompt_frameworks, prompt_*, eval pipelines
 *   schema-tools.ts       — tool_catalog, tool_policies, tool_approval_requests
 *   schema-guardrails.ts  — guardrails, guardrail_evals, identity_rules
 *   schema-workflows.ts   — workflow_defs, workflow_runs, task_contracts, policies
 *   schema-memory.ts      — memory_governance, semantic_memory, entity_memory
 *   schema-enterprise.ts  — search_providers, social_accounts, connectors, tenants
 *   schema-agents.ts      — skills, worker_agents, replay_scenarios, dev-ex tables
 *   schema-compliance.ts  — compliance_rules, collaboration_sessions, graph/plugin
 *   schema-hypothesis.ts  — hv_* hypothesis validation + sv_* backward-compat views
 *   schema-routing.ts     — routing_policies, model_pricing, task routing, experiments
 */

export { SCHEMA_USERS_SQL } from './schema-users.js';
export { SCHEMA_CHAT_SQL } from './schema-chat.js';
export { SCHEMA_PROMPTS_SQL } from './schema-prompts.js';
export { SCHEMA_TOOLS_SQL } from './schema-tools.js';
export { SCHEMA_GUARDRAILS_SQL } from './schema-guardrails.js';
export { SCHEMA_WORKFLOWS_SQL } from './schema-workflows.js';
export { SCHEMA_MEMORY_SQL } from './schema-memory.js';
export { SCHEMA_ENTERPRISE_SQL } from './schema-enterprise.js';
export { SCHEMA_AGENTS_SQL } from './schema-agents.js';
export { SCHEMA_COMPLIANCE_SQL } from './schema-compliance.js';
export { SCHEMA_HYPOTHESIS_SQL } from './schema-hypothesis.js';
export { SCHEMA_ROUTING_SQL } from './schema-routing.js';

import { SCHEMA_USERS_SQL } from './schema-users.js';
import { SCHEMA_CHAT_SQL } from './schema-chat.js';
import { SCHEMA_PROMPTS_SQL } from './schema-prompts.js';
import { SCHEMA_TOOLS_SQL } from './schema-tools.js';
import { SCHEMA_GUARDRAILS_SQL } from './schema-guardrails.js';
import { SCHEMA_WORKFLOWS_SQL } from './schema-workflows.js';
import { SCHEMA_MEMORY_SQL } from './schema-memory.js';
import { SCHEMA_ENTERPRISE_SQL } from './schema-enterprise.js';
import { SCHEMA_AGENTS_SQL } from './schema-agents.js';
import { SCHEMA_COMPLIANCE_SQL } from './schema-compliance.js';
import { SCHEMA_HYPOTHESIS_SQL } from './schema-hypothesis.js';
import { SCHEMA_ROUTING_SQL } from './schema-routing.js';

/** Full SQLite DDL for all geneWeave tables. Consumed by the SQLite adapter at startup. */
export const SCHEMA_SQL = [
  SCHEMA_USERS_SQL,
  SCHEMA_CHAT_SQL,
  SCHEMA_PROMPTS_SQL,
  SCHEMA_TOOLS_SQL,
  SCHEMA_GUARDRAILS_SQL,
  SCHEMA_WORKFLOWS_SQL,
  SCHEMA_MEMORY_SQL,
  SCHEMA_ENTERPRISE_SQL,
  SCHEMA_AGENTS_SQL,
  SCHEMA_COMPLIANCE_SQL,
  SCHEMA_HYPOTHESIS_SQL,
  SCHEMA_ROUTING_SQL,
].join('\n');
