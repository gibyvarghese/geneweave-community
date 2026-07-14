// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — L2 REMOTE code fetch (the three-way scan for instances with NO local git checkout).
 *
 * `code-release-scan.ts` computes the BASE and REMOTE sides of the three-way code diff from LOCAL git refs — it
 * needs the release's tags already fetched into a local work tree. A Community consumer who installed from a
 * release (not a git clone) has no such tags, so that path returns `git_required`. This module supplies the
 * missing capability: it fetches the PRISTINE source tree at the installed tag (BASE) and the target tag
 * (REMOTE) straight from the GitHub repo as tarballs, over the SAME hardened HTTP pipeline the manifest is
 * fetched through (token only in the Authorization header, never logged), then reuses the EXISTING
 * `generateSourceBaselines` + `codeStatus` + `persistCodeReport` so classification and bookkeeping are identical
 * to the local-git path. LOCAL is still the operator's live tree at `installRoot`.
 *
 * Trust (TUF-style): the signed manifest attests to the target tree via `layers.code.fileManifestDigest`. Before
 * a fetched REMOTE tree is used, its recomputed baseline digest must equal that value — a tampered or wrong
 * tree is rejected, so only code the signed manifest vouches for reaches the merge.
 *
 * Safety: the download is size-capped (zip-bomb guard); extraction strips the tarball's single top-level dir and
 * relies on `tar`'s built-in path-traversal protection; the temp extraction dir is always removed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract as tarExtract } from 'tar';
import { runResilient } from '@weaveintel/resilience';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { generateSourceBaselines, type SourceBaseline } from './source-baselines.js';
import { codeStatus, type CodeStatusReport } from './code-scan.js';
import { persistCodeReport, type CodeScanOutcome } from './code-baseline-store.js';

/** Hard ceiling on a downloaded tarball (compressed). A geneWeave source tree is a few MB; 100MB is generous. */
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;

/** The GitHub API base for public github.com; overridable for GitHub Enterprise. */
const GITHUB_API = 'https://api.github.com';

/** Where to fetch a release tree from, plus how to authenticate a private repo. */
export interface RemoteTreeSource {
  /** GitHub `owner/repo`. */
  readonly repo: string;
  /** GitHub API base (GitHub Enterprise); defaults to the public API. */
  readonly apiBase?: string | null;
  /** Optional bearer-token provider for a private repo — used only in the Authorization header, never logged. */
  readonly tokenProvider?: () => Promise<string>;
}

/** A distinct, non-throwing failure the caller renders (parallel to the local scan's `git_required`). */
export type RemoteScanFailure =
  | { status: 'fetch_failed'; reason: string }
  | { status: 'integrity_failed'; reason: string };

/**
 * The GitHub tarball URL for a ref (`…/repos/owner/repo/tarball/<ref>`). GitHub answers with a redirect to a
 * short-lived codeload URL; `fetch` follows it.
 * @param apiBase the API base (no trailing slash needed).
 * @param repo `owner/repo`.
 * @param ref a tag, branch, or commit sha.
 * @returns the absolute tarball URL.
 */
export function githubTarballUrl(apiBase: string, repo: string, ref: string): string {
  return `${apiBase.replace(/\/$/, '')}/repos/${repo}/tarball/${encodeURIComponent(ref)}`;
}

/** Build request headers, adding a (secret) Authorization only when a token provider is configured. */
async function headersFor(tokenProvider?: () => Promise<string>): Promise<Record<string, string>> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'geneweave-upgrade' };
  if (tokenProvider) h['Authorization'] = `Bearer ${await tokenProvider()}`;
  return h;
}

/**
 * Download a ref's tarball through the resilient pipeline and return its bytes.
 * @param url the tarball URL.
 * @param headers request headers (may carry a secret Authorization — never logged, even on error).
 * @returns the tarball bytes. Throws on a non-2xx status, an over-size body, or a transport error — the message
 *   carries only the URL + status, never the headers/token.
 */
