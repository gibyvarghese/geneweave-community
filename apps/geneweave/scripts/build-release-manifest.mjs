#!/usr/bin/env node
// build-release-manifest.mjs — assemble, sign, and self-verify a geneWeave release manifest.
//
// WHY THIS EXISTS
//   A geneWeave release is a `v<x.y.z>` git tag plus a GitHub Release carrying a signed `manifest.json`. The
//   running Upgrade Center discovers that manifest, verifies its Ed25519 signature against a trusted key,
//   checks edition + freshness + anti-rollback, and — for the code layer — fetches the tag's source tree and
//   proves it matches the manifest's `fileManifestDigest` before merging a byte. This script is the PUBLISHER
//   side of that contract: it turns a tagged commit into that signed manifest.
//
//   It reuses, rather than reinvents, everything cryptographic and structural:
//     • `@weaveintel/upgrade` `buildManifest` (schema-validate + Ed25519-sign), `lintManifest` (publisher
//       policy), and `createEd25519Verifier`/`verifyManifestSignature` (the SAME verifier a client uses);
//     • the app's `fetchTreeBaseline` (code-remote-fetch.ts) to compute `fileManifestDigest` — it downloads the
//       tag's tarball from GitHub and hashes it with `generateSourceBaselines`, i.e. the EXACT bytes and
//       algorithm every client re-verifies, so the digest is guaranteed to match (and it's resilience-hardened);
//     • the product-version guard's `fabricFor` for the major's fabric codename (one source of truth).
//
//   The signed manifest is then SELF-VERIFIED against the repo's committed public key(s) in release-keys/ — a
//   release fails to build if the GENEWEAVE_RELEASE_SIGNING_KEY secret doesn't match a published public key, so
//   a wrong/rotated key can never ship a manifest no instance will trust.
//
// USAGE (CI sets these via env on a v* tag; flags are for local dry-runs):
//   GENEWEAVE_RELEASE_SIGNING_KEY=<ed25519 private PEM>   (required — the offline signing key; a secret)
//   GENEWEAVE_UPGRADE_REPO=owner/repo                     (required — where the tag/tarball live)
//   RELEASE_TAG=v1.0.0                                    (defaults to v<product version>)
//   GENEWEAVE_EDITION=community|enterprise                (defaults to EDITION_DEFAULT below)
//   GITHUB_TOKEN=<token>                                  (needed for a PRIVATE repo's tarball; optional public)
//   node scripts/build-release-manifest.mjs --out manifest.json   (run from apps/geneweave, after `npm run build`)
//
// SECURITY: the private key is read from env only, never written to the output or logged; errors from the
// tarball fetch carry a URL + status, never a token (that hygiene lives in code-remote-fetch.ts).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildManifest, lintManifest, createEd25519Verifier, verifyManifestSignature } from '@weaveintel/upgrade';
import { fabricFor } from '../../../scripts/check-product-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..'); // apps/geneweave
const repoRoot = join(appRoot, '..', '..'); // repository root

// ── Per-repo configuration (the only line that differs between editions) ───────────────────────
/** Edition used when GENEWEAVE_EDITION is unset. Community here; the private repo sets 'enterprise'. */
export const EDITION_DEFAULT = 'community';

/** An SRI hash, e.g. `sha512-…` — the shape source-baselines/code digests take. */
const SRI_RE = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
/** Plain product SemVer (matches the product-version guard). */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Assemble a manifest BODY for a release. Pure — no I/O, no signing.
 * @param {object} p
 * @param {string} p.name - product/package name the release is for.
 * @param {string} p.version - the release version (plain x.y.z).
 * @param {string} p.edition - target edition ('community' | 'enterprise').
 * @param {string} p.tag - the git tag (`v<version>`), recorded as `layers.code.repoTag`.
 * @param {string} p.fileManifestDigest - SRI digest of the tag's source tree (`layers.code.fileManifestDigest`).
 * @param {string} p.publishedAt - ISO 8601 publish time.
 * @param {string} [p.node] - required Node range (from package.json engines), if any.
 * @param {string} [p.expiresAt] - optional ISO 8601 expiry (stale-manifest defence).
 * @param {Array} [p.packages] - optional L1 package pins (defaults to none).
 * @param {Array} [p.schema] - optional L3 schema batches (defaults to none).
 * @param {Array} [p.content] - optional L4 content entries (defaults to none).
 * @returns {object} a ManifestBody ready for lint + buildManifest. Codename is derived from the major.
 */
