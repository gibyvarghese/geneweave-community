// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `IToolStore` domain slice of the geneWeave `DatabaseAdapter` — the tool
 * catalog, tool policies + rate-limit buckets, audit events, health snapshots, endpoint health,
 * tool credentials, the MCP gateway (clients / rate buckets / request log), skills, tool approval
 * requests, and DB-backed A2A skills.
 *
 * Each method mirrors the SQLite implementation in `db-sqlite.ts` statement-for-statement: identical
 * SQL, same statement order, same return shapes. SQLite-isms are translated per the porting
 * convention — `?`→`$n`, `datetime('now')`→`${ctx.now}`, text `ORDER BY`→`COLLATE "C"` (byte order),
 * `INSERT OR IGNORE`/`ON CONFLICT … DO NOTHING`, and `INSERT … ON CONFLICT (pk) DO UPDATE`. Booleans
 * persist as INTEGER 0/1; JSON columns are TEXT pass-through; every value is a bound parameter.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  ToolCatalogRow,
  ToolPolicyRow,
  ToolAuditEventRow,
  ToolHealthSnapshotRow,
  ToolHealthSummary,
  EndpointHealthRow,
  EndpointHealthDelta,
  ToolCredentialRow,
  MCPGatewayClientRow,
  MCPGatewayRequestOutcome,
  MCPGatewayRequestLogRow,
  MCPGatewayActivitySummary,
  SkillRow,
  ToolApprovalRequestRow,
  A2ASkillRow,
} from '../db-types/tools.js';

