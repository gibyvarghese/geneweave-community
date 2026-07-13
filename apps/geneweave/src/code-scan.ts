// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — L2 CODE SCANNER + diff3 merge.
 *
 * Given three source baselines — BASE (what the last release shipped), LOCAL (what's on disk now, carrying any
 * operator edits), and REMOTE (what this release ships) — this classifies every application-code file the same
 * way the realm layer classifies a data record, and (for a genuine both-sides change) runs a line-level diff3
 * merge. The result feeds two things: a read-only `code status` an operator can inspect, and — recorded as L2
 * `upgrade_details` — the SAME review queue the content layer uses, so code changes get keep/defer/bulk with
 * the identical P1 guardrails, no parallel machinery.
 *
 * The classification is hash-only (from the baselines), so it never needs the files' contents and is cheap on a
 * large tree. The diff3 CONTENT merge is a separate, pure function (`mergeCodeFile`) a caller invokes with the
 * three file texts (from git tags or release artifacts) — it produces a clean merge or standard diff3 conflict
 * markers, exactly like a mergetool.
 *
 * Reuses `source-baselines.ts` (the hashing + tree walk) and `node-diff3` (the merge). No shell, no git here.
 */
import { mergeDiff3 } from 'node-diff3';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { generateSourceBaselines, type SourceBaseline } from './source-baselines.js';
import { recordUpgradeDetail } from './upgrade-run-store.js';
import type { UpgradeDisposition } from './upgrade-priority.js';

/** The family every L2 code change is filed under (a non-realm family — no in-app record to `adopt`). */
export const CODE_FAMILY = 'code';

/** How a single file compares across BASE / LOCAL / REMOTE. */
export type CodeFileState =
  | 'unchanged'          // nobody changed it (B=L=R, or no remote and B=L)
  | 'operator_modified'  // you edited it, the release didn't (kept)
  | 'vendor_updated'     // the release changed it, you didn't (taken on deploy)
  | 'identical_edit'     // both made the SAME change (no-op)
  | 'both_changed'       // both changed it differently (a conflict → diff3)
  | 'added'              // the release adds a file you don't have
  | 'removed'            // the release removes a file (you hadn't touched)
  | 'orphaned';          // the release removes a file YOU edited (never auto-deleted)

/** One file's classification. */
export interface CodeFileStatus {
  readonly path: string;
  readonly state: CodeFileState;
  readonly baseSri: string | null;
  readonly localSri: string | null;
  readonly remoteSri: string | null;
}

/** The whole scan report. */
export interface CodeStatusReport {
  readonly files: CodeFileStatus[];
  readonly summary: Record<string, number>;
  /** Paths that need a human — both-changed and orphaned edits. */
  readonly conflicts: string[];
  /** True when a REMOTE baseline was supplied (a full three-way upgrade scan) vs a two-way drift scan. */
  readonly threeWay: boolean;
}

/** Map a file state to the review-queue disposition it records as (drives priority: a conflict is P1). */
const STATE_DISPOSITION: Partial<Record<CodeFileState, UpgradeDisposition>> = {
  operator_modified: 'customized',
  vendor_updated: 'stale',
  both_changed: 'conflict',
  added: 'new',
  removed: 'removed',
  orphaned: 'conflict',
};

/**
 * Classify every file across up to three baselines. Pure (hash comparison only). REMOTE may be null for a
 * two-way "what have I edited since the install baseline" scan.
 * @param base the shipped baseline (path → SRI).
 * @param remote the release's target baseline, or null for a two-way scan.
 * @param local the live tree's baseline (path → SRI).
 * @returns one {@link CodeFileStatus} per path in the union of the three, states resolved.
 */
