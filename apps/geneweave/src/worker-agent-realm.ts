/**
 * Tenancy Realm — resolve the tenant-effective WORKER AGENT (content forking for supervisor workers).
 *
 * A built-in worker agent is a *global original* until a tenant forks its own copy (customizes the
 * worker's system_prompt / tools). worker_agents keeps its inline UNIQUE(name), so a fork can't reuse
 * the name: `logical_key = name` is the shared identity, and a fork takes a tenant-scoped `name#tenant`.
 * Resolution keys on logical_key and RESTORES the canonical name on the effective row, so the supervisor
 * sees the worker under its normal name but with the tenant's forked content. Mirrors the prompt/skill
 * bridges over @weaveintel/realm's table-agnostic resolver — no resolution logic is duplicated.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { resolveEffective, type RealmRecord, type RealmContext } from '@weaveintel/realm';
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { WORKER_SEMANTIC_COLS } from './migrations/m155-realm-columns-worker-agents.js';
import type { WorkerAgentRow } from './db-types/agents.js';

/** Recompute a worker's content_hash over its semantic fields (matches m155; excludes `name`). */
export function workerContentHash(row: Partial<WorkerAgentRow>): string {
  const semantic: Record<string, unknown> = {};
  for (const c of WORKER_SEMANTIC_COLS) semantic[c] = parseRealmSemantic((row as Record<string, unknown>)[c]);
  return realmContentHash(semantic);
}

/** Fields an operator may override when a tenant customizes a worker (copy-on-write). */
export type WorkerOverrides = Partial<Pick<WorkerAgentRow, (typeof WORKER_SEMANTIC_COLS)[number] | 'share_mode'>>;

const logicalKeyOf = (r: { logical_key?: string | null; name?: string; id?: string }): string =>
  (r.logical_key ?? undefined) || (r.name ?? undefined) || String(r.id ?? '');

function toWorkerRealmRecord(row: WorkerAgentRow): RealmRecord<Record<string, unknown>> {
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
 * The ONE effective worker per logical key for a tenant — its own fork if present, else a shared
 * ancestor's, else the global — with the canonical `name` restored (a fork's tenant-scoped `name#tenant`
 * is replaced by its logical key so callers address the worker under its normal name). With no tenant,
 * returns the global workers unchanged.
 */
export function resolveTenantEffectiveWorkerAgents(allWorkers: readonly WorkerAgentRow[], tenantId: string | null | undefined, ctx?: RealmContext): WorkerAgentRow[] {
  if (!tenantId) return allWorkers.filter((w) => (w.realm ?? 'global') === 'global');
  const context: RealmContext = ctx ?? { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
  const effective = resolveEffective(allWorkers.map(toWorkerRealmRecord), context);
  return effective.map((e) => {
    const { realmProvenance, ...row } = e;
    const w = row as unknown as WorkerAgentRow;
    // Present the fork under the canonical worker name (its logical key), not the tenant-scoped alias.
    return { ...w, name: w.logical_key ?? w.name };
  });
}

/**
 * Build a tenant's copy-on-write fork of a GLOBAL worker: a new row with a tenant-scoped name (so the
 * inline UNIQUE(name) is satisfied), logical_key = the global's name, provenance columns for drift, the
 * tenant's overrides, and a fresh content_hash. Does not touch the DB — persist via insertRealmWorkerAgentRow.
 */
export function buildTenantWorkerAgentFork(global: WorkerAgentRow, tenantId: string, overrides: WorkerOverrides = {}): Omit<WorkerAgentRow, 'created_at' | 'updated_at'> {
  const logicalKey = logicalKeyOf(global);
  const forked = { ...global, id: newUUIDv7() } as Record<string, unknown>;
  for (const c of WORKER_SEMANTIC_COLS) if (overrides[c] !== undefined) forked[c] = overrides[c];
  forked['name'] = `${logicalKey}#${tenantId}`; // tenant-scoped, satisfies UNIQUE(name)
  forked['enabled'] = 1;
  forked['realm'] = 'tenant';
  forked['owner_tenant_id'] = tenantId;
  forked['logical_key'] = logicalKey;
  forked['origin_id'] = global.id;
  forked['origin_hash'] = global.content_hash ?? '';
  forked['track_mode'] = 'pin';
  forked['share_mode'] = overrides.share_mode ?? 'private';
  forked['content_hash'] = workerContentHash(forked as Partial<WorkerAgentRow>);
  return forked as unknown as Omit<WorkerAgentRow, 'created_at' | 'updated_at'>;
}