export function pgToolStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Tool catalog ────────────────────────────────────────────────────────
    async createToolConfig(t: Omit<ToolCatalogRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_catalog (id, name, description, category, risk_level, requires_approval, max_execution_ms, rate_limit_per_min, enabled, tool_key, version, side_effects, tags, source, credential_id, allocation_class, config, requires) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          t.id, t.name, t.description ?? null, t.category ?? null, t.risk_level, t.requires_approval,
          t.max_execution_ms ?? null, t.rate_limit_per_min ?? null, t.enabled,
          t.tool_key ?? null, t.version ?? '1.0', t.side_effects ?? 0,
          t.tags ?? null, t.source ?? 'builtin', t.credential_id ?? null,
          t.allocation_class ?? null, t.config ?? null, t.requires ?? null,
        ],
      );
    },

    async getToolConfig(id: string): Promise<ToolCatalogRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_catalog WHERE id = $1', [id]);
      return (rows[0] as ToolCatalogRow | undefined) ?? null;
    },

    async getToolCatalogByKey(toolKey: string): Promise<ToolCatalogRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_catalog WHERE tool_key = $1', [toolKey]);
      return (rows[0] as ToolCatalogRow | undefined) ?? null;
    },

    async listToolConfigs(): Promise<ToolCatalogRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tool_catalog ORDER BY category COLLATE "C" ASC, name COLLATE "C" ASC', []);
      return rows as unknown as ToolCatalogRow[];
    },

    async listEnabledToolCatalog(): Promise<ToolCatalogRow[]> {
      const { rows } = await ctx.query(`SELECT * FROM tool_catalog WHERE enabled = 1 AND source = 'builtin' ORDER BY category COLLATE "C" ASC, name COLLATE "C" ASC`, []);
      return rows as unknown as ToolCatalogRow[];
    },

    async updateToolConfig(id: string, fields: Partial<Omit<ToolCatalogRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE tool_catalog SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteToolConfig(id: string): Promise<void> {
      await ctx.query('DELETE FROM tool_catalog WHERE id = $1', [id]);
    },

    // ─── Tool policies ───────────────────────────────────────────────────────
    async createToolPolicy(p: Omit<ToolPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_policies (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, active_hours_utc, expires_at, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          p.id, p.key, p.name, p.description ?? null,
          p.applies_to ?? null, p.applies_to_risk_levels ?? null,
          p.approval_required, p.allowed_risk_levels ?? null,
          p.max_execution_ms ?? null, p.rate_limit_per_minute ?? null, p.max_concurrent ?? null,
          p.require_dry_run, p.log_input_output,
          p.persona_scope ?? null, p.active_hours_utc ?? null, p.expires_at ?? null, p.enabled,
        ],
      );
    },

    async getToolPolicy(id: string): Promise<ToolPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_policies WHERE id = $1', [id]);
      return (rows[0] as ToolPolicyRow | undefined) ?? null;
    },

    async getToolPolicyByKey(key: string): Promise<ToolPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_policies WHERE key = $1', [key]);
      return (rows[0] as ToolPolicyRow | undefined) ?? null;
    },

    async listToolPolicies(): Promise<ToolPolicyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tool_policies ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ToolPolicyRow[];
    },

    async updateToolPolicy(id: string, fields: Partial<Omit<ToolPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE tool_policies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteToolPolicy(id: string): Promise<void> {
      await ctx.query('DELETE FROM tool_policies WHERE id = $1', [id]);
    },

    async getToolRateLimitCount(toolName: string, scopeKey: string, windowStartIso: string): Promise<number> {
      // M-10: Read the current bucket count without modifying it.
      const { rows } = await ctx.query(
        'SELECT count FROM tool_rate_limit_buckets WHERE tool_name = $1 AND scope_key = $2 AND window_start = $3',
        [toolName, scopeKey, windowStartIso],
      );
      const row = rows[0] as { count: number } | undefined;
      return row?.count ?? 0;
    },

    async checkAndIncrementRateLimit(
      toolName: string,
      scopeKey: string,
      windowStartIso: string,
      limitPerMinute: number,
    ): Promise<boolean> {
      // Upsert the bucket for this (toolName, scopeKey, windowStart) combination.
      await ctx.query(
        `INSERT INTO tool_rate_limit_buckets (id, tool_name, scope_key, window_start, count)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (tool_name, scope_key, window_start) DO NOTHING`,
        [newUUIDv7(), toolName, scopeKey, windowStartIso],
      );

      const { rows } = await ctx.query(
        'SELECT count FROM tool_rate_limit_buckets WHERE tool_name = $1 AND scope_key = $2 AND window_start = $3',
        [toolName, scopeKey, windowStartIso],
      );
      const row = rows[0] as { count: number } | undefined;

      if (!row || row.count >= limitPerMinute) return false;

      await ctx.query(
        'UPDATE tool_rate_limit_buckets SET count = count + 1 WHERE tool_name = $1 AND scope_key = $2 AND window_start = $3',
        [toolName, scopeKey, windowStartIso],
      );

      return true;
    },

    // ─── Phase 3: Tool Audit Events ──────────────────────────────────────────
    async insertToolAuditEvent(event: Omit<ToolAuditEventRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_audit_events
           (id, tool_name, chat_id, user_id, agent_persona, skill_key, policy_id, outcome,
            violation_reason, duration_ms, input_preview, output_preview, error_message, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          event.id,
          event.tool_name,
          event.chat_id ?? null,
          event.user_id ?? null,
          event.agent_persona ?? null,
          event.skill_key ?? null,
          event.policy_id ?? null,
          event.outcome,
          event.violation_reason ?? null,
          event.duration_ms ?? null,
          event.input_preview ?? null,
          event.output_preview ?? null,
          event.error_message ?? null,
          event.metadata ?? null,
        ],
      );
    },

    async listToolAuditEvents(filters?: {
      toolName?: string;
      chatId?: string;
      outcome?: string;
      afterIso?: string;
      beforeIso?: string;
      limit?: number;
      offset?: number;
    }): Promise<ToolAuditEventRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filters?.toolName) { where.push(`tool_name = $${params.length + 1}`); params.push(filters.toolName); }
      if (filters?.chatId)   { where.push(`chat_id = $${params.length + 1}`);   params.push(filters.chatId); }
      if (filters?.outcome)  { where.push(`outcome = $${params.length + 1}`);   params.push(filters.outcome); }
      if (filters?.afterIso) { where.push(`created_at >= $${params.length + 1}`); params.push(filters.afterIso); }
      if (filters?.beforeIso){ where.push(`created_at <= $${params.length + 1}`); params.push(filters.beforeIso); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit  = filters?.limit  ?? 100;
      const offset = filters?.offset ?? 0;
      params.push(limit, offset);
      const { rows } = await ctx.query(
        `SELECT * FROM tool_audit_events ${clause} ORDER BY created_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows as unknown as ToolAuditEventRow[];
    },

    async getToolAuditEvent(id: string): Promise<ToolAuditEventRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_audit_events WHERE id = $1', [id]);
      return (rows[0] as ToolAuditEventRow | undefined) ?? null;
    },

    // ─── Phase 3: Tool Health Snapshots ──────────────────────────────────────
    async insertToolHealthSnapshot(snapshot: Omit<ToolHealthSnapshotRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_health_snapshots
           (id, tool_name, snapshot_at, invocation_count, success_count, error_count, denied_count,
            avg_duration_ms, p95_duration_ms, error_rate, availability)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          snapshot.id,
          snapshot.tool_name,
          snapshot.snapshot_at,
          snapshot.invocation_count,
          snapshot.success_count,
          snapshot.error_count,
          snapshot.denied_count,
          snapshot.avg_duration_ms ?? null,
          snapshot.p95_duration_ms ?? null,
          snapshot.error_rate,
          snapshot.availability,
        ],
      );
    },

    async listToolHealthSnapshots(toolName: string, limit = 48): Promise<ToolHealthSnapshotRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM tool_health_snapshots WHERE tool_name = $1 ORDER BY snapshot_at COLLATE "C" DESC LIMIT $2',
        [toolName, limit],
      );
      return rows as unknown as ToolHealthSnapshotRow[];
    },

    async getToolHealthSummary(sinceIso?: string): Promise<ToolHealthSummary[]> {
      const since = sinceIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { rows } = await ctx.query(
        `SELECT
           tool_name,
           COUNT(*)::int                                                    AS total_invocations,
           SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)::int       AS success_count,
           SUM(CASE WHEN outcome = 'error' OR outcome = 'timeout' THEN 1 ELSE 0 END)::int AS error_count,
           SUM(CASE WHEN outcome LIKE 'denied%' OR outcome = 'circuit_open' THEN 1 ELSE 0 END)::int AS denied_count,
           AVG(CASE WHEN duration_ms IS NOT NULL THEN CAST(duration_ms AS REAL) END)::float8 AS avg_duration_ms,
           CAST(
             SUM(CASE WHEN outcome = 'error' OR outcome = 'timeout' THEN 1 ELSE 0 END) AS REAL
           ) / GREATEST(COUNT(*), 1)                                        AS error_rate,
           CAST(
             SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL
           ) / GREATEST(COUNT(*), 1)                                        AS availability,
           MAX(created_at)                                                  AS last_invoked_at
         FROM tool_audit_events
         WHERE created_at >= $1
         GROUP BY tool_name
         ORDER BY total_invocations DESC`,
        [since],
      );
      return rows as unknown as ToolHealthSummary[];
    },

    // ─── Resilience Phase 4: Endpoint Health ─────────────────────────────────
    async applyEndpointHealthDelta(delta: EndpointHealthDelta): Promise<void> {
      const nowIso = new Date().toISOString();
      // Atomic upsert: INSERT a fresh zero-row first (ON CONFLICT DO NOTHING),
      // then UPDATE counters/state.
      await ctx.query(
        `INSERT INTO endpoint_health (endpoint, updated_at) VALUES ($1, $2) ON CONFLICT (endpoint) DO NOTHING`,
        [delta.endpoint, nowIso],
      );

      // Build dynamic UPDATE. Each field is conditionally appended.
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { sets.push(`${col} = $${params.length + 1}`); params.push(val); };

      if (delta.circuit_state !== undefined) set('circuit_state', delta.circuit_state);
      if (delta.consecutive_failures !== undefined) set('consecutive_failures', delta.consecutive_failures);
      if (delta.last_signal_at !== undefined) set('last_signal_at', delta.last_signal_at);
      if (delta.last_429_at !== undefined) set('last_429_at', delta.last_429_at);
      if (delta.last_retry_after_ms !== undefined) set('last_retry_after_ms', delta.last_retry_after_ms);
      if (delta.last_circuit_opened_at !== undefined) set('last_circuit_opened_at', delta.last_circuit_opened_at);
      if (delta.last_circuit_closed_at !== undefined) set('last_circuit_closed_at', delta.last_circuit_closed_at);

      if (delta.inc_success)       { sets.push(`total_success = total_success + $${params.length + 1}`);             params.push(delta.inc_success); }
      if (delta.inc_failed)        { sets.push(`total_failed = total_failed + $${params.length + 1}`);               params.push(delta.inc_failed); }
      if (delta.inc_rate_limited)  { sets.push(`total_rate_limited = total_rate_limited + $${params.length + 1}`);   params.push(delta.inc_rate_limited); }
      if (delta.inc_retries)       { sets.push(`total_retries = total_retries + $${params.length + 1}`);             params.push(delta.inc_retries); }
      if (delta.inc_shed)          { sets.push(`total_shed = total_shed + $${params.length + 1}`);                   params.push(delta.inc_shed); }
      if (delta.inc_circuit_opens) { sets.push(`total_circuit_opens = total_circuit_opens + $${params.length + 1}`); params.push(delta.inc_circuit_opens); }

      // Latency EMA (alpha=0.2): fold each sample sequentially against the
      // current avg_latency_ms (or seed with the first sample when null).
      if (delta.latency_samples_ms && delta.latency_samples_ms.length > 0) {
        const { rows } = await ctx.query('SELECT avg_latency_ms FROM endpoint_health WHERE endpoint = $1', [delta.endpoint]);
        const row = rows[0] as { avg_latency_ms: number | null } | undefined;
        let avg = row?.avg_latency_ms ?? null;
        const alpha = 0.2;
        for (const sample of delta.latency_samples_ms) {
          avg = avg === null ? sample : avg * (1 - alpha) + sample * alpha;
        }
        set('avg_latency_ms', avg);
      }

      set('updated_at', nowIso);
      params.push(delta.endpoint);

      await ctx.query(`UPDATE endpoint_health SET ${sets.join(', ')} WHERE endpoint = $${params.length}`, params);
    },

    async listEndpointHealth(filters?: { circuitState?: string; limit?: number; offset?: number }): Promise<EndpointHealthRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filters?.circuitState) { where.push(`circuit_state = $${params.length + 1}`); params.push(filters.circuitState); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit  = filters?.limit  ?? 200;
      const offset = filters?.offset ?? 0;
      params.push(limit, offset);
      const { rows } = await ctx.query(
        `SELECT * FROM endpoint_health ${clause} ORDER BY updated_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows as unknown as EndpointHealthRow[];
    },

    async getEndpointHealth(endpoint: string): Promise<EndpointHealthRow | null> {
      const { rows } = await ctx.query('SELECT * FROM endpoint_health WHERE endpoint = $1', [endpoint]);
      return (rows[0] as EndpointHealthRow | undefined) ?? null;
    },

    // ─── Phase 4: Tool Credentials ───────────────────────────────────────────
    async createToolCredential(c: Omit<ToolCredentialRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_credentials (id, name, description, credential_type, tool_names, env_var_name, config, rotation_due_at, validation_status, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          c.id, c.name, c.description ?? null, c.credential_type,
          c.tool_names ?? null, c.env_var_name ?? null, c.config ?? null,
          c.rotation_due_at ?? null, c.validation_status, c.enabled,
        ],
      );
    },

    async getToolCredential(id: string): Promise<ToolCredentialRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_credentials WHERE id = $1', [id]);
      return (rows[0] as ToolCredentialRow | undefined) ?? null;
    },

    async listToolCredentials(): Promise<ToolCredentialRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tool_credentials ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ToolCredentialRow[];
    },

    async listEnabledToolCredentials(): Promise<ToolCredentialRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tool_credentials WHERE enabled = 1 ORDER BY name COLLATE "C" ASC', []);
      return rows as unknown as ToolCredentialRow[];
    },

    async updateToolCredential(id: string, fields: Partial<Omit<ToolCredentialRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE tool_credentials SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteToolCredential(id: string): Promise<void> {
      await ctx.query('DELETE FROM tool_credentials WHERE id = $1', [id]);
    },

    async validateToolCredential(id: string): Promise<{ status: 'valid' | 'invalid' | 'unknown'; value: string | null }> {
      const row = await this.getToolCredential!(id);
      if (!row) return { status: 'unknown', value: null };

      let status: 'valid' | 'invalid' | 'unknown' = 'unknown';
      let value: string | null = null;

      if (row.env_var_name) {
        value = process.env[row.env_var_name] ?? null;
        status = value ? 'valid' : 'invalid';
      }

      // Persist the updated validation_status
      await this.updateToolCredential!(id, { validation_status: status });
      return { status, value };
    },

    // ─── Phase 5: MCP Gateway Clients ────────────────────────────────────────
    async createMCPGatewayClient(c: Omit<MCPGatewayClientRow, 'created_at' | 'updated_at' | 'last_used_at' | 'revoked_at' | 'expires_at' | 'rotated_at'> & Partial<Pick<MCPGatewayClientRow, 'expires_at' | 'rotated_at'>>): Promise<void> {
      await ctx.query(
        `INSERT INTO mcp_gateway_clients (id, name, description, token_hash, allowed_classes, audit_chat_id, enabled, rate_limit_per_minute, expires_at, rotated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          c.id, c.name, c.description ?? null, c.token_hash,
          c.allowed_classes ?? null, c.audit_chat_id ?? null, c.enabled,
          c.rate_limit_per_minute ?? null,
          c.expires_at ?? null,
          c.rotated_at ?? null,
        ],
      );
    },

    async getMCPGatewayClient(id: string): Promise<MCPGatewayClientRow | null> {
      const { rows } = await ctx.query('SELECT * FROM mcp_gateway_clients WHERE id = $1', [id]);
      return (rows[0] as MCPGatewayClientRow | undefined) ?? null;
    },

    async getMCPGatewayClientByTokenHash(tokenHash: string): Promise<MCPGatewayClientRow | null> {
      const { rows } = await ctx.query('SELECT * FROM mcp_gateway_clients WHERE token_hash = $1', [tokenHash]);
      return (rows[0] as MCPGatewayClientRow | undefined) ?? null;
    },

    async listMCPGatewayClients(): Promise<MCPGatewayClientRow[]> {
      const { rows } = await ctx.query('SELECT * FROM mcp_gateway_clients ORDER BY name COLLATE "C"', []);
      return rows as unknown as MCPGatewayClientRow[];
    },

    async listEnabledMCPGatewayClients(): Promise<MCPGatewayClientRow[]> {
      const { rows } = await ctx.query('SELECT * FROM mcp_gateway_clients WHERE enabled = 1 AND revoked_at IS NULL ORDER BY name COLLATE "C"', []);
      return rows as unknown as MCPGatewayClientRow[];
    },

    async updateMCPGatewayClient(id: string, fields: Partial<Omit<MCPGatewayClientRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE mcp_gateway_clients SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async touchMCPGatewayClient(id: string): Promise<void> {
      try {
        await ctx.query(`UPDATE mcp_gateway_clients SET last_used_at = ${ctx.now} WHERE id = $1`, [id]);
      } catch {
        // Best-effort — never block a gateway request on this update.
      }
    },

    async revokeMCPGatewayClient(id: string): Promise<void> {
      await ctx.query(`UPDATE mcp_gateway_clients SET enabled = 0, revoked_at = ${ctx.now}, updated_at = ${ctx.now} WHERE id = $1`, [id]);
    },

    async deleteMCPGatewayClient(id: string): Promise<void> {
      await ctx.query('DELETE FROM mcp_gateway_clients WHERE id = $1', [id]);
    },

    /** Phase 9: list enabled, non-revoked clients whose token expires within
     *  the given window. ISO string comparison is lexicographically monotonic. */
    async listExpiringMCPGatewayClients(windowSeconds: number): Promise<MCPGatewayClientRow[]> {
      const nowIso = new Date().toISOString();
      const cutoffIso = new Date(Date.now() + windowSeconds * 1000).toISOString();
      const { rows } = await ctx.query(
        `SELECT * FROM mcp_gateway_clients
         WHERE enabled = 1
           AND revoked_at IS NULL
           AND expires_at IS NOT NULL
           AND expires_at >= $1
           AND expires_at <= $2
         ORDER BY expires_at COLLATE "C" ASC`,
        [nowIso, cutoffIso],
      );
      return rows as unknown as MCPGatewayClientRow[];
    },

    /** A-9 + Phase 7: per-client gateway rate-limit keyed on
     *  `(tenantId, clientId, windowStart)`. NULL tenantId is normalised to ''. */
    async checkAndIncrementGatewayRateLimit(
      tenantId: string | null,
      clientId: string,
      windowStartIso: string,
      limitPerMinute: number,
    ): Promise<boolean> {
      const tid = tenantId ?? '';
      await ctx.query(
        `INSERT INTO mcp_gateway_rate_buckets (id, tenant_id, client_id, window_start, count)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (tenant_id, client_id, window_start) DO NOTHING`,
        [newUUIDv7(), tid, clientId, windowStartIso],
      );
      const { rows } = await ctx.query(
        'SELECT count FROM mcp_gateway_rate_buckets WHERE tenant_id = $1 AND client_id = $2 AND window_start = $3',
        [tid, clientId, windowStartIso],
      );
      const row = rows[0] as { count: number } | undefined;
      if (!row || row.count >= limitPerMinute) return false;
      await ctx.query(
        'UPDATE mcp_gateway_rate_buckets SET count = count + 1 WHERE tenant_id = $1 AND client_id = $2 AND window_start = $3',
        [tid, clientId, windowStartIso],
      );
      return true;
    },

    /** Phase 8: append-only gateway request log. */
    async insertMCPGatewayRequestLog(row: Omit<MCPGatewayRequestLogRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO mcp_gateway_request_log
           (id, client_id, client_name, method, tool_name, outcome, status_code, duration_ms, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id,
          row.client_id,
          row.client_name,
          row.method,
          row.tool_name,
          row.outcome,
          row.status_code,
          row.duration_ms,
          row.error_message,
          new Date().toISOString(),
        ],
      );
    },

    async listMCPGatewayRequestLog(opts: {
      clientId?: string;
      outcome?: MCPGatewayRequestOutcome;
      limit?: number;
      offset?: number;
    }): Promise<MCPGatewayRequestLogRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.clientId) { where.push(`client_id = $${params.length + 1}`); params.push(opts.clientId); }
      if (opts.outcome) { where.push(`outcome = $${params.length + 1}`); params.push(opts.outcome); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
      const offset = Math.max(0, opts.offset ?? 0);
      params.push(limit, offset);
      const { rows } = await ctx.query(
        `SELECT * FROM mcp_gateway_request_log ${whereSql} ORDER BY created_at COLLATE "C" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows as unknown as MCPGatewayRequestLogRow[];
    },

    async summarizeMCPGatewayActivity(opts: { sinceIso: string }): Promise<MCPGatewayActivitySummary[]> {
      const { rows } = await ctx.query(
        `SELECT
           client_id,
           MAX(client_name) AS client_name,
           COUNT(*)::int AS total,
           SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END)::int AS ok,
           SUM(CASE WHEN outcome = 'rate_limited' THEN 1 ELSE 0 END)::int AS rate_limited,
           SUM(CASE WHEN outcome = 'unauthorized' THEN 1 ELSE 0 END)::int AS unauthorized,
           SUM(CASE WHEN outcome = 'error' OR outcome = 'disabled' THEN 1 ELSE 0 END)::int AS errors,
           MAX(created_at) AS last_seen
         FROM mcp_gateway_request_log
         WHERE created_at >= $1
         GROUP BY client_id
         ORDER BY total DESC`,
        [opts.sinceIso],
      );
      return rows as unknown as MCPGatewayActivitySummary[];
    },

    // ─── Admin: Skills ───────────────────────────────────────────────────────
    async createSkill(s: Omit<SkillRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO skills (id, name, description, category, trigger_patterns, instructions, tool_names, examples, tags, priority, version, tool_policy_key, enabled, supervisor_agent_id, domain_sections, execution_contract) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          s.id,
          s.name,
          s.description,
          s.category,
          s.trigger_patterns,
          s.instructions,
          s.tool_names ?? null,
          s.examples ?? null,
          s.tags ?? null,
          s.priority,
          s.version,
          s.tool_policy_key ?? null,
          s.enabled,
          s.supervisor_agent_id ?? null,
          s.domain_sections ?? null,
          s.execution_contract ?? null,
        ],
      );
    },

    async insertRealmSkillRow(s: Omit<SkillRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO skills (id, name, description, category, trigger_patterns, instructions, tool_names, examples, tags, priority, version, tool_policy_key, enabled, supervisor_agent_id, domain_sections, execution_contract, realm, owner_tenant_id, logical_key, origin_id, origin_hash, content_hash, track_mode, share_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
        [
          s.id, s.name, s.description, s.category, s.trigger_patterns, s.instructions, s.tool_names ?? null,
          s.examples ?? null, s.tags ?? null, s.priority, s.version, s.tool_policy_key ?? null, s.enabled,
          s.supervisor_agent_id ?? null, s.domain_sections ?? null, s.execution_contract ?? null,
          s.realm ?? 'tenant', s.owner_tenant_id ?? null, s.logical_key ?? null, s.origin_id ?? null,
          s.origin_hash ?? null, s.content_hash ?? '', s.track_mode ?? 'pin', s.share_mode ?? 'private',
        ],
      );
    },

    async getSkill(id: string): Promise<SkillRow | null> {
      const { rows } = await ctx.query('SELECT * FROM skills WHERE id = $1', [id]);
      return (rows[0] as SkillRow | undefined) ?? null;
    },

    async listSkills(): Promise<SkillRow[]> {
      const { rows } = await ctx.query('SELECT * FROM skills ORDER BY priority DESC, name COLLATE "C" ASC', []);
      return rows as unknown as SkillRow[];
    },

    async listEnabledSkills(): Promise<SkillRow[]> {
      const { rows } = await ctx.query('SELECT * FROM skills WHERE enabled = 1 ORDER BY priority DESC, name COLLATE "C" ASC', []);
      return rows as unknown as SkillRow[];
    },

    async updateSkill(id: string, fields: Partial<Omit<SkillRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE skills SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteSkill(id: string): Promise<void> {
      await ctx.query('DELETE FROM skills WHERE id = $1', [id]);
    },

    // ─── A2A Skills ──────────────────────────────────────────────────────────
    async createA2ASkill(s: Omit<A2ASkillRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO a2a_skills (id, name, description, tags, examples, input_modes, output_modes, security_scopes, mode, required_permission, sort_order, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          s.id, s.name, s.description,
          s.tags ?? null, s.examples ?? null,
          s.input_modes ?? null, s.output_modes ?? null,
          s.security_scopes, s.mode, s.required_permission ?? null,
          s.sort_order, s.enabled,
        ],
      );
    },

    async getA2ASkill(id: string): Promise<A2ASkillRow | null> {
      const { rows } = await ctx.query('SELECT * FROM a2a_skills WHERE id = $1', [id]);
      return (rows[0] as A2ASkillRow | undefined) ?? null;
    },

    async listA2ASkills(): Promise<A2ASkillRow[]> {
      const { rows } = await ctx.query('SELECT * FROM a2a_skills ORDER BY sort_order ASC, name COLLATE "C" ASC', []);
      return rows as unknown as A2ASkillRow[];
    },

    async listEnabledA2ASkills(): Promise<A2ASkillRow[]> {
      const { rows } = await ctx.query('SELECT * FROM a2a_skills WHERE enabled = 1 ORDER BY sort_order ASC, name COLLATE "C" ASC', []);
      return rows as unknown as A2ASkillRow[];
    },

    async updateA2ASkill(id: string, fields: Partial<Omit<A2ASkillRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE a2a_skills SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteA2ASkill(id: string): Promise<void> {
      await ctx.query('DELETE FROM a2a_skills WHERE id = $1', [id]);
    },

    // ─── Phase 6: Tool Approval Requests ─────────────────────────────────────
    async createToolApprovalRequest(r: Omit<ToolApprovalRequestRow, 'requested_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tool_approval_requests (id, tool_name, chat_id, user_id, input_json, policy_key, skill_key, status, resolved_at, resolved_by, resolution_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          r.id,
          r.tool_name,
          r.chat_id,
          r.user_id ?? null,
          r.input_json,
          r.policy_key ?? null,
          r.skill_key ?? null,
          r.status,
          r.resolved_at ?? null,
          r.resolved_by ?? null,
          r.resolution_note ?? null,
        ],
      );
    },

    async getToolApprovalRequest(id: string): Promise<ToolApprovalRequestRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tool_approval_requests WHERE id = $1', [id]);
      return (rows[0] as ToolApprovalRequestRow | undefined) ?? null;
    },

    async getApprovedToolRequest(toolName: string, chatId: string): Promise<ToolApprovalRequestRow | null> {
      const { rows } = await ctx.query(
        `SELECT * FROM tool_approval_requests WHERE tool_name = $1 AND chat_id = $2 AND status = 'approved' ORDER BY resolved_at COLLATE "C" DESC LIMIT 1`,
        [toolName, chatId],
      );
      return (rows[0] as ToolApprovalRequestRow | undefined) ?? null;
    },

    async getPendingToolRequest(toolName: string, chatId: string): Promise<ToolApprovalRequestRow | null> {
      const { rows } = await ctx.query(
        `SELECT * FROM tool_approval_requests WHERE tool_name = $1 AND chat_id = $2 AND status = 'pending' ORDER BY requested_at COLLATE "C" ASC LIMIT 1`,
        [toolName, chatId],
      );
      return (rows[0] as ToolApprovalRequestRow | undefined) ?? null;
    },

    async listToolApprovalRequests(opts?: { status?: string; chatId?: string; toolName?: string; limit?: number; offset?: number }): Promise<ToolApprovalRequestRow[]> {
      const wheres: string[] = [];
      const vals: unknown[] = [];
      if (opts?.status) { wheres.push(`status = $${vals.length + 1}`); vals.push(opts.status); }
      if (opts?.chatId) { wheres.push(`chat_id = $${vals.length + 1}`); vals.push(opts.chatId); }
      if (opts?.toolName) { wheres.push(`tool_name = $${vals.length + 1}`); vals.push(opts.toolName); }
      const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
      const limit = Math.min(opts?.limit ?? 100, 500);
      const offset = opts?.offset ?? 0;
      vals.push(limit, offset);
      const { rows } = await ctx.query(
        `SELECT * FROM tool_approval_requests ${where} ORDER BY requested_at COLLATE "C" DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
        vals,
      );
      return rows as unknown as ToolApprovalRequestRow[];
    },

    async resolveToolApprovalRequest(id: string, fields: { status: string; resolved_by?: string; resolution_note?: string }): Promise<void> {
      await ctx.query(
        `UPDATE tool_approval_requests SET status = $1, resolved_at = ${ctx.now}, resolved_by = $2, resolution_note = $3 WHERE id = $4`,
        [fields.status, fields.resolved_by ?? null, fields.resolution_note ?? null, id],
      );
    },
  };
}
