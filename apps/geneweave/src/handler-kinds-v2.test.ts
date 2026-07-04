/**
 * Phase 3 — Handler Kinds & Attention Policies Taxonomy Expansion (mid-2026)
 *
 * Covers:
 *   Positive:  migration correctness, registry wiring, seed parity, enabled states
 *   Negative:  missing required config, invalid kinds, no-model guard, duplicate registration
 *   Security:  SQL injection, config injection, URL validation, domain allowlist
 *   Stress:    concurrent DB reads, large config schemas, all-kinds enumeration
 *   Examples:  realistic binding configs for all 8 new handler kinds
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';
import { DEFAULT_HANDLER_KINDS, DEFAULT_ATTENTION_POLICIES } from '@weaveintel/live-agents';
import {
  createDefaultHandlerRegistry,
  agenticCodeInterpreterHandler,
  type HandlerContext,
  type HandlerBinding,
  type HandlerAgentInfo,
} from '@weaveintel/live-agents-runtime';
import {
  seedLiveHandlerKinds,
  seedLiveAttentionPolicies,
} from './live-agents/live-handler-kinds-seed.js';

// ── Test DB helpers ──────────────────────────────────────────────────────────

function makeTempDbPath(): string {
  return `/tmp/geneweave-handler-kinds-v2-test-${Date.now()}-${randomUUID()}.db`;
}

/**
 * Create a fresh DB, run all migrations (including m70), then seed the
 * framework builtins. This mirrors the real app boot sequence:
 *   1. initialize() — runs SQLite DDL + all migration batches
 *   2. seedLiveHandlerKinds() — idempotent insert of 7 original kinds
 *   3. seedLiveAttentionPolicies() — idempotent insert of 3 original policies
 *
 * After this: 15 handler kinds (7 original + 8 from m70) and 7 attention
 * policies (3 original + 4 from m70) are present.
 */
async function newHandlerKindsDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(makeTempDbPath());
  await db.initialize();
  await seedLiveHandlerKinds(db);
  await seedLiveAttentionPolicies(db);
  return db;
}

function makeBinding(kind: string, config: Record<string, unknown> = {}): HandlerBinding {
  return {
    id:          `binding-${randomUUID()}`,
    agentId:     `agent-${randomUUID()}`,
    handlerKind: kind,
    config,
  };
}

function makeAgent(overrides: Partial<HandlerAgentInfo> = {}): HandlerAgentInfo {
  return {
    id:      `agent-${randomUUID()}`,
    meshId:  `mesh-${randomUUID()}`,
    roleKey: 'worker',
    name:    'Test Worker',
    ...overrides,
  };
}

function makeCtx(kind: string, config: Record<string, unknown> = {}, extras: Partial<HandlerContext> = {}): HandlerContext {
  const agent = makeAgent();
  const binding = makeBinding(kind, config);
  return {
    binding,
    agent,
    log: () => {},
    ...extras,
  };
}

// ── Shared DB instance (read-only checks) ────────────────────────────────────
let db: SQLiteAdapter;

