// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres port of the `ScopesAdapterMethods` domain slice (`pgScopesStore`).
 *
 * Proves the Postgres store returns the SAME rows as a fresh `SQLiteAdapter` for representative
 * scope operations, against a REAL Postgres in a throwaway Docker container. Timestamps
 * (`created_at` / `updated_at`) are wall-clock values that differ between the two engines by design,
 * so they're normalised to a format assertion rather than an equality assertion.
 *
 * Docker-gated: auto-skips when Docker isn't available so `npm test` stays green anywhere. Nothing
 * is mocked — the `pgScopesStore` factory runs its real SQL against real Postgres.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../db-sqlite.js';
import { pgScopesStore } from './scopes.js';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import type { AgentScopeRow, ScopeCrossPolicyRow, ScopeAccessLogRow } from '../db-types/scopes.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Strip the wall-clock timestamp columns so SQLite vs Postgres rows compare structurally. */
function stripTimes<T extends object>(row: T): Omit<T, 'created_at' | 'updated_at'> {
  const { created_at: _c, updated_at: _u, ...rest } = row as Record<string, unknown>;
  return rest as Omit<T, 'created_at' | 'updated_at'>;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-pg-scopes-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgScopesStore — Postgres parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgScopesStore>;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgScopesStore({ query: (t, p) => pool.query(t, p as unknown[]), now: NOW_SQL });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── Parity 1: agent_scopes create → get / list, incl. byte-order sort ──────
  it('parity: agent_scopes round-trip (create/get/list) matches SQLite, COLLATE "C" order', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      const scopes: Array<Omit<AgentScopeRow, 'created_at' | 'updated_at'>> = [
        { id: `${'zeta'}`, display_name: 'Zeta', description: 'z', sandboxed: 1, max_delegation_depth: 3, audit_level: 'log', enabled: 1 },
        { id: 'Alpha', display_name: 'Alpha', description: 'a', sandboxed: 0, max_delegation_depth: 5, audit_level: 'alert', enabled: 1 },
        { id: 'beta', display_name: 'Beta', description: 'b', sandboxed: 1, max_delegation_depth: 1, audit_level: 'none', enabled: 1 },
      ];
      for (const s of scopes) { await sq.adminCreateScope(s); await pg.adminCreateScope!(s); }

      // getScope: single row parity (minus timestamps)
      const sGet = await sq.getScope('beta');
      const pGet = await pg.getScope!('beta');
      expect(pGet).not.toBeNull();
      expect(stripTimes(pGet as AgentScopeRow)).toEqual(stripTimes(sGet as AgentScopeRow));
      expect((pGet as AgentScopeRow).created_at).toMatch(TS_RE);
      expect((pGet as AgentScopeRow).updated_at).toMatch(TS_RE);

      // listScopes (enabled only) — same rows, same byte-order (uppercase before lowercase).
      // SQLite seeds default scopes at initialize(); scope both lists to THIS test's rows.
      const testIds = new Set(scopes.map((s) => s.id));
      const sList = (await sq.listScopes()).filter((r) => testIds.has(r.id));
      const pList = (await pg.listScopes!()).filter((r) => testIds.has(r.id));
      expect(pList.map((r) => r.id)).toEqual(sList.map((r) => r.id));
      expect(pList.map((r) => r.id)).toEqual(['Alpha', 'beta', 'zeta']); // 'A'(65) < 'b'(98) < 'z'(122)
      expect(pList.map(stripTimes)).toEqual(sList.map(stripTimes));
    } finally {
      await sq.close();
    }
  });

  // ── Parity 2: adminUpdateScope patches only given cols + bumps updated_at ──
  it('parity: adminUpdateScope updates supplied columns and touches updated_at', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      const base = { id: 'upd', display_name: 'Orig', description: 'd', sandboxed: 1, max_delegation_depth: 2, audit_level: 'log', enabled: 1 };
      await sq.adminCreateScope(base); await pg.adminCreateScope!(base);
      await sq.adminUpdateScope('upd', { display_name: 'Renamed', enabled: 0 });
      await pg.adminUpdateScope!('upd', { display_name: 'Renamed', enabled: 0 });

      const sRow = await sq.getScope('upd');
      const pRow = await pg.getScope!('upd');
      expect(stripTimes(pRow as AgentScopeRow)).toEqual(stripTimes(sRow as AgentScopeRow));
      expect((pRow as AgentScopeRow).display_name).toBe('Renamed');
      expect((pRow as AgentScopeRow).enabled).toBe(0);
      expect((pRow as AgentScopeRow).updated_at).toMatch(TS_RE);

      // Empty patch is a no-op on both.
      await expect(pg.adminUpdateScope!('upd', {})).resolves.toBeUndefined();
    } finally {
      await sq.close();
    }
  });

  // ── Parity 3: append-only access log + violation count ─────────────────────
  it('parity: logScopeEvent + listScopeAccessLog + countScopeViolations match SQLite', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      const sess = `sess-${randomUUID()}`;
      const events: Array<Omit<ScopeAccessLogRow, 'id' | 'created_at'>> = [
        { event_type: 'tool_invocation', from_scope: 'a', to_scope: 'b', skill_id: null, tool_name: 't1', session_id: sess, task_id: null, user_id: 'u', allowed: 1, reason: 'ok', delegation_chain_json: null },
        { event_type: 'violation', from_scope: 'a', to_scope: 'c', skill_id: 's', tool_name: 't2', session_id: sess, task_id: null, user_id: 'u', allowed: 0, reason: 'blocked', delegation_chain_json: '["a","c"]' },
      ];
      for (const e of events) { await sq.logScopeEvent(e); await pg.logScopeEvent!(e); }

      const sLog = await sq.listScopeAccessLog({ sessionId: sess, onlyViolations: true });
      const pLog = await pg.listScopeAccessLog!({ sessionId: sess, onlyViolations: true });
      expect(pLog).toHaveLength(1);
      expect(pLog.length).toBe(sLog.length);
      // Compare on stable columns (id is a random UUID per engine; created_at is wall-clock).
      const proj = (r: ScopeAccessLogRow) => ({ event_type: r.event_type, to_scope: r.to_scope, allowed: r.allowed, reason: r.reason, delegation_chain_json: r.delegation_chain_json });
      expect(proj(pLog[0]!)).toEqual(proj(sLog[0]!));
      expect(pLog[0]!.created_at).toMatch(TS_RE);

      // Violations in the last 24h: both count the single blocked event for this session's writes.
      expect(await pg.countScopeViolations!(24)).toBeGreaterThanOrEqual(1);
      expect(await pg.countScopeViolations!(24)).toBe(await sq.countScopeViolations(24));
    } finally {
      await sq.close();
    }
  });

  // ── Parity 4: skill assignments — INSERT OR IGNORE / ON CONFLICT + synthetic id ──
  it('parity: scope_skill_assignments create (idempotent) / list / delete match SQLite', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      await sq.adminCreateScopeSkillAssignment('scopeX', 'skillY');
      await sq.adminCreateScopeSkillAssignment('scopeX', 'skillY'); // idempotent
      await pg.adminCreateScopeSkillAssignment!('scopeX', 'skillY');
      await pg.adminCreateScopeSkillAssignment!('scopeX', 'skillY'); // ON CONFLICT DO NOTHING

      const sAssign = (await sq.adminListScopeSkillAssignments()).filter((r) => r.scope_id === 'scopeX');
      const pAssign = (await pg.adminListScopeSkillAssignments!()).filter((r) => r.scope_id === 'scopeX');
      expect(pAssign).toHaveLength(1); // no duplicate row
      expect(pAssign).toEqual(sAssign);
      expect(pAssign[0]!.id).toBe('scopeX::skillY'); // synthetic composite id

      // Delete via composite id, then confirm gone on both.
      await sq.adminDeleteScopeSkillAssignment('scopeX::skillY');
      await pg.adminDeleteScopeSkillAssignment!('scopeX::skillY');
      expect((await pg.adminListScopeSkillAssignments!()).filter((r) => r.scope_id === 'scopeX')).toEqual([]);
    } finally {
      await sq.close();
    }
  });

  // ── Negative: missing lookups return null / defaults / empty, never throw ──
  it('negative: missing scope → null; unassigned skill/tool → "system"; empty log', async () => {
    expect(await pg.getScope!(`missing-${randomUUID()}`)).toBeNull();
    expect(await pg.adminGetScopePolicy!(`missing-${randomUUID()}`)).toBeNull();
    expect(await pg.getScopeForSkill!(`no-such-skill-${randomUUID()}`)).toBe('system');
    expect(await pg.getScopeForTool!(`no-such-tool-${randomUUID()}`)).toBe('system');
    expect(await pg.getScopeForMeshRole!(`no-mesh-${randomUUID()}`, 'role')).toBe('system');
    const empty = await pg.listScopeAccessLog!({ sessionId: `no-session-${randomUUID()}` });
    expect(empty).toEqual([]);
  });

  // ── Parity 5: cross-policy create → get, JSON + boolean columns preserved ──
  it('parity: scope_cross_policies create/get preserves JSON + integer-boolean columns', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      const pol: Omit<ScopeCrossPolicyRow, 'created_at'> = {
        id: `pol-${randomUUID()}`, from_scope: 'a', to_scope: '*', allowed: 1, requires_a2a: 0,
        max_delegation_depth: 4, conditions_json: '{"when":"business_hours"}', audit_level: 'alert', enabled: 1,
      };
      await sq.adminCreateScopePolicy(pol); await pg.adminCreateScopePolicy!(pol);
      const sPol = await sq.adminGetScopePolicy(pol.id);
      const pPol = await pg.adminGetScopePolicy!(pol.id);
      expect(stripTimes(pPol as ScopeCrossPolicyRow)).toEqual(stripTimes(sPol as ScopeCrossPolicyRow));
      expect((pPol as ScopeCrossPolicyRow).conditions_json).toBe('{"when":"business_hours"}');
      expect((pPol as ScopeCrossPolicyRow).requires_a2a).toBe(0);
    } finally {
      await sq.close();
    }
  });
});
