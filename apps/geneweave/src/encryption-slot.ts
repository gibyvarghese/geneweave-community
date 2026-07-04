/**
 * Phase F — Encryption slot factory for `weaveRuntime`.
 *
 * Bridges the geneweave per-tenant `TenantKeyManager` (constructed late
 * in boot, after the DB schema is up and the master key is loaded) onto
 * the framework-level `RuntimeEncryptionSlot` capability.
 *
 * The slot is constructed BEFORE bootstrap (so `runtime.has(...)` can
 * advertise the capability at boot) and exposes a mutable internal ref
 * that is set once bootstrap succeeds. Consumers retrieve the live
 * manager via `ctx.runtime?.encryption?.getManager()` and cast to the
 * concrete `TenantKeyManager`. `null` is returned while encryption is
 * disabled (no master key) or before bootstrap completes — matches the
 * existing live-binding closure semantics.
 */
import type { RuntimeEncryptionSlot } from '@weaveintel/core';
import type { TenantKeyManager } from '@weaveintel/encryption';

export interface GeneweaveEncryptionSlot extends RuntimeEncryptionSlot {
  /** Set the live manager once bootstrap has succeeded. Pass `null` to clear. */
  setManager(manager: TenantKeyManager | null): void;
  /** Typed accessor for the underlying manager; thin wrapper over `getManager()`. */
  getTenantKeyManager(): TenantKeyManager | null;
}

export function geneweaveEncryptionSlot(
  initial: TenantKeyManager | null = null,
): GeneweaveEncryptionSlot {
  let manager: TenantKeyManager | null = initial;
  return {
    kind: 'tenant-key-manager',
    getManager(): unknown {
      return manager;
    },
    isActive(): boolean {
      return manager !== null && !!process.env['VAULT_KEY'];
    },
    getTenantKeyManager(): TenantKeyManager | null {
      return manager;
    },
    setManager(next: TenantKeyManager | null): void {
      manager = next;
    },
  };
}