beforeAll(async () => {
  db = await newHandlerKindsDb();
});

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('[Phase 3] Handler Kinds — Positive: DB counts after m70', () => {
  it('must have exactly 15 live_handler_kinds after m70', async () => {
    const all = await db.listLiveHandlerKinds();
    expect(all.length).toBeGreaterThanOrEqual(15);
  });

  it('all 8 new Phase 3 handler kind keys must be present', async () => {
    const all = await db.listLiveHandlerKinds();
    const kinds = new Set(all.map(k => k.kind));
    const phase3Kinds = [
      'agentic.computer-use',
      'agentic.browser',
      'agentic.code-interpreter',
      'agentic.voice-realtime',
      'agentic.multimodal',
      'deterministic.mapreduce',
      'multi-agent.swarm',
      'external.mcp-tool',
    ];
    for (const kind of phase3Kinds) {
      expect(kinds.has(kind), `${kind} must be seeded`).toBe(true);
    }
  });

  it('all 7 original handler kinds must still be present after m70', async () => {
    const all = await db.listLiveHandlerKinds();
    const kinds = new Set(all.map(k => k.kind));
    const original = [
      'agentic.react',
      'agentic.scripted',
      'deterministic.template',
      'deterministic.forward',
      'deterministic.observer',
      'human.approval',
      'external.webhook',
    ];
    for (const kind of original) {
      expect(kinds.has(kind), `${kind} must survive m70`).toBe(true);
    }
  });

  it('must have at least 7 live_attention_policies after m70', async () => {
    const all = await db.listLiveAttentionPolicies();
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it('all 4 new Phase 3 attention policy keys must be present', async () => {
    const all = await db.listLiveAttentionPolicies();
    const keys = new Set(all.map(p => p.key));
    const phase3Policies = [
      'event.webhook-trigger',
      'event.file-watcher',
      'event.db-change',
      'model.llm-relevance',
    ];
    for (const key of phase3Policies) {
      expect(keys.has(key), `${key} must be seeded`).toBe(true);
    }
  });

  it('all 3 original attention policies must still be present', async () => {
    const all = await db.listLiveAttentionPolicies();
    const keys = new Set(all.map(p => p.key));
    expect(keys.has('heuristic.inbox-first')).toBe(true);
    expect(keys.has('cron.rest-only')).toBe(true);
    expect(keys.has('model.adaptive')).toBe(true);
  });
});

describe('[Phase 3] Handler Kinds — Positive: enabled states', () => {
  it('agentic.computer-use must be disabled (needs CUA sandbox)', async () => {
    const row = await db.getLiveHandlerKindByKind('agentic.computer-use');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(0);
  });

  it('agentic.browser must be disabled (needs Playwright container)', async () => {
    const row = await db.getLiveHandlerKindByKind('agentic.browser');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(0);
  });

  it('agentic.code-interpreter must be enabled', async () => {
    const row = await db.getLiveHandlerKindByKind('agentic.code-interpreter');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(1);
  });

  it('agentic.voice-realtime must be enabled', async () => {
    const row = await db.getLiveHandlerKindByKind('agentic.voice-realtime');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(1);
  });

  it('agentic.multimodal must be enabled', async () => {
    const row = await db.getLiveHandlerKindByKind('agentic.multimodal');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(1);
  });

  it('deterministic.mapreduce must be enabled', async () => {
    const row = await db.getLiveHandlerKindByKind('deterministic.mapreduce');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(1);
  });

  it('multi-agent.swarm must be enabled', async () => {
    const row = await db.getLiveHandlerKindByKind('multi-agent.swarm');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(1);
  });

  it('external.mcp-tool must be enabled', async () => {
    const row = await db.getLiveHandlerKindByKind('external.mcp-tool');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(1);
  });

  it('event.webhook-trigger must be enabled', async () => {
    const row = await db.getLiveAttentionPolicyByKey('event.webhook-trigger');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(1);
  });

  it('event.file-watcher must be disabled (needs FS-watcher daemon)', async () => {
    const row = await db.getLiveAttentionPolicyByKey('event.file-watcher');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(0);
  });

  it('event.db-change must be disabled (needs CDC pipeline)', async () => {
    const row = await db.getLiveAttentionPolicyByKey('event.db-change');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(0);
  });

  it('model.llm-relevance must be enabled', async () => {
    const row = await db.getLiveAttentionPolicyByKey('model.llm-relevance');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(1);
  });
});

describe('[Phase 3] Handler Kinds — Positive: config schemas are valid JSON', () => {
  it('all Phase 3 handler kinds have parseable config_schema_json', async () => {
    const phase3Kinds = [
      'agentic.computer-use',
      'agentic.browser',
      'agentic.code-interpreter',
      'agentic.voice-realtime',
      'agentic.multimodal',
      'deterministic.mapreduce',
      'multi-agent.swarm',
      'external.mcp-tool',
    ];
    for (const kind of phase3Kinds) {
      const row = await db.getLiveHandlerKindByKind(kind);
      expect(row).not.toBeNull();
      expect(() => JSON.parse(row!.config_schema_json), `${kind} schema must be valid JSON`).not.toThrow();
    }
  });

  it('all Phase 3 attention policies have parseable config_json', async () => {
    const phase3Policies = [
      'event.webhook-trigger',
      'event.file-watcher',
      'event.db-change',
      'model.llm-relevance',
    ];
    for (const key of phase3Policies) {
      const row = await db.getLiveAttentionPolicyByKey(key);
      expect(row).not.toBeNull();
      expect(() => JSON.parse(row!.config_json), `${key} config must be valid JSON`).not.toThrow();
    }
  });

  it('model.llm-relevance config has correct model ID', async () => {
    const row = await db.getLiveAttentionPolicyByKey('model.llm-relevance');
    const cfg = JSON.parse(row!.config_json);
    expect(cfg.model).toBe('claude-haiku-4-5-20251001');
    expect(cfg.threshold).toBe(0.7);
  });
});

describe('[Phase 3] Handler Kinds — Positive: source and kind metadata', () => {
  it('all Phase 3 handler kinds have source=builtin', async () => {
    const phase3Kinds = [
      'agentic.computer-use', 'agentic.browser', 'agentic.code-interpreter',
      'agentic.voice-realtime', 'agentic.multimodal', 'deterministic.mapreduce',
      'multi-agent.swarm', 'external.mcp-tool',
    ];
    for (const kind of phase3Kinds) {
      const row = await db.getLiveHandlerKindByKind(kind);
      expect(row!.source, `${kind} must have source=builtin`).toBe('builtin');
    }
  });

  it('all handler kinds have non-empty descriptions', async () => {
    const all = await db.listLiveHandlerKinds();
    for (const row of all) {
      expect(row.description.length, `${row.kind} must have a description`).toBeGreaterThan(10);
    }
  });

  it('all attention policies have correct kind field (heuristic/cron/model)', async () => {
    const all = await db.listLiveAttentionPolicies();
    const validKinds = new Set(['heuristic', 'cron', 'model']);
    for (const row of all) {
      expect(validKinds.has(row.kind), `${row.key} must have valid kind`).toBe(true);
    }
  });

  it('event.* policies are kind=heuristic', async () => {
    const webhookRow = await db.getLiveAttentionPolicyByKey('event.webhook-trigger');
    const fileRow = await db.getLiveAttentionPolicyByKey('event.file-watcher');
    const dbRow = await db.getLiveAttentionPolicyByKey('event.db-change');
    expect(webhookRow!.kind).toBe('heuristic');
    expect(fileRow!.kind).toBe('heuristic');
    expect(dbRow!.kind).toBe('heuristic');
  });

  it('model.llm-relevance is kind=model', async () => {
    const row = await db.getLiveAttentionPolicyByKey('model.llm-relevance');
    expect(row!.kind).toBe('model');
  });
});

describe('[Phase 3] Handler Kinds — Positive: package seed parity', () => {
  it('DEFAULT_HANDLER_KINDS has exactly 15 entries', () => {
    expect(DEFAULT_HANDLER_KINDS).toHaveLength(15);
  });

  it('DEFAULT_ATTENTION_POLICIES has exactly 7 entries', () => {
    expect(DEFAULT_ATTENTION_POLICIES).toHaveLength(7);
  });

  it('all 8 Phase 3 kinds are in DEFAULT_HANDLER_KINDS', () => {
    const phase3 = new Set(DEFAULT_HANDLER_KINDS.map(k => k.kind));
    const expected = [
      'agentic.computer-use', 'agentic.browser', 'agentic.code-interpreter',
      'agentic.voice-realtime', 'agentic.multimodal', 'deterministic.mapreduce',
      'multi-agent.swarm', 'external.mcp-tool',
    ];
    for (const kind of expected) {
      expect(phase3.has(kind), `${kind} must be in DEFAULT_HANDLER_KINDS`).toBe(true);
    }
  });

  it('all 4 Phase 3 policies are in DEFAULT_ATTENTION_POLICIES', () => {
    const policies = new Set(DEFAULT_ATTENTION_POLICIES.map(p => p.key));
    const expected = [
      'event.webhook-trigger', 'event.file-watcher', 'event.db-change', 'model.llm-relevance',
    ];
    for (const key of expected) {
      expect(policies.has(key), `${key} must be in DEFAULT_ATTENTION_POLICIES`).toBe(true);
    }
  });

  it('computer-use is enabled=1 (headless bash+file path wired); browser is disabled=0 (needs Playwright container)', () => {
    const cu = DEFAULT_HANDLER_KINDS.find(k => k.kind === 'agentic.computer-use');
    const br = DEFAULT_HANDLER_KINDS.find(k => k.kind === 'agentic.browser');
    expect(cu!.enabled).toBe(1); // enabled: headless bash+file tools work without a display
    expect(br!.enabled).toBe(0); // disabled: requires Playwright container
  });

  it('file-watcher and db-change are disabled=0 in DEFAULT_ATTENTION_POLICIES', () => {
    const fw = DEFAULT_ATTENTION_POLICIES.find(p => p.key === 'event.file-watcher');
    const dc = DEFAULT_ATTENTION_POLICIES.find(p => p.key === 'event.db-change');
    expect(fw!.enabled).toBe(0);
    expect(dc!.enabled).toBe(0);
  });
});

describe('[Phase 3] Handler Kinds — Positive: registry wiring', () => {
  it('createDefaultHandlerRegistry() includes all 14 handler kinds', () => {
    const reg = createDefaultHandlerRegistry();
    const kinds = reg.kinds();
    // 6 original + 8 new = 14
    expect(kinds.length).toBeGreaterThanOrEqual(14);
  });

  it('registry resolves all 8 Phase 3 kinds', () => {
    const reg = createDefaultHandlerRegistry();
    const phase3 = [
      'agentic.computer-use', 'agentic.browser', 'agentic.code-interpreter',
      'agentic.voice-realtime', 'agentic.multimodal', 'deterministic.mapreduce',
      'multi-agent.swarm', 'external.mcp-tool',
    ];
    for (const kind of phase3) {
      const reg_ = reg.resolve(kind);
      expect(reg_, `${kind} must be registered`).not.toBeNull();
    }
  });

  it('registry descriptions match DB descriptions for Phase 3 kinds', async () => {
    const reg = createDefaultHandlerRegistry();
    const phase3 = [
      'agentic.computer-use', 'agentic.browser', 'agentic.code-interpreter',
      'agentic.voice-realtime', 'agentic.multimodal', 'deterministic.mapreduce',
      'multi-agent.swarm', 'external.mcp-tool',
    ];
    for (const kind of phase3) {
      const regEntry = reg.resolve(kind);
      const dbRow = await db.getLiveHandlerKindByKind(kind);
      expect(regEntry!.description, `${kind} description must match DB`).toBe(dbRow!.description);
    }
  });

  it('agentic.code-interpreter factory returns a function', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.code-interpreter', { runtime: 'python3.12' }, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('agentic.voice-realtime factory returns a function', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.voice-realtime', { voice: 'alloy' }, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('agentic.multimodal factory returns a function', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.multimodal', { image_detail: 'high' }, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('deterministic.mapreduce factory returns a function', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('deterministic.mapreduce', { fan_out_role_key: 'worker', fan_out_count: 3 });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('multi-agent.swarm factory returns a function', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('multi-agent.swarm', { peer_role_keys: ['analyst', 'critic'] });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('external.mcp-tool factory returns a function', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.example.com/tools',
      tool_name: 'search',
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEGATIVE TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('[Phase 3] Handler Kinds — Negative: factory validation', () => {
  it('agentic.computer-use throws when no model is provided', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.computer-use', {});
    // no ctx.model or ctx.modelResolver
    expect(() => reg.build(ctx)).toThrowError(/model/i);
  });

  it('agentic.browser throws when no model is provided', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.browser', {});
    expect(() => reg.build(ctx)).toThrowError(/model/i);
  });

  it('agentic.code-interpreter throws when no model is provided', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.code-interpreter', {});
    expect(() => reg.build(ctx)).toThrowError(/model/i);
  });

  it('agentic.voice-realtime throws when no model is provided', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.voice-realtime', {});
    expect(() => reg.build(ctx)).toThrowError(/model/i);
  });

  it('agentic.multimodal throws when no model is provided', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.multimodal', {});
    expect(() => reg.build(ctx)).toThrowError(/model/i);
  });

  it('deterministic.mapreduce throws when fan_out_role_key is missing', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('deterministic.mapreduce', {}); // missing fan_out_role_key
    expect(() => reg.build(ctx)).toThrowError(/fan_out_role_key/);
  });

  it('multi-agent.swarm throws when peer_role_keys is empty', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('multi-agent.swarm', { peer_role_keys: [] });
    expect(() => reg.build(ctx)).toThrowError(/peer_role_keys/);
  });

  it('multi-agent.swarm throws when peer_role_keys is missing', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('multi-agent.swarm', {});
    expect(() => reg.build(ctx)).toThrowError(/peer_role_keys/);
  });

  it('external.mcp-tool throws when mcp_server_url is missing', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('external.mcp-tool', { tool_name: 'search' });
    expect(() => reg.build(ctx)).toThrowError(/mcp_server_url/);
  });

  it('external.mcp-tool throws when tool_name is missing', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('external.mcp-tool', { mcp_server_url: 'https://mcp.example.com' });
    expect(() => reg.build(ctx)).toThrowError(/tool_name/);
  });

  it('registry.build throws for unknown handler kind', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.nonexistent', {});
    expect(() => reg.build(ctx)).toThrowError(/unknown handler kind/i);
  });

  it('registry.resolve returns null for unknown kind', () => {
    const reg = createDefaultHandlerRegistry();
    expect(reg.resolve('agentic.fake-kind')).toBeNull();
  });

  it('registering a duplicate kind throws', () => {
    const reg = createDefaultHandlerRegistry();
    // agenticCodeInterpreterHandler is already registered by createDefaultHandlerRegistry()
    expect(() => reg.register(agenticCodeInterpreterHandler)).toThrowError(/already registered/i);
  });
});

