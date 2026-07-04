/**
 * Phase 5 — Admin panel wiring for guardrail conditional triggers
 *
 * Tests that:
 *  1. derivePreset correctly maps stored condition JSON back to preset names.
 *  2. Admin POST/GET/PUT round-trips trigger_preset and trigger_description.
 *  3. Changes written through the admin API (or directly to DB) take effect
 *     on the next evaluateGuardrails call without a server restart.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { evaluateGuardrails } from './chat-guardrail-eval-utils.js';
import { derivePreset, registerGuardrailRoutes } from './admin/api/guardrails.js';
import type { RouterLike, AdminHelpers } from './admin/api/types.js';

// ── Test helpers ──────────────────────────────────────────────

async function freshDb(): Promise<DatabaseAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-phase5-'));
  return createDatabaseAdapter({ type: 'sqlite', path: join(dir, 'gw.db') });
}

/** Minimal mock IncomingMessage that emits a body string as stream data. */
function makeReq(body: string): IncomingMessage {
  const emitter = new EventEmitter();
  setImmediate(() => {
    emitter.emit('data', Buffer.from(body, 'utf8'));
    emitter.emit('end');
  });
  return emitter as unknown as IncomingMessage;
}

const MOCK_RES = null as unknown as ServerResponse;
const MOCK_AUTH = { userId: 'test-admin' };

/** Builds AdminHelpers that capture whatever json() is called with. */
function makeHelpers() {
  const captured: { status: number; body: unknown } = { status: 0, body: null };
  const helpers: AdminHelpers = {
    json: (_res, status, data) => {
      captured.status = status;
      captured.body = data;
    },
    readBody: (req) => new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }),
    requireDetailedDescription: () => null,
  };
  return { helpers, captured };
}

type HandlerFn = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: unknown,
) => Promise<void>;

interface Route { method: string; path: string; handler: HandlerFn; }

function buildRouter(db: DatabaseAdapter) {
  const routes: Route[] = [];
  const router: RouterLike = {
    get: (path, handler) => routes.push({ method: 'GET', path, handler: handler as HandlerFn }),
    post: (path, handler) => routes.push({ method: 'POST', path, handler: handler as HandlerFn }),
    put: (path, handler) => routes.push({ method: 'PUT', path, handler: handler as HandlerFn }),
    patch: (path, handler) => routes.push({ method: 'PATCH', path, handler: handler as HandlerFn }),
    del: (path, handler) => routes.push({ method: 'DELETE', path, handler: handler as HandlerFn }),
  };
  const { helpers, captured } = makeHelpers();
  registerGuardrailRoutes(router, db, helpers);

  function route(method: string, pathPattern: string): HandlerFn {
    const found = routes.find(r => r.method === method && r.path === pathPattern);
    if (!found) throw new Error(`Route not found: ${method} ${pathPattern}`);
    return found.handler;
  }

  async function call(
    method: string,
    pathPattern: string,
    body: string,
    params: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    await route(method, pathPattern)(makeReq(body), MOCK_RES, params, MOCK_AUTH);
    return { status: captured.status, body: captured.body };
  }

  return { call, captured };
}

// ── 1. derivePreset ────────────────────────────────────────────

