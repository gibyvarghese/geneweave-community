#!/usr/bin/env node
// check-product-version.mjs — the geneWeave product-version guardrail.
//
// WHY THIS EXISTS
//   geneWeave ships as ONE product across two editions (community + private/enterprise) that must
//   always carry the SAME product version — the Upgrade Center lines up its edition check and
//   version compare on that shared x.y.z (see VERSIONING.md). This script is the CI guardrail that
//   keeps the version honest:
//     • the product version (apps/geneweave/package.json) is valid SemVer,
//     • its major maps to the correct fabric codename (majors only; VERSIONING.md rule),
//     • VERSIONING.md's "Current release" and CHANGELOG.md's top entry agree with it, and
//     • (private edition only) it matches the community edition's product version — the lockstep.
//
//   SOURCE OF TRUTH: apps/geneweave/package.json `version`. Everything else is checked against it.
//
//   CROSS-EDITION DIRECTION (security): only the PRIVATE repo performs the cross-check, reading the
//   PUBLIC community version over its public raw URL (no secret). We deliberately never place a
//   private-repo access token in the public community repo — that is the classic public-repo /
//   fork-PR secret-exfiltration vector. This community copy therefore sets `PEER = null` and
//   self-validates; the private copy sets `PEER` and additionally enforces equality. Both
//   divergence directions are still caught by the private guard (immediately if private drifts, on
//   its next run / nightly schedule if community drifts).
//
//   NOTE: this file is intentionally duplicated between the two geneWeave repos (they are separate
//   repos with no shared package to import from). The ONLY intended difference between the copies
//   is the `EDITION` and `PEER` constants below; keep the rest identical.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// ── Per-repo configuration (the only lines that differ between editions) ───────────────────────
/** This repo's edition label. */
export const EDITION = 'community';
/**
 * The peer edition whose product version must match this one, or `null` if this edition does not
 * cross-check. `url` points at the peer's apps/geneweave/package.json raw contents.
 * @type {{ edition: string, url: string } | null}
 */
export const PEER = null;

// ── Paths (relative to the repo root) ──────────────────────────────────────────────────────────
export const PRODUCT_PACKAGE = join(repoRoot, 'apps/geneweave/package.json');
export const VERSIONING_DOC = join(repoRoot, 'VERSIONING.md');
export const CHANGELOG_DOC = join(repoRoot, 'CHANGELOG.md');

/**
 * Fabric codenames, one per MAJOR, alphabetical — mirrors the table in VERSIONING.md. Index 0 is
 * major 1 ("Aertex"). Majors beyond this list have no codename yet (extend the list + VERSIONING.md).
 */
export const FABRICS = [
  'Aertex', 'Batiste', 'Calico', 'Damask', 'Etamine', 'Flannel', 'Gauze', 'Habutai',
  'Intarsia', 'Jersey', 'Knit', 'Linen', 'Muslin', 'Nankeen', 'Organza', 'Percale',
  'Rinzu', 'Satin', 'Taffeta', 'Ultrasuede', 'Velvet', 'Wadmal', 'Zephyr',
];

// Product versions are plain x.y.z — the Upgrade Center's SemVer compare + anti-rollback assume it.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a plain SemVer product version.
 * @param {string} v - version string, e.g. "1.0.0".
 * @returns {{ major: number, minor: number, patch: number } | null} parsed parts, or null if invalid.
 */
