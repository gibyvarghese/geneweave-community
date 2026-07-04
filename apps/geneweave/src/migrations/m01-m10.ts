import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

export function applyM01_M10(db: BetterSqlite3.Database): void {
  safeExec(db, `CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_mode TEXT NOT NULL DEFAULT 'agent',
    theme TEXT NOT NULL DEFAULT 'light',
    show_process_card INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'agent',
    system_prompt TEXT,
    timezone TEXT,
    enabled_tools TEXT,
    redaction_enabled INTEGER NOT NULL DEFAULT 1,
    redaction_patterns TEXT,
    workers TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, 'ALTER TABLE chat_settings ADD COLUMN timezone TEXT');
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'");
  safeExec(db, 'ALTER TABLE user_preferences ADD COLUMN show_process_card INTEGER NOT NULL DEFAULT 1');
  safeExec(db, "ALTER TABLE users ADD COLUMN persona TEXT NOT NULL DEFAULT 'tenant_user'");
  safeExec(db, 'ALTER TABLE users ADD COLUMN tenant_id TEXT');

  safeExec(db, `CREATE TABLE IF NOT EXISTS idempotency_records (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    result_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_records(expires_at)');

  safeExec(db, `CREATE TABLE IF NOT EXISTS oauth_flow_states (
    id TEXT PRIMARY KEY,
    state_key TEXT NOT NULL UNIQUE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_oauth_flow_states_expires_at ON oauth_flow_states(expires_at)');

  safeExec(db, 'ALTER TABLE prompts ADD COLUMN key TEXT');
  safeExec(db, "ALTER TABLE prompts ADD COLUMN prompt_type TEXT NOT NULL DEFAULT 'template'");
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN owner TEXT');
  safeExec(db, "ALTER TABLE prompts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'");
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN tags TEXT');
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN model_compatibility TEXT');
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN execution_defaults TEXT');
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN framework TEXT');
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN metadata TEXT');

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_strategies (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    instruction_prefix TEXT,
    instruction_suffix TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_versions (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    template TEXT NOT NULL,
    variables TEXT,
    model_compatibility TEXT,
    execution_defaults TEXT,
    framework TEXT,
    metadata TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(prompt_id, version)
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_experiments (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    variants_json TEXT NOT NULL DEFAULT '[]',
    assignment_key_template TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_eval_datasets (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    prompt_version TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    pass_threshold REAL NOT NULL DEFAULT 0.75,
    cases_json TEXT NOT NULL DEFAULT '[]',
    rubric_json TEXT,
    metadata TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_eval_runs (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES prompt_eval_datasets(id) ON DELETE CASCADE,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    prompt_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    avg_score REAL NOT NULL DEFAULT 0,
    passed_cases INTEGER NOT NULL DEFAULT 0,
    failed_cases INTEGER NOT NULL DEFAULT 0,
    total_cases INTEGER NOT NULL DEFAULT 0,
    results_json TEXT NOT NULL DEFAULT '[]',
    summary_json TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_optimizers (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    implementation_kind TEXT NOT NULL DEFAULT 'rule',
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_optimization_runs (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    source_version TEXT NOT NULL,
    candidate_version TEXT NOT NULL,
    optimizer_id TEXT REFERENCES prompt_optimizers(id) ON DELETE SET NULL,
    objective TEXT NOT NULL,
    source_template TEXT NOT NULL,
    candidate_template TEXT NOT NULL,
    diff_json TEXT NOT NULL,
    eval_baseline_json TEXT,
    eval_candidate_json TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Intentionally repeated to preserve existing bootstrap behavior/order.
  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_versions (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    template TEXT NOT NULL,
    variables TEXT,
    model_compatibility TEXT,
    execution_defaults TEXT,
    framework TEXT,
    metadata TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(prompt_id, version)
  )`);

  // Intentionally repeated to preserve existing bootstrap behavior/order.
  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_experiments (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    variants_json TEXT NOT NULL DEFAULT '[]',
    assignment_key_template TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS semantic_memory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    tenant_id TEXT,
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'semantic',
    source TEXT NOT NULL DEFAULT 'assistant',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS entity_memory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    tenant_id TEXT,
    entity_name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'general',
    facts TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL DEFAULT 'regex',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, entity_name)
  )`);

  safeExec(db, 'ALTER TABLE entity_memory ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5');
  safeExec(db, "ALTER TABLE entity_memory ADD COLUMN source TEXT NOT NULL DEFAULT 'regex'");

  safeExec(db, `CREATE TABLE IF NOT EXISTS memory_extraction_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    tenant_id TEXT,
    self_disclosure INTEGER NOT NULL DEFAULT 0,
    regex_entities_count INTEGER NOT NULL DEFAULT 0,
    llm_entities_count INTEGER NOT NULL DEFAULT 0,
    merged_entities_count INTEGER NOT NULL DEFAULT 0,
    events TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);


  safeExec(db, `CREATE TABLE IF NOT EXISTS website_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_name TEXT NOT NULL,
    site_url_pattern TEXT NOT NULL,
    auth_method TEXT NOT NULL DEFAULT 'form_fill',
    credentials_encrypted TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    last_used_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS sso_linked_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_provider TEXT NOT NULL,
    email TEXT,
    session_encrypted TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    linked_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, identity_provider)
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS oauth_linked_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    picture_url TEXT,
    linked_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    UNIQUE(user_id, provider)
  )`);

  // Migrate seed record IDs from human-readable slugs to stable UUIDs
  // prompts
  safeExec(db, `UPDATE prompts SET id = 'e92e7672-3009-4040-8b05-a411dc825f90' WHERE id = 'prompt-general-assistant'`);
  safeExec(db, `UPDATE prompts SET id = 'e7c21e36-c558-40e0-9b99-2433c0466bc3' WHERE id = 'prompt-code-reviewer'`);
  safeExec(db, `UPDATE prompts SET id = '14b189df-1307-4041-ab1b-2a784df9d304' WHERE id = 'prompt-summarizer'`);
  safeExec(db, `UPDATE prompts SET id = '906cdfa7-35f4-4d39-a0ea-d099207570dc' WHERE id = 'prompt-sql-expert'`);
  safeExec(db, `UPDATE prompts SET id = 'f68c3785-469c-4d2b-a2c2-366c5bc3b4d2' WHERE id = 'prompt-runtime-supervisor-code-execution'`);
  safeExec(db, `UPDATE prompts SET id = '4aecf467-a350-42f9-aeca-550fcc4383a2' WHERE id = 'prompt-runtime-response-card-format'`);
  safeExec(db, `UPDATE prompts SET id = 'b3722c76-fc46-4392-ab8e-3f39b0fce3dc' WHERE id = 'prompt-runtime-supervisor-temporal'`);
  safeExec(db, `UPDATE prompts SET id = '338ee839-adee-43cb-9dd4-34e53333b997' WHERE id = 'prompt-runtime-multi-worker-pipeline'`);
  safeExec(db, `UPDATE prompts SET id = '044e122c-67cf-4bb3-9ad3-090bd937b6c8' WHERE id = 'prompt-runtime-force-worker-data-analysis'`);
  safeExec(db, `UPDATE prompts SET id = '5f58d48f-931f-4b1f-a418-e9b43d545dc8' WHERE id = 'prompt-runtime-hard-execution-guard'`);
  safeExec(db, `UPDATE prompts SET id = 'dc61ee37-5268-4e8b-af36-22d6124d99b6' WHERE id = 'prompt-runtime-enterprise-worker-system'`);
  // prompt_frameworks
  safeExec(db, `UPDATE prompt_frameworks SET id = '21f6a792-9267-4444-bdbc-ff7c2d4298f9' WHERE id = 'framework-rtce'`);
  safeExec(db, `UPDATE prompt_frameworks SET id = '7b55952c-4f80-40ca-81ea-461bab97c672' WHERE id = 'framework-full'`);
  safeExec(db, `UPDATE prompt_frameworks SET id = 'eadfbd4d-039b-4993-a89e-82e1a9175b70' WHERE id = 'framework-critique'`);
  safeExec(db, `UPDATE prompt_frameworks SET id = 'df2c712c-6fcb-4048-a1ff-aee1026571fa' WHERE id = 'framework-judge'`);
  // prompt_fragments
  safeExec(db, `UPDATE prompt_fragments SET id = '34959c97-a4a1-48bd-ac09-9ac176a887fb' WHERE id = 'fragment-safety-notice'`);
  safeExec(db, `UPDATE prompt_fragments SET id = '6d71697a-1132-4fa6-908b-3afbd7016e9c' WHERE id = 'fragment-json-output-contract'`);
  safeExec(db, `UPDATE prompt_fragments SET id = '7c0fcd6a-90e6-4ee2-9380-62153157428c' WHERE id = 'fragment-cot-instruction'`);
  safeExec(db, `UPDATE prompt_fragments SET id = 'a0999e98-3dc6-4c9b-95ea-4e62c1abd53b' WHERE id = 'fragment-language-notice'`);
  safeExec(db, `UPDATE prompt_fragments SET id = '6caa8594-41c4-4664-b91d-40ec8513ccc6' WHERE id = 'fragment-persona-analyst'`);
  safeExec(db, `UPDATE prompt_fragments SET id = 'de14761d-5c2f-46a5-a837-dc2760b0d90c' WHERE id = 'fragment-persona-assistant'`);
  // prompt_strategies
  safeExec(db, `UPDATE prompt_strategies SET id = '1006723f-a866-4762-ad8b-b572a7e71f4c' WHERE id = 'strategy-single-pass'`);
  safeExec(db, `UPDATE prompt_strategies SET id = '1ae56ebf-7e13-4459-bee4-c3e2f9e75299' WHERE id = 'strategy-deliberate'`);
  safeExec(db, `UPDATE prompt_strategies SET id = 'cc57decf-8262-43f1-acfa-d65bdbaa720d' WHERE id = 'strategy-critique-revise'`);
  // prompt_optimizers
  safeExec(db, `UPDATE prompt_optimizers SET id = 'a057bba1-7e06-438e-9c31-1e5489810447' WHERE id = 'optimizer-constraint-appender'`);
  safeExec(db, `UPDATE prompt_optimizers SET id = '5c0497a0-1165-4947-b678-5f01bd900db7' WHERE id = 'optimizer-llm-judge-refine'`);
  // guardrails
  safeExec(db, `UPDATE guardrails SET id = '0370fa22-5fc8-49a4-bd4c-3e39863da61d' WHERE id = 'guard-pii-redact'`);
  safeExec(db, `UPDATE guardrails SET id = '51586988-83b7-4780-a006-b3b86b76713f' WHERE id = 'guard-toxicity'`);
  safeExec(db, `UPDATE guardrails SET id = '1a6b5225-07c6-41cc-878f-c0d08930c1de' WHERE id = 'guard-token-limit'`);
  safeExec(db, `UPDATE guardrails SET id = '8ae24528-463a-4dfa-9348-a2be5214de9f' WHERE id = 'guard-hallucination'`);
  safeExec(db, `UPDATE guardrails SET id = '58897b64-39ca-457c-8e8b-8ce4ffc33aa5' WHERE id = 'guard-cog-pre-sycophancy'`);
  safeExec(db, `UPDATE guardrails SET id = '70469180-6265-47d8-82c6-ee3cec180bc6' WHERE id = 'guard-cog-pre-confidence'`);
  safeExec(db, `UPDATE guardrails SET id = 'e6f04e4f-29bb-4081-a9e8-ef66dba939bf' WHERE id = 'guard-cog-post-grounding'`);
  safeExec(db, `UPDATE guardrails SET id = 'f9e2ec15-8243-4884-9056-a5cf79af9800' WHERE id = 'guard-cog-post-sycophancy'`);
  safeExec(db, `UPDATE guardrails SET id = 'af3ed9ac-b3ca-4d10-bf80-678e4a750389' WHERE id = 'guard-cog-post-devils-advocate'`);
  safeExec(db, `UPDATE guardrails SET id = '4ace09e3-5aa8-4761-8d7c-e56f81ae84dd' WHERE id = 'guard-cog-post-confidence'`);
  safeExec(db, `UPDATE guardrails SET id = '7c8988ba-b7c9-4e52-8139-732e5c922a25' WHERE id = 'guard-injection-directive-override'`);
  safeExec(db, `UPDATE guardrails SET id = '0eb8ae21-e411-4dae-921f-3f91651619d9' WHERE id = 'guard-injection-prompt-exfil'`);
  // routing_rules
  safeExec(db, `UPDATE routing_rules SET id = 'a2cdb3b9-cd89-48d8-884d-ce617a9ca328' WHERE id = 'route-cost-optimized'`);
  safeExec(db, `UPDATE routing_rules SET id = 'eea58ad8-5c94-4aba-98ce-850c4a567e31' WHERE id = 'route-quality-first'`);
  safeExec(db, `UPDATE routing_rules SET id = 'b6bcb4e8-16e2-4c40-b5a6-50bc15912c23' WHERE id = 'route-balanced'`);
  // model_providers
  safeExec(db, `UPDATE model_providers SET id = '24c261e4-3cd0-48da-aba5-ad65cdc4ba84' WHERE id = 'mp-claude-sonnet-4'`);
  safeExec(db, `UPDATE model_providers SET id = '3a01332c-7062-46f4-ac27-23718d0b7e11' WHERE id = 'mp-claude-opus-4'`);
  safeExec(db, `UPDATE model_providers SET id = '7a159bca-cd4a-4008-9adf-537d3f9087a5' WHERE id = 'mp-claude-haiku-4'`);
  safeExec(db, `UPDATE model_providers SET id = 'd544e807-dd8b-45fc-8d7c-4c35b00fe34c' WHERE id = 'mp-gpt-4o'`);
  safeExec(db, `UPDATE model_providers SET id = '453e9a1e-b374-436b-bbed-58ba0a0db737' WHERE id = 'mp-gpt-4o-mini'`);
  safeExec(db, `UPDATE model_providers SET id = '5a851707-9a6f-434f-9c8f-e6bc02647e90' WHERE id = 'mp-gpt-4.1'`);
  safeExec(db, `UPDATE model_providers SET id = 'b2c6d495-f58e-40f1-aff2-d58050aabedb' WHERE id = 'mp-gpt-4.1-mini'`);
  safeExec(db, `UPDATE model_providers SET id = 'bf5734a5-3552-4068-a80d-457c25f927ab' WHERE id = 'mp-gpt-4.1-nano'`);
  safeExec(db, `UPDATE model_providers SET id = '5190bfc2-0601-4153-8563-a6f5811bdcae' WHERE id = 'mp-o3'`);
  safeExec(db, `UPDATE model_providers SET id = 'f7c3f6b4-f3de-4070-a547-f37359aa0ca4' WHERE id = 'mp-o4-mini'`);
  // workflow_defs
  safeExec(db, `UPDATE workflow_defs SET id = '3aedac32-ef1a-429f-89d7-23d481ccd8ad' WHERE id = 'wf-code-review'`);
  safeExec(db, `UPDATE workflow_defs SET id = 'f47a3a38-a090-4956-8998-3e2bf6327304' WHERE id = 'wf-content-pipeline'`);
  safeExec(db, `UPDATE workflow_defs SET id = '2cb3d0de-9ce7-4b90-a7cd-7c41f762a988' WHERE id = 'wf-nz-stats-lookup'`);
  // workflow_runs FK
  safeExec(db, `UPDATE workflow_runs SET workflow_id = '3aedac32-ef1a-429f-89d7-23d481ccd8ad' WHERE workflow_id = 'wf-code-review'`);
  safeExec(db, `UPDATE workflow_runs SET workflow_id = 'f47a3a38-a090-4956-8998-3e2bf6327304' WHERE workflow_id = 'wf-content-pipeline'`);
  // tools
  safeExec(db, `UPDATE tools SET id = 'a7bd3e9f-9b1b-4aa6-9520-8f5fb194a5e3' WHERE id = 'tool-web-search'`);
  safeExec(db, `UPDATE tools SET id = '8e6c2528-f5a0-4d5a-a719-b60cc660f353' WHERE id = 'tool-code-exec'`);
  safeExec(db, `UPDATE tools SET id = 'bca36e31-bf3b-4761-89ba-0f1edecf22cf' WHERE id = 'tool-file-read'`);
  safeExec(db, `UPDATE tools SET id = '9bbd1c34-35a1-442f-b2bb-d5d6f568f57a' WHERE id = 'tool-db-query'`);
  safeExec(db, `UPDATE tools SET id = '31755606-4e34-44be-a101-cee78d49f6e1' WHERE id = 'tool-api-call'`);
  safeExec(db, `UPDATE tools SET id = '220dd56e-5c1c-4dad-93c8-befa5d7588f5' WHERE id = 'tool-statsnz'`);
  // task_contracts
  safeExec(db, `UPDATE task_contracts SET id = 'fbb4e3aa-a78b-452f-90b9-30ec0a1da2ea' WHERE id = 'tc-code-review'`);
  safeExec(db, `UPDATE task_contracts SET id = 'e5f03434-6aba-4e7f-93c5-838344d25d9b' WHERE id = 'tc-content-gen'`);
  safeExec(db, `UPDATE task_contracts SET id = '2e9ac54f-a9b4-4ecd-88a0-1113d8c32a34' WHERE id = 'tc-data-analysis'`);
  safeExec(db, `UPDATE task_contracts SET id = 'eb6561e5-46a8-446d-8056-0d1a6fac751e' WHERE id = 'tc-nz-statistics'`);
  // worker_agents and FK
  safeExec(db, `UPDATE worker_agents SET id = '8d2598f8-775d-4e67-841d-1cb5fb16713e' WHERE id = 'wa-code-executor'`);
  safeExec(db, `UPDATE worker_agents SET id = 'aebc3dc5-cc5b-4ad2-a10c-dedf8a9a5c3e' WHERE id = 'wa-statsnz-specialist'`);
  safeExec(db, `UPDATE worker_agents SET id = 'bf3c7feb-5471-4e17-a46c-f2c84efbf613' WHERE id = 'wa-researcher'`);
  safeExec(db, `UPDATE worker_agents SET id = '63566924-9e94-41e5-8e55-6e9ddee168c5' WHERE id = 'wa-analyst'`);
  safeExec(db, `UPDATE worker_agents SET id = '1111d2e3-2828-4570-9bf2-91320b536a2e' WHERE id = 'wa-writer'`);
  safeExec(db, `UPDATE worker_agents SET task_contract_id = 'eb6561e5-46a8-446d-8056-0d1a6fac751e' WHERE task_contract_id = 'tc-nz-statistics'`);
  // agent_runs
  safeExec(db, `UPDATE agent_runs SET id = '38e1d25e-75e8-470c-ae80-f8464c666026' WHERE id = 'run-001'`);
  safeExec(db, `UPDATE agent_runs SET id = 'b718e2c0-6049-4d67-8d87-3706d13ea97c' WHERE id = 'run-002'`);
  // guardrail_evals
  safeExec(db, `UPDATE guardrail_evals SET id = 'bdb005ec-c192-4404-ab44-bf4e23ab7aee' WHERE id = 'geval-001'`);
  safeExec(db, `UPDATE guardrail_evals SET id = '25f7e39a-5990-467c-8ae2-6114c3511190' WHERE id = 'geval-002'`);
  // human_task_policies
  safeExec(db, `UPDATE human_task_policies SET id = 'cc83adb8-bf49-4fb0-83c4-fa27da65dc56' WHERE id = 'htp-high-risk-tool'`);
  safeExec(db, `UPDATE human_task_policies SET id = '50cb4891-c1b7-4562-9bbb-75d0e552c07d' WHERE id = 'htp-sensitive-data'`);
  safeExec(db, `UPDATE human_task_policies SET id = '33664f9c-7e81-4bae-b536-6bdf17ea2352' WHERE id = 'htp-cost-threshold'`);
  safeExec(db, `UPDATE human_task_policies SET id = '659ed861-c3da-432d-a954-94393eb628de' WHERE id = 'htp-workflow-gate'`);
  // cache_policies
  safeExec(db, `UPDATE cache_policies SET id = 'a747b721-8eff-46b2-a916-864ec0ac67cf' WHERE id = 'cp-global-default'`);
  safeExec(db, `UPDATE cache_policies SET id = '5820734a-3bea-4558-90ad-d382b7b76bb2' WHERE id = 'cp-session-short'`);
  safeExec(db, `UPDATE cache_policies SET id = 'bd5cbbb5-c407-4016-9c43-5525f2789017' WHERE id = 'cp-semantic-lookup'`);
  safeExec(db, `UPDATE cache_policies SET id = '50dd439b-1fec-4293-8ee2-ed24ae07c387' WHERE id = 'cp-user-personalised'`);
  // identity_policies
  safeExec(db, `UPDATE identity_policies SET id = '71d997aa-fb08-446d-8123-1b774f3c7de5' WHERE id = 'ident-admin-all'`);
  safeExec(db, `UPDATE identity_policies SET id = '280a5cfc-548c-4714-aabb-5e6a5dcaaf44' WHERE id = 'ident-user-chat'`);
  safeExec(db, `UPDATE identity_policies SET id = '89eee70b-407a-4a89-a5e8-17b69330da8a' WHERE id = 'ident-agent-tools'`);
  safeExec(db, `UPDATE identity_policies SET id = '7ef01416-07ec-496b-be00-67926157a29e' WHERE id = 'ident-deny-admin-panel'`);
  safeExec(db, `UPDATE identity_policies SET id = '29a67ad5-7424-4e81-887b-14b0b9d951bc' WHERE id = 'ident-sensitive-challenge'`);
  // memory_governance_policies
  safeExec(db, `UPDATE memory_governance_policies SET id = 'b15e183e-66e3-4bd2-9b63-7dd540ca65ec' WHERE id = 'mgov-pii-block'`);
  safeExec(db, `UPDATE memory_governance_policies SET id = '9dbbe38c-a0a4-4f42-a1bc-a688d5b67103' WHERE id = 'mgov-conversation-retention'`);
  safeExec(db, `UPDATE memory_governance_policies SET id = '2a97b95b-6f01-4637-bc69-020d0597c02d' WHERE id = 'mgov-semantic-retention'`);
  safeExec(db, `UPDATE memory_governance_policies SET id = 'e6488668-f28f-4574-a7b0-49e45fc8aff2' WHERE id = 'mgov-entity-no-secrets'`);
  // memory_extraction_rules
  safeExec(db, `UPDATE memory_extraction_rules SET id = '64e1189c-3e5a-41f3-ad5d-da4b1e962093' WHERE id = 'mer-self-name'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = '729662dd-644c-4a42-8984-24ed5623bd4c' WHERE id = 'mer-self-location'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = '464f8582-2df1-4b39-9749-a43f7eb21438' WHERE id = 'mer-self-work'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = '16d483a4-c2b9-4fea-9082-6a9bcb43befb' WHERE id = 'mer-entity-name'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = 'e3354de1-15e6-4ecf-ad8e-e4d02127ee26' WHERE id = 'mer-entity-location'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = 'b7f3045d-6428-4f43-bda1-dd3a879f5951' WHERE id = 'mer-entity-work'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = 'dea53647-9c8a-4c29-9e02-5dd297fe9762' WHERE id = 'mer-entity-pref'`);
  // search_providers
  safeExec(db, `UPDATE search_providers SET id = '6fce6815-171b-4d75-8502-65b720b829d3' WHERE id = 'sp-duckduckgo'`);
  safeExec(db, `UPDATE search_providers SET id = '897b8e52-dc64-4854-ac39-65b92e00ccd8' WHERE id = 'sp-brave'`);
  safeExec(db, `UPDATE search_providers SET id = 'f64e9011-5b20-41b0-bea3-6a86359e4f47' WHERE id = 'sp-tavily'`);
  safeExec(db, `UPDATE search_providers SET id = 'e770810c-7033-4fa5-b525-1befa69000dd' WHERE id = 'sp-google-pse'`);
  safeExec(db, `UPDATE search_providers SET id = 'e2f358c3-89c4-48c4-aad2-3fb7153022ad' WHERE id = 'sp-serper'`);
  // http_endpoints
  safeExec(db, `UPDATE http_endpoints SET id = '49f5b2f0-cff1-4446-b318-5598a6b2eab5' WHERE id = 'he-jsonplaceholder'`);
  safeExec(db, `UPDATE http_endpoints SET id = 'ff913bd9-717d-412a-b67f-7b176faad8f3' WHERE id = 'he-weather'`);
  safeExec(db, `UPDATE http_endpoints SET id = 'fca3c3cd-d8a0-46ec-b448-3e12fd466d2f' WHERE id = 'he-ip-info'`);
  // social_accounts
  safeExec(db, `UPDATE social_accounts SET id = '82e7b3d3-7794-4cab-878f-9dfc73ed94dc' WHERE id = 'sa-slack-default'`);
  safeExec(db, `UPDATE social_accounts SET id = 'd1f54eaa-fdf8-4039-aacc-1cfb84e0fe8b' WHERE id = 'sa-discord-default'`);
  safeExec(db, `UPDATE social_accounts SET id = '81de7d85-e393-475b-aee9-c67363eaeda8' WHERE id = 'sa-github-default'`);
  // enterprise_connections
  safeExec(db, `UPDATE enterprise_connections SET id = '43c533a0-3f2e-40ec-bacb-9a9f8a3815ba' WHERE id = 'ec-jira'`);
  safeExec(db, `UPDATE enterprise_connections SET id = '1f9f0fcd-f190-4e0e-8b84-4dc4142554f0' WHERE id = 'ec-confluence'`);
  safeExec(db, `UPDATE enterprise_connections SET id = '3ed738ad-f493-49e7-835f-a2fb4cf159a8' WHERE id = 'ec-salesforce'`);
  safeExec(db, `UPDATE enterprise_connections SET id = '04833867-7e14-43e5-a64a-188f5b004382' WHERE id = 'ec-notion'`);
  // tool_registry
  safeExec(db, `UPDATE tool_registry SET id = '66c73c20-622c-47a3-a21d-210bd8a2eb91' WHERE id = 'tr-search'`);
  safeExec(db, `UPDATE tool_registry SET id = '2891e86c-a4d0-4fbc-8a6c-ede1c717ba89' WHERE id = 'tr-http'`);
  safeExec(db, `UPDATE tool_registry SET id = 'f27606f3-534b-4760-aa95-77dc4e52da3e' WHERE id = 'tr-browser'`);
  safeExec(db, `UPDATE tool_registry SET id = '212ad0f7-2ad2-43e1-94d0-49be0a73d2bf' WHERE id = 'tr-social'`);
  safeExec(db, `UPDATE tool_registry SET id = '0566e9f3-00c5-4ef2-9ac9-7012c477d5fd' WHERE id = 'tr-enterprise'`);
  // response_schemas
  safeExec(db, `UPDATE response_schemas SET id = 'c6c1387d-1cdd-4c7d-8c2a-0964d3481c51' WHERE id = 'rs-greeting'`);
  safeExec(db, `UPDATE response_schemas SET id = '1eef00ae-efa6-49ee-94ee-5c9a9e301e86' WHERE id = 'rs-code-review'`);
  safeExec(db, `UPDATE response_schemas SET id = '6d68edbb-4641-42b3-8de6-26b61faecf17' WHERE id = 'rs-summarization'`);
  // trigger_definitions and FK
  safeExec(db, `UPDATE trigger_definitions SET id = 'b97f561c-b948-447c-8d52-2d1d681a232e' WHERE id = 'trig-daily-eval'`);
  safeExec(db, `UPDATE trigger_definitions SET id = '6e5be73b-49a5-461a-8cfe-4ff5c758955f' WHERE id = 'trig-webhook-deploy'`);
  safeExec(db, `UPDATE trigger_definitions SET id = '43de3406-4ee5-4ea6-b3ef-0ca283afe1a7' WHERE id = 'trig-queue-analysis'`);
  safeExec(db, `UPDATE trigger_definitions SET id = '1ca7843f-9aa0-4298-8bb5-752ad4c263c6' WHERE id = 'trig-model-change'`);
  safeExec(db, `UPDATE trigger_definitions SET target_workflow = '3aedac32-ef1a-429f-89d7-23d481ccd8ad' WHERE target_workflow = 'wf-code-review'`);
  // tenant_configs
  safeExec(db, `UPDATE tenant_configs SET id = '9ce41ecd-202f-49bf-8042-1ff7a296e537' WHERE id = 'tc-default'`);
  safeExec(db, `UPDATE tenant_configs SET id = '0291280f-f15f-44dc-ac95-bc2a61e88cbd' WHERE id = 'tc-enterprise'`);
  safeExec(db, `UPDATE tenant_configs SET id = 'b061bbe6-2ded-4c77-afad-33473b4cb4fa' WHERE id = 'tc-trial'`);
  // sandbox_profiles
  safeExec(db, `UPDATE sandbox_profiles SET id = 'f694e2d8-172c-4ed2-bab7-35720a28149f' WHERE id = 'sbx-strict'`);
  safeExec(db, `UPDATE sandbox_profiles SET id = '1b9b4d0e-5307-439d-9608-cac2695ac07f' WHERE id = 'sbx-moderate'`);
  safeExec(db, `UPDATE sandbox_profiles SET id = 'f7054708-cbbf-48cd-b3db-16271a4adb10' WHERE id = 'sbx-permissive'`);
  // export_configs
  safeExec(db, `UPDATE export_configs SET id = 'dd32d2f8-ccd6-4f93-8aa8-e8859ca9456b' WHERE id = 'ext-full'`);
  safeExec(db, `UPDATE export_configs SET id = '28e7b976-5201-4170-9c7a-ee813e9b2ff5' WHERE id = 'ext-code-only'`);
  safeExec(db, `UPDATE export_configs SET id = 'b3f4b90f-7094-4ae5-bbda-bf3f106b4c7c' WHERE id = 'ext-tasks-timeline'`);
  // artifact_policies
  safeExec(db, `UPDATE artifact_policies SET id = '5cb95d9c-1bfe-4eb3-b1c4-0a2bab12988f' WHERE id = 'artpol-default'`);
  safeExec(db, `UPDATE artifact_policies SET id = 'fb9ad62b-b0ec-4a89-af1c-9cea0e4b9c9a' WHERE id = 'artpol-strict'`);
  safeExec(db, `UPDATE artifact_policies SET id = 'eda3f580-8b10-4d88-b0bc-2f1f5bf1a9a9' WHERE id = 'artpol-large'`);
  // reliability_policies
  safeExec(db, `UPDATE reliability_policies SET id = '7558015a-aacd-4b89-acf1-6f11e6cb4d74' WHERE id = 'rel-retry-default'`);
  safeExec(db, `UPDATE reliability_policies SET id = 'fe035101-0621-43ce-a133-ca8a74022859' WHERE id = 'rel-retry-aggressive'`);
  safeExec(db, `UPDATE reliability_policies SET id = 'eb4778d5-c048-4c54-892a-bcfeb245e95b' WHERE id = 'rel-concurrency-std'`);
  safeExec(db, `UPDATE reliability_policies SET id = 'fbd7d3d6-4e70-47ff-9e2a-4e1e2bb62ef7' WHERE id = 'rel-idempotency'`);
  // collaboration_sessions
  safeExec(db, `UPDATE collaboration_sessions SET id = '24bfff3d-7f7b-4ca2-9711-5be4488215ea' WHERE id = 'collab-pair'`);
  safeExec(db, `UPDATE collaboration_sessions SET id = '4a79d9c8-5959-4839-a653-7caf09583aae' WHERE id = 'collab-team'`);
  safeExec(db, `UPDATE collaboration_sessions SET id = '3893f5a8-d061-43d7-920f-6d82167e54f6' WHERE id = 'collab-broadcast'`);
  // compliance_rules
  safeExec(db, `UPDATE compliance_rules SET id = '726c5bfc-cdb2-47f0-9d08-177f656f6821' WHERE id = 'comp-retention-90d'`);
  safeExec(db, `UPDATE compliance_rules SET id = 'f56c10ea-07b4-4e8e-8824-8a5a50d1ced7' WHERE id = 'comp-gdpr-deletion'`);
  safeExec(db, `UPDATE compliance_rules SET id = 'a8ef9ac5-977a-4a8c-a473-9cae50d0f132' WHERE id = 'comp-eu-residency'`);
  safeExec(db, `UPDATE compliance_rules SET id = '93e3d7d5-80ac-4924-9916-018e44122ad3' WHERE id = 'comp-analytics-consent'`);
  // graph_configs
  safeExec(db, `UPDATE graph_configs SET id = '19d8bf98-fe69-4bfb-84c7-31181f171f28' WHERE id = 'graph-entity'`);
  safeExec(db, `UPDATE graph_configs SET id = '0abab6b4-93cc-4664-a99d-200bd9378dee' WHERE id = 'graph-timeline'`);
  safeExec(db, `UPDATE graph_configs SET id = '27efa1f1-bec8-4c09-a7a3-c2e472b1125d' WHERE id = 'graph-knowledge'`);
  // plugins
  safeExec(db, `UPDATE plugins SET id = '1a4cac30-57a8-4853-b2d9-e8048ade5fc5' WHERE id = 'plug-code-exec'`);
  safeExec(db, `UPDATE plugins SET id = '0146baef-15d0-40ec-98f0-40c88f34b9b3' WHERE id = 'plug-web-search'`);
  safeExec(db, `UPDATE plugins SET id = 'ad0e5e5b-4af3-4bd9-84e3-5fc2b84bb465' WHERE id = 'plug-community-viz'`);
  safeExec(db, `UPDATE plugins SET id = 'b9550588-d6e3-4d8f-961f-93ed1d841671' WHERE id = 'plug-enterprise-sso'`);
  // scaffolds
  safeExec(db, `UPDATE scaffolds SET id = 'd2d4c9c7-4f26-4de8-b8b9-21c1caadf3d1' WHERE id = 'scaf-basic-agent'`);
  safeExec(db, `UPDATE scaffolds SET id = '238db0e5-0a97-408a-87ea-411b7bb90556' WHERE id = 'scaf-tool-agent'`);
  safeExec(db, `UPDATE scaffolds SET id = '955d8720-fb97-41e2-8e21-f6f5ed8bd944' WHERE id = 'scaf-rag-pipeline'`);
  safeExec(db, `UPDATE scaffolds SET id = 'b65b2a2d-6173-49bf-af09-5fbaf48d1b92' WHERE id = 'scaf-workflow'`);
  safeExec(db, `UPDATE scaffolds SET id = 'b1d3f948-420e-4798-8c16-99c8b0cc46a3' WHERE id = 'scaf-multi-agent'`);
  safeExec(db, `UPDATE scaffolds SET id = 'b61ad2bf-cce5-4989-8800-d51e092fc309' WHERE id = 'scaf-mcp-server'`);
  safeExec(db, `UPDATE scaffolds SET id = 'e27a18c3-7718-46e0-9f71-425ec51802b0' WHERE id = 'scaf-full-stack'`);
  // recipe_configs
  safeExec(db, `UPDATE recipe_configs SET id = '762dba63-d819-4f85-a86f-5f6788c42c99' WHERE id = 'rcp-workflow'`);
  safeExec(db, `UPDATE recipe_configs SET id = '5a5b3951-4ca6-49b8-9ab4-b09a679e5275' WHERE id = 'rcp-governed'`);
  safeExec(db, `UPDATE recipe_configs SET id = 'b046bcff-9950-46bf-b107-ab6baf097240' WHERE id = 'rcp-approval'`);
  safeExec(db, `UPDATE recipe_configs SET id = '58bea5c2-662b-4c41-9f8e-203c59885931' WHERE id = 'rcp-acl-rag'`);
  safeExec(db, `UPDATE recipe_configs SET id = 'ddfd4301-7bf5-459c-a458-59785c6d6995' WHERE id = 'rcp-safe-exec'`);
  // widgets
  safeExec(db, `UPDATE widgets SET id = 'd309940a-bd09-4899-ace5-a0acd53f2325' WHERE id = 'wgt-table'`);
  safeExec(db, `UPDATE widgets SET id = '7fe15c63-2ffd-413f-93e8-1681d5dc5c5b' WHERE id = 'wgt-chart'`);
  safeExec(db, `UPDATE widgets SET id = 'a3b5a4a7-6cd7-45b6-9715-3221ede6e2f0' WHERE id = 'wgt-form'`);
  safeExec(db, `UPDATE widgets SET id = '4d57f558-6068-44ff-9f45-354696fcdb59' WHERE id = 'wgt-code'`);
  safeExec(db, `UPDATE widgets SET id = '464ec787-112f-413f-a376-ce534a3c505c' WHERE id = 'wgt-timeline'`);
  safeExec(db, `UPDATE widgets SET id = '337c379d-22df-44af-980c-04c453398169' WHERE id = 'wgt-image'`);
  // validation_rules
  safeExec(db, `UPDATE validation_rules SET id = '940eb416-6e60-47bc-9d7d-3fca55c7b98d' WHERE id = 'val-agent-name'`);
  safeExec(db, `UPDATE validation_rules SET id = '014b4186-c36f-4f61-b8c3-bf2545023199' WHERE id = 'val-agent-steps'`);
  safeExec(db, `UPDATE validation_rules SET id = 'c5985869-b721-40a2-b4ef-529bb975c84c' WHERE id = 'val-workflow-entry'`);
  safeExec(db, `UPDATE validation_rules SET id = 'b6490a1a-2ddf-41ad-9a7b-6d406808cf86' WHERE id = 'val-tool-risk'`);
  safeExec(db, `UPDATE validation_rules SET id = '892adcec-808b-4c17-bc2c-c5c45cfe47fb' WHERE id = 'val-json-fields'`);

  // Phase 1: tool_configs → tool_catalog migration
  // Copy existing tool_configs data into tool_catalog (for existing databases upgrading from pre-Phase-1).
  // safeExec swallows the error on fresh installs where tool_configs does not exist.
  safeExec(db, `
    INSERT OR IGNORE INTO tool_catalog (id, name, description, category, risk_level, requires_approval, max_execution_ms, rate_limit_per_min, enabled, created_at, updated_at)
    SELECT id, name, description, category, risk_level, requires_approval, max_execution_ms, rate_limit_per_min, enabled, created_at, updated_at
    FROM tool_configs
  `);
  // Add new Phase 1 columns to tool_catalog (no-op if already present).
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN tool_key TEXT`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN version TEXT NOT NULL DEFAULT '1.0'`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN side_effects INTEGER NOT NULL DEFAULT 0`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN tags TEXT`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin'`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN credential_id TEXT`);
  // Backfill tool_key for the 6 builtin seed records.
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'web_search' WHERE id = 'a7bd3e9f-9b1b-4aa6-9520-8f5fb194a5e3' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'cse_run_code' WHERE id = '8e6c2528-f5a0-4d5a-a719-b60cc660f353' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'file_reader' WHERE id = 'bca36e31-bf3b-4761-89ba-0f1edecf22cf' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'database_query' WHERE id = '9bbd1c34-35a1-442f-b2bb-d5d6f568f57a' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'api_caller' WHERE id = '31755606-4e34-44be-a101-cee78d49f6e1' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'statsnz_get_data' WHERE id = '220dd56e-5c1c-4dad-93c8-befa5d7588f5' AND tool_key IS NULL`);

  // Phase 2: Create tool_policies and tool_rate_limit_buckets tables (no-op on fresh installs).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_policies (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      applies_to TEXT,
      applies_to_risk_levels TEXT,
      approval_required INTEGER NOT NULL DEFAULT 0,
      allowed_risk_levels TEXT,
      max_execution_ms INTEGER,
      rate_limit_per_minute INTEGER,
      max_concurrent INTEGER,
      require_dry_run INTEGER NOT NULL DEFAULT 0,
      log_input_output INTEGER NOT NULL DEFAULT 1,
      persona_scope TEXT,
      active_hours_utc TEXT,
      expires_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_rate_limit_buckets (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tool_name, scope_key, window_start)
    )
  `);

  // Phase 2: Seed 4 default tool policies (idempotent via INSERT OR IGNORE).
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('e1a2b3c4-d5e6-47f8-a9b0-c1d2e3f4a5b6', 'default', 'Default Policy',
       'Baseline policy applied to all tools. Logs I/O, 60 req/min, all risk levels allowed. Override with a more specific policy per tool or skill.',
       NULL, NULL, 0,
       '["read-only","write","destructive","privileged","financial","external-side-effect"]',
       NULL, 60, NULL, 0, 1, NULL, 1)
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('f2b3c4d5-e6f7-48a9-b0c1-d2e3f4a5b6c7', 'strict_external', 'Strict External Policy',
       'Applied to tools that make outbound web or API calls. Limits to 20 req/min and enforces full I/O logging for compliance and cost visibility.',
       '["web_search","api_caller","browser_screenshot","browser_navigate"]', NULL, 0,
       '["read-only","external-side-effect"]',
       15000, 20, NULL, 0, 1, NULL, 1)
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('a3c4d5e6-f7a8-49b0-c1d2-e3f4a5b6c7d8', 'destructive_gate', 'Destructive Gate Policy',
       'Requires human approval before any tool invocation classified as destructive, privileged, or financial risk. Attach to skills or agent personas handling sensitive operations.',
       NULL, '["destructive","privileged","financial"]', 1,
       '["destructive","privileged","financial"]',
       NULL, NULL, 1, 1, 1, NULL, 1)
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('b4d5e6f7-a8b9-40c1-d2e3-f4a5b6c7d8e9', 'read_only', 'Read-Only Policy',
       'Restricts tool usage to read-only risk level only. Use with agent personas that must not have side effects — research agents, summarizers, and audit bots.',
       NULL, NULL, 0,
       '["read-only"]',
       10000, 120, NULL, 0, 0, NULL, 1)
  `);

  // Phase 3: Audit Trail + Health Persistence
  // Immutable append-only log of every tool invocation.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_audit_events (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      chat_id TEXT,
      user_id TEXT,
      agent_persona TEXT,
      skill_key TEXT,
      policy_id TEXT,
      outcome TEXT NOT NULL,
      violation_reason TEXT,
      duration_ms INTEGER,
      input_preview TEXT,
      output_preview TEXT,
      error_message TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_tool_name ON tool_audit_events(tool_name)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_chat_id ON tool_audit_events(chat_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_outcome ON tool_audit_events(outcome)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_created_at ON tool_audit_events(created_at)`);

  // Persisted health aggregates written every 15 minutes by the background health job.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_health_snapshots (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      snapshot_at TEXT NOT NULL,
      invocation_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      denied_count INTEGER NOT NULL DEFAULT 0,
      avg_duration_ms REAL,
      p95_duration_ms REAL,
      error_rate REAL NOT NULL DEFAULT 0,
      availability REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_health_name_time ON tool_health_snapshots(tool_name, snapshot_at)`);

  // ─── Phase 4: Tool Credentials ────────────────────────────
  // Stores external API credentials bound to tools. The credential secret
  // lives in the referenced environment variable (env_var_name) so no plaintext
  // secrets are persisted. The config JSON carries transport metadata such as
  // header name and value prefix.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      credential_type TEXT NOT NULL DEFAULT 'api_key',
      tool_names TEXT,
      env_var_name TEXT,
      config TEXT,
      rotation_due_at TEXT,
      validation_status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_credentials_enabled ON tool_credentials(enabled)`);

  // Add config column to tool_catalog for MCP endpoint / A2A agent URL storage.
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN config TEXT`);

  // ─── Phase 6: Skill → Tool Policy Closure ────────────────
  // Adds tool_policy_key to skills so each skill can declare which tool policy
  // governs tool calls made during its activation window.
  safeExec(db, `ALTER TABLE skills ADD COLUMN tool_policy_key TEXT`);

  // Creates the tool_approval_requests table used by DbToolApprovalGate to
  // persist pending/approved/denied approval decisions for tools that require
  // operator approval before execution.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_approval_requests (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      user_id TEXT,
      input_json TEXT NOT NULL DEFAULT '{}',
      policy_key TEXT,
      skill_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_approval_chat ON tool_approval_requests(chat_id, status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_approval_tool ON tool_approval_requests(tool_name, status)`);

  // ── Hypothesis Validation — Phase 2 bootstrap migrations ──
  // Canonical tables are hv_*. Existing sv_* deployments are backfilled.

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_budget_envelope (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      max_llm_cents INTEGER NOT NULL,
      max_sandbox_cents INTEGER NOT NULL,
      max_wall_seconds INTEGER NOT NULL,
      max_rounds INTEGER NOT NULL,
      diminishing_returns_epsilon REAL NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_hypothesis (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      title TEXT NOT NULL,
      statement TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','verdict','abandoned')),
      budget_envelope_id TEXT NOT NULL REFERENCES hv_budget_envelope(id),
      workflow_run_id TEXT,
      trace_id TEXT,
      contract_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_hypothesis_tenant ON hv_hypothesis(tenant_id, created_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_hypothesis_status ON hv_hypothesis(tenant_id, status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_sub_claim (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
      parent_sub_claim_id TEXT REFERENCES hv_sub_claim(id),
      statement TEXT NOT NULL,
      claim_type TEXT NOT NULL
        CHECK (claim_type IN ('mechanism','epidemiological','mathematical','dose_response','causal','other')),
      testability_score REAL NOT NULL CHECK (testability_score BETWEEN 0 AND 1),
      created_at TEXT NOT NULL
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_sub_claim_hypothesis ON hv_sub_claim(hypothesis_id)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_verdict (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      hypothesis_id TEXT NOT NULL UNIQUE REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL
        CHECK (verdict IN ('supported','refuted','inconclusive','ill_posed','out_of_scope')),
      confidence_lo REAL NOT NULL CHECK (confidence_lo BETWEEN 0 AND 1),
      confidence_hi REAL NOT NULL CHECK (confidence_hi BETWEEN 0 AND 1),
      key_evidence_ids TEXT NOT NULL,
      falsifiers TEXT NOT NULL,
      limitations TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      replay_trace_id TEXT NOT NULL,
      emitted_by TEXT NOT NULL DEFAULT 'supervisor',
      created_at TEXT NOT NULL,
      CHECK (confidence_lo <= confidence_hi)
    )
  `);

  // ── worker_agents: add category column ──────────────────────────────────────
  // Existing DBs need the column added. New DBs get it from CREATE TABLE.
  safeExec(db, `ALTER TABLE worker_agents ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
  safeExec(db, `ALTER TABLE worker_agents ADD COLUMN display_name TEXT`);
  safeExec(db, `ALTER TABLE worker_agents ADD COLUMN job_profile TEXT`);
  safeExec(db, `
    UPDATE worker_agents
    SET display_name = CASE name
      WHEN 'code_executor' THEN 'Casey'
      WHEN 'statsnz_specialist' THEN 'Nia'
      WHEN 'researcher' THEN 'Riley'
      WHEN 'analyst' THEN 'Avery'
      WHEN 'writer' THEN 'Wren'
      WHEN 'sv-supervisor' THEN 'geneWeave'
      WHEN 'sv-decomposer' THEN 'Dylan'
      WHEN 'sv-literature' THEN 'Larry'
      WHEN 'sv-statistical' THEN 'Stella'
      WHEN 'sv-mathematical' THEN 'Max'
      WHEN 'sv-simulation' THEN 'Sima'
      WHEN 'sv-adversarial' THEN 'Ada'
      ELSE name
    END
    WHERE COALESCE(display_name, '') = ''
  `);
  safeExec(db, `
    UPDATE worker_agents
    SET job_profile = CASE name
      WHEN 'code_executor' THEN 'Code Execution Specialist'
      WHEN 'statsnz_specialist' THEN 'NZ Data Specialist'
      WHEN 'researcher' THEN 'Research Specialist'
      WHEN 'analyst' THEN 'Data Analyst'
      WHEN 'writer' THEN 'Writing Specialist'
      WHEN 'sv-supervisor' THEN 'Hypothesis Validation Supervisor'
      WHEN 'sv-decomposer' THEN 'Claim Decomposition Specialist'
      WHEN 'sv-literature' THEN 'Literator validator'
      WHEN 'sv-statistical' THEN 'Statistical Validator'
      WHEN 'sv-mathematical' THEN 'Mathematical Validator'
      WHEN 'sv-simulation' THEN 'Simulation Validator'
      WHEN 'sv-adversarial' THEN 'Adversarial Validator'
      ELSE 'Worker Agent'
    END
    WHERE COALESCE(job_profile, '') = ''
  `);

  // ── hv_evidence_event and hv_agent_turn ─────────────────────────────────────
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_evidence_event (
      id TEXT PRIMARY KEY,
      hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'model_inference',
      tool_key TEXT,
      reproducibility_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_evidence_hypothesis ON hv_evidence_event(hypothesis_id, created_at ASC)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_agent_turn (
      id TEXT PRIMARY KEY,
      hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
      round_index INTEGER NOT NULL DEFAULT 0,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      message TEXT NOT NULL,
      cites_evidence_ids TEXT NOT NULL DEFAULT '[]',
      dissent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_agent_turn_hypothesis ON hv_agent_turn(hypothesis_id, created_at ASC)`);

  // Backfill from legacy sv_* tables for existing installations.
  safeExec(db, `
    INSERT OR IGNORE INTO hv_budget_envelope
    (id, tenant_id, name, max_llm_cents, max_sandbox_cents, max_wall_seconds, max_rounds, diminishing_returns_epsilon, created_at)
    SELECT id, tenant_id, name, max_llm_cents, max_sandbox_cents, max_wall_seconds, max_rounds, diminishing_returns_epsilon, created_at
    FROM sv_budget_envelope
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_hypothesis
    (id, tenant_id, submitted_by, title, statement, domain_tags, status, budget_envelope_id, workflow_run_id, trace_id, contract_id, created_at, updated_at)
    SELECT id, tenant_id, submitted_by, title, statement, domain_tags, status, budget_envelope_id, workflow_run_id, trace_id, contract_id, created_at, updated_at
    FROM sv_hypothesis
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_sub_claim
    (id, tenant_id, hypothesis_id, parent_sub_claim_id, statement, claim_type, testability_score, created_at)
    SELECT id, tenant_id, hypothesis_id, parent_sub_claim_id, statement, claim_type, testability_score, created_at
    FROM sv_sub_claim
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_verdict
    (id, tenant_id, hypothesis_id, verdict, confidence_lo, confidence_hi, key_evidence_ids, falsifiers, limitations, contract_id, replay_trace_id, emitted_by, created_at)
    SELECT id, tenant_id, hypothesis_id, verdict, confidence_lo, confidence_hi, key_evidence_ids, falsifiers, limitations, contract_id, replay_trace_id, emitted_by, created_at
    FROM sv_verdict
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_evidence_event
    (id, hypothesis_id, step_id, agent_id, evidence_id, kind, summary, source_type, tool_key, reproducibility_hash, created_at)
    SELECT id, hypothesis_id, step_id, agent_id, evidence_id, kind, summary, source_type, tool_key, reproducibility_hash, created_at
    FROM sv_evidence_event
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_agent_turn
    (id, hypothesis_id, round_index, from_agent, to_agent, message, cites_evidence_ids, dissent, created_at)
    SELECT id, hypothesis_id, round_index, from_agent, to_agent, message, cites_evidence_ids, dissent, created_at
    FROM sv_agent_turn
  `);

  // ── Hypothesis Validation tool policy ────────────────────────────────────────
  // A dedicated policy for the hypothesis-validation tools so operators can tune rate limits,
  // execution timeouts, and logging without touching the default policy.
  // All SV tools are external-side-effect (container compute or external HTTP).
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('c5e6f7a8-b9c0-41d2-e3f4-a5b6c7d8e9f0', 'hypothesis_validation', 'Hypothesis Validation Policy',
       'Governs sandboxed and evidence tools used by hypothesis-validation workflows. Allows external-side-effect and read-only risk levels. 60 s max execution for container tools. 30 req/min per scope. Full I/O logging for reproducibility audits.',
       '["sympy.simplify","sympy.solve","sympy.integrate","wolfram.query","scipy.stats","scipy.meta","scipy.power","pymc.sample","r.meta","rdkit.describe","rdkit.similarity","biopython.align","networkx.analyse","arxiv.search","pubmed.search","semanticscholar.search","openalex.search","crossref.resolve","europepmc.search"]',
       NULL, 0,
       '["read-only","external-side-effect"]',
       60000, 30, NULL, 0, 1, NULL, 1)
  `);

  // Backward-compatible alias key for existing skill configurations.
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    SELECT
      'd6f7a8b9-c0d1-42e3-f4a5-b6c7d8e9f011',
      'scientific_validation',
      'Scientific Validation Policy (Alias)',
      description,
      applies_to,
      applies_to_risk_levels,
      approval_required,
      allowed_risk_levels,
      max_execution_ms,
      rate_limit_per_minute,
      max_concurrent,
      require_dry_run,
      log_input_output,
      persona_scope,
      enabled
    FROM tool_policies
    WHERE key = 'hypothesis_validation'
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1B — DB-driven supervisor agents
  //
  // The `agents` table is the operator-managed registry of supervisor (and
  // future specialist) agent definitions. Tool allocation is decoupled into
  // `agent_tools` so a single agent row can claim a curated bundle without
  // string-encoded JSON. Resolution at runtime is layered:
  //   skill.supervisor_agent_id -> tenant_id+category -> global+category -> is_default=1
  //
  // This phase is additive; chat.ts continues to honour package defaults when
  // no row resolves, and worker_agents/skills tables are untouched apart from
  // an optional `supervisor_agent_id` column on `skills`.
  // ─────────────────────────────────────────────────────────────────────────
  safeExec(db, `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    name TEXT NOT NULL,
    display_name TEXT,
    description TEXT,
    system_prompt TEXT,
    include_utility_tools INTEGER NOT NULL DEFAULT 1,
    default_timezone TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_agents_tenant_category ON agents(tenant_id, category, enabled)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_agents_default ON agents(is_default, enabled)');

  safeExec(db, `CREATE TABLE IF NOT EXISTS agent_tools (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    allocation TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY(agent_id, tool_name)
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id)');

  // Skills may pin a specific supervisor agent (highest precedence at resolve time).
  safeExec(db, 'ALTER TABLE skills ADD COLUMN supervisor_agent_id TEXT');

  // Tool catalog gains an allocation_class hint so operators can flag which
  // tools are appropriate for supervisor-level vs worker-level binding.
  // Values: 'supervisor' | 'worker' | 'shared' | NULL (unspecified).
  safeExec(db, 'ALTER TABLE tool_catalog ADD COLUMN allocation_class TEXT');

  // ─── Phase 5: Per-client MCP gateway tokens ───────────────
  // Stores SHA-256 hashes of per-client bearer tokens so external MCP
  // callers can be individually attributed in audit events and scoped to a
  // subset of allocation classes. The plaintext token is never stored —
  // only the digest. token_lookup is the same digest used as a fast index
  // on bearer-token presentation. allowed_classes is a JSON array; when
  // null the client inherits the gateway-wide exposed_classes set.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS mcp_gateway_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      allowed_classes TEXT,
      audit_chat_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_clients_hash ON mcp_gateway_clients(token_hash)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_clients_enabled ON mcp_gateway_clients(enabled)`);

  // Phase 7: per-client rate limit. Nullable column = no per-client cap.
  // safeExec swallows the duplicate-column error so this is idempotent on
  // existing databases.
  safeExec(db, `ALTER TABLE mcp_gateway_clients ADD COLUMN rate_limit_per_minute INTEGER`);

  // Phase 9: token expiry + rotation tracking. expires_at NULL = no expiry.
  // rotated_at NULL = never rotated since creation. Both idempotent via
  // safeExec.
  safeExec(db, `ALTER TABLE mcp_gateway_clients ADD COLUMN expires_at TEXT`);
  safeExec(db, `ALTER TABLE mcp_gateway_clients ADD COLUMN rotated_at TEXT`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_clients_expires ON mcp_gateway_clients(expires_at)`);

  // Phase 7: tumbling 1-minute buckets for per-client rate limiting. Mirrors
  // the tool_rate_limit_buckets pattern but scoped to gateway clients only.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS mcp_gateway_rate_buckets (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(client_id, window_start)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_rate_buckets_client ON mcp_gateway_rate_buckets(client_id, window_start)`);

  // Phase 8: gateway request log. Captures every terminal outcome
  // (ok / rate_limited / unauthorized / error) so operators can audit
  // traffic per client without having to reconstruct it from
  // tool_audit_events (which only fires for tool invocations and not
  // for tools/list, denied auth, or 429 rate-limited responses).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS mcp_gateway_request_log (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      client_name TEXT,
      method TEXT,
      tool_name TEXT,
      outcome TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      duration_ms INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gw_req_log_created ON mcp_gateway_request_log(created_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gw_req_log_client ON mcp_gateway_request_log(client_id, created_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gw_req_log_outcome ON mcp_gateway_request_log(outcome, created_at DESC)`);

  // Domain-scoped sub-playbooks: JSON array of {key,label?,content,tags?}.
  // Each section becomes an optional, query-scorable PromptSection at render
  // time so a sales-only query keeps only the sales subsection in the
  // supervisor system prompt instead of the full multi-domain playbook.
  safeExec(db, 'ALTER TABLE skills ADD COLUMN domain_sections TEXT');

  // Machine-enforced execution contract: JSON object with optional
  // minDelegations / requiredOutputSubstrings / requiredOutputPatterns.
  // The chat runtime extracts this via extractSkillExecutionContractsFromPrompt
  // and validates the agent result, reporting concrete deltas on failure
  // instead of an opaque "skill plan was selected but not followed" error.
  safeExec(db, 'ALTER TABLE skills ADD COLUMN execution_contract TEXT');

  // ─── anyWeave Task-Aware Routing — Phase 1 ────────────────
  // Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md
  // All tables use UUID PKs (TEXT). Idempotent: CREATE IF NOT EXISTS / safeExec ALTERs.

  // M1 — Task type taxonomy. 16 seed rows live in seedDefaultData().
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS task_type_definitions (
      id              TEXT PRIMARY KEY,
      task_key        TEXT NOT NULL UNIQUE,
      display_name    TEXT NOT NULL,
      category        TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      output_modality TEXT NOT NULL,
      default_strategy TEXT NOT NULL,
      default_weights TEXT NOT NULL DEFAULT '{"cost":0.25,"speed":0.25,"quality":0.25,"capability":0.25}',
      inference_hints TEXT NOT NULL DEFAULT '{}',
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_task_types_category ON task_type_definitions(category, enabled)');

  // M2 — Per-(tenant?, model, provider, task_key) quality + capability flags.
  // tenant_id NULL = global default. Absence of a row = model excluded from candidate pool for that task.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS model_capability_scores (
      id                  TEXT PRIMARY KEY,
      tenant_id           TEXT,
      model_id            TEXT NOT NULL,
      provider            TEXT NOT NULL,
      task_key            TEXT NOT NULL,
      quality_score       REAL NOT NULL,
      supports_tools      INTEGER NOT NULL DEFAULT 1,
      supports_streaming  INTEGER NOT NULL DEFAULT 1,
      supports_thinking   INTEGER NOT NULL DEFAULT 0,
      supports_json_mode  INTEGER NOT NULL DEFAULT 0,
      supports_vision     INTEGER NOT NULL DEFAULT 0,
      max_output_tokens   INTEGER,
      benchmark_source    TEXT,
      raw_benchmark_score REAL,
      is_active           INTEGER NOT NULL DEFAULT 1,
      last_evaluated_at   TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, model_id, provider, task_key)
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_capability_lookup ON model_capability_scores(task_key, is_active, tenant_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_capability_model ON model_capability_scores(model_id, provider)');

  // M3 — Per-tenant task-type overrides (weights, preferred model, cost ceiling).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS task_type_tenant_overrides (
      id                    TEXT PRIMARY KEY,
      tenant_id             TEXT NOT NULL,
      task_key              TEXT NOT NULL,
      weights               TEXT,
      preferred_model_id    TEXT,
      preferred_provider    TEXT,
      preferred_boost_pct   REAL NOT NULL DEFAULT 20,
      cost_ceiling_per_call REAL,
      optimisation_strategy TEXT,
      enabled               INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, task_key)
    )
  `);

  // M4 — Provider tool-format adapter configuration. Replaces hardcoded
  // buildAnthropicTools / buildOpenAITools logic with DB-driven mapping rules
  // consumed by @weaveintel/tools/schema (Phase 3).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS provider_tool_adapters (
      id                        TEXT PRIMARY KEY,
      provider                  TEXT NOT NULL UNIQUE,
      display_name              TEXT NOT NULL,
      adapter_module            TEXT NOT NULL,
      tool_format               TEXT NOT NULL,
      tool_call_response_format TEXT NOT NULL,
      tool_result_format        TEXT NOT NULL,
      system_prompt_location    TEXT NOT NULL DEFAULT 'system_message',
      name_validation_regex     TEXT NOT NULL DEFAULT '^[a-zA-Z0-9_-]{1,64}$',
      max_tool_count            INTEGER NOT NULL DEFAULT 128,
      enabled                   INTEGER NOT NULL DEFAULT 1,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // M6 — Persistent routing decision trace (replaces in-memory DecisionStore for prod use).
  // UUID v7 PK keeps inserts naturally sortable by time.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS routing_decision_traces (
      id                        TEXT PRIMARY KEY,
      tenant_id                 TEXT,
      agent_id                  TEXT,
      workflow_step_id          TEXT,
      task_key                  TEXT,
      inference_source          TEXT,
      selected_model_id         TEXT NOT NULL,
      selected_provider         TEXT NOT NULL,
      selected_capability_score REAL,
      weights_used              TEXT NOT NULL,
      candidate_breakdown       TEXT NOT NULL,
      tool_translation_applied  INTEGER NOT NULL DEFAULT 0,
      source_provider           TEXT,
      estimated_cost_usd        REAL,
      decided_at                TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_decision_task ON routing_decision_traces(task_key, decided_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_decision_tenant ON routing_decision_traces(tenant_id, decided_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_decision_agent ON routing_decision_traces(agent_id, decided_at)');

  // M7 — Agent routing fields.
  safeExec(db, 'ALTER TABLE agents ADD COLUMN default_task_type TEXT');
  safeExec(db, 'ALTER TABLE agents ADD COLUMN allowed_task_types TEXT');     // JSON string[]
  safeExec(db, 'ALTER TABLE agents ADD COLUMN preferred_models TEXT');       // JSON {[taskKey]: {modelId, provider}}
  safeExec(db, 'ALTER TABLE agents ADD COLUMN cost_ceiling_per_call REAL');

  // M8 — Output modality on the existing model_pricing table so the routing
  // filter can exclude text-only LLMs from image/audio/embedding tasks.
  safeExec(db, "ALTER TABLE model_pricing ADD COLUMN output_modality TEXT NOT NULL DEFAULT 'text'");

  // Multi-hop fallback chain (JSON [{modelId, provider, priority}]).
  // The single fallback_model/fallback_provider columns remain for
  // backward compatibility — Phase 2 router prefers the chain when present.
  safeExec(db, 'ALTER TABLE routing_policies ADD COLUMN fallback_chain TEXT');

  // ─── anyWeave Task-Aware Routing — Phase 5: Feedback loop ──
  // Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md §13 Phase 5
  //
  // Four signal channels feed quality_score in model_capability_scores:
  //   1. eval        — eval engine results
  //   2. chat        — 👍/👎/regenerate/copy from chat UI
  //   3. cache       — cache admission quality scores
  //   4. production  — tool-call validity / json compliance / completion
  //
  // routing_capability_signals is the append-only ledger; recompute jobs
  // produce rolling averages and write back to model_capability_scores.

  // Append-only signal log. UUID v7 PK keeps inserts naturally sortable.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS routing_capability_signals (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT,
      model_id      TEXT NOT NULL,
      provider      TEXT NOT NULL,
      task_key      TEXT NOT NULL,
      source        TEXT NOT NULL,
      signal_type   TEXT NOT NULL,
      value         REAL NOT NULL,
      weight        REAL NOT NULL DEFAULT 1.0,
      evidence_id   TEXT,
      message_id    TEXT,
      trace_id      TEXT,
      metadata      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_signals_lookup ON routing_capability_signals(model_id, provider, task_key, created_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_signals_source ON routing_capability_signals(source, created_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_signals_tenant ON routing_capability_signals(tenant_id, created_at)');

  // Per-message user feedback. signal ∈ {thumbs_up, thumbs_down, regenerate, copy}.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS message_feedback (
      id          TEXT PRIMARY KEY,
      message_id  TEXT NOT NULL,
      chat_id     TEXT,
      user_id     TEXT,
      signal      TEXT NOT NULL,
      comment     TEXT,
      model_id    TEXT,
      provider    TEXT,
      task_key    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_feedback_message ON message_feedback(message_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_feedback_signal ON message_feedback(signal, created_at)');

  // Regression / surface-item alerts emitted by the regression detection job.
  // status ∈ {open, acknowledged, resolved}.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS routing_surface_items (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      severity        TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      provider        TEXT NOT NULL,
      task_key        TEXT NOT NULL,
      tenant_id       TEXT,
      message         TEXT NOT NULL,
      metric_7d       REAL,
      metric_30d      REAL,
      drop_pct        REAL,
      sample_count_7d INTEGER,
      sample_count_30d INTEGER,
      auto_disabled   INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_surface_status ON routing_surface_items(status, created_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_surface_model ON routing_surface_items(model_id, provider, task_key)');

  // Production signal score (separate from benchmark quality_score).
  // Updated by the production telemetry channel; surfaced in the simulator
  // for operators to compare benchmark vs lived-experience quality.
  safeExec(db, 'ALTER TABLE model_capability_scores ADD COLUMN production_signal_score REAL');
  safeExec(db, 'ALTER TABLE model_capability_scores ADD COLUMN signal_sample_count INTEGER NOT NULL DEFAULT 0');

  // ─── anyWeave Task-Aware Routing — Phase 6: Production hardening ──
  // Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md §13 Phase 6
  // A/B routing experiments — route a percentage of traffic for a given
  // (task_key, tenant_id) tuple from a baseline model to a candidate model.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS routing_experiments (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      description           TEXT,
      tenant_id             TEXT,
      task_key              TEXT,
      baseline_provider     TEXT NOT NULL,
      baseline_model_id     TEXT NOT NULL,
      candidate_provider    TEXT NOT NULL,
      candidate_model_id    TEXT NOT NULL,
      traffic_pct           REAL NOT NULL DEFAULT 10,
      status                TEXT NOT NULL DEFAULT 'active',
      metadata              TEXT,
      started_at            TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at              TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_experiments_lookup ON routing_experiments(status, task_key, tenant_id)');

  // ─── M9 — Backfill model_pricing for new providers (Gemini / Ollama / llama.cpp) ──
  // Existing databases skipped these rows in seedDefaultData() because the table
  // was non-empty. Insert any missing rows idempotently with INSERT OR IGNORE so
  // routing/admin surfaces immediately know about the new providers.
  const PRICING_BACKFILL: Array<[string, string, string, string, number, number, number]> = [
    // [id, model_id, provider, display_name, input/1M, output/1M, quality]
    ['a1b2c3d4-0001-4000-8000-000000000001', 'gemini-2.5-pro',        'google',   'Gemini 2.5 Pro',        1.25,   10.00, 0.92],
    ['a1b2c3d4-0001-4000-8000-000000000002', 'gemini-2.5-flash',      'google',   'Gemini 2.5 Flash',      0.30,   2.50,  0.82],
    ['a1b2c3d4-0001-4000-8000-000000000003', 'gemini-2.5-flash-lite', 'google',   'Gemini 2.5 Flash Lite', 0.10,   0.40,  0.72],
    ['a1b2c3d4-0001-4000-8000-000000000004', 'gemini-1.5-pro',        'google',   'Gemini 1.5 Pro',        1.25,   5.00,  0.85],
    ['a1b2c3d4-0001-4000-8000-000000000005', 'gemini-1.5-flash',      'google',   'Gemini 1.5 Flash',      0.075,  0.30,  0.72],
    ['a1b2c3d4-0002-4000-8000-000000000001', 'llama3.1',              'ollama',   'Llama 3.1 (local)',     0,      0,     0.72],
    ['a1b2c3d4-0002-4000-8000-000000000002', 'llama3',                'ollama',   'Llama 3 (local)',       0,      0,     0.70],
    ['a1b2c3d4-0002-4000-8000-000000000003', 'qwen2.5',               'ollama',   'Qwen 2.5 (local)',      0,      0,     0.74],
    ['a1b2c3d4-0002-4000-8000-000000000004', 'mistral',               'ollama',   'Mistral (local)',       0,      0,     0.68],
    ['a1b2c3d4-0002-4000-8000-000000000005', 'phi3',                  'ollama',   'Phi 3 (local)',         0,      0,     0.65],
    ['a1b2c3d4-0002-4000-8000-000000000006', 'gemma2',                'ollama',   'Gemma 2 (local)',       0,      0,     0.66],
    ['a1b2c3d4-0002-4000-8000-000000000007', 'deepseek-r1',           'ollama',   'DeepSeek R1 (local)',   0,      0,     0.80],
    ['a1b2c3d4-0003-4000-8000-000000000001', 'local',                 'llamacpp', 'llama.cpp local model', 0,      0,     0.70],
  ];
  const insertPricing = db.prepare(
    `INSERT OR IGNORE INTO model_pricing
       (id, model_id, provider, display_name, input_cost_per_1m, output_cost_per_1m, quality_score, source, last_synced_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', NULL, 1)`,
  );
  for (const row of PRICING_BACKFILL) {
    try { insertPricing.run(...row); } catch { /* ignore */ }
  }

  // ─── M10 — Kaggle MCP tool catalog + credential seed (Phase K1) ──
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §4.1 + §8 (Phase K1).
  // Seeds one credential row pointing at KAGGLE_USERNAME/KAGGLE_KEY env vars
  // and 13 read-only Kaggle MCP tools backed by the ../kaggle/index.js
  // server. Rows are disabled by default — the operator must:
  //   (a) provision KAGGLE_USERNAME + KAGGLE_KEY in the runtime environment,
  //   (b) start the Kaggle MCP server (see examples/38-kaggle-mcp-readonly.ts),
  //   (c) flip enabled=1 in the Tool Catalog admin tab.
  // Fixed deterministic UUIDs so re-runs are idempotent via INSERT OR IGNORE.
  safeExec(db, `INSERT OR IGNORE INTO tool_credentials (
      id, name, description, credential_type, tool_names, env_var_name, config,
      rotation_due_at, validation_status, enabled, created_at, updated_at
    ) VALUES (
      'kgl00000-0000-4000-8000-000000000001',
      'Kaggle Default',
      'Default Kaggle API token (HTTP Basic). Set KAGGLE_USERNAME and KAGGLE_KEY env vars; the MCP server reads them per request.',
      'basic_auth',
      '["kaggle.competitions.list","kaggle.competitions.get","kaggle.competitions.files.list","kaggle.competitions.leaderboard.get","kaggle.competitions.submissions.list","kaggle.datasets.list","kaggle.datasets.get","kaggle.datasets.files.list","kaggle.kernels.list","kaggle.kernels.get","kaggle.kernels.pull","kaggle.kernels.status","kaggle.kernels.output"]',
      'KAGGLE_KEY',
      '{"usernameEnvVar":"KAGGLE_USERNAME","mcpEndpoint":"http://localhost:7421/mcp","note":"Auth is supplied by the local Kaggle MCP server reading both env vars; this row pins the names so admins know what to provision."}',
      NULL,
      'unknown',
      0,
      datetime('now'),
      datetime('now')
    )`);

  const KAGGLE_TOOLS: Array<[string, string, string, string]> = [
    // [uuid suffix, tool_key, name, description]
    ['10', 'kaggle.competitions.list',              'Kaggle: List Competitions',           'List Kaggle competitions with optional category/search/sortBy filters.'],
    ['11', 'kaggle.competitions.get',               'Kaggle: Get Competition',             'Get a single Kaggle competition by ref/slug.'],
    ['12', 'kaggle.competitions.files.list',        'Kaggle: List Competition Files',      'List the data files attached to a Kaggle competition.'],
    ['13', 'kaggle.competitions.leaderboard.get',   'Kaggle: Get Leaderboard',             'Fetch the public leaderboard for a Kaggle competition.'],
    ['14', 'kaggle.competitions.submissions.list',  'Kaggle: List Submissions',            "List the caller's prior submissions for a Kaggle competition."],
    ['15', 'kaggle.datasets.list',                  'Kaggle: List Datasets',               'Search the Kaggle dataset catalog with optional filters.'],
    ['16', 'kaggle.datasets.get',                   'Kaggle: Get Dataset',                 'Get a single Kaggle dataset by owner/slug ref.'],
    ['17', 'kaggle.datasets.files.list',            'Kaggle: List Dataset Files',          'List files inside a Kaggle dataset.'],
    ['18', 'kaggle.kernels.list',                   'Kaggle: List Kernels',                'List Kaggle kernels (notebooks/scripts) with optional filters.'],
    ['19', 'kaggle.kernels.get',                    'Kaggle: Get Kernel',                  'Get a single Kaggle kernel by owner/slug ref.'],
    ['20', 'kaggle.kernels.pull',                   'Kaggle: Pull Kernel',                 "Pull a Kaggle kernel's source and metadata."],
    ['21', 'kaggle.kernels.status',                 'Kaggle: Get Kernel Status',           'Get the latest run status of a Kaggle kernel.'],
    ['22', 'kaggle.kernels.output',                 'Kaggle: Get Kernel Output',           'List the output files (and log) from the latest kernel run.'],
  ];
  const insertKaggleTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
      id, name, description, category, risk_level, requires_approval,
      max_execution_ms, rate_limit_per_min, enabled,
      tool_key, version, side_effects, tags, source, credential_id,
      config, allocation_class, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'read-only', 0, NULL, NULL, 0, ?, '0.1.0', 0, ?, 'mcp', 'kgl00000-0000-4000-8000-000000000001', ?, 'data', datetime('now'), datetime('now'))`,
  );
  const KAGGLE_CONFIG = JSON.stringify({ endpoint: 'http://localhost:7421/mcp' });
  const KAGGLE_TAGS = JSON.stringify(['kaggle', 'mcp', 'data-science']);
  for (const [suffix, toolKey, name, description] of KAGGLE_TOOLS) {
    try {
      insertKaggleTool.run(
        `kgl00000-0000-4000-8000-0000000000${suffix}`,
        name,
        description,
        'kaggle',
        toolKey,
        KAGGLE_TAGS,
        KAGGLE_CONFIG,
      );
    } catch { /* ignore */ }
  }

  // ─── M10b — Phase K2: Kaggle write tools + local sandboxed tools ──
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §4.1 + §6 + §7 (Phase K2).
  // Write tools (submit, push) carry the 'external-side-effect' risk and
  // require approval by default. Local tools (validate_submission, score_cv)
  // are pure compute — no network, no credentials needed.
  const insertKaggleWriteTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
      id, name, description, category, risk_level, requires_approval,
      max_execution_ms, rate_limit_per_min, enabled,
      tool_key, version, side_effects, tags, source, credential_id,
      config, allocation_class, created_at, updated_at
    ) VALUES (?, ?, ?, 'kaggle', 'external-side-effect', 1, ?, ?, 0, ?, '0.1.0', 1, ?, 'mcp', 'kgl00000-0000-4000-8000-000000000001', ?, 'data', datetime('now'), datetime('now'))`,
  );
  // Kaggle competition submissions are commonly capped at 5/day. Set a
  // conservative per-minute limit; the daily cap is enforced at the policy
  // layer (Phase K3 ships kaggle_submit_gate).
  try {
    insertKaggleWriteTool.run(
      'kgl00000-0000-4000-8000-000000000023',
      'Kaggle: Submit to Competition',
      'EXTERNAL SIDE EFFECT — submit a file to a Kaggle competition. Counts against the daily submission cap (typically 5/day). Requires approval; callers must pre-validate the CSV via kaggle.local.validate_submission first.',
      300_000,
      1,
      'kaggle.competitions.submit',
      KAGGLE_TAGS,
      KAGGLE_CONFIG,
    );
  } catch { /* ignore */ }
  try {
    insertKaggleWriteTool.run(
      'kgl00000-0000-4000-8000-000000000024',
      'Kaggle: Push Kernel',
      'EXTERNAL SIDE EFFECT — create or version a Kaggle kernel (notebook/script). Defaults to private with no internet and no GPU. Requires approval.',
      300_000,
      2,
      'kaggle.kernels.push',
      KAGGLE_TAGS,
      KAGGLE_CONFIG,
    );
  } catch { /* ignore */ }

  // Local (pure compute) tools — no credentials, no network, no approval.
  const insertKaggleLocalTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
      id, name, description, category, risk_level, requires_approval,
      max_execution_ms, rate_limit_per_min, enabled,
      tool_key, version, side_effects, tags, source, credential_id,
      config, allocation_class, created_at, updated_at
    ) VALUES (?, ?, ?, 'kaggle', 'read-only', 0, ?, NULL, 0, ?, '0.1.0', 0, ?, 'mcp', NULL, ?, 'data', datetime('now'), datetime('now'))`,
  );
  const KAGGLE_LOCAL_TAGS = JSON.stringify(['kaggle', 'mcp', 'local', 'sandbox']);
  try {
    insertKaggleLocalTool.run(
      'kgl00000-0000-4000-8000-000000000025',
      'Kaggle: Validate Submission (local)',
      'In-process pre-checks for a submission CSV (header order, row count, ID uniqueness/coverage). Pure TypeScript — no network, no credentials, runs in milliseconds. Use this BEFORE kaggle.competitions.submit.',
      30_000,
      'kaggle.local.validate_submission',
      KAGGLE_LOCAL_TAGS,
      KAGGLE_CONFIG,
    );
  } catch { /* ignore */ }
  try {
    insertKaggleLocalTool.run(
      'kgl00000-0000-4000-8000-000000000026',
      'Kaggle: Score CV (sandboxed)',
      'Run k-fold cross-validation in a sandboxed container (Python + sklearn). No network, no credentials. Requires the kaggle-runner image to be registered in the host @weaveintel/sandbox ImagePolicy.',
      300_000,
      'kaggle.local.score_cv',
      KAGGLE_LOCAL_TAGS,
      KAGGLE_CONFIG,
    );
  } catch { /* ignore */ }

}
