/**
 * Example 69 — MCP gateway: per-client token expiry & rotation (Phase 9)
 *
 * This example demonstrates Phase 9 capabilities for the multi-tenant
 * MCP gateway:
 *
 *  1. Create a gateway client with an `expires_at` deadline.
 *  2. Show that the gateway returns 401 + audit outcome `'expired'`
 *     once the deadline has passed.
 *  3. Rotate the client's token and stamp `rotated_at`.
 *  4. Use `listExpiringMCPGatewayClients(windowSeconds)` to find clients
 *     whose tokens are due to expire soon (rotation reminder workflow).
 *
 * Run:
 *   tsx examples/69-mcp-gateway-token-expiry-rotation.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import { createDatabaseAdapter } from '../apps/geneweave/src/db.js';
import {
  createMCPGateway,
  hashGatewayToken,
} from '../apps/geneweave/src/mcp-gateway.js';

async function postJson(url: string, body: unknown, token: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-phase9-example-'));
  const db = await createDatabaseAdapter({ type: 'sqlite', path: join(dir, 'gw.db') });

  // Boot a tiny HTTP front for the gateway, wired to the SQLite-backed
  // multi-tenant client resolver (same shape used in production).
  const gateway = createMCPGateway({
    token: 'fallback-disabled',
    clientResolver: (hash) => db.getMCPGatewayClientByTokenHash(hash),
    touchClient: (id) => db.touchMCPGatewayClient(id),
    requestLogger: async (entry) => {
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/gateway`;

  try {
    // ── 1. Create an already-expired client to demonstrate enforcement. ──
    const expiredToken = 'expired-token-demo';
    const expiredId = randomUUID();
    await db.createMCPGatewayClient({
      id: expiredId,
      name: 'demo-expired',
      description: 'Already past its expires_at',
      token_hash: hashGatewayToken(expiredToken),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const r1 = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, expiredToken);
    console.log(`[expired] status=${r1.status} (expect 401)`);

    const expiredLogs = await db.listMCPGatewayRequestLog({ clientId: expiredId, limit: 5 });
    console.log(`[expired] audit outcome=${expiredLogs[0]?.outcome ?? '<none>'} (expect 'expired')`);

    // ── 2. Create a valid client expiring in 3 days, then rotate it. ──
    const liveToken = 'live-token-demo';
    const liveId = randomUUID();
    await db.createMCPGatewayClient({
      id: liveId,
      name: 'demo-live',
      description: null,
      token_hash: hashGatewayToken(liveToken),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
      expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });

    // Rotate: issue a new token hash, stamp rotated_at, extend expiry by 90 days.
    const rotatedToken = 'rotated-token-demo';
    await db.updateMCPGatewayClient(liveId, {
      token_hash: hashGatewayToken(rotatedToken),
      rotated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    });
    const fresh = await db.getMCPGatewayClient(liveId);
    console.log(`[rotated] rotated_at=${fresh?.rotated_at ?? '<none>'} new expires_at=${fresh?.expires_at ?? '<none>'}`);

    // Prove the new token works and the old token does not.
    const rOld = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, liveToken);
    const rNew = await postJson(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, rotatedToken);
    console.log(`[rotated] old-token status=${rOld.status} (expect 401)  new-token status=${rNew.status} (expect 200)`);

    // ── 3. Expiring-soon listing for a 7-day rotation reminder window. ──
    // Add another client that expires in 30 days — should NOT show up.
    await db.createMCPGatewayClient({
      id: randomUUID(),
      name: 'demo-far-future',
      description: null,
      token_hash: hashGatewayToken('far-future'),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    // And a 1-day one that SHOULD show up.
    await db.createMCPGatewayClient({
      id: randomUUID(),
      name: 'demo-1-day',
      description: null,
      token_hash: hashGatewayToken('one-day'),
      allowed_classes: null,
      audit_chat_id: null,
      enabled: 1,
      rate_limit_per_minute: null,
      expires_at: new Date(Date.now() + 1 * 86_400_000).toISOString(),
    });

    const expiringSoon = await db.listExpiringMCPGatewayClients(7 * 86_400);
    console.log(`[expiring-soon ≤7d] count=${expiringSoon.length}`);
    for (const c of expiringSoon) {
      console.log(`  - ${c.name} expires_at=${c.expires_at}`);
    }
  } finally {
    await new Promise<void>((r, j) => {
      void gateway.close().then(() => server.close((e) => (e ? j(e) : r())));
    });
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
