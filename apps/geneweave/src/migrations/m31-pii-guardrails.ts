import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration M31 — PII pre-execution deny guardrails (P4.1 / C1.2 findings)
 *
 * Adds input-side deny guardrails for SSN and credit card number patterns so
 * sensitive personal data is never stored in the messages table.
 * Idempotent via INSERT OR IGNORE.
 */
export function applyM31PiiGuardrails(db: BetterSqlite3.Database): void {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO guardrails
      (id, name, description, type, stage, config, priority, enabled, created_at, updated_at)
    VALUES (@id, @name, @description, @type, @stage, @config, @priority, @enabled, @now, @now)
  `);

  const rows = [
    {
      id: 'd3000001-aaaa-4000-8000-000000000001',
      name: 'Input PII: SSN Pattern',
      description: 'Deny user messages containing US Social Security Number patterns to prevent PII storage.',
      type: 'regex', stage: 'pre',
      config: JSON.stringify({
        pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
        flags: 'i',
        action: 'deny',
      }),
      priority: 98, enabled: 1,
    },
    {
      id: 'd3000002-aaaa-4000-8000-000000000002',
      name: 'Input PII: Credit Card Number',
      description: 'Deny user messages containing 13–16-digit credit card number patterns to prevent PCI-DSS scope creep.',
      type: 'regex', stage: 'pre',
      config: JSON.stringify({
        pattern: '\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\\d{3})\\d{11})\\b',
        flags: 'i',
        action: 'deny',
      }),
      priority: 98, enabled: 1,
    },
  ];

  for (const r of rows) insert.run({ ...r, now });
}
