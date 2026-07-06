// SPDX-License-Identifier: MIT
/**
 * Postgres implementation of the app's `DatabaseAdapter` — the second backend, alongside the
 * default SQLite one in `db-sqlite.ts`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 * geneWeave runs on SQLite out of the box (one file, zero setup) which is perfect for local
 * development, the desktop app, and small single-node deployments. But a growing team eventually
 * wants a real server database: concurrent writers, network access, backups, and — increasingly —
 * embeddings living next to the rest of the data (Postgres + pgvector as one store). This adapter
 * is that path. You flip one environment variable and the same app talks to Postgres instead.
 *
 * ── What's covered today (and what isn't) ──────────────────────────────────────────────────
 * The full `DatabaseAdapter` is enormous (18 domains, ~300 methods, ~86 tables). Porting all of it
 * is a staged effort. This file implements the **core chat + skills slice** — users, chats,
 * messages, and skills — end to end, byte-for-byte identical to the SQLite adapter. Every method
 * that isn't ported yet throws a clear, self-explaining error (see `withPostgresBoundary`) rather
 * than silently doing the wrong thing, so it's always obvious what's available. The remaining
 * domains are added incrementally. See `PERSISTENCE_ARCHITECTURE_REVIEW_2026.md` for the full plan.
 *
 * ── The one rule that makes SQLite and Postgres agree ───────────────────────────────────────
 * The two databases sort text differently: SQLite compares bytes, Postgres compares by the
 * database's language/locale rules. Left alone, `ORDER BY name` returns rows in a different order
 * on each. We pin every text ordering to `COLLATE "C"` (plain byte order) so results match SQLite
 * exactly. We also keep the same column *shapes*: booleans stay integers (`0`/`1`, not `true`/
 * `false`), counts stay 32-bit integers (so they come back as JS numbers, not strings), and
 * timestamps stay text in SQLite's `YYYY-MM-DD HH:MM:SS` format. The result: a row read from
 * Postgres is indistinguishable from the same row read from SQLite.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────────────────────
 * Every value is sent as a bound parameter (`$1`, `$2`, …) — never glued into the SQL text — so a
 * name or message containing quotes, semicolons, or `DROP TABLE` is stored as harmless data.
 */

import type { DatabaseAdapter } from './db-types/adapter.js';
import type { UserRow, ChatRow, MessageRow } from './db-types/core.js';
import type { SkillRow } from './db-types/tools.js';

/**
 * The tiny slice of a Postgres client this adapter needs. A `pg.Pool`, a `pg.Client`, a pooled
 * proxy, a serverless driver (Neon), or a test container all satisfy it — so nothing here hard-
 * depends on a specific driver.
 */
export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** Optional — present on `pg.Pool`. Called by `close()` only when this adapter created the pool. */
  end?(): Promise<void>;
}

export interface PostgresAdapterOptions {
  /** Bring your own client (tests, custom pooling, serverless). `close()` will NOT end it. */
  readonly client?: SqlClient;
  /** …or hand over a connection string and let the adapter create + own a `pg.Pool`. `close()` ends it. */
  readonly connectionString?: string;
}

/** SQLite's `datetime('now')` in Postgres terms: UTC, `YYYY-MM-DD HH:MM:SS`, second precision. */
const NOW_TEXT = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')`;

/**
 * The schema for the ported slice. Types are chosen to return the *same JS values* as SQLite:
 *  • booleans → INTEGER (0/1)          • counts/priority → INTEGER (JS number, not bigint-string)
 *  • cost → DOUBLE PRECISION (number)  • timestamps → TEXT in SQLite's format
 * `IF NOT EXISTS` everywhere, so `initialize()` is safe to call repeatedly.
 */
