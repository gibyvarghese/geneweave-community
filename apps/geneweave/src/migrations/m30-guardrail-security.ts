import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration M30 — Security guardrail additions (C2 + H4 findings)
 *
 * Inserts four new pre-execution guardrails into existing databases:
 *   - Input: API Key Pattern         (deny credentials arriving in user messages)
 *   - Input: Database Connection String (deny DB connection strings in input)
 *   - SSRF: Localhost / Loopback Probe (deny localhost SSRF prompts)
 *   - SSRF: RFC-1918 Private Network   (deny private-range SSRF prompts)
 *
 * All inserts are idempotent (INSERT OR IGNORE) so re-running the migration
 * on a DB that already has these rows is a no-op.
 */
export function applyM30GuardrailSecurity(db: BetterSqlite3.Database): void {
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO guardrails
      (id, name, description, type, stage, config, priority, enabled, created_at, updated_at)
    VALUES
      (@id, @name, @description, @type, @stage, @config, @priority, @enabled, @now, @now)
  `);

  const guardrails = [
    {
      id: 'd1000001-aaaa-4000-8000-000000000001',
      name: 'Input: API Key Pattern',
      description: 'Deny user messages that contain real API key / bearer token patterns — prevents credential storage in messages table.',
      type: 'regex',
      stage: 'pre',
      config: JSON.stringify({
        pattern: '(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,}|Bearer\\s+[A-Za-z0-9._-]{20,}|AKIA[A-Z0-9]{16})',
        flags: 'i',
        action: 'deny',
      }),
      priority: 99,
      enabled: 1,
    },
    {
      id: 'd1000002-aaaa-4000-8000-000000000002',
      name: 'Input: Database Connection String',
      description: 'Deny user messages leaking a database connection string with embedded credentials.',
      type: 'regex',
      stage: 'pre',
      config: JSON.stringify({
        pattern: '(?:postgres|mysql|mongodb|redis|amqp)://[^:@\\s]+:[^@\\s]+@',
        flags: 'i',
        action: 'deny',
      }),
      priority: 99,
      enabled: 1,
    },
    {
      id: 'd2000001-aaaa-4000-8000-000000000001',
      name: 'SSRF: Localhost / Loopback Probe',
      description: 'Deny prompts that ask the AI to fetch or contact localhost, 127.x.x.x, or other loopback addresses.',
      type: 'regex',
      stage: 'pre',
      config: JSON.stringify({
        pattern: '(?:fetch|call|curl|request|connect|open|ping|probe|scan|access|visit|hit|send.{0,20}to).{0,60}(?:localhost|127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|\\[::1\\]|0\\.0\\.0\\.0)',
        flags: 'i',
        action: 'deny',
      }),
      priority: 97,
      enabled: 1,
    },
    {
      id: 'd2000002-aaaa-4000-8000-000000000002',
      name: 'SSRF: RFC-1918 Private Network Probe',
      description: 'Deny prompts targeting private IPv4 ranges (10.x, 172.16–31.x, 192.168.x) to prevent internal network scanning.',
      type: 'regex',
      stage: 'pre',
      config: JSON.stringify({
        pattern: '(?:fetch|call|curl|request|connect|open|ping|probe|scan|access|visit|hit|send.{0,20}to).{0,60}(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3})',
        flags: 'i',
        action: 'deny',
      }),
      priority: 97,
      enabled: 1,
    },
  ];

  for (const g of guardrails) {
    insert.run({ ...g, now });
  }
}
