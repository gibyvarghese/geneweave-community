/**
 * Tenancy Realm Phase 4 (app) — make the tenant TREE actually drive resolution.
 *
 * Phases 1 & 3 resolved against a flat, depth-0 context (each tenant seen as its own root). Now that
 * tenants are a real tree (m150), this builds the true lineage (root → … → self) so a parent org's
 * SHARED prompt fork resolves for its subsidiaries, and a parent's state overlay inherits down the tree.
 * It reuses @weaveintel/identity's tenant hierarchy over the app's `tenants` table + realm's
 * buildRealmContext — no new tree code. Also computes the blast radius of a share from the real tree.
 */
import { createSqlTenantHierarchy } from '@weaveintel/identity';
import {
  buildRealmContext, GLOBAL_CONTEXT, blastRadius, createSqlVersionLog,
  type SqlClient, type SqlDialect, type RealmContext, type ShareMode, type BlastRadius,
} from '@weaveintel/realm';
import { promptContentHash } from './chat-realm-prompt.js';
import { parseRealmSemantic } from './migrations/m151-realm-columns.js';

const SEMANTIC_COLS = ['name', 'description', 'category', 'template', 'variables', 'model_compatibility', 'execution_defaults', 'framework'] as const;

const ph = (d: SqlDialect, i: number) => (d === 'postgres' ? `$${i}` : '?');
const hierarchyOf = (client: SqlClient, dialect: SqlDialect) =>
  createSqlTenantHierarchy({ client, dialect, table: 'tenants', ensureSchema: false });

/**
 * The realm context (lineage root → self) for a tenant. Falls back to a flat depth-0 context if the
 * tenant isn't a node in the tree yet (e.g. a legacy free-text tenant_id not backfilled), and to the
 * global context when there's no tenant — so resolution never throws on unknown tenants.
 */
export async function buildTenantContext(client: SqlClient, dialect: SqlDialect, tenantId: string | null): Promise<RealmContext> {
  if (!tenantId) return GLOBAL_CONTEXT;
  try {
    const ctx = await buildRealmContext(hierarchyOf(client, dialect), tenantId);
    if (ctx.lineage.length > 0) return ctx;
  } catch { /* tenant not in the tree — fall through to a flat context */ }
  return { tenantId, depth: 0, lineage: [{ tenantId, depth: 0 }] };
}

/**
 * Preview who a share of `logicalKey` (owned by `ownerTenantId`) would reach: descendants who'd start
 * using it (`inheriting`), descendants who already have their own fork (`shadowed`), and those out of
 * scope. Computed from the real tenant tree + the app's `prompts` table.
 */
export async function promptBlastRadius(
  client: SqlClient, dialect: SqlDialect, ownerTenantId: string, logicalKey: string, shareMode: ShareMode,
): Promise<BlastRadius> {
  const hierarchy = hierarchyOf(client, dialect);
  const owner = await hierarchy.get(ownerTenantId).catch(() => null);
  // A tenant that isn't a node in the tree (e.g. a legacy free-text tenant_id) has no descendants → the
  // share reaches nobody. Return an empty radius rather than erroring.
  if (!owner) return blastRadius(0, [], shareMode, new Set());
  const ownerDepth = owner.depth ?? 0;
  const descendants = (await hierarchy.descendants(ownerTenantId).catch(() => [])).map((t) => ({ tenantId: t.id, depth: t.depth }));
  // Which descendants already have their OWN fork of this key → they won't inherit.
  const ids = descendants.map((d) => d.tenantId);
  const forked = new Set<string>();
  if (ids.length) {
    const inList = ids.map((_, i) => ph(dialect, i + 2)).join(', ');
    const { rows } = await client.query(
      `SELECT owner_tenant_id FROM prompts WHERE realm = 'tenant' AND logical_key = ${ph(dialect, 1)} AND owner_tenant_id IN (${inList})`,
      [logicalKey, ...ids],
    );
    for (const r of rows) if (r['owner_tenant_id']) forked.add(String(r['owner_tenant_id']));
  }
  return blastRadius(ownerDepth, descendants, shareMode, forked);
}

