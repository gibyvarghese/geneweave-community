/**
 * Phase 1 — chat→run bridge (SseCaptureResponse) lossless mapping.
 *
 * Feeds the bridge the SSE frames the ChatEngine writes and asserts every
 * channel is mirrored onto the MeRunEmitter (reasoning distinct from text,
 * steps, usage/cost from `done`, artifacts, tool errors, diagnostics) instead
 * of being dropped. Positive, negative, stress, and security cases.
 */
import { describe, it, expect } from 'vitest';
import { SseCaptureResponse } from './me-run-agent.js';
import type { MeRunEmitter } from './me-run-executor.js';
import type { RunStep, RunUsage, RunArtifactRef } from '@weaveintel/core';

interface Recorded {
  text: Array<{ delta: string; role?: string }>;
  reasoning: string[];
  toolInvoked: Array<{ tool: string; args?: Record<string, unknown>; toolCallId?: string }>;
  toolCompleted: Array<{ tool: string; result: unknown; toolCallId?: string }>;
  toolErrored: Array<{ tool: string; error: string; toolCallId?: string }>;
  toolInputStart: Array<{ toolCallId: string; tool: string }>;
  toolInputDelta: Array<{ toolCallId: string; delta: string }>;
  step: RunStep[];
  usage: RunUsage[];
  citation: unknown[];
  artifact: RunArtifactRef[];
  diagnostic: Array<{ channel: string; data?: unknown }>;
  citationFull: CitationLike[];
  widget: Array<{ id: string; payload: Record<string, unknown>; schemaVersion?: number }>;
  objectDelta: string[];
  objectComplete: Array<unknown>;
  file: Array<Record<string, unknown>>;
}
interface CitationLike { id: string; text?: string; source?: string; url?: string }

function recorder(): { emitter: MeRunEmitter; rec: Recorded } {
  const rec: Recorded = { text: [], reasoning: [], toolInvoked: [], toolCompleted: [], toolErrored: [], toolInputStart: [], toolInputDelta: [], step: [], usage: [], citation: [], artifact: [], diagnostic: [], citationFull: [], widget: [], objectDelta: [], objectComplete: [], file: [] };
  const emitter: MeRunEmitter = {
    text: async (delta, role) => { rec.text.push({ delta, ...(role ? { role } : {}) }); },
    toolInvoked: async (tool, args, toolCallId) => { rec.toolInvoked.push({ tool, ...(args ? { args } : {}), ...(toolCallId ? { toolCallId } : {}) }); },
    toolCompleted: async (tool, result, toolCallId) => { rec.toolCompleted.push({ tool, result, ...(toolCallId ? { toolCallId } : {}) }); },
    toolErrored: async (tool, error, toolCallId) => { rec.toolErrored.push({ tool, error, ...(toolCallId ? { toolCallId } : {}) }); },
    widget: async (id, payload, schemaVersion) => { rec.widget.push({ id, payload, ...(schemaVersion !== undefined ? { schemaVersion } : {}) }); },
    reasoning: async (delta) => { rec.reasoning.push(delta); },
    step: async (step) => { rec.step.push(step); },
    usage: async (usage) => { rec.usage.push(usage); },
    citation: async (c) => { rec.citation.push(c); rec.citationFull.push(c as CitationLike); },
    artifact: async (a) => { rec.artifact.push(a); },
    diagnostic: async (channel, data) => { rec.diagnostic.push({ channel, data }); },
    toolInputStart: async (toolCallId, tool) => { rec.toolInputStart.push({ toolCallId, tool }); },
    toolInputDelta: async (toolCallId, delta) => { rec.toolInputDelta.push({ toolCallId, delta }); },
    objectDelta: async (delta) => { rec.objectDelta.push(delta); },
    objectComplete: async (value) => { rec.objectComplete.push(value); },
    file: async (part) => { rec.file.push(part as unknown as Record<string, unknown>); },
  };
  return { emitter, rec };
}

