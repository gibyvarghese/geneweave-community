// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IMemoryStore` slice (`pgMemoryStore`). Proves it returns the SAME rows
 * as a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker
 * container — including the JS-side cosine-similarity semantic search and the entity upsert/merge path.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgMemoryStore } from './memory.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { SemanticMemoryRow, EntityMemoryRow } from '../db-types/memory.js';

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
  return new SQLiteAdapter(join(tmpdir(), `gw-memory-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgMemoryStore — IMemoryStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgMemoryStore>;
  let sq: SQLiteAdapter;

  /** Insert a user row on both stores so FK-constrained memory inserts (user_id) succeed. */
  const seedUser = async (userId: string): Promise<void> => {
    const email = `${userId}@parity.test`;
    await sq.createUser({ id: userId, email, name: 'parity', passwordHash: 'x' });
    await pool.query(
      'INSERT INTO users (id, email, name, persona, tenant_id, password_hash, email_bidx) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, email, 'parity', 'tenant_user', null, 'x', null],
    );
  };

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgMemoryStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── saveSemanticMemory + getSemanticMemoryById parity ──────────────────────
  it('saveSemanticMemory + getSemanticMemoryById: identical rows on both stores', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    const id = randomUUID();
    const mem = {
      id,
      userId,
      content: "O'Brien prefers the \"balanced\" tier ☃",
      memoryType: 'preference',
      source: 'user',
      embedding: [0.1, 0.2, 0.3],
      metadata: JSON.stringify({ supersede: null }),
    };
    await sq.saveSemanticMemory(mem);
    await pg.saveSemanticMemory!(mem);

    const sRow = await sq.getSemanticMemoryById(id, userId);
    const pRow = await pg.getSemanticMemoryById!(id, userId);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    // embedding stored as JSON TEXT pass-through, not a pgvector column.
    expect(pRow!.embedding).toBe(JSON.stringify([0.1, 0.2, 0.3]));
  });

  // ── searchSemanticMemory: JS-side cosine ranking is byte-identical ─────────
  it('searchSemanticMemory (queryEmbedding): same cosine-ranked ids on both stores', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    // Three orthogonal-ish vectors; the query is closest to `near`, then `mid`, then `far`.
    const seeds = [
      { tag: 'near', embedding: [1, 0, 0] },
      { tag: 'mid', embedding: [0.7, 0.7, 0] },
      { tag: 'far', embedding: [0, 0, 1] },
    ];
    const ids: Record<string, string> = {};
    for (const s of seeds) {
      const id = randomUUID();
      ids[s.tag] = id;
      const m = { id, userId, content: `fact ${s.tag}`, embedding: s.embedding };
      await sq.saveSemanticMemory(m);
      await pg.saveSemanticMemory!(m);
    }
    const q = { userId, query: 'anything', limit: 3, queryEmbedding: [1, 0, 0] };
    const sHits = (await sq.searchSemanticMemory(q)).map((r) => r.id);
    const pHits = (await pg.searchSemanticMemory!(q)).map((r) => r.id);
    // Same set (scoped to this user's inserts) AND same order.
    expect(pHits).toEqual(sHits);
    expect(pHits[0]).toBe(ids['near']); // closest wins on both
  });

  // ── upsertEntity + getEntity parity, incl. fact-merge + case-insensitive get ─
  it('upsertEntity (merge) + getEntity (case-insensitive): identical merged row', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    const name = `Acme-${randomUUID().slice(0, 8)}`;
    const first = { userId, entityName: name, entityType: 'organization', facts: { city: 'Munich' }, confidence: 0.6 };
    const second = { userId, entityName: name, entityType: 'organization', facts: { sector: 'pharma' }, confidence: 0.9 };
    await sq.upsertEntity(first); await pg.upsertEntity!(first);
    await sq.upsertEntity(second); await pg.upsertEntity!(second);

    // Look up with a different case to exercise COLLATE NOCASE → LOWER(...).
    const sRow = await sq.getEntity(userId, name.toUpperCase());
    const pRow = await pg.getEntity!(userId, name.toUpperCase());
    expect(pRow).not.toBeNull();
    // `id` is a fresh UUIDv7 per store, so compare everything else. Facts merged, confidence maxed.
    const sNorm = normTs(sRow!) as Omit<EntityMemoryRow, 'created_at' | 'updated_at'>;
    const pNorm = normTs(pRow!) as Omit<EntityMemoryRow, 'created_at' | 'updated_at'>;
    expect(JSON.parse(pNorm.facts)).toEqual(JSON.parse(sNorm.facts));
    expect(JSON.parse(pNorm.facts)).toEqual({ city: 'Munich', sector: 'pharma' });
    expect(pNorm.confidence).toBe(sNorm.confidence);
    expect(pNorm.confidence).toBe(0.9);
    expect(pNorm.source).toBe(sNorm.source);
  });

  // ── listSemanticMemory: byte-order + scoped to this user ───────────────────
  it('listSemanticMemory: same rows, newest-first, scoped to the test user', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    for (let i = 0; i < 3; i++) {
      const m = { id: randomUUID(), userId, content: `note ${i}` };
      await sq.saveSemanticMemory(m);
      await pg.saveSemanticMemory!(m);
    }
    const sList = (await sq.listSemanticMemory(userId, 50)) as SemanticMemoryRow[];
    const pList = (await pg.listSemanticMemory!(userId, 50)) as SemanticMemoryRow[];
    expect(pList.map((r) => r.id)).toEqual(sList.map((r) => r.id));
    expect(pList.map((r) => normTs(r))).toEqual(sList.map((r) => normTs(r)));
  });

  // ── deleteEntity returns affected-count parity ─────────────────────────────
  it('deleteEntity: returns the same removed-count (1) then 0 on a second delete', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    const name = `Del-${randomUUID().slice(0, 8)}`;
    const ent = { userId, entityName: name, facts: { a: 1 } };
    await sq.upsertEntity(ent); await pg.upsertEntity!(ent);
    expect(await pg.deleteEntity!(userId, name)).toBe(await sq.deleteEntity(userId, name)); // both 1
    expect(await pg.deleteEntity!(userId, name)).toBe(await sq.deleteEntity(userId, name)); // both 0
  });

  // ── negative: missing lookups → null on both, injection arg is data ────────
  it('negative: missing semantic id and missing entity return null/empty on both', async () => {
    const userId = `u-${randomUUID()}`;
    await seedUser(userId);
    expect(await pg.getSemanticMemoryById!('nope', userId)).toBeNull();
    expect(await sq.getSemanticMemoryById('nope', userId)).toBeNull();
    expect(await pg.getEntity!(userId, `' OR '1'='1`)).toBeNull(); // injection arg is data, not code
    expect(await sq.getEntity(userId, `' OR '1'='1`)).toBeNull();
    expect(await pg.listSemanticMemory!(userId, 50)).toEqual([]);
    expect(await sq.listSemanticMemory(userId, 50)).toEqual([]);
  });
});
