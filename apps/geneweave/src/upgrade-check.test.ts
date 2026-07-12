// SPDX-License-Identifier: MIT
/**
 * The app-side `check` command: discover → verify → persist, and the anti-rollback FLOOR built from the
 * persisted history. Real booted SQLite (m169 creates upgrade_releases), a mock release source + a real
 * Ed25519 keypair, so the whole path is exercised without touching GitHub.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import { buildManifest, createEd25519Verifier, type ReleaseSource, type ManifestBody } from '@weaveintel/upgrade';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { checkForUpdate, parseTrustedKeys } from './upgrade-check.js';
import { latestReleaseCheck } from './upgrade-release-store.js';

const key = generateAttestationSigningKey();
const otherKey = generateAttestationSigningKey();
const verifier = createEd25519Verifier([key.publicKey]);

const body = (version: string, edition = 'community'): ManifestBody => ({
  manifestVersion: 1, name: '@geneweave/app', version, channel: 'stable', edition,
  publishedAt: '2026-01-01T00:00:00.000Z', requires: {},
  layers: { packages: [], schema: [], content: [] }, artifacts: [],
});
/** A mock release source that serves a manifest signed by `signWith`. */
const source = (version: string, signWith = key.privateKey, edition = 'community'): ReleaseSource =>
  ({ latest: async () => buildManifest(body(version, edition), signWith) });
const emptySource: ReleaseSource = { latest: async () => null };

describe('Upgrade Engine — the check command (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const cfg = (source: ReleaseSource, extra = {}) => ({ source, verifier, edition: 'community', installedVersion: '1.0.0', ...extra });

  beforeAll(async () => {
    dbPath = join(tmpdir(), `check-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('SETUP: m169 created upgrade_releases', () => {
    expect(() => raw().prepare('SELECT count(*) FROM upgrade_releases').get()).not.toThrow();
  });

  it('POSITIVE: a newer, valid, same-edition release → update_available, persisted + accepted', async () => {
    const r = await checkForUpdate(client(), 'sqlite', cfg(source('2.0.0')));
    expect(r.status).toBe('update_available');
    const row = await latestReleaseCheck(client(), 'sqlite');
    expect(row?.version).toBe('2.0.0');
    expect(row?.accepted).toBe(1);
    expect(row?.manifest_json).toBeTruthy(); // manifest kept for an accepted release
  });

  it('ANTI-ROLLBACK FLOOR: after accepting 2.0.0, a replayed 1.5.0 is a downgrade (floor from history)', async () => {
    // installedVersion is 1.0.0, but 2.0.0 was accepted above → floor is 2.0.0.
    const r = await checkForUpdate(client(), 'sqlite', cfg(source('1.5.0')));
    expect(r.floor).toBe('2.0.0');
    expect(r).toMatchObject({ status: 'rejected', reason: 'downgrade' });
    const row = await latestReleaseCheck(client(), 'sqlite');
    expect(row?.outcome).toBe('rejected');
    expect(row?.accepted).toBe(0); // a rejected release does NOT raise the floor
  });

  it('a rejected (untrusted-key) release is recorded but never raises the floor', async () => {
    await checkForUpdate(client(), 'sqlite', cfg(source('9.9.9', otherKey.privateKey))); // signed by untrusted key
    // Query the specific row (checked_at is 1s-resolution, so latestReleaseCheck can't disambiguate here).
    const row = raw().prepare(`SELECT * FROM upgrade_releases WHERE version = '9.9.9'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ version: '9.9.9', outcome: 'rejected', reject_reason: 'untrusted_key', accepted: 0 });
    // floor is still 2.0.0 — the untrusted 9.9.9 didn't count
    const next = await checkForUpdate(client(), 'sqlite', cfg(source('2.0.0')));
    expect(next.floor).toBe('2.0.0');
  });

  it('EDITION MISMATCH: a release for another edition → rejected edition_mismatch (recorded)', async () => {
    const r = await checkForUpdate(client(), 'sqlite', cfg(source('3.0.0', key.privateKey, 'enterprise')));
    expect(r).toMatchObject({ status: 'rejected', reason: 'edition_mismatch' });
  });

  it('none: an empty source records nothing', async () => {
    const before = (raw().prepare('SELECT count(*) c FROM upgrade_releases').get() as { c: number }).c;
    const r = await checkForUpdate(client(), 'sqlite', cfg(emptySource));
    expect(r.status).toBe('none');
    const after = (raw().prepare('SELECT count(*) c FROM upgrade_releases').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('parseTrustedKeys extracts PEM public-key blocks (config parsing)', () => {
    const pem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(parseTrustedKeys(pem).length).toBe(1);
    expect(parseTrustedKeys('no keys here')).toEqual([]);
  });
});
