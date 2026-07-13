// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — L2 SOURCE BASELINES: the per-file identity of an application-code tree.
 *
 * The upgrade engine's L2 layer tracks whether an operator edited a vendor source file and whether a release
 * changed it — the same three-way question the realm layer answers for data records, but for code. Git gives
 * that identity for free; for a non-git install we compute it ourselves: a `source_baselines` manifest is a
 * map of relative path → SRI hash of the file's content, plus a single digest over the whole manifest (the
 * `fileManifestDigest` a release manifest carries). Comparing two baselines (what shipped vs what's on disk)
 * classifies every file.
 *
 * Two details make the hash TRUSTWORTHY:
 *   • an optional first-line PROVENANCE PRAGMA (`// @geneweave-provenance …`) is stripped before hashing, so
 *     stamping a file with where it came from never registers as an operator edit;
 *   • a fixed ignore list (node_modules, dist, .git, VCS/junk) keeps the manifest to source the operator could
 *     actually have edited, and bounds the walk.
 *
 * Pure Node built-ins + `ssri` (already a dependency). No shell, no git. Every path is resolved and confined
 * under the tree root (a manifest entry can never escape it), so a hostile manifest can't read outside the
 * scan root.
 */
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import ssri from 'ssri';

/** A source baseline: relative path → SRI integrity string, plus a digest over the whole (ordered) manifest. */
export interface SourceBaseline {
  /** Relative POSIX-style path → SRI (e.g. `sha512-…`). */
  readonly files: Record<string, string>;
  /** SRI over the canonical `path\tsri\n…` serialization — the release manifest's `fileManifestDigest`. */
  readonly digest: string;
}

/** Directory / file names never walked or hashed (not operator-editable source). */
const IGNORE = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', '.next', 'build', '.DS_Store', 'test-results', 'playwright-report']);
/** The provenance-pragma marker: a first line containing this is excluded from the content hash. */
const PROVENANCE_MARK = '@geneweave-provenance';
/** Hard cap on files walked, so a pathological tree degrades to an error rather than hanging. */
const MAX_FILES = 200_000;

/** Options for baseline generation. */
export interface BaselineOptions {
  /** Only include files whose relative path matches (default: all non-ignored). */
  readonly include?: (relPath: string) => boolean;
  /** Hash algorithm (default sha512). */
  readonly algorithm?: 'sha256' | 'sha512';
}

/**
 * Strip a leading provenance-pragma line from file content before hashing, so a stamped file hashes identically
 * to its unstamped form. Only the FIRST line is considered, and only when it carries the marker.
 * @param content the raw file text.
 * @returns the content with a leading provenance line removed (if present).
 */
export function stripProvenance(content: string): string {
  const nl = content.indexOf('\n');
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  if (firstLine.includes(PROVENANCE_MARK)) return nl === -1 ? '' : content.slice(nl + 1);
  return content;
}

/**
 * The SRI integrity string for a file's semantic content (provenance pragma excluded).
 * @param content the raw file text.
 * @param algorithm the hash algorithm (default sha512).
 * @returns an SRI string like `sha512-…`.
 */
export function sriForContent(content: string, algorithm: 'sha256' | 'sha512' = 'sha512'): string {
  return ssri.fromData(Buffer.from(stripProvenance(content), 'utf8'), { algorithms: [algorithm] }).toString();
}

/**
 * Recursively list the relative paths of every non-ignored file under `root`, confined to the root.
 * @param root the absolute tree root.
 * @param include optional path filter.
 * @returns relative POSIX-style paths (sorted for a stable manifest). Throws if the tree exceeds MAX_FILES.
 */
export function listSourceFiles(root: string, include?: (relPath: string) => boolean): string[] {
  const absRoot = resolve(root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (IGNORE.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; } // vanished mid-walk — skip
      // Confinement: never FOLLOW a symlink (its target may be outside the root) — the single escape vector for
      // a tree walk. Defense in depth: also refuse any path that resolves outside the root.
      if (st.isSymbolicLink()) continue;
      if (!resolve(abs).startsWith(absRoot + sep)) continue;
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isFile()) continue;
      const rel = relative(absRoot, abs).split(sep).join('/');
      if (include && !include(rel)) continue;
      out.push(rel);
      if (out.length > MAX_FILES) throw new Error(`source tree exceeds ${MAX_FILES} files`);
    }
  };
  walk(absRoot);
  return out.sort();
}

/**
 * The SRI of a manifest's canonical serialization — the release manifest's `fileManifestDigest`. Order-stable
 * (paths are sorted), so two identical file sets always produce the same digest.
 * @param files the path → SRI map.
 * @param algorithm the digest algorithm (default sha512).
 * @returns the SRI digest string.
 */
export function baselineDigest(files: Record<string, string>, algorithm: 'sha256' | 'sha512' = 'sha512'): string {
  const canonical = Object.keys(files).sort().map((p) => `${p}\t${files[p]}`).join('\n');
  return ssri.fromData(Buffer.from(canonical, 'utf8'), { algorithms: [algorithm] }).toString();
}

/**
 * Generate a source baseline for a tree: hash every non-ignored file and compute the manifest digest.
 * @param root the absolute tree root to scan.
 * @param opts include filter + algorithm.
 * @returns the {@link SourceBaseline}. Side effects: reads the files under `root` (no writes).
 */
export function generateSourceBaselines(root: string, opts: BaselineOptions = {}): SourceBaseline {
  const algorithm = opts.algorithm ?? 'sha512';
  const files: Record<string, string> = {};
  for (const rel of listSourceFiles(root, opts.include)) {
    try {
      files[rel] = sriForContent(readFileSync(join(root, ...rel.split('/')), 'utf8'), algorithm);
    } catch { /* unreadable/binary — skip; it isn't operator-editable source */ }
  }
  return { files, digest: baselineDigest(files, algorithm) };
}
