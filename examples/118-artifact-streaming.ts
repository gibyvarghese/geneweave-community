/**
 * Example 118 — Phase 4: Artifact Streaming Lifecycle
 *
 * Demonstrates the full Phase 4 streaming artifact stack in geneWeave:
 *
 *   1. `streamArtifact()` API — stable id + progressive updates via in-memory store
 *   2. `emit_artifact` tool streaming mode — `streaming:true` splits data over SSE
 *   3. `artifact-stream-bus` — in-process event bus, mirroring live-run-event-bus
 *   4. SSE endpoint integration — GET /api/artifacts/:id/stream
 *   5. `weaveAgent` with streaming mode (fake model, no API credits)
 *   6. (Optional) Live LLM streaming — set OPENAI_API_KEY or ANTHROPIC_API_KEY
 *
 * Runs without any API keys (Sections 1–5 use fake models + temp SQLite DB).
 * Section 6 is skipped unless a live key is present.
 *
 * Run: npx tsx examples/118-artifact-streaming.ts
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { streamArtifact, createArtifactStore } from '@weaveintel/artifacts';
import { SQLiteAdapter, createToolRegistry } from '@weaveintel/geneweave-api';
import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import { weaveFakeModel } from '@weaveintel/testing';

/* ─── Utilities ──────────────────────────────────────────────────────────── */

function header(title: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}
function ok(msg: string):   void { console.log(`  ✓ ${msg}`); }
function info(msg: string): void { console.log(`  ℹ ${msg}`); }
function fail(msg: string): void { console.log(`  ✗ ${msg}`); process.exitCode = 1; }

