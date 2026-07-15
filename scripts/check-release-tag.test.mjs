// check-release-tag.test.mjs — tests for the release-tag gate.
//
// Run with:  node --test scripts/check-release-tag.test.mjs
//
// The pure validator is tested directly (SemVer, version match, anti-rollback, injection); the CLI is then run
// in a throwaway git repo with real tags. Dimension (4) high-concurrency is N/A — this is a single-run CI gate;
// in its place we stress the anti-rollback scan over many tags and prove determinism.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { validateReleaseTag } from './check-release-tag.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ── (1) Positive ────────────────────────────────────────────────────────────────────────────
test('a SemVer tag matching the version and newer than all others is valid', () => {
  assert.deepEqual(validateReleaseTag('v1.1.0', '1.1.0', ['v1.0.0', 'v1.1.0']), []);
  assert.deepEqual(validateReleaseTag('v1.0.0', '1.0.0', []), []); // first release
});

// ── (2) Negative / boundaries ───────────────────────────────────────────────────────────────
test('a non-SemVer tag is rejected', () => {
  for (const t of ['foo', 'v1.0', '1.0.0', 'v1.0.0.0', 'v1.0.0-rc.1', '']) {
    const p = validateReleaseTag(t, '1.0.0', []);
    assert.ok(p.some((x) => /not a SemVer release tag/.test(x)), `should reject ${JSON.stringify(t)}`);
  }
});

test('a tag that does not match the product version is rejected', () => {
  const p = validateReleaseTag('v1.1.0', '1.2.0', []);
  assert.ok(p.some((x) => /does not match apps\/geneweave\/package\.json version 1\.2\.0/.test(x)));
});

test('anti-rollback: a tag not newer than an existing one is rejected', () => {
  assert.ok(validateReleaseTag('v1.0.0', '1.0.0', ['v2.0.0']).some((x) => /anti-rollback/.test(x)));
  assert.ok(validateReleaseTag('v1.1.0', '1.1.0', ['v1.0.0', 'v1.2.0']).some((x) => /not newer than existing tag\(s\) v1\.2\.0/.test(x)));
  // a lower patch against a higher existing patch is a rollback
  assert.ok(validateReleaseTag('v1.0.0', '1.0.0', ['v1.0.1']).some((x) => /anti-rollback/.test(x)));
});

test('non-release tags in the list are ignored', () => {
  assert.deepEqual(validateReleaseTag('v2.0.0', '2.0.0', ['nightly', 'v1.0.0', 'release-candidate', 'v1.9.0']), []);
});

// ── (3) Stress + determinism ────────────────────────────────────────────────────────────────
test('anti-rollback scan is fast + deterministic over 10k tags', () => {
  const tags = Array.from({ length: 10000 }, (_, i) => `v1.0.${i}`); // max is v1.0.9999
  const started = Date.now();
  const a = validateReleaseTag('v1.1.0', '1.1.0', tags); // 1.1.0 > all 1.0.x
  const b = validateReleaseTag('v1.1.0', '1.1.0', tags);
  const ms = Date.now() - started;
  assert.deepEqual(a, []);
  assert.deepEqual(a, b);
  assert.ok(ms < 2000, `10k-tag scan took ${ms}ms`);
  console.log(`  stress: two 10k-tag scans in ${ms}ms`);
  // and it correctly catches a rollback against 10k tags
  assert.ok(validateReleaseTag('v1.0.500', '1.0.500', tags).some((x) => /anti-rollback/.test(x)));
});

// ── (5) Security ────────────────────────────────────────────────────────────────────────────
test('injection-y tag is rejected as non-SemVer (no shell metacharacters slip through)', () => {
  for (const t of ['v1.0.0; rm -rf /', 'v1.0.0 && echo hi', 'v1.0.0`whoami`', 'v$(id).0.0']) {
    assert.ok(validateReleaseTag(t, '1.0.0', []).some((x) => /not a SemVer release tag/.test(x)));
  }
});

// ── Integration: run the CLI in a throwaway git repo ────────────────────────────────────────
function makeRepo(version, tags) {
  const dir = mkdtempSync(join(tmpdir(), 'reltag-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'apps', 'geneweave'), { recursive: true });
  for (const f of ['check-product-version.mjs', 'release-product.mjs', 'check-release-tag.mjs']) copyFileSync(join(here, f), join(dir, 'scripts', f));
  writeFileSync(join(dir, 'apps', 'geneweave', 'package.json'), `${JSON.stringify({ name: '@weaveintel/geneweave-api', version }, null, 2)}\n`);
  writeFileSync(join(dir, 'VERSIONING.md'), '# V\n## Current release\n| **' + version + '** | Aertex |\n');
  const g = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'x'); g(['add', '-A']); g(['commit', '-qm', 'init']);
  for (const t of tags) g(['tag', t]);
  return dir;
}
const runTag = (dir, tag) => execFileSync('node', ['scripts/check-release-tag.mjs', tag], { cwd: dir, encoding: 'utf8' });
const fails = (dir, tag) => { try { runTag(dir, tag); return false; } catch { return true; } };

test('INTEGRATION: CLI accepts a valid forward tag, refuses rollback / mismatch / bad tag', () => {
  const dir = makeRepo('1.1.0', ['v1.0.0']);
  try {
    assert.match(runTag(dir, 'v1.1.0'), /release tag v1\.1\.0 is valid/);
    // package.json is 1.1.0, so a v1.0.0 tag both mismatches AND is not newer:
    assert.ok(fails(dir, 'v1.0.0'));
    assert.ok(fails(dir, 'v9')); // not SemVer
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('INTEGRATION: a tag older than an existing release is refused', () => {
  const dir = makeRepo('1.5.0', ['v1.0.0', 'v2.0.0']); // existing v2.0.0 makes any v1.x a rollback
  try {
    assert.ok(fails(dir, 'v1.5.0'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
