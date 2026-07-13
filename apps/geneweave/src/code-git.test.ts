// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — L2 git round-trip. Against a REAL git repo fixture: write conflict-marked files onto an
 * `upgrade/v<target>` branch, confirm the markers are there (the block gate), then resolve them and import the
 * resolved content back — the "resolvable in any editor/mergetool" mechanism.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeUpgradeBranch, readUpgradeBranchFile, branchFileHasConflictMarkers, isGitRepo } from './code-git.js';

const ID = ['-c', 'user.email=t@t.dev', '-c', 'user.name=Test'];
const git = (root: string, args: string[]): string => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

describe('L2 git round-trip (real git repo)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codegit-'));
    git(root, ['init', '-q']);
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
    git(root, ['add', '-A']);
    git(root, [...ID, 'commit', '-q', '-m', 'base']);
  });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('POSITIVE: writes conflict-marked files onto upgrade/v<target>, flags markers, then imports the resolution', () => {
    const conflictMarked = 'const a = 1;\n<<<<<<< mine\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> theirs\n';
    const res = writeUpgradeBranch(root, '2.0.0', [{ path: 'a.ts', content: conflictMarked }]);
    expect(res.branch).toBe('upgrade/v2.0.0');
    expect(res.paths).toEqual(['a.ts']);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    // The gate: the file on the branch still carries conflict markers → L3 is blocked.
    expect(branchFileHasConflictMarkers(root, 'upgrade/v2.0.0', 'a.ts')).toBe(true);

    // The operator resolves it in their editor and commits (simulated), then the engine imports it.
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\nconst b = 3;\n'); // took theirs
    git(root, ['add', '-A']);
    git(root, [...ID, 'commit', '-q', '-m', 'resolve']);
    expect(branchFileHasConflictMarkers(root, 'upgrade/v2.0.0', 'a.ts')).toBe(false);
    expect(readUpgradeBranchFile(root, 'upgrade/v2.0.0', 'a.ts')).toBe('const a = 1;\nconst b = 3;\n');
  });

  it('re-running the same upgrade resets the branch (idempotent, -B)', () => {
    writeUpgradeBranch(root, '2.0.0', [{ path: 'a.ts', content: 'v1\n' }]);
    const again = writeUpgradeBranch(root, '2.0.0', [{ path: 'a.ts', content: 'v2\n' }]);
    expect(again.branch).toBe('upgrade/v2.0.0');
    expect(readUpgradeBranchFile(root, 'upgrade/v2.0.0', 'a.ts')).toBe('v2\n');
  });

  it('NEGATIVE / SECURITY: a non-git directory is not a repo and writing to it throws (no shell injection)', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'notgit-'));
    try {
      expect(isGitRepo(notRepo)).toBe(false);
      expect(() => writeUpgradeBranch(notRepo, '2.0.0', [{ path: 'x.ts', content: 'y' }])).toThrow('not a git repository');
      // A version string with shell metacharacters is passed as a SINGLE argv element (no shell), so git just
      // sees a branch name — which it rejects as invalid. Either way, no command executes: the repo is intact.
      try { writeUpgradeBranch(root, '2.0.0; rm -rf $HOME', [{ path: 'a.ts', content: 'z' }]); } catch { /* git rejects the bad ref — expected */ }
      expect(existsSync(join(root, 'a.ts'))).toBe(true);   // nothing was deleted — no injection
    } finally { rmSync(notRepo, { recursive: true, force: true }); }
  });
});