/** Feed frames with object-mode ON (text mirrored to object.delta). */
async function feedObjectMode(frames: Array<Record<string, unknown>>): Promise<Recorded> {
  const { emitter, rec } = recorder();
  const cap = new SseCaptureResponse(emitter, true);
  for (const f of frames) cap.write(frame(f));
  await cap.drain();
  return rec;
}

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function feed(frames: Array<Record<string, unknown>>): Promise<Recorded> {
  const { emitter, rec } = recorder();
  const cap = new SseCaptureResponse(emitter);
  for (const f of frames) cap.write(frame(f));
  await cap.drain();
  return rec;
}

// ─── positive ────────────────────────────────────────────────

describe('bridge — lossless mapping (positive)', () => {
  it('maps reasoning to a DISTINCT channel (not text)', async () => {
    const rec = await feed([{ type: 'reasoning', text: 'thinking...' }, { type: 'text', text: 'answer' }]);
    expect(rec.reasoning).toEqual(['thinking...']);
    expect(rec.text).toEqual([{ delta: 'answer' }]);
  });

  it('maps step frames with tool name + phase', async () => {
    const rec = await feed([{ type: 'step', phase: 'step_end', step: { index: 0, type: 'tool_call', content: 'searching', toolCall: { name: 'web_search' }, durationMs: 120 } }]);
    expect(rec.step).toHaveLength(1);
    expect(rec.step[0]).toMatchObject({ index: 0, type: 'tool_call', toolName: 'web_search', durationMs: 120, phase: 'step_end' });
  });

  it('maps the done frame to usage (cost→costUsd) + artifact refs', async () => {
    const rec = await feed([{
      type: 'done',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: 0.0007, latencyMs: 800, model: 'gpt-4o-mini', provider: 'openai', mode: 'agent',
      artifactRefs: [{ id: 'art-1', type: 'chart', title: 'Sales', mimeType: 'image/svg+xml' }, { artifactId: 'art-2', name: 'Table' }],
    }]);
    expect(rec.usage[0]).toMatchObject({ promptTokens: 10, totalTokens: 15, costUsd: 0.0007, latencyMs: 800, model: 'gpt-4o-mini', mode: 'agent' });
    expect(rec.artifact).toHaveLength(2);
    expect(rec.artifact[0]).toMatchObject({ id: 'art-1', type: 'chart', title: 'Sales' });
    expect(rec.artifact[1]).toMatchObject({ id: 'art-2', title: 'Table' }); // artifactId + name fallbacks
  });

  it('maps tool_start/tool_end normally', async () => {
    const rec = await feed([
      { type: 'tool_start', name: 'calc', arguments: { a: 1 } },
      { type: 'tool_end', name: 'calc', result: { value: 2 } },
    ]);
    expect(rec.toolInvoked[0]).toMatchObject({ tool: 'calc', args: { a: 1 } });
    expect(rec.toolCompleted[0]).toMatchObject({ tool: 'calc', result: { value: 2 } });
    expect(rec.toolErrored).toHaveLength(0);
  });

  it('surfaces guardrail/eval/policy frames as diagnostics (no longer dropped)', async () => {
    const rec = await feed([
      { type: 'guardrail', decision: 'allow', reason: 'ok' },
      { type: 'eval', score: 0.9 },
      { type: 'policy_checks', checks: [] },
      { type: 'ensemble_result', winner: 'a' },
    ]);
    expect(rec.diagnostic.map((d) => d.channel)).toEqual(['guardrail', 'eval', 'policy_checks', 'ensemble_result']);
    expect((rec.diagnostic[0]!.data as Record<string, unknown>)['decision']).toBe('allow');
    expect((rec.diagnostic[0]!.data as Record<string, unknown>)['type']).toBeUndefined(); // type stripped from data
  });
});

// ─── tool errors ─────────────────────────────────────────────

