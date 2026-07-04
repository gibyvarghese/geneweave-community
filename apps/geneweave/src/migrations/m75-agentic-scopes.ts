/**
 * Migration m75 — Agentic Scope Isolation
 *
 * Introduces the database layer for the @weaveintel/identity/scope package.
 * Scope isolation prevents agents from crossing functional domain boundaries
 * (e.g. analytics → kaggle) without explicit A2A authorization.
 *
 * New tables:
 *
 *   agent_scopes              — Named domain boundaries (analytics, kaggle, code, ...)
 *   scope_cross_policies      — Rules governing cross-scope delegation
 *   scope_skill_assignments   — Maps skill IDs to their scope
 *   scope_live_agent_assignments — Maps kaggle mesh roles to the kaggle scope
 *   scope_access_log          — Immutable audit log of all scope events (violations + allowed crossings)
 *
 * Also:
 *   - Adds `agentic_scope` column to `a2a_skills` so each skill knows its scope
 *   - Seeds all default scopes and policies from WEAVEINTEL_DEFAULT_SCOPES / POLICIES
 *   - Seeds the skill→scope mapping for all 15 standard A2A skills
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM75AgenticScopes(db: BetterSqlite3.Database): void {

  // ── 1. agent_scopes — named domain boundaries ─────────────────────────────
  safe(db, `
    CREATE TABLE IF NOT EXISTS agent_scopes (
      id                  TEXT PRIMARY KEY,          -- e.g. 'analytics', 'kaggle'
      display_name        TEXT NOT NULL,
      description         TEXT NOT NULL DEFAULT '',
      -- When sandboxed=1, violations are blocked. When 0, they're audit-only.
      sandboxed           INTEGER NOT NULL DEFAULT 1,
      max_delegation_depth INTEGER NOT NULL DEFAULT 5,
      -- 'none' | 'log' | 'alert'
      audit_level         TEXT NOT NULL DEFAULT 'log',
      enabled             INTEGER NOT NULL DEFAULT 1,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── 2. scope_cross_policies — cross-scope permission rules ────────────────
  safe(db, `
    CREATE TABLE IF NOT EXISTS scope_cross_policies (
      id                  TEXT PRIMARY KEY,
      from_scope          TEXT NOT NULL,
      -- '*' = wildcard (matches any scope not covered by a more-specific rule)
      to_scope            TEXT NOT NULL,
      allowed             INTEGER NOT NULL DEFAULT 0,
      -- When 1, delegation MUST use the A2A protocol (no direct invocation)
      requires_a2a        INTEGER NOT NULL DEFAULT 1,
      max_delegation_depth INTEGER NOT NULL DEFAULT 1,
      -- JSON array of ScopePolicyCondition objects
      conditions_json     TEXT,
      -- 'none' | 'log' | 'alert'
      audit_level         TEXT NOT NULL DEFAULT 'log',
      enabled             INTEGER NOT NULL DEFAULT 1,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (from_scope, to_scope)
    )
  `);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_scope_cross_policies_from ON scope_cross_policies (from_scope)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_scope_cross_policies_to ON scope_cross_policies (to_scope)`);

  // ── 3. scope_skill_assignments — skill → scope mapping ───────────────────
  safe(db, `
    CREATE TABLE IF NOT EXISTS scope_skill_assignments (
      scope_id            TEXT NOT NULL,
      skill_id            TEXT NOT NULL,
      PRIMARY KEY (scope_id, skill_id)
    )
  `);

  // ── 4. scope_live_agent_assignments — live mesh → scope mapping ───────────
  // role_key uses '' (empty string) as the catch-all sentinel instead of NULL
  // so that SQLite's PRIMARY KEY works correctly (NULL values are always distinct
  // in SQLite UNIQUE/PK constraints, making INSERT OR IGNORE unreliable for catch-alls).
  safe(db, `
    CREATE TABLE IF NOT EXISTS scope_live_agent_assignments (
      scope_id            TEXT NOT NULL,
      mesh_key            TEXT NOT NULL,            -- e.g. 'kaggle'
      role_key            TEXT NOT NULL DEFAULT '', -- '' = all roles (catch-all), named role otherwise
      PRIMARY KEY (scope_id, mesh_key, role_key)
    )
  `);

  // ── 5. scope_access_log — immutable audit log ─────────────────────────────
  // Append-only table. Do not UPDATE or DELETE rows.
  safe(db, `
    CREATE TABLE IF NOT EXISTS scope_access_log (
      id                  TEXT PRIMARY KEY,          -- UUID v4
      -- 'skill_activation' | 'cross_scope_delegation' | 'tool_invocation' | 'violation'
      event_type          TEXT NOT NULL,
      from_scope          TEXT,
      to_scope            TEXT,
      skill_id            TEXT,
      tool_name           TEXT,
      session_id          TEXT,
      task_id             TEXT,
      user_id             TEXT,
      allowed             INTEGER NOT NULL,          -- 1 = permitted, 0 = blocked
      reason              TEXT,
      delegation_chain_json TEXT,                   -- JSON string of ScopeDelegationEntry[]
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_scope_access_log_created ON scope_access_log (created_at DESC)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_scope_access_log_session ON scope_access_log (session_id)`);
  safe(db, `CREATE INDEX IF NOT EXISTS idx_scope_access_log_violation ON scope_access_log (allowed, event_type)`);

  // ── 6. Add agentic_scope column to a2a_skills ─────────────────────────────
  // Each skill belongs to exactly one scope. Used by discoverSkillsForInput()
  // to filter skills based on the current ScopeContext.
  safe(db, `ALTER TABLE a2a_skills ADD COLUMN agentic_scope TEXT NOT NULL DEFAULT 'system'`);

  // ── 7. Seed default scopes ────────────────────────────────────────────────
  const scopeRows = [
    {
      id: 'system',
      display_name: 'System Orchestration',
      description:
        'Core orchestration scope. Hosts supervisor agents, ensemble reasoning, and workflow orchestration. ' +
        'Can delegate to any other scope. Agents here see the full picture and route work to domain specialists.',
      sandboxed: 1,
      max_delegation_depth: 10,
      audit_level: 'log',
    },
    {
      id: 'analytics',
      display_name: 'Data Analytics',
      description:
        'General business intelligence and data analysis. Right scope for "analyze my sales data", ' +
        '"identify my hero product", or "summarize this report". Deliberately isolated from Kaggle.',
      sandboxed: 1,
      max_delegation_depth: 3,
      audit_level: 'log',
    },
    {
      id: 'kaggle',
      display_name: 'Kaggle Competition',
      description:
        'Competitive ML/data science domain. Hosts the 9-agent Kaggle competition mesh (discoverer, strategist, ' +
        'implementer, validator, submitter, observer, leaderboard_monitor, parallel_implementer, debrief). ' +
        'Must NOT be activated for general data analysis — isolated from analytics by an explicit DENY policy.',
      sandboxed: 1,
      max_delegation_depth: 5,
      audit_level: 'alert',  // Alert on any unexpected access into Kaggle
    },
    {
      id: 'code',
      display_name: 'Code Execution',
      description:
        'Sandboxed Python execution (CSE) and code review. Accessible from analytics and kaggle via A2A.',
      sandboxed: 1,
      max_delegation_depth: 2,
      audit_level: 'log',
    },
    {
      id: 'browser',
      display_name: 'Browser Automation',
      description:
        'Playwright web automation and computer-use. Accessible via A2A when external web interaction is needed.',
      sandboxed: 1,
      max_delegation_depth: 2,
      audit_level: 'log',
    },
    {
      id: 'voice',
      display_name: 'Voice Interaction',
      description:
        'Speech-to-text and text-to-speech pipeline. Isolated for latency and modality constraints.',
      sandboxed: 1,
      max_delegation_depth: 1,
      audit_level: 'none',
    },
    {
      id: 'memory',
      display_name: 'Memory Retrieval',
      description:
        'Vector-based and episodic memory retrieval. Most scopes can read from memory; writing is restricted.',
      sandboxed: 1,
      max_delegation_depth: 1,
      audit_level: 'none',
    },
  ];

  const insertScope = db.prepare(`
    INSERT OR IGNORE INTO agent_scopes
      (id, display_name, description, sandboxed, max_delegation_depth, audit_level)
    VALUES
      (@id, @display_name, @description, @sandboxed, @max_delegation_depth, @audit_level)
  `);
  for (const row of scopeRows) insertScope.run(row);

  // ── 8. Seed cross-scope policies ──────────────────────────────────────────
  const policyRows = [
    // system → * : supervisor can delegate to any scope
    { id: 'pol-sys-any', from_scope: 'system', to_scope: '*', allowed: 1, requires_a2a: 0, max_delegation_depth: 10, audit_level: 'log' },
    // analytics → code : allowed via A2A (for analysis scripts, ETL notebooks)
    { id: 'pol-ana-code', from_scope: 'analytics', to_scope: 'code', allowed: 1, requires_a2a: 1, max_delegation_depth: 2, audit_level: 'log' },
    // analytics → kaggle : EXPLICITLY DENIED — the core isolation boundary
    { id: 'pol-ana-kag', from_scope: 'analytics', to_scope: 'kaggle', allowed: 0, requires_a2a: 0, max_delegation_depth: 0, audit_level: 'alert' },
    // analytics → memory : allowed via A2A
    { id: 'pol-ana-mem', from_scope: 'analytics', to_scope: 'memory', allowed: 1, requires_a2a: 1, max_delegation_depth: 1, audit_level: 'none' },
    // analytics → browser : allowed via A2A (for web-sourced data)
    { id: 'pol-ana-bro', from_scope: 'analytics', to_scope: 'browser', allowed: 1, requires_a2a: 1, max_delegation_depth: 1, audit_level: 'log' },
    // kaggle → code : allowed via A2A (model training, kernel execution)
    { id: 'pol-kag-code', from_scope: 'kaggle', to_scope: 'code', allowed: 1, requires_a2a: 1, max_delegation_depth: 3, audit_level: 'log' },
    // kaggle → analytics : allowed via A2A (result interpretation)
    { id: 'pol-kag-ana', from_scope: 'kaggle', to_scope: 'analytics', allowed: 1, requires_a2a: 1, max_delegation_depth: 1, audit_level: 'log' },
    // kaggle → memory : allowed via A2A (competition context storage)
    { id: 'pol-kag-mem', from_scope: 'kaggle', to_scope: 'memory', allowed: 1, requires_a2a: 1, max_delegation_depth: 1, audit_level: 'none' },
    // kaggle → browser : allowed via A2A (dataset download, leaderboard scraping)
    { id: 'pol-kag-bro', from_scope: 'kaggle', to_scope: 'browser', allowed: 1, requires_a2a: 1, max_delegation_depth: 1, audit_level: 'log' },
    // code → memory : allowed via A2A (lookup docs, store outputs)
    { id: 'pol-code-mem', from_scope: 'code', to_scope: 'memory', allowed: 1, requires_a2a: 1, max_delegation_depth: 1, audit_level: 'none' },
    // browser → analytics : allowed via A2A (send scraped data for analysis)
    { id: 'pol-bro-ana', from_scope: 'browser', to_scope: 'analytics', allowed: 1, requires_a2a: 1, max_delegation_depth: 1, audit_level: 'log' },
    // memory → * : memory agents should not call out — blocked
    { id: 'pol-mem-any', from_scope: 'memory', to_scope: '*', allowed: 0, requires_a2a: 0, max_delegation_depth: 0, audit_level: 'log' },
    // voice → system : voice routes through the supervisor
    { id: 'pol-voi-sys', from_scope: 'voice', to_scope: 'system', allowed: 1, requires_a2a: 0, max_delegation_depth: 1, audit_level: 'none' },
  ];

  const insertPolicy = db.prepare(`
    INSERT OR IGNORE INTO scope_cross_policies
      (id, from_scope, to_scope, allowed, requires_a2a, max_delegation_depth, audit_level)
    VALUES
      (@id, @from_scope, @to_scope, @allowed, @requires_a2a, @max_delegation_depth, @audit_level)
  `);
  for (const row of policyRows) insertPolicy.run(row);

  // ── 9. Seed skill → scope assignments ────────────────────────────────────
  const skillScopeRows = [
    // system scope
    { scope_id: 'system', skill_id: 'general-chat' },
    { scope_id: 'system', skill_id: 'supervisor-orchestration' },
    { scope_id: 'system', skill_id: 'ensemble-reasoning' },
    { scope_id: 'system', skill_id: 'workflow-orchestration' },
    { scope_id: 'system', skill_id: 'image-generation' },   // infrastructure-dependent
    // analytics scope
    { scope_id: 'analytics', skill_id: 'data-pipeline' },
    { scope_id: 'analytics', skill_id: 'research-synthesis' },
    { scope_id: 'analytics', skill_id: 'document-intelligence' },
    { scope_id: 'analytics', skill_id: 'image-analysis' },
    { scope_id: 'analytics', skill_id: 'hypothesis-validation' },
    // code scope
    { scope_id: 'code', skill_id: 'code-execution' },
    { scope_id: 'code', skill_id: 'code-review' },
    // browser scope
    { scope_id: 'browser', skill_id: 'browser-automation' },
    { scope_id: 'browser', skill_id: 'computer-use' },
    // voice scope
    { scope_id: 'voice', skill_id: 'voice-interaction' },
    // memory scope
    { scope_id: 'memory', skill_id: 'memory-retrieval' },
  ];

  const insertSkillScope = db.prepare(`
    INSERT OR IGNORE INTO scope_skill_assignments (scope_id, skill_id)
    VALUES (@scope_id, @skill_id)
  `);
  for (const row of skillScopeRows) insertSkillScope.run(row);

  // ── 10. Seed kaggle mesh → kaggle scope assignment ────────────────────────
  const insertMeshScope = db.prepare(`
    INSERT OR IGNORE INTO scope_live_agent_assignments (scope_id, mesh_key, role_key)
    VALUES (@scope_id, @mesh_key, @role_key)
  `);
  // All roles in the kaggle mesh belong to the kaggle scope
  const kaggleRoles = [
    'discoverer', 'strategist', 'implementer', 'parallel_implementer',
    'validator', 'submitter', 'observer', 'leaderboard_monitor', 'debrief',
  ];
  for (const role of kaggleRoles) {
    insertMeshScope.run({ scope_id: 'kaggle', mesh_key: 'kaggle', role_key: role });
  }
  // Also add a catch-all row (empty string role_key) for any future roles
  insertMeshScope.run({ scope_id: 'kaggle', mesh_key: 'kaggle', role_key: '' });

  // ── 11. Update a2a_skills.agentic_scope with correct scope for each skill ──
  const skillScopeUpdates: Array<{ skill_id: string; scope: string }> = [
    { skill_id: 'general-chat', scope: 'system' },
    { skill_id: 'supervisor-orchestration', scope: 'system' },
    { skill_id: 'ensemble-reasoning', scope: 'system' },
    { skill_id: 'workflow-orchestration', scope: 'system' },
    { skill_id: 'image-generation', scope: 'system' },
    { skill_id: 'data-pipeline', scope: 'analytics' },
    { skill_id: 'research-synthesis', scope: 'analytics' },
    { skill_id: 'document-intelligence', scope: 'analytics' },
    { skill_id: 'image-analysis', scope: 'analytics' },
    { skill_id: 'hypothesis-validation', scope: 'analytics' },
    { skill_id: 'code-execution', scope: 'code' },
    { skill_id: 'code-review', scope: 'code' },
    { skill_id: 'browser-automation', scope: 'browser' },
    { skill_id: 'computer-use', scope: 'browser' },
    { skill_id: 'voice-interaction', scope: 'voice' },
    { skill_id: 'memory-retrieval', scope: 'memory' },
  ];

  const updateSkillScope = db.prepare(`
    UPDATE a2a_skills SET agentic_scope = ? WHERE id = ?
  `);
  for (const { skill_id, scope } of skillScopeUpdates) {
    try { updateSkillScope.run(scope, skill_id); } catch { /* skill not yet seeded — ok */ }
  }
}
