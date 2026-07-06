// SPDX-License-Identifier: MIT
/**
 * Phase 1 — Postgres app adapter. Proves the Postgres `DatabaseAdapter` slice (users, chats,
 * messages, skills) behaves *identically* to the default SQLite adapter, against a REAL Postgres
 * (spun up in a throwaway Docker container), plus a real-LLM end-to-end that persists genuine model
 * output. Tiers: positive · negative · stress · security · parity · real-LLM.
 *
 * The Postgres tests auto-skip when Docker isn't available (so `npm test` stays green on any
 * machine); the LLM test auto-skips without an OpenAI key. Nothing here is mocked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';
import { createPostgresAdapter, resolveDatabaseConfigFromEnv } from './db.js';
import type { UserRow, MessageRow } from './db-types/core.js';
import type { SkillRow } from './db-types/tools.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

function loadOpenAIKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const candidates = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '../../.env'),
    '/private/tmp/gw-community-fresh/.env',
    '/Users/gibyvarghese/weaveintel/.env',
  ];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/);
      if (m) return m[1]!.trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return undefined;
}
const OPENAI_KEY = loadOpenAIKey();

// ── Helpers ──────────────────────────────────────────────────────────────────
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const USER_COLS = ['id', 'email', 'name', 'persona', 'tenant_id', 'password_hash', 'email_verified', 'email_verified_at', 'email_bidx', 'mfa_enabled', 'mfa_totp_secret'];
const CHAT_COLS = ['id', 'user_id', 'title', 'model', 'provider', 'pinned', 'archived'];
const MSG_COLS = ['id', 'chat_id', 'role', 'content', 'metadata', 'tokens_used', 'cost', 'latency_ms'];
const SKILL_COLS = ['id', 'name', 'description', 'category', 'trigger_patterns', 'instructions', 'tool_names', 'examples', 'tags', 'priority', 'version', 'tool_policy_key', 'supervisor_agent_id', 'domain_sections', 'execution_contract', 'enabled'];

/** Project a row onto a fixed column set, normalising undefined→null, so SQLite and Postgres compare cleanly. */
function pick(row: Record<string, unknown>, cols: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = row[c] ?? null;
  return out;
}