describe('bridge — real tool.errored path', () => {
  it('routes a tool_end whose result carries an error to toolErrored', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'http', result: { error: 'timeout' } }]);
    expect(rec.toolErrored).toHaveLength(1);
    expect(rec.toolErrored[0]).toMatchObject({ tool: 'http', error: 'timeout' });
    expect(rec.toolErrored[0]!.toolCallId).toBeDefined();
    expect(rec.toolCompleted).toHaveLength(0);
  });

  it('a successful result with no error string is a normal completion', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'http', result: { status: 200 } }]);
    expect(rec.toolCompleted).toHaveLength(1);
    expect(rec.toolErrored).toHaveLength(0);
  });
});

// ─── Phase 2 — tool-call id correlation ──────────────────────

describe('bridge — toolCallId correlation (Phase 2)', () => {
  it('assigns a stable id on tool_start and reuses it on tool_end', async () => {
    const rec = await feed([
      { type: 'tool_start', name: 'calc', arguments: { a: 1 } },
      { type: 'tool_end', name: 'calc', result: 2 },
    ]);
    expect(rec.toolInvoked[0]!.toolCallId).toBeDefined();
    expect(rec.toolCompleted[0]!.toolCallId).toBe(rec.toolInvoked[0]!.toolCallId);
  });

  it('correlates interleaved same-name calls LIFO (no id crosstalk)', async () => {
    const rec = await feed([
      { type: 'tool_start', name: 'calc', arguments: { n: 1 } }, // id A
      { type: 'tool_start', name: 'calc', arguments: { n: 2 } }, // id B
      { type: 'tool_end', name: 'calc', result: 2 },             // pops B
      { type: 'tool_end', name: 'calc', result: 1 },             // pops A
    ]);
    const [a, b] = rec.toolInvoked.map((t) => t.toolCallId);
    expect(a).not.toBe(b);
    expect(rec.toolCompleted[0]!.toolCallId).toBe(b);
    expect(rec.toolCompleted[1]!.toolCallId).toBe(a);
  });

  it('distinct tool names get distinct ids', async () => {
    const rec = await feed([
      { type: 'tool_start', name: 'calc', arguments: {} },
      { type: 'tool_start', name: 'search', arguments: {} },
    ]);
    expect(rec.toolInvoked[0]!.toolCallId).not.toBe(rec.toolInvoked[1]!.toolCallId);
  });
});

// ─── negative / security ─────────────────────────────────────

describe('bridge — robustness (negative/security)', () => {
  it('ignores malformed JSON frames without crashing or emitting', async () => {
    const { emitter, rec } = recorder();
    const cap = new SseCaptureResponse(emitter);
    cap.write('data: {not json\n\n');
    cap.write('data: \n\n');
    cap.write(frame({ type: 'text', text: 'ok' }));
    await cap.drain();
    expect(rec.text).toEqual([{ delta: 'ok' }]);
  });

  it('captures an error frame as a run failure (not as output)', async () => {
    const { emitter } = recorder();
    const cap = new SseCaptureResponse(emitter);
    cap.write(frame({ type: 'error', error: 'model exploded' }));
    await cap.drain();
    expect(cap.error).toBe('model exploded');
  });

  it('drops unknown/internal frames (redaction/generation/screenshot)', async () => {
    const rec = await feed([
      { type: 'redaction', count: 2 },
      { type: 'generation', id: 'g1' },
      { type: 'screenshot', url: 'x' },
    ]);
    const total = rec.text.length + rec.reasoning.length + rec.step.length + rec.usage.length + rec.artifact.length + rec.diagnostic.length;
    expect(total).toBe(0);
  });

  it('handles a done frame with no usage/artifacts gracefully', async () => {
    const rec = await feed([{ type: 'done' }]);
    expect(rec.usage).toHaveLength(1); // emits an (empty) usage snapshot
    expect(rec.artifact).toHaveLength(0);
  });

  it('preserves frame ordering across a split write (SSE chunk boundary)', async () => {
    const { emitter, rec } = recorder();
    const cap = new SseCaptureResponse(emitter);
    const a = frame({ type: 'reasoning', text: 'AB' });
    const b = frame({ type: 'text', text: 'CD' });
    const joined = a + b;
    cap.write(joined.slice(0, 12)); // split mid-frame
    cap.write(joined.slice(12));
    await cap.drain();
    expect(rec.reasoning).toEqual(['AB']);
    expect(rec.text).toEqual([{ delta: 'CD' }]);
  });
});

