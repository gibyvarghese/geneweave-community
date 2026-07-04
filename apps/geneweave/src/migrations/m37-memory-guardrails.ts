import type BetterSqlite3 from 'better-sqlite3';

/**
 * M37 — Memory governance guardrails
 *
 * Adds two governance rules that were missing from the initial memory seeding:
 *
 * 1. "Episodic PII Redaction" (types: ['episodic'])
 *    Redact-only rule — episodic turn logs must never be blocked entirely, but
 *    SSNs, credit-card numbers, JWT tokens, phone numbers, emails, and inline
 *    credential patterns must be scrubbed before the raw turn is persisted.
 *
 * 2. "Entity PII Block" (types: ['entity'])
 *    Block rule — entity facts that contain SSNs or credit-card numbers are
 *    not stored at all (complements the existing "No Secrets in Entity Memory"
 *    rule which already blocks api-key / password / bearer-token patterns).
 *
 * Both rules are global (tenant_id = NULL) and enabled by default.
 */
export function applyM37MemoryGuardrails(db: BetterSqlite3.Database): void {
  // ── 0. Fix pre-existing bad regex in mgov-0002 (m35 used (?i) prefix which
  //        is invalid in JavaScript — strip it so the regex compiles) ─────────
  db.prepare(`
    UPDATE memory_governance
    SET redact_patterns = ?,
        updated_at = datetime('now')
    WHERE id = 'mgov-0000-0000-4000-8000-000000000002'
  `).run(
    JSON.stringify([
      '(?:password|passwd|secret|token|api[_-]?key)\\s*[=:]\\s*\\S+',
      '(?:eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})',
    ]),
  );

  // ── 1. Episodic PII Redaction rule ────────────────────────────────────────
  // Redact patterns (NOT block patterns) so that conversation turns are always
  // captured but sensitive tokens are replaced with [REDACTED].
  db.prepare(`
    INSERT OR IGNORE INTO memory_governance (
      id, name, description, memory_types,
      block_patterns, redact_patterns,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(
    'mgov-0000-0000-4000-8000-000000000007',
    'Episodic PII Redaction',
    'Redact SSNs, credit-card numbers, JWTs, phone numbers, emails and inline credentials from episodic conversation turns before persistence.',
    JSON.stringify(['episodic']),
    JSON.stringify([]),  // no blocking — episodic turns must always be saved
    JSON.stringify([
      // US Social Security Number  (e.g. 123-45-6789)
      '\\b(?!000|666|9\\d{2})\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b',
      // Major credit-card numbers (Visa, MC, Amex, Discover)
      '\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\\b',
      // JWT tokens  (three base64url segments separated by dots)
      'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
      // Inline credential assignments  (password=..., api_key=..., secret=...)
      '(?:password|passwd|api[_-]?key|secret(?:[_-]?key)?|access[_-]?token)\\s*[=:]\\s*\\S+',
      // E-mail addresses
      '[\\w.+%-]+@[\\w-]+\\.[A-Za-z]{2,}',
      // US phone numbers  (e.g. 415-555-0100, (415) 555-0100, +14155550100)
      '(?:\\+?1[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b',
    ]),
  );

  // ── 2. Entity PII Block rule ───────────────────────────────────────────────
  // Complement to the existing "No Secrets in Entity Memory" rule. That rule
  // already blocks api_key / password / bearer-token patterns. This rule adds
  // SSN and credit-card patterns so structured entity facts never store them.
  db.prepare(`
    INSERT OR IGNORE INTO memory_governance (
      id, name, description, memory_types,
      block_patterns, redact_patterns,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(
    'mgov-0000-0000-4000-8000-000000000008',
    'Entity PII Block',
    'Block entity facts that contain SSNs or credit-card numbers from being persisted as structured memory.',
    JSON.stringify(['entity']),
    JSON.stringify([
      // US Social Security Number
      '\\b(?!000|666|9\\d{2})\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b',
      // Major credit-card numbers
      '\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\\b',
    ]),
    JSON.stringify([]),  // block-only for entity — no partial redaction of structured facts
  );
}
