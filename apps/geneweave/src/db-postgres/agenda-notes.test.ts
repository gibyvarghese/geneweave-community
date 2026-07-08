// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IAgendaNotesStore` slice (`pgAgendaNotesStore`). Proves it returns the
 * SAME rows as a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway
 * Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape. List
 * comparisons are scoped to THIS test's inserted ids/user so a shared container never leaks rows in.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgAgendaNotesStore } from './agenda-notes.js';
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
  expect(created_at).toMatch(TS_RE);
  expect(updated_at).toMatch(TS_RE);
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-agenda-notes-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgAgendaNotesStore — IAgendaNotesStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgAgendaNotesStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgAgendaNotesStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── agenda item: create + get parity ───────────────────────────────────────
  it('createAgendaItem + getAgendaItem: identical rows on both stores', async () => {
    const id = randomUUID();
    const userId = `u-${randomUUID()}`;
    const item = {
      id,
      user_id: userId,
      title: "O'Brien's \"quarterly\" review ☃",
      kind: 'deadline' as const,
      start_at: '2026-08-01T09:00:00',
      all_day: 1,
      amount: '1200.50',
      currency: 'EUR',
    };
    await sq.createAgendaItem(item);
    await pg.createAgendaItem!(item);

    const sRow = await sq.getAgendaItem(id, userId);
    const pRow = await pg.getAgendaItem!(id, userId);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    // Integer boolean preserved as a number, not coerced to true/false.
    expect(pRow!.all_day).toBe(1);
  });

  // ── agenda list parity, incl. filter + ordering, scoped to THIS user ───────
  it('listAgendaItems: same order and same kind-filtering for our user', async () => {
    const userId = `u-${randomUUID()}`;
    const rows = [
      { id: randomUUID(), title: 'later', kind: 'event' as const, start_at: '2026-09-10T10:00:00' },
      { id: randomUUID(), title: 'earlier', kind: 'reminder' as const, start_at: '2026-09-01T10:00:00' },
      { id: randomUUID(), title: 'middle', kind: 'event' as const, start_at: '2026-09-05T10:00:00' },
    ];
    for (const r of rows) {
      const item = { id: r.id, user_id: userId, title: r.title, kind: r.kind, start_at: r.start_at };
      await sq.createAgendaItem(item);
      await pg.createAgendaItem!(item);
    }

    const sAll = await sq.listAgendaItems(userId);
    const pAll = await pg.listAgendaItems!(userId);
    expect(pAll.map((r) => r.id)).toEqual(sAll.map((r) => r.id));
    expect(pAll.map((r) => r.title)).toEqual(['earlier', 'middle', 'later']); // COALESCE(start_at,...) ASC

    const sEvents = await sq.listAgendaItems(userId, { kind: 'event' });
    const pEvents = await pg.listAgendaItems!(userId, { kind: 'event' });
    expect(pEvents.map((r) => r.id)).toEqual(sEvents.map((r) => r.id));
    expect(pEvents.map((r) => r.title)).toEqual(['middle', 'later']); // reminder filtered out
  });

  // ── agenda update parity ───────────────────────────────────────────────────
  it('updateAgendaItem: same mutated row, owner-scoped', async () => {
    const id = randomUUID();
    const userId = `u-${randomUUID()}`;
    await sq.createAgendaItem({ id, user_id: userId, title: 'before', status: 'proposed' });
    await pg.createAgendaItem!({ id, user_id: userId, title: 'before', status: 'proposed' });

    const patch = { title: 'after', status: 'confirmed' as const, location: 'Munich' };
    await sq.updateAgendaItem(id, userId, patch);
    await pg.updateAgendaItem!(id, userId, patch);

    const sRow = await sq.getAgendaItem(id, userId);
    const pRow = await pg.getAgendaItem!(id, userId);
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    expect(pRow!.title).toBe('after');
    expect(pRow!.status).toBe('confirmed');
  });

  // ── agenda delete parity (returns boolean) ─────────────────────────────────
  it('deleteAgendaItem: removes the row and returns the same boolean', async () => {
    const id = randomUUID();
    const userId = `u-${randomUUID()}`;
    await sq.createAgendaItem({ id, user_id: userId, title: 'doomed' });
    await pg.createAgendaItem!({ id, user_id: userId, title: 'doomed' });

    expect(await pg.deleteAgendaItem!(id, userId)).toBe(await sq.deleteAgendaItem(id, userId));
    expect(await pg.getAgendaItem!(id, userId)).toBeNull();
    expect(await sq.getAgendaItem(id, userId)).toBeNull();
    // second delete: nothing to remove → false on both
    expect(await pg.deleteAgendaItem!(id, userId)).toBe(false);
    expect(await sq.deleteAgendaItem(id, userId)).toBe(false);
  });

  // ── note: create + get parity ──────────────────────────────────────────────
  it('createNote + getNote: identical rows on both stores', async () => {
    const id = randomUUID();
    const userId = `u-${randomUUID()}`;
    const note = {
      id,
      owner_user_id: userId,
      title: "Meeting — O'Brien ☃",
      icon: '📓',
      doc_json: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
      favorite: 1,
    };
    await sq.createNote(note);
    await pg.createNote!(note);

    const sRow = await sq.getNote(id, userId);
    const pRow = await pg.getNote!(id, userId);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    expect(pRow!.favorite).toBe(1);
  });

  // ── note list parity with search filter, scoped to THIS user ───────────────
  it('listNotes: same order (favorite DESC, updated_at DESC) and same search filtering', async () => {
    const userId = `u-${randomUUID()}`;
    const tag = randomUUID().slice(0, 8);
    const notes = [
      { id: randomUUID(), title: `${tag}-plain`, favorite: 0 },
      { id: randomUUID(), title: `${tag}-starred`, favorite: 1 },
    ];
    for (const n of notes) {
      const note = { id: n.id, owner_user_id: userId, title: n.title, favorite: n.favorite };
      await sq.createNote(note);
      await pg.createNote!(note);
    }

    const sAll = (await sq.listNotes(userId)).filter((r) => r.title.startsWith(tag));
    const pAll = (await pg.listNotes!(userId)).filter((r) => r.title.startsWith(tag));
    expect(pAll.map((r) => r.id)).toEqual(sAll.map((r) => r.id));
    expect(pAll.map((r) => r.title)).toEqual([`${tag}-starred`, `${tag}-plain`]); // favorite first

    const sSearch = (await sq.listNotes(userId, { search: `${tag}-starred` })).filter((r) => r.title.startsWith(tag));
    const pSearch = (await pg.listNotes!(userId, { search: `${tag}-starred` })).filter((r) => r.title.startsWith(tag));
    expect(pSearch.map((r) => r.id)).toEqual(sSearch.map((r) => r.id));
    expect(pSearch.map((r) => r.title)).toEqual([`${tag}-starred`]);
  });

  // ── note archive + delete parity (both return boolean) ─────────────────────
  it('archiveNote + deleteNote: same booleans, archive hides from active list', async () => {
    const id = randomUUID();
    const userId = `u-${randomUUID()}`;
    await sq.createNote({ id, owner_user_id: userId, title: 'to-archive' });
    await pg.createNote!({ id, owner_user_id: userId, title: 'to-archive' });

    const at = '2026-07-06 12:00:00';
    expect(await pg.archiveNote!(id, userId, at)).toBe(await sq.archiveNote(id, userId, at));
    // re-archive is a no-op → false on both
    expect(await pg.archiveNote!(id, userId, at)).toBe(false);
    expect(await sq.archiveNote(id, userId, at)).toBe(false);

    const sArchived = (await sq.listNotes(userId, { archived: true })).map((r) => r.id);
    const pArchived = (await pg.listNotes!(userId, { archived: true })).map((r) => r.id);
    expect(pArchived).toContain(id);
    expect(sArchived).toContain(id);

    expect(await pg.deleteNote!(id, userId)).toBe(await sq.deleteNote(id, userId));
    expect(await pg.getNote!(id, userId)).toBeNull();
    expect(await sq.getNote(id, userId)).toBeNull();
  });

  // ── negative: missing ids → null / false (no throw, no boolean-blind leak) ─
  it('negative: missing rows return null/false on both, and injection args are data', async () => {
    expect(await pg.getAgendaItem!('does-not-exist', 'nobody')).toBeNull();
    expect(await sq.getAgendaItem('does-not-exist', 'nobody')).toBeNull();
    expect(await pg.getNote!(`' OR '1'='1`, `' OR '1'='1`)).toBeNull(); // injection arg is data, not code
    expect(await sq.getNote(`' OR '1'='1`, `' OR '1'='1`)).toBeNull();
    expect(await pg.deleteNote!('does-not-exist', 'nobody')).toBe(false);
    expect(await sq.deleteNote('does-not-exist', 'nobody')).toBe(false);
  });
});