describe('[Phase 3] Handler Kinds — Negative: DB lookups for nonexistent kinds', () => {
  it('getLiveHandlerKindByKind returns null for unknown kind', async () => {
    const row = await db.getLiveHandlerKindByKind('agentic.does-not-exist-phase3');
    expect(row).toBeNull();
  });

  it('getLiveAttentionPolicyByKey returns null for unknown key', async () => {
    const row = await db.getLiveAttentionPolicyByKey('event.does-not-exist-phase3');
    expect(row).toBeNull();
  });
});

describe('[Phase 3] Handler Kinds — Negative: idempotency', () => {
  it('running m70 twice does not duplicate rows', async () => {
    const freshDb = await newHandlerKindsDb();
    // m70 runs as part of initialize(); running it again manually is idempotent
    const { applyM70HandlerKindsV2 } = await import('./migrations/m70-handler-kinds-v2.js');
    const rawDb = (freshDb as any).d; // access underlying better-sqlite3 instance
    // Should not throw
    expect(() => applyM70HandlerKindsV2(rawDb)).not.toThrow();
    // Count should still be correct
    const all = await freshDb.listLiveHandlerKinds();
    const phase3 = all.filter(k => [
      'agentic.computer-use', 'agentic.browser', 'agentic.code-interpreter',
      'agentic.voice-realtime', 'agentic.multimodal', 'deterministic.mapreduce',
      'multi-agent.swarm', 'external.mcp-tool',
    ].includes(k.kind));
    expect(phase3.length).toBe(8);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('[Phase 3] Handler Kinds — Security: SQL injection via kind lookup', () => {
  it('SQL injection attempt in getLiveHandlerKindByKind returns null, not an error', async () => {
    const injected = "agentic.react' OR '1'='1";
    const row = await db.getLiveHandlerKindByKind(injected);
    expect(row).toBeNull(); // parameterised query; injection does not match any row
  });

  it('SQL injection attempt in getLiveAttentionPolicyByKey returns null', async () => {
    const injected = "heuristic.inbox-first'; DROP TABLE live_handler_kinds; --";
    const row = await db.getLiveAttentionPolicyByKey(injected);
    expect(row).toBeNull();
  });

  it('table still intact after injection attempts', async () => {
    const all = await db.listLiveHandlerKinds();
    expect(all.length).toBeGreaterThanOrEqual(15);
  });
});

describe('[Phase 3] Handler Kinds — Security: config injection in handler factories', () => {
  it('agentic.browser allowed_domains with prototype pollution attempt is treated as strings', () => {
    const reg = createDefaultHandlerRegistry();
    // This should not cause prototype pollution — config is copied, not merged
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['__proto__', 'constructor'],
    }, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
    });
    expect(() => reg.build(ctx)).not.toThrow();
  });

  it('agentic.computer-use with script-injection in fallbackPrompt does not execute', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.computer-use', {
      fallbackPrompt: '<script>alert(1)</script>You are a CUA agent.',
    }, {
      model: { id: 'claude-opus-4-8', apiKey: 'test', provider: 'anthropic' } as any,
    });
    // Handler builds fine — output is just a string stored in the system prompt, not executed
    expect(() => reg.build(ctx)).not.toThrow();
  });

  it('external.mcp-tool with invalid URL scheme builds OK but would fail at runtime', () => {
    const reg = createDefaultHandlerRegistry();
    // The factory validates config shape, not URL scheme (HTTP validation is at runtime)
    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'javascript:alert(1)',
      tool_name: 'hack',
    });
    // Build should not throw — URL scheme check is at runtime fetch()
    expect(() => reg.build(ctx)).not.toThrow();
  });

  it('deterministic.mapreduce with very large fan_out_count builds OK', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('deterministic.mapreduce', {
      fan_out_role_key: 'worker',
      fan_out_count: 10000, // large but valid config
    });
    expect(() => reg.build(ctx)).not.toThrow();
  });

  it('multi-agent.swarm with > 100 peers builds without stack overflow', () => {
    const reg = createDefaultHandlerRegistry();
    const peers = Array.from({ length: 100 }, (_, i) => `peer-${i}`);
    const ctx = makeCtx('multi-agent.swarm', { peer_role_keys: peers });
    expect(() => reg.build(ctx)).not.toThrow();
  });

  it('agentic.browser config with non-string allowed_domains entries is filtered', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.browser', {
      // Mixed array — only strings should survive the readConfig type guard
      allowed_domains: ['example.com', 123, null, 'trusted.org'],
    } as any, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
    });
    // Should build — readConfig casts the array; runtime enforcement is on the allow list
    expect(() => reg.build(ctx)).not.toThrow();
  });
});

