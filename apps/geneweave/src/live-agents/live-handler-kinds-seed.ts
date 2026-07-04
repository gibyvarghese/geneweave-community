/**
 * First-run seed for the live-agents runtime registries.
 *
 * Two tables, both DB-driven from operator perspective:
 *
 *  1. `live_handler_kinds`     — the catalog of handler shapes the runtime
 *                                knows how to execute (agentic ReAct,
 *                                deterministic template, human approval, …).
 *                                Plugins can append additional `source='plugin'`
 *                                rows; this seed only inserts the framework
 *                                builtins on first boot.
 *
 *  2. `live_attention_policies` — when an agent should be picked up for a
 *                                tick (heuristic inbox-first, cron rest-only,
 *                                model.adaptive). Personas reference these by
 *                                key so the runtime never bakes scheduling
 *                                logic into TypeScript.
 *
 * Idempotent: each row is gated on existence (`getLiveHandlerKindByKind`,
 * `getLiveAttentionPolicyByKey`). Operator edits to existing rows are never
 * overwritten on subsequent boots.
 *
 * Phase 3 additions (mid-2026):
 *   Handler kinds:  agentic.computer-use, agentic.browser, agentic.code-interpreter,
 *                   agentic.voice-realtime, agentic.multimodal, deterministic.mapreduce,
 *                   multi-agent.swarm, external.mcp-tool
 *   Attention:      event.webhook-trigger, event.file-watcher, event.db-change,
 *                   model.llm-relevance
 */
import type { DatabaseAdapter } from '../db.js';
import { newUUIDv7 } from '../lib/uuid.js';

interface SeedHandlerKind {
  kind: string;
  description: string;
  config_schema_json: string;
  enabled?: number; // 0 = disabled, 1 = enabled (default 1)
}

interface SeedAttentionPolicy {
  key: string;
  kind: 'heuristic' | 'cron' | 'model';
  description: string;
  config_json: string;
  enabled?: number; // 0 = disabled, 1 = enabled (default 1)
}