describe('derivePreset', () => {
  it('returns "always" for null', () => {
    expect(derivePreset(null)).toBe('always');
  });

  it('returns "always" for undefined', () => {
    expect(derivePreset(undefined)).toBe('always');
  });

  it('returns "always" for empty string', () => {
    expect(derivePreset('')).toBe('always');
  });

  it('returns "custom" for invalid JSON', () => {
    expect(derivePreset('{not json')).toBe('custom');
  });

  it('returns "custom" for unknown valid JSON', () => {
    expect(derivePreset(JSON.stringify({ unknown_leaf: true }))).toBe('custom');
  });

  it('matches agent_mode preset', () => {
    const conditions = JSON.stringify({ any: [{ chat_mode: ['agent', 'supervisor'] }, { turn_has_tool_calls: true }] });
    expect(derivePreset(conditions)).toBe('agent_mode');
  });

  it('matches elevated_situation preset', () => {
    const conditions = JSON.stringify({ any: [{ risk_level: ['high', 'critical'] }, { prior_has_warn: true }] });
    expect(derivePreset(conditions)).toBe('elevated_situation');
  });

  it('matches anonymous_user preset', () => {
    expect(derivePreset(JSON.stringify({ persona: ['anonymous'] }))).toBe('anonymous_user');
  });

  it('matches factual_output preset', () => {
    const conditions = JSON.stringify({ all: [{ output_has_factual_claims: true }, { output_has_tool_evidence: false }] });
    expect(derivePreset(conditions)).toBe('factual_output');
  });

  it('matches validation_seeking preset', () => {
    expect(derivePreset(JSON.stringify({ input_has_validation_seeking: true }))).toBe('validation_seeking');
  });

  it('matches long_input preset', () => {
    expect(derivePreset(JSON.stringify({ input_length_gt: 300 }))).toBe('long_input');
  });

  it('matches suspicious_input preset', () => {
    const conditions = JSON.stringify({ any: [{ input_has_code: true }, { input_has_base64: true }, { input_has_urls: true }, { input_has_instruction_override: true }] });
    expect(derivePreset(conditions)).toBe('suspicious_input');
  });

  it('returns "custom" when JSON differs from all presets', () => {
    // Slightly different from agent_mode (extra field)
    const conditions = JSON.stringify({ any: [{ chat_mode: ['agent'] }] });
    expect(derivePreset(conditions)).toBe('custom');
  });
});

// ── 2. Admin CRUD — trigger_preset round-trip ──────────────────

