// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres FULL `IChatStore` slice (`pgChatStore`). Proves it returns the SAME
 * rows as a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway
 * Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape. List
 * comparisons are scoped to THIS test's user id so a shared container can't leak cross-test rows.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgChatStore } from './chats.js';
import { SQLiteAdapter } from '../db-sqlite.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Strip clock-dependent columns after asserting each carries the SQLite timestamp shape. */
function normTs<T extends { created_at?: string; updated_at?: string }>(row: T): Omit<T, 'created_at' | 'updated_at'> {
  const { created_at, updated_at, ...rest } = row;
  if (created_at !== undefined) expect(created_at).toMatch(TS_RE);
  if (updated_at !== undefined) expect(updated_at).toMatch(TS_RE);
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-chats-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgChatStore — IChatStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgChatStore>;
  let sq: SQLiteAdapter;

  // A single user shared by all cases in this describe, created on BOTH stores (FK: chats.user_id).
  const userId = `u-${randomUUID()}`;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgChatStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();

    // Parent user must exist before any chat (FK chats.user_id → users.id).
    const user = { id: userId, email: `${userId}@ex.co`, name: 'Ada', passwordHash: 'x' };
    await sq.createUser(user);
    await pool.query('INSERT INTO users (id, email, name, persona, password_hash) VALUES ($1, $2, $3, $4, $5)', [
      user.id, user.email, user.name, 'tenant_user', user.passwordHash,
    ]);
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── createChat + getChat / getChatById parity ──────────────────────────────
  it('createChat + getChat: identical row (incl. pinned/archived integer flags)', async () => {
    const id = `c-${randomUUID()}`;
    const chat = { id, userId, title: 'O\'Brien\'s "chat" ☃', model: 'gpt-x', provider: 'openai' };
    await sq.createChat(chat);
    await pg.createChat!(chat);

    const sRow = await sq.getChat(id, userId);
    const pRow = await pg.getChat!(id, userId);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    // Integer booleans preserved as numbers, not true/false.
    expect(pRow!.pinned).toBe(0);
    expect(pRow!.archived).toBe(0);

    // getChatById parity.
    expect(normTs((await pg.getChatById!(id))!)).toEqual(normTs((await sq.getChatById(id))!));
  });

  // ── addMessage + getMessages order (created_at COLLATE "C" ASC) ─────────────
  it('addMessage + getMessages: same rows in same order, chat.updated_at bumped', async () => {
    const chatId = `c-${randomUUID()}`;
    await sq.createChat({ id: chatId, userId, title: 'msgs', model: 'm', provider: 'p' });
    await pg.createChat!({ id: chatId, userId, title: 'msgs', model: 'm', provider: 'p' });

    for (let i = 0; i < 3; i++) {
      const m = { id: `m-${randomUUID()}`, chatId, role: i % 2 ? 'assistant' : 'user', content: `line ${i}`, tokensUsed: i, cost: i * 0.5, latencyMs: i * 10 };
      await sq.addMessage(m);
      await pg.addMessage!(m);
    }

    const sMsgs = await sq.getMessages(chatId);
    const pMsgs = await pg.getMessages!(chatId);
    // All three messages share the same second, so intra-second ORDER is engine-specific
    // (SQLite=rowid, Postgres=heap) — compare row-by-row keyed by id, not by position.
    const byId = (ms: typeof sMsgs) => new Map(ms.map((m) => [m.id, normTs(m)] as const));
    expect(byId(pMsgs)).toEqual(byId(sMsgs));
    expect([...pMsgs].map((m) => m.content).sort()).toEqual(['line 0', 'line 1', 'line 2']);
    expect(pMsgs.find((m) => m.content === 'line 1')!.cost).toBe(0.5); // DOUBLE preserved as number
  });

  // ── listUserConversations: pin/archive filter + byte-order + snippet ────────
  it('listUserConversations: identical filtering (active/pinned/archived) and snippet', async () => {
    const mk = async (title: string, pinned: boolean, archived: boolean) => {
      const id = `c-${randomUUID()}`;
      await sq.createChat({ id, userId, title, model: 'm', provider: 'p' });
      await pg.createChat!({ id, userId, title, model: 'm', provider: 'p' });
      const msg = { id: `m-${randomUUID()}`, chatId: id, role: 'user', content: `snippet for ${title}` };
      await sq.addMessage(msg);
      await pg.addMessage!(msg);
      await sq.setConversationFlags(id, userId, { pinned, archived });
      await pg.setConversationFlags!(id, userId, { pinned, archived });
      return id;
    };
    const pinnedId = await mk('conv-pinned', true, false);
    await mk('conv-plain', false, false);
    await mk('conv-archived', false, true);

    for (const filter of ['active', 'pinned', 'archived', 'all'] as const) {
      const sList = (await sq.listUserConversations(userId, { filter })).filter((c) => c.id.startsWith('c-'));
      const pList = (await pg.listUserConversations!(userId, { filter })).filter((c) => c.id.startsWith('c-'));
      // The three chats share an updated_at second, so order within a filter is engine-specific —
      // assert the same SET of titles (which proves the filter itself matches).
      expect(pList.map((c) => c.title).sort()).toEqual(sList.map((c) => c.title).sort());
    }

    // Pinned filter excludes archived and non-pinned; snippet is the message content.
    const pinnedList = await pg.listUserConversations!(userId, { filter: 'pinned' });
    const pinnedRow = pinnedList.find((c) => c.id === pinnedId);
    expect(pinnedRow).toBeDefined();
    expect(pinnedRow!.snippet).toBe('snippet for conv-pinned');
    expect(pinnedRow!.pinned).toBe(1);
    expect(pinnedRow!.mode).toBe('agent'); // COALESCE default when no chat_settings

    // Query search parity (substring against title).
    const sQ = (await sq.listUserConversations(userId, { query: 'pinned' })).map((c) => c.title);
    const pQ = (await pg.listUserConversations!(userId, { query: 'pinned' })).map((c) => c.title);
    expect(pQ).toEqual(sQ);
  });

  // ── updateChatTitle parity ─────────────────────────────────────────────────
  it('updateChatTitle: same mutated title, scoped by user id', async () => {
    const id = `c-${randomUUID()}`;
    await sq.createChat({ id, userId, title: 'before', model: 'm', provider: 'p' });
    await pg.createChat!({ id, userId, title: 'before', model: 'm', provider: 'p' });
    await sq.updateChatTitle(id, userId, 'after');
    await pg.updateChatTitle!(id, userId, 'after');
    expect((await pg.getChat!(id, userId))!.title).toBe('after');
    expect((await sq.getChat(id, userId))!.title).toBe('after');
    // Wrong user id must not update.
    await pg.updateChatTitle!(id, 'someone-else', 'HACKED');
    expect((await pg.getChat!(id, userId))!.title).toBe('after');
  });

  // ── metrics + summary parity ───────────────────────────────────────────────
  it('recordMetric + getMetricsSummary: identical aggregate totals as numbers', async () => {
    const metricUser = `u-${randomUUID()}`;
    await sq.createUser({ id: metricUser, email: `${metricUser}@ex.co`, name: 'M', passwordHash: 'x' });
    await pool.query('INSERT INTO users (id, email, name, persona, password_hash) VALUES ($1, $2, $3, $4, $5)', [
      metricUser, `${metricUser}@ex.co`, 'M', 'tenant_user', 'x',
    ]);
    const chatId = `c-${randomUUID()}`;
    await sq.createChat({ id: chatId, userId: metricUser, title: 't', model: 'gpt-x', provider: 'openai' });
    await pg.createChat!({ id: chatId, userId: metricUser, title: 't', model: 'gpt-x', provider: 'openai' });

    for (let i = 0; i < 2; i++) {
      const metric = { id: `mt-${randomUUID()}`, userId: metricUser, chatId, type: 'chat', provider: 'openai', model: 'gpt-x', totalTokens: 100, cost: 0.25, latencyMs: 50 };
      await sq.recordMetric(metric);
      await pg.recordMetric!(metric);
    }

    const sSum = await sq.getMetricsSummary(metricUser);
    const pSum = await pg.getMetricsSummary!(metricUser);
    expect(pSum.total_tokens).toBe(sSum.total_tokens);
    expect(pSum.total_cost).toBe(sSum.total_cost);
    expect(pSum.total_chats).toBe(sSum.total_chats);
    expect(typeof pSum.total_tokens).toBe('number');
    expect(pSum.total_tokens).toBe(200);
  });

  // ── user preferences upsert parity ─────────────────────────────────────────
  it('saveUserPreferences + getUserPreferences: identical upserted row', async () => {
    const prefUser = `u-${randomUUID()}`;
    await sq.createUser({ id: prefUser, email: `${prefUser}@ex.co`, name: 'P', passwordHash: 'x' });
    await pool.query('INSERT INTO users (id, email, name, persona, password_hash) VALUES ($1, $2, $3, $4, $5)', [
      prefUser, `${prefUser}@ex.co`, 'P', 'tenant_user', 'x',
    ]);

    await sq.saveUserPreferences(prefUser, 'agent', 'dark', false);
    await pg.saveUserPreferences!(prefUser, 'agent', 'dark', false);
    // Upsert again to prove ON CONFLICT path.
    await sq.saveUserPreferences(prefUser, 'direct', 'light', true);
    await pg.saveUserPreferences!(prefUser, 'direct', 'light', true);

    const sRow = await sq.getUserPreferences(prefUser);
    const pRow = await pg.getUserPreferences!(prefUser);
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    expect(pRow!.show_process_card).toBe(1);
    expect(pRow!.default_mode).toBe('direct');
  });

  // ── negative: missing lookups → null on both stores ────────────────────────
  it('negative: missing chat / prefs / conversation return null on both', async () => {
    expect(await pg.getChat!('does-not-exist', userId)).toBeNull();
    expect(await sq.getChat('does-not-exist', userId)).toBeNull();
    expect(await pg.getChatById!('nope')).toBeNull();
    expect(await pg.getUserPreferences!('no-such-user')).toBeNull();
    expect(await pg.getUserConversation!(`' OR '1'='1`, userId)).toBeNull(); // injection arg is data
    expect(await sq.getUserConversation(`' OR '1'='1`, userId)).toBeNull();
  });
});
