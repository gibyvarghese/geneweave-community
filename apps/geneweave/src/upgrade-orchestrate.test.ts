// SPDX-License-Identifier: MIT
/**
 * Tests for the one-click upgrade orchestration helpers (upgrade-orchestrate.ts): the semver bump classifier and
 * the plain-language outcome shaper across every apply status + both edition L2 modes.
 */
import { describe, it, expect } from 'vitest';
import { computeBumpType, describeUpgradeOutcome } from './upgrade-orchestrate.js';
import type { ApplyResult } from './upgrade-apply.js';

describe('computeBumpType', () => {
  it('classifies patch / minor / major moves', () => {
    expect(computeBumpType('1.2.3', '1.2.4')).toBe('patch');
    expect(computeBumpType('1.2.3', '1.3.0')).toBe('minor');
    expect(computeBumpType('1.2.3', '2.0.0')).toBe('major');
  });
  it('handles equal, downgrade, prerelease, and unparseable input', () => {
    expect(computeBumpType('1.2.3', '1.2.3')).toBe('none');
    expect(computeBumpType('2.0.0', '1.9.9')).toBe('downgrade');
    expect(computeBumpType('1.2.3', '1.2.4-rc.1')).toBe('patch'); // prepatch → patch
    expect(computeBumpType('1.2.3-rc.1', '1.2.3-rc.2')).toBe('prerelease');
    expect(computeBumpType('not-semver', '1.0.0')).toBe('unknown');
    expect(computeBumpType('1.0.0', '')).toBe('unknown');
  });
});

describe('describeUpgradeOutcome', () => {
  const merge = { bumpType: 'patch' as const, toVersion: '1.5.0', l2mode: 'merge' as const, codeConflicts: 0 };

  it('succeeded with no code change → no deploy needed', () => {
    const r: ApplyResult = { status: 'succeeded', content: { adopted: 3, published: 0, review: 0 }, schema: { applied: [], deferred: [] } };
    const o = describeUpgradeOutcome(r, merge);
    expect(o.status).toBe('succeeded');
    expect(o.headline).toContain('Upgraded to v1.5.0');
    expect(o.headline).toContain('patch');
    expect(o.needsDeploy).toBe(false);
    expect(o.detail).toContain('3 un-customized items auto-updated');
  });

  it('succeeded with deferred schema (code changed) → deploy needed', () => {
    const r: ApplyResult = { status: 'succeeded', content: { adopted: 1, published: 0, review: 0 }, schema: { applied: [], deferred: ['batch-1'] } };
    const o = describeUpgradeOutcome(r, merge);
    expect(o.needsDeploy).toBe(true);
    expect(o.detail).toContain('Redeploy');
  });

  it('succeeded_with_pending on the community merge path names the code files to merge', () => {
    const r: ApplyResult = { status: 'succeeded_with_pending', pending: 2, content: { adopted: 5, published: 0, review: 2 }, schema: { applied: [], deferred: ['b'] } };
    const o = describeUpgradeOutcome(r, { ...merge, codeConflicts: 2 });
    expect(o.status).toBe('succeeded_with_pending');
    expect(o.detail).toContain('2 code files you changed also changed upstream');
    expect(o.needsDeploy).toBe(true);
    expect(o.pending).toBe(2);
  });

  it('succeeded_with_pending on the locked (enterprise) path talks about review, not code merges', () => {
    const r: ApplyResult = { status: 'succeeded_with_pending', pending: 3, content: { adopted: 10, published: 1, review: 3 } };
    const o = describeUpgradeOutcome(r, { bumpType: 'minor', toVersion: '2.0.0', l2mode: 'locked', codeConflicts: 0 });
    expect(o.detail).toContain('3 items need review');
    expect(o.detail).not.toContain('code file');
  });

  it('surfaces busy / preflight_failed / rolled_back as distinct headlines', () => {
    expect(describeUpgradeOutcome({ status: 'busy' }, merge).headline).toMatch(/already running/i);
    expect(describeUpgradeOutcome({ status: 'preflight_failed' }, merge).headline).toMatch(/blocked by preflight/i);
    expect(describeUpgradeOutcome({ status: 'rolled_back' }, merge).headline).toMatch(/rolled back/i);
  });
});