describe('Admin guardrail CRUD — trigger_preset and trigger_description', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('POST with trigger_preset=agent_mode stores conditions and GET returns trigger_preset', async () => {
    const api = buildRouter(db);

    const post = await api.call('POST', '/api/admin/guardrails', JSON.stringify({
      name: 'Agent-mode check',
      type: 'content_filter',
      trigger_preset: 'agent_mode',
      trigger_description: 'Only in agent/supervisor mode or when tool calls are present',
    }));
    expect(post.status).toBe(201);
    const created = (post.body as { guardrail: Record<string, unknown> }).guardrail;
    expect(created['trigger_preset']).toBe('agent_mode');
    expect(created['trigger_description']).toBe('Only in agent/supervisor mode or when tool calls are present');
    expect(typeof created['trigger_conditions']).toBe('string');
    // The stored JSON must match the agent_mode preset
    expect(derivePreset(created['trigger_conditions'] as string)).toBe('agent_mode');

    const guardId = created['id'] as string;
    const get = await api.call('GET', '/api/admin/guardrails/:id', '', { id: guardId });
    expect(get.status).toBe(200);
    const fetched = (get.body as { guardrail: Record<string, unknown> }).guardrail;
    expect(fetched['trigger_preset']).toBe('agent_mode');
    expect(fetched['trigger_description']).toBe('Only in agent/supervisor mode or when tool calls are present');
  });

  it('POST with trigger_preset=always stores null conditions', async () => {
    const api = buildRouter(db);

    const post = await api.call('POST', '/api/admin/guardrails', JSON.stringify({
      name: 'Always-on check',
      type: 'content_filter',
      trigger_preset: 'always',
    }));
    expect(post.status).toBe(201);
    const created = (post.body as { guardrail: Record<string, unknown> }).guardrail;
    expect(created['trigger_preset']).toBe('always');
    // trigger_conditions should be null or absent
    expect(created['trigger_conditions'] == null).toBe(true);
  });

  it('POST with explicit trigger_conditions JSON is stored and returned as trigger_preset=custom', async () => {
    const api = buildRouter(db);
    const customConds = { turn_number_gt: 5 };

    const post = await api.call('POST', '/api/admin/guardrails', JSON.stringify({
      name: 'Custom-cond check',
      type: 'content_filter',
      trigger_conditions: customConds,
    }));
    expect(post.status).toBe(201);
    const created = (post.body as { guardrail: Record<string, unknown> }).guardrail;
    expect(created['trigger_preset']).toBe('custom');
    expect(JSON.parse(created['trigger_conditions'] as string)).toMatchObject(customConds);
  });

  it('POST returns 400 when name is missing', async () => {
    const api = buildRouter(db);
    const post = await api.call('POST', '/api/admin/guardrails', JSON.stringify({ type: 'content_filter' }));
    expect(post.status).toBe(400);
  });

  it('GET list includes trigger_preset and trigger_description for all guardrails', async () => {
    const api = buildRouter(db);

    await api.call('POST', '/api/admin/guardrails', JSON.stringify({
      name: 'G1', type: 'content_filter', trigger_preset: 'long_input', trigger_description: 'Long inputs only',
    }));
    await api.call('POST', '/api/admin/guardrails', JSON.stringify({
      name: 'G2', type: 'content_filter', trigger_preset: 'always',
    }));

    const list = await api.call('GET', '/api/admin/guardrails', '');
    expect(list.status).toBe(200);
    const guardrails = (list.body as { guardrails: Record<string, unknown>[] }).guardrails;
    // DB is seeded with migration guardrails; at minimum our 2 created ones are present
    expect(guardrails.length).toBeGreaterThanOrEqual(2);
    // Every row must have a trigger_preset field (enrichRow applied to all rows)
    expect(guardrails.every(g => 'trigger_preset' in g)).toBe(true);

    const g1 = guardrails.find(g => g['name'] === 'G1');
    const g2 = guardrails.find(g => g['name'] === 'G2');
    expect(g1?.['trigger_preset']).toBe('long_input');
    expect(g1?.['trigger_description']).toBe('Long inputs only');
    expect(g2?.['trigger_preset']).toBe('always');
  });

  it('PUT with trigger_preset updates stored conditions', async () => {
    const api = buildRouter(db);

    const post = await api.call('POST', '/api/admin/guardrails', JSON.stringify({
      name: 'Updatable', type: 'content_filter', trigger_preset: 'always',
    }));
    const id = (post.body as { guardrail: { id: string } }).guardrail.id;

    const put = await api.call('PUT', '/api/admin/guardrails/:id', JSON.stringify({
      trigger_preset: 'elevated_situation',
      trigger_description: 'High-risk or warned',
    }), { id });
    expect(put.status).toBe(200);
    const updated = (put.body as { guardrail: Record<string, unknown> }).guardrail;
    expect(updated['trigger_preset']).toBe('elevated_situation');
    expect(updated['trigger_description']).toBe('High-risk or warned');
    expect(derivePreset(updated['trigger_conditions'] as string)).toBe('elevated_situation');
  });

  it('PUT with trigger_preset=always clears trigger_conditions to null', async () => {
    const api = buildRouter(db);

    const post = await api.call('POST', '/api/admin/guardrails', JSON.stringify({
      name: 'Will be cleared', type: 'content_filter', trigger_preset: 'agent_mode',
    }));
    const id = (post.body as { guardrail: { id: string } }).guardrail.id;

    const put = await api.call('PUT', '/api/admin/guardrails/:id', JSON.stringify({
      trigger_preset: 'always',
    }), { id });
    expect(put.status).toBe(200);
    const updated = (put.body as { guardrail: Record<string, unknown> }).guardrail;
    expect(updated['trigger_preset']).toBe('always');
    expect(updated['trigger_conditions'] == null).toBe(true);
  });

  it('PUT returns 404 for unknown id', async () => {
    const api = buildRouter(db);
    const put = await api.call('PUT', '/api/admin/guardrails/:id', JSON.stringify({ name: 'x' }), { id: 'nonexistent' });
    expect(put.status).toBe(404);
  });

  it('GET detail returns 404 for unknown id', async () => {
    const api = buildRouter(db);
    const get = await api.call('GET', '/api/admin/guardrails/:id', '', { id: 'bad-id' });
    expect(get.status).toBe(404);
  });
});

// ── 3. Immediate effect — DB update → evaluateGuardrails ───────

