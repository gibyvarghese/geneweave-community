// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — L2 git round-trip (`code checkout` / `code import`).
 *
 * The Community edition's non-UI resolution path. When an upgrade leaves code conflicts, the engine writes the
 * conflict-marked files (standard `<<<<<<< ======= >>>>>>>` diff3 markers, from `mergeCodeFile`) onto a fresh
 * `upgrade/v<target>` git branch. The operator resolves them in ANY editor, mergetool, or PR — nothing
 * geneweave-specific — then the engine imports the resolved content back. This is the "resolvable anywhere"
 * mechanism the design calls for; the in-app editor is only a convenience on top of the same branch.
 *
 * Git is invoked via `execFileSync` with every argument as a distinct argv element (never shell-interpolated),
 * so a hostile path or branch name cannot inject a command. Commits set an explicit identity so the write
 * works on a CI runner with no global git config.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** One file to write onto the upgrade branch (conflict-marked or clean-merged content). */
export interface BranchFile {
  /** Repo-relative path. */
  readonly path: string;
  /** The content to write (typically diff3-conflict-marked). */
  readonly content: string;
}

/** The result of writing an upgrade branch. */
export interface UpgradeBranchResult {
  readonly branch: string;
  readonly paths: string[];
  /** The commit sha the conflict-marked files were committed at. */
  readonly sha: string;
}

/** Run a git command in a repo, returning trimmed stdout. Throws on non-zero exit. */
function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

/**
 * Is git available and is `repoRoot` inside a work tree?
 * @param repoRoot the directory to check.
 * @returns true iff `git` runs and `repoRoot` is a git work tree.
 */
export function isGitRepo(repoRoot: string): boolean {
  try { return git(repoRoot, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}

/**
 * Write conflict-marked (or merged) files onto a fresh `upgrade/v<target>` branch and commit them, so an
 * operator can resolve them in any editor/mergetool.
 * @param repoRoot the git work tree.
 * @param targetVersion the release version, used to name the branch `upgrade/v<targetVersion>`.
 * @param files the files to write (path + content).
 * @returns the branch name, the paths written, and the commit sha. Side effects: creates/resets the branch,
 *   writes the files, and commits. Throws if `repoRoot` is not a git repo.
 */
export function writeUpgradeBranch(repoRoot: string, targetVersion: string, files: BranchFile[]): UpgradeBranchResult {
  if (!isGitRepo(repoRoot)) throw new Error('not a git repository');
  const branch = `upgrade/v${targetVersion}`;
  // -B resets the branch if it already exists (a re-run of the same upgrade), based on the current HEAD.
  git(repoRoot, ['checkout', '-B', branch]);
  const paths: string[] = [];
  for (const f of files) {
    const abs = join(repoRoot, ...f.path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
    git(repoRoot, ['add', '--', f.path]);
    paths.push(f.path);
  }
  // Explicit identity so the commit works with no global git config (CI).
  git(repoRoot, ['-c', 'user.email=upgrade@geneweave.local', '-c', 'user.name=geneWeave Upgrade', 'commit', '-m', `L2 code conflicts for v${targetVersion} — resolve and import`]);
  const sha = git(repoRoot, ['rev-parse', 'HEAD']);
  return { branch, paths, sha };
}

/**
 * Import a file's RESOLVED content from the upgrade branch (after the operator resolved the conflicts on it).
 * @param repoRoot the git work tree.
 * @param branch the upgrade branch name.
 * @param path the repo-relative file path.
 * @returns the file content on that branch. Throws if the ref/path doesn't exist.
 */
export function readUpgradeBranchFile(repoRoot: string, branch: string, path: string): string {
  return execFileSync('git', ['-C', repoRoot, 'show', `${branch}:${path}`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * Whether a file on the upgrade branch still carries unresolved diff3 conflict markers — the gate the design
 * requires (unresolved vendor conflicts block L3).
 * @param repoRoot the git work tree.
 * @param branch the upgrade branch name.
 * @param path the repo-relative file path.
 * @returns true iff the file still contains `<<<<<<<` / `>>>>>>>` markers.
 */
export function branchFileHasConflictMarkers(repoRoot: string, branch: string, path: string): boolean {
  const content = readUpgradeBranchFile(repoRoot, branch, path);
  return content.includes('<<<<<<<') && content.includes('>>>>>>>');
}