export function parseSemver(v) {
  const m = SEMVER_RE.exec((v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/**
 * The fabric codename for a given MAJOR.
 * @param {number} major - the SemVer major (1-based).
 * @returns {string | null} the codename, or null if the major is outside the named list.
 */
export function fabricFor(major) {
  return FABRICS[major - 1] ?? null;
}

/**
 * Read the product version (source of truth) from a package.json.
 * @param {string} [file] - path to the package.json; defaults to apps/geneweave/package.json.
 * @returns {string} the `version` field verbatim.
 */
export function readProductVersion(file = PRODUCT_PACKAGE) {
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

/**
 * Extract the body of VERSIONING.md's "## Current release" section (up to the next heading).
 * @param {string} md - the VERSIONING.md contents.
 * @returns {string} the section body, or "" if the section is absent.
 */
export function currentReleaseSection(md) {
  const m = /##\s+Current release([\s\S]*?)(?:\n#{1,2}\s|$)/i.exec(md);
  return m ? m[1] : '';
}

/**
 * The first VERSIONED heading in a CHANGELOG ("## [x.y.z]" or "## x.y.z"), skipping "## [Unreleased]".
 * @param {string} md - the CHANGELOG.md contents.
 * @returns {string | null} the top version string, or null if there is no versioned heading yet.
 */
export function topChangelogVersion(md) {
  const m = /^##\s+\[?(\d+\.\d+\.\d+)\]?/m.exec(md);
  return m ? m[1] : null;
}

/**
 * Check the product version against the local docs (no network).
 * @param {string} version - the product version from package.json.
 * @param {string} versioningMd - VERSIONING.md contents.
 * @param {string} changelogMd - CHANGELOG.md contents.
 * @returns {string[]} a list of human-readable problems; empty means consistent.
 */
export function checkConsistency(version, versioningMd, changelogMd) {
  const problems = [];
  const sv = parseSemver(version);
  if (!sv) {
    problems.push(`product version "${version}" is not valid SemVer (expected x.y.z)`);
    return problems; // nothing else is meaningful without a parseable version
  }

  const codename = fabricFor(sv.major);
  if (!codename) {
    problems.push(`major ${sv.major} has no fabric codename (list covers majors 1..${FABRICS.length}); extend FABRICS + VERSIONING.md`);
  }

  // VERSIONING.md's "Current release" section must name this version (and codename, if any).
  const current = currentReleaseSection(versioningMd);
  if (!current) {
    problems.push('VERSIONING.md has no "## Current release" section');
  } else {
    if (!current.includes(version)) problems.push(`VERSIONING.md "Current release" does not name product version ${version}`);
    if (codename && !new RegExp(`\\b${codename}\\b`).test(current)) {
      problems.push(`VERSIONING.md "Current release" does not name codename "${codename}" for major ${sv.major}`);
    }
  }

  // CHANGELOG.md's newest versioned entry must equal this version.
  const top = topChangelogVersion(changelogMd);
  if (!top) problems.push('CHANGELOG.md has no versioned "## [x.y.z]" heading');
  else if (top !== version) problems.push(`CHANGELOG.md newest version ${top} != product version ${version}`);

  return problems;
}

/**
 * Resolve the peer edition's product version for the lockstep check.
 * Resolution order: `PEER_PRODUCT_VERSION` env (test/offline override) → fetch `peer.url` with retries.
 * @param {{ edition: string, url: string } | null} [peer] - the peer config; null ⇒ no cross-check.
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] - fetch implementation (injectable for tests).
 * @param {number} [opts.retries] - fetch attempts before giving up (default 3).
 * @param {NodeJS.ProcessEnv} [opts.env] - environment (injectable for tests).
 * @returns {Promise<string | null>} the peer version, or null if `peer` is null.
 * @throws if the peer version cannot be read after all retries (drift-safety: never silently skip).
 */
export async function fetchPeerVersion(peer = PEER, { fetchImpl = fetch, retries = 3, env = process.env } = {}) {
  if (!peer) return null;
  if (env.PEER_PRODUCT_VERSION) return env.PEER_PRODUCT_VERSION.trim();
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(peer.url, { headers: { 'user-agent': 'geneweave-product-version-guard' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body?.version) throw new Error('peer package.json has no "version"');
      return String(body.version).trim();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`could not read ${peer.edition} product version from ${peer.url}: ${lastErr?.message}`);
}

/**
 * Run the full guard: local doc consistency + (if configured) cross-edition lockstep.
 * @param {object} [opts] - overrides, primarily for tests. Any omitted field is read from disk/config.
 * @param {string} [opts.version] - product version (default: read from package.json).
 * @param {string} [opts.versioningMd] - VERSIONING.md contents.
 * @param {string} [opts.changelogMd] - CHANGELOG.md contents.
 * @param {{edition:string,url:string}|null} [opts.peer] - peer config (default: module `PEER`).
 * @param {string|null} [opts.peerVersion] - inject the peer version (skips the network).
 * @returns {Promise<{version:string, codename:string|null, peerVersion:string|null, problems:string[]}>}
 */
export async function runGuard(opts = {}) {
  const version = opts.version ?? readProductVersion();
  const versioningMd = opts.versioningMd ?? readFileSync(VERSIONING_DOC, 'utf8');
  const changelogMd = opts.changelogMd ?? readFileSync(CHANGELOG_DOC, 'utf8');
  const problems = checkConsistency(version, versioningMd, changelogMd);

  const peer = opts.peer !== undefined ? opts.peer : PEER;
  let peerVersion = null;
  if (peer) {
    peerVersion = opts.peerVersion !== undefined ? opts.peerVersion : await fetchPeerVersion(peer, opts);
    if (peerVersion !== version) {
      problems.push(`edition lockstep violated: ${EDITION}=${version} but ${peer.edition}=${peerVersion} — both editions must ship the same product version`);
    }
  }
  return { version, codename: fabricFor(parseSemver(version)?.major ?? -1), peerVersion, problems };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGuard()
    .then(({ version, codename, peerVersion, problems }) => {
      if (problems.length) {
        console.error(`✗ product-version guard FAILED (${EDITION} @ ${version}${codename ? ` "${codename}"` : ''}):`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
      }
      const lock = peerVersion ? ` — lockstep OK with ${PEER.edition} @ ${peerVersion}` : '';
      console.log(`✓ product-version guard passed: ${EDITION} @ ${version} "${codename}"${lock}`);
    })
    .catch((err) => {
      console.error(`✗ product-version guard ERROR: ${err.message}`);
      process.exit(1);
    });
}