describe('Immediate effect: DB update → evaluateGuardrails picks up change', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => { db = await freshDb(); });

  it('condition-gated guardrail only fires when condition matches', async () => {
    // Blocklist that only fires in agent/supervisor mode
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'agent-only-blocklist',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['restricted'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ chat_mode: ['agent', 'supervisor'] }),
    });

    // direct mode → condition not met → allow
    const r1 = await evaluateGuardrails(db, 'chat-1', null, 'restricted content', 'pre-execution',
      undefined, { chatMode: 'direct' });
    expect(r1.decision).toBe('allow');
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // agent mode → condition met → deny
    const r2 = await evaluateGuardrails(db, 'chat-2', null, 'restricted content', 'pre-execution',
      undefined, { chatMode: 'agent' });
    expect(r2.decision).toBe('deny');
  });

  it('removing trigger_conditions makes guardrail fire in all modes immediately', async () => {
    const id = newUUIDv7();

    // Start gated to agent mode only
    await db.createGuardrail({
      id,
      name: 'removable-gate',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['forbidden'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ chat_mode: ['agent'] }),
    });

    // direct mode → skipped
    const before = await evaluateGuardrails(db, 'c1', null, 'forbidden word', 'pre-execution',
      undefined, { chatMode: 'direct' });
    expect(before.decision).toBe('allow');
    expect(before.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // Remove the condition gate (no server restart needed — DB read on next call)
    await db.updateGuardrail(id, { trigger_conditions: null });

    // Same direct mode call now fires because conditions are gone
    const after = await evaluateGuardrails(db, 'c2', null, 'forbidden word', 'pre-execution',
      undefined, { chatMode: 'direct' });
    expect(after.decision).toBe('deny');
  });

  it('updating trigger_conditions to a new condition changes which turns fire', async () => {
    const id = newUUIDv7();

    // Initially fires only for long inputs (length > 300)
    await db.createGuardrail({
      id,
      name: 'length-then-mode-gated',
      description: null,
      type: 'blocklist',
      stage: 'pre',
      config: JSON.stringify({ words: ['secret'], action: 'deny' }),
      priority: 50,
      enabled: 1,
      trigger_conditions: JSON.stringify({ input_length_gt: 300 }),
    });

    const shortInput = 'secret'; // < 300 chars → condition not met
    const r1 = await evaluateGuardrails(db, 'c1', null, shortInput, 'pre-execution',
      undefined, {});
    expect(r1.decision).toBe('allow');
    expect(r1.results[0]?.metadata?.['skipped']).toBe('condition_not_met');

    // Switch condition to fire for anonymous users instead
    await db.updateGuardrail(id, {
      trigger_conditions: JSON.stringify({ persona: ['anonymous'] }),
    });

    // anonymous → now fires (regardless of input length)
    const r2 = await evaluateGuardrails(db, 'c2', null, shortInput, 'pre-execution',
      undefined, { persona: 'anonymous' });
    expect(r2.decision).toBe('deny');

    // tenant_user → skipped
    const r3 = await evaluateGuardrails(db, 'c3', null, shortInput, 'pre-execution',
      undefined, { persona: 'tenant_user' });
    expect(r3.decision).toBe('allow');
    expect(r3.results[0]?.metadata?.['skipped']).toBe('condition_not_met');
  });

  it('trigger_description round-trips through DB and admin GET detail', async () => {
    const api = buildRouter(db);

    const post = await api.call('POST', '/api/admin/guardrails', JSON.stringify({
      name: 'Described guardrail',
      type: 'content_filter',
      trigger_preset: 'validation_seeking',
      trigger_description: 'Fires when user is seeking validation',
    }));
    const id = (post.body as { guardrail: { id: string } }).guardrail.id;

    const get = await api.call('GET', '/api/admin/guardrails/:id', '', { id });
    const g = (get.body as { guardrail: Record<string, unknown> }).guardrail;
    expect(g['trigger_description']).toBe('Fires when user is seeking validation');
    expect(g['trigger_preset']).toBe('validation_seeking');
  });
});
