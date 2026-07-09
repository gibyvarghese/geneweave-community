// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm Phase 2 (app) — built-in prompt drift + one-click resync, end to end on a real booted
 * SQLite adapter. Positive (fresh baseline), the operator-edit → customized story, a simulated release
 * that changes a default (stale → adopt / diverged → keep), resync, and idempotency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import { reconcilePromptRealm, sqliteSqlClient, promptDriftReport } from './realm-prompt-drift.js';

describe('Tenancy Realm Phase 2 — prompt drift + resync', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as { prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } };

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-p2-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: a fresh install has every built-in prompt in_sync, one baseline version each', async () => {
    const rep = await db.promptDriftReport();
    expect(rep.summary.in_sync).toBeGreaterThan(0);
    expect(rep.summary.customized + rep.summary.stale + rep.summary.diverged).toBe(0);
    const versions = raw().prepare(`SELECT count(*) c FROM realm_versions WHERE family='prompts'`).get() as { c: number };
    expect(versions.c).toBe(rep.entries.length);
  });

  it('CUSTOMIZED: an operator edit of a built-in is detected even without refreshing content_hash', async () => {
    const target = (await db.promptDriftReport()).entries[0]!;
    // Simulate an admin PUT that changes the template but does NOT recompute content_hash.
    raw().prepare(`UPDATE prompts SET template = template || ' — house rule' WHERE id = ?`).run(target.id);
    const rep = await db.promptDriftReport();
    const e = rep.entries.find((x) => x.id === target.id)!;
    expect(e.state).toBe('customized'); // Local (live hash) != Base, Remote == Base
  });

  it('RESYNC: taking the shipped version returns a customized built-in to in_sync', async () => {
    const before = (await db.promptDriftReport()).entries.find((x) => x.state === 'customized')!;
    const res = await db.resyncPromptToPackage(before.id);
    expect(res.ok).toBe(true);
    const e = (await db.promptDriftReport()).entries.find((x) => x.id === before.id)!;
    expect(e.state).toBe('in_sync');
  });

  it('STALE→ADOPT & DIVERGED→KEEP: a release that changes two defaults', async () => {
    const inSync = (await db.promptDriftReport()).entries.filter((e) => e.state === 'in_sync');
    const [a, b] = [inSync[0]!, inSync[1]!];
    const client = sqliteSqlClient(raw());

    // Operator edits `b` in place (will collide with the release change → diverged).
    raw().prepare(`UPDATE prompts SET template = template || ' — tenant note' WHERE id = ?`).run(b.id);

    // Simulate a NEW release: the package changes the default for BOTH a and b.
    const rowA = raw().prepare(`SELECT * FROM prompts WHERE id = ?`).get(a.id) as Record<string, unknown>;
    const rowB = raw().prepare(`SELECT * FROM prompts WHERE id = ?`).get(b.id) as Record<string, unknown>;
    const releaseDefaults = [
      { ...rowA, template: `${String(rowA['template'])} [v2 shipped改]` },
      { ...rowB, template: `ORIGINAL B v2 shipped` }, // different from both baseline and operator edit
    ];
    const result = await reconcilePromptRealm(client, 'sqlite', releaseDefaults, { at: '2026-06-01T00:00:00Z' });

    const rep = await db.promptDriftReport();
    const ea = rep.entries.find((x) => x.id === a.id)!;
    const eb = rep.entries.find((x) => x.id === b.id)!;
    // `a` was untouched by the operator → stale → adopted → now in_sync with the new shipped default.
    expect(result.adopted).toContain(ea.logicalKey);
    expect(ea.state).toBe('in_sync');
    expect(String((raw().prepare(`SELECT template FROM prompts WHERE id=?`).get(a.id) as { template: string }).template)).toContain('v2 shipped');
    // `b` was edited by the operator AND changed by the release → diverged → operator edit preserved.
    expect(eb.state).toBe('diverged');
    expect(String((raw().prepare(`SELECT template FROM prompts WHERE id=?`).get(b.id) as { template: string }).template)).toContain('tenant note');
  });

  it('IDEMPOTENT: re-running the reconcile with the same defaults is a no-op', async () => {
    const client = sqliteSqlClient(raw());
    const defaults = raw().prepare(`SELECT * FROM prompts WHERE realm='global'`).all() as Record<string, unknown>[];
    // First pass normalises the log to the current content; the SECOND pass with identical defaults
    // must change nothing (content-addressed version log + no adoptions).
    await reconcilePromptRealm(client, 'sqlite', defaults, { at: '2026-06-02T00:00:00Z' });
    const before = (raw().prepare(`SELECT count(*) c FROM realm_versions`).get() as { c: number }).c;
    const r = await reconcilePromptRealm(client, 'sqlite', defaults, { at: '2026-06-03T00:00:00Z' });
    const after = (raw().prepare(`SELECT count(*) c FROM realm_versions`).get() as { c: number }).c;
    expect(r.adopted).toHaveLength(0);
    expect(after).toBe(before);
  });
});