async function downloadTarball(url: string, headers: Record<string, string>): Promise<Buffer> {
  return runResilient(async () => {
    const res = await fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`tarball HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_TARBALL_BYTES) throw new Error(`tarball exceeds ${MAX_TARBALL_BYTES}-byte limit`);
    return buf;
  }, { endpoint: 'upgrade:tarball' });
}

/**
 * Fetch a git ref's source tree from GitHub and baseline it — the remote analogue of `baselineAtRef`.
 *
 * The tarball's single top-level directory (`owner-repo-<sha>/`) is stripped so extracted paths match the live
 * tree's relative paths; `generateSourceBaselines` then applies the SAME ignore set + provenance stripping + sha512.
 * @param source repo + api base + optional token provider.
 * @param ref the tag/branch/sha to fetch.
 * @returns the ref's {@link SourceBaseline} (path → SRI + digest). Side effects: one HTTP GET; a temp dir created
 *   and removed. Throws on download/extract failure.
 */
export async function fetchTreeBaseline(source: RemoteTreeSource, ref: string): Promise<SourceBaseline> {
  const headers = await headersFor(source.tokenProvider);
  const buf = await downloadTarball(githubTarballUrl(source.apiBase || GITHUB_API, source.repo, ref), headers);
  const dir = mkdtempSync(join(tmpdir(), 'uc-remote-tree-'));
  try {
    // strip:1 removes the tarball's top-level owner-repo-<sha>/ wrapper. tar auto-detects the gzip and rejects
    // `..`/absolute paths itself. The filter is defence-in-depth against a path-traversal entry.
    await pipeline(Readable.from(buf), tarExtract({ cwd: dir, strip: 1, filter: (p: string) => !p.includes('..') }));
    return generateSourceBaselines(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Run a THREE-WAY code scan for an instance with no local git checkout: BASE + REMOTE are fetched from GitHub,
 * LOCAL is the live tree at `installRoot`. The REMOTE tree is integrity-checked against the signed manifest's
 * `fileManifestDigest` before use. Records changes (including real `both_changed` conflicts) as L2 review items.
 *
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param installRoot the operator's live source root (LOCAL).
 * @param source repo + api base + optional token provider for the fetch.
 * @param refs the installed-version tag (BASE) and target-version tag (REMOTE).
 * @param expectedRemoteDigest the manifest's `layers.code.fileManifestDigest` — REMOTE must match it (pass null
 *   to skip only when the manifest carries no digest; a PRESENT-but-mismatching digest always rejects).
 * @param at optional timestamp override (tests).
 * @returns the scan outcome, or a `fetch_failed` / `integrity_failed` marker the caller surfaces.
 * @sideEffect on success, one upgrade_runs row + one upgrade_details per non-trivial file.
 */
export async function scanCodeAgainstRemoteRelease(
  client: SqlClient, dialect: SqlDialect, installRoot: string,
  source: RemoteTreeSource, refs: { baseRef: string; remoteRef: string },
  expectedRemoteDigest: string | null, at?: string,
): Promise<CodeScanOutcome | RemoteScanFailure> {
  let base: SourceBaseline, remote: SourceBaseline;
  try {
    base = await fetchTreeBaseline(source, refs.baseRef);
    remote = await fetchTreeBaseline(source, refs.remoteRef);
  } catch (err) {
    return { status: 'fetch_failed', reason: (err as Error).message };
  }
  // TUF-style integrity: the signed manifest vouches for the target tree's digest. A present digest MUST match.
  if (expectedRemoteDigest && remote.digest !== expectedRemoteDigest) {
    return { status: 'integrity_failed', reason: 'fetched target tree does not match the signed manifest digest' };
  }
  const report: CodeStatusReport = codeStatus(installRoot, base, remote);
  const { runId, recorded } = await persistCodeReport(client, dialect, report, at);
  return { status: 'ok', runId, recorded, report };
}

/** Emitted when the remote scan can't run because no source/target is configured yet (parallel to git_required). */
export type RemoteScanUnconfigured = { status: 'not_configured'; reason: string };

/** Every outcome of the config-driven remote scan (success or a distinct, non-throwing failure). */
export type RemoteScanResult = CodeScanOutcome | RemoteScanFailure | RemoteScanUnconfigured;

/**
 * Resolve the release source + refs + integrity digest from stored config and the latest accepted manifest, then
 * run {@link scanCodeAgainstRemoteRelease}. This is the single orchestration both DB adapters call, so the ref/
 * digest/source resolution lives (and is tested) in one place.
 *
 * BASE = `GENEWEAVE_SOURCE_BASE_REF` or `v<installedVersion>` (the installed release's tag). REMOTE + the
 * integrity digest come from the accepted manifest's code layer. The repo/api-base come from the stored source
 * config (env `GENEWEAVE_UPGRADE_REPO` is the fallback). LOCAL is `installRoot`.
 *
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param installRoot the operator's live source root (LOCAL).
 * @param opts.tokenProvider optional private-repo token provider; opts.env process env override; opts.at timestamp.
 * @returns the scan outcome, a fetch/integrity failure, or `not_configured` when there's no repo or no target tag.
 */
export async function scanCodeRemoteFromConfig(
  client: SqlClient, dialect: SqlDialect, installRoot: string,
  opts: { tokenProvider?: () => Promise<string>; env?: NodeJS.ProcessEnv; at?: string } = {},
): Promise<CodeScanOutcome | RemoteScanFailure | RemoteScanUnconfigured> {
  const env = opts.env ?? process.env;
  const [{ loadSourceConfig }, { latestAcceptedManifest }, { getAppVersion }] = await Promise.all([
    import('./upgrade-source.js'), import('./upgrade-release-store.js'), import('./upgrade-check.js'),
  ]);
  const source = await loadSourceConfig(client, dialect);
  const target = await latestAcceptedManifest(client, dialect);
  const repo = source?.repo ?? env['GENEWEAVE_UPGRADE_REPO'];
  if (!repo) return { status: 'not_configured', reason: 'no release source configured' };
  const remoteRef = target?.manifest.layers.code?.repoTag;
  if (!remoteRef) return { status: 'not_configured', reason: 'no accepted release with a code tag to compare against' };
  const baseRef = env['GENEWEAVE_SOURCE_BASE_REF'] ?? `v${getAppVersion()}`;
  const expectedRemoteDigest = target?.manifest.layers.code?.fileManifestDigest ?? null;
  return scanCodeAgainstRemoteRelease(
    client, dialect, installRoot,
    { repo, apiBase: source?.apiBase ?? null, ...(opts.tokenProvider ? { tokenProvider: opts.tokenProvider } : {}) },
    { baseRef, remoteRef }, expectedRemoteDigest, opts.at,
  );
}
