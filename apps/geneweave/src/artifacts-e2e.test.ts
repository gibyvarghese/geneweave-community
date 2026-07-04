/**
 * GeneWeave — Artifact E2E tests (Phase 1)
 *
 * Two tiers:
 *
 *  1. Fake-model E2E — uses weaveFakeModel with canned emit_artifact tool calls to
 *     exercise the full artifact persistence stack (tool execution → artifactSave
 *     callback → SQLite / filesystem) without any real API credits.
 *
 *  2. Live-model E2E — uses a real LLM (OpenAI GPT-4o-mini or Anthropic Haiku) to
 *     verify the agent autonomously decides to call emit_artifact when asked.
 *     Skipped when API keys are absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { SQLiteAdapter } from './db-sqlite.js';
import { createToolRegistry } from './tools.js';
import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import { createArtifactStore } from '@weaveintel/artifacts';
import { weaveFakeModel } from '@weaveintel/testing';

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
const OPENAI_KEY = process.env['OPENAI_API_KEY'];
const HAS_LIVE_KEY = !!(ANTHROPIC_KEY || OPENAI_KEY);

function makeTempDb(): string {
  return join(tmpdir(), `gw-artifact-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gw-artifact-e2e-fs-'));
}

// ─── Fake-model: full persistence stack ───────────────────────────────────────
//
// weaveFakeModel drives emit_artifact with known args so we can assert exact
// persistence behavior without spending API credits.

describe('E2E (fake model): artifact persistence through weaveAgent', () => {
  let db: SQLiteAdapter;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    db = new SQLiteAdapter(dbPath);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  });

  it('agent emits a text artifact — SQLite row is created', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc1', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'hello-world', type: 'text', data: 'Hello, World!' }) } }],
        },
        { content: 'Artifact saved successfully.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'fake-user', sessionId: 'fake-sess-1' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'fake-artifact-agent', maxSteps: 5 });
    const result = await agent.run(weaveContext({ userId: 'fake-user' }), {
      messages: [],
      goal: 'Emit the hello-world artifact.',
    });

    expect(result.status).toBe('completed');
    const artifacts = await db.listArtifacts!({ userId: 'fake-user' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.name).toBe('hello-world');
    expect(artifacts[0]!.data_text).toBe('Hello, World!');
    expect(artifacts[0]!.user_id).toBe('fake-user');
    expect(artifacts[0]!.session_id).toBe('fake-sess-1');
  });

  it('agent emits a JSON artifact — mime type is inferred correctly', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc1', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'config', type: 'json', data: '{"version":1,"enabled":true}' }) } }],
        },
        { content: 'Done.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'json-user' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'json-agent', maxSteps: 5 });
    await agent.run(weaveContext({ userId: 'json-user' }), { messages: [], goal: 'Emit config.' });

    const artifacts = await db.listArtifacts!({ userId: 'json-user' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.mime_type).toBe('application/json');
    expect(artifacts[0]!.name).toBe('config');
  });

  it('agent emits multiple artifacts in one turn — all are persisted', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [
            { id: 'tc1', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'report', type: 'text', data: 'Report content' }) } },
            { id: 'tc2', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'data', type: 'csv', data: 'col1,col2\n1,2' }) } },
          ],
        },
        { content: 'Both artifacts saved.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'multi-user' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'multi-agent', maxSteps: 5 });
    await agent.run(weaveContext({ userId: 'multi-user' }), { messages: [], goal: 'Emit two artifacts.' });

    const artifacts = await db.listArtifacts!({ userId: 'multi-user' });
    expect(artifacts).toHaveLength(2);
    const names = artifacts.map((a) => a.name).sort();
    expect(names).toEqual(['data', 'report']);
  });

  it('emit_artifact tool result contains artifactId and version', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc1', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'versioned', type: 'markdown', data: '# Title' }) } }],
        },
        { content: 'Saved.' },
      ],
    });

    const savedRef: { id: string; version: number } = { id: '', version: 0 };

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'ref-user' });
        savedRef.id = row.id;
        savedRef.version = row.version;
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'ref-agent', maxSteps: 5 });
    const result = await agent.run(weaveContext({ userId: 'ref-user' }), { messages: [], goal: 'Emit versioned doc.' });

    expect(result.status).toBe('completed');
    // Tool result should be embedded in step output
    const toolStep = result.steps.find((s) => s.type === 'tool_call' && s.toolCall?.name === 'emit_artifact');
    expect(toolStep).toBeDefined();
    const toolResult = JSON.parse(toolStep!.toolCall!.result ?? '{}') as Record<string, unknown>;
    expect(toolResult['ok']).toBe(true);
    expect(typeof toolResult['artifactId']).toBe('string');
    expect(toolResult['version']).toBe(1);
    expect(toolResult['artifactId']).toBe(savedRef.id);
  });

  it('getArtifactVersions returns 1 entry after fake-model save', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc1', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'doc', type: 'text', data: 'v1 content' }) } }],
        },
        { content: 'Saved.' },
      ],
    });

    let savedId = '';
    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'ver-user' });
        savedId = row.id;
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'ver-agent', maxSteps: 5 });
    await agent.run(weaveContext({ userId: 'ver-user' }), { messages: [], goal: 'Emit doc.' });

    const versions = await db.getArtifactVersions!(savedId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
  });

  it('no artifact is persisted when artifactSave callback throws', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc1', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'fail-art', type: 'text', data: 'x' }) } }],
        },
        { content: 'Tool failed but I handled it.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async () => { throw new Error('storage unavailable'); },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'fail-agent', maxSteps: 5 });
    const result = await agent.run(weaveContext({ userId: 'fail-user' }), { messages: [], goal: 'Emit artifact.' });

    expect(result.status).toBe('completed');
    const toolStep = result.steps.find((s) => s.type === 'tool_call' && s.toolCall?.name === 'emit_artifact');
    const toolResult = JSON.parse(toolStep?.toolCall?.result ?? '{}') as Record<string, unknown>;
    expect(toolResult['ok']).toBe(false);
    expect(String(toolResult['error'])).toContain('storage unavailable');
  });
});

// ─── Fake-model: filesystem backend ───────────────────────────────────────────

describe('E2E (fake model): filesystem artifact backend via weaveAgent', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('artifact is written to disk via filesystem store', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc1', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'fs-test', type: 'text', data: 'filesystem content' }) } }],
        },
        { content: 'Done.' },
      ],
    });

    const fsStore = await createArtifactStore({ backend: 'filesystem', path: tmpDir });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const artifact = await fsStore.save({
          name: input.name,
          type: (input.type as Parameters<typeof fsStore.save>[0]['type']) ?? 'text',
          mimeType: input.mimeType ?? 'text/plain',
          data: input.data ?? '',
          version: 1,
          scope: 'session',
          userId: 'fs-fake-user',
        });
        return { id: artifact.id, version: artifact.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'fs-fake-agent', maxSteps: 5 });
    const result = await agent.run(weaveContext({ userId: 'fs-fake-user' }), { messages: [], goal: 'Emit fs artifact.' });

    expect(result.status).toBe('completed');

    const allArtifacts = await fsStore.list({ userId: 'fs-fake-user' });
    expect(allArtifacts).toHaveLength(1);
    expect(allArtifacts[0]!.name).toBe('fs-test');
    expect(existsSync(join(tmpDir, allArtifacts[0]!.id, 'meta.json'))).toBe(true);
    expect(existsSync(join(tmpDir, allArtifacts[0]!.id, 'v1.txt'))).toBe(true);
  });
});

// ─── Fake-model: negative path ────────────────────────────────────────────────

describe('E2E (fake model): negative paths', () => {
  it('agent without emit_artifact in registry completes with no artifacts saved', async () => {
    const model = weaveFakeModel({ responses: ['4'] });

    // Empty tool list — emit_artifact is not registered
    const registry = await createToolRegistry([], [], { actorPersona: 'tenant_user' });

    const artifactsSaved: unknown[] = [];
    const agent = weaveAgent({
      model,
      tools: registry,
      name: 'no-artifact-agent',
      maxSteps: 3,
    });

    const result = await agent.run(weaveContext({ userId: 'neg-user' }), {
      messages: [],
      goal: 'What is 2 + 2?',
    });

    expect(result.status).toBe('completed');
    expect(artifactsSaved).toHaveLength(0);
    expect(result.output).toBeTruthy();
  });

  it('emit_artifact is absent from registry when artifactSave callback is not provided', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      // no artifactSave
    });
    expect(registry.get('emit_artifact')).toBeUndefined();
  });
});

// ─── Live-model E2E (OpenAI) ──────────────────────────────────────────────────
//
// Single live-model test: verify Claude/GPT autonomously calls emit_artifact.
// Skipped when no API key is available so CI without secrets succeeds.

describe('E2E (live model): autonomous emit_artifact via OpenAI', () => {
  let db: SQLiteAdapter;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    db = new SQLiteAdapter(dbPath);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  });

  it.skipIf(!HAS_LIVE_KEY)('live agent calls emit_artifact and artifact is persisted', async () => {
    let model;
    if (OPENAI_KEY) {
      const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
      model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY });
    } else {
      const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');
      model = weaveAnthropicModel('claude-haiku-4-5-20251001', { apiKey: ANTHROPIC_KEY! });
    }

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'live-user', sessionId: 'live-session' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({
      model,
      tools: registry,
      name: 'live-artifact-agent',
      maxSteps: 6,
    });

    const prompt = 'Use the emit_artifact tool to save a text artifact named "live-test" with content "Live agent test passed" and mime type text/plain.';
    const result = await agent.run(weaveContext({ userId: 'live-user' }), {
      messages: [{ role: 'user', content: prompt }],
      goal: prompt,
    });

    expect(result.status).toBe('completed');

    const artifacts = await db.listArtifacts!({ userId: 'live-user' });
    expect(artifacts.length).toBeGreaterThanOrEqual(1);

    const artifact = artifacts.find((a) => a.name === 'live-test' || (a.data_text ?? '').toLowerCase().includes('live'));
    expect(artifact).toBeDefined();
    expect(artifact?.user_id).toBe('live-user');
  }, 90_000);
});

// ─── Phase 2-J: New types via weaveAgent (fake model) ────────────────────────

describe('E2E (fake model): Phase 2 extended artifact types', () => {
  let db: SQLiteAdapter;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `gw-artifact-phase2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new SQLiteAdapter(dbPath);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  });

  const NEW_TYPES = [
    { type: 'mermaid', data: 'graph TD\n  A-->B', expectedMime: 'text/x-mermaid' },
    { type: 'react', data: 'export default function App() { return <div>Hello</div>; }', expectedMime: 'text/typescript' },
    { type: 'interactive', data: '<div id="app"></div><script>console.log("hello")</script>', expectedMime: 'text/html' },
    { type: 'svg', data: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="5"/></svg>', expectedMime: 'image/svg+xml' },
    { type: 'audio', data: 'base64audiodata==', expectedMime: 'audio/mpeg' },
    { type: 'video', data: 'base64videodata==', expectedMime: 'video/mp4' },
    { type: 'spreadsheet', data: 'col1,col2\n1,2', expectedMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ] as const;

  for (const { type, data, expectedMime } of NEW_TYPES) {
    it(`agent emits a "${type}" artifact — saved and MIME type set`, async () => {
      const model = weaveFakeModel({
        responses: [
          {
            content: '',
            toolCalls: [{ id: `tc-${type}`, function: { name: 'emit_artifact', arguments: JSON.stringify({ name: `${type}-test`, type, data }) } }],
          },
          { content: `${type} artifact saved.` },
        ],
      });

      const registry = await createToolRegistry(['emit_artifact'], [], {
        actorPersona: 'tenant_user',
        artifactSave: async (input) => {
          const row = await db.saveArtifact!({ ...input, userId: 'phase2-user', sessionId: `sess-${type}` });
          return { id: row.id, version: row.version };
        },
      });

      const agent = weaveAgent({ model, tools: registry, name: `${type}-agent`, maxSteps: 5 });
      const result = await agent.run(weaveContext({ userId: 'phase2-user' }), {
        messages: [],
        goal: `Emit a ${type} artifact.`,
      });

      expect(result.status).toBe('completed');
      const artifacts = await db.listArtifacts!({ userId: 'phase2-user', type });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.type).toBe(type);
      expect(artifacts[0]!.mime_type).toBe(expectedMime);
    });
  }

  it('code artifact with language — language stored in metadata', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc-code', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'analysis.py', type: 'code', data: 'import pandas as pd\ndf = pd.DataFrame()', language: 'python' }) } }],
        },
        { content: 'Python script saved.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'code-user' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'code-agent', maxSteps: 5 });
    const result = await agent.run(weaveContext({ userId: 'code-user' }), {
      messages: [],
      goal: 'Emit a Python code artifact.',
    });

    expect(result.status).toBe('completed');
    const artifacts = await db.listArtifacts!({ userId: 'code-user' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.type).toBe('code');
    expect(artifacts[0]!.mime_type).toBe('text/x-python');
    const meta = JSON.parse(artifacts[0]!.metadata ?? '{}');
    expect(meta.language).toBe('python');
  });

  it('tenant settings blocking: emit_artifact blocked when type not in allowed_types', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc-blocked', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'blocked', type: 'html', data: '<html/>' }) } }],
        },
        { content: 'I could not save the artifact: type is not allowed.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'restricted-user' });
        return { id: row.id, version: row.version };
      },
      resolvedArtifactSettings: {
        allowed_types: ['text', 'json', 'csv'],
        max_size_bytes: null,
        emit_enabled: true,
        preview_enabled: true,
        sandbox_html: true,
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'restricted-agent', maxSteps: 5 });
    await agent.run(weaveContext({ userId: 'restricted-user' }), {
      messages: [],
      goal: 'Emit an HTML artifact.',
    });

    // No artifact should be saved since the tool returned ok=false
    const artifacts = await db.listArtifacts!({ userId: 'restricted-user' });
    expect(artifacts).toHaveLength(0);
  });

  it('tenant settings: emit_enabled=false blocks all artifact types', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc-disabled', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'should-not-save', type: 'text', data: 'data' }) } }],
        },
        { content: 'Artifact emission is disabled.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'disabled-user' });
        return { id: row.id, version: row.version };
      },
      resolvedArtifactSettings: {
        allowed_types: null,
        max_size_bytes: null,
        emit_enabled: false,
        preview_enabled: false,
        sandbox_html: false,
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'disabled-agent', maxSteps: 5 });
    await agent.run(weaveContext({ userId: 'disabled-user' }), {
      messages: [],
      goal: 'Emit a text artifact.',
    });

    const artifacts = await db.listArtifacts!({ userId: 'disabled-user' });
    expect(artifacts).toHaveLength(0);
  });
});

// ─── Phase 2-J: Live model test for Phase 2 types ────────────────────────────

describe('E2E (live model): Phase 2 new types via OpenAI', () => {
  let db: SQLiteAdapter;
  let dbPath: string;
  let model: Awaited<ReturnType<typeof import('@weaveintel/provider-openai').weaveOpenAIModel>> | undefined;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `gw-phase2-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new SQLiteAdapter(dbPath);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  });

  it.skipIf(!HAS_LIVE_KEY)('live agent emits mermaid diagram artifact', async () => {
    const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
    model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY! });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'live-phase2-user' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'live-mermaid-agent', maxSteps: 6 });
    const prompt = 'Use the emit_artifact tool to save a mermaid type artifact named "architecture-diagram" with content: "graph TD\n  A[User] --> B[API]\n  B --> C[DB]". Use type "mermaid".';
    const result = await agent.run(weaveContext({ userId: 'live-phase2-user' }), {
      messages: [{ role: 'user', content: prompt }],
      goal: prompt,
    });

    expect(result.status).toBe('completed');
    const artifacts = await db.listArtifacts!({ userId: 'live-phase2-user' });
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    const mermaidArtifact = artifacts.find(a => a.type === 'mermaid' || a.name.includes('diagram'));
    expect(mermaidArtifact).toBeDefined();
  }, 90_000);
});

// ─── Phase 3: Full round-trip (fake model): emit → admin API → download ───────
//
// The fake model emits artifacts through emit_artifact. We then verify:
//  1. Admin list route sees the artifacts
//  2. Admin get route returns correct fields
//  3. Version history after updateArtifact
//  4. Download endpoint returns correct content and headers

describe('E2E (fake model): Phase 3 round-trip via admin API', () => {
  let db: SQLiteAdapter;
  let dbPath: string;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `gw-p3-rt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new SQLiteAdapter(dbPath);
    await db.initialize();

    const { createServer } = await import('node:http');
    const { Router, json: jsonHelper, readBody: readBodyHelper } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./admin/api/artifacts.js');
    const router = new Router();
    registerArtifactRoutes(router, db as unknown as import('./db.js').DatabaseAdapter, {
      json: jsonHelper,
      readBody: readBodyHelper,
      requireDetailedDescription: () => null,
    });
    const fakeAuth = {
      userId: 'admin', email: 'admin@test', sessionId: 'sess-a', csrfToken: 'tok', persona: 'platform_admin', tenantId: null,
    };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end('{}'); return; }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address() as import('node:net').AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () => new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  });

  afterEach(async () => {
    await closeServer();
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  });

  it('agent emits artifact → admin API lists it → download returns content', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 'tc-rt1', function: { name: 'emit_artifact', arguments: JSON.stringify({ name: 'q3-report.md', type: 'markdown', data: '# Q3 Report\nAll good.' }) } }],
        },
        { content: 'Report saved.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'p3-user', sessionId: 'sess-p3' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'p3-agent', maxSteps: 5 });
    const result = await agent.run(weaveContext({ userId: 'p3-user' }), {
      messages: [],
      goal: 'Save a Q3 report.',
    });
    expect(result.status).toBe('completed');

    // Admin API list
    const listRes = await fetch(`${serverUrl}/api/admin/artifacts`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { artifacts: Array<{ id: string; name: string; type: string; session_id: string }> };
    const found = listBody.artifacts.find(a => a.name === 'q3-report.md');
    expect(found).toBeDefined();
    expect(found!.type).toBe('markdown');
    expect(found!.session_id).toBe('sess-p3');

    // Admin API get
    const getRes = await fetch(`${serverUrl}/api/admin/artifacts/${found!.id}`);
    const getBody = await getRes.json() as { artifact: { id: string; type: string } };
    expect(getBody.artifact.id).toBe(found!.id);

    // Download
    const dlRes = await fetch(`${serverUrl}/api/admin/artifacts/${found!.id}/download`);
    expect(dlRes.status).toBe(200);
    const dlText = await dlRes.text();
    expect(dlText).toContain('Q3 Report');
    const disposition = dlRes.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('q3-report');
    expect(disposition).toContain('.md');
  });

  it('updateArtifact creates version history visible via admin API', async () => {
    const row = await db.saveArtifact!({ name: 'evolving-doc', type: 'text', mimeType: 'text/plain', data: 'Version 1 content', scope: 'session', userId: 'p3-ver-user' });
    await db.updateArtifact!(row.id, { data: 'Version 2 content' }, 'Added section 2');
    await db.updateArtifact!(row.id, { data: 'Version 3 content' }, 'Final revision');

    const versRes = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/versions`);
    expect(versRes.status).toBe(200);
    const versBody = await versRes.json() as { versions: Array<{ version: number; changelog: string | null }> };
    expect(versBody.versions).toHaveLength(3);
    expect(versBody.versions[0]!.version).toBe(1);
    expect(versBody.versions[2]!.changelog).toBe('Final revision');

    // Specific version
    const v1Res = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}/versions/1`);
    expect(v1Res.status).toBe(200);
    const v1Body = await v1Res.json() as { version: { version: number } };
    expect(v1Body.version.version).toBe(1);

    // Latest artifact shows version 3
    const latestRes = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}`);
    const latestBody = await latestRes.json() as { artifact: { version: number } };
    expect(latestBody.artifact.version).toBe(3);
  });

  it('agent emits multiple artifact types → admin API filters correctly', async () => {
    const EMIT_CALLS = [
      { name: 'data.csv', type: 'csv', data: 'col1,col2\n1,2\n3,4' },
      { name: 'code.py', type: 'code', data: 'print("hello")', language: 'python' },
      { name: 'diagram.mmd', type: 'mermaid', data: 'graph TD\n  A-->B' },
    ];

    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: EMIT_CALLS.map((e, i) => ({
            id: `tc-${i}`,
            function: { name: 'emit_artifact', arguments: JSON.stringify(e) },
          })),
        },
        { content: 'All artifacts saved.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'multi-type-user', sessionId: 'sess-mt' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'multi-agent', maxSteps: 5 });
    await agent.run(weaveContext({ userId: 'multi-type-user' }), { messages: [], goal: 'Save 3 artifacts.' });

    // Filter by session_id
    const sessRes = await fetch(`${serverUrl}/api/admin/artifacts?session_id=sess-mt`);
    const sessBody = await sessRes.json() as { artifacts: unknown[] };
    expect(sessBody.artifacts.length).toBeGreaterThanOrEqual(3);

    // Filter by type=csv
    const csvRes = await fetch(`${serverUrl}/api/admin/artifacts?type=csv`);
    const csvBody = await csvRes.json() as { artifacts: Array<{ type: string }> };
    expect(csvBody.artifacts.some(a => a.type === 'csv')).toBe(true);

    // Filter by type=mermaid
    const mmdRes = await fetch(`${serverUrl}/api/admin/artifacts?type=mermaid`);
    const mmdBody = await mmdRes.json() as { artifacts: Array<{ type: string }> };
    expect(mmdBody.artifacts.some(a => a.type === 'mermaid')).toBe(true);
  });

  it('delete via admin API removes artifact and it disappears from list', async () => {
    const row = await db.saveArtifact!({ name: 'temp-report', type: 'report', mimeType: 'text/html', data: '<p>Delete me</p>', scope: 'session', userId: 'del-user' });

    const delRes = await fetch(`${serverUrl}/api/admin/artifacts/${row.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    const listRes = await fetch(`${serverUrl}/api/admin/artifacts`);
    const listBody = await listRes.json() as { artifacts: Array<{ id: string }> };
    expect(listBody.artifacts.some(a => a.id === row.id)).toBe(false);
  });
});

// ─── Phase 3: Live LLM — multi-artifact session with admin API ────────────────

describe('E2E (live model): Phase 3 multi-artifact session via OpenAI', () => {
  let db: SQLiteAdapter;
  let dbPath: string;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `gw-p3-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new SQLiteAdapter(dbPath);
    await db.initialize();

    const { createServer } = await import('node:http');
    const { Router, json: jsonHelper, readBody: readBodyHelper } = await import('./server-core.js');
    const { registerArtifactRoutes } = await import('./admin/api/artifacts.js');
    const router = new Router();
    registerArtifactRoutes(router, db as unknown as import('./db.js').DatabaseAdapter, {
      json: jsonHelper,
      readBody: readBodyHelper,
      requireDetailedDescription: () => null,
    });
    const fakeAuth = {
      userId: 'admin', email: 'admin@test', sessionId: 'sess-admin', csrfToken: 'tok', persona: 'platform_admin', tenantId: null,
    };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end('{}'); return; }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address() as import('node:net').AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () => new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  });

  afterEach(async () => {
    await closeServer();
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  });

  it.skipIf(!HAS_LIVE_KEY)('live agent emits 3 artifact types — all visible via admin API', async () => {
    const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
    const model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY! });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'p3-live-user', sessionId: 'sess-p3-live' });
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'p3-live-agent', maxSteps: 10 });
    const prompt = `Use the emit_artifact tool to save exactly 3 artifacts:
1. A markdown artifact named "project-summary" with content "# Project Summary\n- Phase 3 complete\n- All tests passing"
2. A csv artifact named "team-metrics" with content "name,score\nAlice,95\nBob,87"
3. A mermaid artifact named "architecture" with content "graph TD\n  Client-->API\n  API-->DB"
Call emit_artifact 3 separate times, once for each artifact.`;

    const result = await agent.run(weaveContext({ userId: 'p3-live-user' }), {
      messages: [{ role: 'user', content: prompt }],
      goal: prompt,
    });

    expect(result.status).toBe('completed');

    // Admin API should see all 3
    const listRes = await fetch(`${serverUrl}/api/admin/artifacts`);
    const listBody = await listRes.json() as { artifacts: Array<{ name: string; type: string }> };
    expect(listBody.artifacts.length).toBeGreaterThanOrEqual(3);

    const types = listBody.artifacts.map(a => a.type);
    expect(types).toContain('markdown');
    expect(types).toContain('csv');

    // Admin API shows correct metadata
    const mdArt = listBody.artifacts.find(a => a.type === 'markdown') as { id: string; name: string; type: string } | undefined;
    expect(mdArt).toBeDefined();
    const dlRes = await fetch(`${serverUrl}/api/admin/artifacts/${mdArt!.id}/download`);
    expect(dlRes.status).toBe(200);
    const dlText = await dlRes.text();
    expect(dlText.length).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(!HAS_LIVE_KEY)('live agent versioning: emit then update via re-emit → admin API shows 2+ versions', async () => {
    const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
    const model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY! });

    // First create an artifact manually with a known ID
    const initial = await db.saveArtifact!({ name: 'live-versioned', type: 'text', mimeType: 'text/plain', data: 'Initial version', scope: 'session', userId: 'p3-ver-live-user' });
    await db.updateArtifact!(initial.id, { data: 'Second version content' }, 'Live update');

    // Admin API should see version history
    const versRes = await fetch(`${serverUrl}/api/admin/artifacts/${initial.id}/versions`);
    expect(versRes.status).toBe(200);
    const versBody = await versRes.json() as { versions: Array<{ version: number }> };
    expect(versBody.versions).toHaveLength(2);
    expect(versBody.versions[1]!.version).toBe(2);
  }, 60_000);
});

// ─── Phase 4 E2E: Streaming mode round-trip ────────────────────────────────────

describe('E2E (fake model): Phase 4 streaming artifact round-trip', () => {
  let db: SQLiteAdapter;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDb());
    await db.initialize();
    const { createServer } = await import('node:http');
    const { Router, json: jsonHelper, readBody: readBodyHelper } = await import('./server-core.js');
    const { registerArtifactRoutes: registerAdminArtifactRoutes } = await import('./admin/api/artifacts.js');
    const router = new Router();
    registerAdminArtifactRoutes(router, db as unknown as import('./db.js').DatabaseAdapter, {
      json: jsonHelper,
      readBody: readBodyHelper,
      requireDetailedDescription: () => null,
    });
    const fakeAuth = { userId: 'p4-admin', email: 'p4@t.local', sessionId: 'sp4', csrfToken: 'tokp4', persona: 'platform_admin', tenantId: null };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) { res.writeHead(404); res.end(); return; }
      void matched.route.handler(req, res, matched.params, fakeAuth as import('./auth.js').AuthContext);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address() as import('node:net').AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () => new Promise<void>((r, e) => srv.close(err => err ? e(err) : r()));
  });

  afterEach(async () => {
    await db.close();
    await closeServer();
  });

  it('streaming emit_artifact: bus events fire, artifact finalised in DB', async () => {
    const { emitArtifactStreamEvent, onArtifactStreamEvent, offArtifactStreamEvent } = await import('./lib/artifact-stream-bus.js');

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => { const row = await db.saveArtifact!(input); return { id: row.id, version: row.version }; },
      artifactUpdate: async (id, patch, cl) => { const row = await db.updateArtifact!(id, patch, cl); return { id: row.id, version: row.version }; },
    });
    const tool = registry.get('emit_artifact')!;

    const busEvents: import('./lib/artifact-stream-bus.js').ArtifactStreamBusEvent[] = [];

    // Invoke the tool with streaming:true
    const ctx = weaveContext({ userId: 'p4-e2e-user' });
    const output = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: {
        name: 'streaming-report.md',
        type: 'markdown',
        data: '# Header\nParagraph 1\nParagraph 2\nParagraph 3\nParagraph 4\nParagraph 5\nParagraph 6',
        streaming: true,
      },
    });
    const result = JSON.parse(output.content) as { ok: boolean; artifactId: string; version: number; streaming: boolean };

    expect(result.ok).toBe(true);
    expect(result.streaming).toBe(true);
    expect(result.version).toBeGreaterThanOrEqual(2); // final update bumps version

    // DB should reflect finalised state
    const row = await db.getArtifact!(result.artifactId);
    expect(row).not.toBeNull();
    expect(row!.streaming_status).toBeNull(); // cleared on finalise
    expect(row!.data_text).toBeTruthy();

    // Admin API can list and get the artifact
    const listRes = await fetch(`${serverUrl}/api/admin/artifacts`);
    const listBody = await listRes.json() as { artifacts: Array<{ id: string }> };
    expect(listBody.artifacts.some(a => a.id === result.artifactId)).toBe(true);
  });

  it('streaming:false and streaming:true produce identical final artifact structure', async () => {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => { const row = await db.saveArtifact!(input); return { id: row.id, version: row.version }; },
      artifactUpdate: async (id, patch, cl) => { const row = await db.updateArtifact!(id, patch, cl); return { id: row.id, version: row.version }; },
    });
    const tool = registry.get('emit_artifact')!;
    const DATA = '# Same content for both';
    const ctx = weaveContext({ userId: 'p4-cmp-user' });

    const stdOut = await tool.invoke(ctx, { name: 'emit_artifact', arguments: { name: 'std.md', type: 'markdown', data: DATA } });
    const stmOut = await tool.invoke(ctx, { name: 'emit_artifact', arguments: { name: 'stm.md', type: 'markdown', data: DATA, streaming: true } });
    const stdRes = JSON.parse(stdOut.content) as { ok: boolean; artifactId: string };
    const stmRes = JSON.parse(stmOut.content) as { ok: boolean; artifactId: string };

    const stdRow = await db.getArtifact!(stdRes.artifactId);
    const stmRow = await db.getArtifact!(stmRes.artifactId);

    // Both should have identical type and mime_type
    expect(stdRow!.type).toBe(stmRow!.type);
    expect(stdRow!.mime_type).toBe(stmRow!.mime_type);
    // Both should have no streaming_status at rest
    expect(stdRow!.streaming_status).toBeNull();
    expect(stmRow!.streaming_status).toBeNull();
    // Streaming artifact has higher version due to finalization update
    expect(stmRow!.version).toBeGreaterThanOrEqual(2);
  });

  it('weaveAgent with streaming emit_artifact persists via admin API', async () => {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{
            id: 'tc-p4-agent',
            function: {
              name: 'emit_artifact',
              arguments: JSON.stringify({
                name: 'agent-stream.md',
                type: 'markdown',
                data: '# Agent Report\n\nGenerated by agent with streaming mode.\n\nSection 1\nSection 2\nSection 3',
                streaming: true,
              }),
            },
          }],
        },
        { content: 'Streaming artifact saved.' },
      ],
    });
    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => { const row = await db.saveArtifact!(input); return { id: row.id, version: row.version }; },
      artifactUpdate: async (id, patch, cl) => { const row = await db.updateArtifact!(id, patch, cl); return { id: row.id, version: row.version }; },
    });
    const agent = weaveAgent({ model, tools: registry, name: 'p4-agent', maxSteps: 3 });
    await agent.run(weaveContext({ userId: 'p4-e2e-user' }), { messages: [{ role: 'user', content: 'Write a streaming report.' }] });

    const rows = await db.listArtifacts!({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('agent-stream.md');
    expect(rows[0]!.streaming_status).toBeNull(); // finalised
    expect(rows[0]!.version).toBeGreaterThanOrEqual(2); // streaming bumps version
  });
});

// ─── Phase 4 E2E: Live model streaming ─────────────────────────────────────────

describe('E2E (live model): Phase 4 streaming artifact via OpenAI', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDb());
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it.skipIf(!HAS_LIVE_KEY)('live agent emits streaming artifact — SSE complete event received', async () => {
    const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
    const model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY! });
    const { emitArtifactStreamEvent, onArtifactStreamEvent, offArtifactStreamEvent } = await import('./lib/artifact-stream-bus.js');

    const busCompleteEvents: import('./lib/artifact-stream-bus.js').ArtifactStreamBusEvent[] = [];

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        // Subscribe to bus events for this artifact as soon as it's created
        onArtifactStreamEvent(row.id, (ev) => {
          busCompleteEvents.push(ev);
          offArtifactStreamEvent(row.id, () => undefined);
        });
        return { id: row.id, version: row.version };
      },
      artifactUpdate: async (id, patch, cl) => {
        const row = await db.updateArtifact!(id, patch, cl);
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'p4-live-agent', maxSteps: 8 });
    await agent.run(weaveContext({ userId: 'p4-live-user' }), {
      messages: [{
        role: 'user',
        content: 'Use the emit_artifact tool to save a markdown report about artificial intelligence trends in 2026. Use streaming:true mode. Keep the report under 200 words.',
      }],
    });

    const rows = await db.listArtifacts!({});
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const streamedRow = rows.find(r => r.streaming_status === null && r.version >= 2);
    expect(streamedRow).toBeDefined();
  }, 120_000);
});
