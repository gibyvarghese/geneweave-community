/**
 * Phase 1 integration tests — OTel observability
 *
 * Verifies:
 * - OTel tracer is wired into geneWeave runtime when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * - Console tracer is used when no endpoint is configured
 * - withLLMSpan creates spans with GenAI semantic convention attributes
 * - spanId/correlationId flow through weaveAudit entries
 * - createRedactingAuditLogger scrubs resource and action fields (Phase 1.2)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weaveContext, weaveRuntime, weaveAudit, createRedactingAuditLogger, type AuditEntry } from '@weaveintel/core';
import { createOtelTracer, GEN_AI } from '@weaveintel/observability';
import { weaveRedactor } from '@weaveintel/guardrails/redaction';
import { createGeneWeave, type GeneWeaveApp } from './index.js';
import { withLLMSpan } from './chat-trace-utils.js';

async function bootApp(dbPath: string): Promise<GeneWeaveApp> {
  return createGeneWeave({
    port: 0,
    jwtSecret: 'phase1-otel-test-secret-not-for-prod-use-only',
    database: { type: 'sqlite', path: dbPath },
    providers: { anthropic: { apiKey: 'sk-test-not-real' } },
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
  });
}

describe('Phase 1 — OTel tracer wiring in geneWeave', () => {
  let app: GeneWeaveApp | undefined;
  let dir: string | undefined;
  const prevEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  afterEach(async () => {
    if (app) { await app.stop(); app = undefined; }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
    if (prevEndpoint === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prevEndpoint;
  });

  it('uses console tracer when OTEL_EXPORTER_OTLP_ENDPOINT is not set', async () => {
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    dir = mkdtempSync(join(tmpdir(), 'gw-phase1-console-'));
    app = await bootApp(join(dir, 'gw.db'));

    // The tracer should be defined (console tracer)
    expect(app.runtime.tracer).toBeDefined();
    const ctx = weaveContext({ runtime: app.runtime });
    const span = ctx.runtime!.tracer.startSpan(ctx, 'test-span');
    expect(span.spanId).toBeTruthy();
    span.end();
  });

  it('uses OTel tracer when OTEL_EXPORTER_OTLP_ENDPOINT is set', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
    dir = mkdtempSync(join(tmpdir(), 'gw-phase1-otel-'));
    app = await bootApp(join(dir, 'gw.db'));

    expect(app.runtime.tracer).toBeDefined();
    const ctx = weaveContext({ runtime: app.runtime });
    const span = ctx.runtime!.tracer.startSpan(ctx, 'gen_ai.chat', {
      [GEN_AI.SYSTEM]: 'anthropic',
      [GEN_AI.REQUEST_MODEL]: 'claude-sonnet-4-6',
    });
    expect(span.attributes[GEN_AI.SYSTEM]).toBe('anthropic');
    expect(span.attributes[GEN_AI.REQUEST_MODEL]).toBe('claude-sonnet-4-6');
    span.end();
  });
});

// ─── withLLMSpan unit tests (no DB) ─────────────────────────────────────────

describe('Phase 1 — withLLMSpan GenAI semantic attributes', () => {
  it('returns the result of the wrapped function', async () => {
    const ctx = weaveContext({});
    const { result } = await withLLMSpan(
      ctx,
      { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', operation: 'chat' },
      async () => ({ content: 'hello', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
    );
    expect(result.content).toBe('hello');
    expect(result.usage.totalTokens).toBe(15);
  });

  it('returns a non-empty spanId when tracer is present', async () => {
    const otelTracer = createOtelTracer({ serviceName: 'test' });
    const runtime = weaveRuntime({ tracer: otelTracer });
    const ctx = weaveContext({ runtime });

    const { result, spanId } = await withLLMSpan(
      ctx,
      { provider: 'anthropic', modelId: 'claude-sonnet-4-6', operation: 'chat', maxTokens: 4096 },
      async () => 'ok',
    );
    expect(result).toBe('ok');
    expect(spanId).toBeTruthy();
  });

  it('returns empty spanId when no tracer is wired', async () => {
    const ctx = weaveContext({}); // no runtime
    const { spanId } = await withLLMSpan(
      ctx,
      { provider: 'openai', modelId: 'gpt-4o' },
      async () => 'result',
    );
    expect(spanId).toBe('');
  });

  it('propagates errors from the wrapped function', async () => {
    const otelTracer = createOtelTracer({ serviceName: 'test' });
    const runtime = weaveRuntime({ tracer: otelTracer });
    const ctx = weaveContext({ runtime });

    await expect(
      withLLMSpan(ctx, { provider: 'anthropic', modelId: 'claude-sonnet-4-6' }, async () => {
        throw new Error('model error');
      }),
    ).rejects.toThrow('model error');
  });

  it('attaches GenAI attributes to the span', async () => {
    const spans: import('@weaveintel/core').SpanRecord[] = [];
    const otelTracer = createOtelTracer({ serviceName: 'test' });
    // Capture spans by intercepting the sink
    const origRecord = otelTracer.sink.record.bind(otelTracer.sink);
    otelTracer.sink.record = (s) => { spans.push(s); origRecord(s); };

    const runtime = weaveRuntime({ tracer: otelTracer });
    const ctx = weaveContext({ runtime });

    await withLLMSpan(
      ctx,
      { provider: 'anthropic', modelId: 'claude-sonnet-4-6', operation: 'chat', maxTokens: 2048, temperature: 0.7 },
      async () => 'done',
    );

    const span = spans[0]!;
    expect(span).toBeDefined();
    expect(span.name).toBe('gen_ai.chat');
    expect(span.attributes[GEN_AI.SYSTEM]).toBe('anthropic');
    expect(span.attributes[GEN_AI.REQUEST_MODEL]).toBe('claude-sonnet-4-6');
    expect(span.attributes[GEN_AI.OPERATION_NAME]).toBe('chat');
    expect(span.attributes[GEN_AI.REQUEST_MAX_TOKENS]).toBe(2048);
    expect(span.attributes[GEN_AI.REQUEST_TEMPERATURE]).toBe(0.7);
  });
});

// ─── AuditEntry.spanId / correlationId ──────────────────────────────────────

describe('Phase 1 — AuditEntry spanId + correlationId', () => {
  it('weaveAudit passes spanId and correlationId through to the audit logger', async () => {
    const logged: AuditEntry[] = [];
    const runtime = weaveRuntime({
      audit: { log: async (e) => { logged.push(e); } },
    });
    const ctx = weaveContext({ runtime });

    await weaveAudit(ctx, {
      action: 'chat.send',
      outcome: 'success',
      spanId: 'span-abc123',
      correlationId: 'req-xyz',
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]!.spanId).toBe('span-abc123');
    expect(logged[0]!.correlationId).toBe('req-xyz');
  });

  it('weaveAudit works without spanId (backward compat)', async () => {
    const logged: AuditEntry[] = [];
    const runtime = weaveRuntime({ audit: { log: async (e) => { logged.push(e); } } });
    const ctx = weaveContext({ runtime });

    await weaveAudit(ctx, { action: 'chat.send', outcome: 'success' });
    expect(logged[0]!.spanId).toBeUndefined();
    expect(logged[0]!.correlationId).toBeUndefined();
  });
});

// ─── createRedactingAuditLogger — action + resource scrubbing (Phase 1.2) ───

describe('Phase 1.2 — createRedactingAuditLogger scrubs action and resource', () => {
  it('redacts PII in the action field', async () => {
    const logged: AuditEntry[] = [];
    const inner = { log: async (e: AuditEntry) => { logged.push(e); } };
    const redactor = weaveRedactor({
      patterns: [{ name: 'email', type: 'builtin', builtinType: 'email' }],
      reversible: false,
    });
    const logger = createRedactingAuditLogger(inner, redactor);

    await logger.log({
      timestamp: new Date().toISOString(),
      executionId: 'exec-1',
      action: 'user.register jane.doe@example.com',
      outcome: 'success',
    });

    expect(logged[0]!.action).not.toContain('jane.doe@example.com');
    expect(logged[0]!.action).toContain('[EMAIL]');
  });

  it('redacts PII in the resource field', async () => {
    const logged: AuditEntry[] = [];
    const inner = { log: async (e: AuditEntry) => { logged.push(e); } };
    const redactor = weaveRedactor({
      patterns: [{ name: 'email', type: 'builtin', builtinType: 'email' }],
      reversible: false,
    });
    const logger = createRedactingAuditLogger(inner, redactor);

    await logger.log({
      timestamp: new Date().toISOString(),
      executionId: 'exec-2',
      action: 'chat.access',
      resource: 'user:bob@example.org',
      outcome: 'success',
    });

    expect(logged[0]!.resource).not.toContain('bob@example.org');
    expect(logged[0]!.resource).toContain('[EMAIL]');
  });

  it('preserves non-PII action and resource unchanged', async () => {
    const logged: AuditEntry[] = [];
    const inner = { log: async (e: AuditEntry) => { logged.push(e); } };
    const redactor = weaveRedactor({
      patterns: [{ name: 'email', type: 'builtin', builtinType: 'email' }],
      reversible: false,
    });
    const logger = createRedactingAuditLogger(inner, redactor);

    await logger.log({
      timestamp: new Date().toISOString(),
      executionId: 'exec-3',
      action: 'tool.invoke',
      resource: 'web_search',
      outcome: 'success',
    });

    expect(logged[0]!.action).toBe('tool.invoke');
    expect(logged[0]!.resource).toBe('web_search');
  });
});