export function buildReleaseBody(p) {
  const sv = SEMVER_RE.exec(p.version ?? '');
  const codename = sv ? fabricFor(Number(sv[1])) : null;
  return {
    manifestVersion: 1,
    name: p.name,
    version: p.version,
    ...(codename ? { codename } : {}),
    channel: 'stable',
    edition: p.edition,
    publishedAt: p.publishedAt,
    ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
    requires: { ...(p.node ? { node: p.node } : {}) },
    layers: {
      packages: p.packages ?? [],
      schema: p.schema ?? [],
      content: p.content ?? [],
      code: { repoTag: p.tag, fileManifestDigest: p.fileManifestDigest },
    },
    artifacts: [],
  };
}

/**
 * Repo-level release checks the manifest lint cannot do (it has no repository context).
 * @param {object} p - { version, tag, edition, fileManifestDigest }.
 * @returns {string[]} human-readable problems; empty means the inputs are release-ready.
 */
export function checkReleaseInputs(p) {
  const problems = [];
  if (!SEMVER_RE.test(p.version ?? '')) problems.push(`version "${p.version}" is not plain SemVer (x.y.z)`);
  if (p.tag !== `v${p.version}`) problems.push(`tag "${p.tag}" must equal "v${p.version}" (the product version)`);
  if (!p.edition) problems.push('edition is required (GENEWEAVE_EDITION)');
  if (!SRI_RE.test(p.fileManifestDigest ?? '')) problems.push('fileManifestDigest is missing or not an SRI hash');
  return problems;
}

/**
 * Read the committed trusted public keys from a directory (files ending `.pub.pem`).
 * @param {string} dir - the release-keys directory.
 * @returns {string[]} the PEM contents (empty if the directory is absent/empty).
 */
export function readTrustedPublicKeys(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.pub.pem'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'));
}

/**
 * Sign a manifest body and PROVE it verifies against the repo's committed public key(s).
 * @param {object} body - the manifest body (buildManifest validates it against the schema).
 * @param {string} privateKeyPem - the Ed25519 private PEM (the release signing key).
 * @param {string[]} trustedPublicKeyPems - the committed public keys the manifest must verify against.
 * @returns {{ manifest: object, fingerprint: string }} the signed manifest + its signing-key fingerprint.
 * @throws if no public key is committed, or the signed manifest doesn't verify against any of them (a wrong/
 *   rotated signing secret — fail closed so we never ship a manifest no instance can trust).
 */
export function signAndSelfVerify(body, privateKeyPem, trustedPublicKeyPems) {
  const manifest = buildManifest(body, privateKeyPem); // schema-validate + Ed25519-sign
  if (trustedPublicKeyPems.length === 0) {
    throw new Error(
      'no committed public key in release-keys/ — commit the signing key\'s public PEM (release-keys/geneweave-<edition>.pub.pem) so releases self-verify and adopters can trust them (see release-keys/README.md)',
    );
  }
  const res = verifyManifestSignature(manifest, createEd25519Verifier(trustedPublicKeyPems));
  if (!res.ok) {
    throw new Error(
      `signed manifest does not verify against any committed public key (${res.reason}); the GENEWEAVE_RELEASE_SIGNING_KEY secret must match a release-keys/*.pub.pem`,
    );
  }
  return { manifest, fingerprint: manifest.signature.keyFingerprint };
}

