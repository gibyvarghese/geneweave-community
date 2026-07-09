/**
 * Tenancy Realm — resolve the tenant-effective PROMPT CATALOG rows (content forking for prompt
 * strategies, output contracts, and section frameworks).
 *
 * A built-in catalog row is a *global original* until a tenant forks its own copy (customizes a strategy's
 * instructions, a contract's rules, a framework's sections). All three tables key on `key UNIQUE`, so a
 * fork can't reuse the key: `logical_key = key` is the shared identity, a fork takes a tenant-scoped
 * `key#tenant`, and resolution keys on logical_key and RESTORES the canonical key on the effective row.
 * Mirrors the tool-policy/cost-policy bridges over @weaveintel/realm's table-agnostic resolver — no
 * resolution logic is duplicated. A single generic factory backs all three tables (identical shape).
 */
import { newUUIDv7 } from '@weaveintel/core';
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { STRATEGY_SEMANTIC_COLS, CONTRACT_SEMANTIC_COLS, FRAMEWORK_SEMANTIC_COLS } from './migrations/m159-realm-columns-prompt-catalog.js';
import type { PromptStrategyRow, PromptContractRow, PromptFrameworkRow } from './db-types/prompts.js';

/** The common shape of a keyed, realm-aware catalog row. */
interface KeyedRealmRow {
  id: string;
  key: string;
  enabled?: number;
  realm?: string;
  owner_tenant_id?: string | null;
  logical_key?: string | null;
  origin_id?: string | null;
  origin_hash?: string | null;
  content_hash?: string;
  track_mode?: string;
  share_mode?: string;
}

const logicalKeyOf = (r: { logical_key?: string | null; key?: string; id?: string }): string =>
  (r.logical_key ?? undefined) || (r.key ?? undefined) || String(r.id ?? '');

/** Build the content-hash / resolve / fork helpers for one keyed catalog table (parameterised by its semantic cols). */
function makeKeyedCatalogRealm<Row extends KeyedRealmRow>(semanticCols: readonly string[]) {
  function contentHash(row: Partial<Row>): string {
    const semantic: Record<string, unknown> = {};
    for (const c of semanticCols) semantic[c] = parseRealmSemantic((row as Record<string, unknown>)[c]);
    return realmContentHash(semantic);
  }

  function toRealmRecord(row: Row): RealmRecord<Record<string, unknown>> {
    return {
      ...(row as unknown as Record<string, unknown>),
      id: row.id,
      realm: row.realm === 'tenant' ? 'tenant' : 'global',
      ownerTenantId: row.owner_tenant_id ?? null,
      logicalKey: logicalKeyOf(row),
      originId: row.origin_id ?? null,
      originHash: row.origin_hash ?? null,
      contentHash: row.content_hash ?? '',
      trackMode: row.track_mode === 'track_latest' ? 'track_latest' : 'pin',
      shareMode: row.share_mode === 'children' ? 'children' : row.share_mode === 'subtree' ? 'subtree' : 'private',
    };
  }

  /**
   * The ONE effective row per logical key for a tenant — its own fork if present, else a shared ancestor's,
   * else the global — with the canonical `key` restored. With no tenant, returns the global rows unchanged.
   */
  function resolve(all: readonly Row[], tenantId: string | null | undefined, ctx?: RealmContext): Row[] {
    if (!tenantId) return all.filter((r) => (r.realm ?? 'global') === 'global');
    const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
    const effective = resolveEffective(all.map(toRealmRecord), context);
    return effective.map((e) => {
      const { realmProvenance, ...row } = e;
      const r = row as unknown as Row;
      return { ...r, key: r.logical_key ?? r.key };
    });
  }

  /**
   * Build a tenant's copy-on-write fork of a GLOBAL row: a new row with a tenant-scoped `key#tenant` (so the
   * UNIQUE(key) is satisfied), logical_key = the global's key, provenance columns for drift, the tenant's
   * overrides, and a fresh content_hash. Does not touch the DB — persist via the sibling insertRealm*Row.
   */
  function buildFork(global: Row, tenantId: string, overrides: Record<string, unknown> = {}): Omit<Row, 'created_at' | 'updated_at'> {
    const logicalKey = logicalKeyOf(global);
    const forked = { ...global, id: newUUIDv7() } as unknown as Record<string, unknown>;
    for (const c of semanticCols) if (overrides[c] !== undefined) forked[c] = overrides[c];
    forked['key'] = `${logicalKey}#${tenantId}`; // tenant-scoped, satisfies UNIQUE(key)
    forked['enabled'] = global.enabled ?? 1;
    forked['realm'] = 'tenant';
    forked['owner_tenant_id'] = tenantId;
    forked['logical_key'] = logicalKey;
    forked['origin_id'] = global.id;
    forked['origin_hash'] = global.content_hash ?? '';
    forked['track_mode'] = 'pin';
    forked['share_mode'] = overrides['share_mode'] ?? 'private';
    forked['content_hash'] = contentHash(forked as Partial<Row>);
    return forked as unknown as Omit<Row, 'created_at' | 'updated_at'>;
  }

  return { contentHash, resolve, buildFork };
}

// ── prompt_strategies ────────────────────────────────────────────────────────
const strategyRealm = makeKeyedCatalogRealm<PromptStrategyRow>(STRATEGY_SEMANTIC_COLS);
export const promptStrategyContentHash = strategyRealm.contentHash;
export const resolveTenantEffectivePromptStrategies = strategyRealm.resolve;
export const buildTenantPromptStrategyFork = strategyRealm.buildFork;

// ── prompt_contracts ─────────────────────────────────────────────────────────
const contractRealm = makeKeyedCatalogRealm<PromptContractRow>(CONTRACT_SEMANTIC_COLS);
export const promptContractContentHash = contractRealm.contentHash;
export const resolveTenantEffectivePromptContracts = contractRealm.resolve;
export const buildTenantPromptContractFork = contractRealm.buildFork;

// ── prompt_frameworks ────────────────────────────────────────────────────────
const frameworkRealm = makeKeyedCatalogRealm<PromptFrameworkRow>(FRAMEWORK_SEMANTIC_COLS);
export const promptFrameworkContentHash = frameworkRealm.contentHash;
export const resolveTenantEffectivePromptFrameworks = frameworkRealm.resolve;
export const buildTenantPromptFrameworkFork = frameworkRealm.buildFork;
