// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — L2 PRIVATE-edition patch-file lifecycle.
 *
 * The Community edition merges upstream source per-file. The Private (locked) edition doesn't: the vendor tree
 * is swapped wholesale on upgrade, and an operator's customizations live as *sanctioned patch files* that are
 * REAPPLIED on top of the freshly-swapped tree. A patch here is simply the operator's edited version of a file
 * together with the vendor baseline it was edited against — reapplying it is the same three-way merge the rest
 * of L2 uses: (baseline, operator-edited, new-vendor). A patch that no longer applies cleanly (the vendor
 * changed the same lines) is a genuine conflict that must enter the review queue — it is NEVER silently
 * dropped, and the operator's edit is NEVER silently lost.
 *
 * This deliberately does NOT use `node-diff3`'s `patch()`, which blindly re-applies a hunk even when its
 * context changed (silently clobbering the vendor's edit). It reuses `mergeCodeFile` (a real three-way merge),
 * so a conflict is detected, not guessed. Conflicts are recorded as L2 `upgrade_details`, joining the same
 * review queue as every other change.
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { mergeCodeFile } from './code-scan.js';
import { recordUpgradeDetail } from './upgrade-run-store.js';
import { CODE_FAMILY } from './code-scan.js';

/** One operator patch: the file's vendor baseline and the operator's edited version. */
export interface OperatorPatch {
  /** Repo-relative file path. */
  readonly path: string;
  /** The vendor file the operator edited against (BASE). */
  readonly baseline: string;
  /** The operator's edited content (LOCAL). */
  readonly edited: string;
}

/** The outcome of reapplying one patch onto a new vendor file. */
export interface PatchReapplyResult {
  readonly path: string;
  /** True when the operator's edit reapplied without conflict. */
  readonly clean: boolean;
  /** The merged content — the reapplied file, or content carrying diff3 conflict markers. */
  readonly merged: string;
}

/**
 * Reapply one operator patch onto the new (swapped-in) vendor file — a three-way merge of (baseline, edited,
 * newVendor). A clean merge is the reapplied customization; a conflict carries standard diff3 markers.
 * @param patch the operator's baseline + edited content.
 * @param newVendor the new vendor version of the file (REMOTE), or null if the vendor deleted it.
 * @returns whether it reapplied cleanly and the merged content. A vendor deletion of a file the operator
 *   edited is a conflict (the edit is surfaced, never lost).
 */
export function reapplyPatch(patch: OperatorPatch, newVendor: string | null): PatchReapplyResult {
  if (newVendor === null) {
    // The vendor removed a file the operator customised — surface the operator's version for a decision.
    return { path: patch.path, clean: false, merged: patch.edited };
  }
  const { clean, merged } = mergeCodeFile(patch.baseline, patch.edited, newVendor);
  return { path: patch.path, clean, merged };
}

/** The result of reapplying a whole patch set. */
export interface PatchSetResult {
  readonly results: PatchReapplyResult[];
  readonly cleanCount: number;
  readonly conflicts: string[];
}

/**
 * Reapply a set of operator patches onto their new vendor files.
 * @param patches the operator patches.
 * @param newVendorFor a lookup from path → the new vendor content (null when the vendor deleted the file).
 * @returns per-patch results + the conflict paths. Pure.
 */
export function reapplyPatchSet(patches: OperatorPatch[], newVendorFor: (path: string) => string | null): PatchSetResult {
  const results = patches.map((p) => reapplyPatch(p, newVendorFor(p.path)));
  const conflicts = results.filter((r) => !r.clean).map((r) => r.path);
  return { results, cleanCount: results.length - conflicts.length, conflicts };
}

/**
 * Record the CONFLICTING patches of a reapply as L2 review items (family `code`, disposition `conflict` → P1),
 * so a locked-edition patch that no longer applies enters the same review queue as everything else. Clean
 * reapplications record nothing (they just apply).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param runId the owning upgrade run.
 * @param result a {@link PatchSetResult}.
 * @returns the number of conflict rows written. Side effect: INSERTs into upgrade_details.
 */
export async function recordPatchConflicts(client: SqlClient, dialect: SqlDialect, runId: string, result: PatchSetResult): Promise<number> {
  let recorded = 0;
  for (const r of result.results) {
    if (r.clean) continue;
    await recordUpgradeDetail(client, dialect, runId, {
      family: CODE_FAMILY, logicalKey: r.path, layer: 'L2', disposition: 'conflict', priority: 'P1',
      note: 'a sanctioned patch no longer applies cleanly after the tree swap',
    });
    recorded++;
  }
  return recorded;
}
