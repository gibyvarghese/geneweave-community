// SPDX-License-Identifier: MIT
/**
 * Postgres port of the INLINE `DatabaseAdapter` methods — the ones declared directly on the
 * `DatabaseAdapter` interface in `../db-types/adapter.ts` (NOT in any `adapter-<domain>.ts` sub-interface):
 * scheduled note-agents + their run log (m129), per-user MCP tokens (m130), artifact storage + version
 * history (m77), and live-artifact refresh configs (m80).
 *
 * Each method mirrors the SQLite implementation in `../db-sqlite.ts` statement-for-statement: same SQL,
 * same column order, same integer-boolean and TEXT-JSON conventions. The only translations are the
 * SQLite→Postgres dialect differences:
 *   - `?`→`$n` placeholders (dynamic WHERE/SET builders renumber via `$${vals.length + 1}`);
 *   - named-parameter (`@col`) inserts → an explicit ordered column list + positional binds pulled from
 *     the row object in the same column order;
 *   - `datetime('now')`→`${ctx.now}` (UTC `YYYY-MM-DD HH:MM:SS` text, parity with SQLite);
 *   - text `ORDER BY <textCol>` pinned to `COLLATE "C"` (plain byte order) so results match SQLite;
 *     numeric orderings (e.g. `next_run_at`) are left uncollated;
 *   - `INSERT ... ON CONFLICT (<pk>) DO UPDATE SET ...=EXCLUDED...` for the upserts;
 *   - `.get(...)`→`SELECT`, take `rows[0] ?? null`; `.all(...)`→`rows`; `.run(...)`→`ctx.query`;
 *   - `.changes` counts via `RETURNING <pk>` + `rows.length` (none needed here — all return void/row);
 *   - `COUNT(*)` coerced to a JS number via `Number(...)`.
 *
 * Booleans persist as INTEGER 0/1 (numbers, via the int8 parser); JSON/data columns are TEXT/BYTEA
 * pass-through; bigint columns read back as numbers; every value is a bound parameter.
 *
 * The artifact writers keep the SQLite multi-statement logic (INSERT/UPDATE + a version row, then
 * re-select to return the row) as sequential awaits — same as `pgMeStore` mirrors `d.transaction`.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  ArtifactRow,
  ArtifactVersionRow,
  ArtifactSaveInput,
  ArtifactUpdateInput,
  ArtifactListFilter,
  LiveArtifactConfigRow,
  LiveArtifactConfigInput,
  LiveArtifactConfigUpdate,
} from '../db-types/artifacts.js';
import type { ScheduledNoteAgentRow, ScheduledNoteAgentRunRow } from '../db-types/scheduled-agents.js';
import type { UserMcpTokenRow } from '../db-types/mcp-notes.js';

export function pgInlineAdapterStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Scheduled note agents (m129 / Phase 3) ──────────────────────────────────
    async createScheduledNoteAgent(row: ScheduledNoteAgentRow): Promise<void> {
      await ctx.query(
        `INSERT INTO scheduled_note_agents (id, user_id, tenant_id, name, recipe, task_prompt, trigger_type, cron, timezone, scope, scope_tag, lookback_days, max_notes, token_budget, max_steps, require_approval, enabled, last_run_id, last_run_at, next_run_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          row.id, row.user_id, row.tenant_id, row.name, row.recipe, row.task_prompt, row.trigger_type,
          row.cron, row.timezone, row.scope, row.scope_tag, row.lookback_days, row.max_notes,
          row.token_budget, row.max_steps, row.require_approval, row.enabled, row.last_run_id,
          row.last_run_at, row.next_run_at, row.created_at, row.updated_at,
        ],
      );
    },

    async listScheduledNoteAgents(userId: string): Promise<ScheduledNoteAgentRow[]> {
      const { rows } = await ctx.query('SELECT * FROM scheduled_note_agents WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC', [userId]);
      return rows as unknown as ScheduledNoteAgentRow[];
    },

    async getScheduledNoteAgent(id: string, userId: string): Promise<ScheduledNoteAgentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM scheduled_note_agents WHERE id = $1 AND user_id = $2', [id, userId]);
      return (rows[0] as ScheduledNoteAgentRow | undefined) ?? null;
    },

    async countScheduledNoteAgents(userId: string): Promise<number> {
      const { rows } = await ctx.query('SELECT COUNT(*) AS n FROM scheduled_note_agents WHERE user_id = $1', [userId]);
      return Number((rows[0] as { n: number | string }).n);
    },

    async updateScheduledNoteAgent(id: string, userId: string, fields: Partial<ScheduledNoteAgentRow>): Promise<void> {
      const cols = ['name', 'recipe', 'task_prompt', 'trigger_type', 'cron', 'timezone', 'scope', 'scope_tag', 'lookback_days', 'max_notes', 'token_budget', 'max_steps', 'require_approval', 'enabled', 'last_run_id', 'last_run_at', 'next_run_at'] as const;
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const c of cols) {
        const v = (fields as Record<string, unknown>)[c];
        if (v !== undefined) { sets.push(`${c} = $${vals.length + 1}`); vals.push(v); }
      }
      if (!sets.length) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id, userId);
      await ctx.query(`UPDATE scheduled_note_agents SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND user_id = $${vals.length}`, vals);
    },

    async deleteScheduledNoteAgent(id: string, userId: string): Promise<void> {
      await ctx.query('DELETE FROM scheduled_note_agents WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    async listDueScheduledNoteAgents(nowMs: number, limit = 50): Promise<ScheduledNoteAgentRow[]> {
      const { rows } = await ctx.query(
        `SELECT * FROM scheduled_note_agents WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at ASC LIMIT $2`,
        [nowMs, Math.max(1, Math.min(200, limit))],
      );
      return rows as unknown as ScheduledNoteAgentRow[];
    },

    async createScheduledNoteAgentRun(row: ScheduledNoteAgentRunRow): Promise<void> {
      await ctx.query(
        `INSERT INTO scheduled_note_agent_runs (id, agent_id, user_id, tenant_id, trigger, status, started_at, finished_at, steps, tokens_used, notes_scanned, suggestions_created, output_note_id, summary, error, detail_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          row.id, row.agent_id, row.user_id, row.tenant_id, row.trigger, row.status, row.started_at,
          row.finished_at, row.steps, row.tokens_used, row.notes_scanned, row.suggestions_created,
          row.output_note_id, row.summary, row.error, row.detail_json,
        ],
      );
    },

    async updateScheduledNoteAgentRun(id: string, fields: Partial<ScheduledNoteAgentRunRow>): Promise<void> {
      const cols = ['status', 'finished_at', 'steps', 'tokens_used', 'notes_scanned', 'suggestions_created', 'output_note_id', 'summary', 'error', 'detail_json'] as const;
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const c of cols) {
        const v = (fields as Record<string, unknown>)[c];
        if (v !== undefined) { sets.push(`${c} = $${vals.length + 1}`); vals.push(v); }
      }
      if (!sets.length) return;
      vals.push(id);
      await ctx.query(`UPDATE scheduled_note_agent_runs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async listScheduledNoteAgentRuns(agentId: string, userId: string, limit = 20): Promise<ScheduledNoteAgentRunRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM scheduled_note_agent_runs WHERE agent_id = $1 AND user_id = $2 ORDER BY started_at COLLATE "C" DESC LIMIT $3',
        [agentId, userId, Math.max(1, Math.min(100, limit))],
      );
      return rows as unknown as ScheduledNoteAgentRunRow[];
    },

    // ─── Per-user MCP tokens (m130 / Phase 3) ─────────────────────────────────────
    async createUserMcpToken(row: UserMcpTokenRow): Promise<void> {
      await ctx.query(
        `INSERT INTO user_mcp_tokens (id, user_id, tenant_id, name, token_hash, token_prefix, scope, enabled, created_at, last_used_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          row.id, row.user_id, row.tenant_id, row.name, row.token_hash, row.token_prefix, row.scope,
          row.enabled, row.created_at, row.last_used_at, row.expires_at,
        ],
      );
    },

    async listUserMcpTokens(userId: string): Promise<UserMcpTokenRow[]> {
      const { rows } = await ctx.query('SELECT * FROM user_mcp_tokens WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC', [userId]);
      return rows as unknown as UserMcpTokenRow[];
    },

    async getUserMcpTokenByHash(tokenHash: string): Promise<UserMcpTokenRow | null> {
      const { rows } = await ctx.query('SELECT * FROM user_mcp_tokens WHERE token_hash = $1', [tokenHash]);
      return (rows[0] as UserMcpTokenRow | undefined) ?? null;
    },

    async revokeUserMcpToken(id: string, userId: string): Promise<void> {
      await ctx.query('UPDATE user_mcp_tokens SET enabled = 0 WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    async touchUserMcpToken(id: string): Promise<void> {
      try {
        await ctx.query(`UPDATE user_mcp_tokens SET last_used_at = ${ctx.now} WHERE id = $1`, [id]);
      } catch { /* best-effort */ }
    },

    // ─── Artifact storage (m77) ───────────────────────────────────────────────────
    async saveArtifact(input: ArtifactSaveInput): Promise<ArtifactRow> {
      const { newUUIDv7 } = await import('@weaveintel/core');
      const id = newUUIDv7();
      const now = new Date().toISOString();
      const { serializeArtifactData, estimateArtifactSize } = await import('../lib/artifact-helpers.js');
      const { data_text, data_blob } = serializeArtifactData(input.data);
      const sizeBytes = input.sizeBytes ?? estimateArtifactSize(input.data);
      await ctx.query(
        `INSERT INTO artifacts
           (id, name, type, mime_type, data_text, data_blob, size_bytes, version,
            session_id, user_id, agent_id, run_id, tags, metadata, policy_id, scope,
            streaming_status, streaming_progress, created_at, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          id, input.name, input.type, input.mimeType,
          data_text, data_blob, sizeBytes, 1,
          input.sessionId ?? null, input.userId ?? null,
          input.agentId ?? null, input.runId ?? null,
          input.tags ? JSON.stringify(input.tags) : null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          input.policyId ?? null,
          input.scope ?? 'session',
          input.streamingStatus ?? null,
          input.streamingProgress ?? null,
          now,
          input.tenantId ?? null,
        ],
      );
      const verId = newUUIDv7();
      await ctx.query(
        `INSERT INTO artifact_versions (id, artifact_id, version, data_text, data_blob, changelog, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [verId, id, 1, data_text, data_blob, null, now],
      );
      const { rows } = await ctx.query('SELECT * FROM artifacts WHERE id = $1', [id]);
      return rows[0] as unknown as ArtifactRow;
    },

    async getArtifact(id: string): Promise<ArtifactRow | null> {
      const { rows } = await ctx.query('SELECT * FROM artifacts WHERE id = $1 LIMIT 1', [id]);
      return (rows[0] as ArtifactRow | undefined) ?? null;
    },

    async updateArtifact(id: string, patch: ArtifactUpdateInput, changelog?: string): Promise<ArtifactRow> {
      const existing = await this.getArtifact!(id);
      if (!existing) throw new Error(`Artifact not found: ${id}`);
      const { newUUIDv7 } = await import('@weaveintel/core');
      const { serializeArtifactData, estimateArtifactSize } = await import('../lib/artifact-helpers.js');
      const now = new Date().toISOString();
      const nextVersion = existing.version + 1;
      const newData = patch.data !== undefined ? patch.data : (existing.data_text !== null
        ? (() => { try { return JSON.parse(existing.data_text!); } catch { return existing.data_text; } })()
        : existing.data_blob);
      const { data_text, data_blob } = serializeArtifactData(newData);
      const sizeBytes = patch.data !== undefined ? estimateArtifactSize(newData) : existing.size_bytes;
      // m79: streamingStatus=null clears the 'streaming' marker (artifact finalized)
      const newStreamingStatus = 'streamingStatus' in patch
        ? (patch.streamingStatus ?? null)
        : existing.streaming_status;
      const newStreamingProgress = 'streamingProgress' in patch
        ? (patch.streamingProgress ?? null)
        : existing.streaming_progress;
      await ctx.query(
        `UPDATE artifacts SET
           name=$1, type=$2, mime_type=$3, data_text=$4, data_blob=$5, size_bytes=$6,
           version=$7, tags=$8, metadata=$9, policy_id=$10, scope=$11,
           streaming_status=$12, streaming_progress=$13, updated_at=$14
         WHERE id=$15`,
        [
          patch.name ?? existing.name,
          patch.type ?? existing.type,
          patch.mimeType ?? existing.mime_type,
          data_text, data_blob, sizeBytes, nextVersion,
          patch.tags !== undefined ? JSON.stringify(patch.tags) : existing.tags,
          patch.metadata !== undefined ? JSON.stringify(patch.metadata) : existing.metadata,
          patch.policyId !== undefined ? patch.policyId : existing.policy_id,
          patch.scope ?? existing.scope,
          newStreamingStatus,
          newStreamingProgress,
          now, id,
        ],
      );
      const verId = newUUIDv7();
      await ctx.query(
        `INSERT INTO artifact_versions (id, artifact_id, version, data_text, data_blob, changelog, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [verId, id, nextVersion, data_text, data_blob, changelog ?? null, now],
      );
      const { rows } = await ctx.query('SELECT * FROM artifacts WHERE id = $1', [id]);
      return rows[0] as unknown as ArtifactRow;
    },

    async listArtifacts(filter?: ArtifactListFilter): Promise<ArtifactRow[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filter?.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        conditions.push(`type IN (${types.map(() => `$${params.length + 1}`).join(',')})`);
        params.push(...types);
      }
      if (filter?.sessionId) { conditions.push(`session_id=$${params.length + 1}`); params.push(filter.sessionId); }
      if (filter?.userId) { conditions.push(`user_id=$${params.length + 1}`); params.push(filter.userId); }
      if (filter?.agentId) { conditions.push(`agent_id=$${params.length + 1}`); params.push(filter.agentId); }
      if (filter?.runId) { conditions.push(`run_id=$${params.length + 1}`); params.push(filter.runId); }
      if (filter?.scope) { conditions.push(`scope=$${params.length + 1}`); params.push(filter.scope); }
      if (filter?.policyId) { conditions.push(`policy_id=$${params.length + 1}`); params.push(filter.policyId); }
      if (filter?.tenantId !== undefined) {
        if (filter.tenantId === null) { conditions.push('tenant_id IS NULL'); }
        else { conditions.push(`tenant_id=$${params.length + 1}`); params.push(filter.tenantId); }
      }
      let sql = 'SELECT * FROM artifacts';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at COLLATE "C" DESC';
      if (filter?.limit) { sql += ` LIMIT $${params.length + 1}`; params.push(filter.limit); }
      if (filter?.offset) { sql += ` OFFSET $${params.length + 1}`; params.push(filter.offset); }
      const res = await ctx.query(sql, params);
      let rows = res.rows as unknown as ArtifactRow[];
      if (filter?.tags && filter.tags.length > 0) {
        const required = filter.tags;
        rows = rows.filter((r) => {
          if (!r.tags) return false;
          try {
            const t = JSON.parse(r.tags) as string[];
            return required.every((tag: string) => t.includes(tag));
          } catch { return false; }
        });
      }
      return rows;
    },

    async deleteArtifact(id: string): Promise<void> {
      await ctx.query('DELETE FROM artifacts WHERE id = $1', [id]);
    },

    async getArtifactVersions(artifactId: string): Promise<ArtifactVersionRow[]> {
      const { rows } = await ctx.query('SELECT * FROM artifact_versions WHERE artifact_id = $1 ORDER BY version ASC', [artifactId]);
      return rows as unknown as ArtifactVersionRow[];
    },

    async getArtifactVersion(artifactId: string, version: number): Promise<ArtifactVersionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM artifact_versions WHERE artifact_id = $1 AND version = $2 LIMIT 1', [artifactId, version]);
      return (rows[0] as ArtifactVersionRow | undefined) ?? null;
    },

    async expireArtifacts(): Promise<number> {
      // Joins artifacts with their policy to find rows past retention period.
      // policy_id is nullable — rows without a policy are never expired.
      const { rows } = await ctx.query(
        `SELECT a.id, p.retention_days
         FROM artifacts a
         JOIN artifact_policies p ON a.policy_id = p.id
         WHERE p.retention_days IS NOT NULL
           AND p.retention_days > 0
           AND p.enabled = 1
           AND ((replace(replace(a.created_at, 'T', ' '), 'Z', ''))::timestamp + (p.retention_days || ' days')::interval) < (now() at time zone 'utc')`,
        [],
      );
      const expired = rows as unknown as Array<{ id: string; retention_days: number }>;
      if (expired.length === 0) return 0;
      for (const row of expired) await ctx.query('DELETE FROM artifacts WHERE id = $1', [row.id]);
      return expired.length;
    },

    // ─── Live artifact configs (m80 / Phase 6) ────────────────────────────────────
    async getLiveArtifactConfig(artifactId: string): Promise<LiveArtifactConfigRow | null> {
      try {
        const { rows } = await ctx.query('SELECT * FROM live_artifact_configs WHERE artifact_id = $1', [artifactId]);
        return (rows[0] as LiveArtifactConfigRow | undefined) ?? null;
      } catch { return null; }
    },

    async saveLiveArtifactConfig(input: LiveArtifactConfigInput): Promise<LiveArtifactConfigRow> {
      const { newUUIDv7 } = await import('@weaveintel/core');
      const now = new Date().toISOString();
      const id = newUUIDv7();
      await ctx.query(
        `INSERT INTO live_artifact_configs
           (id, artifact_id, mcp_server_key, refresh_tool, refresh_args,
            refresh_interval_seconds, cache_ttl_seconds, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(artifact_id) DO UPDATE SET
           mcp_server_key = excluded.mcp_server_key,
           refresh_tool   = excluded.refresh_tool,
           refresh_args   = excluded.refresh_args,
           refresh_interval_seconds = excluded.refresh_interval_seconds,
           cache_ttl_seconds        = excluded.cache_ttl_seconds,
           updated_at = excluded.created_at`,
        [
          id, input.artifactId,
          input.mcpServerKey ?? null,
          input.refreshTool ?? null,
          input.refreshArgs ? JSON.stringify(input.refreshArgs) : null,
          input.refreshIntervalSeconds ?? 0,
          input.cacheTtlSeconds ?? 30,
          now,
        ],
      );
      return (await this.getLiveArtifactConfig!(input.artifactId))!;
    },

    async updateLiveArtifactConfig(artifactId: string, patch: LiveArtifactConfigUpdate): Promise<LiveArtifactConfigRow> {
      const now = new Date().toISOString();
      const sets: string[] = ['updated_at = $1'];
      const vals: unknown[] = [now];
      if (patch.mcpServerKey !== undefined) { sets.push(`mcp_server_key = $${vals.length + 1}`); vals.push(patch.mcpServerKey); }
      if (patch.refreshTool !== undefined) { sets.push(`refresh_tool = $${vals.length + 1}`); vals.push(patch.refreshTool); }
      if (patch.refreshArgs !== undefined) { sets.push(`refresh_args = $${vals.length + 1}`); vals.push(patch.refreshArgs ? JSON.stringify(patch.refreshArgs) : null); }
      if (patch.refreshIntervalSeconds !== undefined) { sets.push(`refresh_interval_seconds = $${vals.length + 1}`); vals.push(patch.refreshIntervalSeconds); }
      if (patch.cacheTtlSeconds !== undefined) { sets.push(`cache_ttl_seconds = $${vals.length + 1}`); vals.push(patch.cacheTtlSeconds); }
      vals.push(artifactId);
      await ctx.query(`UPDATE live_artifact_configs SET ${sets.join(', ')} WHERE artifact_id = $${vals.length}`, vals);
      return (await this.getLiveArtifactConfig!(artifactId))!;
    },

    async deleteLiveArtifactConfig(artifactId: string): Promise<void> {
      try { await ctx.query('DELETE FROM live_artifact_configs WHERE artifact_id = $1', [artifactId]); } catch { /* ignore */ }
    },

    async touchLiveArtifactRefresh(artifactId: string): Promise<void> {
      const now = new Date().toISOString();
      await ctx.query(
        `UPDATE live_artifact_configs
            SET last_refreshed_at = $1, refresh_count = refresh_count + 1, updated_at = $2
          WHERE artifact_id = $3`,
        [now, now, artifactId],
      );
    },
  };
}
