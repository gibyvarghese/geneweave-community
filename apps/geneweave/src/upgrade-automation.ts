// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — review-queue AUTOMATION (managed rules) + per-family AUTO-ADOPT policy rows.
 *
 * The review queue (`upgrade_details`) lands every drift/merge outcome for a human. Two managed-config
 * surfaces let an operator automate the safe parts of that queue and tune how aggressively releases adopt:
 *
 *   1. Resolution rules (`upgrade_resolution_rules`) — ordered rules that match an unresolved item by
 *      family / priority / disposition and apply an action (keep | adopt | defer | tag). `applyResolutionRules`
 *      walks the queue and applies the FIRST matching rule per item, first-match-wins by `seq`. A HARD
 *      guardrail refuses to auto-resolve a P1 (guardrails / auth / collisions / conflicts) — a rule may only
 *      `tag` a P1 for triage, never keep/adopt/defer it. Every automated resolution is stamped
 *      `resolution_source = 'automation'` and `resolved_by` for audit. This reuses the review write path
 *      (`resolveReviewItem`) verbatim, so an automated `adopt` does the same field-merge + undo capture a
 *      human adopt does.
 *
 *   2. Family auto-adopt policy (`upgrade_family_policy`) — one row per realm family overriding its seed-time
 *      auto-adopt policy (always | patch_only | never). Empty by default, so the frozen `AUTO_ADOPT_POLICY`
 *      constant still governs a fresh install; a row overrides the constant for its family and is loaded into
 *      the reconcile as `policyByFamily`.
 *
 * Both tables are realm families (see realm-families.ts), so a rule / policy CHANGE flows through the existing
 * propose → review → promote governance — this module is the runtime + CRUD, not a second governance path.
 *
 * Engine-agnostic over the `SqlClient` / `SqlDialect` seam (SQLite + Postgres). All SQL is parameterized.
 */
import { randomUUID } from 'node:crypto';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph, nowExpr } from './realm-sql.js';
import { realmFamily, isRealmFamily } from './realm-families.js';
import { hashLiveRealmRow, loadFamilyPolicyOverrides } from './realm-seed-reconcile.js';
import type { AutoAdoptPolicy } from './realm-seed-reconcile.js';
import { listUnresolvedUpgradeDetails } from './upgrade-run-store.js';
import { resolveReviewItem, type ReviewAction } from './upgrade-review.js';

/** A resolution rule's action. keep/adopt/defer RESOLVE the item; tag only annotates it (no resolution). */
export type ResolutionRuleAction = 'keep' | 'adopt' | 'defer' | 'tag';
const RULE_ACTIONS: ReadonlySet<string> = new Set<ResolutionRuleAction>(['keep', 'adopt', 'defer', 'tag']);
const ADOPT_POLICIES: ReadonlySet<string> = new Set<AutoAdoptPolicy>(['always', 'patch_only', 'never']);

/** The realm family specs for the two managed-config tables (looked up once). */
const RULES_SPEC = realmFamily('upgrade_resolution_rules');
const POLICY_SPEC = realmFamily('upgrade_family_policy');

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Resolution rules — store
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The persisted shape of a resolution rule (read). JSON match columns are raw strings as stored. */
export interface ResolutionRuleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  seq: number;
  /** JSON array of family strings, or null = match any family. */
  match_families: string | null;
  /** JSON array of 'P1'..'P5', or null = match any priority. */
  match_priorities: string | null;
  /** JSON array of dispositions, or null = match any disposition. */
  match_dispositions: string | null;
  action: string;
  tag: string | null;
  enabled: number;
  realm: string;
  owner_tenant_id: string | null;
  logical_key: string | null;
  origin_hash: string | null;
  content_hash: string;
  deprecated_at: string | null;
}

/** Input for creating a resolution rule. Absent match arrays mean "match any" for that dimension. */
export interface ResolutionRuleInput {
  /** Stable rule key (its logical key). */
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
  /** Evaluation order — lower runs first (first match wins). Defaults to 100. */
  readonly seq?: number;
  readonly enabled?: boolean;
  /** Families to match; null/omitted = any. */
  readonly matchFamilies?: readonly string[] | null;
  /** Priorities to match ('P1'..'P5'); null/omitted = any. */
  readonly matchPriorities?: readonly string[] | null;
  /** Dispositions to match; null/omitted = any. */
  readonly matchDispositions?: readonly string[] | null;
  readonly action: ResolutionRuleAction;
  /** Annotation label for the 'tag' action (also appended to the item's note for audit). */
  readonly tag?: string | null;
}

