import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMCPGateway,
  DEFAULT_EXPOSED_ALLOCATION_CLASSES,
  registerMCPGatewayInCatalog,
  loadGatewayConfigFromCatalog,
  hashGatewayToken,
  MCP_GATEWAY_TOOL_KEY,
  MCP_GATEWAY_CREDENTIAL_NAME,
  MCP_GATEWAY_DEFAULT_ENV_VAR,
} from './mcp-gateway.js';
import { createDatabaseAdapter } from './db.js';
import {
  InMemoryToolPolicyResolver,
  type ToolAuditEmitter,
} from '@weaveintel/tools';
import type { Tool, ToolAuditEvent } from '@weaveintel/core';

/**
 * Boots a tiny HTTP server fronted only by the MCP gateway handler so we
 * can exercise the request lifecycle (auth, MCP JSON-RPC dispatch, error
 * surfaces) without spinning up the full GeneWeave server.
 */
function startGatewayHttp(token: string | undefined): Promise<{ url: string; close: () => Promise<void> }> {
  const gateway = createMCPGateway({ token });
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void gateway.handle(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('gateway handle error', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('error');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () =>
          new Promise<void>((r, rej) => {
            void gateway.close().then(() => server.close((err) => (err ? rej(err) : r())));
          }),
      });
    });
  });
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; bodyText: string; bodyJson: unknown; body: string; headers: Record<string, string> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const bodyText = await res.text();
  let bodyJson: unknown = null;
  try { bodyJson = JSON.parse(bodyText); } catch { /* SSE or non-JSON */ }
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });
  return { status: res.status, bodyText, bodyJson, body: bodyText, headers: respHeaders };
}

/**
 * The Streamable HTTP transport may reply either as a single JSON response
 * or as an SSE stream depending on negotiation. This helper extracts the
 * first JSON-RPC envelope from either shape.
 */
function parseRPCResponse(bodyText: string, bodyJson: unknown): { id?: number | string; result?: unknown; error?: unknown } | null {
  if (bodyJson && typeof bodyJson === 'object') {
    return bodyJson as { id?: number | string; result?: unknown; error?: unknown };
  }
  const dataLine = bodyText.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(6));
  } catch {
    return null;
  }
}

