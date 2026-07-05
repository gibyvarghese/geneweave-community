// Skills MCP server — exposes the workspace's skill catalogue over the Model Context Protocol so an
// external agent (Claude Desktop, Cursor, …) can discover and pull skills on demand (read-only:
// list_skills / search_skills / get_skill). Mirrors the notes MCP server; reuses the per-user
// user_mcp_tokens table with service='skills'.

import { randomBytes, createHash } from 'node:crypto';
import { newUUIDv7 } from '@weaveintel/core';
import { handleMcpMessage } from '@weaveintel/mcp-server';
import { createSkillMcpBridge, skillFromRow } from '@weaveintel/skills';
import type BetterSqlite3 from 'better-sqlite3';
import type { DatabaseAdapter } from './db.js';

const TOKEN_PREFIX = 'wsk_';
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
function handle(db: DatabaseAdapter): BetterSqlite3.Database {
  return (db as unknown as { d: BetterSqlite3.Database }).d;
}

interface TokenRow { id: string; user_id: string; tenant_id: string | null; name: string; token_prefix: string; enabled: number; created_at: string; last_used_at: string | null }

export function createMcpSkillsServer(db: DatabaseAdapter, opts: { now?: () => number } = {}) {
  // The catalogue is resolved fresh per request so newly-enabled skills appear immediately; retired
  // skills are hidden by the bridge. The catalogue is workspace-global (skills aren't per-user).
  const bridge = createSkillMcpBridge({
    skills: async () => (await db.listEnabledSkills()).map(skillFromRow),
    serverInfo: { name: 'geneweave-skills', version: '0.1.2', instructions: 'Search for a skill, then get it to follow its instructions.' },
  });

  function createToken(input: { userId: string; tenantId?: string | null; name?: string }): { token: string; id: string; prefix: string } {
    const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
    const id = 'smt-' + newUUIDv7().slice(-10);
    const createdAt = new Date((opts.now ?? Date.now)()).toISOString();
    handle(db).prepare(
      `INSERT INTO user_mcp_tokens (id, user_id, tenant_id, name, token_hash, token_prefix, scope, enabled, created_at, service)
       VALUES (?, ?, ?, ?, ?, ?, 'read', 1, ?, 'skills')`,
    ).run(id, input.userId, input.tenantId ?? null, input.name ?? 'Skills MCP token', sha256(token), token.slice(0, 14), createdAt);
    return { token, id, prefix: token.slice(0, 14) }; // plaintext returned ONCE
  }

  function listTokens(userId: string): TokenRow[] {
    return handle(db).prepare(
      `SELECT id, user_id, tenant_id, name, token_prefix, enabled, created_at, last_used_at
       FROM user_mcp_tokens WHERE user_id = ? AND service = 'skills' AND enabled = 1 ORDER BY created_at DESC`,
    ).all(userId) as TokenRow[];
  }

  function revokeToken(id: string, userId: string): void {
    handle(db).prepare(`UPDATE user_mcp_tokens SET enabled = 0 WHERE id = ? AND user_id = ? AND service = 'skills'`).run(id, userId);
  }

  function resolveToken(bearer: string | undefined): { userId: string; tokenId: string } | null {
    const token = (bearer ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const row = handle(db).prepare(`SELECT * FROM user_mcp_tokens WHERE token_hash = ? AND service = 'skills' AND enabled = 1`).get(sha256(token)) as { id: string; user_id: string } | undefined;
    if (!row) return null;
    handle(db).prepare(`UPDATE user_mcp_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
    return { userId: row.user_id, tokenId: row.id };
  }

  async function handleRequest(bearer: string | undefined, rawBody: string): Promise<{ status: number; body: unknown }> {
    const user = resolveToken(bearer);
    if (!user) return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a valid Skills MCP bearer token is required.' } } };
    let msg: unknown;
    try { msg = JSON.parse(rawBody || '{}'); } catch { return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }; }
    const response = await handleMcpMessage(msg as Parameters<typeof handleMcpMessage>[0], bridge);
    return { status: response === null ? 202 : 200, body: response };
  }

  return { createToken, listTokens, revokeToken, resolveToken, handleRequest };
}

export type McpSkillsServer = ReturnType<typeof createMcpSkillsServer>;