export function classifyCodeFiles(
  base: Record<string, string>, remote: Record<string, string> | null, local: Record<string, string>,
): CodeFileStatus[] {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(local), ...(remote ? Object.keys(remote) : [])])].sort();
  const out: CodeFileStatus[] = [];
  for (const path of paths) {
    const b = base[path] ?? null;
    const l = local[path] ?? null;
    const r = remote ? (remote[path] ?? null) : null;
    let state: CodeFileState;

    if (!remote) {
      // Two-way: baseline vs live.
      if (b === l) state = 'unchanged';
      else if (b == null) state = 'added';       // present locally, not in the baseline
      else if (l == null) state = 'removed';     // in the baseline, gone locally
      else state = 'operator_modified';
    } else if (r == null) {
      // The release removes this file.
      state = (l != null && l !== b) ? 'orphaned' : 'removed';
    } else if (b == null) {
      // The release adds it (or a two-sided add).
      state = (l == null || l === r) ? 'added' : 'both_changed';
    } else {
      const localChanged = l !== b;
      const remoteChanged = r !== b;
      if (!localChanged && !remoteChanged) state = 'unchanged';
      else if (localChanged && !remoteChanged) state = 'operator_modified';
      else if (!localChanged && remoteChanged) state = 'vendor_updated';
      else state = l === r ? 'identical_edit' : 'both_changed';
    }
    out.push({ path, state, baseSri: b, localSri: l, remoteSri: r });
  }
  return out;
}

/**
 * A read-only `code status`: hash the live tree and classify it against a base (and optionally remote) baseline.
 * @param root the absolute source-tree root to scan.
 * @param base the shipped baseline to compare against.
 * @param remote the release's target baseline for a three-way upgrade scan, or undefined for a two-way scan.
 * @returns the {@link CodeStatusReport}. Side effects: reads files under `root` (no writes).
 */
export function codeStatus(root: string, base: SourceBaseline, remote?: SourceBaseline): CodeStatusReport {
  const live = generateSourceBaselines(root);
  const files = classifyCodeFiles(base.files, remote?.files ?? null, live.files);
  const summary: Record<string, number> = {};
  const conflicts: string[] = [];
  for (const f of files) {
    summary[f.state] = (summary[f.state] ?? 0) + 1;
    if (f.state === 'both_changed' || f.state === 'orphaned') conflicts.push(f.path);
  }
  return { files, summary, conflicts, threeWay: remote != null };
}

/**
 * Record the non-trivial files of a scan as L2 `upgrade_details`, so they join the review queue (keep / defer /
 * bulk, with a both-changed conflict banded P1). `unchanged` / `identical_edit` files are skipped.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param runId the owning upgrade run.
 * @param report a {@link CodeStatusReport}.
 * @returns the number of detail rows written. Side effect: INSERTs into upgrade_details.
 */
export async function recordCodeReview(client: SqlClient, dialect: SqlDialect, runId: string, report: CodeStatusReport): Promise<number> {
  let recorded = 0;
  for (const f of report.files) {
    const disposition = STATE_DISPOSITION[f.state];
    if (!disposition) continue; // unchanged / identical_edit — nothing to review
    await recordUpgradeDetail(client, dialect, runId, {
      family: CODE_FAMILY, logicalKey: f.path, layer: 'L2', disposition,
      baseHash: f.baseSri, localHash: f.localSri, remoteHash: f.remoteSri,
      ...(disposition === 'conflict' ? { priority: 'P1' as const } : {}),
    });
    recorded++;
  }
  return recorded;
}

/** The outcome of a diff3 file merge. */
export interface CodeMergeResult {
  /** True when the three-way merge produced no conflicts. */
  readonly clean: boolean;
  /** The merged text — the resolved content, or content carrying standard diff3 conflict markers. */
  readonly merged: string;
}

/** Split file text into lines for a line-level merge (a trailing newline yields no phantom empty line). */
function toLines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
}

/**
 * Three-way line-level merge of one file — the L2 auto-merge. A file both the operator and the release changed
 * merges cleanly when their edits don't overlap; overlapping edits produce standard `<<<<<<< ||||||| =======
 * >>>>>>>` markers for a human (or a mergetool) to resolve, exactly as git would.
 * @param base the file as the last release shipped it.
 * @param local the file on disk now (operator edits).
 * @param remote the file this release ships.
 * @returns whether the merge was clean and the merged text.
 */
export function mergeCodeFile(base: string, local: string, remote: string): CodeMergeResult {
  // node-diff3.mergeDiff3(mine, original, theirs) — LOCAL is "mine", REMOTE is "theirs". excludeFalseConflicts
  // collapses regions where both sides made the identical change.
  const r = mergeDiff3(toLines(local), toLines(base), toLines(remote), { excludeFalseConflicts: true, stringSeparator: '\n' }) as { conflict: boolean; result: string[] };
  return { clean: !r.conflict, merged: r.result.join('\n') };
}