describe('Phase 1D — MCP gateway', () => {
  describe('disabled (no token)', () => {
    let handle: { url: string; close: () => Promise<void> };
    beforeAll(async () => { handle = await startGatewayHttp(undefined); });
    afterAll(async () => { await handle.close(); });

    it('returns 503 with explanatory error when no token is configured', async () => {
      const r = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(r.status).toBe(503);
      expect(r.bodyJson).toMatchObject({ error: expect.stringContaining('disabled') });
    });
  });

  describe('enabled', () => {
    const TOKEN = 'test-secret-token-1234';
    let handle: { url: string; close: () => Promise<void> };
    beforeAll(async () => { handle = await startGatewayHttp(TOKEN); });
    afterAll(async () => { await handle.close(); });

    it('rejects requests with no Authorization header (401)', async () => {
      const r = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(r.status).toBe(401);
      expect(r.bodyJson).toMatchObject({ error: 'Unauthorized' });
    });

    it('rejects requests with wrong bearer token (401)', async () => {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: 'Bearer wrong-token' },
      );
      expect(r.status).toBe(401);
    });

    it('initialize handshake succeeds with correct token', async () => {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'phase1d-test', version: '1.0.0' },
          },
        },
        { Authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(200);
      const env = parseRPCResponse(r.bodyText, r.bodyJson);
      expect(env).toBeTruthy();
      expect(env?.error).toBeUndefined();
      const result = env?.result as { serverInfo?: { name?: string } } | undefined;
      expect(result?.serverInfo?.name).toBe('geneweave-gateway');
    });

    it('tools/list exposes external tools and excludes utility/data classes', async () => {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { Authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(200);
      const env = parseRPCResponse(r.bodyText, r.bodyJson);
      const result = env?.result as { tools?: Array<{ name: string; description: string }> } | undefined;
      expect(Array.isArray(result?.tools)).toBe(true);
      const names = (result?.tools ?? []).map((t) => t.name);

      // External classes — at least the canonical web search must be present.
      expect(names).toContain('web_search');

      // Utility / SV / data classes must NOT be exposed by default.
      expect(names).not.toContain('calculator'); // utility
      expect(names).not.toContain('datetime');   // utility
      expect(names).not.toContain('json_format');  // data
      expect(names).not.toContain('text_analysis');// data
    });

    it('all exposed tools belong to the default exposed allocation classes', async () => {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        { Authorization: `Bearer ${TOKEN}` },
      );
      const env = parseRPCResponse(r.bodyText, r.bodyJson);
      const result = env?.result as { tools?: Array<{ name: string; description: string }> } | undefined;
      const tools = result?.tools ?? [];
      expect(tools.length).toBeGreaterThan(0);
      // Description prefixes are `[allocationClass] ...`.
      for (const t of tools) {
        const m = t.description.match(/^\[([^\]]+)\]/);
        expect(m, `tool ${t.name} must have allocationClass prefix`).toBeTruthy();
        const cls = m![1]!;
        expect(DEFAULT_EXPOSED_ALLOCATION_CLASSES.has(cls), `tool ${t.name} class ${cls} must be in default set`).toBe(true);
      }
    });
  });

  describe('exposed surface', () => {
    it('synchronous factory reports exposedToolNames before any request', () => {
      const gw = createMCPGateway({ token: 'x' });
      expect(gw.enabled).toBe(true);
      expect(gw.exposedToolNames).toContain('web_search');
      expect(gw.exposedToolNames).not.toContain('calculator');
      void gw.close();
    });

    it('reports disabled and empty surface when no token', () => {
      const gw = createMCPGateway({ token: undefined });
      expect(gw.enabled).toBe(false);
      // Tools are still discovered; only the HTTP path is disabled.
      expect(gw.exposedToolNames.length).toBeGreaterThan(0);
      void gw.close();
    });
  });

  describe('self-registration in tool_catalog', () => {
    function makeTempDbPath(): { dir: string; dbPath: string } {
      const dir = mkdtempSync(join(tmpdir(), 'gw-mcp-cat-'));
      return { dir, dbPath: join(dir, 'test.db') };
    }

    it('upserts a catalog row + credential row idempotently', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        const first = await registerMCPGatewayInCatalog(db);
        expect(first.catalogId).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.credentialId).toMatch(/^[0-9a-f-]{36}$/);

        const catalog = await db.getToolCatalogByKey(MCP_GATEWAY_TOOL_KEY);
        expect(catalog).not.toBeNull();
        expect(catalog!.source).toBe('mcp');
        expect(catalog!.allocation_class).toBe('gateway');
        expect(catalog!.credential_id).toBe(first.credentialId);
        expect(catalog!.enabled).toBe(1);

        const config = JSON.parse(catalog!.config ?? '{}') as {
          endpoint: string;
          exposed_classes: string[];
          exposed_tool_keys: string[];
          auth_scheme: string;
        };
        expect(config.endpoint).toBe('/api/mcp/gateway');
        expect(config.auth_scheme).toBe('Bearer');
        // exposed_classes must match the default exposed set, sorted.
        expect(config.exposed_classes).toEqual([...DEFAULT_EXPOSED_ALLOCATION_CLASSES].sort());
        // exposed_tool_keys must include at least one external tool and exclude utility ones.
        expect(config.exposed_tool_keys).toContain('web_search');
        expect(config.exposed_tool_keys).not.toContain('calculator');

        const cred = await db.getToolCredential(first.credentialId);
        expect(cred).not.toBeNull();
        expect(cred!.name).toBe(MCP_GATEWAY_CREDENTIAL_NAME);
        expect(cred!.env_var_name).toBe(MCP_GATEWAY_DEFAULT_ENV_VAR);
        expect(cred!.enabled).toBe(1);
        // Tool names array must reference the catalog tool_key.
        const credToolNames = JSON.parse(cred!.tool_names ?? '[]') as string[];
        expect(credToolNames).toContain(MCP_GATEWAY_TOOL_KEY);

        // Second call must not create duplicates and must reuse the same IDs.
        const second = await registerMCPGatewayInCatalog(db);
        expect(second.catalogId).toBe(first.catalogId);
        expect(second.credentialId).toBe(first.credentialId);

        const allCreds = await db.listToolCredentials();
        expect(allCreds.filter((c) => c.name === MCP_GATEWAY_CREDENTIAL_NAME).length).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // ── Phase 4 — DB-driven gateway exposure config ──────────────────────────
    it('preserves operator-edited enabled toggle and exposed_classes on re-register', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        // Initial registration writes defaults.
        const first = await registerMCPGatewayInCatalog(db);

        // Operator disables the gateway and narrows the exposed classes.
        await db.updateToolConfig(first.catalogId, {
          enabled: 0,
          config: JSON.stringify({
            endpoint: '/api/mcp/gateway',
            server_name: 'geneweave-gateway',
            auth_scheme: 'Bearer',
            // Operator decided only `web` and `search` should be reachable.
            exposed_classes: ['web', 'search'],
            exposed_tool_keys: ['web_search'],
          }),
        });

        // Re-register (simulating next boot) must NOT clobber operator edits.
        await registerMCPGatewayInCatalog(db);
        const after = await db.getToolCatalogByKey(MCP_GATEWAY_TOOL_KEY);
        expect(after).not.toBeNull();
        expect(after!.enabled).toBe(0); // preserved
        const cfg = JSON.parse(after!.config ?? '{}') as {
          exposed_classes: string[];
          exposed_tool_keys: string[];
        };
        expect(cfg.exposed_classes).toEqual(['search', 'web']); // sorted, preserved
        // exposed_tool_keys is recomputed against the operator's class set,
        // so utility / cse / enterprise tools must not leak in.
        expect(cfg.exposed_tool_keys).toContain('web_search');
        expect(cfg.exposed_tool_keys).not.toContain('calculator');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadGatewayConfigFromCatalog returns operator-edited classes', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        const reg = await registerMCPGatewayInCatalog(db);
        await db.updateToolConfig(reg.catalogId, {
          enabled: 1,
          config: JSON.stringify({
            endpoint: '/api/mcp/gateway',
            exposed_classes: ['web', 'social'],
            exposed_tool_keys: [],
          }),
        });
        const loaded = await loadGatewayConfigFromCatalog(db);
        expect(loaded.enabled).toBe(true);
        expect([...loaded.exposedClasses].sort()).toEqual(['social', 'web']);
        expect(loaded.endpoint).toBe('/api/mcp/gateway');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadGatewayConfigFromCatalog reports enabled=false when operator disabled', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        const reg = await registerMCPGatewayInCatalog(db);
        await db.updateToolConfig(reg.catalogId, { enabled: 0 });
        const loaded = await loadGatewayConfigFromCatalog(db);
        expect(loaded.enabled).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadGatewayConfigFromCatalog falls back to defaults when catalog row absent', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        const loaded = await loadGatewayConfigFromCatalog(db);
        expect(loaded.enabled).toBe(true);
        expect([...loaded.exposedClasses].sort()).toEqual(
          [...DEFAULT_EXPOSED_ALLOCATION_CLASSES].sort(),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Phase 3 — policy enforcement + audit on gateway invocations ─────────────
  describe('policy enforcement + audit emission', () => {
    /**
     * Boots the gateway with a stub web_search tool, an in-memory policy
     * resolver (default permissive), and a capturing audit emitter so we
     * can assert that traffic flowing through `/api/mcp/gateway` lands in
     * the same audit pipeline as in-process chat tool calls.
     */
    function makeStubTool(record: { invoked: number }): Tool {
      return {
        schema: {
          name: 'web_search',
          description: 'stub web_search for gateway policy test',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          tags: ['web-search', 'search'],
          riskLevel: 'read-only',
        },
        async invoke() {
          record.invoked += 1;
          return { content: 'stub-ok' };
        },
      };
    }

    function startEnforcedGateway(token: string): Promise<{
      url: string;
      events: ToolAuditEvent[];
      stubCalls: { invoked: number };
      close: () => Promise<void>;
    }> {
      const stubCalls = { invoked: 0 };
      const stub = makeStubTool(stubCalls);
      const events: ToolAuditEvent[] = [];
      const auditEmitter: ToolAuditEmitter = { emit: async (e) => { events.push(e); } };
      const policyResolver = new InMemoryToolPolicyResolver();
      const gateway = createMCPGateway({
        token,
        tools: { web_search: stub },
        policyResolver,
        auditEmitter,
      });
      const server = createServer((req, res) => {
        void gateway.handle(req, res).catch(() => {
          if (!res.headersSent) { res.writeHead(500); res.end('error'); }
        });
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          resolve({
            url: `http://127.0.0.1:${addr.port}`,
            events,
            stubCalls,
            close: () =>
              new Promise<void>((r, rej) => {
                void gateway.close().then(() => server.close((err) => (err ? rej(err) : r())));
              }),
          });
        });
      });
    }

    it('emits a success audit event tagged with mcp-gateway chatId on tools/call', async () => {
      const TOKEN = 'phase3-test-token';
      const handle = await startEnforcedGateway(TOKEN);
      try {
        const r = await postJson(
          `${handle.url}/api/mcp/gateway`,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'web_search', arguments: { q: 'hello' } },
          },
          { Authorization: `Bearer ${TOKEN}` },
        );
        expect(r.status).toBe(200);
        expect(handle.stubCalls.invoked).toBe(1);

        // Audit event must have been emitted exactly once with the synthetic
        // gateway chatId so operators can filter MCP traffic in the admin UI.
        expect(handle.events.length).toBe(1);
        const evt = handle.events[0]!;
        expect(evt.toolName).toBe('web_search');
        expect(evt.outcome).toBe('success');
        expect(evt.chatId).toBe('mcp-gateway');
        expect(evt.agentPersona).toBe('mcp-gateway');
      } finally {
        await handle.close();
      }
    });
  });
});

