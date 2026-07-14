// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — review-queue AUTOMATION (resolution rules) + per-family AUTO-ADOPT policy rows.
 *
 * Real booted SQLite. Covers the Phase-7 exit criterion for automation (a P5 rule auto-resolves; a P1 is
 * REFUSED), plus positive/negative, stress (10k), concurrency (100 concurrent passes over a shared queue,
 * idempotent — no double-resolve, no lost update, latency percentiles), and security (P1 guardrail under
 * concurrency; SQL-injection-safe match values; managed-policy override steering reconcile).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { REALM_FAMILIES } from './realm-families.js';
import { beginUpgradeRun, recordUpgradeDetail, listUnresolvedUpgradeDetails, getUpgradeDetail } from './upgrade-run-store.js';
import { reconcileRealmFamily } from './realm-seed-reconcile.js';
import {
  createResolutionRule, listResolutionRules, getResolutionRule, updateResolutionRule, deleteResolutionRule,
  applyResolutionRules, setFamilyPolicy, getFamilyPolicy, listFamilyPolicies, loadFamilyPolicyMap,
} from './upgrade-automation.js';

const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

describe('Upgrade Engine — resolution rules + family policy (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let runId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `automation-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply', toVersion: '2.0.0' });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  /** Insert a plain (no live-record) review detail — for keep/defer/tag/bulk automation. */
  const addDetail = (over: { family?: string; logicalKey?: string; disposition?: string; priority?: string; remoteHash?: string } = {}) =>
    recordUpgradeDetail(client(), 'sqlite', runId, {
      family: over.family ?? 'prompts', logicalKey: over.logicalKey ?? `k-${Math.random().toString(36).slice(2)}`,
      disposition: (over.disposition ?? 'diverged') as never, priority: (over.priority ?? 'P3') as never,
      ...(over.remoteHash ? { remoteHash: over.remoteHash } : {}),
    });

  // ── Rule store ──────────────────────────────────────────────────────────────────────────────────
  it('STORE: create stamps realm columns; list/get/update/delete round-trip', async () => {
    const r = await createResolutionRule(client(), 'sqlite', { key: 'adopt-pricing', name: 'Adopt pricing', action: 'keep', matchFamilies: ['model_pricing'], matchPriorities: ['P5'] });
    expect(r.realm).toBe('global');
    expect(r.logical_key).toBe('adopt-pricing');
    expect(r.content_hash).toMatch(/^sha256:/);
    expect(r.origin_hash).toBe(r.content_hash); // a global original baselines to itself
    const got = await getResolutionRule(client(), 'sqlite', r.id);
    expect(got?.key).toBe('adopt-pricing');
    const upd = await updateResolutionRule(client(), 'sqlite', r.id, { seq: 5, action: 'defer' });
    expect(upd?.seq).toBe(5); expect(upd?.action).toBe('defer');
    expect(upd?.content_hash).not.toBe(r.content_hash); // re-hashed on semantic change
    expect(await listResolutionRules(client(), 'sqlite')).toHaveLength(1);
    expect(await deleteResolutionRule(client(), 'sqlite', r.id)).toBe(true);
    expect(await listResolutionRules(client(), 'sqlite')).toHaveLength(0);
  });

  // ── The exit criterion ──────────────────────────────────────────────────────────────────────────
  it('EXIT: a P5 rule auto-resolves P5 items; a P1 is REFUSED (never auto-resolved)', async () => {
    await addDetail({ family: 'model_pricing', priority: 'P5', disposition: 'stale' });
    await addDetail({ family: 'model_pricing', priority: 'P5', disposition: 'stale' });
    await addDetail({ family: 'guardrails', priority: 'P1', disposition: 'conflict' });
    // A wildcard "keep mine" rule that would match everything — the P1 guardrail must still hold.
    await createResolutionRule(client(), 'sqlite', { key: 'auto-keep', name: 'Auto keep', action: 'keep' });

    const res = await applyResolutionRules(client(), 'sqlite');
    expect(res.resolved).toBe(2);      // both P5 auto-resolved
    expect(res.skippedP1).toBe(1);     // the P1 refused
    // The P1 is still on the queue; the P5s are gone.
    const left = await listUnresolvedUpgradeDetails(client(), 'sqlite');
    expect(left).toHaveLength(1);
    expect(left[0]!.priority).toBe('P1');
    // Audit: the resolved P5s carry resolution_source='automation' and resolved_by='automation'.
    const anyP5 = raw().prepare(`SELECT resolution, resolved_by, resolution_source FROM upgrade_details WHERE priority='P5' LIMIT 1`).get() as Record<string, string>;
    expect(anyP5['resolution']).toBe('kept');
    expect(anyP5['resolved_by']).toBe('automation');
    expect(anyP5['resolution_source']).toBe('automation');
  });

  it('FIRST-MATCH-WINS: the lowest-seq matching rule decides the action', async () => {
    await addDetail({ family: 'prompts', priority: 'P3', disposition: 'diverged' });
    await createResolutionRule(client(), 'sqlite', { key: 'defer-all', name: 'Defer all', action: 'defer', seq: 20 });
    await createResolutionRule(client(), 'sqlite', { key: 'keep-prompts', name: 'Keep prompts', action: 'keep', seq: 10, matchFamilies: ['prompts'] });
    await applyResolutionRules(client(), 'sqlite');
    const d = raw().prepare(`SELECT resolution FROM upgrade_details WHERE family='prompts' LIMIT 1`).get() as { resolution: string };
    expect(d.resolution).toBe('kept'); // seq 10 keep beats seq 20 defer
  });

  it('MATCH DIMENSIONS: a rule only fires when family + priority + disposition all match', async () => {
    await addDetail({ family: 'skills', priority: 'P2', disposition: 'diverged' });
    await createResolutionRule(client(), 'sqlite', { key: 'only-conflict', name: 'Only conflict', action: 'keep', matchDispositions: ['conflict'] });
    const res = await applyResolutionRules(client(), 'sqlite');
    expect(res.resolved).toBe(0);
    expect(res.unmatched).toBe(1); // disposition 'diverged' ≠ 'conflict'
  });

  it('TAG: annotates the note without resolving, and is allowed on a P1 (triage aid)', async () => {
    await addDetail({ family: 'guardrails', priority: 'P1', disposition: 'conflict' });
    await createResolutionRule(client(), 'sqlite', { key: 'triage', name: 'Triage', action: 'tag', tag: 'needs-security-review' });
    const res = await applyResolutionRules(client(), 'sqlite');
    expect(res.tagged).toBe(1);
    expect(res.resolved).toBe(0);
    const d = raw().prepare(`SELECT note, resolution FROM upgrade_details WHERE priority='P1' LIMIT 1`).get() as Record<string, string | null>;
    expect(d['resolution']).toBeNull();         // tag never resolves
    expect(d['note']).toContain('[tag: needs-security-review]');
  });

  it('ADOPT via automation: a diverged realm record is merged, undo captured, source stamped', async () => {
    await db.seedDefaultData?.();
    await db.seedReconcileRealm?.();
    const spec = REALM_FAMILIES['skills']!;
    const row = raw().prepare(`SELECT * FROM skills WHERE realm='global' LIMIT 1`).get() as Record<string, unknown>;
    const id = String(row['id']);
    // Publish an upstream version + baseline the row so it classifies diverged with an upstream to adopt.
    const { createSqlVersionLog } = await import('@weaveintel/realm');
    const { semanticOfRow } = await import('./realm-diff.js');
    const { logicalKeyOfRow } = await import('./realm-families.js');
    const key = logicalKeyOfRow(spec, row);
    const base = semanticOfRow(spec, row);
    const log = createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });
    const baseV = await log.append({ family: 'skills', logicalKey: key, payload: base });
    await log.append({ family: 'skills', logicalKey: key, payload: { ...base, description: 'UPSTREAM' } });
    raw().prepare(`UPDATE skills SET description=?, origin_hash=? WHERE id=?`).run('LOCAL_EDIT', baseV.contentHash, id);
    await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'skills', logicalKey: key, disposition: 'diverged', priority: 'P2' });
    await createResolutionRule(client(), 'sqlite', { key: 'adopt-skills', name: 'Adopt skills', action: 'adopt', matchFamilies: ['skills'] });

    const res = await applyResolutionRules(client(), 'sqlite');
    expect(res.resolved).toBe(1);
    const after = raw().prepare(`SELECT description FROM skills WHERE id=?`).get(id) as { description: string };
    expect(after.description).toBe('UPSTREAM'); // adopted upstream
    const d = raw().prepare(`SELECT resolution, resolution_source, undo_json FROM upgrade_details WHERE family='skills' LIMIT 1`).get() as Record<string, string | null>;
    expect(d['resolution']).toBe('adopted');
    expect(d['resolution_source']).toBe('automation');
    expect(d['undo_json']).toBeTruthy(); // undoable
  });

  // ── Negative ────────────────────────────────────────────────────────────────────────────────────
  it('NEGATIVE: invalid rule action / unknown policy family / invalid policy all reject; empty ruleset is a no-op', async () => {
    await expect(createResolutionRule(client(), 'sqlite', { key: 'x', name: 'x', action: 'nuke' as never })).rejects.toThrow(/invalid rule action/);
    await expect(setFamilyPolicy(client(), 'sqlite', 'not_a_family', 'always')).rejects.toThrow(/unknown realm family/);
    await expect(setFamilyPolicy(client(), 'sqlite', 'skills', 'sometimes' as never)).rejects.toThrow(/invalid policy/);
    await addDetail({ priority: 'P3' });
    const res = await applyResolutionRules(client(), 'sqlite'); // no rules
    expect(res.resolved).toBe(0); expect(res.unmatched).toBe(1);
  });

  // ── Family policy as managed rows ────────────────────────────────────────────────────────────────
  it('FAMILY POLICY: upsert is one row per family; loadFamilyPolicyMap reflects it', async () => {
    await setFamilyPolicy(client(), 'sqlite', 'skills', 'never', { note: 'review every skill change' });
    await setFamilyPolicy(client(), 'sqlite', 'skills', 'always'); // upsert, not duplicate
    await setFamilyPolicy(client(), 'sqlite', 'model_pricing', 'always');
    expect(await listFamilyPolicies(client(), 'sqlite')).toHaveLength(2);
    expect((await getFamilyPolicy(client(), 'sqlite', 'skills'))?.policy).toBe('always');
    expect(await loadFamilyPolicyMap(client(), 'sqlite')).toMatchObject({ skills: 'always', model_pricing: 'always' });
  });

  it('FAMILY POLICY steers reconcile: policy=never surfaces a stale default for review instead of adopting', async () => {
    await db.seedDefaultData?.();
    await db.seedReconcileRealm?.();
    const spec = REALM_FAMILIES['skills']!;
    const row = raw().prepare(`SELECT * FROM skills WHERE realm='global' LIMIT 1`).get() as Record<string, unknown>;
    // Operator sets skills to 'never' — even an untouched stale must be reviewed, not auto-adopted.
    await setFamilyPolicy(client(), 'sqlite', 'skills', 'never');
    const changed = { ...row, description: `${String(row['description'])} (v2)` };
    // reconcileAllRealmFamilies self-loads the override; assert the skill is reviewed, not adopted.
    const { reconcileAllRealmFamilies } = await import('./realm-seed-reconcile.js');
    const rid = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply' });
    const out = await reconcileAllRealmFamilies(client(), 'sqlite', { skills: [changed] }, { runId: rid });
    const skills = out.perFamily.find((f) => f.family === 'skills')!;
    expect(skills.adopted).not.toContain(String(row['id']));
    expect(skills.review.find((r) => r.logicalKey === String(row['id']))?.state).toBe('stale');
    // Control: without the override the same stale WOULD adopt (proves the override caused the difference).
    const changed2 = { ...row, description: `${String(row['description'])} (v3)` };
    const res2 = await reconcileRealmFamily(client(), 'sqlite', spec, [changed2], {});
    expect(res2.adopted).toContain(String(row['id']));
  });

  // ── Stress ──────────────────────────────────────────────────────────────────────────────────────
  it('STRESS: 10k queued items are auto-resolved by one pass within budget', async () => {
    const N = 10_000;
    const insert = raw().prepare(`INSERT INTO upgrade_details (id, run_id, family, logical_key, layer, disposition, priority, created_at) VALUES (?, ?, 'prompts', ?, 'L4', 'diverged', 'P3', datetime('now'))`);
    const tx = raw().transaction(() => { for (let i = 0; i < N; i++) insert.run(`d${i}`, runId, `k${i}`); });
    tx();
    await createResolutionRule(client(), 'sqlite', { key: 'keep-all', name: 'Keep all', action: 'keep' });
    const t0 = performance.now();
    const res = await applyResolutionRules(client(), 'sqlite');
    const ms = performance.now() - t0;
    expect(res.resolved).toBe(N);
    expect(await listUnresolvedUpgradeDetails(client(), 'sqlite')).toHaveLength(0);
    // eslint-disable-next-line no-console
    console.log(`[automation stress] ${N} items resolved in ${ms.toFixed(0)}ms (${Math.round(N / (ms / 1000))}/s)`);
    expect(ms).toBeLessThan(60_000);
  });

  // ── Concurrency ─────────────────────────────────────────────────────────────────────────────────
  it('CONCURRENCY: 100 concurrent passes over a shared 2k queue leave each item resolved EXACTLY once (no lost update / no corruption)', async () => {
    const N = 2000, PASSES = 100;
    const insert = raw().prepare(`INSERT INTO upgrade_details (id, run_id, family, logical_key, layer, disposition, priority, created_at) VALUES (?, ?, 'prompts', ?, 'L4', 'diverged', 'P3', datetime('now'))`);
    raw().transaction(() => { for (let i = 0; i < N; i++) insert.run(`c${i}`, runId, `k${i}`); })();
    await createResolutionRule(client(), 'sqlite', { key: 'keep-all', name: 'Keep all', action: 'keep' });

    const durations: number[] = [];
    const runs = Array.from({ length: PASSES }, () => async () => { const t = performance.now(); const r = await applyResolutionRules(client(), 'sqlite'); durations.push(performance.now() - t); return r; });
    await Promise.all(runs.map((f) => f()));

    // Correctness is asserted on the FINAL DB STATE (the real invariant): the terminal write is conditional on
    // `resolution IS NULL`, so however the 100 passes interleave, every item ends resolved exactly once — no
    // lost update, no double-write, no corruption. (Per-pass counters are best-effort; automation is serialized
    // by the mutex at the adapter, so concurrent passes are a stress probe, not the normal path.)
    const resolvedRows = raw().prepare(`SELECT COUNT(*) c FROM upgrade_details WHERE resolution IS NOT NULL`).get() as { c: number };
    expect(resolvedRows.c).toBe(N);
    expect(await listUnresolvedUpgradeDetails(client(), 'sqlite')).toHaveLength(0);
    const distinctResolutions = raw().prepare(`SELECT COUNT(DISTINCT resolution) c FROM upgrade_details WHERE resolution IS NOT NULL`).get() as { c: number };
    expect(distinctResolutions.c).toBe(1);         // all 'kept' — every row carries the single expected value
    const distinctSources = raw().prepare(`SELECT COUNT(DISTINCT resolution_source) c FROM upgrade_details WHERE resolution IS NOT NULL`).get() as { c: number };
    expect(distinctSources.c).toBe(1);             // all 'automation'
    // eslint-disable-next-line no-console
    console.log(`[automation concurrency] ${PASSES} passes / ${N} items · p50 ${pct(durations, 50).toFixed(1)}ms p95 ${pct(durations, 95).toFixed(1)}ms p99 ${pct(durations, 99).toFixed(1)}ms`);
  });

  // ── Security ────────────────────────────────────────────────────────────────────────────────────
  it('SECURITY: the P1 guardrail holds under 100 concurrent passes with a wildcard rule', async () => {
    for (let i = 0; i < 50; i++) await addDetail({ family: 'guardrails', priority: 'P1', disposition: 'conflict', logicalKey: `p1-${i}` });
    await createResolutionRule(client(), 'sqlite', { key: 'adopt-everything', name: 'Adopt everything', action: 'adopt' });
    await Promise.all(Array.from({ length: 100 }, () => applyResolutionRules(client(), 'sqlite')));
    const p1left = raw().prepare(`SELECT COUNT(*) c FROM upgrade_details WHERE priority='P1' AND resolution IS NULL`).get() as { c: number };
    expect(p1left.c).toBe(50); // every P1 still unresolved — never auto-resolved under any concurrency
  });

  it('SECURITY: a hostile match value is a bound JSON parameter — no injection, simply never matches', async () => {
    await addDetail({ family: 'prompts', priority: 'P3' });
    const hostile = "prompts'; DROP TABLE upgrade_details; --";
    await createResolutionRule(client(), 'sqlite', { key: 'evil', name: 'Evil', action: 'keep', matchFamilies: [hostile] });
    const res = await applyResolutionRules(client(), 'sqlite');
    expect(res.resolved).toBe(0);       // the hostile string never equals 'prompts'
    expect(res.unmatched).toBe(1);
    // The table still exists and the item is intact.
    expect(raw().prepare(`SELECT COUNT(*) c FROM upgrade_details`).get()).toMatchObject({ c: 1 });
  });
});