/** Read a JSON field from apps/geneweave/package.json. */
function appPackage() {
  return JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
}

/** Parse `--flag value` pairs from argv into a plain object. */
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/**
 * CLI entry — gather inputs, compute the digest from GitHub's tag tarball, assemble → lint → sign → self-verify,
 * and write manifest.json. Network + app-build are only touched here (dynamic import of the built dist), so the
 * pure functions above stay unit-testable without either.
 */
async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const pkg = appPackage();
  const version = pkg.version;
  const name = pkg.name;
  const node = pkg.engines?.node;
  const tag = process.env.RELEASE_TAG || flags.tag || `v${version}`;
  const edition = process.env.GENEWEAVE_EDITION || flags.edition || EDITION_DEFAULT;
  const repo = process.env.GENEWEAVE_UPGRADE_REPO || flags.repo;
  const privateKeyPem = process.env.GENEWEAVE_RELEASE_SIGNING_KEY;
  const out = flags.out || join(appRoot, 'manifest.json');

  const fatal = (msg) => { console.error(`✗ build-release-manifest: ${msg}`); process.exit(1); };
  if (!privateKeyPem) fatal('GENEWEAVE_RELEASE_SIGNING_KEY is not set (the Ed25519 private PEM)');
  if (!repo) fatal('repo is required (GENEWEAVE_UPGRADE_REPO=owner/repo or --repo)');

  // Compute fileManifestDigest via the SAME function every client re-verifies with (guaranteed match).
  // A PRIVATE repo's tarball needs auth — pass the CI GITHUB_TOKEN via a token provider when present.
  const { fetchTreeBaseline } = await import('../dist/code-remote-fetch.js');
  const token = process.env.GITHUB_TOKEN;
  const apiBase = process.env.GENEWEAVE_UPGRADE_API_BASE || flags.apiBase; // GitHub Enterprise / test mock
  const source = {
    repo,
    ...(apiBase ? { apiBase } : {}),
    ...(token ? { tokenProvider: async () => token } : {}),
  };
  let fileManifestDigest;
  try {
    fileManifestDigest = (await fetchTreeBaseline(source, tag)).digest;
  } catch (err) {
    fatal(`could not compute the source-tree digest for ${tag}: ${err.message}`);
  }

  const inputProblems = checkReleaseInputs({ version, tag, edition, fileManifestDigest });
  if (inputProblems.length) fatal(`release input errors:\n  - ${inputProblems.join('\n  - ')}`);

  const publishedAt = new Date().toISOString();
  const body = buildReleaseBody({ name, version, edition, tag, node, publishedAt, fileManifestDigest });

  const lint = lintManifest(body);
  for (const w of lint.issues.filter((i) => i.level === 'warning')) console.warn(`  ⚠ ${w.code}: ${w.message}`);
  const errors = lint.issues.filter((i) => i.level === 'error');
  if (errors.length) fatal(`manifest lint errors:\n  - ${errors.map((e) => `${e.code}: ${e.message}`).join('\n  - ')}`);

  const keysDir = process.env.GENEWEAVE_RELEASE_KEYS_DIR || join(repoRoot, 'release-keys');
  const trusted = readTrustedPublicKeys(keysDir);
  let manifest, fingerprint;
  try {
    ({ manifest, fingerprint } = signAndSelfVerify(body, privateKeyPem, trusted));
  } catch (err) {
    fatal(err.message);
  }

  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ ${name}@${version} "${manifest.codename ?? ''}" (${edition}) tag ${tag}`);
  console.log(`  digest ${fileManifestDigest.slice(0, 24)}… · signed by ${fingerprint} · self-verified against release-keys/`);
  console.log(`  wrote ${out}`);
}

// Run as CLI only (importing this module for tests must not execute main()). Exit explicitly on success so a
// lingering keep-alive socket (undici's fetch pool) can't hold the event loop open after the work is done.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ build-release-manifest: ${err.message}`); process.exit(1); });
}
