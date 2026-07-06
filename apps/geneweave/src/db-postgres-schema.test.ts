// SPDX-License-Identifier: MIT
/**
 * Validates the generated Postgres schema (the full geneWeave app schema, all tables) — that it
 * applies cleanly to a real Postgres and mirrors SQLite's type/row decisions. The Docker-gated test
 * spins up a throwaway Postgres and applies the whole schema in one shot; the hermetic tests check
 * the parity-critical shape without needing a database.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from './db-postgres-schema.js';

const home = process.env['HOME'] ?? '';
const HAS_DOCKER = !!process.env['DOCKER_HOST'] || ['/var/run/docker.sock', join(home, '.docker/run/docker.sock')].some(existsSync);

const TABLE_COUNT = (POSTGRES_FULL_SCHEMA.match(/CREATE TABLE/g) ?? []).length;

describe('Postgres full schema (generated)', () => {
  it('hermetic: covers the whole app and keeps SQLite-parity column types', () => {
    expect(TABLE_COUNT).toBeGreaterThan(200);
    // On/off flags are INTEGER (0/1), never BOOLEAN, so rows read back identically to SQLite.
    expect(POSTGRES_FULL_SCHEMA).toMatch(/"email_verified" INTEGER NOT NULL DEFAULT 0/);
    expect(POSTGRES_FULL_SCHEMA).not.toMatch(/\bBOOLEAN\b/);
    // Timestamps stay TEXT in SQLite's datetime('now') format.
    expect(POSTGRES_FULL_SCHEMA).toMatch(/"created_at" TEXT NOT NULL DEFAULT to_char\(\(now\(\) at time zone 'utc'\), 'YYYY-MM-DD HH24:MI:SS'\)/);
    // Money stays double precision (JS number), counts stay integer.
    expect(POSTGRES_FULL_SCHEMA).toMatch(/"cost" DOUBLE PRECISION/);
    // No untranslated SQLite date functions leaked into the DDL.
    expect(POSTGRES_FULL_SCHEMA).not.toMatch(/datetime\('now'\)|strftime\(|unixepoch\(|randomblob/);
  });

  it.skipIf(!HAS_DOCKER)('applies cleanly to a real Postgres — every table creates and is selectable', async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pg = (await import('pg')).default;
    const container = await new PostgreSqlContainer('postgres:16').start();
    const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    try {
      await pool.query(POSTGRES_FULL_SCHEMA); // the entire schema, one shot — FK order must be right
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
      expect(rows[0]!['n']).toBe(TABLE_COUNT);
      // Spot-check that a representative FK-linked table exists and is empty/usable.
      for (const t of ['users', 'chats', 'messages', 'skills', 'prompts', 'tool_catalog', 'worker_agents']) {
        const r = await pool.query(`SELECT count(*)::int AS n FROM "${t}"`);
        expect(r.rows[0]!['n']).toBe(0);
      }
    } finally {
      await pool.end();
      await container.stop();
    }
  }, 180_000);
});
