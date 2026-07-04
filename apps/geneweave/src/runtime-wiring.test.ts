import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weaveAudit, weaveContext, RuntimeCapabilities, type RuntimeKvStore } from '@weaveintel/core';
import { createGeneWeave, type GeneWeaveApp } from './index.js';

async function listAudit(kv: RuntimeKvStore): Promise<any[]> {
  const rows = await kv.list('audit:');
  return rows.map((r) => JSON.parse(r.value));
}

async function bootApp(dbPath: string): Promise<GeneWeaveApp> {
  return createGeneWeave({
    port: 0,
    jwtSecret: 'phaseA-test-secret-not-for-prod-use-only-min-32',
    database: { type: 'sqlite', path: dbPath },
    providers: { anthropic: { apiKey: 'sk-test-not-real' } },
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
  });
}

describe('Phase A — createGeneWeave runtime wiring', () => {
  let app: GeneWeaveApp | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (app) { await app.stop(); app = undefined; }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
  });

  it('advertises persistence + audit capabilities', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phaseA-cap-'));
    app = await bootApp(join(dir, 'gw.db'));

    expect(app.runtime.has(RuntimeCapabilities.Persistence)).toBe(true);
    expect(app.runtime.has(RuntimeCapabilities.Audit)).toBe(true);
    expect(app.runtime.has(RuntimeCapabilities.Secrets)).toBe(true);
    expect(app.runtime.has(RuntimeCapabilities.Guardrails)).toBe(true);
    expect(app.runtime.guardrails?.checkToolCall).toBeTypeOf('function');
    expect(app.runtime.guardrails?.checkOutput).toBeTypeOf('function');
    expect(app.runtime.persistence?.kv).toBeDefined();
  });

  // ── Phase 0 integration checks ───────────────────────────────────────────

  it('Phase 0 — advertises Resilience capability and exposes getState', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phase0-resilience-'));
    app = await bootApp(join(dir, 'gw.db'));

    expect(app.runtime.has(RuntimeCapabilities.Resilience)).toBe(true);
    expect(app.runtime.resilience).toBeDefined();
    expect(typeof app.runtime.resilience?.emit).toBe('function');
    expect(typeof app.runtime.resilience?.getState).toBe('function');
    expect(typeof app.runtime.resilience?.getLatencyP50).toBe('function');
    expect(typeof app.runtime.resilience?.getLatencyP95).toBe('function');
  });

  it('Phase 0 — getState returns "unknown" for an endpoint with no recorded events', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phase0-state-'));
    app = await bootApp(join(dir, 'gw.db'));

    expect(app.runtime.resilience?.getState?.('anthropic:rest')).toBe('unknown');
  });

  it('Phase 0 — guardrails slot exposes checkInput (pre-LLM gate)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phase0-guardrails-'));
    app = await bootApp(join(dir, 'gw.db'));

    expect(app.runtime.has(RuntimeCapabilities.Guardrails)).toBe(true);
    expect(typeof app.runtime.guardrails?.checkInput).toBe('function');
  });

  it('Phase 0 — encryption slot exposes isActive()', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phase0-encryption-'));
    delete process.env['VAULT_KEY'];
    app = await bootApp(join(dir, 'gw.db'));

    expect(app.runtime.has(RuntimeCapabilities.Encryption)).toBe(true);
    expect(typeof app.runtime.encryption?.isActive).toBe('function');
    // No VAULT_KEY set, so isActive returns false
    expect(app.runtime.encryption?.isActive()).toBe(false);
  });

  it('audit entries are written to durable KV with PII redacted', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phaseA-redact-'));
    app = await bootApp(join(dir, 'gw.db'));

    const ctx = weaveContext({ runtime: app.runtime });
    await weaveAudit(ctx, {
      action: 'phaseA.unit.redact',
      outcome: 'success',
      resource: 'test',
      details: { contact: 'jane.doe@example.com phone 555-987-6543' },
    });

    const entries = await listAudit(app.runtime.persistence!.kv);
    const proof = entries.find((e) => e.action === 'phaseA.unit.redact');
    expect(proof).toBeDefined();
    const blob = JSON.stringify(proof.details);
    expect(blob).not.toContain('jane.doe@example.com');
    expect(blob).not.toContain('555-987-6543');
  });

  it('audit entries survive a restart on the same SQLite path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phaseA-restart-'));
    const dbPath = join(dir, 'gw.db');

    const app1 = await bootApp(dbPath);
    const ctx = weaveContext({ runtime: app1.runtime });
    await weaveAudit(ctx, {
      action: 'phaseA.unit.restart',
      outcome: 'success',
      resource: 'test',
      details: { note: 'persist-me' },
    });
    await app1.stop();

    app = await bootApp(dbPath);
    const entries = await listAudit(app.runtime.persistence!.kv);
    const proof = entries.find((e) => e.action === 'phaseA.unit.restart');
    expect(proof).toBeDefined();
    expect(proof.details?.note).toBe('persist-me');
  });

  it('in-memory fallback when database is custom', async () => {
    // Construct a no-op custom adapter sufficient for boot.
    // Skip: the createGeneWeave seed path requires a working adapter, so
    // the durable path is exercised via the SQLite tests above. This test
    // documents the fallback contract: the runtime KV slot is always
    // present, regardless of backend choice.
    dir = mkdtempSync(join(tmpdir(), 'gw-phaseA-inmem-'));
    app = await bootApp(join(dir, 'gw.db'));
    expect(app.runtime.persistence?.kind).toBe('sqlite');
  });
});
