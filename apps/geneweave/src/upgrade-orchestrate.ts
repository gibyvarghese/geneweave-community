// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — one-click UPGRADE orchestration helpers.
 *
 * The individual steps already exist (check, preflight, code scan, apply). This module holds the small pieces of
 * PURE logic that turn them into a single operator action with an honest outcome:
 *   • `computeBumpType` — is this a patch, a minor, or a major move? (semver), so the UI can signal risk;
 *   • `describeUpgradeOutcome` — shape an `ApplyResult` into a plain-language result the operator can act on,
 *     making the running-server reality explicit: config/data is applied live, but code changes land on the
 *     next deploy, and any file the operator edited that the release also changed must be merged first.
 *
 * The route composes these with the existing adapter methods (preflight → derive the code-conflict gate from the
 * recorded conflicts → apply); keeping the decision logic here makes it unit-testable without a live apply.
 */
import { diff as semverDiff, valid as semverValid, gt as semverGt } from 'semver';
import type { ApplyResult, EditionL2Mode } from './upgrade-apply.js';

/** How big a move this upgrade is. `none` = same version; `downgrade` = target older (blocked upstream). */
export type BumpType = 'patch' | 'minor' | 'major' | 'prerelease' | 'none' | 'downgrade' | 'unknown';

/**
 * Classify the version move from `from` to `to` by semver.
 * @param from the deployed version.
 * @param to the target release version.
 * @returns the bump type. `unknown` for unparseable input; `none` when equal; `downgrade` when `to` < `from`.
 */
export function computeBumpType(from: string, to: string): BumpType {
  if (!semverValid(from) || !semverValid(to)) return 'unknown';
  if (from === to) return 'none';
  if (semverGt(from, to)) return 'downgrade';
  const d = semverDiff(from, to);
  if (d === 'major' || d === 'premajor') return 'major';
  if (d === 'minor' || d === 'preminor') return 'minor';
  if (d === 'patch' || d === 'prepatch') return 'patch';
  if (d === 'prerelease') return 'prerelease';
  return 'unknown';
}

/** A plain-language upgrade outcome the UI renders (and the route returns). */
export interface UpgradeOutcome {
  /** The apply status, echoed for the UI to branch on. */
  readonly status: ApplyResult['status'];
  /** One-line headline, e.g. "Upgraded to v1.5.0 (patch)". */
  readonly headline: string;
  /** The follow-up the operator must do, or '' when nothing is pending. */
  readonly detail: string;
  /** How many review items (code conflicts + divergent data) still need a decision. */
  readonly pending: number;
  /** True when code changed and the instance must be redeployed to run it. */
  readonly needsDeploy: boolean;
}

/**
 * Shape an apply result into an operator-facing outcome.
 * @param result the ApplyResult from `applyUpgrade`.
 * @param opts.bumpType the semver bump (for the headline).
 * @param opts.toVersion the target release version (ApplyResult carries no version; the caller supplies it).
 * @param opts.l2mode the edition's L2 mode ('merge' = community per-file; 'locked' = enterprise whole-tree swap).
 * @param opts.codeConflicts how many code files are in conflict (unresolved), for the merge follow-up message.
 * @returns the outcome. Pure — no I/O.
 */
export function describeUpgradeOutcome(
  result: ApplyResult,
  opts: { bumpType: BumpType; toVersion: string; l2mode: EditionL2Mode; codeConflicts: number },
): UpgradeOutcome {
  const { bumpType, l2mode, codeConflicts } = opts;
  const to = opts.toVersion || '?';
  const pending = result.pending ?? 0;
  const codeChanged = (result.schema?.deferred?.length ?? 0) > 0 || codeConflicts > 0;

  if (result.status === 'busy') {
    return { status: result.status, headline: 'Another upgrade is already running', detail: 'Wait for it to finish, then try again.', pending, needsDeploy: false };
  }
  if (result.status === 'preflight_failed') {
    return { status: result.status, headline: 'Upgrade blocked by preflight', detail: 'Resolve the failing checks (or force) and try again.', pending, needsDeploy: false };
  }
  if (result.status === 'rolled_back') {
    return { status: result.status, headline: 'Upgrade failed and was rolled back', detail: 'The database was restored to its pre-upgrade snapshot. No changes were kept.', pending, needsDeploy: false };
  }

  const bumpLabel = bumpType === 'none' ? '' : ` (${bumpType})`;
  const adopted = result.content?.adopted ?? 0;
  const adoptedNote = adopted > 0 ? `${adopted} un-customized item${adopted === 1 ? '' : 's'} auto-updated. ` : '';

  if (result.status === 'succeeded_with_pending') {
    // Community merge path: some files/data need a human decision before the upgrade is complete.
    const mergeNote = l2mode === 'locked'
      ? `${pending} item${pending === 1 ? '' : 's'} need review.`
      : (codeConflicts > 0
          ? `${codeConflicts} code file${codeConflicts === 1 ? '' : 's'} you changed also changed upstream — merge them, then redeploy to finish.`
          : `${pending} item${pending === 1 ? '' : 's'} need review.`);
    return {
      status: result.status,
      headline: `Config updated toward v${to}${bumpLabel}`,
      detail: `${adoptedNote}${mergeNote}`,
      pending,
      needsDeploy: codeChanged,
    };
  }

  // succeeded — nothing pending.
  return {
    status: result.status,
    headline: `Upgraded to v${to}${bumpLabel}`,
    detail: `${adoptedNote}${codeChanged ? 'Redeploy the instance to run the new code.' : 'No code changes — nothing to deploy.'}`.trim(),
    pending,
    needsDeploy: codeChanged,
  };
}
