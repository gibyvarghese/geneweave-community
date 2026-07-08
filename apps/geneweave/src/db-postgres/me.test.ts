// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IMeStore` slice (`pgMeStore`). Proves it returns the SAME rows as a
 * fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * differ by wall-clock between the two stores, so they're normalised away before comparison — but each
 * is asserted to carry a valid `YYYY-MM-DD HH:MM:SS` (or ISO-ms) shape.
 *
 * `initialize()` seeds default catalog rows (mode_labels / starter_prompts) into the SQLite store, so
 * EVERY list comparison here is scoped to ids/users this test inserted; same-second lists are compared
 * as id-keyed SETS, not by array position.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgMeStore } from './me.js';
import { SQLiteAdapter } from '../db-sqlite.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

// Accepts BOTH SQLite `YYYY-MM-DD HH:MM:SS` and ISO `YYYY-MM-DDTHH:MM:SS(.mmm)Z` timestamp shapes.
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+Z?)?$/;

/** Strip clock-dependent columns after asserting each carries a valid timestamp shape. */
function normTs<T extends { created_at?: string; updated_at?: string }>(row: T): Omit<T, 'created_at' | 'updated_at'> {
  const { created_at, updated_at, ...rest } = row;
  if (created_at !== undefined) expect(created_at).toMatch(TS_RE);
  if (updated_at !== undefined) expect(updated_at).toMatch(TS_RE);
  return rest;
}

