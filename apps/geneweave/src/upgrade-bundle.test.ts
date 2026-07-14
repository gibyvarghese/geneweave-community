// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — signed RESOLUTION BUNDLES (cross-instance propagation of review decisions).
 *
 * Real booted SQLite (two independent instances). Covers the Phase-7 exit criterion (a staging bundle resolves
 * a MATCHING production item and SKIPS a non-matching hash), plus negative (bad/untrusted signature, edition
 * mismatch), stress (5k entries), and security (the signature covers content; a P1 is never auto-resolved; a
 * hostile key/family is a bound parameter). Signing reuses the Ed25519 attestation keys the manifest path uses.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import { createEd25519Verifier } from '@weaveintel/upgrade';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { beginUpgradeRun, recordUpgradeDetail, resolveUpgradeDetail, listUnresolvedUpgradeDetails } from './upgrade-run-store.js';
import { resolveReviewItem } from './upgrade-review.js';
import {
  collectResolutionBundle, signResolutionBundle, verifyResolutionBundle, importResolutionBundle,
  type SignedResolutionBundle,
} from './upgrade-bundle.js';

/** A booted SQLite instance with a fresh upgrade run — a stand-in for one geneWeave install. */
async function makeInstance(tag: string): Promise<{ db: DatabaseAdapter; path: string; client: () => ReturnType<typeof sqliteSqlClient>; raw: () => Database.Database; runId: string }> {
  const path = join(tmpdir(), `bundle-${tag}-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
  const db = await createDatabaseAdapter({ type: 'sqlite', path });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply', toVersion: '2.0.0' });
  return { db, path, client, raw, runId };
}
async function closeInstance(inst: { db: DatabaseAdapter; path: string }): Promise<void> {
  await inst.db?.close?.();
  for (const s of ['', '-wal', '-shm']) { try { rmSync(inst.path + s, { force: true }); } catch { /* ignore */ } }
}

describe('Upgrade Engine — signed resolution bundles (real booted SQLite)', () => {
  let key: ReturnType<typeof generateAttestationSigningKey>;
  let src: Awaited<ReturnType<typeof makeInstance>>;
  let dst: Awaited<ReturnType<typeof makeInstance>>;

  beforeEach(async () => {
    key = generateAttestationSigningKey();
    src = await makeInstance('src');
    dst = await makeInstance('dst');
  });
  afterEach(async () => { await closeInstance(src); await closeInstance(dst); });

  /** Add a detail and, if `resolve`, keep it — so the source can export a decision. */
  async function stageDecision(inst: typeof src, over: { family: string; logicalKey: string; remoteHash: string; priority?: string }): Promise<void> {
    await recordUpgradeDetail(inst.client(), 'sqlite', inst.runId, {
      family: over.family, logicalKey: over.logicalKey, disposition: 'diverged' as never,
      priority: (over.priority ?? 'P3') as never, remoteHash: over.remoteHash,
    });
    const id = (inst.raw().prepare(`SELECT id FROM upgrade_details WHERE family=? AND logical_key=? LIMIT 1`).get(over.family, over.logicalKey) as { id: string }).id;
    await resolveReviewItem(inst.client(), 'sqlite', id, 'keep');
  }
  /** Add an UNRESOLVED detail to a destination (a production item awaiting review). */
  const stageOpen = (inst: typeof dst, over: { family: string; logicalKey: string; remoteHash: string; priority?: string }) =>
    recordUpgradeDetail(inst.client(), 'sqlite', inst.runId, {
      family: over.family, logicalKey: over.logicalKey, disposition: 'diverged' as never,
      priority: (over.priority ?? 'P3') as never, remoteHash: over.remoteHash,
    });

  const trustedVerifier = () => createEd25519Verifier([key.publicKey]);

  // ── The exit criterion ────────────────────────────────────────────────────────────────────────────
  it('EXIT: a bundle resolves a MATCHING production item and SKIPS one whose remote hash differs', async () => {
    await stageDecision(src, { family: 'prompts', logicalKey: 'greeting', remoteHash: 'sha256:AAA' });
    await stageDecision(src, { family: 'skills', logicalKey: 'summariser', remoteHash: 'sha256:BBB' });
    const bundle = signResolutionBundle(await collectResolutionBundle(src.client(), 'sqlite', { edition: 'community' }), key.privateKey);
    expect(bundle.entries).toHaveLength(2);
    expect(bundle.signature.alg).toBe('Ed25519');

    // Production: 'greeting' shipped IDENTICAL content (same hash → will match); 'summariser' shipped DIFFERENT
    // content (different hash → must be skipped, never blindly adopted).
    await stageOpen(dst, { family: 'prompts', logicalKey: 'greeting', remoteHash: 'sha256:AAA' });
    await stageOpen(dst, { family: 'skills', logicalKey: 'summariser', remoteHash: 'sha256:DIFFERENT' });

    const res = await importResolutionBundle(dst.client(), 'sqlite', bundle, trustedVerifier());
    expect(res.signatureOk).toBe(true);
    expect(res.applied).toBe(1);      // 'greeting' matched on the full triple
    expect(res.skippedHash).toBe(1);  // 'summariser' present but different hash → skipped
    // The matched item is resolved and stamped 'imported'; the mismatched one is untouched.
    const greeting = dst.raw().prepare(`SELECT resolution, resolution_source, resolved_by FROM upgrade_details WHERE logical_key='greeting'`).get() as Record<string, string>;
    expect(greeting['resolution']).toBe('kept');
    expect(greeting['resolution_source']).toBe('imported');
    expect(greeting['resolved_by']).toBe('imported');
    const summ = dst.raw().prepare(`SELECT resolution FROM upgrade_details WHERE logical_key='summariser'`).get() as Record<string, string | null>;
    expect(summ['resolution']).toBeNull(); // never resolved on a hash mismatch
  });

  it('POSITIVE: an item with no local counterpart is reported unmatched', async () => {
    await stageDecision(src, { family: 'prompts', logicalKey: 'orphan', remoteHash: 'sha256:X' });
    const bundle = signResolutionBundle(await collectResolutionBundle(src.client(), 'sqlite'), key.privateKey);
    const res = await importResolutionBundle(dst.client(), 'sqlite', bundle, trustedVerifier());
    expect(res.applied).toBe(0);
    expect(res.unmatched).toBe(1);
  });

  // ── Negative / security ─────────────────────────────────────────────────────────────────────────
  it('SECURITY: a P1 item is never auto-resolved by an imported decision', async () => {
    await stageDecision(src, { family: 'guardrails', logicalKey: 'no-secrets', remoteHash: 'sha256:P1', priority: 'P1' });
    await stageOpen(dst, { family: 'guardrails', logicalKey: 'no-secrets', remoteHash: 'sha256:P1', priority: 'P1' });
    const bundle = signResolutionBundle(await collectResolutionBundle(src.client(), 'sqlite'), key.privateKey);
    const res = await importResolutionBundle(dst.client(), 'sqlite', bundle, trustedVerifier());
    expect(res.applied).toBe(0);
    expect(res.skippedP1).toBe(1);
    expect(await listUnresolvedUpgradeDetails(dst.client(), 'sqlite')).toHaveLength(1); // still on the queue
  });

  it('SECURITY: a bad signature (tampered body) applies NOTHING', async () => {
    await stageDecision(src, { family: 'prompts', logicalKey: 'g', remoteHash: 'sha256:A' });
    await stageOpen(dst, { family: 'prompts', logicalKey: 'g', remoteHash: 'sha256:A' });
    const bundle = signResolutionBundle(await collectResolutionBundle(src.client(), 'sqlite'), key.privateKey);
    // Tamper an entry AFTER signing — the canonical bytes no longer match the signature.
    const tampered = { ...bundle, entries: [{ ...bundle.entries[0]!, remoteHash: 'sha256:A', resolution: 'adopted' }] } as SignedResolutionBundle;
    expect(verifyResolutionBundle(tampered, trustedVerifier()).ok).toBe(false);
    const res = await importResolutionBundle(dst.client(), 'sqlite', tampered, trustedVerifier());
    expect(res.signatureOk).toBe(false);
    expect(res.rejected).toBe('bad_signature');
    expect(res.applied).toBe(0);
    expect(await listUnresolvedUpgradeDetails(dst.client(), 'sqlite')).toHaveLength(1); // untouched
  });

  it('SECURITY: a bundle signed by an UNTRUSTED key applies nothing', async () => {
    await stageDecision(src, { family: 'prompts', logicalKey: 'g', remoteHash: 'sha256:A' });
    await stageOpen(dst, { family: 'prompts', logicalKey: 'g', remoteHash: 'sha256:A' });
    const bundle = signResolutionBundle(await collectResolutionBundle(src.client(), 'sqlite'), key.privateKey);
    const strangerVerifier = createEd25519Verifier([generateAttestationSigningKey().publicKey]); // doesn't trust `key`
    const res = await importResolutionBundle(dst.client(), 'sqlite', bundle, strangerVerifier);
    expect(res.signatureOk).toBe(false);
    expect(res.rejected).toBe('untrusted_key');
    expect(res.applied).toBe(0);
  });

  it('NEGATIVE: a cross-edition bundle is rejected when the local edition is supplied', async () => {
    await stageDecision(src, { family: 'prompts', logicalKey: 'g', remoteHash: 'sha256:A' });
    await stageOpen(dst, { family: 'prompts', logicalKey: 'g', remoteHash: 'sha256:A' });
    const bundle = signResolutionBundle(await collectResolutionBundle(src.client(), 'sqlite', { edition: 'enterprise' }), key.privateKey);
    const res = await importResolutionBundle(dst.client(), 'sqlite', bundle, trustedVerifier(), { edition: 'community' });
    expect(res.rejected).toBe('edition_mismatch');
    expect(res.applied).toBe(0);
  });

  it('NEGATIVE: a non-replayable resolution (merged) is not exported', async () => {
    await recordUpgradeDetail(src.client(), 'sqlite', src.runId, { family: 'prompts', logicalKey: 'm', disposition: 'diverged' as never, priority: 'P3' as never, remoteHash: 'sha256:M' });
    const id = (src.raw().prepare(`SELECT id FROM upgrade_details WHERE logical_key='m'`).get() as { id: string }).id;
    await resolveUpgradeDetail(src.client(), 'sqlite', id, { resolution: 'merged' }); // a resolution the review actions don't produce
    const body = await collectResolutionBundle(src.client(), 'sqlite');
    expect(body.entries.find((e) => e.logicalKey === 'm')).toBeUndefined();
  });

  // ── Stress ────────────────────────────────────────────────────────────────────────────────────────
  it('STRESS: a 5k-entry bundle round-trips (export → sign → verify → import) within budget', async () => {
    const N = 5000;
    const insSrc = src.raw().prepare(`INSERT INTO upgrade_details (id, run_id, family, logical_key, layer, disposition, priority, remote_hash, resolution, resolved_at, created_at) VALUES (?, ?, 'prompts', ?, 'L4', 'diverged', 'P3', ?, 'kept', datetime('now'), datetime('now'))`);
    src.raw().transaction(() => { for (let i = 0; i < N; i++) insSrc.run(`s${i}`, src.runId, `k${i}`, `sha256:h${i}`); })();
    const insDst = dst.raw().prepare(`INSERT INTO upgrade_details (id, run_id, family, logical_key, layer, disposition, priority, remote_hash, created_at) VALUES (?, ?, 'prompts', ?, 'L4', 'diverged', 'P3', ?, datetime('now'))`);
    dst.raw().transaction(() => { for (let i = 0; i < N; i++) insDst.run(`d${i}`, dst.runId, `k${i}`, `sha256:h${i}`); })();

    const t0 = performance.now();
    const bundle = signResolutionBundle(await collectResolutionBundle(src.client(), 'sqlite'), key.privateKey);
    const tSign = performance.now();
    expect(bundle.entries).toHaveLength(N);
    const res = await importResolutionBundle(dst.client(), 'sqlite', bundle, trustedVerifier());
    const tImport = performance.now();
    expect(res.applied).toBe(N);
    expect(await listUnresolvedUpgradeDetails(dst.client(), 'sqlite')).toHaveLength(0);
    // eslint-disable-next-line no-console
    console.log(`[bundle stress] ${N} entries · export+sign ${(tSign - t0).toFixed(0)}ms · verify+import ${(tImport - tSign).toFixed(0)}ms (${Math.round(N / ((tImport - tSign) / 1000))}/s)`);
    expect(tImport - t0).toBeLessThan(60_000);
  });

  it('SECURITY: a hostile family/logicalKey is a bound parameter — no injection, simply unmatched', async () => {
    const hostile = "prompts'; DROP TABLE upgrade_details; --";
    await stageDecision(src, { family: hostile, logicalKey: hostile, remoteHash: 'sha256:A' });
    const bundle = signResolutionBundle(await collectResolutionBundle(src.client(), 'sqlite'), key.privateKey);
    const res = await importResolutionBundle(dst.client(), 'sqlite', bundle, trustedVerifier());
    expect(res.unmatched).toBe(1);
    // The destination's ledger table is intact.
    expect(dst.raw().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='upgrade_details'`).get()).toBeTruthy();
  });
});
