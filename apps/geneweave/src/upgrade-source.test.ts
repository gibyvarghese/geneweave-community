// SPDX-License-Identifier: MIT
/**
 * Tests for the Upgrade Engine release-SOURCE configuration store (upgrade-source.ts + m177).
 *
 * Covers: validation (positive + every negative branch), load/save round-trip, singleton upsert semantics,
 * buildCheckConfigFromSource wiring + its disabled/unusable null paths, concurrency (many parallel saves
 * converge to one row with no corruption), and security (a hostile repo string can't smuggle a URL/path;
 * no secret token is ever persisted).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import {
  validateSourceConfig, loadSourceConfig, saveSourceConfig, buildCheckConfigFromSource,
  type UpgradeSourceConfig,
} from './upgrade-source.js';

// A syntactically valid Ed25519 PUBLIC KEY PEM block (content need not verify — parseTrustedKeys only greps blocks).
const PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=
-----END PUBLIC KEY-----`;

const VALID: UpgradeSourceConfig = {
  repo: 'gibyvarghese/geneweave-community', edition: 'community',
  assetName: 'manifest.json', trustedKeysPem: PEM, apiBase: null, tokenCredentialId: null,
};

describe('upgrade-source: validation', () => {
  it('accepts a well-formed config', () => {
    expect(validateSourceConfig(VALID)).toEqual([]);
  });
  it('rejects a repo that is not owner/repo (URL, spaces, extra path segments)', () => {
    for (const repo of ['https://github.com/o/r', 'owner', 'a/b/c', 'own er/repo', '', '/repo', 'owner/']) {
      const errs = validateSourceConfig({ ...VALID, repo });
      expect(errs.some((e) => e.field === 'repo'), `repo="${repo}"`).toBe(true);
    }
  });
  it('requires at least one PEM public-key block', () => {
    expect(validateSourceConfig({ ...VALID, trustedKeysPem: '' }).some((e) => e.field === 'trustedKeysPem')).toBe(true);
    expect(validateSourceConfig({ ...VALID, trustedKeysPem: 'not a key' }).some((e) => e.field === 'trustedKeysPem')).toBe(true);
  });
  it('requires a non-empty edition', () => {
    expect(validateSourceConfig({ ...VALID, edition: '  ' }).some((e) => e.field === 'edition')).toBe(true);
  });
  it('rejects an assetName with a path separator and a non-https apiBase', () => {
    expect(validateSourceConfig({ ...VALID, assetName: 'dir/manifest.json' }).some((e) => e.field === 'assetName')).toBe(true);
    expect(validateSourceConfig({ ...VALID, apiBase: 'http://ghe.local/api' }).some((e) => e.field === 'apiBase')).toBe(true);
    expect(validateSourceConfig({ ...VALID, apiBase: 'https://ghe.local/api/v3' })).toEqual([]);
  });
});

describe('upgrade-source: store round-trip + singleton', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  const client = () => sqliteSqlClient((db as unknown as { d: Database.Database }).d);

  beforeEach(async () => {
    dbPath = join(tmpdir(), `uc-source-${process.pid}-${Math.floor(performance.now() * 1000)}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(() => { try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('returns null before anything is configured', async () => {
    expect(await loadSourceConfig(client(), 'sqlite')).toBeNull();
  });

  it('saves then loads the same config, stamping audit fields', async () => {
    const saved = await saveSourceConfig(client(), 'sqlite', VALID, { updatedBy: 'admin-1' });
    expect(saved.repo).toBe(VALID.repo);
    expect(saved.edition).toBe('community');
    expect(saved.updatedBy).toBe('admin-1');
    const loaded = await loadSourceConfig(client(), 'sqlite');
    expect(loaded?.repo).toBe(VALID.repo);
    expect(loaded?.trustedKeysPem).toContain('BEGIN PUBLIC KEY');
    expect(loaded?.enabled).toBe(true);
  });

  it('is a singleton: a second save UPDATES the one row, not a new row', async () => {
    await saveSourceConfig(client(), 'sqlite', VALID, { updatedBy: 'a' });
    await saveSourceConfig(client(), 'sqlite', { ...VALID, repo: 'acme/private', edition: 'enterprise' }, { updatedBy: 'b' });
    const { rows } = await client().query('SELECT COUNT(*) AS n FROM upgrade_source_config', []);
    expect(Number((rows[0] as { n: number }).n)).toBe(1);
    const loaded = await loadSourceConfig(client(), 'sqlite');
    expect(loaded?.repo).toBe('acme/private');
    expect(loaded?.edition).toBe('enterprise');
    expect(loaded?.updatedBy).toBe('b');
  });

  it('never persists a secret token — only a credential-id reference', async () => {
    await saveSourceConfig(client(), 'sqlite', { ...VALID, tokenCredentialId: 'cred-123' }, {});
    const { rows } = await client().query('SELECT * FROM upgrade_source_config', []);
    const row = rows[0] as Record<string, unknown>;
    // The stored columns hold the reference, and there is no column that could hold a plaintext token.
    expect(row['token_credential_id']).toBe('cred-123');
    expect(Object.keys(row)).not.toContain('token');
    expect(JSON.stringify(row)).not.toMatch(/ghp_|github_pat_/); // no leaked token material
  });

  it('honors enabled=false as paused', async () => {
    const saved = await saveSourceConfig(client(), 'sqlite', { ...VALID, enabled: false }, {});
    expect(saved.enabled).toBe(false);
  });
});

describe('upgrade-source: buildCheckConfigFromSource', () => {
  it('builds a usable CheckConfig from a valid public-repo source', () => {
    const cfg = buildCheckConfigFromSource({ ...VALID, updatedAt: null, updatedBy: null }, '1.2.3');
    expect(cfg).not.toBeNull();
    expect(cfg?.edition).toBe('community');
    expect(cfg?.installedVersion).toBe('1.2.3');
    expect(cfg?.source).toBeDefined();
    expect(cfg?.verifier).toBeDefined();
  });
  it('returns null when disabled or when keys are unusable (→ caller reports not_configured)', () => {
    expect(buildCheckConfigFromSource({ ...VALID, enabled: false, updatedAt: null, updatedBy: null }, '1.0.0')).toBeNull();
    expect(buildCheckConfigFromSource({ ...VALID, trustedKeysPem: 'nope', updatedAt: null, updatedBy: null }, '1.0.0')).toBeNull();
  });
});

describe('upgrade-source: concurrency', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  const client = () => sqliteSqlClient((db as unknown as { d: Database.Database }).d);
  beforeEach(async () => {
    dbPath = join(tmpdir(), `uc-source-conc-${process.pid}-${Math.floor(performance.now() * 1000)}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(() => { try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('200 concurrent saves converge to exactly one row with a valid final value', async () => {
    const saves = Array.from({ length: 200 }, (_, i) =>
      saveSourceConfig(client(), 'sqlite', { ...VALID, repo: `owner/repo-${i}` }, { updatedBy: `u${i}` }));
    const settled = await Promise.allSettled(saves);
    // No save may corrupt the table; at least one must succeed.
    expect(settled.some((s) => s.status === 'fulfilled')).toBe(true);
    const { rows } = await client().query('SELECT COUNT(*) AS n FROM upgrade_source_config', []);
    expect(Number((rows[0] as { n: number }).n)).toBe(1);
    const loaded = await loadSourceConfig(client(), 'sqlite');
    expect(loaded?.repo).toMatch(/^owner\/repo-\d+$/); // a coherent value from some writer, not a torn mix
  });
});