export const POSTGRES_SLICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT 'tenant_user',
  tenant_id TEXT,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_verified_at TEXT,
  email_bidx TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_totp_secret TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT 'New Chat',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT},
  updated_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  trigger_patterns TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '',
  tool_names TEXT,
  examples TEXT,
  tags TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '1.0',
  tool_policy_key TEXT,
  supervisor_agent_id TEXT,
  domain_sections TEXT,
  execution_contract TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW_TEXT},
  updated_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
);
`;

/** The method names this adapter actually implements — the honest, testable Phase-1 surface. */
export const POSTGRES_IMPLEMENTED_METHODS: readonly string[] = [
  'initialize', 'close',
  'createUser', 'getUserByEmail', 'getUserById',
  'createChat', 'updateChatTitle', 'deleteChat', 'addMessage', 'getMessages',
  'createSkill', 'getSkill', 'listSkills', 'listEnabledSkills',
];

/**
 * The real implementation of the ported slice. Each method mirrors the SQLite adapter's SQL exactly
 * (same columns, same order, same JSON-as-text handling) with `?` swapped for `$n` and text
 * orderings pinned to `COLLATE "C"` for byte-order parity.
 */
class PostgresCore {
  private sql: SqlClient | null = null;
  private ownsClient = false;

  constructor(private readonly opts: PostgresAdapterOptions) {}

  private db(): SqlClient {
    if (!this.sql) throw new Error('PostgresAdapter: call initialize() before using the adapter');
    return this.sql;
  }

  async initialize(): Promise<void> {
    if (!this.sql) {
      if (this.opts.client) {
        this.sql = this.opts.client;
        this.ownsClient = false;
      } else {
        if (!this.opts.connectionString) {
          throw new Error('PostgresAdapter: provide either { client } or { connectionString }');
        }
        // Lazy-import so `pg` is only required when Postgres is actually used.
        const pg = (await import('pg')).default as unknown as {
          Pool: new (cfg: { connectionString: string }) => SqlClient;
        };
        this.sql = new pg.Pool({ connectionString: this.opts.connectionString });
        this.ownsClient = true;
      }
    }
    await this.sql.query(POSTGRES_SLICE_SCHEMA);
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.sql?.end) await this.sql.end();
    this.sql = null;
  }

  // ── Users ──────────────────────────────────────────────────────────────────
  async createUser(u: { id: string; email: string; name: string; passwordHash: string; persona?: string; tenantId?: string | null; emailBidx?: string | null }): Promise<void> {
    await this.db().query(
      'INSERT INTO users (id, email, name, persona, tenant_id, password_hash, email_bidx) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [u.id, u.email, u.name, u.persona ?? 'tenant_user', u.tenantId ?? null, u.passwordHash, u.emailBidx ?? null],
    );
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.db().query('SELECT * FROM users WHERE email = $1', [email]);
    return (rows[0] as UserRow | undefined) ?? null;
  }

  async getUserById(id: string): Promise<UserRow | null> {
    const { rows } = await this.db().query('SELECT * FROM users WHERE id = $1', [id]);
    return (rows[0] as UserRow | undefined) ?? null;
  }

  // ── Chats ──────────────────────────────────────────────────────────────────
  async createChat(c: { id: string; userId: string; title: string; model: string; provider: string }): Promise<void> {
    await this.db().query(
      'INSERT INTO chats (id, user_id, title, model, provider) VALUES ($1, $2, $3, $4, $5)',
      [c.id, c.userId, c.title, c.model, c.provider],
    );
  }

  async updateChatTitle(id: string, userId: string, title: string): Promise<void> {
    await this.db().query(
      `UPDATE chats SET title = $1, updated_at = ${NOW_TEXT} WHERE id = $2 AND user_id = $3`,
      [title, id, userId],
    );
  }

  async deleteChat(id: string, userId: string): Promise<void> {
    await this.db().query('DELETE FROM chats WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  async addMessage(m: { id: string; chatId: string; role: string; content: string; metadata?: string; tokensUsed?: number; cost?: number; latencyMs?: number }): Promise<void> {
    await this.db().query(
      'INSERT INTO messages (id, chat_id, role, content, metadata, tokens_used, cost, latency_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [m.id, m.chatId, m.role, m.content, m.metadata ?? null, m.tokensUsed ?? 0, m.cost ?? 0, m.latencyMs ?? 0],
    );
    await this.db().query(`UPDATE chats SET updated_at = ${NOW_TEXT} WHERE id = $1`, [m.chatId]);
  }

  async getMessages(chatId: string): Promise<MessageRow[]> {
    const { rows } = await this.db().query(
      'SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at COLLATE "C" ASC',
      [chatId],
    );
    return rows as unknown as MessageRow[];
  }

  // ── Skills ─────────────────────────────────────────────────────────────────
  async createSkill(s: Omit<SkillRow, 'created_at' | 'updated_at'>): Promise<void> {
    await this.db().query(
      `INSERT INTO skills (id, name, description, category, trigger_patterns, instructions, tool_names, examples, tags, priority, version, tool_policy_key, enabled, supervisor_agent_id, domain_sections, execution_contract)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        s.id, s.name, s.description, s.category, s.trigger_patterns, s.instructions,
        s.tool_names ?? null, s.examples ?? null, s.tags ?? null, s.priority, s.version,
        s.tool_policy_key ?? null, s.enabled, s.supervisor_agent_id ?? null,
        s.domain_sections ?? null, s.execution_contract ?? null,
      ],
    );
  }

  async getSkill(id: string): Promise<SkillRow | null> {
    const { rows } = await this.db().query('SELECT * FROM skills WHERE id = $1', [id]);
    return (rows[0] as SkillRow | undefined) ?? null;
  }

  async listSkills(): Promise<SkillRow[]> {
    const { rows } = await this.db().query('SELECT * FROM skills ORDER BY priority DESC, name COLLATE "C" ASC');
    return rows as unknown as SkillRow[];
  }

  async listEnabledSkills(): Promise<SkillRow[]> {
    const { rows } = await this.db().query('SELECT * FROM skills WHERE enabled = 1 ORDER BY priority DESC, name COLLATE "C" ASC');
    return rows as unknown as SkillRow[];
  }
}

