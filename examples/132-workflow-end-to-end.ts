/**
 * Example 132 — Workflow package full integration end-to-end.
 *
 * Proves that the workflow engine wired by `createGeneWeave(...)`:
 *   1. Has all 6 DB-backed stores plumbed (payload, step-lock, sleep,
 *      audit, rate-limiter, run-queue) plus SQLite idempotency.
 *   2. Auto-registers the `subworkflow:` resolver so `wf-greet-parent`
 *      can invoke `wf-greet-subflow` synchronously to terminal.
 *   3. Auto-seeds three example workflows (`wf-greet-subflow`,
 *      `wf-greet-parent`, `wf-tool-calc`) on first boot.
 *   4. The `tool:` resolver invokes a real built-in (`calculator`).
 *   5. The `script:` resolver works when the operator opt-in is set.
 *
 * No LLM, no network, no external service. Runs against a tmp SQLite
 * file. The script-resolver opt-in (`GENEWEAVE_ENABLE_SCRIPT_RESOLVER=1`)
 * is set inside this example so the parent → subflow path runs end-to-end.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';

// Operator opt-in for the in-process script resolver. Must be set
// BEFORE `createGeneWeave` constructs the engine because the gate is
// read once during resolver registry build.
process.env['GENEWEAVE_ENABLE_SCRIPT_RESOLVER'] = '1';

const { createGeneWeave } = await import('@weaveintel/geneweave-api');

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'geneweave-ex132-'));
  const dbPath = join(dir, 'geneweave.db');

  const app = await createGeneWeave({
    port: 0,
    jwtSecret: 'ex132-test-secret-not-for-prod-use-only-min-32',
    database: { type: 'sqlite', path: dbPath },
    providers: { anthropic: { apiKey: 'sk-test-not-real' } },
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
  });

  const db = (app as { db?: unknown }).db as {
    listWorkflowDefs(): Promise<{ id: string; name: string }[]>;
    getWorkflowDef(id: string): Promise<unknown>;
  };
  assert.ok(db, 'app exposes db');

  // ── 1. Seeded workflows present ─────────────────────────────────────────
  const seeded = await db.listWorkflowDefs();
  const ids = seeded.map((r) => r.id);
  assert.ok(ids.includes('wf-greet-subflow'), 'wf-greet-subflow seeded');
  assert.ok(ids.includes('wf-greet-parent'), 'wf-greet-parent seeded');
  assert.ok(ids.includes('wf-tool-calc'), 'wf-tool-calc seeded');
  console.log('[ex132] ✓ 3 example workflows auto-seeded');

  const handle = (app as { workflows?: unknown }).workflows as {
    engine: { startRun(id: string, vars: Record<string, unknown>): Promise<{ status: string; state?: unknown; error?: unknown }> };
    payloadStore: unknown;
    stepLockStore: unknown;
    sleepStore: unknown;
    auditLog: unknown;
    rateLimiter: unknown;
    runQueue: unknown;
    idempotencyStore: unknown;
  };
  assert.ok(handle, 'app exposes workflows handle');

  // ── 2. All 6 stores wired ───────────────────────────────────────────────
  assert.ok(handle.payloadStore, 'payloadStore wired');
  assert.ok(handle.stepLockStore, 'stepLockStore wired');
  assert.ok(handle.sleepStore, 'sleepStore wired');
  assert.ok(handle.auditLog, 'auditLog wired');
  assert.ok(handle.rateLimiter, 'rateLimiter wired');
  assert.ok(handle.runQueue, 'runQueue wired');
  assert.ok(handle.idempotencyStore, 'idempotencyStore wired');
  console.log('[ex132] ✓ all 6 DB stores + idempotency wired into engine');

  // ── 3. Subflow runs script step ─────────────────────────────────────────
  const subRun = await handle.engine.startRun('wf-greet-subflow', { name: 'World' });
  if (subRun.status !== 'completed') {
    console.error('[ex132] subRun details:', JSON.stringify(subRun, null, 2));
  }
  assert.equal(subRun.status, 'completed', `subflow completed (got ${subRun.status})`);
  console.log('[ex132] ✓ wf-greet-subflow completed');

  // ── 4. Parent invokes subflow via subworkflow: resolver ─────────────────
  const parentRun = await handle.engine.startRun('wf-greet-parent', { name: 'WeaveIntel' });
  assert.equal(parentRun.status, 'completed', `parent completed (got ${parentRun.status})`);
  console.log('[ex132] ✓ wf-greet-parent → wf-greet-subflow completed');

  // ── 5. Tool resolver invokes built-in calculator ────────────────────────
  const toolRun = await handle.engine.startRun('wf-tool-calc', { expression: '2 + 3' });
  assert.equal(toolRun.status, 'completed', `tool run completed (got ${toolRun.status})`);
  console.log('[ex132] ✓ wf-tool-calc → calculator built-in completed');

  await app.stop();
  await rm(dir, { recursive: true, force: true });
  console.log('[ex132] all assertions passed');
}

main().catch((err) => {
  console.error('[ex132] failed:', err);
  process.exit(1);
});
