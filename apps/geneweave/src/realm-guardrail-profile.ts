// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — the lean guardrail profile (Section E, item 20).
 *
 * geneWeave used to decide a tenant's guardrail posture by a **fresh-database heuristic**: the base
 * guardrail set was seeded only when the `guardrails` table happened to be empty. That was brittle in
 * both directions — migrations seed guardrails before the seeder runs, so on many databases the base set
 * was never installed at all, and a tenant could never express "I want fewer checks" except by an
 * operator globally deleting rows for everyone.
 *
 * Posture is now a **per-tenant state overlay**, not a seeding accident: every guardrail is always
 * installed, and a tenant that wants a leaner (cheaper, faster) posture disables the heavy checks for
 * itself. The overlay can only ever SUBTRACT — `guardrails.enabled` still gates everything — so this can
 * never switch on something the platform turned off.
 *
 * What "lean" means, concretely: drop the **model-graded** checks, which cost an extra LLM call per turn
 * (`cognitive_check`, `factuality`). It NEVER drops a safety control — redaction, content filters, regex
 * injection detectors, budgets and escalation policies are PROTECTED and refuse to be disabled by this
 * profile, so a tenant chasing latency can't quietly turn off PII redaction or prompt-injection defence.
 */
import type { DatabaseAdapter } from './db.js';
import { guardrailLogicalKey } from './guardrail-realm.js';

/** Model-graded checks a lean posture drops: real quality signal, but an extra LLM call per turn. */
export const LEAN_DISABLED_TYPES: readonly string[] = ['cognitive_check', 'factuality'];

/**
 * Safety controls the lean profile must never disable. Even if one were also listed above, protection
 * wins — this list is the backstop that keeps "make it cheaper" from becoming "make it unsafe".
 */
export const LEAN_PROTECTED_TYPES: readonly string[] = ['redaction', 'content_filter', 'regex', 'budget', 'escalation_policy'];

export interface LeanProfileResult {
  /** Logical keys switched off for this tenant. */
  readonly disabled: string[];
  /** Logical keys deliberately left on because their type is a protected safety control. */
  readonly protected: string[];
}

const isProtected = (type: string): boolean => LEAN_PROTECTED_TYPES.includes(type);
const isLeanDrop = (type: string): boolean => LEAN_DISABLED_TYPES.includes(type) && !isProtected(type);

/**
 * Turn the model-graded guardrails off for `tenantId`, leaving every safety control on. Idempotent:
 * re-applying sets the same overlays. Returns what it disabled and what it refused to.
 */
export async function applyLeanGuardrailProfile(db: DatabaseAdapter, tenantId: string): Promise<LeanProfileResult> {
  const rows = await db.resolveTenantEffectiveGuardrails(tenantId);
  const out: LeanProfileResult = { disabled: [], protected: [] };
  for (const row of rows) {
    const key = guardrailLogicalKey(row);
    if (isLeanDrop(row.type)) {
      await db.setRealmState('guardrails', key, tenantId, { enabled: false });
      out.disabled.push(key);
    } else if (isProtected(row.type)) {
      out.protected.push(key);
    }
  }
  return out;
}

/**
 * Drop the tenant's guardrail overlays entirely — back to the shared posture (everything the platform
 * has enabled). This is the "revert to inherited" of dispositions.
 */
export async function clearGuardrailProfile(db: DatabaseAdapter, tenantId: string): Promise<{ cleared: string[] }> {
  const states = await db.listRealmStates('guardrails', tenantId);
  const cleared: string[] = [];
  for (const s of states) {
    await db.clearRealmState('guardrails', s.logicalKey, tenantId);
    cleared.push(s.logicalKey);
  }
  return { cleared };
}
