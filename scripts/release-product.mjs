#!/usr/bin/env node
// release-product.mjs — one command to cut a geneWeave PRODUCT release.
//
// WHY THIS EXISTS
//   A geneWeave release is a `v<x.y.z>` tag whose push triggers the signed-release workflow
//   (.github/workflows/release.yml → build-release-manifest.mjs). Getting to that tag by hand means bumping the
//   product version, rolling the changelog, updating VERSIONING.md's "Current release", keeping the fabric
//   codename right, committing, and tagging — each an easy place to drift from the invariants the CI guard
//   (check-product-version.mjs) enforces. This script does all of it in one step, and VALIDATES the result with
//   that very guard's rules before it commits, so a release it produces is guaranteed to pass CI.
//
//   It REUSES the guard's logic (parseSemver, fabricFor, checkConsistency, …) rather than re-deriving versioning
//   rules, so there is one source of truth for "what a consistent product version looks like".
//
// USAGE (run in a clean working tree on the release branch):
//   node scripts/release-product.mjs <patch|minor|major>     # bump + roll changelog + commit + tag (LOCAL)
//   node scripts/release-product.mjs --set 1.2.0             # release an exact version (both editions share it)
//   node scripts/release-product.mjs minor --dry-run         # preview only; writes nothing
//   node scripts/release-product.mjs minor --push            # also push branch + tag → triggers the release
//   node scripts/release-product.mjs patch --allow-empty-notes
//
// SAFETY: by default it does NOT push — it commits + tags locally (both easily undone with `git reset` /
// `git tag -d`) and prints the exact push command, because pushing the tag cuts a real, signed release. The
// two editions share ONE product version (VERSIONING.md); run this in community, then `--set <that version>` in
// the private repo. The Phase-2 lockstep guard fails CI if they diverge.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  parseSemver, fabricFor, checkConsistency, PRODUCT_PACKAGE, VERSIONING_DOC, CHANGELOG_DOC, PEER, fetchPeerVersion,
} from './check-product-version.mjs';

// ── Pure transforms (no I/O — unit-tested directly) ────────────────────────────────────────────

/**
 * Compute the next version for a semantic bump.
 * @param {string} current - the current version (x.y.z).
 * @param {'patch'|'minor'|'major'} bump - which part to increment.
 * @returns {string} the next version.
 * @throws if `current` isn't valid SemVer or `bump` is unknown.
 */
export function computeNext(current, bump) {
  const sv = parseSemver(current);
  if (!sv) throw new Error(`current version "${current}" is not valid SemVer`);
  if (bump === 'major') return `${sv.major + 1}.0.0`;
  if (bump === 'minor') return `${sv.major}.${sv.minor + 1}.0`;
  if (bump === 'patch') return `${sv.major}.${sv.minor}.${sv.patch + 1}`;
  throw new Error(`unknown bump "${bump}" (expected patch|minor|major)`);
}

/**
 * Compare two SemVer versions.
 * @param {string} a - left version.
 * @param {string} b - right version.
 * @returns {number} negative if a<b, 0 if equal, positive if a>b.
 */
export function semverCompare(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) throw new Error(`cannot compare versions "${a}" and "${b}"`);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/**
 * Set the top-level `version` field of a package.json's TEXT, preserving all other formatting.
 * @param {string} jsonText - the package.json file contents.
 * @param {string} version - the new version.
 * @returns {string} the updated text (only the version string changed).
 * @throws if no top-level version field is found.
 */
