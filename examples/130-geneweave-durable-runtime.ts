/**
 * Example 130 — Phase A (GeneWeave adoption): durable, redacting runtime.
 *
 * Proves that `createGeneWeave(...)` constructs a `weaveRuntime` whose
 * `persistence` slot points at the same SQLite path as the app database
 * and whose `audit` logger is the auto-wired durable + redacting variant
 * (Phase 5). Audit entries written through `weaveAudit(ctx, ...)` survive
 * across a fresh `createGeneWeave` invocation against the same file, and
 * the entry's `details` have PII scrubbed at write time.
 *
 * No LLM, no external service. Runs in-process against a tmp SQLite path.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import {
  weaveContext,
  weaveAudit,
  RuntimeCapabilities,
  type RuntimeKvStore,
} from '@weaveintel/core';
import { createGeneWeave } from '@weaveintel/geneweave-api';

async function listAuditEntries(kv: RuntimeKvStore): Promise<unknown[]> {
  const rows = await kv.list('audit:');
  return rows.map((r) => JSON.parse(r.value));
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'geneweave-phaseA-'));
  const dbPath = join(dir, 'geneweave.db');

  // ── Boot 1: write a durable audit entry containing PII ─────────────────────
  const app1 = await createGeneWeave({
    port: 0,
    jwtSecret: 'phaseA-test-secret-not-for-prod-use-only-min-32',
    database: { type: 'sqlite', path: dbPath },
    providers: { anthropic: { apiKey: 'sk-test-not-real' } },
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
  });

  const rt1 = app1.runtime;
  assert.ok(rt1.has(RuntimeCapabilities.Persistence), 'persistence capability advertised');
  assert.ok(rt1.has(RuntimeCapabilities.Audit), 'audit capability advertised');
  assert.ok(rt1.persistence?.kv, 'kv exposed on persistence slot');

  const ctx1 = weaveContext({ runtime: rt1 });
  await weaveAudit(ctx1, {
    action: 'phaseA.proof',
    outcome: 'success',
    resource: 'geneweave',
    details: { contact: 'user@example.com, 555-123-4567' },
  });

  const kv1 = rt1.persistence!.kv;
  const entries1 = await listAuditEntries(kv1);
  assert.ok(entries1.length >= 1, 'at least one durable audit entry written');
  const proof = entries1.find((e: any) => e.action === 'phaseA.proof') as any;
  assert.ok(proof, 'phaseA.proof entry persisted');

  const serialised = JSON.stringify(proof.details ?? {});
  assert.ok(!serialised.includes('user@example.com'), 'email redacted before KV write');
  assert.ok(!serialised.includes('555-123-4567'), 'phone redacted before KV write');
  console.log('[ex130] ✓ durable audit entry redacted at write time');

  await app1.stop();

  // ── Boot 2: same path → entry survives restart ─────────────────────────────
  const app2 = await createGeneWeave({
    port: 0,
    jwtSecret: 'phaseA-test-secret-not-for-prod-use-only-min-32',
    database: { type: 'sqlite', path: dbPath },
    providers: { anthropic: { apiKey: 'sk-test-not-real' } },
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
  });

  const kv2 = app2.runtime.persistence!.kv;
  const entries2 = await listAuditEntries(kv2);
  const proof2 = entries2.find((e: any) => e.action === 'phaseA.proof');
  assert.ok(proof2, 'audit entry survived restart against shared SQLite path');
  console.log('[ex130] ✓ audit entry survived process restart');

  await app2.stop();
  await rm(dir, { recursive: true, force: true });
  console.log('[ex130] all assertions passed');
}

main().catch((err) => {
  console.error('[ex130] failed:', err);
  process.exit(1);
});
