// SPDX-License-Identifier: MIT
/**
 * Postgres port of the geneWeave app's capabilities domain (`ICapabilityStore`): capability packs,
 * their installations and experiments, plus guardrail evaluations. Mirrors the SQLite implementation
 * in `db-sqlite.ts` statement-for-statement, translated to Postgres:
 *   - `?` placeholders → `$1, $2, …`
 *   - `datetime('now')` → the `ctx.now` UTC-text expression (identical read-back shape)
 *   - text `ORDER BY` columns pinned to `COLLATE "C"` for byte-order parity with SQLite
 *   - SQLite `rowid` tiebreakers dropped (Postgres has no `rowid`)
 *
 * All values are bound parameters — never string-concatenated — so hostile input is data, not SQL.
 * Booleans stay INTEGER 0/1 and JSON columns stay TEXT, exactly as SQLite stores them.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  CapabilityPackStatus,
  CapabilityPackRow,
  CapabilityPackInstallationRow,
  CapabilityPackExperimentRow,
  GuardrailEvalRow,
} from '../db-types/capabilities.js';

export function pgCapabilityStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Capability Packs ──────────────────────────────────────
    async createCapabilityPack(p: Omit<CapabilityPackRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO capability_packs (id, pack_key, version, status, name, description, authored_by, manifest, installed_at, installed_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [p.id, p.pack_key, p.version, p.status, p.name, p.description, p.authored_by, p.manifest, p.installed_at, p.installed_by],
      );
    },

    async getCapabilityPack(id: string): Promise<CapabilityPackRow | null> {
      const { rows } = await ctx.query('SELECT * FROM capability_packs WHERE id = $1', [id]);
      return (rows[0] as unknown as CapabilityPackRow | undefined) ?? null;
    },

    async getCapabilityPackByKeyVersion(packKey: string, version: string): Promise<CapabilityPackRow | null> {
      const { rows } = await ctx.query('SELECT * FROM capability_packs WHERE pack_key = $1 AND version = $2', [packKey, version]);
      return (rows[0] as unknown as CapabilityPackRow | undefined) ?? null;
    },

    async listCapabilityPacks(opts?: { packKey?: string; status?: CapabilityPackStatus; limit?: number; offset?: number }): Promise<CapabilityPackRow[]> {
      const wheres: string[] = [];
      const vals: unknown[] = [];
      if (opts?.packKey) { wheres.push(`pack_key = $${vals.length + 1}`); vals.push(opts.packKey); }
      if (opts?.status) { wheres.push(`status = $${vals.length + 1}`); vals.push(opts.status); }
      const limitP = `$${vals.length + 1}`;
      const offsetP = `$${vals.length + 2}`;
      const sql = `SELECT * FROM capability_packs ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY pack_key COLLATE "C" ASC, created_at COLLATE "C" DESC LIMIT ${limitP} OFFSET ${offsetP}`;
      vals.push(opts?.limit ?? 200, opts?.offset ?? 0);
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as CapabilityPackRow[];
    },

    async updateCapabilityPack(id: string, fields: Partial<Omit<CapabilityPackRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE capability_packs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteCapabilityPack(id: string): Promise<void> {
      await ctx.query('DELETE FROM capability_packs WHERE id = $1', [id]);
    },

    async createCapabilityPackInstallation(i: Omit<CapabilityPackInstallationRow, 'installed_at' | 'uninstalled_at'> & { installed_at?: string }): Promise<void> {
      if (i.installed_at) {
        await ctx.query(
          `INSERT INTO capability_pack_installations (id, pack_id, pack_key, pack_version, ledger, installed_by, installed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [i.id, i.pack_id, i.pack_key, i.pack_version, i.ledger, i.installed_by, i.installed_at],
        );
      } else {
        await ctx.query(
          `INSERT INTO capability_pack_installations (id, pack_id, pack_key, pack_version, ledger, installed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
          [i.id, i.pack_id, i.pack_key, i.pack_version, i.ledger, i.installed_by],
        );
      }
    },

    async getCapabilityPackInstallation(id: string): Promise<CapabilityPackInstallationRow | null> {
      const { rows } = await ctx.query('SELECT * FROM capability_pack_installations WHERE id = $1', [id]);
      return (rows[0] as unknown as CapabilityPackInstallationRow | undefined) ?? null;
    },

    async listCapabilityPackInstallations(opts?: { packId?: string; activeOnly?: boolean; limit?: number; offset?: number }): Promise<CapabilityPackInstallationRow[]> {
      const wheres: string[] = [];
      const vals: unknown[] = [];
      if (opts?.packId) { wheres.push(`pack_id = $${vals.length + 1}`); vals.push(opts.packId); }
      if (opts?.activeOnly) { wheres.push('uninstalled_at IS NULL'); }
      const limitP = `$${vals.length + 1}`;
      const offsetP = `$${vals.length + 2}`;
      const sql = `SELECT * FROM capability_pack_installations ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY installed_at COLLATE "C" DESC LIMIT ${limitP} OFFSET ${offsetP}`;
      vals.push(opts?.limit ?? 200, opts?.offset ?? 0);
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as CapabilityPackInstallationRow[];
    },

    async markCapabilityPackInstallationUninstalled(id: string, uninstalledAt?: string): Promise<void> {
      await ctx.query(
        `UPDATE capability_pack_installations SET uninstalled_at = $1 WHERE id = $2`,
        [uninstalledAt ?? new Date().toISOString(), id],
      );
    },

    async createCapabilityPackExperiment(e: Omit<CapabilityPackExperimentRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO capability_pack_experiments (id, pack_key, name, variants, enabled) VALUES ($1, $2, $3, $4, $5)`,
        [e.id, e.pack_key, e.name, e.variants, e.enabled],
      );
    },

    async getCapabilityPackExperiment(id: string): Promise<CapabilityPackExperimentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM capability_pack_experiments WHERE id = $1', [id]);
      return (rows[0] as unknown as CapabilityPackExperimentRow | undefined) ?? null;
    },

    async listCapabilityPackExperiments(opts?: { packKey?: string; enabledOnly?: boolean }): Promise<CapabilityPackExperimentRow[]> {
      const wheres: string[] = [];
      const vals: unknown[] = [];
      if (opts?.packKey) { wheres.push(`pack_key = $${vals.length + 1}`); vals.push(opts.packKey); }
      if (opts?.enabledOnly) { wheres.push('enabled = 1'); }
      const sql = `SELECT * FROM capability_pack_experiments ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY created_at COLLATE "C" DESC`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as CapabilityPackExperimentRow[];
    },

    async updateCapabilityPackExperiment(id: string, fields: Partial<Omit<CapabilityPackExperimentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      vals.push(id);
      await ctx.query(`UPDATE capability_pack_experiments SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async deleteCapabilityPackExperiment(id: string): Promise<void> {
      await ctx.query('DELETE FROM capability_pack_experiments WHERE id = $1', [id]);
    },

    // ─── Guardrail Evaluations ─────────────────────────────────
    async createGuardrailEval(e: Omit<GuardrailEvalRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO guardrail_evals (id, chat_id, message_id, stage, input_preview, results, overall_decision, escalation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [e.id, e.chat_id, e.message_id, e.stage, e.input_preview, e.results, e.overall_decision, e.escalation ?? null],
      );
    },

    async listGuardrailEvals(chatId?: string, limit = 50): Promise<GuardrailEvalRow[]> {
      if (chatId) {
        const { rows } = await ctx.query(
          'SELECT * FROM guardrail_evals WHERE chat_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2',
          [chatId, limit],
        );
        return rows as unknown as GuardrailEvalRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM guardrail_evals ORDER BY created_at COLLATE "C" DESC LIMIT $1', [limit]);
      return rows as unknown as GuardrailEvalRow[];
    },
  };
}