// ─── Phase 3 — citations + generative-UI widget from search ──

const searchFrame = (query: string, results: Array<Record<string, unknown>>): Record<string, unknown> =>
  ({ type: 'tool_end', name: 'web_search', result: { query, provider: 'test', resultCount: results.length, results } });

describe('bridge — search derivatives (Phase 3, positive)', () => {
  it('emits a citation per result and a results table widget', async () => {
    const rec = await feed([searchFrame('weaveintel docs', [
      { title: 'A', url: 'https://a.example/x', snippet: 'about a', source: 'a.example' },
      { title: 'B', url: 'https://b.example/y', snippet: 'about b', source: 'b.example' },
    ])]);
    expect(rec.citationFull).toHaveLength(2);
    expect(rec.citationFull[0]).toMatchObject({ url: 'https://a.example/x', text: 'about a' });
    expect(rec.widget).toHaveLength(1);
    const w = rec.widget[0]!.payload as Record<string, unknown>;
    expect(w['type']).toBe('table');
    expect((w['data'] as { rows: unknown[][] }).rows).toHaveLength(2);
    expect((w['data'] as { columns: string[] }).columns).toEqual(['Title', 'Source', 'URL']);
    // The tool completion still fires alongside the derivatives.
    expect(rec.toolCompleted).toHaveLength(1);
  });

  it('dedupes citations that point at the same source/text', async () => {
    const rec = await feed([searchFrame('dup', [
      { title: 'A', url: 'https://a.example/x', snippet: 'same', source: 'a.example' },
      { title: 'A2', url: 'https://a.example/x', snippet: 'same', source: 'a.example' },
      { title: 'C', url: 'https://c.example/z', snippet: 'other', source: 'c.example' },
    ])]);
    expect(rec.citationFull.length).toBe(2); // a.example deduped
  });

  it('parses a stringified JSON tool result', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'web_search', result: JSON.stringify({ query: 'q', results: [{ title: 'A', url: 'https://a.example', snippet: 's', source: 'a.example' }] }) }]);
    expect(rec.citationFull).toHaveLength(1);
    expect(rec.widget).toHaveLength(1);
  });
});

describe('bridge — search derivatives (negative/security)', () => {
  it('emits nothing for a non-search tool', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'calculator', result: { value: 42 } }]);
    expect(rec.citationFull).toHaveLength(0);
    expect(rec.widget).toHaveLength(0);
  });

  it('emits nothing when there are no results', async () => {
    const rec = await feed([searchFrame('empty', [])]);
    expect(rec.citationFull).toHaveLength(0);
    expect(rec.widget).toHaveLength(0);
  });

  it('skips only URL-less results and never throws on odd URLs', async () => {
    const rec = await feed([searchFrame('mixed', [
      { title: 'good', url: 'https://good.example', snippet: 'g', source: 'good.example' },
      { title: 'odd', url: 'not a url', snippet: 'b', source: 'bad' }, // kept (source given)
      { title: 'noUrl', snippet: 'n', source: 'n' }, // no url → skipped
    ])]);
    expect(rec.citationFull).toHaveLength(2); // url-less result dropped; odd url kept
    expect(rec.citationFull.map((c) => c.url)).toContain('https://good.example');
    expect(rec.widget).toHaveLength(1);
  });

  it('ignores non-object results entries without crashing', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'web_search', result: { query: 'x', results: [null, 'str', 42, { title: 'A', url: 'https://a.example', source: 'a.example' }] } }]);
    expect(rec.citationFull).toHaveLength(1);
  });
});

describe('bridge — search derivatives (stress)', () => {
  it('caps the widget at 10 rows for a large result set', async () => {
    const results = Array.from({ length: 50 }, (_, i) => ({ title: `T${i}`, url: `https://s${i}.example/p`, snippet: `snip ${i}`, source: `s${i}.example` }));
    const rec = await feed([searchFrame('big', results)]);
    expect(rec.citationFull.length).toBe(50); // all unique
    const rows = (rec.widget[0]!.payload as { data: { rows: unknown[][] } }).data.rows;
    expect(rows).toHaveLength(10); // capped
  });
});

