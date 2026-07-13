// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — L2 code baseline store + review integration, on real booted SQLite. Covers capture/status,
 * recording code changes as L2 review items that flow through the SAME review queue (keep/defer/bulk with the
 * P1 guardrail; adopt correctly refused for code), and CONCURRENCY under contention: 1,000 concurrent resolves
 * of distinct items (no lost updates) + many concurrent resolves of the SAME item (idempotent, no corruption),
 * with throughput + p50/p95/p99.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { beginUpgradeRun, recordUpgradeDetail, getUpgradeDetail } from './upgrade-run-store.js';
import { getReviewQueue, resolveReviewItem, bulkResolveReview } from './upgrade-review.js';
import { captureCodeBaseline, runCodeStatus, runCodeScan } from './code-baseline-store.js';

const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0; };

describe('L2 code baseline store + review queue (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let root: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `codestore-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    root = mkdtempSync(join(tmpdir(), 'codestore-src-'));
  });
  afterEach(async () => {
    await db?.close?.();
    for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('POSITIVE: capture a baseline, edit the tree, and code status detects the edits/adds/removes', async () => {
    writeFileSync(join(root, 'keep.ts'), 'const a = 1;\n');
    writeFileSync(join(root, 'edit.ts'), 'const b = 1;\n');
    writeFileSync(join(root, 'gone.ts'), 'const c = 1;\n');
    const cap = await captureCodeBaseline(client(), 'sqlite', root);
    expect(cap.fileCount).toBe(3);
    // Operator edits one file, removes one, adds one.
    writeFileSync(join(root, 'edit.ts'), 'const b = 2; // my edit\n');
    rmSync(join(root, 'gone.ts'));
    writeFileSync(join(root, 'new.ts'), 'const d = 4;\n');
    const status = await runCodeStatus(client(), 'sqlite', root);
    expect(status.status).toBe('ok');
    if (status.status === 'ok') {
      const byPath = Object.fromEntries(status.files.map((f) => [f.path, f.state]));
      expect(byPath).toMatchObject({ 'keep.ts': 'unchanged', 'edit.ts': 'operator_modified', 'gone.ts': 'removed', 'new.ts': 'added' });
    }
  });

  it('NEGATIVE: code status before any baseline reports no_baseline', async () => {
    expect((await runCodeStatus(client(), 'sqlite', root)).status).toBe('no_baseline');
  });

  it('code changes flow into the review queue and honour the resolve rules (adopt refused for code)', async () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
    await captureCodeBaseline(client(), 'sqlite', root);
    writeFileSync(join(root, 'a.ts'), 'const a = 99;\n'); // operator edit
    const scan = await runCodeScan(client(), 'sqlite', root);
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.recorded).toBeGreaterThanOrEqual(1);
    const item = (await getReviewQueue(client(), 'sqlite', { family: 'code' })).items.find((i) => i.logical_key === 'a.ts')!;
    expect(item).toBeTruthy();
    // keep works; adopt is refused (code has no in-app record to overwrite — that's a deploy).
    expect((await resolveReviewItem(client(), 'sqlite', item.id, 'adopt')).reason).toContain('non-content layer');
    expect((await resolveReviewItem(client(), 'sqlite', item.id, 'keep')).ok).toBe(true);
    expect((await getUpgradeDetail(client(), 'sqlite', item.id))?.resolution).toBe('kept');
  });

  it('SECURITY/guardrail: a both-changed code conflict is P1 and is never bulk-resolved', async () => {
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'preview', toVersion: 'code' });
    await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'code', logicalKey: 'conflict.ts', layer: 'L2', disposition: 'conflict', priority: 'P1' });
    await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'code', logicalKey: 'edited.ts', layer: 'L2', disposition: 'customized', priority: 'P3' });
    const res = await bulkResolveReview(client(), 'sqlite', 'keep', { family: 'code' });
    expect(res).toMatchObject({ resolved: 1, skippedP1: 1 }); // the P3 kept, the P1 conflict left for a human
  });

  it('CONCURRENCY: 1,000 distinct code items resolve concurrently with no lost updates; throughput + latency', async () => {
    const N = 1000;
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'preview', toVersion: 'code' });
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'code', logicalKey: `f${i}.ts`, layer: 'L2', disposition: 'customized', priority: 'P3' });
    }
    for (const r of raw().prepare(`SELECT id FROM upgrade_details WHERE family='code'`).all() as Array<{ id: string }>) ids.push(r.id);
    expect(ids.length).toBe(N);

    const durations: number[] = [];
    const t0 = performance.now();
    const results = await Promise.all(ids.map((id) => (async () => {
      const s = performance.now();
      const r = await resolveReviewItem(client(), 'sqlite', id, 'keep', { resolvedBy: 'admin-1' });
      durations.push(performance.now() - s);
      return r.ok;
    })()));
    const wall = performance.now() - t0;
    const okCount = results.filter(Boolean).length;
    // No lost updates: every distinct item resolved, and the queue is drained.
    expect(okCount).toBe(N);
    expect((await getReviewQueue(client(), 'sqlite', { family: 'code' })).items.length).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[concurrency] ${N} concurrent resolves in ${wall.toFixed(0)}ms (${(N / (wall / 1000)).toFixed(0)}/s) · p50=${pct(durations, 50).toFixed(1)}ms p95=${pct(durations, 95).toFixed(1)}ms p99=${pct(durations, 99).toFixed(1)}ms`);
  });

  it('CONCURRENCY: 100 concurrent resolves of the SAME item are idempotent (one consistent state, no corruption)', async () => {
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'preview', toVersion: 'code' });
    await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'code', logicalKey: 'hot.ts', layer: 'L2', disposition: 'customized', priority: 'P3' });
    const id = (raw().prepare(`SELECT id FROM upgrade_details WHERE logical_key='hot.ts'`).get() as { id: string }).id;
    const results = await Promise.all(Array.from({ length: 100 }, () => resolveReviewItem(client(), 'sqlite', id, 'keep', { resolvedBy: 'admin-1' })));
    // Idempotent under contention: the row ends in exactly one resolved state, exactly one row, no corruption.
    const rows = raw().prepare(`SELECT resolution FROM upgrade_details WHERE id=?`).all(id) as Array<{ resolution: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.resolution).toBe('kept');
    // eslint-disable-next-line no-console
    console.log(`[idempotency] 100 concurrent same-item resolves → ${results.filter((r) => r.ok).length} reported ok; final resolution='kept' (single row)`);
  });
});
