// release-product.test.mjs — tests for the one-command product release.
//
// Run with:  node --test scripts/release-product.test.mjs
//
// The pure transforms (version compute, package.json bump, changelog roll, VERSIONING update) are tested directly;
// the whole thing is then exercised end-to-end in a throwaway git repo (git init → run the real script → assert
// the version bumped, the changelog rolled, VERSIONING updated, a commit + annotated tag created). Anti-rollback,
// existing-tag refusal, empty-notes refusal, and injection-safe input are all covered.
//
// Dimension (4) high-concurrency is N/A — this is a single-run local release CLI, not a service. In its place we
// prove the transforms are pure + deterministic under many parallel calls, and idempotent (a re-run refuses).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  computeNext, semverCompare, bumpPackageJson, rollChangelog, updateVersioningCurrentRelease, parseArgs,
} from './release-product.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────
const VERSIONING = `# geneWeave Versioning
## Current release

| Version | Codename | Editions |
|---------|----------|----------|
| **1.0.0** | Aertex | community + private (same version line) |

## Enforcement
guard stuff
`;
const changelog = (unreleased) => `# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

${unreleased}

## [1.0.0] — Aertex

Initial GA.
`;

// ── (1) Positive / pure transforms ─────────────────────────────────────────────────────────────
test('computeNext bumps patch/minor/major', () => {
  assert.equal(computeNext('1.2.3', 'patch'), '1.2.4');
  assert.equal(computeNext('1.2.3', 'minor'), '1.3.0');
  assert.equal(computeNext('1.2.3', 'major'), '2.0.0');
});

test('semverCompare orders versions', () => {
  assert.ok(semverCompare('1.1.0', '1.0.9') > 0);
  assert.equal(semverCompare('2.0.0', '2.0.0'), 0);
  assert.ok(semverCompare('1.0.0', '1.0.1') < 0);
});

test('bumpPackageJson changes only the version, preserving formatting', () => {
  const src = '{\n  "name": "x",\n  "version": "1.0.0",\n  "deps": { "a": "^2.0.0" }\n}\n';
  const out = bumpPackageJson(src, '1.1.0');
  assert.equal(JSON.parse(out).version, '1.1.0');
  assert.match(out, /"deps": \{ "a": "\^2\.0\.0" \}/); // untouched
  assert.equal(out.split('\n').length, src.split('\n').length); // formatting preserved
});