export function bumpPackageJson(jsonText, version) {
  let replaced = false;
  const out = jsonText.replace(/("version"\s*:\s*")[^"]+(")/, (_m, a, b) => { replaced = true; return `${a}${version}${b}`; });
  if (!replaced) throw new Error('no "version" field found in package.json');
  return out;
}

/**
 * Roll a Keep-a-Changelog CHANGELOG: move the `[Unreleased]` body into a new dated version section and reset
 * `[Unreleased]` to empty.
 * @param {string} md - the CHANGELOG.md contents.
 * @param {string} version - the version being released.
 * @param {string} codename - the fabric codename for the version's major.
 * @param {string} date - ISO date (YYYY-MM-DD) for the release heading.
 * @returns {{ text: string, notes: string }} the updated changelog + the notes that were released (trimmed).
 * @throws if there is no `## [Unreleased]` section.
 */
export function rollChangelog(md, version, codename, date) {
  const re = /##\s+\[Unreleased\]\s*\n([\s\S]*?)(\n##\s+\[)/;
  const m = re.exec(md);
  if (!m) throw new Error('CHANGELOG.md has no "## [Unreleased]" section to roll');
  const notes = m[1].trim();
  const fresh = '## [Unreleased]\n\n_Nothing yet._\n\n';
  const released = `## [${version}] — ${codename} — ${date}\n\n${notes}\n`;
  return { text: md.replace(re, `${fresh}${released}${m[2]}`), notes };
}

/**
 * Update VERSIONING.md's "Current release" table row to the new version + codename (editions cell preserved).
 * @param {string} md - the VERSIONING.md contents.
 * @param {string} version - the new version.
 * @param {string} codename - the new codename.
 * @returns {string} the updated text.
 * @throws if the Current-release row (a bold SemVer + codename) isn't found.
 */
export function updateVersioningCurrentRelease(md, version, codename) {
  const re = /(\|\s*)\*\*\d+\.\d+\.\d+\*\*(\s*\|\s*)[A-Za-z]+(\s*\|)/;
  if (!re.test(md)) throw new Error('VERSIONING.md "Current release" row (| **x.y.z** | Codename | …) not found');
  return md.replace(re, `$1**${version}**$2${codename}$3`);
}

// ── Git helpers (array args — no shell, so nothing is injectable) ───────────────────────────────

/** Run git with array args in the repo root; returns trimmed stdout. */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** True if a tag already exists locally. */
function tagExists(tag, cwd) {
  return git(['tag', '--list', tag], cwd).length > 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

/** Parse argv into { bump, set, dryRun, push, allowEmptyNotes }. */
export function parseArgs(argv) {
  const out = { bump: null, set: null, dryRun: false, push: false, allowEmptyNotes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--push') out.push = true;
    else if (a === '--allow-empty-notes') out.allowEmptyNotes = true;
    else if (a === '--set') out.set = argv[++i];
    else if (['patch', 'minor', 'major'].includes(a)) out.bump = a;
  }
  return out;
}

/**
 * Run the release: compute the version, transform the files, validate, and (unless --dry-run) commit + tag.
 * @param {object} [opts] - overrides for tests: { argv, repoRoot, date, gitImpl, now }.
 * @returns {Promise<{version, codename, notes, wrote, committed, pushed}>}
 */
async function main(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);
  const args = parseArgs(argv);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  // repoRoot is where VERSIONING.md/CHANGELOG.md live (the guard's constants point at it).
  const repoRoot = VERSIONING_DOC.replace(/\/VERSIONING\.md$/, '');

  const fatal = (msg) => { console.error(`✗ release:product — ${msg}`); process.exit(1); };
  if (!args.bump && !args.set) fatal('specify a bump (patch|minor|major) or --set <x.y.z>');

  const pkgText = readFileSync(PRODUCT_PACKAGE, 'utf8');
  const current = JSON.parse(pkgText).version;
  const version = args.set ?? computeNext(current, args.bump);

  if (!parseSemver(version)) fatal(`target version "${version}" is not valid SemVer (x.y.z)`);
  if (semverCompare(version, current) <= 0) fatal(`target ${version} is not greater than current ${current} (anti-rollback)`);
  const codename = fabricFor(parseSemver(version).major);
  if (!codename) fatal(`major ${parseSemver(version).major} has no fabric codename — extend the fabric list first`);

  const tag = `v${version}`;
  if (tagExists(tag, repoRoot)) fatal(`tag ${tag} already exists`);

  // Optional peer-edition heads-up (both editions share the version). Never fatal — the CI guard enforces it.
  if (PEER) {
    try {
      const peerVersion = await fetchPeerVersion(PEER);
      if (peerVersion && peerVersion !== version) {
        console.warn(`  ⚠ ${PEER.edition} is at ${peerVersion}; run the SAME version there so the editions stay in lockstep.`);
      }
    } catch { /* offline peer check is advisory only */ }
  }

  // Transform the three files.
  const newPkg = bumpPackageJson(pkgText, version);
  const versioningText = readFileSync(VERSIONING_DOC, 'utf8');
  const newVersioning = updateVersioningCurrentRelease(versioningText, version, codename);
  const changelogText = readFileSync(CHANGELOG_DOC, 'utf8');
  const { text: newChangelog, notes } = rollChangelog(changelogText, version, codename, date);

  if (!args.allowEmptyNotes && (notes === '' || notes === '_Nothing yet._')) {
    fatal('the [Unreleased] section is empty — add release notes to CHANGELOG.md first, or pass --allow-empty-notes');
  }

  // Validate the RESULT against the same rules CI enforces (peer skipped — that's the guard's job in CI).
  const problems = checkConsistency(version, newVersioning, newChangelog);
  if (problems.length) fatal(`the bumped files would fail the product-version guard:\n  - ${problems.join('\n  - ')}`);

  console.log(`release:product — ${current} → ${version} "${codename}" (${date})`);
  if (args.dryRun) {
    console.log('  --dry-run: no files written, no commit, no tag. Release notes:');
    console.log(notes.split('\n').map((l) => '    ' + l).join('\n'));
    return { version, codename, notes, wrote: false, committed: false, pushed: false };
  }

  writeFileSync(PRODUCT_PACKAGE, newPkg);
  writeFileSync(VERSIONING_DOC, newVersioning);
  writeFileSync(CHANGELOG_DOC, newChangelog);

  git(['add', '-A'], repoRoot);
  git(['commit', '-m', `release: ${tag} "${codename}"`], repoRoot);
  git(['tag', '-a', tag, '-m', `geneWeave ${version} "${codename}"`], repoRoot);
  console.log(`  ✓ committed + tagged ${tag} locally`);

  if (args.push) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    git(['push', 'origin', branch], repoRoot);
    git(['push', 'origin', tag], repoRoot);
    console.log(`  ✓ pushed ${branch} + ${tag} → the Release workflow will sign + publish`);
    return { version, codename, notes, wrote: true, committed: true, pushed: true };
  }

  console.log(`  Next: push to cut the release →  git push origin HEAD && git push origin ${tag}`);
  console.log(`  (undo locally:  git tag -d ${tag} && git reset --hard HEAD~1)`);
  return { version, codename, notes, wrote: true, committed: true, pushed: false };
}

// Run as CLI only (importing for tests must not execute main()).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => { console.error(`✗ release:product — ${err.message}`); process.exit(1); });
}