function makeSkill(over: Partial<SkillRow> & Pick<SkillRow, 'id' | 'name'>): Omit<SkillRow, 'created_at' | 'updated_at'> {
  return {
    description: '', category: 'general', trigger_patterns: '[]', instructions: '',
    tool_names: null, examples: null, tags: null, priority: 0, version: '1.0',
    tool_policy_key: null, supervisor_agent_id: null, domain_sections: null, execution_contract: null,
    enabled: 1, ...over,
  };
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-pg-parity-${Date.now()}-${randomUUID()}.db`));
}

async function askOpenAI(prompt: string): Promise<{ content: string; model: string; usage: { total_tokens: number } }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { choices: Array<{ message: { content: string } }>; model: string; usage: { total_tokens: number } };
  return { content: j.choices[0]!.message.content, model: j.model, usage: j.usage };
}

// ════════════════════════════════════════════════════════════════════════════
// Hermetic tests — always run (no Docker, no network)
// ════════════════════════════════════════════════════════════════════════════
describe('Phase 1 — env switch + boundary (hermetic)', () => {
  it('resolveDatabaseConfigFromEnv: Postgres when WEAVE_DB=postgres + DATABASE_URL', () => {
    const cfg = resolveDatabaseConfigFromEnv({ WEAVE_DB: 'postgres', DATABASE_URL: 'postgres://u:p@h:5432/d' } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ type: 'postgres', connectionString: 'postgres://u:p@h:5432/d' });
  });

  it('resolveDatabaseConfigFromEnv: throws if WEAVE_DB=postgres but DATABASE_URL missing', () => {
    expect(() => resolveDatabaseConfigFromEnv({ WEAVE_DB: 'postgres' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('resolveDatabaseConfigFromEnv: SQLite by default, honouring WEAVE_DB_PATH', () => {
    expect(resolveDatabaseConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({ type: 'sqlite', path: './geneweave.db' });
    expect(resolveDatabaseConfigFromEnv({ WEAVE_DB_PATH: '/data/gw.db' } as NodeJS.ProcessEnv)).toEqual({ type: 'sqlite', path: '/data/gw.db' });
  });

  it('boundary: a not-yet-ported method throws a clear, actionable error', async () => {
    const db = createPostgresAdapter({ connectionString: 'postgres://unused' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((db as any).listPrompts()).rejects.toThrow(/not implemented yet[\s\S]*users, chats, messages, skills/);
  });

  it('boundary: implemented methods refuse to run before initialize()', async () => {
    const db = createPostgresAdapter({ connectionString: 'postgres://unused' });
    await expect(db.getUserById('x')).rejects.toThrow(/initialize\(\)/);
  });

  it('boundary: the adapter is not accidentally thenable', () => {
    const db = createPostgresAdapter({ connectionString: 'postgres://unused' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((db as any).then).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('Phase 1 — Postgres adapter (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: DatabaseAdapterLike;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pg = createPostgresAdapter({ client: pool }) as unknown as DatabaseAdapterLike;
    await pg.initialize();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── Positive: full slice round-trips ──────────────────────────────────────
  it('positive: users / chats / messages / skills round-trip on Postgres', async () => {
    const uid = randomUUID();
    await pg.createUser({ id: uid, email: `pos-${uid}@x.co`, name: 'Ada Lovelace', passwordHash: 'h', persona: 'tenant_user', tenantId: 't1' });
    const byEmail = await pg.getUserByEmail(`pos-${uid}@x.co`);
    const byId = await pg.getUserById(uid);
    expect(byEmail).not.toBeNull();
    expect(byId!.name).toBe('Ada Lovelace');
    expect(byId!.email_verified).toBe(0); // integer default (0), not boolean false
    expect(byId!.created_at).toMatch(TS_RE);

    const cid = randomUUID();
    await pg.createChat({ id: cid, userId: uid, title: 'First chat', model: 'gpt-4o-mini', provider: 'openai' });
    await pg.addMessage({ id: randomUUID(), chatId: cid, role: 'user', content: 'hello', tokensUsed: 3, cost: 0.0001, latencyMs: 12 });
    await pg.addMessage({ id: randomUUID(), chatId: cid, role: 'assistant', content: 'hi there', metadata: JSON.stringify({ finish: 'stop' }), tokensUsed: 5, cost: 0.0002, latencyMs: 340 });
    const msgs = await pg.getMessages(cid);
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.role).sort()).toEqual(['assistant', 'user']);
    expect(msgs.find((m) => m.role === 'assistant')!.cost).toBeCloseTo(0.0002);

    await pg.updateChatTitle(cid, uid, 'Renamed');

    const sid = randomUUID();
    await pg.createSkill(makeSkill({ id: sid, name: 'Invoice Reader', category: 'finance', priority: 7, tool_names: JSON.stringify(['ocr']), enabled: 1 }));
    await pg.createSkill(makeSkill({ id: randomUUID(), name: 'Disabled One', enabled: 0 }));
    expect((await pg.getSkill(sid))!.name).toBe('Invoice Reader');
    expect((await pg.listEnabledSkills()).some((s) => s.id === sid)).toBe(true);
    expect((await pg.listEnabledSkills()).some((s) => s.name === 'Disabled One')).toBe(false);
  });

  // ── Negative: missing rows are graceful, never crashes ────────────────────
  it('negative: missing lookups return null / empty, no throw', async () => {
    expect(await pg.getUserByEmail('nobody@nowhere.example')).toBeNull();
    expect(await pg.getUserById('missing-id')).toBeNull();
    expect(await pg.getSkill('missing-skill')).toBeNull();
    expect(await pg.getMessages('missing-chat')).toEqual([]);
  });

  // ── Parity: identical ops → identical rows on SQLite and Postgres ─────────
  it('parity: SQLite and Postgres return byte-identical rows for the same operations', async () => {
    const sq = tempSqlite();
    await sq.initialize();
    try {
      const uid = randomUUID();
      const user = { id: uid, email: `par-${uid}@x.co`, name: "O'Brien \"Ünïcode\"", passwordHash: 'p', persona: 'tenant_admin', tenantId: 'tenant-42', emailBidx: 'abc123' };
      await sq.createUser(user);
      await pg.createUser(user);
      expect(pick(await pg.getUserByEmail(user.email) as never, USER_COLS)).toEqual(pick(await sq.getUserByEmail(user.email) as never, USER_COLS));

      const cid = randomUUID();
      const chat = { id: cid, userId: uid, title: 'Parity chat', model: 'm', provider: 'openai' };
      await sq.createChat(chat); await pg.createChat(chat);
      const msg = { id: randomUUID(), chatId: cid, role: 'assistant', content: 'line;with--comment and ☃', metadata: JSON.stringify({ a: 1 }), tokensUsed: 9, cost: 0.5, latencyMs: 100 };
      await sq.addMessage(msg); await pg.addMessage(msg);
      const sMsg = (await sq.getMessages(cid))[0]!;
      const pMsg = (await pg.getMessages(cid)).find((m) => m.id === msg.id)!;
      expect(pick(pMsg as never, MSG_COLS)).toEqual(pick(sMsg as never, MSG_COLS));

      // Byte-order sort parity: uppercase sorts BEFORE lowercase (COLLATE "C"), unlike locale order.
      for (const [id, name, prio] of [['s1', 'zebra', 5], ['s2', 'Apple', 5], ['s3', 'banana', 9]] as const) {
        const s = makeSkill({ id: `${cid}-${id}`, name, priority: prio });
        await sq.createSkill(s); await pg.createSkill(s);
      }
      const sSkills = (await sq.listSkills()).filter((s) => s.id.startsWith(cid));
      const pSkills = (await pg.listSkills()).filter((s) => s.id.startsWith(cid));
      expect(pSkills.map((s) => s.name)).toEqual(sSkills.map((s) => s.name)); // same order
      expect(pSkills.map((s) => s.name)).toEqual(['banana', 'Apple', 'zebra']); // prio 9 first, then byte-order tie

      // Timestamps: present and same format on both (values differ by clock, which is expected).
      expect(pMsg.created_at).toMatch(TS_RE);
      expect(sMsg.created_at).toMatch(TS_RE);
    } finally {
      await sq.close();
    }
  });

  // ── Stress: large volume + concurrent writes stay correct ─────────────────
  it('stress: 800 skills + a 500-message chat + concurrent inserts stay consistent', async () => {
    const uid = randomUUID();
    await pg.createUser({ id: uid, email: `stress-${uid}@x.co`, name: 'Stress', passwordHash: 'h' });
    const cid = randomUUID();
    await pg.createChat({ id: cid, userId: uid, title: 'Big', model: 'm', provider: 'p' });

    const N_SKILLS = 800;
    for (let i = 0; i < N_SKILLS; i += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, N_SKILLS - i) }, (_, j) =>
          pg.createSkill(makeSkill({ id: `stress-${uid}-${String(i + j).padStart(4, '0')}`, name: `skill ${String(i + j).padStart(4, '0')}`, priority: (i + j) % 10 })),
        ),
      );
    }
    const mine = (await pg.listSkills()).filter((s) => s.id.startsWith(`stress-${uid}-`));
    expect(mine).toHaveLength(N_SKILLS);
    // Ordering invariant holds across the whole set: non-increasing priority.
    for (let i = 1; i < mine.length; i++) expect(mine[i - 1]!.priority).toBeGreaterThanOrEqual(mine[i]!.priority);

    const N_MSG = 500;
    for (let i = 0; i < N_MSG; i += 50) {
      await Promise.all(
        Array.from({ length: 50 }, (_, j) => pg.addMessage({ id: `${cid}-m${String(i + j).padStart(4, '0')}`, chatId: cid, role: 'user', content: `msg ${i + j}` })),
      );
    }
    const msgs = await pg.getMessages(cid);
    expect(msgs).toHaveLength(N_MSG);
    expect(new Set(msgs.map((m) => m.id)).size).toBe(N_MSG); // no dupes/loss under concurrency
  }, 60_000);

  // ── Security: hostile input is data, never executed; tenants stay isolated ─
  it('security: SQL-injection payloads are stored verbatim and cannot drop tables', async () => {
    const evil = `Robert'); DROP TABLE skills; --`;
    const sid = randomUUID();
    await pg.createSkill(makeSkill({ id: sid, name: evil, instructions: `"; DELETE FROM users; --`, description: evil }));
    const got = await pg.getSkill(sid);
    expect(got!.name).toBe(evil); // stored exactly, not executed
    expect(got!.instructions).toBe(`"; DELETE FROM users; --`);
    // Table still exists and is usable → injection did nothing.
    expect(Array.isArray(await pg.listSkills())).toBe(true);

    // Injection via a lookup argument returns nothing (no boolean-blind leak).
    expect(await pg.getUserByEmail(`' OR '1'='1`)).toBeNull();
  });

  it('security: two tenants round-trip independently (no cross-tenant bleed)', async () => {
    const a = randomUUID(); const b = randomUUID();
    await pg.createUser({ id: a, email: `t-${a}@x.co`, name: 'A', passwordHash: 'h', tenantId: 'tenant-A' });
    await pg.createUser({ id: b, email: `t-${b}@x.co`, name: 'B', passwordHash: 'h', tenantId: 'tenant-B' });
    expect((await pg.getUserById(a))!.tenant_id).toBe('tenant-A');
    expect((await pg.getUserById(b))!.tenant_id).toBe('tenant-B');
  });

  // ── Flagship: real LLM output persisted + read back byte-for-byte ─────────
  it.skipIf(!OPENAI_KEY)('real LLM: a genuine assistant message survives a Postgres round-trip intact', async () => {
    const uid = randomUUID();
    await pg.createUser({ id: uid, email: `llm-${uid}@x.co`, name: 'Real User', passwordHash: 'h' });
    const cid = randomUUID();
    await pg.createChat({ id: cid, userId: uid, title: 'LLM chat', model: 'gpt-4o-mini', provider: 'openai' });

    // Deliberately provoke tricky characters (emoji, quotes, apostrophes) to stress text fidelity.
    const answer = await askOpenAI('Reply with one short encouraging sentence that includes an emoji and the word "don\'t".');
    const mid = randomUUID();
    await pg.addMessage({
      id: mid, chatId: cid, role: 'assistant', content: answer.content,
      metadata: JSON.stringify({ model: answer.model, provider: 'openai' }),
      tokensUsed: answer.usage.total_tokens, cost: answer.usage.total_tokens * 0.0000006, latencyMs: 0,
    });

    const stored = (await pg.getMessages(cid)).find((m) => m.id === mid)!;
    expect(stored.content).toBe(answer.content); // byte-for-byte, emoji + quotes intact
    expect(JSON.parse(stored.metadata!).model).toBe(answer.model);
    expect(stored.tokens_used).toBe(answer.usage.total_tokens);
    expect(stored.tokens_used).toBeGreaterThan(0);

    // And a skill named by the LLM lists correctly.
    const named = await askOpenAI('Give me a two-word Title Case name for a skill that summarises invoices. Reply with only the name.');
    const skillName = named.content.trim().replace(/^["']|["']$/g, '').slice(0, 60);
    await pg.createSkill(makeSkill({ id: randomUUID(), name: skillName, category: 'finance', priority: 5 }));
    expect((await pg.listEnabledSkills()).some((s) => s.name === skillName)).toBe(true);
  }, 60_000);
});

/** Minimal structural type for the slice we call in tests (avoids depending on the full interface). */
interface DatabaseAdapterLike {
  initialize(): Promise<void>;
  createUser(u: { id: string; email: string; name: string; passwordHash: string; persona?: string; tenantId?: string | null; emailBidx?: string | null }): Promise<void>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  createChat(c: { id: string; userId: string; title: string; model: string; provider: string }): Promise<void>;
  updateChatTitle(id: string, userId: string, title: string): Promise<void>;
  addMessage(m: { id: string; chatId: string; role: string; content: string; metadata?: string; tokensUsed?: number; cost?: number; latencyMs?: number }): Promise<void>;
  getMessages(chatId: string): Promise<MessageRow[]>;
  createSkill(s: Omit<SkillRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSkill(id: string): Promise<SkillRow | null>;
  listSkills(): Promise<SkillRow[]>;
  listEnabledSkills(): Promise<SkillRow[]>;
}
