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
 * Whether a ref (tag / branch / commit) resolves in the repo — so a caller can verify BASE/REMOTE refs exist
 * before trying to read file content at them (a missing ref would otherwise silently produce empty content and
 * a garbage merge).
 * @param repoRoot the git work tree.
 * @param ref the ref to verify.
 * @returns true iff `git rev-parse --verify <ref>^{commit}` succeeds.
 */
export function refExists(repoRoot: string, ref: string): boolean {
  try { git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; }
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
 * List every file path present in a git ref's tree — `git ls-tree -r --name-only <ref>`. Used to enumerate the
 * files a release ships (at its tag) so their content can be hashed into a baseline. The ref is one argv
 * element (never shell-interpolated).
 * @param repoRoot the git work tree.
 * @param ref the git ref whose tree to list.
 * @returns the repo-relative paths at that ref (POSIX-style, as git emits them). Empty if the ref has no tree.
 */
export function listTreeFilesAtRef(repoRoot: string, ref: string): string[] {
  const out = git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', ref]);
  // -z gives NUL-separated paths (safe for paths with spaces/newlines); split + drop the trailing empty.
  return out.length === 0 ? [] : out.split('\0').filter((p) => p.length > 0);
}

/**
 * Read many files' content at a ref in ONE `git cat-file --batch` subprocess (instead of one `git show` per
 * file), so hashing a whole release tree is fast. Returns a Map of path → content; a path absent at the ref is
 * simply omitted. Binary/oversized blobs are returned as their raw UTF-8 decode (the baseliner skips anything
 * that isn't editable source anyway).
 * @param repoRoot the git work tree.
 * @param ref the git ref.
 * @param paths the repo-relative paths to read.
 * @returns a Map of path → UTF-8 content for the paths that exist at the ref.
 */
export function readFilesAtRef(repoRoot: string, ref: string, paths: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;
  // Feed `<ref>:<path>\n` per file on stdin; git streams `<oid> blob <size>\n<content>\n` (or `… missing\n`).
  const input = paths.map((p) => `${ref}:${p}`).join('\n') + '\n';
  const buf = execFileSync('git', ['-C', repoRoot, 'cat-file', '--batch'], { input, maxBuffer: 512 * 1024 * 1024 });
  let off = 0;
  for (const path of paths) {
    // Read one header line up to '\n'.
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) break;
    const header = buf.toString('utf8', off, nl);
    off = nl + 1;
    const parts = header.split(' ');
    if (parts[1] === 'missing' || parts[1] !== 'blob') {
      // `<name> missing` has no body; a non-blob (unlikely for a file path) also has no body to consume here.
      continue;
    }
    const size = Number(parts[2]);
    const content = buf.toString('utf8', off, off + size);
    off += size + 1; // skip the blob content + the trailing newline git appends
    result.set(path, content);
  }
  return result;
}

/**
 * Read a file's content at an arbitrary git ref (tag / branch / commit) — `git show <ref>:<path>`. The ref and
 * path are passed as a single argv element to `git show`, never shell-interpolated, so neither can inject.
 * @param repoRoot the git work tree.
 * @param ref the git ref (a tag like `v1.2.3`, a branch, or a commit sha).
 * @param path the repo-relative file path.
 * @returns the file content at that ref. Throws if the ref or path doesn't exist there (use
 *   {@link readFileAtRefOrNull} when "absent" is a valid, expected answer — e.g. a file only one side has).
 */
export function readFileAtRef(repoRoot: string, ref: string, path: string): string {
  return execFileSync('git', ['-C', repoRoot, 'show', `${ref}:${path}`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * Read a file at a ref, returning null when the file does NOT exist at that ref (rather than throwing). This is
 * the correct read for the BASE/REMOTE sides of a merge: a newly-added file has no BASE, a deleted file has no
 * REMOTE, and "absent" must be represented as empty content, not an error.
 * @param repoRoot the git work tree.
 * @param ref the git ref.
 * @param path the repo-relative file path.
 * @returns the content, or null if the path doesn't exist at that ref.
 */
export function readFileAtRefOrNull(repoRoot: string, ref: string, path: string): string | null {
  try {
    return readFileAtRef(repoRoot, ref, path);
  } catch {
    return null; // path absent at this ref (added on one side / deleted on the other) — a valid merge input
  }
}

/**
 * Import a file's RESOLVED content from the upgrade branch (after the operator resolved the conflicts on it).
 * A branch is just a ref, so this is {@link readFileAtRef} named for its call site.
 * @param repoRoot the git work tree.
 * @param branch the upgrade branch name.
 * @param path the repo-relative file path.
 * @returns the file content on that branch. Throws if the ref/path doesn't exist.
 */
export function readUpgradeBranchFile(repoRoot: string, branch: string, path: string): string {
  return readFileAtRef(repoRoot, branch, path);
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
