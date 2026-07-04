/**
 * Example 15 — Tenant Encryption Phase 3.
 *
 * Demonstrates the reusable adapter-helpers from `@weaveintel/encryption`
 * AND the geneweave Proxy wrapper (`withTenantEncryptedMessages`) wiring
 * the package into a database adapter — without geneweave's full DB.
 *
 * Two scopes are demonstrated:
 *   A. Pure package layer — `maybeEncryptField` / `maybeDecryptField` against
 *      an in-memory state. Confirms the no-op rules (null, sentinel, disabled,
 *      not-in-policy) and the lazy-upgrade decrypt path.
 *   B. App layer — drive `withTenantEncryptedMessages` against a tiny
 *      in-memory `DatabaseAdapter` stub with two tenants:
 *        - tenant A has policy enabled=1 → addMessage stores ciphertext,
 *          getMessages returns plaintext.
 *        - tenant B has policy enabled=0 → addMessage stores plaintext.
 *        - Direct plaintext insert + getMessages on tenant A → still readable
 *          (lazy upgrade window).
 *
 * No DB, no LLM, no external services.
 *
 * Run: npx tsx examples/15-encryption-phase3.ts
 */

import {
  isEncrypted,
  LocalKmsProvider,
  loadMasterKeyFromEnv,
  maybeDecryptField,
  maybeEncryptField,
  mergeFieldPolicy,
  noopAuditEmitter,
  weaveTenantKeyManager,
  type BikRecord,
  type DekRecord,
  type EncryptionStore,
  type FieldPolicy,
  type KekRecord,
  type TenantEncryptionState,
  type TenantPolicyRecord,
} from '@weaveintel/encryption';

import { withTenantEncryptedMessages } from '../apps/geneweave/src/encryption/db-encrypted-adapter.js';
import type { DatabaseAdapter } from '../apps/geneweave/src/db-types.js';

// --- in-memory EncryptionStore ----------------------------------------------

function createInMemoryStore(): EncryptionStore {
  const policies = new Map<string, TenantPolicyRecord>();
  const keks: KekRecord[] = [];
  const deks: DekRecord[] = [];
  const biks: BikRecord[] = [];
  return {
    async getPolicy(tenantId) {
      return policies.get(tenantId) ?? null;
    },
    async upsertPolicy(p) {
      policies.set(p.tenantId, p);
    },
    async listKeks(tenantId) {
      return keks.filter((k) => k.tenantId === tenantId);
    },
    async insertKek(k) {
      keks.push(k);
    },
    async getKekById(tenantId, kekId) {
      return keks.find((k) => k.tenantId === tenantId && k.id === kekId) ?? null;
    },
    async updateKekStatus(id, status, at) {
      const r = keks.find((k) => k.id === id);
      if (!r) return;
      Object.assign(r, {
        status,
        ...(status === 'previous' ? { rotatedAt: at } : status === 'revoked' ? { revokedAt: at } : {}),
      });
    },
    async listDeks(tenantId) {
      return deks.filter((d) => d.tenantId === tenantId);
    },
    async insertDek(d) {
      deks.push(d);
    },
    async getDekById(tenantId, dekId) {
      return deks.find((d) => d.tenantId === tenantId && d.id === dekId) ?? null;
    },
    async getMaxDekEpoch(tenantId) {
      const epochs = deks.filter((d) => d.tenantId === tenantId).map((d) => d.epoch);
      return epochs.length ? Math.max(...epochs) : null;
    },
    async updateDekStatus(id, status, at) {
      const r = deks.find((d) => d.id === id);
      if (!r) return;
      Object.assign(r, {
        status,
        ...(status === 'previous' ? { rotatedAt: at } : status === 'revoked' ? { revokedAt: at } : {}),
      });
    },
    async listBiks(tenantId) {
      return biks.filter((b) => b.tenantId === tenantId);
    },
    async insertBik(b) {
      biks.push(b);
    },
    async updateBikStatus(id, status, at) {
      const r = biks.find((b) => b.id === id);
      if (!r) return;
      Object.assign(r, { status, revokedAt: at });
    },
    async deletePolicy(tenantId) {
      policies.delete(tenantId);
    },
    async deleteAllWrappedMaterial(tenantId) {
      const count = (arr: { tenantId: string }[]) => {
        const before = arr.length;
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i]!.tenantId === tenantId) arr.splice(i, 1);
        }
        return before - arr.length;
      };
      return { keks: count(keks), deks: count(deks), biks: count(biks) };
    },
  };
}

