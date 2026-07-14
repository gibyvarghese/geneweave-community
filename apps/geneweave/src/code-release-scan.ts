// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — L2 RELEASE-AWARE code scan (the piece that produces real `both_changed` conflicts).
 *
 * `code-scan.ts` classifies a file `both_changed` (a conflict needing a merge) only when it has all three sides:
 * BASE (what shipped), LOCAL (the live tree), and REMOTE (what the release ships). The stored-baseline scan
 * (`runCodeScan`) has BASE + LOCAL but no REMOTE, so it can only ever report operator edits — never a conflict.
 * This module supplies REMOTE (and BASE) from git, the way the Community edition's design specifies (BASE =
 * installed tag, REMOTE = target tag), so an upgrade's genuine code conflicts land in the review queue with
 * content the in-app merge editor (and the git branch) can actually resolve.
 *
 * `baselineAtRef` hashes a whole git ref's tree in one `git cat-file --batch` pass (not one `git show` per
 * file), applying the SAME ignore + provenance-stripping rules as the live-tree baseliner so the three sides are
 * directly comparable. `scanCodeAgainstRelease` then reuses the pure `codeStatus` classifier + the shared
 * `persistCodeReport` writer — no parallel classification or run bookkeeping.
 *
 * Engine-agnostic over the `SqlClient` seam; git reads pass every ref/path as argv (never a shell string).
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { isGitRepo, refExists, listTreeFilesAtRef, readFilesAtRef } from './code-git.js';
import { sriForContent, baselineDigest, isIgnoredPath, type SourceBaseline } from './source-baselines.js';
import { codeStatus, type CodeStatusReport } from './code-scan.js';
import { persistCodeReport, type CodeScanOutcome } from './code-baseline-store.js';

/**
 * Compute the {@link SourceBaseline} of a git ref's tree — the path → SRI map + digest, filtered + hashed
 * IDENTICALLY to the live-tree baseliner (same ignore set, same provenance stripping, same sha512), so it can
 * be diffed against a live baseline without spurious differences.
 * @param repoRoot the git work tree.
 * @param ref the git ref (tag / branch / commit) whose tree to baseline.
 * @param algorithm hash algorithm (default sha512, matching generateSourceBaselines).
 * @returns the ref's source baseline. Side effects: git reads only (no writes).
 */
export function baselineAtRef(repoRoot: string, ref: string, algorithm: 'sha256' | 'sha512' = 'sha512'): SourceBaseline {
  const paths = listTreeFilesAtRef(repoRoot, ref).filter((p) => !isIgnoredPath(p));
  const contents = readFilesAtRef(repoRoot, ref, paths);
  const files: Record<string, string> = {};
  for (const [path, content] of contents) files[path] = sriForContent(content, algorithm);
  return { files, digest: baselineDigest(files, algorithm) };
}

/**
 * Run a THREE-WAY code scan against a release's git refs and record the changes (including real conflicts) as
 * L2 review items. BASE and REMOTE are hashed from `baseRef` / `remoteRef`; LOCAL is the live tree (hashed
 * inside `codeStatus`). A file changed on both sides differently becomes a `both_changed` conflict (P1) the
 * operator resolves in the merge editor.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param root the source/git work-tree root.
 * @param baseRef the installed release git ref (BASE).
 * @param remoteRef the target release git ref (REMOTE).
 * @param at optional timestamp override (tests).
 * @returns the scan outcome (run id + recorded count + report), or `{ status: 'git_required' }` when `root`
 *   isn't a git work tree or a ref doesn't resolve (the caller then falls back to the git-branch mechanism).
 * @sideEffect one upgrade_runs row + one upgrade_details per non-trivial file.
 */
export async function scanCodeAgainstRelease(
  client: SqlClient, dialect: SqlDialect, root: string, baseRef: string, remoteRef: string, at?: string,
): Promise<CodeScanOutcome | { status: 'git_required'; reason: string }> {
  if (!isGitRepo(root)) return { status: 'git_required', reason: 'not a git work tree' };
  if (!refExists(root, baseRef)) return { status: 'git_required', reason: `base ref '${baseRef}' not found` };
  if (!refExists(root, remoteRef)) return { status: 'git_required', reason: `target ref '${remoteRef}' not found` };
  const base = baselineAtRef(root, baseRef);
  const remote = baselineAtRef(root, remoteRef);
  const report: CodeStatusReport = codeStatus(root, base, remote);
  const { runId, recorded } = await persistCodeReport(client, dialect, report, at);
  return { status: 'ok', runId, recorded, report };
}