test('rollChangelog moves Unreleased into a dated version section + resets Unreleased', () => {
  const { text, notes } = rollChangelog(changelog('- added skills autofill'), '1.1.0', 'Aertex', '2026-07-16');
  assert.equal(notes, '- added skills autofill');
  assert.match(text, /## \[Unreleased\]\s*\n\s*\n_Nothing yet\._/);
  assert.match(text, /## \[1\.1\.0\] — Aertex — 2026-07-16\s*\n\s*\n- added skills autofill/);
  // the new section sits above the previous one
  assert.ok(text.indexOf('## [1.1.0]') < text.indexOf('## [1.0.0]'));
});

test('updateVersioningCurrentRelease swaps version + codename, keeps editions cell', () => {
  const out = updateVersioningCurrentRelease(VERSIONING, '2.0.0', 'Batiste');
  assert.match(out, /\| \*\*2\.0\.0\*\* \| Batiste \| community \+ private \(same version line\) \|/);
  assert.doesNotMatch(out, /\*\*1\.0\.0\*\*/);
});

test('parseArgs reads bump, --set, and flags', () => {
  assert.deepEqual(parseArgs(['minor', '--dry-run']), { bump: 'minor', set: null, dryRun: true, push: false, allowEmptyNotes: false });
  assert.deepEqual(parseArgs(['--set', '3.1.4', '--push']), { bump: null, set: '3.1.4', dryRun: false, push: true, allowEmptyNotes: false });
});

// ── (2) Negative / boundaries ───────────────────────────────────────────────────────────────
test('computeNext rejects bad version / bump', () => {
  assert.throws(() => computeNext('1.0', 'patch'), /not valid SemVer/);
  assert.throws(() => computeNext('1.0.0', 'sideways'), /unknown bump/);
});

test('bumpPackageJson throws when there is no version field', () => {
  assert.throws(() => bumpPackageJson('{"name":"x"}', '1.0.0'), /no "version" field/);
});

test('rollChangelog throws without an Unreleased section', () => {
  assert.throws(() => rollChangelog('# Changelog\n## [1.0.0]\n', '1.1.0', 'Aertex', '2026-07-16'), /no "## \[Unreleased\]"/);
});

test('updateVersioningCurrentRelease throws when the row is absent', () => {
  assert.throws(() => updateVersioningCurrentRelease('# no current release row', '1.1.0', 'Aertex'), /Current release" row/);
});

// ── (3) Stress / determinism (concurrency is N/A for a single-run CLI) ──────────────────────
test('transforms are pure + deterministic under many parallel calls', async () => {
  const N = 5000;
  const results = await Promise.all(Array.from({ length: N }, () => Promise.resolve(
    rollChangelog(changelog('- x'), '1.1.0', 'Aertex', '2026-07-16').text,
  )));
  assert.equal(new Set(results).size, 1, 'same input must yield identical output every time');
});

test('rolling a chain of releases keeps a valid, ordered changelog', () => {
  let md = changelog('- one');
  for (const [v, note] of [['1.1.0', '- two'], ['1.2.0', '- three'], ['2.0.0', '- four']]) {
    md = rollChangelog(md.replace('_Nothing yet._', note), v, v.startsWith('2') ? 'Batiste' : 'Aertex', '2026-07-16').text;
  }
  assert.ok(md.indexOf('## [2.0.0]') < md.indexOf('## [1.2.0]'));
  assert.ok(md.indexOf('## [1.2.0]') < md.indexOf('## [1.1.0]'));
  assert.match(md, /## \[2\.0\.0\] — Batiste/);
});

// ── Integration: run the REAL script in a throwaway git repo ────────────────────────────────
function makeRepo(unreleased = '- shipped a new skill') {
  const dir = mkdtempSync(join(tmpdir(), 'relprod-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'apps', 'geneweave'), { recursive: true });
  copyFileSync(join(here, 'check-product-version.mjs'), join(dir, 'scripts', 'check-product-version.mjs'));
  copyFileSync(join(here, 'release-product.mjs'), join(dir, 'scripts', 'release-product.mjs'));
  writeFileSync(join(dir, 'apps', 'geneweave', 'package.json'), `${JSON.stringify({ name: '@weaveintel/geneweave-api', version: '1.0.0' }, null, 2)}\n`);
  writeFileSync(join(dir, 'VERSIONING.md'), VERSIONING);
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog(unreleased));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']); g(['config', 'user.email', 't@t.test']); g(['config', 'user.name', 'T']);
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  return dir;
}
// PEER_PRODUCT_VERSION keeps the run hermetic: in the private edition the guard's PEER is set, and without this
// the script would make a live network peer-fetch. The value is only used for an advisory warning, never fatal.
const run = (dir, args, opts = {}) => execFileSync('node', ['scripts/release-product.mjs', ...args], {
  cwd: dir, encoding: 'utf8', ...opts, env: { ...process.env, PEER_PRODUCT_VERSION: '0.0.0', ...(opts.env ?? {}) },
});
const readVer = (dir) => JSON.parse(readFileSync(join(dir, 'apps', 'geneweave', 'package.json'), 'utf8')).version;
const tags = (dir) => execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim();

test('INTEGRATION: --set bumps version, rolls changelog, updates VERSIONING, commits + tags', () => {
  const dir = makeRepo();
  try {
    const out = run(dir, ['--set', '1.1.0']);
    assert.match(out, /1\.0\.0 → 1\.1\.0 "Aertex"/);
    assert.equal(readVer(dir), '1.1.0');
    assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## \[1\.1\.0\] — Aertex/);
    assert.match(readFileSync(join(dir, 'VERSIONING.md'), 'utf8'), /\*\*1\.1\.0\*\* \| Aertex/);
    assert.equal(tags(dir), 'v1.1.0');
    // a commit was made (HEAD subject)
    assert.match(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' }), /release: v1\.1\.0 "Aertex"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('INTEGRATION: major bump advances the fabric codename', () => {
  const dir = makeRepo();
  try {
    run(dir, ['major']);
    assert.equal(readVer(dir), '2.0.0');
    assert.match(readFileSync(join(dir, 'VERSIONING.md'), 'utf8'), /\*\*2\.0\.0\*\* \| Batiste/);
    assert.equal(tags(dir), 'v2.0.0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('INTEGRATION: --dry-run writes nothing and creates no tag', () => {
  const dir = makeRepo();
  try {
    run(dir, ['minor', '--dry-run']);
    assert.equal(readVer(dir), '1.0.0');
    assert.equal(tags(dir), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('INTEGRATION: anti-rollback + existing-tag + empty-notes are refused (exit 1, no mutation)', () => {
  const dir = makeRepo('_Nothing yet._');
  const fails = (args) => {
    try { run(dir, args, { stdio: 'pipe' }); return false; } catch { return true; }
  };
  try {
    assert.ok(fails(['--set', '0.9.0']), 'downgrade refused');       // anti-rollback
    assert.ok(fails(['patch']), 'empty notes refused');             // Unreleased is "_Nothing yet._"
    assert.equal(readVer(dir), '1.0.0');                            // nothing changed
    assert.equal(tags(dir), '');
    // with --allow-empty-notes it proceeds
    run(dir, ['patch', '--allow-empty-notes']);
    assert.equal(readVer(dir), '1.0.1');
    // re-running the same version now refuses (tag exists)
    assert.ok(fails(['--set', '1.0.1', '--allow-empty-notes']), 'existing tag refused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── (5) Security ────────────────────────────────────────────────────────────────────────────
test('INTEGRATION: injection-y --set is rejected as non-SemVer before any git runs', () => {
  const dir = makeRepo();
  try {
    let threw = false;
    try { run(dir, ['--set', '1.2.0; touch HACKED'], { stdio: 'pipe' }); } catch { threw = true; }
    assert.ok(threw, 'must reject');
    assert.equal(tags(dir), '');                                    // no tag created
    assert.equal(readVer(dir), '1.0.0');                            // no mutation
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