/** Blast radius for a specific fork (by prompt id) — resolves its owner + logical key, then computes. */
export async function promptBlastRadiusById(client: SqlClient, dialect: SqlDialect, promptId: string, shareMode: ShareMode): Promise<BlastRadius | { error: string }> {
  const { rows } = await client.query(`SELECT owner_tenant_id, logical_key, key, id, realm FROM prompts WHERE id = ${ph(dialect, 1)}`, [promptId]);
  const fork = rows[0];
  if (!fork) return { error: 'not found' };
  if (fork['realm'] !== 'tenant' || !fork['owner_tenant_id']) return { error: 'only a tenant fork has a blast radius' };
  const logicalKey = String(fork['logical_key'] ?? fork['key'] ?? fork['id']);
  return promptBlastRadius(client, dialect, String(fork['owner_tenant_id']), logicalKey, shareMode);
}

/** Flip a tenant fork's share mode (private | children | subtree) — the Share/Unshare action. */
export async function setPromptShareMode(client: SqlClient, dialect: SqlDialect, promptId: string, shareMode: ShareMode): Promise<{ ok: boolean; reason?: string }> {
  const { rows } = await client.query(`SELECT realm FROM prompts WHERE id = ${ph(dialect, 1)}`, [promptId]);
  if (!rows[0]) return { ok: false, reason: 'not found' };
  if (rows[0]['realm'] !== 'tenant') return { ok: false, reason: 'only a tenant fork can be shared' };
  await client.query(`UPDATE prompts SET share_mode = ${ph(dialect, 1)} WHERE id = ${ph(dialect, 2)}`, [shareMode, promptId]);
  return { ok: true };
}

/**
 * Promote a tenant's fork to the shared global default — ProposeToRealm's approve step. Copies the
 * fork's content onto the global original (re-baselining it) and records a version, so every tenant
 * without its own copy now gets this content. The fork itself is left untouched.
 */
export async function promotePromptForkToGlobal(client: SqlClient, dialect: SqlDialect, promptId: string): Promise<{ ok: boolean; reason?: string; logicalKey?: string }> {
  const { rows } = await client.query(`SELECT * FROM prompts WHERE id = ${ph(dialect, 1)}`, [promptId]);
  const fork = rows[0];
  if (!fork) return { ok: false, reason: 'not found' };
  if (fork['realm'] !== 'tenant') return { ok: false, reason: 'only a tenant fork can be promoted' };
  const logicalKey = String(fork['logical_key'] ?? fork['key'] ?? fork['id']);
  const { rows: g } = await client.query(`SELECT id FROM prompts WHERE realm = 'global' AND logical_key = ${ph(dialect, 1)} LIMIT 1`, [logicalKey]);
  const globalRow = g[0];
  if (!globalRow) return { ok: false, reason: 'no global default to promote into' };

  const remote = promptContentHash(fork as Record<string, unknown>);
  const sets = SEMANTIC_COLS.map((c, i) => `${c} = ${ph(dialect, i + 1)}`);
  const vals: unknown[] = SEMANTIC_COLS.map((c) => {
    const v = (fork as Record<string, unknown>)[c];
    return v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : v);
  });
  sets.push(`content_hash = ${ph(dialect, vals.length + 1)}`); vals.push(remote);
  sets.push(`origin_hash = ${ph(dialect, vals.length + 1)}`); vals.push(remote);
  vals.push(String(globalRow['id']));
  await client.query(`UPDATE prompts SET ${sets.join(', ')} WHERE id = ${ph(dialect, vals.length)}`, vals);

  // Record the promotion as a new package version so drift keeps working.
  const log = createSqlVersionLog({ client, dialect, table: 'realm_versions' });
  const semantic: Record<string, unknown> = {};
  for (const c of SEMANTIC_COLS) semantic[c] = parseRealmSemantic((fork as Record<string, unknown>)[c]);
  await log.append({ family: 'prompts', logicalKey, payload: semantic, note: 'promote' });
  return { ok: true, logicalKey };
}