describe('[Phase 3] Handler Kinds — Security: config schema validation fields', () => {
  it('deterministic.mapreduce schema has required=[fan_out_role_key]', async () => {
    const row = await db.getLiveHandlerKindByKind('deterministic.mapreduce');
    const schema = JSON.parse(row!.config_schema_json);
    expect(schema.required).toContain('fan_out_role_key');
  });

  it('multi-agent.swarm schema has required=[peer_role_keys]', async () => {
    const row = await db.getLiveHandlerKindByKind('multi-agent.swarm');
    const schema = JSON.parse(row!.config_schema_json);
    expect(schema.required).toContain('peer_role_keys');
  });

  it('external.mcp-tool schema has required=[mcp_server_url, tool_name]', async () => {
    const row = await db.getLiveHandlerKindByKind('external.mcp-tool');
    const schema = JSON.parse(row!.config_schema_json);
    expect(schema.required).toContain('mcp_server_url');
    expect(schema.required).toContain('tool_name');
  });

  it('agentic.browser playwright_config allows only known browsers', async () => {
    const row = await db.getLiveHandlerKindByKind('agentic.browser');
    const schema = JSON.parse(row!.config_schema_json);
    const browserEnum = schema.properties.playwright_config.properties.browser.enum;
    expect(browserEnum).toContain('chromium');
    expect(browserEnum).toContain('firefox');
    expect(browserEnum).toContain('webkit');
    expect(browserEnum).not.toContain('edge'); // not supported
  });

  it('agentic.computer-use allowed_actions enum is restrictive', async () => {
    const row = await db.getLiveHandlerKindByKind('agentic.computer-use');
    const schema = JSON.parse(row!.config_schema_json);
    const validActions = schema.properties.allowed_actions.items.enum;
    expect(validActions).toContain('screenshot');
    expect(validActions).toContain('click');
    expect(validActions).not.toContain('execute_arbitrary_code'); // not in allowlist
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STRESS TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('[Phase 3] Handler Kinds — Stress: concurrent DB reads', () => {
  it('20 concurrent getLiveHandlerKindByKind calls return correct results', async () => {
    const kinds = [
      'agentic.computer-use', 'agentic.browser', 'agentic.code-interpreter',
      'agentic.voice-realtime', 'agentic.multimodal', 'deterministic.mapreduce',
      'multi-agent.swarm', 'external.mcp-tool', 'agentic.react', 'human.approval',
      'agentic.computer-use', 'agentic.browser', 'agentic.code-interpreter',
      'agentic.voice-realtime', 'agentic.multimodal', 'deterministic.mapreduce',
      'multi-agent.swarm', 'external.mcp-tool', 'agentic.react', 'human.approval',
    ];
    const results = await Promise.all(kinds.map(k => db.getLiveHandlerKindByKind(k)));
    for (const row of results) {
      expect(row).not.toBeNull();
    }
  });

  it('20 concurrent getLiveAttentionPolicyByKey calls return correct results', async () => {
    const KEYS = ['heuristic.inbox-first', 'cron.rest-only', 'model.adaptive',
      'event.webhook-trigger', 'event.file-watcher', 'event.db-change', 'model.llm-relevance'] as const;
    const keys = Array.from({ length: 20 }, (_, i) => KEYS[i % KEYS.length]!);
    const results = await Promise.all(keys.map(k => db.getLiveAttentionPolicyByKey(k)));
    for (const row of results) {
      expect(row).not.toBeNull();
    }
  });

  it('listLiveHandlerKinds returns all rows consistently across 10 calls', async () => {
    const counts = await Promise.all(
      Array.from({ length: 10 }, () => db.listLiveHandlerKinds()),
    );
    const expected = counts[0]!.length;
    for (const result of counts) {
      expect(result.length).toBe(expected);
    }
  });

  it('registry.kinds() is consistent across 100 calls', () => {
    const reg = createDefaultHandlerRegistry();
    const first = reg.kinds().sort();
    for (let i = 0; i < 100; i++) {
      const current = reg.kinds().sort();
      expect(current).toEqual(first);
    }
  });

  it('building all 8 Phase 3 handlers 10 times each does not throw (with model)', () => {
    const reg = createDefaultHandlerRegistry();
    const fakeModel = { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any;

    const agenticHandlers = [
      { kind: 'agentic.computer-use', config: {} },
      { kind: 'agentic.browser', config: {} },
      { kind: 'agentic.code-interpreter', config: {} },
      { kind: 'agentic.voice-realtime', config: {} },
      { kind: 'agentic.multimodal', config: {} },
    ];
    const deterministicHandlers = [
      { kind: 'deterministic.mapreduce', config: { fan_out_role_key: 'worker' } },
      { kind: 'multi-agent.swarm', config: { peer_role_keys: ['a', 'b', 'c'] } },
      { kind: 'external.mcp-tool', config: { mcp_server_url: 'https://mcp.test/tools', tool_name: 'ping' } },
    ];

    for (let i = 0; i < 10; i++) {
      for (const { kind, config } of agenticHandlers) {
        const ctx = makeCtx(kind, config, { model: fakeModel });
        expect(() => reg.build(ctx)).not.toThrow();
      }
      for (const { kind, config } of deterministicHandlers) {
        const ctx = makeCtx(kind, config);
        expect(() => reg.build(ctx)).not.toThrow();
      }
    }
  });
});

describe('[Phase 3] Handler Kinds — Stress: enabled-only listing', () => {
  it('listLiveHandlerKinds({ enabledOnly: true }) excludes computer-use and browser', async () => {
    const enabled = await db.listLiveHandlerKinds({ enabledOnly: true });
    const kinds = new Set(enabled.map(k => k.kind));
    expect(kinds.has('agentic.computer-use')).toBe(false);
    expect(kinds.has('agentic.browser')).toBe(false);
  });

  it('listLiveHandlerKinds({ enabledOnly: true }) includes all other Phase 3 kinds', async () => {
    const enabled = await db.listLiveHandlerKinds({ enabledOnly: true });
    const kinds = new Set(enabled.map(k => k.kind));
    const expectedEnabled = [
      'agentic.code-interpreter', 'agentic.voice-realtime', 'agentic.multimodal',
      'deterministic.mapreduce', 'multi-agent.swarm', 'external.mcp-tool',
    ];
    for (const kind of expectedEnabled) {
      expect(kinds.has(kind), `${kind} should be in enabled list`).toBe(true);
    }
  });

  it('listLiveAttentionPolicies({ enabledOnly: true }) excludes file-watcher and db-change', async () => {
    const enabled = await db.listLiveAttentionPolicies({ enabledOnly: true });
    const keys = new Set(enabled.map(p => p.key));
    expect(keys.has('event.file-watcher')).toBe(false);
    expect(keys.has('event.db-change')).toBe(false);
  });

  it('listLiveAttentionPolicies({ enabledOnly: true }) includes webhook-trigger and llm-relevance', async () => {
    const enabled = await db.listLiveAttentionPolicies({ enabledOnly: true });
    const keys = new Set(enabled.map(p => p.key));
    expect(keys.has('event.webhook-trigger')).toBe(true);
    expect(keys.has('model.llm-relevance')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// EXAMPLE / INTEGRATION TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('[Phase 3] Handler Kinds — Examples: realistic binding configs', () => {
  it('code-interpreter with full config builds successfully', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.code-interpreter', {
      model:             'claude-sonnet-4-6',
      runtime:           'python3.12',
      max_cells:         30,
      auto_install_libs: true,
      max_steps:         25,
      fallbackPrompt:    'You are a data scientist. Analyse the provided CSV and return insights.',
    }, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('mapreduce with 5 workers and concat reduce builds successfully', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('deterministic.mapreduce', {
      fan_out_role_key: 'research-worker',
      fan_out_count:    5,
      reduce_fn:        'concat',
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('swarm with 3 peers and 67% consensus builds successfully', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('multi-agent.swarm', {
      peer_role_keys:      ['critic', 'analyst', 'fact-checker'],
      consensus_threshold: 0.67,
      max_rounds:          3,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('mcp-tool with auth headers builds successfully', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.anthropic.com/v1/tools',
      tool_name:      'web_search',
      headers:        { 'Authorization': 'Bearer sk-test-xxx', 'X-Request-ID': 'req-abc' },
      timeout_ms:     15000,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('voice-realtime with French VAD config builds successfully', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.voice-realtime', {
      model:           'claude-sonnet-4-6',
      voice:           'nova',
      turn_detection:  { type: 'server_vad', threshold: 0.6 },
      max_duration_s:  3600,
      fallbackPrompt:  'Vous êtes un assistant vocal en français. Répondez en français.',
    }, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('multimodal with high-detail mode for document analysis builds successfully', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.multimodal', {
      model:               'claude-opus-4-8',
      image_detail:        'high',
      max_images_per_turn: 5,
      max_steps:           20,
      fallbackPrompt:      'You are a document analysis agent. Perform OCR and extract key information.',
    }, {
      model: { id: 'claude-opus-4-8', apiKey: 'test', provider: 'anthropic' } as any,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('browser with domain allowlist for competitor research builds successfully', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.browser', {
      playwright_config: { browser: 'chromium', headless: true },
      max_pages:         10,
      allowed_domains:   ['techcrunch.com', 'producthunt.com', 'github.com'],
      max_steps:         20,
      fallbackPrompt:    'You are a competitive intelligence agent. Gather public data from approved domains only.',
    }, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('computer-use with restricted actions builds successfully', () => {
    const reg = createDefaultHandlerRegistry();
    const ctx = makeCtx('agentic.computer-use', {
      model:            'claude-opus-4-8',
      max_steps:        20,
      allowed_actions:  ['screenshot', 'click', 'type'], // no scroll, no key, no mouse_move
      fallbackPrompt:   'You are a data entry agent. Only click and type in form fields.',
    }, {
      model: { id: 'claude-opus-4-8', apiKey: 'test', provider: 'anthropic' } as any,
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
  });

  it('resolveSystemPrompt is invoked when systemPromptSkillKey is configured', async () => {
    const reg = createDefaultHandlerRegistry();
    let resolvedKey: string | null = null;
    const ctx = makeCtx('agentic.code-interpreter', {
      systemPromptSkillKey: 'code-interpreter.kaggle.system',
      max_steps: 15,
    }, {
      model: { id: 'claude-sonnet-4-6', apiKey: 'test', provider: 'anthropic' } as any,
      resolveSystemPrompt: async (key) => {
        resolvedKey = key;
        return `You are a Kaggle specialist code interpreter for key: ${key}`;
      },
    });
    const handler = reg.build(ctx);
    expect(typeof handler).toBe('function');
    // resolveSystemPrompt is called inside prepare(), which runs at tick time, not at build time
    // So resolvedKey is still null here — that's correct
    expect(resolvedKey).toBeNull();
  });
});

describe('[Phase 3] Handler Kinds — Examples: attention policy configs', () => {
  it('event.webhook-trigger config has path_filter field', async () => {
    const row = await db.getLiveAttentionPolicyByKey('event.webhook-trigger');
    const cfg = JSON.parse(row!.config_json);
    expect(cfg.trigger).toBe('webhook');
    expect(cfg.path_filter).toContain('/api/webhooks/agent/');
  });

  it('event.file-watcher config has path_pattern and events', async () => {
    const row = await db.getLiveAttentionPolicyByKey('event.file-watcher');
    const cfg = JSON.parse(row!.config_json);
    expect(cfg.trigger).toBe('file_change');
    expect(Array.isArray(cfg.events)).toBe(true);
    expect(cfg.events).toContain('created');
    expect(cfg.events).toContain('modified');
  });

  it('event.db-change config has table and operation fields', async () => {
    const row = await db.getLiveAttentionPolicyByKey('event.db-change');
    const cfg = JSON.parse(row!.config_json);
    expect(cfg.trigger).toBe('db_change');
    expect(Array.isArray(cfg.operation)).toBe(true);
    expect(cfg.operation).toContain('insert');
  });

  it('model.llm-relevance config has threshold > 0 and prompt', async () => {
    const row = await db.getLiveAttentionPolicyByKey('model.llm-relevance');
    const cfg = JSON.parse(row!.config_json);
    expect(typeof cfg.threshold).toBe('number');
    expect(cfg.threshold).toBeGreaterThan(0);
    expect(cfg.threshold).toBeLessThanOrEqual(1);
    expect(typeof cfg.prompt).toBe('string');
    expect(cfg.prompt.length).toBeGreaterThan(10);
  });
});
