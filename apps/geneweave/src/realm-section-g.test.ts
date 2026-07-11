// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — Section G (Phase 0 completion): the `users.tenant_id` → `tenants(id)` foreign key,
 * end to end on a real booted SQLite adapter.
 *
 * The column existed since m01-m10 with no referential integrity. m162 rebuilds `users` to add the FK
 * (SQLite can't ALTER ADD CONSTRAINT), de-orphaning any stray tenant_id first and re-linking the many
 * inbound FKs (sessions, user_preferences, …) through the rebuild. This proves: the FK exists and is
 * enforced, every column + inbound reference survives, blank/unknown tenants are handled, ON DELETE
 * SET NULL orphans users to global rather than deleting them, and the whole thing is idempotent under
 * stress. Positive / negative / security / stress.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import { newUUIDv7 } from './lib/uuid.js';
import { isTenantFkViolation } from './admin/routes/users.js';

interface FkRow { table: string; from: string; to: string; on_delete: string }
interface ColRow { name: string }

const HOSTILE = "'; DROP TABLE tenants; --";

describe('Tenancy Realm — Section G (users.tenant_id FK)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d;
  const mkTenant = (id: string) => raw().prepare(`INSERT OR IGNORE INTO tenants (id,name,path,depth,status) VALUES (?,?,?,0,'active')`).run(id, id, `/${id}/`);
  const insUser = (id: string, tenantId: string | null) =>
    raw().prepare(`INSERT INTO users (id,email,name,persona,tenant_id,password_hash) VALUES (?,?,?,'tenant_user',?,'h')`).run(id, `${id}@x.dev`, id, tenantId);

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-section-g-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  describe('the constraint', () => {
    it('POSITIVE: users.tenant_id has a FK to tenants(id) ON DELETE SET NULL', () => {
      const fk = (raw().pragma('foreign_key_list(users)') as FkRow[]).find((f) => f.table === 'tenants' && f.from === 'tenant_id');
      expect(fk, 'the tenant FK exists').toBeTruthy();
      expect(fk!.to).toBe('id');
      expect(fk!.on_delete).toBe('SET NULL');
    });

    it('POSITIVE: the rebuild preserved all 12 columns and the UNIQUE(email) constraint', () => {
      const cols = (raw().pragma('table_info(users)') as ColRow[]).map((c) => c.name).sort();
      expect(cols).toEqual([
        'created_at', 'email', 'email_bidx', 'email_verified', 'email_verified_at',
        'id', 'mfa_enabled', 'mfa_totp_secret', 'name', 'password_hash', 'persona', 'tenant_id',
      ]);
      // UNIQUE(email) still enforced
      const id = newUUIDv7();
      raw().prepare(`INSERT INTO users (id,email,name,persona,password_hash) VALUES (?,?,?,'tenant_user','h')`).run(id, 'uniq@x.dev', 'u');
      expect(() => raw().prepare(`INSERT INTO users (id,email,name,persona,password_hash) VALUES (?,?,?,'tenant_user','h')`).run(newUUIDv7(), 'uniq@x.dev', 'u2')).toThrow(/UNIQUE/i);
    });

    it('POSITIVE: FK enforcement is ON for the connection', () => {
      expect((raw().pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0]!.foreign_keys).toBe(1);
    });

    it('INBOUND: sessions and user_preferences still reference users(id) after the rebuild', () => {
      expect((raw().pragma('foreign_key_list(sessions)') as FkRow[]).some((f) => f.table === 'users')).toBe(true);
      expect((raw().pragma('foreign_key_list(user_preferences)') as FkRow[]).some((f) => f.table === 'users')).toBe(true);
    });
  });

  describe('enforcement', () => {
    it('POSITIVE: a NULL tenant (global user) and a real-tenant user both insert fine', async () => {
      await db.createUser!({ id: newUUIDv7(), email: 'g1@x.dev', name: 'g1', passwordHash: 'h' });
      mkTenant('acme-g');
      await db.createUser!({ id: newUUIDv7(), email: 'a1@x.dev', name: 'a1', passwordHash: 'h', tenantId: 'acme-g' });
      expect((await db.getUserByEmail!('a1@x.dev'))?.tenant_id).toBe('acme-g');
    });

    it('NEGATIVE: assigning a user to a NONEXISTENT tenant is rejected by the FK', () => {
      expect(() => insUser('u-orphan', 'ghost-tenant')).toThrow(/FOREIGN KEY/i);
      expect(raw().prepare(`SELECT count(*) c FROM users WHERE id='u-orphan'`).get().c).toBe(0);
    });

    it('NEGATIVE: updating an existing user to a bogus tenant is rejected', async () => {
      const id = newUUIDv7();
      await db.createUser!({ id, email: 'upd@x.dev', name: 'upd', passwordHash: 'h' });
      expect(() => raw().prepare(`UPDATE users SET tenant_id='no-such' WHERE id=?`).run(id)).toThrow(/FOREIGN KEY/i);
      expect((await db.getUserById!(id))?.tenant_id ?? null).toBeNull();
    });

    it('SET NULL: deleting a tenant orphans its users to global (never deletes the user)', async () => {
      mkTenant('doomed-g');
      const id = newUUIDv7();
      await db.createUser!({ id, email: 'doomed@x.dev', name: 'd', passwordHash: 'h', tenantId: 'doomed-g' });
      raw().prepare(`DELETE FROM tenants WHERE id='doomed-g'`).run();
      const u = await db.getUserById!(id);
      expect(u, 'user survives the tenant delete').toBeTruthy();
      expect(u?.tenant_id ?? null).toBeNull();
    });

    it('NULL is always allowed (the FK only constrains non-null values)', async () => {
      const id = newUUIDv7();
      await db.createUser!({ id, email: 'nullt@x.dev', name: 'n', passwordHash: 'h', tenantId: null });
      expect((await db.getUserById!(id))?.tenant_id ?? null).toBeNull();
    });
  });

  describe('admin route — graceful 400 instead of a raw FK 500', () => {
    it('isTenantFkViolation recognises both the SQLite and Postgres FK error shapes, and only those', () => {
      // SQLite shape
      expect(isTenantFkViolation(new Error('FOREIGN KEY constraint failed'))).toBe(true);
      // Postgres shape
      expect(isTenantFkViolation(new Error('insert or update on table "users" violates foreign key constraint "users_tenant_id_fkey"'))).toBe(true);
      // Not a FK error → not swallowed as a 400
      expect(isTenantFkViolation(new Error('UNIQUE constraint failed: users.email'))).toBe(false);
      expect(isTenantFkViolation(new Error('some unrelated failure'))).toBe(false);
      expect(isTenantFkViolation('a string, not an Error')).toBe(false);
    });

    it('the real DB error IS a foreign-key violation the helper would map to 400', () => {
      let caught: unknown;
      try { insUser('u-fk', 'still-ghost'); } catch (e) { caught = e; }
      expect(caught).toBeTruthy();
      expect(isTenantFkViolation(caught)).toBe(true);
    });
  });

  describe('idempotency + integrity', () => {
    it('IDEMPOTENT: re-running seedDefaultData (migrations) leaves exactly one tenant FK and does not rebuild', async () => {
      const before = raw().prepare(`SELECT count(*) c FROM users`).get().c as number;
      await db.seedDefaultData?.();
      await db.seedDefaultData?.();
      const fks = (raw().pragma('foreign_key_list(users)') as FkRow[]).filter((f) => f.table === 'tenants' && f.from === 'tenant_id');
      expect(fks.length).toBe(1);
      expect(raw().prepare(`SELECT count(*) c FROM users`).get().c).toBe(before); // no rows lost/duplicated
    });

    it('SECURITY: a hostile tenant id is bound, not interpolated; the tenants table survives', () => {
      // Inserting a user with a SQLi-shaped (nonexistent) tenant id is just an FK failure, not injection.
      expect(() => insUser('u-hostile', HOSTILE)).toThrow(/FOREIGN KEY/i);
      expect(raw().prepare(`SELECT count(*) c FROM tenants`).get().c).toBeGreaterThan(0); // not dropped
    });

    it('STRESS: 500 users across 50 tenants insert under the FK; each references a real tenant', async () => {
      for (let t = 0; t < 50; t++) mkTenant(`st-${t}`);
      for (let i = 0; i < 500; i++) {
        await db.createUser!({ id: newUUIDv7(), email: `st${i}@x.dev`, name: `st${i}`, passwordHash: 'h', tenantId: `st-${i % 50}` });
      }
      // Every user's tenant_id is either null or a real tenant — the FK guarantees it.
      const orphans = raw().prepare(`
        SELECT count(*) c FROM users
        WHERE tenant_id IS NOT NULL AND tenant_id NOT IN (SELECT id FROM tenants)
      `).get().c as number;
      expect(orphans).toBe(0);
      // foreign_key_check(users) is clean across the whole table.
      expect((raw().pragma('foreign_key_check(users)') as unknown[]).length).toBe(0);
    }, 60_000);
  });
});
