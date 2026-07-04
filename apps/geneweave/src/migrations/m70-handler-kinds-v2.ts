/**
 * m70 — Handler Kinds & Attention Policies Taxonomy Expansion (mid-2026)
 *
 * Phase 3 of the mid-2026 DB content audit.  Fully idempotent:
 *   - All INSERTs use INSERT OR IGNORE so re-running is safe on existing installs.
 *
 * Changes:
 *   1. INSERT 8 new live_handler_kinds:
 *        agentic.computer-use    (enabled=0 — needs CUA sandbox)
 *        agentic.browser         (enabled=0 — needs Playwright container)
 *        agentic.code-interpreter
 *        agentic.voice-realtime
 *        agentic.multimodal
 *        deterministic.mapreduce
 *        multi-agent.swarm
 *        external.mcp-tool
 *
 *   2. INSERT 4 new live_attention_policies:
 *        event.webhook-trigger   (enabled=1)
 *        event.file-watcher      (enabled=0 — needs FS-watcher daemon)
 *        event.db-change         (enabled=0 — needs CDC pipeline)
 *        model.llm-relevance     (enabled=1)
 *
 * Architecture note:
 *   The handler TypeScript implementations live in
 *   packages/live-agents-runtime/src/handlers/. This migration only persists
 *   the catalog rows; the runtime registers the TypeScript handlers on boot
 *   via `createDefaultHandlerRegistry()`.
 *
 * Reference (mid-2026 platforms):
 *   - Anthropic CUA: claude-opus-4-8 with computer_use tool (GA June 2026)
 *   - Playwright: stable v1.44+ (Chromium, Firefox, WebKit sandboxes)
 *   - MCP spec: modelcontextprotocol.io v0.7 (JSON-RPC 2.0 tools/call)
 */

import type BetterSqlite3 from 'better-sqlite3';

export function applyM70HandlerKindsV2(db: BetterSqlite3.Database): void {
  // ── 1. INSERT 8 new handler kinds (INSERT OR IGNORE = fully idempotent) ───

  const insertKind = db.prepare(`
    INSERT OR IGNORE INTO live_handler_kinds
      (id, kind, description, config_schema_json, source, enabled)
    VALUES
      (@id, @kind, @description, @config_schema_json, 'builtin', @enabled)
  `);

  const newKinds = [
    {
      id:                  'm70-handler-01-computer-use',
      kind:                'agentic.computer-use',
      description:         'Autonomous computer control via screenshot→action loop (Anthropic CUA / claude-opus-4-8). Takes screenshots and performs clicks, typing, and scrolling to complete GUI tasks.',
      config_schema_json:  JSON.stringify({
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
      enabled: 0, // enabled when CUA sandbox is provisioned
    },
    {
      id:                 'm70-handler-02-browser',
      kind:               'agentic.browser',
      description:        'Programmatic browser automation using Playwright. Navigates URLs, extracts content, fills forms, and captures screenshots in an isolated browser sandbox.',
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
      id:                 'm70-handler-03-code-interpreter',
      kind:               'agentic.code-interpreter',
      description:        'Python code execution in a sandboxed CSE environment. Supports data analysis, visualisation, file I/O, and auto-installing packages. Returns stdout, stderr, and generated files.',
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
      enabled: 1,
    },
    {
      id:                 'm70-handler-04-voice-realtime',
      kind:               'agentic.voice-realtime',
      description:        'Real-time speech-to-text and text-to-speech interaction over WebRTC/WebSocket. Supports 30+ languages, server VAD turn detection, and configurable voice personas.',
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
      enabled: 1,
    },
    {
      id:                 'm70-handler-05-multimodal',
      kind:               'agentic.multimodal',
      description:        'Vision-first ReAct loop for tasks where images are the primary input. Controls image detail level and per-turn image count to manage token budget.',
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
      enabled: 1,
    },
    {
      id:                 'm70-handler-06-mapreduce',
      kind:               'deterministic.mapreduce',
      description:        'No LLM call in supervisor. Fans out one inbox item to N worker agents (by role key) and awaits all to complete before reducing results into a single contract.',
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
      enabled: 1,
    },
    {
      id:                 'm70-handler-07-swarm',
      kind:               'multi-agent.swarm',
      description:        'Peer agents collaborate without a designated supervisor. Each peer processes the inbox and emits a response; consensus is reached when ≥ threshold fraction agree.',
      config_schema_json: JSON.stringify({
        type: 'object',
        required: ['peer_role_keys'],
        properties: {
          peer_role_keys: { type: 'array', items: { type: 'string' } },
          consensus_threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.67 },
          max_rounds: { type: 'integer', default: 3 },
        },
      }),
      enabled: 1,
    },
    {
      id:                 'm70-handler-08-mcp-tool',
      kind:               'external.mcp-tool',
      description:        'Invokes a single tool on an external MCP (Model Context Protocol) server via JSON-RPC. Returns the tool result as the agent output without any LLM call.',
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
      enabled: 1,
    },
  ];

  for (const row of newKinds) {
    insertKind.run(row);
  }

  // ── 2. INSERT 4 new attention policies ────────────────────────────────────

  const insertPolicy = db.prepare(`
    INSERT OR IGNORE INTO live_attention_policies
      (id, key, kind, description, config_json, enabled)
    VALUES
      (@id, @key, @kind, @description, @config_json, @enabled)
  `);

  const newPolicies = [
    {
      id:          'm70-policy-01-webhook-trigger',
      key:         'event.webhook-trigger',
      kind:        'heuristic',
      description: 'Wake the agent immediately when an authenticated webhook POST arrives on its dedicated path. Zero latency for external-event-driven agents.',
      config_json: JSON.stringify({
        trigger:     'webhook',
        secret:      '',
        path_filter: '/api/webhooks/agent/*',
      }),
      enabled: 1,
    },
    {
      id:          'm70-policy-02-file-watcher',
      key:         'event.file-watcher',
      kind:        'heuristic',
      description: 'Wake the agent when a file system change matching the pattern is detected. Requires a FS-watcher daemon (inotify / FSEvents) attached to the deployment.',
      config_json: JSON.stringify({
        trigger:      'file_change',
        path_pattern: '/data/**',
        events:       ['created', 'modified'],
      }),
      enabled: 0, // enabled when FS-watcher daemon is provisioned
    },
    {
      id:          'm70-policy-03-db-change',
      key:         'event.db-change',
      kind:        'heuristic',
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
      id:          'm70-policy-04-llm-relevance',
      key:         'model.llm-relevance',
      kind:        'model',
      description: 'Calls a lightweight LLM to decide whether the pending inbox item warrants agent attention. Avoids waking agents for noise while ensuring relevant events are acted on.',
      config_json: JSON.stringify({
        strategy:  'llm_relevance',
        model:     'claude-haiku-4-5-20251001',
        threshold: 0.7,
        prompt:    'Does this inbox item require immediate agent attention? Reply YES or NO with a confidence score.',
      }),
      enabled: 1,
    },
  ];

  for (const row of newPolicies) {
    insertPolicy.run(row);
  }
}