/** Property names that must NOT be intercepted — doing so would make the object look thenable, etc. */
const PASS_THROUGH = new Set(['then', 'catch', 'finally', 'constructor', 'toJSON', 'toString', 'inspect']);

/**
 * Wrap the core implementation so any not-yet-ported `DatabaseAdapter` method throws a clear,
 * actionable error instead of being `undefined` (which would surface as a confusing
 * "x is not a function" much later). This keeps the adapter honest: what's implemented works and is
 * byte-parity-tested; everything else tells you exactly why it isn't available and what to do.
 */
export function withPostgresBoundary(core: PostgresCore): DatabaseAdapter {
  return new Proxy(core, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) return typeof value === 'function' ? value.bind(target) : value;
      if (typeof prop !== 'string' || PASS_THROUGH.has(prop)) return value;
      return async (..._args: unknown[]) => {
        throw new Error(
          `PostgresAdapter: "${prop}()" is not implemented yet.\n` +
          `Phase 1 covers the core chat + skills slice — users, chats, messages, skills — at full ` +
          `parity with SQLite. The remaining domains are ported incrementally (see ` +
          `PERSISTENCE_ARCHITECTURE_REVIEW_2026.md). For complete coverage today, run on SQLite ` +
          `(the default) or contribute the "${prop}" method to db-postgres.ts.`,
        );
      };
    },
  }) as unknown as DatabaseAdapter;
}

/**
 * Build a Postgres-backed `DatabaseAdapter`. Call `initialize()` before use (the factory
 * `createDatabaseAdapter({ type: 'postgres', connectionString })` does this for you).
 *
 * @example
 * ```ts
 * import pg from 'pg';
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const db = createPostgresAdapter({ client: pool });
 * await db.initialize();
 * await db.createUser({ id: 'u1', email: 'a@b.co', name: 'Ana', passwordHash: 'x' });
 * ```
 */
export function createPostgresAdapter(opts: PostgresAdapterOptions): DatabaseAdapter {
  return withPostgresBoundary(new PostgresCore(opts));
}