// ─── Phase 5: Per-client gateway tokens ──────────────────────

describe('Phase 5 — multi-tenant MCP gateway clients', () => {
  /**
   * Build a gateway HTTP server backed by a SQLite-backed client resolver.
   * Each test gets its own DB so we can register/revoke clients without
   * cross-talk.
   */
  async function startMultiTenantHttp(
    db: Awaited<ReturnType<typeof createDatabaseAdapter>>,
    auditEvents?: ToolAuditEvent[],
    tools?: Record<string, Tool>,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const auditEmitter: ToolAuditEmitter = {
      async emit(evt: ToolAuditEvent): Promise<void> {
        auditEvents?.push(evt);
      },
    };
    // Permissive policy resolver so policy gating doesn't interfere with
    // client-attribution assertions.
    // Empty policy map → all tools fall through to DEFAULT_TOOL_POLICY
    // (enabled, read-only risk level, all risk levels allowed) which keeps
    // the gateway audit emit path active without blocking calls.
    const policy = new InMemoryToolPolicyResolver();
    const gateway = createMCPGateway({
      token: 'legacy-fallback',
      ...(tools ? { tools } : {}),
      policyResolver: policy,
      auditEmitter,
      clientResolver: (hash) => db.getMCPGatewayClientByTokenHash(hash),
      touchClient: (id) => db.touchMCPGatewayClient(id),
      // A-9: pass tenantId as first argument.
      gatewayRateLimiter: (tenantId, clientId, ws, limit) => db.checkAndIncrementGatewayRateLimit(tenantId, clientId, ws, limit),
      requestLogger: async (entry) => {
        const { randomUUID } = await import('node:crypto');
        await db.insertMCPGatewayRequestLog({
          id: randomUUID(),
          client_id: entry.clientId,
          client_name: entry.clientName,
          method: entry.method,
          tool_name: entry.toolName,
          outcome: entry.outcome,
          status_code: entry.statusCode,
          duration_ms: entry.durationMs,
          error_message: entry.errorMessage,
        });
      },
    });
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void gateway.handle(req, res).catch(() => {
        if (!res.headersSent) { res.writeHead(500); res.end('error'); }
      });
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise<void>((r, rej) => {
            void gateway.close().then(() => server.close((err) => err ? rej(err) : r()));
          }),
        });
      });
    });
  }

  let dbDir: string;
  let db: Awaited<ReturnType<typeof createDatabaseAdapter>>;

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'gw-phase5-'));
    db = await createDatabaseAdapter({ type: 'sqlite', path: join(dbDir, 'gw.db') });
  });
  afterAll(async () => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('rejects a registered client whose token is wrong (401)', async () => {
    const client = {
      id: 'client-bad-token',
      name: 'bad-token-client',
      description: null,
      token_hash: hashGatewayToken('correct-token'),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    const handle = await startMultiTenantHttp(db);
    try {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: 'Bearer attacker-guess' },
      );
      expect(r.status).toBe(401);
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('accepts a registered client and stamps audit chatId from client name', async () => {
    const plaintext = 'phase5-good-secret-xyz';
    const client = {
      id: 'client-good',
      name: 'claude-desktop',
      description: 'Test client',
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    const events: ToolAuditEvent[] = [];
    const stub: Tool = {
      schema: { name: 'web_search', description: 'stub', parameters: { type: 'object' }, tags: ['web-search'], riskLevel: 'read-only' },
      async invoke() { return { content: 'ok' }; },
    };
    const handle = await startMultiTenantHttp(db, events, { web_search: stub });
    try {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: `Bearer ${plaintext}` },
      );
      expect(r.status).toBe(200);
      // tools/list itself does not emit a tool audit event; trigger an
      // actual tool call to verify chatId attribution.
      const r2 = await postJson(
        `${handle.url}/api/mcp/gateway`,
        {
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'web_search', arguments: { query: 'test' } },
        },
        { Authorization: `Bearer ${plaintext}` },
      );
      expect(r2.status).toBe(200);
      const evt = events.find((e) => e.toolName === 'web_search');
      expect(evt).toBeTruthy();
      expect(evt?.chatId).toBe('mcp-gateway:claude-desktop');
      expect(evt?.agentPersona).toBe('mcp-gateway');
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('honors explicit audit_chat_id override on the client row', async () => {
    const plaintext = 'phase5-override-token';
    const client = {
      id: 'client-override',
      name: 'ci-runner',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: 'tenant-acme:ci',
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    const events: ToolAuditEvent[] = [];
    const stub: Tool = {
      schema: { name: 'web_search', description: 'stub', parameters: { type: 'object' }, tags: ['web-search'], riskLevel: 'read-only' },
      async invoke() { return { content: 'ok' }; },
    };
    const handle = await startMultiTenantHttp(db, events, { web_search: stub });
    try {
      await postJson(
        `${handle.url}/api/mcp/gateway`,
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'web_search', arguments: { query: 'x' } },
        },
        { Authorization: `Bearer ${plaintext}` },
      );
      const evt = events.find((e) => e.toolName === 'web_search');
      expect(evt?.chatId).toBe('tenant-acme:ci');
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('narrows exposed tools to the allowed_classes intersection', async () => {
    const plaintext = 'phase5-scoped-token';
    const client = {
      id: 'client-scoped',
      name: 'web-only',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: JSON.stringify(['web']),
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    const handle = await startMultiTenantHttp(db);
    try {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: `Bearer ${plaintext}` },
      );
      const env = parseRPCResponse(r.bodyText, r.bodyJson);
      const tools = (env?.result as { tools?: Array<{ name: string; description: string }> })?.tools ?? [];
      // All exposed descriptions must start with [web]; nothing else is
      // visible to a web-only client.
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) {
        expect(t.description.startsWith('[web]')).toBe(true);
      }
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('rejects a revoked client even if its token hash still matches', async () => {
    const plaintext = 'phase5-revoked-token';
    const client = {
      id: 'client-revoked',
      name: 'old-laptop',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    await db.revokeMCPGatewayClient(client.id);
    const handle = await startMultiTenantHttp(db);
    try {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: `Bearer ${plaintext}` },
      );
      expect(r.status).toBe(401);
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('falls back to the legacy single token when no client row matches', async () => {
    // No client rows registered with this hash — gateway should accept the
    // legacy `token` we wired in startMultiTenantHttp.
    const handle = await startMultiTenantHttp(db);
    try {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: 'Bearer legacy-fallback' },
      );
      expect(r.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('updates last_used_at after a successful client request', async () => {
    const plaintext = 'phase5-touch-token';
    const client = {
      id: 'client-touch',
      name: 'touch-test',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    const before = await db.getMCPGatewayClient(client.id);
    expect(before?.last_used_at).toBeNull();
    const handle = await startMultiTenantHttp(db);
    try {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: `Bearer ${plaintext}` },
      );
      expect(r.status).toBe(200);
      // The touch is fire-and-forget; give it a microtask to land.
      await new Promise((r) => setTimeout(r, 50));
      const after = await db.getMCPGatewayClient(client.id);
      expect(after?.last_used_at).toBeTruthy();
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  // ─── Phase 7: per-client rate limits ─────────────────────────

  it('enforces per-client rate_limit_per_minute and returns 429 with Retry-After', async () => {
    const plaintext = 'phase7-rl-secret';
    const client = {
      id: 'client-rl-7',
      name: 'rate-limited-client',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: 2,
    };
    await db.createMCPGatewayClient(client);
    const handle = await startMultiTenantHttp(db);
    try {
      const auth = { Authorization: `Bearer ${plaintext}` };
      // First two calls in the same minute window must succeed.
      const r1 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth);
      expect(r1.status).toBe(200);
      const r2 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
      expect(r2.status).toBe(200);
      // Third call exhausts the bucket → 429 with Retry-After header.
      const r3 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, auth);
      expect(r3.status).toBe(429);
      const retry = r3.headers['retry-after'];
      expect(retry).toBeTruthy();
      expect(Number(retry)).toBeGreaterThan(0);
      expect(Number(retry)).toBeLessThanOrEqual(60);
      const body = JSON.parse(r3.body) as { error: string; retry_after_seconds: number };
      expect(body.error).toMatch(/rate limit/i);
      expect(body.retry_after_seconds).toBeGreaterThan(0);
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('does not rate limit clients with rate_limit_per_minute=null', async () => {
    const plaintext = 'phase7-no-rl-secret';
    const client = {
      id: 'client-no-rl',
      name: 'unlimited-client',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    const handle = await startMultiTenantHttp(db);
    try {
      const auth = { Authorization: `Bearer ${plaintext}` };
      // Five calls all succeed since no cap is set.
      for (let i = 0; i < 5; i++) {
        const r = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: i, method: 'tools/list' }, auth);
        expect(r.status).toBe(200);
      }
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('isolates rate-limit buckets per client', async () => {
    const plaintextA = 'phase7-iso-a';
    const plaintextB = 'phase7-iso-b';
    const a = {
      id: 'client-iso-a', name: 'iso-a', description: null,
      token_hash: hashGatewayToken(plaintextA), allowed_classes: null,
      audit_chat_id: null, enabled: 1, rate_limit_per_minute: 1,
    };
    const b = {
      id: 'client-iso-b', name: 'iso-b', description: null,
      token_hash: hashGatewayToken(plaintextB), allowed_classes: null,
      audit_chat_id: null, enabled: 1, rate_limit_per_minute: 1,
    };
    await db.createMCPGatewayClient(a);
    await db.createMCPGatewayClient(b);
    const handle = await startMultiTenantHttp(db);
    try {
      // A consumes its quota.
      const r1 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${plaintextA}` });
      expect(r1.status).toBe(200);
      const r2 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { Authorization: `Bearer ${plaintextA}` });
      expect(r2.status).toBe(429);
      // B still has its full quota — buckets are scoped per client.
      const r3 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { Authorization: `Bearer ${plaintextB}` });
      expect(r3.status).toBe(200);
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(a.id);
      await db.deleteMCPGatewayClient(b.id);
    }
  });

  // ─── Phase 8 — gateway request log ───────────────────────────────

  it('logs every terminal outcome to mcp_gateway_request_log (ok, unauthorized, rate_limited)', async () => {
    const plaintext = 'phase8-log-token';
    const client = {
      id: 'client-phase8-log',
      name: 'phase8-log',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: 1,
    };
    await db.createMCPGatewayClient(client);
    const handle = await startMultiTenantHttp(db);
    try {
      // ok
      const r1 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${plaintext}` });
      expect(r1.status).toBe(200);
      // rate_limited (cap=1)
      const r2 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { Authorization: `Bearer ${plaintext}` });
      expect(r2.status).toBe(429);
      // unauthorized (no auth)
      const r3 = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
      expect(r3.status).toBe(401);
      // Allow async logger writes to flush.
      await new Promise((r) => setTimeout(r, 50));
      const events = await db.listMCPGatewayRequestLog({ limit: 50 });
      const matched = events.filter((e) => e.client_id === client.id || (e.client_id == null && e.outcome === 'unauthorized'));
      const outcomes = new Set(matched.map((e) => e.outcome));
      expect(outcomes.has('ok')).toBe(true);
      expect(outcomes.has('rate_limited')).toBe(true);
      expect(outcomes.has('unauthorized')).toBe(true);
      // The ok/rate_limited events carry the client name; method is 'tools/list'.
      const okEvt = matched.find((e) => e.outcome === 'ok');
      expect(okEvt?.client_name).toBe('phase8-log');
      expect(okEvt?.method).toBe('tools/list');
      expect(typeof okEvt?.duration_ms).toBe('number');
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('summarizeMCPGatewayActivity aggregates per-client counts in window', async () => {
    const plaintext = 'phase8-summary-token';
    const client = {
      id: 'client-phase8-summary',
      name: 'phase8-summary',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    const handle = await startMultiTenantHttp(db);
    try {
      for (let i = 0; i < 3; i++) {
        const r = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: i, method: 'tools/list' }, { Authorization: `Bearer ${plaintext}` });
        expect(r.status).toBe(200);
      }
      await new Promise((r) => setTimeout(r, 50));
      const sinceIso = new Date(Date.now() - 60_000).toISOString();
      const summary = await db.summarizeMCPGatewayActivity({ sinceIso });
      const row = summary.find((s) => s.client_id === client.id);
      expect(row).toBeDefined();
      expect(row!.total).toBeGreaterThanOrEqual(3);
      expect(row!.ok).toBeGreaterThanOrEqual(3);
      expect(row!.rate_limited).toBe(0);
      expect(row!.last_seen).toBeTruthy();
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it("Phase 9 — rejects expired token with 401 and logs 'expired' outcome", async () => {
    const plaintext = 'phase9-expired-token';
    const client = {
      id: 'client-phase9-expired',
      name: 'phase9-expired',
      description: null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    await db.createMCPGatewayClient(client);
    const handle = await startMultiTenantHttp(db);
    try {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: `Bearer ${plaintext}` },
      );
      expect(r.status).toBe(401);
      await new Promise((res) => setTimeout(res, 30));
      const logs = await db.listMCPGatewayRequestLog({ clientId: client.id, limit: 50 });
      const expired = logs.find((l) => l.outcome === 'expired');
      expect(expired).toBeDefined();
      expect(expired!.status_code).toBe(401);
    } finally {
      await handle.close();
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('Phase 9 — rotateMCPGatewayClient stamps rotated_at and updates expires_at', async () => {
    const client = {
      id: 'client-phase9-rotate',
      name: 'phase9-rotate',
      description: null,
      token_hash: hashGatewayToken('initial'),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    await db.createMCPGatewayClient(client);
    try {
      const newExpiresIso = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await db.updateMCPGatewayClient(client.id, {
        token_hash: hashGatewayToken('rotated'),
        rotated_at: new Date().toISOString(),
        expires_at: newExpiresIso,
      });
      const fresh = await db.getMCPGatewayClient(client.id);
      expect(fresh).toBeTruthy();
      expect(fresh!.rotated_at).toBeTruthy();
      expect(new Date(fresh!.rotated_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(fresh!.expires_at).toBe(newExpiresIso);
      expect(fresh!.token_hash).toBe(hashGatewayToken('rotated'));
    } finally {
      await db.deleteMCPGatewayClient(client.id);
    }
  });

  it('Phase 9 — listExpiringMCPGatewayClients returns only clients within window', async () => {
    const a = {
      id: 'client-phase9-expnone',
      name: 'phase9-expnone',
      description: null,
      token_hash: hashGatewayToken('a'),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
    };
    const b = {
      id: 'client-phase9-exp1d',
      name: 'phase9-exp1d',
      description: null,
      token_hash: hashGatewayToken('b'),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
      expires_at: new Date(Date.now() + 1 * 86_400_000).toISOString(),
    };
    const c = {
      id: 'client-phase9-exp30d',
      name: 'phase9-exp30d',
      description: null,
      token_hash: hashGatewayToken('c'),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    await db.createMCPGatewayClient(a);
    await db.createMCPGatewayClient(b);
    await db.createMCPGatewayClient(c);
    try {
      const within7 = await db.listExpiringMCPGatewayClients(7 * 86_400);
      const ids = within7.map((r) => r.id);
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(a.id);
      expect(ids).not.toContain(c.id);
    } finally {
      await db.deleteMCPGatewayClient(a.id);
      await db.deleteMCPGatewayClient(b.id);
      await db.deleteMCPGatewayClient(c.id);
    }
  });
});
