#!/usr/bin/env node
// check-release-tag.mjs — the release-tag gate.
//
// WHY THIS EXISTS
//   A geneWeave release is triggered by pushing a `v<x.y.z>` tag (→ .github/workflows/release.yml). The
//   release-product tooling creates well-formed, monotonic tags, but a tag can also be pushed by hand — and a
//   malformed or backwards tag would cut a bad or downgrade release. This gate runs FIRST in the release
//   workflow and refuses a tag that is: not SemVer, out of step with the committed product version, or not
//   strictly newer than every existing release tag (anti-rollback). It is the release-time enforcement of the
//   same rules `release-product.mjs` applies at tag-creation time — defence in depth at the point of no return.
//
//   It REUSES the shared version logic (parseSemver, semverCompare) rather than re-deriving it, so "what a valid,
//   monotonic version looks like" has one definition across the guard, the releaser, and this gate.
//
// USAGE (CI passes the pushed tag; the product version + existing tags are read here):
//   node scripts/check-release-tag.mjs v1.2.0
//   node scripts/check-release-tag.mjs           # falls back to RELEASE_TAG / GITHUB_REF_NAME
//   (needs the full tag list — the workflow checks out with fetch-depth: 0)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseSemver, PRODUCT_PACKAGE, VERSIONING_DOC } from './check-product-version.mjs';
import { semverCompare } from './release-product.mjs';

/** Match a release tag `v<x.y.z>` → its version, or null. */
const TAG_RE = /^v(\d+\.\d+\.\d+)$/;

/**
 * Validate a release tag against the product version and the existing tags (pure — no git/fs).
 * @param {string} tag - the pushed tag, e.g. "v1.2.0".
 * @param {string} productVersion - the version in apps/geneweave/package.json.
 * @param {string[]} existingTags - all `v*` tags in the repo (may include `tag` itself).
 * @returns {string[]} human-readable problems; empty means the tag is release-ready.
 */
export function validateReleaseTag(tag, productVersion, existingTags) {
  const problems = [];
  const m = TAG_RE.exec(tag ?? '');
  if (!m) {
    problems.push(`tag "${tag}" is not a SemVer release tag (expected v<x.y.z>)`);
    return problems; // nothing else is meaningful
  }
  const version = m[1];
  if (version !== productVersion) {
    problems.push(`tag ${tag} does not match apps/geneweave/package.json version ${productVersion} (bump the product version first)`);
  }
  // Anti-rollback: the new tag must be strictly newer than every OTHER release tag.
  const notNewer = existingTags
    .map((t) => TAG_RE.exec(t)?.[1])
    .filter((v) => v && v !== version) // ignore self + non-release tags
    .filter((v) => semverCompare(v, version) >= 0); // an existing tag ≥ the new one ⇒ not a forward release
  if (notNewer.length) {
    problems.push(`anti-rollback: ${tag} is not newer than existing tag(s) ${[...new Set(notNewer)].sort().map((v) => 'v' + v).join(', ')}`);
  }
  return problems;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const tag = process.argv[2] || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  const fatal = (msg) => { console.error(`✗ check-release-tag — ${msg}`); process.exit(1); };
  if (!tag) fatal('no tag given (arg, RELEASE_TAG, or GITHUB_REF_NAME)');

  const productVersion = JSON.parse(readFileSync(PRODUCT_PACKAGE, 'utf8')).version;
  const repoRoot = VERSIONING_DOC.replace(/\/VERSIONING\.md$/, '');
  let existingTags = [];
  try {
    existingTags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    fatal(`could not list git tags: ${err.message}`);
  }

  const problems = validateReleaseTag(tag, productVersion, existingTags);
  if (problems.length) fatal(`the release tag is not valid:\n  - ${problems.join('\n  - ')}`);
  console.log(`✓ release tag ${tag} is valid (SemVer, matches product version ${productVersion}, newer than all existing tags)`);
}
