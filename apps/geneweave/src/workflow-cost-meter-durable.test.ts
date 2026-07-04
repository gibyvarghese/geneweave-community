import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeKvStore } from '@weaveintel/core';
import { createGeneWeave, type GeneWeaveApp } from './index.js';

async function bootApp(dbPath: string): Promise<GeneWeaveApp> {
  return createGeneWeave({
    port: 0,
    jwtSecret: 'phaseB-test-secret-not-for-prod-use-only-min-32',
    database: { type: 'sqlite', path: dbPath },
    providers: { anthropic: { apiKey: 'sk-test-not-real' } },
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
  });
}

async function readCostKeys(kv: RuntimeKvStore): Promise<Array<{ key: string; value: string }>> {
  const rows = await kv.list('cost-meter:');
  return rows.map((r) => ({ key: r.key, value: r.value }));
}

describe('Phase B — durable cost meter', () => {
  let app: GeneWeaveApp | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (app) { await app.stop(); app = undefined; }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
  });

  it('cost meter writes to runtime persistence under cost-meter: namespace', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phaseB-cost-'));
    app = await bootApp(join(dir, 'gw.db'));

    const meter = app.workflows.costMeter;
    expect(meter).toBeDefined();

    const runId = 'run-phaseB-1';
    // Durable cost meter stores integer cents (Math.round(costUsd * 100))
    // to avoid float drift across cumulative writes — see cost-meter.ts.
    await meter.record(runId, { costUsd: 0.01, source: 'unit-test' });
    await meter.record(runId, { costUsd: 0.05, source: 'unit-test' });

    const total = await meter.total(runId);
    expect(total).toBeCloseTo(0.06, 4);

    const kv = app.runtime.persistence!.kv;
    const rows = await readCostKeys(kv);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.key === `cost-meter:${runId}`)).toBe(true);
  });

  it('cost totals survive a restart on the same sqlite path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phaseB-restart-'));
    const dbPath = join(dir, 'gw.db');

    app = await bootApp(dbPath);
    const runId = 'run-phaseB-restart';
    await app.workflows.costMeter.record(runId, { costUsd: 0.42 });
    expect(await app.workflows.costMeter.total(runId)).toBeCloseTo(0.42, 4);
    await app.stop();
    app = undefined;

    app = await bootApp(dbPath);
    const totalAfter = await app.workflows.costMeter.total(runId);
    expect(totalAfter).toBeCloseTo(0.42, 4);
  });
});