// ─── F2 — emit_widget → widget.update ────────────────────────

describe('bridge — emit_widget (generative UI)', () => {
  it('maps an emit_widget tool result to a widget (positive)', async () => {
    const widget = { id: 'w-1', type: 'table', title: 'Sales', data: { columns: ['A'], rows: [[1]] }, interactive: false, schemaVersion: 1 };
    const rec = await feed([{ type: 'tool_end', name: 'emit_widget', result: JSON.stringify({ ok: true, widget }) }]);
    expect(rec.widget).toHaveLength(1);
    expect(rec.widget[0]!.id).toBe('w-1');
    expect((rec.widget[0]!.payload as { type: string }).type).toBe('table');
    expect(rec.widget[0]!.schemaVersion).toBe(1);
    // It is still a normal tool completion too.
    expect(rec.toolCompleted).toHaveLength(1);
  });

  it('accepts an already-parsed object result', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'emit_widget', result: { ok: true, widget: { id: 'w-2', type: 'chart' } } }]);
    expect(rec.widget).toHaveLength(1);
    expect(rec.widget[0]!.id).toBe('w-2');
  });

  it('emits nothing when the tool failed (negative)', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'emit_widget', result: JSON.stringify({ ok: false, error: 'bad type' }) }]);
    expect(rec.widget).toHaveLength(0);
  });

  it('does not emit a widget for other tools (security: scoped to emit_widget)', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'calculator', result: { ok: true, widget: { id: 'x' } } }]);
    expect(rec.widget).toHaveLength(0);
  });

  it('ignores a malformed widget payload without throwing', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'emit_widget', result: JSON.stringify({ ok: true, widget: 'not-an-object' }) }]);
    expect(rec.widget).toHaveLength(0);
  });
});

// ─── stress ──────────────────────────────────────────────────

describe('bridge — stress', () => {
  it('mirrors 2000 mixed frames in order', async () => {
    const frames: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 2000; i++) {
      const k = i % 4;
      if (k === 0) frames.push({ type: 'text', text: 't' });
      else if (k === 1) frames.push({ type: 'reasoning', text: 'r' });
      else if (k === 2) frames.push({ type: 'step', step: { index: i, type: 'response' } });
      else frames.push({ type: 'tool_end', name: 'x', result: { ok: true } });
    }
    const rec = await feed(frames);
    expect(rec.text).toHaveLength(500);
    expect(rec.reasoning).toHaveLength(500);
    expect(rec.step).toHaveLength(500);
    expect(rec.toolCompleted).toHaveLength(500);
  });
});

// ─── Phase 7 — structured object streaming + multimodal ──────────

describe('bridge — Phase 7 object mode', () => {
  it('mirrors text frames to object.delta and finalizes on done', async () => {
    const rec = await feedObjectMode([
      { type: 'text', text: '{"a":1,' },
      { type: 'text', text: '"b":2}' },
      { type: 'done', usage: { totalTokens: 3 } },
    ]);
    // Text is still emitted (back-compat) AND mirrored to object.delta.
    expect(rec.text.map((t) => t.delta)).toEqual(['{"a":1,', '"b":2}']);
    expect(rec.objectDelta).toEqual(['{"a":1,', '"b":2}']);
    expect(rec.objectComplete).toHaveLength(1);
  });

  it('does NOT emit object events when object mode is off', async () => {
    const rec = await feed([{ type: 'text', text: '{"a":1}' }, { type: 'done' }]);
    expect(rec.objectDelta).toEqual([]);
    expect(rec.objectComplete).toEqual([]);
  });

  it('does not finalize an object when no text streamed (objectStarted=false)', async () => {
    const rec = await feedObjectMode([{ type: 'done' }]);
    expect(rec.objectDelta).toEqual([]);
    expect(rec.objectComplete).toEqual([]);
  });
});
