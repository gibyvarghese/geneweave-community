// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — write-path & governance (Section D), engine-agnostic over `SqlClient`.
 *
 * Everything here answers "who may change the shared defaults, and how" — as opposed to the resolvers,
 * which only answer "which copy does this tenant get". All five operations are written ONCE against the
 * family registry (`realm-families.ts`) rather than per-table:
 *
 *   • promoteRealmForkToGlobal  — a tenant's fork becomes the global default (generic; was prompts-only)
 *   • ProposeToRealm            — propose → pending queue → platform-admin approve (promotes) / reject
 *   • deprecate / undeprecate   — retire a global default without breaking tenants already on it
 *   • assertNoVisibleKeyCollision — "if you can already SEE that key, Customize it; don't create a twin"
 *   • reparentTenant            — move a tenant in the org tree, reporting whose inherited config moved
 */
import { createSqlTenantHierarchy } from '@weaveintel/identity';
import {
  isVisible, createSqlVersionLog,
  type SqlClient, type SqlDialect, type RealmContext, type RealmFields,
} from '@weaveintel/realm';
import { newUUIDv7 } from './lib/uuid.js';
// The app's own hash (m151) — byte-identical to the engine's computeContentHash, and the exact function
// the migration backfill used. Promote MUST reproduce it or every promoted row reads as drifted.
import { realmContentHash, parseRealmSemantic } from './migrations/m151-realm-columns.js';
import { realmFamily, logicalKeyOfRow, type RealmFamilySpec } from './realm-families.js';

const ph = (d: SqlDialect, i: number) => (d === 'postgres' ? `$${i}` : '?');
/** The engine's `now` expression — matches NOW_SQL / the m160 column defaults on both dialects. */
const nowExpr = (d: SqlDialect) => (d === 'postgres' ? `to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')` : `datetime('now')`);
const hierarchyOf = (client: SqlClient, dialect: SqlDialect) =>
  createSqlTenantHierarchy({ client, dialect, table: 'tenants', ensureSchema: false });

/** The semantic payload of a row for `spec` — the same projection the migrations hash. */
function semanticOf(spec: RealmFamilySpec, row: Record<string, unknown>): Record<string, unknown> {
  const semantic: Record<string, unknown> = {};
  for (const c of spec.semanticCols) semantic[c] = parseRealmSemantic(row[c]);
  return semantic;
}