/** Serialise a match array to the stored JSON string (null when empty/absent → "match any"). */
function matchJson(arr: readonly string[] | null | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  return JSON.stringify(arr.map(String));
}
/** Parse a stored match column back to an array (null/invalid → null = "match any"). */
function parseMatch(v: string | null): string[] | null {
  if (v == null || v === '') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * The semantic columns of a rule as a hashable row (JSON match columns stored as strings — hashLiveRealmRow
 * parses them, matching how every family's content_hash is computed).
 */
function ruleSemanticRow(input: ResolutionRuleInput): Record<string, unknown> {
  return {
    description: input.description ?? null,
    seq: input.seq ?? 100,
    match_families: matchJson(input.matchFamilies),
    match_priorities: matchJson(input.matchPriorities),
    match_dispositions: matchJson(input.matchDispositions),
    action: input.action,
    tag: input.tag ?? null,
  };
}

/**
 * Create a global resolution rule (a realm 'global' original — stamped with logical_key/content_hash/
 * origin_hash so governance + drift treat it like any family row).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param input the rule definition.
 * @param opts optional id override (tests), timestamp, and creator id.
 * @returns the created row. Throws on an invalid action.
 * @sideEffect one INSERT into upgrade_resolution_rules.
 */
export async function createResolutionRule(
  client: SqlClient, dialect: SqlDialect, input: ResolutionRuleInput,
  opts: { id?: string; at?: string; createdBy?: string | null } = {},
): Promise<ResolutionRuleRow> {
  if (!RULE_ACTIONS.has(input.action)) throw new Error(`invalid rule action '${input.action}' (expected keep|adopt|defer|tag)`);
  if (!input.key) throw new Error('rule key is required');
  const id = opts.id ?? randomUUID();
  const semantic = ruleSemanticRow(input);
  const contentHash = hashLiveRealmRow(RULES_SPEC, semantic);
  const at = opts.at ?? null;
  await client.query(
    `INSERT INTO upgrade_resolution_rules
       (id, key, name, description, seq, match_families, match_priorities, match_dispositions, action, tag, enabled,
        created_at, updated_at, realm, owner_tenant_id, logical_key, origin_id, origin_hash, content_hash, track_mode, share_mode)
     VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, ${ph(dialect, 3)}, ${ph(dialect, 4)}, ${ph(dialect, 5)}, ${ph(dialect, 6)}, ${ph(dialect, 7)}, ${ph(dialect, 8)}, ${ph(dialect, 9)}, ${ph(dialect, 10)}, ${ph(dialect, 11)},
       COALESCE(${ph(dialect, 12)}, ${nowExpr(dialect)}), COALESCE(${ph(dialect, 13)}, ${nowExpr(dialect)}), 'global', NULL, ${ph(dialect, 14)}, NULL, ${ph(dialect, 15)}, ${ph(dialect, 16)}, 'pin', 'private')`,
    [
      id, input.key, input.name, input.description ?? null, semantic['seq'],
      semantic['match_families'], semantic['match_priorities'], semantic['match_dispositions'], input.action, input.tag ?? null,
      input.enabled === false ? 0 : 1, at, at, input.key, contentHash, contentHash,
    ],
  );
  const row = await getResolutionRule(client, dialect, id);
  if (!row) throw new Error('failed to read back created rule');
  return row;
}

/** Fetch one rule by id. */
export async function getResolutionRule(client: SqlClient, dialect: SqlDialect, id: string): Promise<ResolutionRuleRow | null> {
  const { rows } = await client.query(`SELECT * FROM upgrade_resolution_rules WHERE id = ${ph(dialect, 1)}`, [id]);
  return (rows[0] as ResolutionRuleRow | undefined) ?? null;
}

/**
 * List resolution rules.
 * @param opts.activeOnly when true, only enabled, non-deprecated GLOBAL rules (the set the engine applies),
 *        ordered by seq then created_at (the evaluation order). Otherwise every global rule.
 */
export async function listResolutionRules(
  client: SqlClient, dialect: SqlDialect, opts: { activeOnly?: boolean } = {},
): Promise<ResolutionRuleRow[]> {
  const where = opts.activeOnly
    ? `WHERE realm = 'global' AND enabled = 1 AND deprecated_at IS NULL`
    : `WHERE realm = 'global'`;
  const { rows } = await client.query(`SELECT * FROM upgrade_resolution_rules ${where} ORDER BY seq ASC, created_at ASC, id ASC`, []);
  return rows as unknown as ResolutionRuleRow[];
}

/**
 * Update a rule's fields (platform-admin edit of a global rule). Recomputes content_hash over the new
 * semantic columns so drift/governance stay accurate.
 * @returns the updated row, or null if no such rule.
 * @sideEffect one UPDATE (all semantic columns + updated_at + content_hash).
 */
export async function updateResolutionRule(
  client: SqlClient, dialect: SqlDialect, id: string, patch: Partial<ResolutionRuleInput>,
  opts: { at?: string } = {},
): Promise<ResolutionRuleRow | null> {
  const existing = await getResolutionRule(client, dialect, id);
  if (!existing) return null;
  // Merge patch over the existing row to a full input, then rewrite all semantic columns (keeps hashing simple).
  const merged: ResolutionRuleInput = {
    key: patch.key ?? existing.key,
    name: patch.name ?? existing.name,
    description: patch.description !== undefined ? patch.description : existing.description,
    seq: patch.seq !== undefined ? patch.seq : existing.seq,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled === 1,
    matchFamilies: patch.matchFamilies !== undefined ? patch.matchFamilies : parseMatch(existing.match_families),
    matchPriorities: patch.matchPriorities !== undefined ? patch.matchPriorities : parseMatch(existing.match_priorities),
    matchDispositions: patch.matchDispositions !== undefined ? patch.matchDispositions : parseMatch(existing.match_dispositions),
    action: patch.action ?? (existing.action as ResolutionRuleAction),
    tag: patch.tag !== undefined ? patch.tag : existing.tag,
  };
  if (!RULE_ACTIONS.has(merged.action)) throw new Error(`invalid rule action '${merged.action}'`);
  const semantic = ruleSemanticRow(merged);
  const contentHash = hashLiveRealmRow(RULES_SPEC, semantic);
  await client.query(
    `UPDATE upgrade_resolution_rules SET
       key = ${ph(dialect, 1)}, name = ${ph(dialect, 2)}, description = ${ph(dialect, 3)}, seq = ${ph(dialect, 4)},
       match_families = ${ph(dialect, 5)}, match_priorities = ${ph(dialect, 6)}, match_dispositions = ${ph(dialect, 7)},
       action = ${ph(dialect, 8)}, tag = ${ph(dialect, 9)}, enabled = ${ph(dialect, 10)}, content_hash = ${ph(dialect, 11)},
       logical_key = ${ph(dialect, 12)}, updated_at = COALESCE(${ph(dialect, 13)}, ${nowExpr(dialect)})
     WHERE id = ${ph(dialect, 14)}`,
    [
      merged.key, merged.name, merged.description ?? null, semantic['seq'],
      semantic['match_families'], semantic['match_priorities'], semantic['match_dispositions'],
      merged.action, merged.tag ?? null, merged.enabled === false ? 0 : 1, contentHash,
      merged.key, opts.at ?? null, id,
    ],
  );
  return getResolutionRule(client, dialect, id);
}

/** Delete a rule by id. @returns true if a row was removed. */
export async function deleteResolutionRule(client: SqlClient, dialect: SqlDialect, id: string): Promise<boolean> {
  const existing = await getResolutionRule(client, dialect, id);
  if (!existing) return false;
  await client.query(`DELETE FROM upgrade_resolution_rules WHERE id = ${ph(dialect, 1)}`, [id]);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Resolution rules — the automation engine
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The outcome of an automation pass over the queue. */
export interface ApplyRulesResult {
  /** Unresolved items considered. */
  readonly evaluated: number;
  /** Items resolved (keep/adopt/defer) by a rule. */
  readonly resolved: number;
  /** Items annotated by a `tag` rule (not resolved). */
  readonly tagged: number;
  /** P1 items a resolving rule matched but was REFUSED on (the hard guardrail). */
  readonly skippedP1: number;
  /** Items no rule matched. */
  readonly unmatched: number;
  /** Items a rule matched but whose resolve failed (e.g. adopt with no upstream). */
  readonly failed: number;
  /** Count of resolutions/annotations by action. */
  readonly byAction: Record<string, number>;
}

/** A parsed, ready-to-match rule (match arrays decoded once). */
interface CompiledRule {
  readonly action: ResolutionRuleAction;
  readonly tag: string | null;
  readonly families: string[] | null;
  readonly priorities: string[] | null;
  readonly dispositions: string[] | null;
}

/** True if `value` satisfies a match dimension: a null constraint is a wildcard; otherwise membership. */
const dimMatches = (constraint: string[] | null, value: string): boolean => constraint === null || constraint.includes(value);

/**
 * Apply the active resolution rules across the unresolved review queue, first-match-wins by seq.
 *
 * For each unresolved item, the first enabled global rule whose family/priority/disposition constraints all
 * match decides the action. A resolving action (keep/adopt/defer) is applied via the normal review write path
 * with `resolution_source = 'automation'` — EXCEPT on a P1 item, where any resolving action is REFUSED
 * (counted in `skippedP1`); the `tag` action annotates the item's note and is allowed on any priority.
 *
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param opts.resolvedBy audit actor for automated resolutions (defaults to 'automation').
 * @param opts.family optional narrowing — only evaluate this family's items.
 * @param opts.priority optional narrowing — only evaluate this priority's items.
 * @param opts.at timestamp override (tests).
 * @returns an {@link ApplyRulesResult} tally. Side effects: resolves/annotates matched non-P1 items.
 */
export async function applyResolutionRules(
  client: SqlClient, dialect: SqlDialect,
  opts: { resolvedBy?: string | null; family?: string; priority?: string; at?: string } = {},
): Promise<ApplyRulesResult> {
  const ruleRows = await listResolutionRules(client, dialect, { activeOnly: true });
  const rules: CompiledRule[] = ruleRows.map((r) => ({
    action: r.action as ResolutionRuleAction,
    tag: r.tag,
    families: parseMatch(r.match_families),
    priorities: parseMatch(r.match_priorities),
    dispositions: parseMatch(r.match_dispositions),
  }));
  const filter: { family?: string; priority?: string } = {};
  if (opts.family) filter.family = opts.family;
  if (opts.priority) filter.priority = opts.priority;
  const items = await listUnresolvedUpgradeDetails(client, dialect, filter);

  const resolvedBy = opts.resolvedBy ?? 'automation';
  let resolved = 0, tagged = 0, skippedP1 = 0, unmatched = 0, failed = 0;
  const byAction: Record<string, number> = {};

  for (const item of items) {
    const rule = rules.find((r) => dimMatches(r.families, item.family) && dimMatches(r.priorities, item.priority) && dimMatches(r.dispositions, item.disposition));
    if (!rule) { unmatched++; continue; }

    if (rule.action === 'tag') {
      // Annotation only — never a resolution — so it is allowed on P1 (triage aid), same note-append as defer.
      await client.query(
        `UPDATE upgrade_details SET note = COALESCE(note, '') || ${ph(dialect, 1)} WHERE id = ${ph(dialect, 2)}`,
        [` [tag: ${rule.tag ?? 'tagged'}]`, item.id],
      );
      tagged++;
      byAction['tag'] = (byAction['tag'] ?? 0) + 1;
      continue;
    }

    // Resolving action (keep/adopt/defer): HARD refusal on P1 — the guardrail is a rule, not a filter to bypass.
    if (item.priority === 'P1') { skippedP1++; continue; }
    const res = await resolveReviewItem(client, dialect, item.id, rule.action as ReviewAction, { resolvedBy, resolutionSource: 'automation' });
    if (res.ok) { resolved++; byAction[rule.action] = (byAction[rule.action] ?? 0) + 1; }
    else failed++;
  }
  return { evaluated: items.length, resolved, tagged, skippedP1, unmatched, failed, byAction };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Family auto-adopt policy — store
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The persisted shape of a family auto-adopt policy row (read). */
export interface FamilyPolicyRow {
  id: string;
  target_family: string;
  policy: string;
  note: string | null;
  enabled: number;
  realm: string;
  logical_key: string | null;
  deprecated_at: string | null;
}

/**
 * Set (upsert) a family's auto-adopt policy override. One GLOBAL row per family; a repeat call updates it.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param family the realm family the policy governs (validated against the registry).
 * @param policy 'always' | 'patch_only' | 'never'.
 * @param opts optional note, timestamp, and actor.
 * @returns the upserted row. Throws on an unknown family or invalid policy.
 * @sideEffect one INSERT or UPDATE of upgrade_family_policy.
 */
export async function setFamilyPolicy(
  client: SqlClient, dialect: SqlDialect, family: string, policy: AutoAdoptPolicy,
  opts: { note?: string | null; at?: string; updatedBy?: string | null } = {},
): Promise<FamilyPolicyRow> {
  if (!isRealmFamily(family)) throw new Error(`unknown realm family '${family}'`);
  if (!ADOPT_POLICIES.has(policy)) throw new Error(`invalid policy '${policy}' (expected always|patch_only|never)`);
  const contentHash = hashLiveRealmRow(POLICY_SPEC, { policy });
  const existing = await getFamilyPolicy(client, dialect, family);
  const at = opts.at ?? null;
  if (existing) {
    await client.query(
      `UPDATE upgrade_family_policy SET policy = ${ph(dialect, 1)}, note = ${ph(dialect, 2)}, content_hash = ${ph(dialect, 3)}, updated_at = COALESCE(${ph(dialect, 4)}, ${nowExpr(dialect)}) WHERE id = ${ph(dialect, 5)}`,
      [policy, opts.note ?? existing.note ?? null, contentHash, at, existing.id],
    );
    const row = await getFamilyPolicy(client, dialect, family);
    return row!;
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO upgrade_family_policy
       (id, target_family, policy, note, enabled, created_at, updated_at, realm, owner_tenant_id, logical_key, origin_id, origin_hash, content_hash, track_mode, share_mode)
     VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, ${ph(dialect, 3)}, ${ph(dialect, 4)}, 1, COALESCE(${ph(dialect, 5)}, ${nowExpr(dialect)}), COALESCE(${ph(dialect, 6)}, ${nowExpr(dialect)}), 'global', NULL, ${ph(dialect, 7)}, NULL, ${ph(dialect, 8)}, ${ph(dialect, 9)}, 'pin', 'private')`,
    [id, family, policy, opts.note ?? null, at, at, family, contentHash, contentHash],
  );
  const row = await getFamilyPolicy(client, dialect, family);
  return row!;
}

/** Fetch the GLOBAL policy row for a family, or null. */
export async function getFamilyPolicy(client: SqlClient, dialect: SqlDialect, family: string): Promise<FamilyPolicyRow | null> {
  const { rows } = await client.query(
    `SELECT * FROM upgrade_family_policy WHERE realm = 'global' AND target_family = ${ph(dialect, 1)} LIMIT 1`,
    [family],
  );
  return (rows[0] as FamilyPolicyRow | undefined) ?? null;
}

/** List every GLOBAL family-policy override row. */
export async function listFamilyPolicies(client: SqlClient, dialect: SqlDialect): Promise<FamilyPolicyRow[]> {
  const { rows } = await client.query(`SELECT * FROM upgrade_family_policy WHERE realm = 'global' ORDER BY target_family ASC`, []);
  return rows as unknown as FamilyPolicyRow[];
}

/**
 * The family → auto-adopt-policy override map that reconcile consumes (see
 * {@link loadFamilyPolicyOverrides}). Re-exported here so the admin surface and reconcile share ONE loader.
 */
export { loadFamilyPolicyOverrides as loadFamilyPolicyMap } from './realm-seed-reconcile.js';
