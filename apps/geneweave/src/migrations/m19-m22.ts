import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

export function applyM19_M22(db: BetterSqlite3.Database): void {
  // ─── M19 — Live-agents StateStore mirror (la_entities) ──────────────────
  // The @weaveintel/live-agents SqliteStateStore persists meshes, agents,
  // contracts, account bindings, ticks, messages, etc. as JSON payloads keyed
  // by (entity_type, id). Historically this lived in a separate SQLite file
  // (`./live-agents.db`); consolidating it into geneweave.db means everything
  // is documented in one place and the Kaggle live-agents admin tabs read
  // from the same DB the rest of the app uses.
  //
  // Schema MUST match `MIGRATIONS_SQL` in `packages/live-agents/src/sqlite-state-store.ts`
  // exactly so the StateStore can attach to this file without re-creating the
  // table.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS la_entities (
      entity_type TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_type, id)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_la_entities_type_updated ON la_entities(entity_type, updated_at)`);

  // ─── M20 — Kaggle competition runs ledger (per-run UUIDv7 isolation) ────
  // Each "Start Competition" click creates a fresh run row keyed by UUIDv7.
  // All steps and events the agents emit during the run are scoped to that
  // run id, so subsequent runs of the same competition produce a brand new
  // step/flow timeline rather than appending to or mutating a previous one.
  //
  // - kgl_competition_run    — one row per run (status, mesh_id, totals)
  // - kgl_run_step           — ordered, named units of work in the flow
  // - kgl_run_event          — fine-grained events (tool calls, dialogue,
  //                            evidence, log lines) optionally attached to
  //                            a step
  //
  // All PKs are UUIDv7 (TEXT), so they sort naturally by creation time.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kgl_competition_run (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      competition_ref TEXT NOT NULL,
      title TEXT,
      objective TEXT,
      mesh_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','completed','abandoned','failed')),
      step_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_run_tenant ON kgl_competition_run(tenant_id, created_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_run_competition ON kgl_competition_run(competition_ref)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_run_status ON kgl_competition_run(status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kgl_run_step (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES kgl_competition_run(id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','completed','failed','skipped')),
      started_at TEXT,
      completed_at TEXT,
      summary TEXT,
      input_preview TEXT,
      output_preview TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_step_run ON kgl_run_step(run_id, step_index)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_step_status ON kgl_run_step(status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kgl_run_event (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES kgl_competition_run(id) ON DELETE CASCADE,
      step_id TEXT REFERENCES kgl_run_step(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      agent_id TEXT,
      tool_key TEXT,
      summary TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_event_run ON kgl_run_event(run_id, id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_event_step ON kgl_run_event(step_id)`);

  // ─── M21 — Live mesh/agent definitions (DB-driven mesh blueprints) ──────
  // Move mesh + agent + delegation-edge templates out of code and into the
  // database. Each `live_mesh_definitions` row defines a reusable mesh
  // blueprint (e.g. "kaggle"); its `live_agent_definitions` rows describe
  // each role-bound agent (persona / objectives / success indicators); and
  // `live_mesh_delegation_edges` describes the directed graph between roles.
  // Operators edit personas + pipeline shape from the admin UI — runtime
  // boot loads the snapshot at provision time. Playbook overlays still apply
  // on top, scoped per competition slug.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_mesh_definitions (
      id TEXT PRIMARY KEY,
      mesh_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      charter_prose TEXT NOT NULL,
      dual_control_required_for TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_mesh_def_enabled ON live_mesh_definitions(enabled)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_agent_definitions (
      id TEXT PRIMARY KEY,
      mesh_def_id TEXT NOT NULL REFERENCES live_mesh_definitions(id) ON DELETE CASCADE,
      role_key TEXT NOT NULL,
      name TEXT NOT NULL,
      role_label TEXT NOT NULL,
      persona TEXT NOT NULL,
      objectives TEXT NOT NULL,
      success_indicators TEXT NOT NULL,
      ordering INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mesh_def_id, role_key)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_agent_def_mesh ON live_agent_definitions(mesh_def_id, ordering)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_mesh_delegation_edges (
      id TEXT PRIMARY KEY,
      mesh_def_id TEXT NOT NULL REFERENCES live_mesh_definitions(id) ON DELETE CASCADE,
      from_role_key TEXT NOT NULL,
      to_role_key TEXT NOT NULL,
      relationship TEXT NOT NULL,
      prose TEXT NOT NULL,
      ordering INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mesh_def_id, from_role_key, to_role_key)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_edge_mesh ON live_mesh_delegation_edges(mesh_def_id, ordering)`);

  // ─── M22 — DB-driven Live-Agents Runtime (Phase 1) ──────────────────────
  // Design doc: docs/live-agents/DB_DRIVEN_RUNTIME_PLAN.md §3.
  //
  // Splits the live-agents framework into:
  //   • blueprint  (live_mesh_definitions, live_agent_definitions — M21)
  //   • runtime    (live_meshes, live_agents — provisioned per tenant, M22)
  //   • bindings   (handler_bindings, tool_bindings — what each agent does)
  //   • registries (live_handler_kinds, live_attention_policies — DB-managed)
  //   • ledger     (live_runs, live_run_steps, live_run_events — generic
  //                 replacement for kgl_run_step / kgl_run_event)
  //
  // Every table uses a TEXT UUIDv7 primary key. All ALTERs are wrapped in
  // try/catch to remain idempotent on existing databases.

  // (a) Extend live_mesh_definitions with optional Phase-1 columns. Each
  //     ALTER is wrapped because SQLite has no `ADD COLUMN IF NOT EXISTS`.
  const m22DefAlters = [
    `ALTER TABLE live_mesh_definitions ADD COLUMN domain TEXT`,
    `ALTER TABLE live_mesh_definitions ADD COLUMN bridge_topics_default TEXT`,
    `ALTER TABLE live_mesh_definitions ADD COLUMN bridge_rate_limit_default INTEGER`,
    `ALTER TABLE live_mesh_definitions ADD COLUMN provisioner_config_json TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN default_handler_kind TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN default_handler_config_json TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN default_tool_catalog_keys TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN default_attention_policy_key TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN model_capability_json TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN model_routing_policy_key TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN model_pinned_id TEXT`,
    // Phase 3.5 — mirror the model routing columns onto the *runtime*
    // `live_agents` row so per-tenant overrides do not require touching the
    // blueprint. Plan: docs/live-agents/DB_DRIVEN_RUNTIME_PLAN.md §5b.4.
    `ALTER TABLE live_agents ADD COLUMN model_capability_json TEXT`,
    `ALTER TABLE live_agents ADD COLUMN model_routing_policy_key TEXT`,
    `ALTER TABLE live_agents ADD COLUMN model_pinned_id TEXT`,
    // Phase 2 (DB-driven capability plan) — declarative `prepare()` recipe
    // JSON. When set, the runtime synthesises the agent's `prepare()`
    // function from this recipe instead of relying on inline binding
    // config. See packages/live-agents-runtime/src/db-prepare-resolver.ts.
    `ALTER TABLE live_agents ADD COLUMN prepare_config_json TEXT`,
    `ALTER TABLE tool_catalog ADD COLUMN domain_tags TEXT`,
  ];
  for (const sql of m22DefAlters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // (b) Framework registry — the set of handler kinds the runtime knows
  //     about. Implementations live in code (Phase 2 plugins); this table
  //     exists so admins can introspect / select kinds in the UI and so
  //     handler bindings can FK-validate against a known kind.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_handler_kinds (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      config_schema_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'builtin',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // (c) Attention policies — selectable behaviour profiles for "when should
  //     this agent take a tick?". Three built-in `kind`s ship in seeds:
  //     'heuristic', 'cron', 'model'. Tunables live in `config_json`.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_attention_policies (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // (d) live_meshes — a *provisioned* runtime mesh (one per tenant per
  //     blueprint). Distinct from `live_mesh_definitions` (the blueprint).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_meshes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      mesh_def_id TEXT NOT NULL REFERENCES live_mesh_definitions(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      domain TEXT,
      dual_control_required_for TEXT NOT NULL DEFAULT '[]',
      owner_human_id TEXT,
      mcp_server_ref TEXT,
      account_id TEXT,
      context_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_meshes_tenant ON live_meshes(tenant_id, status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_meshes_def ON live_meshes(mesh_def_id)`);

  // (e) live_agents — a provisioned agent inside a runtime mesh. Persona /
  //     objectives are denormalised at provision time so blueprint edits
  //     never silently mutate live agents.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_agents (
      id TEXT PRIMARY KEY,
      mesh_id TEXT NOT NULL REFERENCES live_meshes(id) ON DELETE CASCADE,
      agent_def_id TEXT REFERENCES live_agent_definitions(id) ON DELETE SET NULL,
      role_key TEXT NOT NULL,
      name TEXT NOT NULL,
      role_label TEXT NOT NULL,
      persona TEXT NOT NULL,
      objectives TEXT NOT NULL,
      success_indicators TEXT NOT NULL,
      attention_policy_key TEXT,
      contract_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      ordering INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      -- Phase 3.5 — model routing columns (mirror of live_agent_definitions
      -- defaults; per-tenant runtime overrides land here).
      model_capability_json TEXT,
      model_routing_policy_key TEXT,
      model_pinned_id TEXT,
      -- Phase 2 (DB-driven capability plan) — declarative prepare() recipe.
      prepare_config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mesh_id, role_key)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_agents_mesh ON live_agents(mesh_id, status)`);

  // (f) live_agent_handler_bindings — one row per live_agents row says
  //     which handler kind dispatches its ticks plus opaque config.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_agent_handler_bindings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES live_agents(id) ON DELETE CASCADE,
      handler_kind TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, handler_kind)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_handler_bind_agent ON live_agent_handler_bindings(agent_id, enabled)`);

  // (g) live_agent_tool_bindings — M2M from live_agents to either
  //     `tool_catalog` rows or external MCP server endpoints. Replaces the
  //     in-code KAGGLE_CAPABILITY_MATRIX. Either tool_catalog_id OR
  //     mcp_server_url must be non-null.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_agent_tool_bindings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES live_agents(id) ON DELETE CASCADE,
      tool_catalog_id TEXT REFERENCES tool_catalog(id) ON DELETE CASCADE,
      mcp_server_url TEXT,
      capability_keys TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_tool_bind_agent ON live_agent_tool_bindings(agent_id, enabled)`);

  // (h) live_runs — a "campaign" inside a mesh. Generic enough to cover a
  //     Kaggle competition run, an inbox triage pass, a code-review queue.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_runs (
      id TEXT PRIMARY KEY,
      mesh_id TEXT NOT NULL REFERENCES live_meshes(id) ON DELETE CASCADE,
      tenant_id TEXT,
      run_key TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      summary TEXT,
      context_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mesh_id, run_key)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_runs_mesh ON live_runs(mesh_id, status, started_at)`);

  // (i) live_run_steps — per-agent progress ledger inside a run. Generic
  //     replacement for kgl_run_step.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES live_runs(id) ON DELETE CASCADE,
      mesh_id TEXT NOT NULL REFERENCES live_meshes(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES live_agents(id) ON DELETE SET NULL,
      role_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      started_at TEXT,
      completed_at TEXT,
      summary TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_run_steps_run ON live_run_steps(run_id, role_key)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_run_steps_mesh ON live_run_steps(mesh_id, status)`);

  // (j) live_run_events — append-only event log. Generic replacement for
  //     kgl_run_event. Tail this for SSE/observability.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES live_runs(id) ON DELETE CASCADE,
      step_id TEXT REFERENCES live_run_steps(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      agent_id TEXT REFERENCES live_agents(id) ON DELETE SET NULL,
      tool_key TEXT,
      summary TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_run_events_run ON live_run_events(run_id, created_at, id)`);

  // ─── Resilience Phase 4: Endpoint Health ────────────────
  // One row per logical resilience endpoint (e.g. 'openai:rest',
  // 'anthropic:rest', 'tools-http:<name>'). The DbResilienceObserver
  // batches signals from @weaveintel/resilience's signal bus and upserts
  // running counters here. Used by the admin UI and by live-agent
  // schedulers to defer work when an endpoint is degraded.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS endpoint_health (
      endpoint TEXT PRIMARY KEY,
      circuit_state TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_signal_at TEXT,
      last_429_at TEXT,
      last_retry_after_ms INTEGER,
      last_circuit_opened_at TEXT,
      last_circuit_closed_at TEXT,
      total_success INTEGER NOT NULL DEFAULT 0,
      total_failed INTEGER NOT NULL DEFAULT 0,
      total_rate_limited INTEGER NOT NULL DEFAULT 0,
      total_retries INTEGER NOT NULL DEFAULT 0,
      total_shed INTEGER NOT NULL DEFAULT 0,
      total_circuit_opens INTEGER NOT NULL DEFAULT 0,
      avg_latency_ms REAL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_endpoint_health_updated_at ON endpoint_health(updated_at)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_endpoint_health_circuit_state ON endpoint_health(circuit_state)`);

  // ─── Workflow Platform Phase 1: Handler Kinds Catalog ─────
  // One row per registered HandlerResolver kind (e.g. 'tool', 'prompt',
  // 'agent', 'mcp', 'script', 'subworkflow', 'noop'). Synced at startup
  // from @weaveintel/workflows' HandlerResolverRegistry via
  // syncWorkflowHandlerKindsToDb(). Powers admin UI dropdowns so step
  // handler kinds are not hardcoded. UUID PK; `kind` is the unique key.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_handler_kinds (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL UNIQUE,
      description TEXT,
      config_schema TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'builtin',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_workflow_handler_kinds_kind ON workflow_handler_kinds(kind)`);

  // ─── Phase 3 (DB-driven capability plan) — Unified Triggers ───
  // One row per operator-defined trigger. The dispatcher in
  // @weaveintel/triggers loads these at startup and subscribes the
  // appropriate source adapters; matching events route through filter
  // -> rate-limit -> target dispatch. UUID PK; `key` is the operator
  // alias (also used as a filter handle by the cron source adapter).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      source_kind TEXT NOT NULL,
      source_config TEXT NOT NULL DEFAULT '{}',
      filter_expr TEXT,
      target_kind TEXT NOT NULL,
      target_config TEXT NOT NULL DEFAULT '{}',
      input_map TEXT,
      rate_limit_per_minute INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_triggers_source_kind ON triggers(source_kind, enabled)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_triggers_target_kind ON triggers(target_kind)`);

  // Append-only audit log. Every dispatch attempt (including filtered,
  // rate_limited, disabled, no_target_adapter, error) writes one row so
  // operators can inspect the live trigger fabric in the admin UI.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS trigger_invocations (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
      fired_at TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      target_ref TEXT,
      error_message TEXT,
      source_event TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_trigger_invocations_trigger ON trigger_invocations(trigger_id, fired_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_trigger_invocations_status ON trigger_invocations(status, fired_at DESC)`);

  // ─── Phase 4 (DB-driven capability plan) — Mesh contracts ───
  // Append-only ledger of typed contracts emitted by workflow runs (or
  // any other ContractEmitter consumer). The triggers dispatcher reads
  // these via its in-process bus (MeshContractSourceAdapter) so a row
  // here doubles as the audit trail and the source event.
  // UUID PK; body and evidence are JSON-serialized. mesh_id and
  // source_agent_id are nullable for workflow-only emissions.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS mesh_contracts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      body_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT,
      mesh_id TEXT,
      source_workflow_definition_id TEXT,
      source_workflow_run_id TEXT,
      source_agent_id TEXT,
      metadata TEXT,
      emitted_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mesh_contracts_kind ON mesh_contracts(kind, emitted_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mesh_contracts_run ON mesh_contracts(source_workflow_run_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mesh_contracts_mesh ON mesh_contracts(mesh_id, emitted_at DESC)`);

  // ─── Phase 5 — Workflow Governance / Durability / Replay ────────────────
  // Adds cost tracking + metadata to workflow_runs, durable checkpoint store,
  // and the capability-policy bindings table for binding policies to agents,
  // meshes, or workflows. UUID PKs everywhere.
  safeExec(db, 'ALTER TABLE workflow_runs ADD COLUMN cost_total REAL NOT NULL DEFAULT 0');
  safeExec(db, 'ALTER TABLE workflow_runs ADD COLUMN metadata TEXT');

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS workflow_checkpoints (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_run ON workflow_checkpoints(run_id, created_at DESC)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS capability_policy_bindings (
      id TEXT PRIMARY KEY,
      binding_kind TEXT NOT NULL,
      binding_ref TEXT NOT NULL,
      policy_kind TEXT NOT NULL,
      policy_ref TEXT NOT NULL,
      precedence INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(binding_kind, binding_ref, policy_kind)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_capability_policy_bindings_lookup ON capability_policy_bindings(binding_kind, binding_ref, policy_kind, enabled)`);

  // ─── Phase 6 — Capability Packs ────────────────────────────
  // Operator-shippable, versioned bundles of DB rows. The pack manifest is
  // stored as JSON; the installation ledger records exactly which child rows
  // each pack version wrote (so uninstall is precise). Experiments add
  // weighted version rollouts.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS capability_packs (
      id TEXT PRIMARY KEY,
      pack_key TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      authored_by TEXT,
      manifest TEXT NOT NULL,
      installed_at TEXT,
      installed_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(pack_key, version)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_capability_packs_key ON capability_packs(pack_key, status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS capability_pack_installations (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      pack_key TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      ledger TEXT NOT NULL,
      installed_by TEXT,
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      uninstalled_at TEXT,
      FOREIGN KEY (pack_id) REFERENCES capability_packs(id) ON DELETE CASCADE
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_capability_pack_installations_pack ON capability_pack_installations(pack_id, installed_at DESC)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS capability_pack_experiments (
      id TEXT PRIMARY KEY,
      pack_key TEXT NOT NULL,
      name TEXT NOT NULL,
      variants TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_capability_pack_experiments_key ON capability_pack_experiments(pack_key, enabled)`);

}