// --- in-memory DatabaseAdapter stub (just enough for the wrapper) -----------

interface MiniRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  metadata: string | null;
  tokens_used: number;
  cost: number;
  latency_ms: number;
  created_at: string;
}

function createMiniDb(opts: {
  chats: ReadonlyArray<{ id: string; user_id: string }>;
  users: ReadonlyArray<{ id: string; tenant_id: string | null }>;
  policies: ReadonlyArray<{ tenant_id: string; enabled: number; field_policy: string }>;
}): {
  db: DatabaseAdapter;
  rawMessages: () => MiniRow[];
} {
  const messages: MiniRow[] = [];
  // Cast through `unknown` — we only implement the methods the wrapper touches.
  const db = {
    async addMessage(msg: {
      id: string;
      chatId: string;
      role: string;
      content: string;
      metadata?: string;
      tokens_used?: number;
      cost?: number;
      latency_ms?: number;
    }) {
      const row: MiniRow = {
        id: msg.id,
        chat_id: msg.chatId,
        role: msg.role,
        content: msg.content,
        metadata: msg.metadata ?? null,
        tokens_used: msg.tokens_used ?? 0,
        cost: msg.cost ?? 0,
        latency_ms: msg.latency_ms ?? 0,
        created_at: new Date().toISOString(),
      };
      messages.push(row);
    },
    async getMessages(chatId: string) {
      return messages.filter((m) => m.chat_id === chatId).map((m) => ({ ...m }));
    },
    async getChatById(id: string) {
      const c = opts.chats.find((c) => c.id === id);
      return c ? { id: c.id, user_id: c.user_id, title: '', model: '', provider: '', created_at: '', updated_at: '' } : null;
    },
    async getUserById(id: string) {
      const u = opts.users.find((u) => u.id === id);
      return u ? { id: u.id, tenant_id: u.tenant_id, email: '', persona: 'user', created_at: '', updated_at: '' } : null;
    },
    async getTenantEncryptionPolicy(tenantId: string) {
      const p = opts.policies.find((p) => p.tenant_id === tenantId);
      return p ? { ...p } : null;
    },
  } as unknown as DatabaseAdapter;
  return { db, rawMessages: () => messages };
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('--- Tenant Encryption Phase 3 demo ---\n');

  // Bootstrap shared encryption manager.
  const loaded = loadMasterKeyFromEnv({ devGenerateIfMissing: true });
  console.log(`[boot] master key source: ${loaded.source}`);
  const store = createInMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: loaded.key });
  const manager = weaveTenantKeyManager({ store, kms, audit: noopAuditEmitter });
  await manager.bootstrapTenant({ tenantId: 'tenant-A', enable: true, actor: 'demo' });
  await manager.bootstrapTenant({ tenantId: 'tenant-B', enable: true, actor: 'demo' });

  // ---- A. Package layer no-op rules ----------------------------------------

  console.log('\n[A] package adapter-helpers no-op rules:');
  const policy: FieldPolicy = mergeFieldPolicy(null);
  const enabledState: TenantEncryptionState = { manager, tenantId: 'tenant-A', enabled: true, policy };
  const disabledState: TenantEncryptionState = { manager, tenantId: 'tenant-B', enabled: false, policy };

  const ct = await maybeEncryptField(enabledState, { table: 'messages', column: 'content', rowId: 'msg-1' }, 'hello');
  if (!ct || !isEncrypted(ct)) throw new Error('expected sentinel');
  console.log(`    encrypted enabled tenant: sentinel? ${isEncrypted(ct)} (${ct!.slice(0, 24)}…)`);

  const ctIdempotent = await maybeEncryptField(enabledState, { table: 'messages', column: 'content', rowId: 'msg-1' }, ct!);
  if (ctIdempotent !== ct) throw new Error('double-encryption detected');
  console.log(`    re-encrypt idempotent (sentinel passed back unchanged): ✓`);

  const ptThrough = await maybeEncryptField(disabledState, { table: 'messages', column: 'content', rowId: 'msg-2' }, 'hello');
  if (ptThrough !== 'hello') throw new Error('disabled tenant should pass through');
  console.log(`    disabled tenant: pass-through plaintext: ✓`);

  const nullThrough = await maybeEncryptField(enabledState, { table: 'messages', column: 'content', rowId: 'msg-3' }, null);
  if (nullThrough !== null) throw new Error('null pass-through broke');
  console.log(`    null value: pass-through null: ✓`);

  const notInPolicy = await maybeEncryptField(enabledState, { table: 'tool_catalog', column: 'name', rowId: 'tc-1' }, 'web_search');
  if (notInPolicy !== 'web_search') throw new Error('not-in-policy column should not encrypt');
  console.log(`    column outside field policy: pass-through: ✓`);

  const lazyUpgrade = await maybeDecryptField(enabledState, { table: 'messages', column: 'content', rowId: 'msg-99' }, 'plain-row-from-old-data');
  if (lazyUpgrade !== 'plain-row-from-old-data') throw new Error('lazy-upgrade decrypt should pass plaintext through');
  console.log(`    decrypt of plaintext row (lazy-upgrade window): pass-through: ✓`);

  const rt = await maybeDecryptField(enabledState, { table: 'messages', column: 'content', rowId: 'msg-1' }, ct!);
  if (rt !== 'hello') throw new Error('decrypt round-trip failed');
  console.log(`    decrypt round-trip: "${rt}" ✓`);

  // ---- B. App-layer wrapper against a stub DB ------------------------------

  console.log('\n[B] withTenantEncryptedMessages wrapper:');
  const { db, rawMessages } = createMiniDb({
    chats: [
      { id: 'chat-A', user_id: 'user-A' },
      { id: 'chat-B', user_id: 'user-B' },
    ],
    users: [
      { id: 'user-A', tenant_id: 'tenant-A' },
      { id: 'user-B', tenant_id: 'tenant-B' },
    ],
    policies: [
      { tenant_id: 'tenant-A', enabled: 1, field_policy: '{"messages":{"columns":["content","metadata"]}}' },
      { tenant_id: 'tenant-B', enabled: 0, field_policy: '{"messages":{"columns":["content","metadata"]}}' },
    ],
  });
  const wrapped = withTenantEncryptedMessages(db, () => manager);

  // Tenant A (enabled): write+read
  await wrapped.addMessage({
    id: 'm-A1',
    chatId: 'chat-A',
    role: 'user',
    content: 'top secret tenant-A',
    metadata: '{"k":"v"}',
  } as Parameters<DatabaseAdapter['addMessage']>[0]);
  const storedA = rawMessages().find((m) => m.id === 'm-A1');
  if (!storedA || !isEncrypted(storedA.content)) throw new Error('tenant-A content not encrypted at rest');
  if (!storedA.metadata || !isEncrypted(storedA.metadata)) throw new Error('tenant-A metadata not encrypted at rest');
  console.log(`    tenant-A: stored content sentinel? ${isEncrypted(storedA.content)} (${storedA.content.slice(0, 20)}…)`);
  console.log(`    tenant-A: stored metadata sentinel? ${isEncrypted(storedA.metadata)}`);
  const readA = await wrapped.getMessages('chat-A');
  if (readA[0]!.content !== 'top secret tenant-A') throw new Error('tenant-A decrypt failed');
  if (readA[0]!.metadata !== '{"k":"v"}') throw new Error('tenant-A metadata decrypt failed');
  console.log(`    tenant-A: getMessages returns plaintext content+metadata: ✓`);

  // Tenant B (disabled): write stays plaintext
  await wrapped.addMessage({
    id: 'm-B1',
    chatId: 'chat-B',
    role: 'user',
    content: 'plain tenant-B',
    metadata: null,
  } as Parameters<DatabaseAdapter['addMessage']>[0]);
  const storedB = rawMessages().find((m) => m.id === 'm-B1');
  if (!storedB || isEncrypted(storedB.content)) throw new Error('tenant-B content should NOT be encrypted');
  console.log(`    tenant-B (disabled): stored plaintext: "${storedB.content}" ✓`);

  // Lazy-upgrade window: a plaintext row already in the DB on tenant A.
  rawMessages().push({
    id: 'm-A0',
    chat_id: 'chat-A',
    role: 'assistant',
    content: 'legacy plaintext row',
    metadata: null,
    tokens_used: 0,
    cost: 0,
    latency_ms: 0,
    created_at: new Date().toISOString(),
  });
  const allA = await wrapped.getMessages('chat-A');
  const legacy = allA.find((m) => m.id === 'm-A0');
  if (!legacy || legacy.content !== 'legacy plaintext row') throw new Error('lazy-upgrade read broke');
  console.log(`    tenant-A: legacy plaintext row read transparently: ✓`);

  console.log('\nAll Phase 3 assertions passed. ✅');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