const HANDLER_KINDS: SeedHandlerKind[] = [
  // ── Original 7 (Phase 0 baseline) ─────────────────────────────────────────
  {
    kind: 'agentic.react',
    description: 'LLM-driven ReAct loop. The agent reasons over its tool catalog and decides when to act vs delegate.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Optional model id; otherwise routing decides.' },
        max_steps: { type: 'integer', default: 8 },
      },
    }),
  },
  {
    kind: 'agentic.scripted',
    description: 'LLM follows a fixed sequence of declared steps; useful for known pipelines that still need natural-language handling.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['steps'],
    }),
  },
  {
    kind: 'deterministic.template',
    description: 'No LLM call. Renders a string template against the inbox context and emits the result as a contract.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Mustache-style template.' },
      },
      required: ['template'],
    }),
  },
  {
    kind: 'deterministic.forward',
    description: 'No LLM call. Forwards the inbox payload to another agent / mesh queue.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        target_role_key: { type: 'string' },
      },
      required: ['target_role_key'],
    }),
  },
  {
    kind: 'deterministic.observer',
    description: 'No LLM call. Records the inbox event in the runs ledger without acting on it. Useful for audit-only roles.',
    config_schema_json: JSON.stringify({ type: 'object', properties: {} }),
  },
  {
    kind: 'human.approval',
    description: 'Pauses the run and writes a tool_approval_requests row. Human grants/denies via admin UI.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Message shown to the human reviewer.' },
      },
    }),
  },
  {
    kind: 'external.webhook',
    description: 'Posts the inbox payload to an external HTTPS endpoint and treats the response as the agent output.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        headers: { type: 'object' },
      },
      required: ['url'],
    }),
  },

  // ── Phase 3 — New execution loops (mid-2026) ─────────────────────────────
  {
    kind:        'agentic.computer-use',
    description: 'Autonomous computer control via screenshot→action loop (Anthropic CUA / claude-opus-4-8). Takes screenshots and performs clicks, typing, and scrolling to complete GUI tasks.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model:                  { type: 'string', default: 'claude-opus-4-8' },
        screenshot_interval_ms: { type: 'integer', default: 1000 },
        max_steps:              { type: 'integer', default: 50 },
        allowed_actions: {
          type: 'array',
          items: { type: 'string', enum: ['screenshot', 'click', 'type', 'scroll', 'key', 'mouse_move'] },
        },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
      },
    }),
    enabled: 1, // enabled — uses bash + file tools without a display; GUI actions require Xvfb
  },
  {
    kind:        'agentic.browser',
    description: 'Programmatic browser automation using Playwright. Navigates URLs, extracts content, fills forms, and captures screenshots in an isolated browser sandbox.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model:           { type: 'string' },
        playwright_config: {
          type: 'object',
          properties: {
            browser:  { type: 'string', enum: ['chromium', 'firefox', 'webkit'], default: 'chromium' },
            headless: { type: 'boolean', default: true },
          },
        },
        max_pages:       { type: 'integer', default: 5 },
        allowed_domains: { type: 'array', items: { type: 'string' } },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
        max_steps:       { type: 'integer', default: 30 },
      },
    }),
    enabled: 0, // enabled when Playwright container is provisioned
  },
  {
    kind:        'agentic.code-interpreter',
    description: 'Python code execution in a sandboxed CSE environment. Supports data analysis, visualisation, file I/O, and auto-installing packages. Returns stdout, stderr, and generated files.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model:             { type: 'string' },
        runtime:           { type: 'string', enum: ['python3.12', 'python3.11', 'python3.10'], default: 'python3.12' },
        max_cells:         { type: 'integer', default: 20 },
        auto_install_libs: { type: 'boolean', default: true },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
        max_steps:         { type: 'integer', default: 20 },
      },
    }),
  },
  {
    kind:        'agentic.voice-realtime',
    description: 'Real-time speech-to-text and text-to-speech interaction over WebRTC/WebSocket. Supports 30+ languages, server VAD turn detection, and configurable voice personas.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model: { type: 'string' },
        voice: { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], default: 'alloy' },
        turn_detection: {
          type: 'object',
          properties: {
            type:      { type: 'string', enum: ['server_vad', 'none'], default: 'server_vad' },
            threshold: { type: 'number', default: 0.5 },
          },
        },
        max_duration_s:       { type: 'integer', default: 1800 },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
        max_steps:            { type: 'integer', default: 60 },
      },
    }),
  },
  {
    kind:        'agentic.multimodal',
    description: 'Vision-first ReAct loop for tasks where images are the primary input. Controls image detail level and per-turn image count to manage token budget.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model:               { type: 'string' },
        image_detail:        { type: 'string', enum: ['low', 'high', 'auto'], default: 'auto' },
        max_images_per_turn: { type: 'integer', default: 10 },
        max_steps:           { type: 'integer', default: 12 },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
      },
    }),
  },
  {
    kind:        'deterministic.mapreduce',
    description: 'No LLM call in supervisor. Fans out one inbox item to N worker agents (by role key) and awaits all to complete before reducing results into a single contract.',
    config_schema_json: JSON.stringify({
      type: 'object',
      required: ['fan_out_role_key'],
      properties: {
        fan_out_role_key: { type: 'string', description: 'Role key of worker agents to fan-out to.' },
        reduce_fn: {
          type: 'string',
          enum: ['concat', 'vote', 'summarize', 'first'],
          default: 'concat',
        },
        fan_out_count: { type: 'integer', default: 3 },
      },
    }),
  },
  {
    kind:        'multi-agent.swarm',
    description: 'Peer agents collaborate without a designated supervisor. Each peer processes the inbox and emits a response; consensus is reached when ≥ threshold fraction agree.',
    config_schema_json: JSON.stringify({
      type: 'object',
      required: ['peer_role_keys'],
      properties: {
        peer_role_keys: { type: 'array', items: { type: 'string' } },
        consensus_threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.67 },
        max_rounds: { type: 'integer', default: 3 },
      },
    }),
  },
  {
    kind:        'external.mcp-tool',
    description: 'Invokes a single tool on an external MCP (Model Context Protocol) server via JSON-RPC. Returns the tool result as the agent output without any LLM call.',
    config_schema_json: JSON.stringify({
      type: 'object',
      required: ['mcp_server_url', 'tool_name'],
      properties: {
        mcp_server_url: { type: 'string', format: 'uri' },
        tool_name:      { type: 'string' },
        headers:        { type: 'object' },
        timeout_ms:     { type: 'integer', default: 30000 },
      },
    }),
  },
];

