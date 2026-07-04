/**
 * Tool infrastructure: catalog, policies, rate-limit buckets, registry, and approval requests.
 *
 * Relationships:
 *   tool_approval_requests — references chat_id and user_id (soft FK for delete safety)
 */
export const SCHEMA_TOOLS_SQL = `
CREATE TABLE IF NOT EXISTS tool_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  risk_level TEXT NOT NULL DEFAULT 'read-only',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  max_execution_ms INTEGER,
  rate_limit_per_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  tool_key TEXT UNIQUE,
  version TEXT NOT NULL DEFAULT '1.0',
  side_effects INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  source TEXT NOT NULL DEFAULT 'builtin',
  credential_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_policies (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  applies_to TEXT,              -- JSON array of tool names or wildcards
  applies_to_risk_levels TEXT,  -- JSON array of ToolRiskLevel values
  approval_required INTEGER NOT NULL DEFAULT 0,
  allowed_risk_levels TEXT,     -- JSON array of ToolRiskLevel values
  max_execution_ms INTEGER,
  rate_limit_per_minute INTEGER,
  max_concurrent INTEGER,
  require_dry_run INTEGER NOT NULL DEFAULT 0,
  log_input_output INTEGER NOT NULL DEFAULT 1,
  persona_scope TEXT,           -- JSON array of persona identifiers
  active_hours_utc TEXT,        -- JSON object { start: "HH:MM", end: "HH:MM" }
  expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_rate_limit_buckets (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tool_name, scope_key, window_start)
);

CREATE TABLE IF NOT EXISTS tool_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  package_name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0',
  category TEXT NOT NULL DEFAULT 'custom',
  risk_level TEXT NOT NULL DEFAULT 'low',
  tags TEXT,
  config TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  max_execution_ms INTEGER,
  rate_limit_per_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Tool Approval Requests (Phase 6) ──────────────────────
-- Created by DbToolApprovalGate when a tool invocation requires operator approval.
-- Operators approve or deny via the admin UI; the policy-enforced tool gate
-- checks this table before allowing or blocking execution.

CREATE TABLE IF NOT EXISTS tool_approval_requests (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT,
  -- JSON snapshot of the tool input at the time of the request
  input_json TEXT NOT NULL DEFAULT '{}',
  -- Tool policy key that triggered the approval requirement
  policy_key TEXT,
  -- Skill that was active when the request was created (if any)
  skill_key TEXT,
  -- pending | approved | denied | expired
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_approval_chat ON tool_approval_requests(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_tool_approval_tool ON tool_approval_requests(tool_name, status);
`;
