/**
 * Enterprise integrations: search providers, HTTP endpoints, social accounts,
 * enterprise connectors, website credentials, and tenant configuration.
 *
 * NOTE: api_key, api_secret, access_token, refresh_token fields in social_accounts
 * and enterprise_connectors store credentials as TEXT. These should be migrated to
 * encrypted storage via the tenant key manager (see CODEBASE_REVIEW A-6).
 */
export const SCHEMA_ENTERPRISE_SQL = `
CREATE TABLE IF NOT EXISTS search_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  provider_type TEXT NOT NULL,
  api_key TEXT,
  base_url TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  options TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS http_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  auth_type TEXT,
  auth_config TEXT,
  headers TEXT,
  body_template TEXT,
  response_transform TEXT,
  retry_count INTEGER NOT NULL DEFAULT 2,
  rate_limit_rpm INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  platform TEXT NOT NULL,
  api_key TEXT,
  api_secret TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TEXT,
  oauth_state TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  base_url TEXT,
  options TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enterprise_connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  connector_type TEXT NOT NULL,
  base_url TEXT,
  auth_type TEXT,
  auth_config TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TEXT,
  oauth_state TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  options TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS website_credentials (
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
);

CREATE TABLE IF NOT EXISTS tenant_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'tenant',
  allowed_models TEXT,
  denied_models TEXT,
  allowed_tools TEXT,
  max_tokens_daily INTEGER,
  max_cost_daily REAL,
  max_tokens_monthly INTEGER,
  max_cost_monthly REAL,
  features TEXT,
  config_overrides TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
