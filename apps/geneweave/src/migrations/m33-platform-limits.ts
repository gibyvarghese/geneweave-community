/**
 * Migration M33 — Platform limits configuration
 *
 * No schema change: the `config_overrides` column on `tenant_configs` already
 * exists and accepts any JSON object. This migration ensures the global (platform)
 * tenant_configs row has a `limits` key in its `config_overrides` document that
 * documents the supported structure without overriding code defaults.
 *
 * After this migration, operators can edit the global row's `config_overrides`
 * via the admin panel or PATCH /api/admin/platform-limits to change platform-wide
 * limits. Per-tenant overrides live in each tenant's own tenant_configs row.
 *
 * Supported limit keys (all optional, all fall back to CODE_DEFAULTS):
 *   chat_max_steps             — max agent reasoning steps per turn (default 20)
 *   chat_max_tokens            — default response token ceiling (default 4096)
 *   guardrail_input_max_chars  — max chars fed to guardrail pipeline (default 8000)
 *   guardrail_action_max_chars — max chars of serialised tool-call action (default 4000)
 *   attachment_inline_max_chars — max attachment chars inlined into context (default 12000)
 *   cse_timeout_ms             — sandbox execution wall-clock timeout (default 30000)
 *   cse_memory_mb              — sandbox container memory MiB (default 512)
 *   cse_cpu_count              — sandbox container CPU cores (default 1)
 *   cse_pids_limit             — sandbox container max processes (default 256)
 *   cse_session_ttl_ms         — sandbox session idle TTL ms (default 600000)
 *   cse_max_sessions           — max concurrent sandbox session containers (default 20)
 */

import type BetterSqlite3 from 'better-sqlite3';

export function applyM33PlatformLimits(db: BetterSqlite3.Database): void {
  // Ensure the global row exists. If the seed ran, it already does.
  const globalRow = db.prepare("SELECT id, config_overrides FROM tenant_configs WHERE scope = 'global' LIMIT 1").get() as
    { id: string; config_overrides: string | null } | undefined;

  if (!globalRow) return; // Nothing to do — seed hasn't run yet; seed will set it up.

  // If config_overrides already has a `limits` key, leave it alone (operator may have set values).
  if (globalRow.config_overrides) {
    try {
      const parsed = JSON.parse(globalRow.config_overrides) as Record<string, unknown>;
      if (parsed['limits']) return; // already initialised
    } catch { /* fall through to initialise */ }
  }

  // Initialise with an empty limits object so the key is visible in the admin panel.
  const existing = globalRow.config_overrides ? (() => {
    try { return JSON.parse(globalRow.config_overrides!) as Record<string, unknown>; } catch { return {}; }
  })() : {};

  existing['limits'] = {};
  db.prepare('UPDATE tenant_configs SET config_overrides = ? WHERE id = ?')
    .run(JSON.stringify(existing), globalRow.id);
}
