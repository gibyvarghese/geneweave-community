/**
 * Phase K5 — Kaggle live-agents account-binding capability matrix.
 *
 * Per design §5.3, every live-agent in the kaggle mesh binds to a single
 * Kaggle credential Account. The capabilities array on the AccountBinding row
 * is the platform's authoritative gate (separate from tool policies, defense in
 * depth). Revoking a single capability immediately stops that agent's next
 * tick — no redeploy.
 *
 * DB-first: capabilities are loaded from `kaggle_role_capabilities` (m45) at
 * mesh startup. `KAGGLE_CAPABILITY_MATRIX` is the hard code-level fallback for
 * rows not present in DB (e.g. custom roles) or on pre-m45 schemas.
 */

export type KaggleAgentRole =
  | 'discoverer'
  | 'strategist'
  | 'implementer'
  | 'validator'
  | 'submitter'
  | 'observer';

export const KAGGLE_CAPABILITY_MATRIX: Record<KaggleAgentRole, readonly string[]> = {
  discoverer:  ['KAGGLE_LIST_COMPETITIONS', 'KAGGLE_READ_DATASETS'],
  strategist:  ['KAGGLE_LIST_KERNELS', 'KAGGLE_READ_KERNELS'],
  implementer: ['KAGGLE_PUSH_KERNEL', 'KAGGLE_READ_KERNELS'],
  validator:   ['KAGGLE_DOWNLOAD_DATA', 'KAGGLE_LOCAL_COMPUTE'],
  submitter:   ['KAGGLE_SUBMIT'],
  observer:    ['KAGGLE_READ_LEADERBOARD', 'KAGGLE_READ_SUBMISSIONS'],
};

/** Capability constraint string baked into the AccountBinding.constraints field. */
export function bindingConstraintsFor(role: KaggleAgentRole): string {
  const caps = KAGGLE_CAPABILITY_MATRIX[role];
  return `Capabilities: ${caps.join(', ')}. Capability revocation takes effect on next tick.`;
}

/** Resolve the effective capabilities for `role` given an optional override
 *  map (typically the catch-all `*` playbook's `capabilityMatrix` field).
 *  Override REPLACES the historical default for that role; missing roles
 *  fall through to `KAGGLE_CAPABILITY_MATRIX`. */
export function resolveCapabilitiesFor(
  role: KaggleAgentRole,
  overrides?: Partial<Record<KaggleAgentRole, readonly string[]>>,
): readonly string[] {
  const override = overrides?.[role];
  if (override && override.length > 0) return override;
  return KAGGLE_CAPABILITY_MATRIX[role];
}

/** Like `bindingConstraintsFor` but consumes resolved capabilities so the
 *  catch-all playbook can rewrite the constraint prose without touching code. */
export function bindingConstraintsForCaps(caps: readonly string[]): string {
  return `Capabilities: ${caps.join(', ')}. Capability revocation takes effect on next tick.`;
}

/**
 * Load the effective capability matrix from DB (m45 table), merging DB values
 * over the hardcoded defaults. The code constant acts as a safe fallback for
 * roles that have no DB row (custom roles, pre-m45 schemas).
 *
 * Should be called once at Kaggle mesh startup and the result passed to
 * `resolveCapabilitiesFor(role, dbMatrix)` so capability changes take effect
 * without a code deploy.
 */
export async function loadKaggleCapabilityMatrix(
  db: { getKaggleRoleCapabilityMatrix(): Promise<Record<string, string[]>> },
): Promise<Record<KaggleAgentRole, readonly string[]>> {
  try {
    const dbMatrix = await db.getKaggleRoleCapabilityMatrix();
    return {
      ...KAGGLE_CAPABILITY_MATRIX,
      ...dbMatrix,
    } as Record<KaggleAgentRole, readonly string[]>;
  } catch {
    // If the table hasn't been created yet (pre-m45 schema), return code defaults.
    return { ...KAGGLE_CAPABILITY_MATRIX };
  }
}