function makeTempDbPath(): string {
  return join(tmpdir(), `gw-ex118-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/* ─── Section 1: streamArtifact() API with in-memory store ──────────────── */

async function runSection1(): Promise<void> {
  header('Section 1 — streamArtifact() API (in-memory store)');

  const store = await createArtifactStore({ backend: 'memory' });

  const events: Array<{ kind: string; progress: number }> = [];

  const handle = await streamArtifact<string>(
    store,
    {
      name: 'market-report.md',
      type: 'markdown',
      mimeType: 'text/markdown',
      data: '',
      scope: 'session',
    },
    {
      onProgress: (ev) => {
        events.push({ kind: ev.kind, progress: ev.progress });
        info(`  event: ${ev.kind} @ ${(ev.progress * 100).toFixed(0)}%`);
      },
    },
  );

  ok(`Artifact created with id: ${handle.id}`);
  if (handle.status !== 'streaming') fail('Expected status=streaming after init');

  // Simulate progressive content generation
  const CHUNKS = [
    '# Market Report 2026\n\n',
    '## Executive Summary\n\nStrong growth across all segments.\n\n',
    '## Key Metrics\n\n| Metric | Value |\n|--------|-------|\n| Revenue | $4.2B |\n| Growth | +18% |\n\n',
    '## Outlook\n\nPositive momentum expected to continue into Q3.\n',
  ];

  let accumulated = '';
  for (let i = 0; i < CHUNKS.length; i++) {
    accumulated += CHUNKS[i]!;
    await handle.update(accumulated, (i + 1) / CHUNKS.length);
  }

  const finalArtifact = await handle.complete(accumulated, 'Generated market report');

  if (handle.status !== 'complete') fail('Expected status=complete after complete()');
  if (handle.progress !== 1)       fail('Expected progress=1 after complete()');
  if (finalArtifact.version < 2)   fail(`Expected version>=2, got ${finalArtifact.version}`);

  ok(`Stream completed — artifact version: ${finalArtifact.version}`);
  ok(`Events received: ${events.map(e => e.kind).join(' → ')}`);

  // Verify error path with a separate handle
  const errHandle = await streamArtifact(store, { name: 'err.md', type: 'markdown', mimeType: 'text/markdown', data: '', scope: 'session' });
  await errHandle.error('LLM quota exceeded');
  if (errHandle.status !== 'error') fail('Expected status=error after error()');
  ok('Error path: status transitions to "error" correctly');
}

/* ─── Section 2: emit_artifact streaming mode (tool invoke) ─────────────── */

async function runSection2(): Promise<void> {
  header('Section 2 — emit_artifact streaming mode (direct tool invoke)');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  const { onArtifactStreamEvent, offArtifactStreamEvent } = await import(
    '../apps/geneweave/src/lib/artifact-stream-bus.js'
  );

  try {
    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        return { id: row.id, version: row.version };
      },
      artifactUpdate: async (id, patch, changelog) => {
        const row = await db.updateArtifact!(id, patch, changelog);
        return { id: row.id, version: row.version };
      },
    });

    const tool = registry.get('emit_artifact');
    if (!tool) { fail('emit_artifact not in registry'); return; }

    const busEvents: Array<{ kind: string; progress: number }> = [];
    let subscribedId: string | null = null;

    // We'll subscribe after save by wrapping artifactSave — but the bus is
    // populated by the streaming tool itself. Subscribe on an id we don't know
    // yet by hooking into the save. Instead, subscribe globally right after
    // the tool call completes (events are synchronous-ish via setImmediate).
    //
    // In practice: the tool emits events after the initial save. We can capture
    // the id from the tool result and verify final DB state.

    const ctx = weaveContext({ userId: 'ex118-user' });
    const DATA = '# Streaming Report\n\nParagraph 1\nParagraph 2\nParagraph 3\n' +
                 'Paragraph 4\nParagraph 5\nParagraph 6\nParagraph 7\nParagraph 8';

    const output = await tool.invoke(ctx, {
      name: 'emit_artifact',
      arguments: {
        name: 'streaming-report.md',
        type: 'markdown',
        data: DATA,
        streaming: true,
      },
    });

    const result = JSON.parse(output.content) as {
      ok: boolean; artifactId: string; version: number; streaming: boolean; streamUrl?: string;
    };

    if (!result.ok)       fail(`Tool returned ok=false: ${JSON.stringify(result)}`);
    if (!result.streaming) fail('Tool result missing streaming:true');
    if (result.version < 2) fail(`Expected version>=2 after finalise, got ${result.version}`);
    ok(`Streaming tool: ok=true, id=${result.artifactId}, version=${result.version}`);
    if (result.streamUrl) ok(`Stream URL: ${result.streamUrl}`);

    // Verify DB state — streaming_status should be cleared
    const row = await db.getArtifact!(result.artifactId);
    if (!row)                           fail('Artifact row not found in DB');
    if (row!.streaming_status !== null) fail(`Expected streaming_status=null, got ${row!.streaming_status}`);
    if (!row!.data_text?.includes('Paragraph 1')) fail('Final data not persisted');
    ok(`DB: streaming_status cleared, data persisted (${row!.data_text!.length} chars)`);

  } finally {
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  }
}

/* ─── Section 3: In-process bus + SSE endpoint ──────────────────────────── */

async function runSection3(): Promise<void> {
  header('Section 3 — artifact-stream-bus + SSE endpoint');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  const { onArtifactStreamEvent, offArtifactStreamEvent, emitArtifactStreamEvent } = await import(
    '../apps/geneweave/src/lib/artifact-stream-bus.js'
  );
  const { Router, json: jsonHelper } = await import('../apps/geneweave/src/server-core.js');
  const { registerArtifactRoutes } = await import('../apps/geneweave/src/routes/artifacts.js');

  // Spin up a minimal HTTP server with the artifact routes
  const router = new Router();
  registerArtifactRoutes(router, db as never);

  let serverUrl = '';
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const matched = router.match(req.method ?? 'GET', url.pathname);
    if (!matched) { res.writeHead(404); res.end(); return; }
    const fakeAuth = { userId: 's3-user', email: 't@t', sessionId: 'ss3', csrfToken: 'tok', persona: 'tenant_user', tenantId: null };
    void matched.route.handler(req, res, matched.params, fakeAuth as never);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  serverUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  try {
    // Save an artifact in 'streaming' state
    const row = await db.saveArtifact!({
      name: 'live-report.md', type: 'markdown', mimeType: 'text/markdown',
      data: '', scope: 'session', userId: 's3-user', streamingStatus: 'streaming', streamingProgress: 0,
    });
    ok(`Saved streaming artifact: id=${row.id}`);

    // Open SSE connection
    const sseEvents: string[] = [];
    const sseResponse = await fetch(`${serverUrl}/api/artifacts/${row.id}/stream`);
    if (sseResponse.status !== 200) { fail(`SSE returned ${sseResponse.status}`); return; }
    if (!sseResponse.headers.get('content-type')?.includes('text/event-stream')) {
      fail('Expected text/event-stream content type'); return;
    }
    ok('SSE endpoint returned 200 text/event-stream');

    // Read the initial 'update' event (the endpoint sends current progress immediately)
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    async function readNextEvent(): Promise<string> {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return '';
        buf += decoder.decode(value, { stream: true });
        const dblNewline = buf.indexOf('\n\n');
        if (dblNewline >= 0) {
          const event = buf.slice(0, dblNewline);
          buf = buf.slice(dblNewline + 2);
          return event;
        }
      }
    }

    const initialChunk = await readNextEvent();
    if (!initialChunk.includes('event: update')) fail(`Expected initial update event, got: ${initialChunk}`);
    ok('Received initial update event from SSE stream');

    // Emit a complete event via the bus (simulates the streaming tool finishing)
    emitArtifactStreamEvent(row.id, { kind: 'complete', progress: 1, version: 2 });

    const completeChunk = await readNextEvent();
    if (!completeChunk.includes('event: complete')) fail(`Expected complete event, got: ${completeChunk}`);
    ok('Received complete event via bus → SSE delivery');

    await reader.cancel();

    // Test: already-completed artifact returns immediate complete
    const completedRow = await db.saveArtifact!({
      name: 'done.md', type: 'markdown', mimeType: 'text/markdown',
      data: '# Done', scope: 'session', userId: 's3-user',
    });
    const immediateRes = await fetch(`${serverUrl}/api/artifacts/${completedRow.id}/stream`);
    const immediateText = await immediateRes.text();
    if (!immediateText.includes('event: complete')) fail('Expected immediate complete for non-streaming artifact');
    ok('Non-streaming artifact: SSE returns immediate complete event');

  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  }
}

/* ─── Section 4: weaveAgent with streaming emit_artifact (fake model) ────── */

async function runSection4(): Promise<void> {
  header('Section 4 — weaveAgent + emit_artifact streaming mode (fake model)');

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  try {
    const model = weaveFakeModel({
      responses: [
        {
          content: '',
          toolCalls: [{
            id: 'tc-stream-1',
            function: {
              name: 'emit_artifact',
              arguments: JSON.stringify({
                name: 'agent-analysis.md',
                type: 'markdown',
                data: '# Analysis\n\n## Summary\nKey insight 1.\n\n## Detail\nExpanded analysis.\n\n## Conclusion\nStrong result.',
                streaming: true,
                changelog: 'Generated via streaming mode',
              }),
            },
          }],
        },
        { content: 'Streaming analysis artifact saved.' },
      ],
    });

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!({ ...input, userId: 'ex118-agent-user' });
        return { id: row.id, version: row.version };
      },
      artifactUpdate: async (id, patch, changelog) => {
        const row = await db.updateArtifact!(id, patch, changelog);
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'ex118-stream-agent', maxSteps: 4 });
    const result = await agent.run(
      weaveContext({ userId: 'ex118-agent-user' }),
      { messages: [{ role: 'user', content: 'Write a streaming analysis report.' }] },
    );

    if (result.status !== 'completed') fail(`Agent status: ${result.status}`);
    ok(`Agent completed in ${result.steps.length} steps`);

    const rows = await db.listArtifacts!({ userId: 'ex118-agent-user' });
    if (rows.length !== 1) { fail(`Expected 1 artifact, got ${rows.length}`); return; }

    const art = rows[0]!;
    if (art.name !== 'agent-analysis.md')  fail(`Wrong artifact name: ${art.name}`);
    if (art.streaming_status !== null)      fail(`streaming_status not cleared: ${art.streaming_status}`);
    if (art.version < 2)                    fail(`Expected version>=2, got ${art.version}`);
    if (!art.data_text?.includes('Summary')) fail('Final data not persisted');

    ok(`Artifact persisted: name=${art.name}, version=${art.version}`);
    ok(`streaming_status cleared (null), data present (${art.data_text!.length} chars)`);

  } finally {
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  }
}

/* ─── Section 5: streamArtifact() idempotency (update after complete) ──── */

async function runSection5(): Promise<void> {
  header('Section 5 — streamArtifact() guard: update() is no-op after complete()');

  const store = await createArtifactStore({ backend: 'memory' });
  const updateCallCount = { n: 0 };

  const handle = await streamArtifact<string>(
    store,
    { name: 'guarded.md', type: 'markdown', mimeType: 'text/markdown', data: '', scope: 'session' },
    { onProgress: () => { updateCallCount.n++; } },
  );

  await handle.complete('Final content', 'Done');
  ok(`Completed. Status=${handle.status}, progress=${handle.progress}`);

  // Calls after complete() should be no-ops (guard: if (_status !== 'streaming') return)
  const countBefore = updateCallCount.n;
  await handle.update('This should be ignored', 0.5);
  if (updateCallCount.n !== countBefore) fail('update() fired after complete() — guard broken');
  ok('update() after complete() is silently ignored (no-op guard works)');
}

/* ─── Section 6: Live LLM streaming (optional) ─────────────────────────── */

async function runSection6(): Promise<void> {
  header('Section 6 — Live LLM: streaming artifact via real model (optional)');

  const OPENAI_KEY = process.env['OPENAI_API_KEY'];
  const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];

  if (!OPENAI_KEY && !ANTHROPIC_KEY) {
    info('No API key found — skipping live LLM section.');
    info('Set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable.');
    return;
  }

  const dbPath = makeTempDbPath();
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  try {
    let model;
    if (OPENAI_KEY) {
      const { weaveOpenAIModel } = await import('@weaveintel/provider-openai');
      model = weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_KEY });
      info('Using OpenAI gpt-4o-mini');
    } else {
      const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');
      model = weaveAnthropicModel('claude-haiku-4-5-20251001', { apiKey: ANTHROPIC_KEY! });
      info('Using Anthropic claude-haiku-4-5-20251001');
    }

    const registry = await createToolRegistry(['emit_artifact'], [], {
      actorPersona: 'tenant_user',
      artifactSave: async (input) => {
        const row = await db.saveArtifact!(input);
        info(`  [save] id=${row.id}, name=${input.name}`);
        return { id: row.id, version: row.version };
      },
      artifactUpdate: async (id, patch, changelog) => {
        const row = await db.updateArtifact!(id, patch, changelog);
        info(`  [update] id=${id}, version=${row.version}`);
        return { id: row.id, version: row.version };
      },
    });

    const agent = weaveAgent({ model, tools: registry, name: 'ex118-live-agent', maxSteps: 8 });
    const prompt = 'Use the emit_artifact tool to save a markdown artifact named "ai-trends-2026.md" ' +
                   'with a brief summary of AI trends in 2026. Use streaming:true mode. Keep it under 150 words.';

    const result = await agent.run(weaveContext({ userId: 'ex118-live-user' }), {
      messages: [{ role: 'user', content: prompt }],
    });

    if (result.status !== 'completed') fail(`Agent status: ${result.status}`);
    ok(`Live agent completed in ${result.steps.length} steps`);

    const rows = await db.listArtifacts!({ userId: 'ex118-live-user' });
    if (rows.length === 0) { fail('No artifact saved by live agent'); return; }

    const art = rows.find(r => r.name.includes('ai-trends') || r.type === 'markdown')
      ?? rows[0]!;
    ok(`Artifact: name=${art.name}, version=${art.version}, streaming_status=${art.streaming_status ?? 'null (finalised)'}`);

    if (art.streaming_status === null && art.version >= 2) {
      ok('Streaming finalise confirmed: version bumped and marker cleared');
    } else if (art.streaming_status === null) {
      info('Artifact saved without streaming mode (model chose standard emit)');
    }

  } finally {
    await db.close();
    try { rmSync(dbPath); } catch { /* ignore */ }
  }
}

/* ─── Main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log('\nExample 118 — Phase 4: Artifact Streaming Lifecycle');
  console.log('WeaveIntel geneWeave Platform\n');

  await runSection1();
  await runSection2();
  await runSection3();
  await runSection4();
  await runSection5();
  await runSection6();

  console.log('\n' + '═'.repeat(70));
  if (process.exitCode) {
    console.log('  RESULT: FAIL — see ✗ lines above');
  } else {
    console.log('  RESULT: PASS — all Phase 4 streaming checks passed');
  }
  console.log('═'.repeat(70) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
