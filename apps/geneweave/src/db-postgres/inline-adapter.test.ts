// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres INLINE-adapter slice (`pgInlineAdapterStore`) — the methods declared
 * directly on `DatabaseAdapter` (scheduled note-agents, per-user MCP tokens, artifacts + versions,
 * live-artifact configs). Proves it returns the SAME rows as a fresh `SQLiteAdapter` for identical
 * inputs, against a REAL Postgres in a throwaway Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps differ
 * by wall-clock between the two stores, so they're normalised away before comparison — but each is
 * asserted to carry a valid `YYYY-MM-DD HH:MM:SS` (or ISO-ms) shape. EVERY list comparison is scoped to
 * ids/users this test inserted; same-second lists are compared as id-keyed SETS, not by array position.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgInlineAdapterStore } from './inline-adapter.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { ScheduledNoteAgentRow } from '../db-types/scheduled-agents.js';
import type { UserMcpTokenRow } from '../db-types/mcp-notes.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

// Accepts BOTH SQLite `YYYY-MM-DD HH:MM:SS` and ISO `YYYY-MM-DDTHH:MM:SS(.mmm)Z` timestamp shapes.
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+Z?)?$/;

/** Strip clock-dependent columns after asserting each carries a valid timestamp shape. */
function normTs<T extends { created_at?: string; updated_at?: string | null }>(row: T): Omit<T, 'created_at' | 'updated_at'> {
  const { created_at, updated_at, ...rest } = row;
  if (created_at !== undefined && created_at !== null) expect(created_at).toMatch(TS_RE);
  if (updated_at !== undefined && updated_at !== null) expect(updated_at).toMatch(TS_RE);
  return rest;
}