async function rowById(client: SqlClient, dialect: SqlDialect, table: string, id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query(`SELECT * FROM ${table} WHERE id = ${ph(dialect, 1)}`, [id]);
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

// ════════════════════════════ generic promote ════════════════════════════

export interface PromoteResult { ok: boolean; reason?: string; logicalKey?: string; globalId?: string }

/**
 * Copy a tenant fork's content onto its family's GLOBAL original, re-baselining it, and append a
 * `realm_versions` entry so drift keeps working. Every tenant without its own copy now gets this
 * content. The fork itself is left untouched (its owner keeps using it, now in_sync with the global).
 *
 * Generalises the prompts-only `promotePromptForkToGlobal`: identical semantics, driven by the family
 * registry so all eleven families promote through one implementation.
 */
export async function promoteRealmForkToGlobal(
  client: SqlClient, dialect: SqlDialect, family: string, forkId: string,
): Promise<PromoteResult> {
  const spec = realmFamily(family);
  const fork = await rowById(client, dialect, spec.table, forkId);
  if (!fork) return { ok: false, reason: 'not found' };
  if (fork['realm'] !== 'tenant') return { ok: false, reason: 'only a tenant fork can be promoted' };

  const logicalKey = logicalKeyOfRow(spec, fork);
  const { rows: g } = await client.query(
    `SELECT id FROM ${spec.table} WHERE realm = 'global' AND logical_key = ${ph(dialect, 1)} LIMIT 1`, [logicalKey],
  );
  const globalRow = g[0] as Record<string, unknown> | undefined;
  if (!globalRow) return { ok: false, reason: 'no global default to promote into' };

  const semantic = semanticOf(spec, fork);
  const remote = realmContentHash(semantic);

  const sets = spec.semanticCols.map((c, i) => `${c} = ${ph(dialect, i + 1)}`);
  const vals: unknown[] = spec.semanticCols.map((c) => {
    const v = fork[c];
    return v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : v);
  });
  sets.push(`content_hash = ${ph(dialect, vals.length + 1)}`); vals.push(remote);
  sets.push(`origin_hash = ${ph(dialect, vals.length + 1)}`); vals.push(remote);
  vals.push(String(globalRow['id']));
  await client.query(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = ${ph(dialect, vals.length)}`, vals);

  const log = createSqlVersionLog({ client, dialect, table: 'realm_versions' });
  await log.append({ family: spec.family, logicalKey, payload: semantic, note: 'promote' });
  return { ok: true, logicalKey, globalId: String(globalRow['id']) };
}

// ════════════════════════════ D12 — ProposeToRealm ════════════════════════════

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface RealmProposalRow {
  id: string; family: string; logical_key: string; fork_id: string; tenant_id: string;
  note: string | null; status: ProposalStatus; proposed_by: string | null;
  created_at: string; reviewed_at: string | null; reviewed_by: string | null; review_note: string | null;
}

export interface ProposeResult { ok: boolean; reason?: string; proposal?: RealmProposalRow }

/**
 * A tenant admin proposes that their fork become the global default. Nothing changes yet — the row
 * lands `pending` for a platform admin to review. Re-proposing the same fork UPDATES the open proposal
 * (note/proposer) rather than queueing a duplicate: the partial unique index allows one pending row
 * per fork.
 */
export async function proposeRealmFork(
  client: SqlClient, dialect: SqlDialect, family: string, forkId: string,
  opts: { proposedBy?: string | null; note?: string | null } = {},
): Promise<ProposeResult> {
  const spec = realmFamily(family);
  const fork = await rowById(client, dialect, spec.table, forkId);
  if (!fork) return { ok: false, reason: 'not found' };
  if (fork['realm'] !== 'tenant') return { ok: false, reason: 'only a tenant fork can be proposed' };
  const tenantId = fork['owner_tenant_id'];
  if (typeof tenantId !== 'string' || tenantId === '') return { ok: false, reason: 'fork has no owner tenant' };

  const logicalKey = logicalKeyOfRow(spec, fork);
  const { rows: g } = await client.query(
    `SELECT id, deprecated_at FROM ${spec.table} WHERE realm = 'global' AND logical_key = ${ph(dialect, 1)} LIMIT 1`, [logicalKey],
  );
  const globalRow = g[0] as Record<string, unknown> | undefined;
  if (!globalRow) return { ok: false, reason: 'no global default to promote into' };
  if (globalRow['deprecated_at']) return { ok: false, reason: 'the global default is deprecated' };

  const existing = await pendingProposalForFork(client, dialect, forkId);
  if (existing) {
    await client.query(
      `UPDATE realm_proposals SET note = ${ph(dialect, 1)}, proposed_by = ${ph(dialect, 2)} WHERE id = ${ph(dialect, 3)}`,
      [opts.note ?? null, opts.proposedBy ?? null, existing.id],
    );
    return { ok: true, proposal: { ...existing, note: opts.note ?? null, proposed_by: opts.proposedBy ?? null } };
  }

  const id = newUUIDv7();
  await client.query(
    `INSERT INTO realm_proposals (id, family, logical_key, fork_id, tenant_id, note, status, proposed_by)
     VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, ${ph(dialect, 3)}, ${ph(dialect, 4)}, ${ph(dialect, 5)}, ${ph(dialect, 6)}, 'pending', ${ph(dialect, 7)})`,
    [id, spec.family, logicalKey, forkId, tenantId, opts.note ?? null, opts.proposedBy ?? null],
  );
  const saved = await proposalById(client, dialect, id);
  return { ok: true, ...(saved ? { proposal: saved } : {}) };
}

async function pendingProposalForFork(client: SqlClient, dialect: SqlDialect, forkId: string): Promise<RealmProposalRow | null> {
  const { rows } = await client.query(
    `SELECT * FROM realm_proposals WHERE fork_id = ${ph(dialect, 1)} AND status = 'pending' LIMIT 1`, [forkId],
  );
  return (rows[0] as RealmProposalRow | undefined) ?? null;
}

export async function proposalById(client: SqlClient, dialect: SqlDialect, id: string): Promise<RealmProposalRow | null> {
  const { rows } = await client.query(`SELECT * FROM realm_proposals WHERE id = ${ph(dialect, 1)}`, [id]);
  return (rows[0] as RealmProposalRow | undefined) ?? null;
}

/** The review queue, newest first. Filter by status (default `pending`) and optionally by family. */
export async function listRealmProposals(
  client: SqlClient, dialect: SqlDialect, opts: { status?: ProposalStatus; family?: string } = {},
): Promise<RealmProposalRow[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.status) { where.push(`status = ${ph(dialect, vals.length + 1)}`); vals.push(opts.status); }
  if (opts.family) { where.push(`family = ${ph(dialect, vals.length + 1)}`); vals.push(opts.family); }
  const sql = `SELECT * FROM realm_proposals${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`;
  const { rows } = await client.query(sql, vals);
  return rows as unknown as RealmProposalRow[];
}

export interface ReviewResult { ok: boolean; reason?: string; promoted?: PromoteResult }

/**
 * Platform-admin approval: promote the proposed fork into the global default, then close the proposal.
 * The promote runs FIRST — if it fails (the global vanished, the fork was reverted), the proposal stays
 * `pending` and the caller sees why, rather than a queue that claims success over a no-op.
 */
export async function approveRealmProposal(
  client: SqlClient, dialect: SqlDialect, proposalId: string, opts: { reviewer?: string | null; reviewNote?: string | null } = {},
): Promise<ReviewResult> {
  const proposal = await proposalById(client, dialect, proposalId);
  if (!proposal) return { ok: false, reason: 'proposal not found' };
  if (proposal.status !== 'pending') return { ok: false, reason: `proposal already ${proposal.status}` };

  const promoted = await promoteRealmForkToGlobal(client, dialect, proposal.family, proposal.fork_id);
  if (!promoted.ok) return { ok: false, reason: promoted.reason ?? 'promote failed', promoted };

  await closeProposal(client, dialect, proposalId, 'approved', opts);
  return { ok: true, promoted };
}

/** Platform-admin rejection: close the proposal, change nothing. */
export async function rejectRealmProposal(
  client: SqlClient, dialect: SqlDialect, proposalId: string, opts: { reviewer?: string | null; reviewNote?: string | null } = {},
): Promise<ReviewResult> {
  const proposal = await proposalById(client, dialect, proposalId);
  if (!proposal) return { ok: false, reason: 'proposal not found' };
  if (proposal.status !== 'pending') return { ok: false, reason: `proposal already ${proposal.status}` };
  await closeProposal(client, dialect, proposalId, 'rejected', opts);
  return { ok: true };
}

async function closeProposal(
  client: SqlClient, dialect: SqlDialect, id: string, status: 'approved' | 'rejected',
  opts: { reviewer?: string | null; reviewNote?: string | null },
): Promise<void> {
  const now = nowExpr(dialect);
  await client.query(
    `UPDATE realm_proposals SET status = ${ph(dialect, 1)}, reviewed_at = ${now}, reviewed_by = ${ph(dialect, 2)}, review_note = ${ph(dialect, 3)} WHERE id = ${ph(dialect, 4)}`,
    [status, opts.reviewer ?? null, opts.reviewNote ?? null, id],
  );
}

// ════════════════════════════ D15 — deprecation lifecycle ════════════════════════════

export interface DeprecateResult { ok: boolean; reason?: string }

/**
 * Retire a GLOBAL default. It keeps resolving for every tenant already using it — deprecation never
 * breaks a running tenant — but it can no longer be freshly customized (see `assertCustomizable`), and
 * `supersededById` points operators at the replacement.
 */
export async function deprecateRealmRecord(
  client: SqlClient, dialect: SqlDialect, family: string, id: string,
  opts: { note?: string | null; supersededById?: string | null } = {},
): Promise<DeprecateResult> {
  const spec = realmFamily(family);
  const row = await rowById(client, dialect, spec.table, id);
  if (!row) return { ok: false, reason: 'not found' };
  if (row['realm'] !== 'global') return { ok: false, reason: 'only a global default can be deprecated' };
  if (opts.supersededById) {
    const replacement = await rowById(client, dialect, spec.table, opts.supersededById);
    if (!replacement) return { ok: false, reason: 'superseding record not found' };
    if (replacement['id'] === id) return { ok: false, reason: 'a record cannot supersede itself' };
  }
  const now = nowExpr(dialect);
  await client.query(
    `UPDATE ${spec.table} SET deprecated_at = ${now}, deprecation_note = ${ph(dialect, 1)}, superseded_by_id = ${ph(dialect, 2)} WHERE id = ${ph(dialect, 3)}`,
    [opts.note ?? null, opts.supersededById ?? null, id],
  );
  return { ok: true };
}

/** Bring a deprecated global default back into service. */
export async function undeprecateRealmRecord(client: SqlClient, dialect: SqlDialect, family: string, id: string): Promise<DeprecateResult> {
  const spec = realmFamily(family);
  const row = await rowById(client, dialect, spec.table, id);
  if (!row) return { ok: false, reason: 'not found' };
  await client.query(
    `UPDATE ${spec.table} SET deprecated_at = NULL, deprecation_note = NULL, superseded_by_id = NULL WHERE id = ${ph(dialect, 1)}`, [id],
  );
  return { ok: true };
}

/** Is this record deprecated? (`deprecated_at` non-null.) */
export const isDeprecated = (row: Record<string, unknown> | null | undefined): boolean =>
  !!row && row['deprecated_at'] != null && row['deprecated_at'] !== '';

/**
 * Gate for the `customize` (fork) routes: a deprecated global must not gain NEW forks. Existing forks
 * keep working — this only blocks creating another one, steering operators to the replacement.
 */
export function assertCustomizable(row: Record<string, unknown>): { ok: true } | { ok: false; reason: string; supersededById?: string } {
  if (!isDeprecated(row)) return { ok: true };
  const superseded = row['superseded_by_id'];
  const base = 'this default is deprecated and can no longer be customized';
  return typeof superseded === 'string' && superseded
    ? { ok: false, reason: `${base}; customize ${superseded} instead`, supersededById: superseded }
    : { ok: false, reason: base };
}

// ════════════════════════════ D17 — logical-key collision rule ════════════════════════════

/** Map a raw snake_case DB row onto the camelCase realm fields `isVisible` expects. */
function visibilityFieldsOf(row: Record<string, unknown>): RealmFields {
  return {
    realm: (row['realm'] === 'tenant' ? 'tenant' : 'global'),
    ownerTenantId: (row['owner_tenant_id'] as string | null) ?? null,
    logicalKey: String(row['logical_key'] ?? ''),
    originId: (row['origin_id'] as string | null) ?? null,
    originHash: (row['origin_hash'] as string | null) ?? null,
    contentHash: String(row['content_hash'] ?? ''),
    trackMode: ((row['track_mode'] as RealmFields['trackMode']) ?? 'pin'),
    shareMode: ((row['share_mode'] as RealmFields['shareMode']) ?? 'private'),
  };
}

export interface KeyCollision { collides: boolean; reason?: string; visibleId?: string; visibleRealm?: string }

/**
 * The rule: **if a tenant can already SEE a record under logical key K, it may only Customize that
 * record — never create a brand-new one under K.** Without this, a tenant creating a same-named
 * guardrail silently produces a twin that shadows the global (for the canonical-key families) or
 * squats the canonical key (for the aliasing families), and `resolveEffective` would then have two
 * candidates for one logical key.
 *
 * Visibility is the engine's own `isVisible` — globals and your own rows always; a parent's row only if
 * it's shared to `children`/`subtree`. So an ancestor's *private* fork does NOT block you, which is
 * correct: you genuinely can't see it.
 */
export async function checkVisibleKeyCollision(
  client: SqlClient, dialect: SqlDialect, family: string, logicalKey: string, ctx: RealmContext,
): Promise<KeyCollision> {
  if (!logicalKey) return { collides: false };
  const spec = realmFamily(family);
  const { rows } = await client.query(
    `SELECT id, realm, owner_tenant_id, share_mode, logical_key FROM ${spec.table} WHERE logical_key = ${ph(dialect, 1)}`, [logicalKey],
  );
  for (const raw of rows as Array<Record<string, unknown>>) {
    if (isVisible(visibilityFieldsOf(raw), ctx)) {
      return {
        collides: true,
        reason: `logical key '${logicalKey}' already exists and is visible to you — customize it instead of creating a new one`,
        visibleId: String(raw['id']),
        visibleRealm: String(raw['realm'] ?? 'global'),
      };
    }
  }
  return { collides: false };
}

// ════════════════════════════ D16 — reparent a tenant ════════════════════════════

export interface ReparentDiff {
  ok: boolean;
  reason?: string;
  tenantId?: string;
  /** Parent before → after (`null` = a root tenant). */
  from?: { parentTenantId: string | null; path: string; depth: number };
  to?: { parentTenantId: string | null; path: string; depth: number };
  /** The moved tenant plus every descendant — each one's inherited config may now resolve differently. */
  affectedTenantIds?: string[];
}

/**
 * Move a tenant (and its whole subtree) under a new parent. This is a REALM operation, not just a tree
 * edit: a tenant's effective config is resolved down its lineage, so changing the lineage silently
 * changes which inherited prompt / guardrail / capability score every node in the subtree gets.
 *
 * So we (1) capture before-state, (2) delegate the cycle-safe materialized-path rewrite to
 * `@weaveintel/identity`, (3) report the affected subtree so the caller can flush realm caches keyed by
 * tenant. Cache invalidation is the caller's job (it holds the process-local caches) — see the admin
 * route, which clears the capability matrix.
 */
export async function reparentTenant(
  client: SqlClient, dialect: SqlDialect, tenantId: string, newParentTenantId: string | null,
): Promise<ReparentDiff> {
  const hierarchy = hierarchyOf(client, dialect);
  const before = await tenantNode(client, dialect, tenantId);
  if (!before) return { ok: false, reason: 'tenant not found' };
  if (newParentTenantId !== null && !(await tenantNode(client, dialect, newParentTenantId))) {
    return { ok: false, reason: 'new parent not found' };
  }

  // Capture the subtree BEFORE the move — these are the nodes whose lineage (and thus inherited
  // config) changes. Computed from the old materialized path so it's correct pre-move.
  const affected = await subtreeIds(client, dialect, before.path);

  try {
    await hierarchy.reparent(tenantId, newParentTenantId);
  } catch (err) {
    // Cycle-safe: identity throws TenantCycleError rather than corrupting the tree.
    return { ok: false, reason: err instanceof Error ? err.message : 'reparent failed' };
  }

  const after = await tenantNode(client, dialect, tenantId);
  if (!after) return { ok: false, reason: 'tenant vanished during reparent' };
  return { ok: true, tenantId, from: before, to: after, affectedTenantIds: affected };
}

async function tenantNode(
  client: SqlClient, dialect: SqlDialect, tenantId: string,
): Promise<{ parentTenantId: string | null; path: string; depth: number } | null> {
  const { rows } = await client.query(
    `SELECT parent_tenant_id, path, depth FROM tenants WHERE id = ${ph(dialect, 1)}`, [tenantId],
  );
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return { parentTenantId: (r['parent_tenant_id'] as string | null) ?? null, path: String(r['path'] ?? ''), depth: Number(r['depth'] ?? 0) };
}

/**
 * Every tenant id at or under `path` (the materialized path is `/a/b/c/`, so a prefix match is the
 * subtree). The prefix is LIKE-escaped: a tenant id containing `_` or `%` would otherwise act as a
 * wildcard and sweep in sibling tenants that are NOT in the subtree.
 */
async function subtreeIds(client: SqlClient, dialect: SqlDialect, path: string): Promise<string[]> {
  if (!path) return [];
  const prefix = path.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { rows } = await client.query(
    `SELECT id FROM tenants WHERE path = ${ph(dialect, 1)} OR path LIKE ${ph(dialect, 2)} ESCAPE '\\'`,
    [path, `${prefix}%`],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => String(r['id']));
}
