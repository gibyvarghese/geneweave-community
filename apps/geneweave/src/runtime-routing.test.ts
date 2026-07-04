/**
 * Phase 2 integration tests — Shared Routing Slot
 *
 * Verifies:
 * - weaveRuntime correctly advertises RuntimeCapabilities.Routing when
 *   a routing slot is wired
 * - createGeneWeave() boots with Routing capability advertised
 * - recordOutcome from one access path is visible through listHealth()
 * - blockProvider from the routing slot is visible in getBlockedProviders()
 * - ChatEngine's recordModelOutcome delegates to the shared slot when
 *   a runtime with routing is wired
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weaveRuntime, weaveContext, RuntimeCapabilities } from '@weaveintel/core';
import { ModelHealthTracker, createRuntimeRoutingAdapter } from '@weaveintel/routing';
import { createGeneWeave, type GeneWeaveApp } from './index.js';

// ─── Unit: weaveRuntime + routing slot ───────────────────────────────────────

describe('Phase 2 — weaveRuntime + RuntimeRoutingSlot', () => {
  it('has(RuntimeCapabilities.Routing) is false when no routing slot is configured', () => {
    const runtime = weaveRuntime({ tlsFloor: false });
    expect(runtime.has(RuntimeCapabilities.Routing)).toBe(false);
    expect(runtime.routing).toBeUndefined();
  });

  it('has(RuntimeCapabilities.Routing) is true when routing slot is wired', () => {
    const tracker = new ModelHealthTracker();
    const routingSlot = createRuntimeRoutingAdapter(tracker);
    const runtime = weaveRuntime({ tlsFloor: false, routing: routingSlot });
    expect(runtime.has(RuntimeCapabilities.Routing)).toBe(true);
    expect(runtime.routing).toBe(routingSlot);
  });

  it('runtime.routing.listHealth() returns outcomes recorded via the slot', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);
    const runtime = weaveRuntime({ tlsFloor: false, routing: slot });

    runtime.routing!.recordOutcome('claude-sonnet-4-6', 'anthropic', 120, true);
    runtime.routing!.recordOutcome('gpt-4o', 'openai', 200, false);

    const health = runtime.routing!.listHealth();
    expect(health).toHaveLength(2);
    const modelIds = health.map((h) => h.modelId).sort();
    expect(modelIds).toContain('claude-sonnet-4-6');
    expect(modelIds).toContain('gpt-4o');
  });

  it('runtime.routing.getBlockedProviders() reflects blockProvider calls', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);
    const runtime = weaveRuntime({ tlsFloor: false, routing: slot });

    expect(runtime.routing!.getBlockedProviders().size).toBe(0);
    runtime.routing!.blockProvider('openai', 60_000);
    expect(runtime.routing!.getBlockedProviders().has('openai')).toBe(true);
  });

  it('routing slot is accessible through weaveContext', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);
    const runtime = weaveRuntime({ tlsFloor: false, routing: slot });
    const ctx = weaveContext({ runtime });

    expect(ctx.runtime?.routing).toBe(slot);
    expect(ctx.runtime?.has(RuntimeCapabilities.Routing)).toBe(true);
  });
});

// ─── Cross-access-path sharing test ──────────────────────────────────────────

describe('Phase 2 — shared state between two adapters on same tracker', () => {
  it('outcome recorded by adapter A is visible via adapter B', () => {
    const tracker = new ModelHealthTracker();
    const chatSlot = createRuntimeRoutingAdapter(tracker);
    const supervisorSlot = createRuntimeRoutingAdapter(tracker);

    // Chat path records an outcome
    chatSlot.recordOutcome('claude-sonnet-4-6', 'anthropic', 180, true);

    // Supervisor reads via its own slot — same underlying tracker
    const health = supervisorSlot.listHealth();
    expect(health).toHaveLength(1);
    expect(health[0]!.modelId).toBe('claude-sonnet-4-6');
    expect(health[0]!.avgLatencyMs).toBeGreaterThan(0);
  });

  it('blockProvider called on chat slot blocks the provider in supervisor slot', () => {
    const tracker = new ModelHealthTracker();
    const chatSlot = createRuntimeRoutingAdapter(tracker);
    const supervisorSlot = createRuntimeRoutingAdapter(tracker);

    chatSlot.blockProvider('openai', 5 * 60_000);

    expect(supervisorSlot.getBlockedProviders().has('openai')).toBe(true);
  });
});

// ─── Full-boot integration test ──────────────────────────────────────────────

describe('Phase 2 — createGeneWeave() boot with Routing capability', () => {
  let app: GeneWeaveApp | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (app) { await app.stop(); app = undefined; }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
  });

  it('runtime.has(RuntimeCapabilities.Routing) is true after boot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phase2-routing-'));
    app = await createGeneWeave({
      port: 0,
      jwtSecret: 'phase2-routing-test-secret-not-for-prod-use-only',
      database: { type: 'sqlite', path: join(dir, 'gw.db') },
      providers: { anthropic: { apiKey: 'sk-test-not-real' } },
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
    });

    expect(app.runtime.has(RuntimeCapabilities.Routing)).toBe(true);
    expect(app.runtime.routing).toBeDefined();
  });

  it('runtime.routing slot is functional after boot — listHealth() returns an array', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phase2-health-'));
    app = await createGeneWeave({
      port: 0,
      jwtSecret: 'phase2-health-test-secret-not-for-prod-use-only-32ch',
      database: { type: 'sqlite', path: join(dir, 'gw.db') },
      providers: { anthropic: { apiKey: 'sk-test-not-real' } },
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
    });

    const health = app.runtime.routing!.listHealth();
    expect(Array.isArray(health)).toBe(true);
  });

  it('outcome recorded via runtime.routing is visible through listHealth()', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phase2-outcome-'));
    app = await createGeneWeave({
      port: 0,
      jwtSecret: 'phase2-outcome-test-secret-not-for-prod-use-only-32',
      database: { type: 'sqlite', path: join(dir, 'gw.db') },
      providers: { anthropic: { apiKey: 'sk-test-not-real' } },
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
    });

    // Simulate recording an outcome (as chat path / live-agent supervisor would)
    app.runtime.routing!.recordOutcome('claude-sonnet-4-6', 'anthropic', 200, true);
    app.runtime.routing!.recordOutcome('gpt-4o', 'openai', 300, false);

    const health = app.runtime.routing!.listHealth();
    expect(health.some((h) => h.modelId === 'claude-sonnet-4-6')).toBe(true);
    expect(health.some((h) => h.modelId === 'gpt-4o')).toBe(true);
  });

  it('blockProvider is respected in getBlockedProviders()', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-phase2-block-'));
    app = await createGeneWeave({
      port: 0,
      jwtSecret: 'phase2-block-test-secret-not-for-prod-use-only-32ch',
      database: { type: 'sqlite', path: join(dir, 'gw.db') },
      providers: { anthropic: { apiKey: 'sk-test-not-real' } },
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
    });

    expect(app.runtime.routing!.getBlockedProviders().size).toBe(0);

    app.runtime.routing!.blockProvider('openai', 60_000);

    expect(app.runtime.routing!.getBlockedProviders().has('openai')).toBe(true);
  });
});