/** Key a list by id for set-wise comparison (order-independent for same-second rows). */
function byId<T extends { id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-me-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgMeStore — IMeStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgMeStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgMeStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // Create the FK parent user_runs row on both stores.
  async function seedRun(runId: string, userId: string): Promise<void> {
    const run = { id: runId, user_id: userId, status: 'running' as const, surface: 'chat', metadata: '{}' };
    await sq.createUserRun(run);
    await pg.createUserRun!(run);
  }

  // ── createUserRun + getUserRun (+ missing→null) ────────────────────────────
  it('createUserRun + getUserRun: identical row; missing id → null on both', async () => {
    const id = randomUUID();
    const userId = `u-${randomUUID()}`;
    const run = { id, user_id: userId, status: 'pending' as const, surface: 'agenda', metadata: JSON.stringify({ note: "O'Brien ☃" }) };
    await sq.createUserRun(run);
    await pg.createUserRun!(run);

    const sRow = await sq.getUserRun(id, userId);
    const pRow = await pg.getUserRun!(id, userId);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));

    expect(await pg.getUserRun!('does-not-exist', userId)).toBeNull();
    expect(await sq.getUserRun('does-not-exist', userId)).toBeNull();
  });

  // ── run events: idempotent insert + afterSequence filter ───────────────────
  it('appendUserRunEvent + listUserRunEvents: idempotent + afterSequence, same rows', async () => {
    const runId = randomUUID();
    const userId = `u-${randomUUID()}`;
    await seedRun(runId, userId);

    const ev = (seq: number) => ({ id: `${runId}-${seq}`, run_id: runId, sequence: seq, kind: 'delta', payload: JSON.stringify({ seq }) });
    for (const seq of [0, 1, 2]) {
      await sq.appendUserRunEvent(ev(seq));
      await pg.appendUserRunEvent!(ev(seq));
    }
    // Re-insert seq 1 (same id) — INSERT OR IGNORE / ON CONFLICT DO NOTHING must swallow it.
    await sq.appendUserRunEvent(ev(1));
    await pg.appendUserRunEvent!(ev(1));

    const sAll = await sq.listUserRunEvents(runId);
    const pAll = await pg.listUserRunEvents!(runId);
    expect(pAll.map((r) => r.sequence)).toEqual(sAll.map((r) => r.sequence));
    expect(pAll.map((r) => r.sequence)).toEqual([0, 1, 2]);

    const sAfter = await sq.listUserRunEvents(runId, 0);
    const pAfter = await pg.listUserRunEvents!(runId, 0);
    expect(pAfter.map((r) => r.sequence)).toEqual(sAfter.map((r) => r.sequence));
    expect(pAfter.map((r) => r.sequence)).toEqual([1, 2]);
  });

  // ── presence: upsert (heartbeat) + TTL filter + peer_type/user ordering ─────
  it('upsertRunPresence + listActiveRunPresence: upsert + TTL filter, same active set', async () => {
    const runId = randomUUID();
    const userId = `u-${randomUUID()}`;
    await seedRun(runId, userId);
    const now = 1_000_000;

    const mk = (uid: string, peer: string, exp: number) => ({
      id: `${runId}-${uid}`, run_id: runId, tenant_id: null, user_id: uid, display_name: uid,
      presence: 'active', peer_type: peer, color: null, cursor_json: null, last_heartbeat_at: now, expires_at: exp,
    });
    // human (live), agent (live), a human that has already expired
    await sq.upsertRunPresence(mk('bob', 'human', now + 5000));
    await pg.upsertRunPresence!(mk('bob', 'human', now + 5000));
    await sq.upsertRunPresence(mk('agent', 'agent', now + 5000));
    await pg.upsertRunPresence!(mk('agent', 'agent', now + 5000));
    await sq.upsertRunPresence(mk('gone', 'human', now - 1));
    await pg.upsertRunPresence!(mk('gone', 'human', now - 1));
    // Heartbeat re-upsert for bob (updates expiry; must NOT create a duplicate row).
    await sq.upsertRunPresence(mk('bob', 'human', now + 9999));
    await pg.upsertRunPresence!(mk('bob', 'human', now + 9999));

    const sActive = await sq.listActiveRunPresence(runId, now);
    const pActive = await pg.listActiveRunPresence!(runId, now);
    // Same order (peer_type DESC byte-order, user_id ASC): [bob(human), agent(agent)].
    expect(pActive.map((r) => r.user_id)).toEqual(sActive.map((r) => r.user_id));
    expect(pActive.map((r) => r.user_id)).toEqual(['bob', 'agent']);
    expect(pActive.find((r) => r.user_id === 'bob')!.expires_at).toBe(now + 9999);
  });

  // ── notification feed: dedupe idempotency returns the surviving row ─────────
  it('appendNotificationFeed: dedupe-key insert is idempotent; returns surviving row', async () => {
    const principal = `p-${randomUUID()}`;
    const dedupe = `dk-${randomUUID()}`;
    const first = {
      id: randomUUID(), tenant_id: null, principal_id: principal, category: 'run', title: 'first',
      body: null, deep_link: null, priority: 'normal' as const, dedupe_key: dedupe, created_at: 111, read_at: null,
    };
    const dup = { ...first, id: randomUUID(), title: 'second-should-be-ignored' };

    const sFirst = await sq.appendNotificationFeed(first);
    const pFirst = await pg.appendNotificationFeed!(first);
    expect(pFirst.id).toBe(sFirst.id);

    const sDup = await sq.appendNotificationFeed(dup);
    const pDup = await pg.appendNotificationFeed!(dup);
    // Both must return the ORIGINAL surviving row (title 'first', original id), not the duplicate.
    expect(pDup.id).toBe(sDup.id);
    expect(pDup.id).toBe(first.id);
    expect(pDup.title).toBe('first');

    const sCnt = await sq.countUnreadNotificationFeed('__global__', principal);
    const pCnt = await pg.countUnreadNotificationFeed!('__global__', principal);
    expect(pCnt).toBe(sCnt);
    expect(pCnt).toBe(1);
  });

  // ── note suggestions: before_text default + status filter + resolve rowcount ─
  it('createNoteSuggestion + list + resolve: before_text default, filter, one-time resolve', async () => {
    const noteId = randomUUID();
    const userId = `u-${randomUUID()}`;
    // FK parent note on both stores.
    await sq.createNote({ id: noteId, owner_user_id: userId, title: 'N' });
    await pool.query(
      `INSERT INTO notes (id, owner_user_id, title, doc_json) VALUES ($1, $2, $3, '{"type":"doc","content":[]}')`,
      [noteId, userId, 'N'],
    );

    const sug = (sid: string, status: 'pending') => ({
      id: sid, note_id: noteId, doc_id: `doc-${noteId}`, tenant_id: null,
      author_kind: 'agent' as const, author_id: 'ai', author_site: 'site-a',
      action: 'continue' as const, status, ops_json: '[]', preview_text: 'hi',
      // before_text intentionally omitted → must default to '' on both stores.
      anchor_json: null, created_at: 500, resolved_at: null, resolved_by: null,
    });
    const s1 = randomUUID();
    await sq.createNoteSuggestion(sug(s1, 'pending'));
    await pg.createNoteSuggestion!(sug(s1, 'pending'));

    const sPending = await sq.listNoteSuggestions(noteId, 'pending');
    const pPending = await pg.listNoteSuggestions!(noteId, 'pending');
    expect(byId(pPending.map((r) => ({ ...r, id: r.id })))).toBeDefined();
    expect(pPending.map((r) => r.id)).toEqual(sPending.map((r) => r.id));
    expect(pPending[0]!.before_text).toBe('');
    expect(pPending[0]!.before_text).toBe(sPending[0]!.before_text);

    // Resolve once → 1 row changed on both; resolving again → 0 (idempotent guard).
    const sChanged = await sq.resolveNoteSuggestion(s1, 'accepted', 900, 'human');
    const pChanged = await pg.resolveNoteSuggestion!(s1, 'accepted', 900, 'human');
    expect(pChanged).toBe(sChanged);
    expect(pChanged).toBe(1);
    expect(await pg.resolveNoteSuggestion!(s1, 'accepted', 901, 'human')).toBe(await sq.resolveNoteSuggestion(s1, 'accepted', 901, 'human'));
    expect(await pg.resolveNoteSuggestion!(s1, 'accepted', 902, 'human')).toBe(0);
  });

  // ── tenant appearance: upsert + list byte-order (COLLATE "C") ───────────────
  it('upsertTenantAppearance + listTenantAppearance: byte-order sort, same rows (SET-scoped)', async () => {
    const tag = randomUUID().slice(0, 8);
    const mk = (tid: string) => ({
      tenant_id: tid, enabled: 1, brand_name: 'B', logo_svg: null, color_scheme: 'system',
      variant: 'pro', accent: null, on_accent: null, corner_style: 'soft',
      font_display: null, font_body: null, density: 'comfortable', updated_at: '2026-01-01 00:00:00',
    });
    // Chosen so uppercase sorts BEFORE lowercase under COLLATE "C" (byte order), unlike locale.
    const tids = [`${tag}-zeta`, `${tag}-Alpha`, `${tag}-beta`];
    for (const tid of tids) {
      await sq.upsertTenantAppearance(mk(tid));
      await pg.upsertTenantAppearance!(mk(tid));
    }
    // Upsert one again with a changed field → must UPDATE, not duplicate.
    await sq.upsertTenantAppearance({ ...mk(`${tag}-beta`), variant: 'creative' });
    await pg.upsertTenantAppearance!({ ...mk(`${tag}-beta`), variant: 'creative' });

    const sAll = (await sq.listTenantAppearance()).filter((r) => r.tenant_id.startsWith(tag));
    const pAll = (await pg.listTenantAppearance!()).filter((r) => r.tenant_id.startsWith(tag));
    expect(pAll.map((r) => r.tenant_id)).toEqual(sAll.map((r) => r.tenant_id));
    expect(pAll.map((r) => r.tenant_id)).toEqual([`${tag}-Alpha`, `${tag}-beta`, `${tag}-zeta`]);
    expect(pAll.find((r) => r.tenant_id === `${tag}-beta`)!.variant).toBe('creative');
  });

  // ── weaveNotes settings: single global row + dynamic partial UPDATE ─────────
  it('getWeaveNotesSettings + updateWeaveNotesSettings: single global row, partial update parity', async () => {
    // SQLite seeds the 'global' row in initialize(); the Postgres test loads DDL only (no seed data),
    // so seed the same single row here so the parity comparison is apples-to-apples.
    await pool.query(`INSERT INTO weavenotes_settings (id) VALUES ('global') ON CONFLICT DO NOTHING`);
    const sBefore = await sq.getWeaveNotesSettings();
    const pBefore = await pg.getWeaveNotesSettings!();
    expect(pBefore).not.toBeNull();
    expect(sBefore).not.toBeNull();
    expect(pBefore!.id).toBe('global');
    expect(pBefore!.id).toBe(sBefore!.id);

    await sq.updateWeaveNotesSettings({ default_theme: 'creative', max_ai_tokens_per_edit: 8000 });
    await pg.updateWeaveNotesSettings!({ default_theme: 'creative', max_ai_tokens_per_edit: 8000 });

    const sAfter = await sq.getWeaveNotesSettings();
    const pAfter = await pg.getWeaveNotesSettings!();
    expect(pAfter!.default_theme).toBe('creative');
    expect(pAfter!.default_theme).toBe(sAfter!.default_theme);
    expect(pAfter!.max_ai_tokens_per_edit).toBe(8000);
    expect(pAfter!.max_ai_tokens_per_edit).toBe(sAfter!.max_ai_tokens_per_edit);
    // Empty patch is a no-op on both (no throw).
    await pg.updateWeaveNotesSettings!({});
    await sq.updateWeaveNotesSettings({});
  });

  // ── mode labels: is_default exclusivity + sort ordering (scoped to a surface) ─
  it('createModeLabel + listModeLabels: is_default is exclusive per surface, same order', async () => {
    const surface = `surf-${randomUUID()}`;
    const mk = (id: string, key: string, sort: number, isDefault: number) => ({
      id, surface_id: surface, mode_key: key, label: key.toUpperCase(), sort_order: sort, is_default: isDefault, enabled: 1,
    });
    await sq.createModeLabel(mk('m-a', 'alpha', 0, 1));
    await pg.createModeLabel!(mk('m-a', 'alpha', 0, 1));
    await sq.createModeLabel(mk('m-b', 'beta', 1, 0));
    await pg.createModeLabel!(mk('m-b', 'beta', 1, 0));
    // Creating a second default must flip the first to is_default = 0 on both stores.
    await sq.createModeLabel(mk('m-c', 'gamma', 2, 1));
    await pg.createModeLabel!(mk('m-c', 'gamma', 2, 1));

    const sList = await sq.listModeLabels(surface);
    const pList = await pg.listModeLabels!(surface);
    expect(pList.map((r) => r.id)).toEqual(sList.map((r) => r.id));
    expect(pList.map((r) => r.id)).toEqual(['m-a', 'm-b', 'm-c']);
    // Exactly one default remains, and it's gamma (the last one created).
    const pDefaults = pList.filter((r) => r.is_default === 1).map((r) => r.id);
    const sDefaults = sList.filter((r) => r.is_default === 1).map((r) => r.id);
    expect(pDefaults).toEqual(sDefaults);
    expect(pDefaults).toEqual(['m-c']);
  });

  // ── temporal reminders cross-chat view: scope_id LIKE `${userId}:%` ─────────
  it('listTemporalRemindersByUserId + delete: user-scoped LIKE filter, same rows', async () => {
    const userId = `u-${randomUUID()}`;
    const scopeA = `${userId}:chat-1`;
    const scopeB = `${userId}:chat-2`;
    const otherScope = `other-${randomUUID()}:chat-9`;
    const mk = (id: string, scope: string, due: string) => ({
      id, scopeId: scope, text: 'ping', dueAt: due, timezone: 'UTC', status: 'scheduled', createdAt: '2026-01-01T00:00:00.000Z', cancelledAt: null,
    });
    // upsertTemporalReminder is an IChatStore method present on the SQLite adapter; insert into PG directly.
    const rem = [mk('r1', scopeA, '2026-06-01T09:00:00.000Z'), mk('r2', scopeB, '2026-05-01T09:00:00.000Z'), mk('r3', otherScope, '2026-04-01T09:00:00.000Z')];
    for (const r of rem) {
      await sq.upsertTemporalReminder(r);
      await pool.query(
        `INSERT INTO temporal_reminders (id, scope_id, text, due_at, timezone, status, created_at, cancelled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.id, r.scopeId, r.text, r.dueAt, r.timezone, r.status, r.createdAt, r.cancelledAt],
      );
    }

    const sMine = await sq.listTemporalRemindersByUserId(userId);
    const pMine = await pg.listTemporalRemindersByUserId!(userId);
    // Ordered by due_at ASC → [r2 (May), r1 (June)]; other user's r3 excluded.
    expect(pMine.map((r) => r.id)).toEqual(sMine.map((r) => r.id));
    expect(pMine.map((r) => r.id)).toEqual(['r2', 'r1']);

    // Delete one → true on both; deleting the other user's reminder via THIS user → false.
    expect(await pg.deleteTemporalReminderById!('r2', userId)).toBe(await sq.deleteTemporalReminderById('r2', userId));
    expect(await pg.deleteTemporalReminderById!('r3', userId)).toBe(false);
    expect(await sq.deleteTemporalReminderById('r3', userId)).toBe(false);
  });
});
