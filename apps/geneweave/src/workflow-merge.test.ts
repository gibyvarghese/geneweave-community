// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — structured workflow (node/edge) merge tests. Covers the per-node three-way outcomes:
 * adopt untouched, keep customised, coexist added-both-sides, per-node conflict, and removal semantics —
 * including that tenant work is never silently lost.
 */
import { describe, it, expect } from 'vitest';
import { mergeWorkflowSteps, parseSteps, structuredFieldsFor } from './workflow-merge.js';
import { autoMerge, type ThreeWayDiff } from './realm-diff.js';

const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe('Upgrade Engine — workflow structured merge', () => {
  it('parseSteps tolerates JSON strings, arrays, and junk', () => {
    expect(parseSteps(JSON.stringify([s('a')]))).toEqual([s('a')]);
    expect(parseSteps([s('a')])).toEqual([s('a')]);
    expect(parseSteps('not json')).toEqual([]);
    expect(parseSteps({ not: 'array' })).toEqual([]);
    expect(parseSteps([{ noId: true }, s('ok')])).toEqual([s('ok')]); // idless nodes dropped
  });

  it('POSITIVE: adopts an untouched node the release changed; keeps a node the tenant customised', () => {
    const base = [s('a', { label: 'A' }), s('b', { label: 'B' })];
    const local = [s('a', { label: 'A' }), s('b', { label: 'B-tenant' })]; // tenant edited b
    const remote = [s('a', { label: 'A2' }), s('b', { label: 'B' })];       // release changed a
    const { steps, conflicts } = mergeWorkflowSteps(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(steps.find((x) => x.id === 'a')!['label']).toBe('A2');       // adopted release's a
    expect(steps.find((x) => x.id === 'b')!['label']).toBe('B-tenant'); // kept tenant's b
  });

  it('POSITIVE: a vendor-added node and a tenant-added node coexist', () => {
    const base = [s('a')];
    const local = [s('a'), s('t', { by: 'tenant' })];   // tenant added t
    const remote = [s('a'), s('v', { by: 'vendor' })];  // release added v
    const { steps, conflicts } = mergeWorkflowSteps(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(steps.map((x) => x.id).sort()).toEqual(['a', 't', 'v']);
  });

  it('NEGATIVE (conflict): both change the same node differently → per-node conflict, local kept', () => {
    const base = [s('a', { n: 0 })];
    const local = [s('a', { n: 1 })];
    const remote = [s('a', { n: 2 })];
    const { steps, conflicts } = mergeWorkflowSteps(base, local, remote);
    expect(conflicts).toEqual([{ id: 'a', reason: 'both_changed' }]);
    expect(steps.find((x) => x.id === 'a')!['n']).toBe(1); // local kept, never lost
  });

  it('removal semantics: untouched removal honoured; edit-vs-remove is a conflict (work kept)', () => {
    // remote removes b (tenant untouched) → honoured; remote removes c (tenant edited) → conflict keeps c
    const base = [s('a'), s('b'), s('c', { v: 0 })];
    const local = [s('a'), s('b'), s('c', { v: 1 })]; // tenant edited c
    const remote = [s('a')];                           // release removed b and c
    const { steps, conflicts } = mergeWorkflowSteps(base, local, remote);
    expect(steps.map((x) => x.id).sort()).toEqual(['a', 'c']); // b honoured-removed, c kept
    expect(conflicts).toEqual([{ id: 'c', reason: 'edit_vs_remove' }]);
  });

  it('no-op: identical graphs merge to themselves with no conflicts (edge wiring preserved)', () => {
    const g = [s('a', { next: 'b' }), s('b', { next: null })];
    const { steps, conflicts } = mergeWorkflowSteps(g, g, g);
    expect(conflicts).toEqual([]);
    expect(steps).toEqual(g); // outgoing-edge wiring (next) preserved verbatim
  });

  it('order is stable: base order, then local additions, then remote additions', () => {
    const base = [s('a'), s('b')];
    const local = [s('a'), s('b'), s('l')];
    const remote = [s('b'), s('a'), s('r')]; // reordered + added r
    const { steps } = mergeWorkflowSteps(base, local, remote);
    expect(steps.map((x) => x.id)).toEqual(['a', 'b', 'l', 'r']);
  });

  it('INTEGRATION: realm-diff autoMerge uses the structured merger to resolve a steps conflict per node', () => {
    // A steps field that changed on BOTH sides in DIFFERENT nodes → atomically a 'conflict', but per-node
    // it resolves cleanly (vendor added a node; tenant edited a different one).
    const base = JSON.stringify([s('a', { w: 0 }), s('b', { w: 0 })]);
    const local = JSON.stringify([s('a', { w: 1 }), s('b', { w: 0 })]);              // tenant edited a
    const remote = JSON.stringify([s('a', { w: 0 }), s('b', { w: 0 }), s('v')]);     // vendor added v
    // autoMerge only reads `.fields`; the rest of ThreeWayDiff is irrelevant here, so cast a minimal shape.
    const diff = { fields: [{ field: 'steps', base, local, remote, status: 'conflict' as const, resolved: local }], conflicts: ['steps'] } as unknown as ThreeWayDiff;
    // Without the structured merger: the field stays a conflict (atomic).
    expect(autoMerge(diff).conflicts).toEqual(['steps']);
    // With it: the node graph merges, no conflict, and both changes survive.
    const merged = autoMerge(diff, structuredFieldsFor('workflows'));
    expect(merged.conflicts).toEqual([]);
    const steps = parseSteps(merged.merged['steps']);
    expect(steps.find((x) => x.id === 'a')!['w']).toBe(1);          // tenant edit kept
    expect(steps.map((x) => x.id)).toContain('v');                  // vendor node added
  });

  it('STRESS: 2,000-node graphs merge deterministically', () => {
    const base = Array.from({ length: 2000 }, (_, i) => s(`n${i}`, { w: 0 }));
    const local = base.map((n) => (n.id === 'n5' ? s('n5', { w: 1 }) : n));       // tenant edits one
    const remote = base.map((n) => (n.id === 'n9' ? s('n9', { w: 2 }) : n));      // release edits another
    const { steps, conflicts } = mergeWorkflowSteps(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(steps.length).toBe(2000);
    expect(steps.find((x) => x.id === 'n5')!['w']).toBe(1);
    expect(steps.find((x) => x.id === 'n9')!['w']).toBe(2);
  });
});