const ATTENTION_POLICIES: SeedAttentionPolicy[] = [
  // ── Original 3 (Phase 0 baseline) ─────────────────────────────────────────
  {
    key: 'heuristic.inbox-first',
    kind: 'heuristic',
    description: 'Run whenever the agent has unread inbox items. Lowest latency, highest cost.',
    config_json: JSON.stringify({ trigger: 'inbox_nonempty' }),
  },
  {
    key: 'cron.rest-only',
    kind: 'cron',
    description: 'Run on a fixed cron schedule regardless of inbox. Good for periodic sweeps (e.g. discoverers).',
    config_json: JSON.stringify({ cron: '0 */1 * * *' }), // hourly
  },
  {
    key: 'model.adaptive',
    kind: 'model',
    description: 'Routing model decides when to wake the agent based on inbox semantics + recent run history.',
    config_json: JSON.stringify({ scorer: 'default', threshold: 0.5 }),
  },

  // ── Phase 3 — Event-driven and model-gated attention (mid-2026) ───────────
  {
    key:  'event.webhook-trigger',
    kind: 'heuristic',
    description: 'Wake the agent immediately when an authenticated webhook POST arrives on its dedicated path. Zero latency for external-event-driven agents.',
    config_json: JSON.stringify({
      trigger:     'webhook',
      secret:      '',
      path_filter: '/api/webhooks/agent/*',
    }),
  },
  {
    key:     'event.file-watcher',
    kind:    'heuristic',
    description: 'Wake the agent when a file system change matching the pattern is detected. Requires a FS-watcher daemon (inotify / FSEvents) attached to the deployment.',
    config_json: JSON.stringify({
      trigger:      'file_change',
      path_pattern: '/data/**',
      events:       ['created', 'modified'],
    }),
    enabled: 0, // enabled when FS-watcher daemon is provisioned
  },
  {
    key:     'event.db-change',
    kind:    'heuristic',
    description: 'Wake the agent when a row matching the filter is inserted/updated/deleted in the configured table. Requires DB change-data-capture (CDC) integration.',
    config_json: JSON.stringify({
      trigger:   'db_change',
      table:     '',
      operation: ['insert', 'update'],
      filter:    {},
    }),
    enabled: 0, // enabled when CDC pipeline is configured
  },
  {
    key:  'model.llm-relevance',
    kind: 'model',
    description: 'Calls a lightweight LLM to decide whether the pending inbox item warrants agent attention. Avoids waking agents for noise while ensuring relevant events are acted on.',
    config_json: JSON.stringify({
      strategy:  'llm_relevance',
      model:     'claude-haiku-4-5-20251001',
      threshold: 0.7,
      prompt:    'Does this inbox item require immediate agent attention? Reply YES or NO with a confidence score.',
    }),
  },
];

/**
 * Seed framework builtin handler kinds. Per-row idempotent.
 */
export async function seedLiveHandlerKinds(db: DatabaseAdapter): Promise<void> {
  for (const k of HANDLER_KINDS) {
    const existing = await db.getLiveHandlerKindByKind(k.kind);
    if (existing) continue;
    await db.createLiveHandlerKind({
      id: newUUIDv7(),
      kind: k.kind,
      description: k.description,
      config_schema_json: k.config_schema_json,
      source: 'builtin',
      enabled: k.enabled ?? 1,
    });
  }
}

/**
 * Seed framework builtin attention policies. Per-row idempotent.
 */
export async function seedLiveAttentionPolicies(db: DatabaseAdapter): Promise<void> {
  for (const p of ATTENTION_POLICIES) {
    const existing = await db.getLiveAttentionPolicyByKey(p.key);
    if (existing) continue;
    await db.createLiveAttentionPolicy({
      id: newUUIDv7(),
      key: p.key,
      kind: p.kind,
      description: p.description,
      config_json: p.config_json,
      enabled: p.enabled ?? 1,
    });
  }
}