/** Key a list by id for set-wise comparison (order-independent for same-second rows). */
function byId<T extends { id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-inline-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgInlineAdapterStore — inline DatabaseAdapter parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgInlineAdapterStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgInlineAdapterStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  /** Create the FK parent user on both stores. */
  async function seedUser(userId: string): Promise<void> {
    const u = { id: userId, email: `${userId}@ex.co`, name: 'parity', passwordHash: 'x' };
    await sq.createUser(u);
    // user_id is a plain column with no DB FK, but we still insert the parent user on Postgres so both
    // stores model the parent identically.
    await pool.query('INSERT INTO users (id, email, name, persona, password_hash) VALUES ($1, $2, $3, $4, $5)', [u.id, u.email, u.name, 'tenant_user', u.passwordHash]);
  }

  function agentRow(id: string, userId: string, over: Partial<ScheduledNoteAgentRow> = {}): ScheduledNoteAgentRow {
    return {
      id, user_id: userId, tenant_id: null,
      name: "O'Brien's digest ☃", recipe: 'daily_digest', task_prompt: 'summarize the week',
      trigger_type: 'schedule', cron: '0 8 * * *', timezone: 'UTC',
      scope: 'recent', scope_tag: '', lookback_days: 1, max_notes: 25,
      token_budget: 8000, max_steps: 8, require_approval: 1, enabled: 1,
      last_run_id: null, last_run_at: null, next_run_at: null,
      created_at: '', updated_at: null,
      ...over,
    };
  }

  // ── Scheduled note-agents: create/get/list/update/count ────────────────────
  it('scheduled note-agent: create/get/list/update/count parity + missing→null', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    const id = randomUUID();
    // created_at is supplied by the caller for these rows; use the same value on both stores.
    const created = '2026-07-01 09:00:00';
    const row = agentRow(id, userId, { created_at: created, next_run_at: 1_800_000_000_000 });

    await sq.createScheduledNoteAgent(row);
    await pg.createScheduledNoteAgent!(row);

    const sGet = await sq.getScheduledNoteAgent(id, userId);
    const pGet = await pg.getScheduledNoteAgent!(id, userId);
    expect(pGet).not.toBeNull();
    expect(normTs(pGet!)).toEqual(normTs(sGet!));

    // missing → null
    expect(await pg.getScheduledNoteAgent!('nope', userId)).toBeNull();
    expect(await sq.getScheduledNoteAgent('nope', userId)).toBeNull();

    // count scoped to this user
    expect(await pg.countScheduledNoteAgents!(userId)).toBe(await sq.countScheduledNoteAgents(userId));
    expect(await pg.countScheduledNoteAgents!(userId)).toBe(1);

    // update a subset of fields
    await sq.updateScheduledNoteAgent(id, userId, { enabled: 0, name: 'renamed', next_run_at: 42 });
    await pg.updateScheduledNoteAgent!(id, userId, { enabled: 0, name: 'renamed', next_run_at: 42 });
    const sUpd = await sq.getScheduledNoteAgent(id, userId);
    const pUpd = await pg.getScheduledNoteAgent!(id, userId);
    expect(normTs(pUpd!)).toEqual(normTs(sUpd!));
    expect(pUpd!.enabled).toBe(0);
    expect(pUpd!.name).toBe('renamed');

    // list scoped to this user, compared as an id-keyed set
    const id2 = randomUUID();
    const row2 = agentRow(id2, userId, { created_at: '2026-07-02 09:00:00' });
    await sq.createScheduledNoteAgent(row2);
    await pg.createScheduledNoteAgent!(row2);
    const sList = (await sq.listScheduledNoteAgents(userId)).map((r) => normTs(r));
    const pList = (await pg.listScheduledNoteAgents!(userId)).map((r) => normTs(r));
    expect(byId(pList)).toEqual(byId(sList));
    expect(pList.length).toBe(2);
  });

  // ── listDueScheduledNoteAgents parity (numeric next_run_at ordering) ────────
  it('listDueScheduledNoteAgents: only enabled schedule rows due before nowMs', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    const due = agentRow(randomUUID(), userId, { created_at: '2026-07-01 00:00:00', enabled: 1, next_run_at: 1000 });
    const future = agentRow(randomUUID(), userId, { created_at: '2026-07-01 00:00:00', enabled: 1, next_run_at: 9_999_999 });
    const disabled = agentRow(randomUUID(), userId, { created_at: '2026-07-01 00:00:00', enabled: 0, next_run_at: 1000 });
    for (const r of [due, future, disabled]) { await sq.createScheduledNoteAgent(r); await pg.createScheduledNoteAgent!(r); }

    const nowMs = 5000;
    const sDue = (await sq.listDueScheduledNoteAgents(nowMs)).filter((r) => r.user_id === userId).map((r) => r.id);
    const pDue = (await pg.listDueScheduledNoteAgents!(nowMs)).filter((r) => r.user_id === userId).map((r) => r.id);
    expect(pDue).toEqual(sDue);
    expect(pDue).toEqual([due.id]);
  });

  // ── Per-user MCP tokens: create/getByHash/revoke ───────────────────────────
  it('mcp token: create/getByHash/revoke parity + missing→null', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    const id = randomUUID();
    const tokenHash = `hash-${randomUUID()}`;
    const row: UserMcpTokenRow = {
      id, user_id: userId, tenant_id: null, name: 'my token',
      token_hash: tokenHash, token_prefix: 'gw_abc', scope: 'readwrite',
      enabled: 1, created_at: '2026-07-01 10:00:00', last_used_at: null, expires_at: null,
    };
    await sq.createUserMcpToken(row);
    await pg.createUserMcpToken!(row);

    const sGet = await sq.getUserMcpTokenByHash(tokenHash);
    const pGet = await pg.getUserMcpTokenByHash!(tokenHash);
    expect(pGet).not.toBeNull();
    expect(normTs(pGet!)).toEqual(normTs(sGet!));

    // missing → null (injection arg is data, not code)
    expect(await pg.getUserMcpTokenByHash!(`' OR '1'='1`)).toBeNull();
    expect(await sq.getUserMcpTokenByHash(`' OR '1'='1`)).toBeNull();

    // revoke flips enabled to 0 on both
    await sq.revokeUserMcpToken(id, userId);
    await pg.revokeUserMcpToken!(id, userId);
    const sList = (await sq.listUserMcpTokens(userId)).map((r) => normTs(r));
    const pList = (await pg.listUserMcpTokens!(userId)).map((r) => normTs(r));
    expect(byId(pList)).toEqual(byId(sList));
    expect(pList[0]!.enabled).toBe(0);
  });

  // ── Artifacts: saveArtifact → getArtifact → updateArtifact (version) → list ─
  it('artifact: save/get/update-version/list parity', async () => {
    const userId = `u-${randomUUID()}`;
    const tag = randomUUID().slice(0, 8);
    const input = {
      name: "chart ☃",
      type: 'application/json',
      mimeType: 'application/json',
      data: { hello: "O'Brien", n: 42 },
      userId,
      tags: [tag],
      scope: 'user' as const,
    };
    const sSaved = await sq.saveArtifact(input);
    const pSaved = await pg.saveArtifact!(input);
    // ids/created_at are generated internally → differ. Compare by the stable, caller-supplied columns.
    expect(pSaved.name).toBe(sSaved.name);
    expect(pSaved.type).toBe(sSaved.type);
    expect(pSaved.version).toBe(1);
    expect(sSaved.version).toBe(1);
    expect(pSaved.data_text).toBe(sSaved.data_text);
    expect(pSaved.size_bytes).toBe(sSaved.size_bytes);
    expect(pSaved.scope).toBe('user');
    expect(pSaved.created_at).toMatch(TS_RE);

    // getArtifact round-trips the same row
    const pGet = await pg.getArtifact!(pSaved.id);
    expect(pGet).not.toBeNull();
    expect(pGet!.data_text).toBe(pSaved.data_text);
    expect(await pg.getArtifact!('does-not-exist')).toBeNull();

    // updateArtifact bumps version to 2 and writes a version row on both stores
    const sUpd = await sq.updateArtifact(sSaved.id, { data: { hello: 'world' } }, 'edit');
    const pUpd = await pg.updateArtifact!(pSaved.id, { data: { hello: 'world' } }, 'edit');
    expect(pUpd.version).toBe(2);
    expect(sUpd.version).toBe(2);
    expect(pUpd.data_text).toBe(sUpd.data_text);

    const sVers = await sq.getArtifactVersions(sSaved.id);
    const pVers = await pg.getArtifactVersions!(pSaved.id);
    expect(pVers.map((v) => v.version)).toEqual([1, 2]);
    expect(sVers.map((v) => v.version)).toEqual([1, 2]);
    expect(pVers[1]!.changelog).toBe('edit');

    // listArtifacts by tag+user, scoped to this test's tag
    const sList = (await sq.listArtifacts({ userId, tags: [tag] })).map((r) => r.name);
    const pList = (await pg.listArtifacts!({ userId, tags: [tag] })).map((r) => r.name);
    expect(pList).toEqual(sList);
    expect(pList).toEqual(['chart ☃']);
  });

  // ── Live artifact config: save/get parity ──────────────────────────────────
  it('live artifact config: save/get parity + missing→null', async () => {
    // live_artifact_configs.artifact_id → artifacts.id (FK), so create the parent artifact on each
    // store. saveArtifact auto-generates the id, so the two ids differ — normalize id/artifact_id.
    const artInput = { name: 'Live', type: 'chart', mimeType: 'application/json', data: { x: 1 }, scope: 'user' as const };
    const sArt = await sq.saveArtifact(artInput);
    const pArt = await pg.saveArtifact!(artInput);
    const mk = (artifactId: string) => ({
      artifactId, mcpServerKey: 'gw-mcp', refreshTool: 'refresh_data',
      refreshArgs: { q: "O'Brien" }, refreshIntervalSeconds: 60, cacheTtlSeconds: 15,
    });
    const strip = (r: Record<string, unknown>) => { const { id, artifact_id, created_at, updated_at, ...rest } = r; return rest; };

    const sSaved = await sq.saveLiveArtifactConfig(mk(sArt.id));
    const pSaved = await pg.saveLiveArtifactConfig!(mk(pArt.id));
    expect(strip(pSaved as unknown as Record<string, unknown>)).toEqual(strip(sSaved as unknown as Record<string, unknown>));

    const sGet = await sq.getLiveArtifactConfig(sArt.id);
    const pGet = await pg.getLiveArtifactConfig!(pArt.id);
    expect(pGet).not.toBeNull();
    expect(strip(pGet! as unknown as Record<string, unknown>)).toEqual(strip(sGet! as unknown as Record<string, unknown>));
    expect(pGet!.refresh_interval_seconds).toBe(60);
    expect(pGet!.refresh_count).toBe(0);

    // missing → null on both
    expect(await pg.getLiveArtifactConfig!('does-not-exist')).toBeNull();
    expect(await sq.getLiveArtifactConfig('does-not-exist')).toBeNull();
  });
});
