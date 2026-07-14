// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — L2 in-app code-conflict merge (the data behind the `@codemirror/merge` view).
 *
 * The L2 review queue records a `both_changed` code file as a `family='code'`, `disposition='conflict'`
 * upgrade_details row (P1) — keyed only by path + the three SRI hashes. To let an operator resolve that conflict
 * IN the Upgrade Center (instead of only on the `upgrade/v<target>` git branch), the merge view needs the three
 * *text* sides. The L2 layer is hash-only, so the sides are sourced the way the Community edition's design
 * specifies — **git-first**:
 *
 *   • LOCAL  — the working-tree file on disk (the operator's current edits);
 *   • BASE   — the file at the installed release ref (`git show <baseRef>:<path>`);
 *   • REMOTE — the file at the target release ref (`git show <remoteRef>:<path>`).
 *
 * From those, {@link mergeCodeFile} produces the base-informed diff3 pre-merge the operator resolves. A resolved
 * file is written back to the working tree and its review row is marked resolved. On a non-git install (BASE/
 * REMOTE aren't recoverable) the caller degrades gracefully to the git-branch mechanism — this module reports
 * that rather than guessing.
 *
 * Security: every git read passes the ref+path as one argv element (never a shell string); the write path is
 * confined to the source root (a `..`/absolute path escaping the root is refused); a resolution that still
 * carries conflict markers is rejected so it can never silently clear the L3-blocking gate.
 *
 * Engine-agnostic over the `SqlClient` / `SqlDialect` seam; all SQL is parameterized (via the shared store).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { isGitRepo, refExists, readFileAtRefOrNull } from './code-git.js';
import { mergeCodeFile, hasConflictMarkers, CODE_FAMILY } from './code-scan.js';
import { listUnresolvedUpgradeDetails, resolveUpgradeDetail } from './upgrade-run-store.js';
import { latestAcceptedManifest } from './upgrade-release-store.js';
import { getAppVersion } from './upgrade-check.js';

/** One unresolved L2 code conflict awaiting a merge decision. */
export interface CodeConflictItem {
  /** The upgrade_details row id (what a resolve targets). */
  readonly detailId: string;
  /** The repo-relative file path (the detail's logical_key). */
  readonly path: string;
  readonly priority: string;
}

/** The three text sides of a conflicted file plus the base-informed pre-merge. */
export interface CodeConflictContent {
  readonly path: string;
  /** BASE — the file at the installed ref (empty string if the file didn't exist there, i.e. newly added). */
  readonly base: string;
  /** LOCAL — the working-tree file (empty string if the operator deleted it). */
  readonly local: string;
  /** REMOTE — the file at the target ref (empty string if the release removed it). */
  readonly remote: string;
  /** The diff3 auto-merge of (base, local, remote): clean hunks applied, conflicts carrying diff3 markers. */
  readonly merged: string;
  /** True when the three-way merge is already clean (no markers) — an easy accept. */
  readonly clean: boolean;
}

/** Why a conflict couldn't be loaded in-app (the caller degrades to the git-branch mechanism). */
export type CodeConflictUnavailable = { readonly status: 'git_required'; readonly reason: string };

/** The outcome of applying a resolution. */
export interface ResolveCodeConflictResult {
  readonly ok: boolean;
  readonly path: string;
  /** Present on refusal: 'unresolved_markers' (still conflicted) or 'path_escapes_root' (traversal attempt). */
  readonly reason?: 'unresolved_markers' | 'path_escapes_root' | 'item_not_found';
}

/**
 * Resolve a repo-relative path to an absolute path CONFINED to `root`. A path that escapes the root (via `..`
 * or an absolute path) returns null — the caller must refuse it. Symlinks are not followed for the escape
 * check; the confinement is purely lexical on the resolved path, which is sufficient to keep a write inside the
 * tree we own.
 * @param root the source-tree root.
 * @param relPath the repo-relative path from the review row.
 * @returns the confined absolute path, or null if it escapes `root`.
 */
function confinedPath(root: string, relPath: string): string | null {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  return abs;
}

/**
 * The unresolved L2 code conflicts (family='code', disposition='conflict') — the merge view's work list.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the conflicts (path + detail id + priority). Read-only.
 */
export async function listCodeConflicts(client: SqlClient, dialect: SqlDialect): Promise<CodeConflictItem[]> {
  const rows = await listUnresolvedUpgradeDetails(client, dialect, { family: CODE_FAMILY });
  return rows
    .filter((r) => r.disposition === 'conflict')
    .map((r) => ({ detailId: r.id, path: r.logical_key, priority: r.priority }));
}

/**
 * Assemble the three text sides + the base-informed pre-merge for one conflicted file, sourcing BASE/REMOTE
 * from git. Returns `{ status: 'git_required' }` when the tree isn't a git work tree (BASE/REMOTE can't be
 * recovered in-app → resolve on the `upgrade/v<target>` branch instead).
 * @param root the source/git work-tree root (also the base of `path`).
 * @param path the repo-relative file path.
 * @param baseRef the installed release git ref (tag/commit).
 * @param remoteRef the target release git ref (tag/commit).
 * @returns the conflict content, or a `git_required` marker. Read-only.
 */
export function loadCodeConflict(
  root: string, path: string, baseRef: string, remoteRef: string,
): CodeConflictContent | CodeConflictUnavailable {
  if (!isGitRepo(root)) return { status: 'git_required', reason: 'not a git work tree — resolve on the upgrade branch' };
  const abs = confinedPath(root, path);
  if (!abs) return { status: 'git_required', reason: 'path escapes the source root' };

  // LOCAL from disk (absent = the operator deleted it → empty). BASE/REMOTE from git (absent one side = added/
  // removed → empty). readFileAtRefOrNull turns "path absent at ref" into null rather than throwing.
  let local = '';
  try { local = readFileSync(abs, 'utf8'); } catch { local = ''; }
  const base = readFileAtRefOrNull(root, baseRef, path) ?? '';
  const remote = readFileAtRefOrNull(root, remoteRef, path) ?? '';
  const merge = mergeCodeFile(base, local, remote);
  return { path, base, local, remote, merged: merge.merged, clean: merge.clean };
}

/**
 * Resolve the BASE (installed) and REMOTE (target) git refs the merge needs, from the latest accepted release
 * and the environment. REMOTE = the target manifest's `layers.code.repoTag`; BASE = `GENEWEAVE_SOURCE_BASE_REF`
 * or the installed version tag `v<installedVersion>`. Both are verified to resolve in the repo.
 * @param client the SqlClient (to read the accepted target manifest).
 * @param dialect 'sqlite' | 'postgres'.
 * @param root the git work-tree root.
 * @param opts.env environment (defaults to process.env; injectable for tests); opts.remoteRef/baseRef overrides.
 * @returns the two refs, or a `git_required` marker explaining why the in-app path is unavailable.
 */
async function resolveMergeRefs(
  client: SqlClient, dialect: SqlDialect, root: string,
  opts: { env?: NodeJS.ProcessEnv; baseRef?: string; remoteRef?: string } = {},
): Promise<{ baseRef: string; remoteRef: string } | CodeConflictUnavailable> {
  if (!isGitRepo(root)) return { status: 'git_required', reason: 'not a git work tree — resolve on the upgrade branch' };
  const env = opts.env ?? process.env;
  const target = await latestAcceptedManifest(client, dialect);
  const remoteRef = opts.remoteRef ?? target?.manifest.layers.code?.repoTag;
  const baseRef = opts.baseRef ?? env['GENEWEAVE_SOURCE_BASE_REF'] ?? `v${getAppVersion()}`;
  if (!remoteRef) return { status: 'git_required', reason: 'no accepted release with a code tag — resolve on the upgrade branch' };
  if (!refExists(root, remoteRef)) return { status: 'git_required', reason: `target ref '${remoteRef}' not found in the repo` };
  if (!refExists(root, baseRef)) return { status: 'git_required', reason: `base ref '${baseRef}' not found (set GENEWEAVE_SOURCE_BASE_REF)` };
  return { baseRef, remoteRef };
}

/**
 * The Upgrade-Center entry point: assemble a conflicted file's merge content, sourcing the git refs from the
 * accepted release + environment. A thin orchestration over {@link resolveMergeRefs} + {@link loadCodeConflict}
 * so the DB adapters stay one-liners and the ref logic lives (and is tested) in one place.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param root the source/git work-tree root.
 * @param path the repo-relative file path.
 * @param opts ref/env overrides (tests).
 * @returns the conflict content, or a `git_required` marker. Read-only.
 */
export async function getCodeConflictContent(
  client: SqlClient, dialect: SqlDialect, root: string, path: string,
  opts: { env?: NodeJS.ProcessEnv; baseRef?: string; remoteRef?: string } = {},
): Promise<CodeConflictContent | CodeConflictUnavailable> {
  const refs = await resolveMergeRefs(client, dialect, root, opts);
  if ('status' in refs) return refs;
  return loadCodeConflict(root, path, refs.baseRef, refs.remoteRef);
}

/**
 * Apply an operator's resolved content for a conflicted file: refuse it if it still carries conflict markers,
 * write it to the working tree (confined to `root`), and mark the review row resolved ('merged'). This is the
 * in-app equivalent of resolving on the git branch and importing — it never clears the L3 gate for a file that
 * is still conflicted.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param root the source/git work-tree root.
 * @param detailId the upgrade_details row id for the conflict.
 * @param path the repo-relative file path (validated against traversal).
 * @param resolvedContent the operator's resolved file text.
 * @param opts.resolvedBy audit actor; opts.at timestamp override (tests).
 * @returns {@link ResolveCodeConflictResult}. Side effects: writes the file; marks the detail resolved.
 */
export async function resolveCodeConflict(
  client: SqlClient, dialect: SqlDialect, root: string, detailId: string, path: string, resolvedContent: string,
  opts: { resolvedBy?: string | null; at?: string } = {},
): Promise<ResolveCodeConflictResult> {
  if (hasConflictMarkers(resolvedContent)) return { ok: false, path, reason: 'unresolved_markers' };
  const abs = confinedPath(root, path);
  if (!abs) return { ok: false, path, reason: 'path_escapes_root' };

  // Write the resolution to the working tree (creating parent dirs if the file is new), then mark the review
  // row resolved. Order matters: only mark resolved after the write succeeds.
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, resolvedContent, 'utf8');
  await resolveUpgradeDetail(client, dialect, detailId, { resolution: 'merged', resolvedBy: opts.resolvedBy ?? null, ...(opts.at ? { at: opts.at } : {}) });
  return { ok: true, path };
}
