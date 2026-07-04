import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeCapabilities } from '@weaveintel/core';
import { createGeneWeave, type GeneWeaveApp } from './index.js';
import type { TenantKeyManager } from '@weaveintel/encryption';
import { geneweaveEncryptionSlot } from './encryption-slot.js';

const PHASE_F_KEY = 'a'.repeat(64); // 32 bytes hex

async function bootApp(dbPath: string): Promise<GeneWeaveApp> {
  return createGeneWeave({
    port: 0,
    jwtSecret: 'phaseF-test-secret-not-for-prod-use-only-min-32',
    database: { type: 'sqlite', path: dbPath },
    providers: { anthropic: { apiKey: 'sk-test-not-real' } },
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
  });
}

describe('Phase F — encryption runtime slot', () => {
  let app: GeneWeaveApp | undefined;
  let dir: string | undefined;
  const prevKey = process.env['WEAVE_ENCRYPTION_MASTER_KEY'];

  afterEach(async () => {
    if (app) { await app.stop(); app = undefined; }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
    if (prevKey === undefined) delete process.env['WEAVE_ENCRYPTION_MASTER_KEY'];
    else process.env['WEAVE_ENCRYPTION_MASTER_KEY'] = prevKey;
  });

  it('advertises the encryption capability and exposes the slot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phaseF-cap-'));
    delete process.env['WEAVE_ENCRYPTION_MASTER_KEY'];
    app = await bootApp(join(dir, 'gw.db'));

    // Slot is wired at runtime construction time regardless of bootstrap state.
    expect(app.runtime.has(RuntimeCapabilities.Encryption)).toBe(true);
    expect(app.runtime.encryption?.kind).toBe('tenant-key-manager');
    // Without a master key, manager is null (graceful — encryption disabled).
    expect(app.runtime.encryption?.getManager()).toBeNull();
  });

  it('exposes the live TenantKeyManager when master key is configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phaseF-mgr-'));
    process.env['WEAVE_ENCRYPTION_MASTER_KEY'] = PHASE_F_KEY;
    app = await bootApp(join(dir, 'gw.db'));

    expect(app.runtime.has(RuntimeCapabilities.Encryption)).toBe(true);
    const manager = app.runtime.encryption?.getManager() as TenantKeyManager | null;
    expect(manager).not.toBeNull();
    expect(typeof manager?.encrypt).toBe('function');
    expect(typeof manager?.decrypt).toBe('function');
  });
});

// ── Phase 0 — isActive() unit tests (no DB needed) ──────────────────────────

describe('Phase 0 — geneweaveEncryptionSlot.isActive()', () => {
  const prevKey = process.env['VAULT_KEY'];

  afterEach(() => {
    if (prevKey === undefined) delete process.env['VAULT_KEY'];
    else process.env['VAULT_KEY'] = prevKey;
  });

  it('returns false when no manager is set', () => {
    delete process.env['VAULT_KEY'];
    const slot = geneweaveEncryptionSlot(null);
    expect(slot.isActive()).toBe(false);
  });

  it('returns false when manager is set but VAULT_KEY env is absent', () => {
    delete process.env['VAULT_KEY'];
    // Create a minimal stub that satisfies TenantKeyManager structurally
    const fakeManager = { encrypt: async () => '', decrypt: async () => '' } as unknown as TenantKeyManager;
    const slot = geneweaveEncryptionSlot(fakeManager);
    expect(slot.isActive()).toBe(false);
  });

  it('returns true when manager is set and VAULT_KEY is present', () => {
    process.env['VAULT_KEY'] = 'test-vault-key';
    const fakeManager = { encrypt: async () => '', decrypt: async () => '' } as unknown as TenantKeyManager;
    const slot = geneweaveEncryptionSlot(fakeManager);
    expect(slot.isActive()).toBe(true);
  });

  it('returns false after setManager(null) even when VAULT_KEY is present', () => {
    process.env['VAULT_KEY'] = 'test-vault-key';
    const fakeManager = { encrypt: async () => '', decrypt: async () => '' } as unknown as TenantKeyManager;
    const slot = geneweaveEncryptionSlot(fakeManager);
    expect(slot.isActive()).toBe(true);
    slot.setManager(null);
    expect(slot.isActive()).toBe(false);
  });
});
