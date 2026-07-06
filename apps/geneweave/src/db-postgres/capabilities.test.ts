// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres capabilities store (`pgCapabilityStore`). Proves the Postgres port of
 * the `ICapabilityStore` slice returns the *same* rows as the reference SQLite adapter for identical
 * inputs, against a REAL Postgres spun up in a throwaway Docker container. Timestamps (created_at /
 * updated_at / installed_at) differ by clock, so they're asserted to match the shared timestamp shape
 * and then normalised away before comparing. A missing-id lookup is asserted to return null.
 *
 * Auto-skips when Docker isn't available, so `npm test` stays green on any machine. Nothing is mocked.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../db-sqlite.js';
import { pgCapabilityStore } from './capabilities.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import type {
  CapabilityPackRow,
  CapabilityPackInstallationRow,
  CapabilityPackExperimentRow,
} from '../db-types/capabilities.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

// ── Helpers ──────────────────────────────────────────────────────────────────
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Strip clock-dependent timestamp columns so SQLite and Postgres rows compare cleanly. */
function stripTimestamps<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const { created_at, updated_at, installed_at, ...rest } = row as unknown as Record<string, unknown>;
  void created_at; void updated_at; void installed_at;
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-pg-cap-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('Postgres capabilities store — parity with SQLite (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgCapabilityStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgCapabilityStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── create + get: a pack round-trips identically ──────────────────────────
  it('createCapabilityPack + getCapabilityPack: identical rows on Postgres and SQLite', async () => {
    const id = randomUUID();
    const pack: Omit<CapabilityPackRow, 'created_at' | 'updated_at'> = {
      id, pack_key: 'invoices', version: '1.2.0', status: 'published',
      name: 'Invoice Reader', description: "O'Brien's \"pack\" ☃",
      authored_by: 'ada', manifest: JSON.stringify({ tools: ['ocr'] }),
      installed_at: null, installed_by: null,
    };
    await sq.createCapabilityPack(pack);
    await pg.createCapabilityPack!(pack);

    const p = await pg.getCapabilityPack!(id);
    const s = await sq.getCapabilityPack(id);
    expect(p).not.toBeNull();
    expect(p!.created_at).toMatch(TS_RE);
    expect(s!.created_at).toMatch(TS_RE);
    expect(stripTimestamps(p as never)).toEqual(stripTimestamps(s as never));
  });

  // ── negative: a missing id returns null on both ───────────────────────────
  it('getCapabilityPack: missing id → null (both adapters)', async () => {
    expect(await pg.getCapabilityPack!('no-such-pack')).toBeNull();
    expect(await sq.getCapabilityPack('no-such-pack')).toBeNull();
  });

  // ── list + filter + ordering parity ───────────────────────────────────────
  // The leading sort key is `pack_key COLLATE "C" ASC`; we give each row a DISTINCT pack_key so the
  // order is fully determined by that key. (The SQLite impl's final `rowid DESC` tiebreak has no
  // Postgres equivalent, so parity is only well-defined when the real ordering keys are distinct —
  // which they are for any realistic pack listing.)
  it('listCapabilityPacks: same rows, same order (byte-order COLLATE "C")', async () => {
    const run = randomUUID();
    // pack_keys chosen so COLLATE "C" (byte order: uppercase before lowercase) gives a stable order.
    const packs: Array<Omit<CapabilityPackRow, 'created_at' | 'updated_at'>> = [
      { id: `${run}-1`, pack_key: `${run}-Zebra`, version: '1.0.0', status: 'published', name: 'zebra', description: '', authored_by: null, manifest: '{}', installed_at: null, installed_by: null },
      { id: `${run}-2`, pack_key: `${run}-Apple`, version: '2.0.0', status: 'draft', name: 'Apple', description: '', authored_by: null, manifest: '{}', installed_at: null, installed_by: null },
      { id: `${run}-3`, pack_key: `${run}-banana`, version: '3.0.0', status: 'published', name: 'banana', description: '', authored_by: null, manifest: '{}', installed_at: null, installed_by: null },
    ];
    for (const p of packs) { await sq.createCapabilityPack(p); await pg.createCapabilityPack!(p); }

    const onlyRun = (rows: CapabilityPackRow[]) => rows.filter((r) => r.id.startsWith(run));
    const sList = onlyRun(await sq.listCapabilityPacks()).map((r) => stripTimestamps(r as never));
    const pList = onlyRun(await pg.listCapabilityPacks!()).map((r) => stripTimestamps(r as never));
    expect(pList).toEqual(sList);
    // Byte-order sort: `-Apple` < `-Zebra` < `-banana` (uppercase before lowercase).
    expect(pList.map((r) => (r as unknown as CapabilityPackRow).name)).toEqual(['Apple', 'zebra', 'banana']);

    // Status filter parity.
    const sPub = onlyRun(await sq.listCapabilityPacks({ status: 'published' })).map((r) => r.id);
    const pPub = onlyRun(await pg.listCapabilityPacks!({ status: 'published' })).map((r) => r.id);
    expect(pPub).toEqual(sPub);
  });

  // ── update parity ─────────────────────────────────────────────────────────
  it('updateCapabilityPack: partial update lands identically', async () => {
    const id = randomUUID();
    const pack: Omit<CapabilityPackRow, 'created_at' | 'updated_at'> = {
      id, pack_key: 'upd', version: '1.0.0', status: 'draft', name: 'Before',
      description: '', authored_by: null, manifest: '{}', installed_at: null, installed_by: null,
    };
    await sq.createCapabilityPack(pack); await pg.createCapabilityPack!(pack);
    await sq.updateCapabilityPack(id, { status: 'retired', name: 'After' });
    await pg.updateCapabilityPack!(id, { status: 'retired', name: 'After' });

    const p = await pg.getCapabilityPack!(id);
    const s = await sq.getCapabilityPack(id);
    expect(p!.updated_at).toMatch(TS_RE);
    expect(stripTimestamps(p as never)).toEqual(stripTimestamps(s as never));
    expect(p!.status).toBe('retired');
    expect(p!.name).toBe('After');
  });

  // ── installation create + list (activeOnly) parity ────────────────────────
  it('createCapabilityPackInstallation + list(activeOnly): identical rows', async () => {
    const packId = randomUUID();
    await sq.createCapabilityPack({ id: packId, pack_key: 'inst', version: '1.0.0', status: 'published', name: 'Inst', description: '', authored_by: null, manifest: '{}', installed_at: null, installed_by: null });
    await pg.createCapabilityPack!({ id: packId, pack_key: 'inst', version: '1.0.0', status: 'published', name: 'Inst', description: '', authored_by: null, manifest: '{}', installed_at: null, installed_by: null });

    const inst: Omit<CapabilityPackInstallationRow, 'installed_at' | 'uninstalled_at'> & { installed_at?: string } = {
      id: randomUUID(), pack_id: packId, pack_key: 'inst', pack_version: '1.0.0',
      ledger: JSON.stringify({ steps: [] }), installed_by: 'ada',
    };
    await sq.createCapabilityPackInstallation(inst); await pg.createCapabilityPackInstallation!(inst);

    const s = (await sq.listCapabilityPackInstallations({ packId, activeOnly: true })).map((r) => stripTimestamps(r as never));
    const p = (await pg.listCapabilityPackInstallations!({ packId, activeOnly: true })).map((r) => stripTimestamps(r as never));
    expect(p).toEqual(s);
    expect(p).toHaveLength(1);
  });

  // ── experiment create + delete parity ─────────────────────────────────────
  it('createCapabilityPackExperiment + delete: create matches, delete removes on both', async () => {
    const id = randomUUID();
    const exp: Omit<CapabilityPackExperimentRow, 'created_at' | 'updated_at'> = {
      id, pack_key: 'exp', name: 'A/B', variants: JSON.stringify([{ version: '1.0.0', weight: 1 }]), enabled: 1,
    };
    await sq.createCapabilityPackExperiment(exp); await pg.createCapabilityPackExperiment!(exp);
    const p = await pg.getCapabilityPackExperiment!(id);
    const s = await sq.getCapabilityPackExperiment(id);
    expect(stripTimestamps(p as never)).toEqual(stripTimestamps(s as never));

    await sq.deleteCapabilityPackExperiment(id); await pg.deleteCapabilityPackExperiment!(id);
    expect(await pg.getCapabilityPackExperiment!(id)).toBeNull();
    expect(await sq.getCapabilityPackExperiment(id)).toBeNull();
  });
});
