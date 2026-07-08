// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres voice-agent store (pgVoiceStore) vs. the reference SQLiteAdapter.
 *
 * Proves the ported IVoiceStore slice behaves identically on a REAL Postgres (throwaway Docker
 * container via Testcontainers) and on a fresh SQLite DB, for the same inputs. Docker-gated so
 * `npm test` stays green on any machine.
 *
 * NOTE: the shared db-postgres-schema.ts declares voice_configs.user_id NOT NULL but (unlike the
 * SQLite m47 migration) WITHOUT the UNIQUE constraint that upsertVoiceConfig's ON CONFLICT(user_id)
 * requires. Since we may not edit the schema file, the harness adds the same unique index the
 * SQLite schema has after loading POSTGRES_FULL_SCHEMA — a faithful mirror of production DDL.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../db-sqlite.js';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgVoiceStore } from './voice.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Compare rows column-wise, replacing the two clock-driven timestamps with a placeholder after
 * asserting both are well-formed. Everything else must match byte-for-byte. */
function assertRowParity(pgRow: Record<string, unknown>, sqRow: Record<string, unknown>, tsCols: readonly string[]): void {
  for (const col of tsCols) {
    expect(String(pgRow[col])).toMatch(TS_RE);
    expect(String(sqRow[col])).toMatch(TS_RE);
  }
  const norm = (r: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = tsCols.includes(k) ? '<ts>' : (v ?? null);
    return out;
  };
  expect(norm(pgRow)).toEqual(norm(sqRow));
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-voice-parity-${Date.now()}-${randomUUID()}.db`));
}

describe.skipIf(!HAS_DOCKER)('Postgres voice store — parity with SQLite (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgVoiceStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    // Mirror the SQLite m47 UNIQUE(user_id) that ON CONFLICT(user_id) depends on.
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_configs_user ON voice_configs(user_id)');
    pg = pgVoiceStore({ query: (t, p) => pool.query(t, p), now: NOW_SQL });

    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── upsertVoiceConfig + getVoiceConfig ────────────────────────────────────
  it('upsert + get voice config: same row on Postgres and SQLite (incl. insert→update path)', async () => {
    const userId = `u-${randomUUID()}`;
    const create = {
      userId, tenantId: 'tenant-A', sttProvider: 'openai', sttModel: 'whisper-1', sttLanguage: 'en',
      ttsProvider: 'openai', ttsModel: 'tts-1', ttsVoice: 'alloy', ttsSpeed: 1.25, ttsFormat: 'mp3',
      enabledTools: ['search', 'code'], mode: 'agent', pipelineMode: 'chained' as const, realtimeModel: 'gpt-realtime-2',
    };
    const pgIns = await pg.upsertVoiceConfig!(create);
    const sqIns = await sq.upsertVoiceConfig(create);
    // id is a fresh UUID on each store → exclude it, compare the rest.
    const { id: _p, ...pgRest } = pgIns as unknown as Record<string, unknown>;
    const { id: _s, ...sqRest } = sqIns as unknown as Record<string, unknown>;
    assertRowParity(pgRest, sqRest, ['created_at', 'updated_at']);
    expect(pgIns.enabled_tools).toBe('["search","code"]'); // JSON TEXT pass-through
    expect(pgIns.tts_speed).toBeCloseTo(1.25);

    // Upsert again with changed values → ON CONFLICT(user_id) update path.
    const pgUpd = await pg.upsertVoiceConfig!({ ...create, ttsVoice: 'nova', ttsSpeed: 0.9 });
    const sqUpd = await sq.upsertVoiceConfig({ ...create, ttsVoice: 'nova', ttsSpeed: 0.9 });
    expect(pgUpd.tts_voice).toBe('nova');
    const { id: _p2, ...pgU } = pgUpd as unknown as Record<string, unknown>;
    const { id: _s2, ...sqU } = sqUpd as unknown as Record<string, unknown>;
    assertRowParity(pgU, sqU, ['created_at', 'updated_at']);

    // getVoiceConfig round-trip parity.
    const pgGot = await pg.getVoiceConfig!(userId);
    const sqGot = await sq.getVoiceConfig(userId);
    const { id: _pg, ...pgG } = pgGot as unknown as Record<string, unknown>;
    const { id: _sg, ...sqG } = sqGot as unknown as Record<string, unknown>;
    assertRowParity(pgG, sqG, ['created_at', 'updated_at']);
  });

  // ── updateVoiceConfig (dynamic SET) ───────────────────────────────────────
  it('updateVoiceConfig: partial update produces the same row', async () => {
    const userId = `u-${randomUUID()}`;
    await pg.upsertVoiceConfig!({ userId });
    await sq.upsertVoiceConfig({ userId });
    const pgUpd = await pg.updateVoiceConfig!(userId, { ttsSpeed: 2.0, mode: 'assist', enabledTools: ['x'] });
    const sqUpd = await sq.updateVoiceConfig(userId, { ttsSpeed: 2.0, mode: 'assist', enabledTools: ['x'] });
    expect(pgUpd!.mode).toBe('assist');
    expect(pgUpd!.enabled_tools).toBe('["x"]');
    const { id: _p, ...pgR } = pgUpd as unknown as Record<string, unknown>;
    const { id: _s, ...sqR } = sqUpd as unknown as Record<string, unknown>;
    assertRowParity(pgR, sqR, ['created_at', 'updated_at']);
  });

  // ── createVoiceSession + getVoiceSession + listVoiceSessions ──────────────
  it('create / get / list voice sessions: identical rows and ordering', async () => {
    const userId = `u-${randomUUID()}`;
    const snap = JSON.stringify({ sttModel: 'whisper-1', ttsVoice: 'alloy' });
    const sessions = [
      { id: `s-${randomUUID()}`, userId, tenantId: 'tenant-A', chatId: `c-${randomUUID()}`, configSnapshot: snap },
      { id: `s-${randomUUID()}`, userId, tenantId: null, chatId: `c-${randomUUID()}`, configSnapshot: snap },
    ];
    for (const s of sessions) { await pg.createVoiceSession!(s); await sq.createVoiceSession(s); }

    for (const s of sessions) {
      const p = await pg.getVoiceSession!(s.id, userId);
      const q = await sq.getVoiceSession(s.id, userId);
      assertRowParity(p as unknown as Record<string, unknown>, q as unknown as Record<string, unknown>, ['created_at', 'updated_at']);
      expect(p!.ws_connected).toBe(0);     // boolean-as-integer default
      expect(p!.total_turns).toBe(0);
      expect(p!.total_cost_usd).toBe(0);
    }

    // updateVoiceSessionStats: numeric increments + ws_connected boolean → integer.
    await pg.updateVoiceSessionStats!(sessions[0]!.id, userId, { turns: 3, costUsd: 0.5, audioBytes: 2048, wsConnected: true, lastActiveAt: '2026-07-01 10:00:00' });
    await sq.updateVoiceSessionStats(sessions[0]!.id, userId, { turns: 3, costUsd: 0.5, audioBytes: 2048, wsConnected: true, lastActiveAt: '2026-07-01 10:00:00' });
    const pStat = await pg.getVoiceSession!(sessions[0]!.id, userId);
    const sStat = await sq.getVoiceSession(sessions[0]!.id, userId);
    expect(pStat!.total_turns).toBe(3);
    expect(pStat!.ws_connected).toBe(1);
    expect(pStat!.total_cost_usd).toBeCloseTo(0.5);
    assertRowParity(pStat as unknown as Record<string, unknown>, sStat as unknown as Record<string, unknown>, ['created_at', 'updated_at']);

    // status transitions.
    await pg.updateVoiceSessionStatus!(sessions[1]!.id, userId, 'paused');
    await sq.updateVoiceSessionStatus(sessions[1]!.id, userId, 'paused');
    await pg.endVoiceSession!(sessions[0]!.id, userId);
    await sq.endVoiceSession(sessions[0]!.id, userId);
    expect((await pg.getVoiceSession!(sessions[0]!.id, userId))!.status).toBe('ended');
    expect((await pg.getVoiceSession!(sessions[0]!.id, userId))!.ws_connected).toBe(0);

    // list (filtered + ordered) parity.
    const pgList = await pg.listVoiceSessions!(userId);
    const sqList = await sq.listVoiceSessions(userId);
    expect(pgList.map((r) => r.id)).toEqual(sqList.map((r) => r.id)); // same DESC(created_at) order
    const pgActive = await pg.listVoiceSessions!(userId, { status: 'paused' });
    expect(pgActive.map((r) => r.id)).toEqual([sessions[1]!.id]);
  });

  // ── insertVoiceSessionEvent + listVoiceSessionEvents ──────────────────────
  it('insert + list session events: identical audit rows and ordering', async () => {
    const userId = `u-${randomUUID()}`;
    const sessionId = `s-${randomUUID()}`;
    await pg.createVoiceSession!({ id: sessionId, userId, chatId: `c-${randomUUID()}`, configSnapshot: '{}' });
    await sq.createVoiceSession({ id: sessionId, userId, chatId: `c-${randomUUID()}`, configSnapshot: '{}' });

    const events = [
      { id: `e-${randomUUID()}`, sessionId, userId, turnIndex: 0, eventType: 'stt' as const, inputText: 'hello', durationMs: 120, sttProvider: 'openai', sttModel: 'whisper-1' },
      { id: `e-${randomUUID()}`, sessionId, userId, turnIndex: 0, eventType: 'llm' as const, outputText: 'hi there', promptTokens: 5, completionTokens: 3, costUsd: 0.0001, llmProvider: 'openai', llmModel: 'gpt-4o-mini' },
      { id: `e-${randomUUID()}`, sessionId, userId, turnIndex: 1, eventType: 'error' as const, error: 'timeout' },
    ];
    for (const e of events) { await pg.insertVoiceSessionEvent!(e); await sq.insertVoiceSessionEvent(e); }

    const pgEvents = await pg.listVoiceSessionEvents!(sessionId, userId);
    const sqEvents = await sq.listVoiceSessionEvents(sessionId, userId);
    expect(pgEvents.map((e) => e.id)).toEqual(sqEvents.map((e) => e.id)); // turn_index ASC, created_at ASC
    for (let i = 0; i < pgEvents.length; i++) {
      assertRowParity(pgEvents[i] as unknown as Record<string, unknown>, sqEvents[i] as unknown as Record<string, unknown>, ['created_at']);
    }
    expect(pgEvents[1]!.prompt_tokens).toBe(5);
    expect(pgEvents[1]!.cost_usd).toBeCloseTo(0.0001);
  });

  // ── Negative: missing lookups return null / empty, never throw ────────────
  it('negative: missing config / session return null; missing events return []', async () => {
    expect(await pg.getVoiceConfig!('nobody')).toBeNull();
    expect(await pg.getVoiceSession!('missing', 'nobody')).toBeNull();
    expect(await pg.updateVoiceConfig!('nobody', { mode: 'agent' })).toBeNull();
    expect(await pg.listVoiceSessionEvents!('missing', 'nobody')).toEqual([]);
    expect(await pg.listVoiceSessions!('nobody')).toEqual([]);
  });
});
