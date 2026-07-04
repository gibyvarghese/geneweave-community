import type BetterSqlite3 from 'better-sqlite3';

/**
 * M38 — Extended PII redaction patterns for episodic memory
 *
 * Adds three redact patterns to the m37 "Episodic PII Redaction" governance rule
 * (mgov-0007) that were revealed as gaps by Group 31 of the memory stress test:
 *
 * 1. Database/service URI credentials  (postgresql://user:pass@host, redis://:pass@host)
 *    The m37 inline-credential pattern covers `password=VALUE` style but not
 *    passwords embedded in connection-string URIs.
 *
 * 2. JWT/HMAC signing secret key values in variable-name form
 *    Patterns like `jwt_secret_key_ABCDEF...` are secret values themselves
 *    rather than `key=value` assignments.
 *
 * 3. Broad social-security-number pattern (catches 9xx numbers too)
 *    The strict m37 SSN regex deliberately excluded 9xx numbers (invalid ISS
 *    range) but 9xx-xx-xxxx still appears in fraudulent/test data and should
 *    be redacted.  The extra pattern `\b\d{3}-\d{2}-\d{4}\b` is added as a
 *    fallback to the existing strict pattern.
 */
export function applyM38ExtendedPiiPatterns(db: BetterSqlite3.Database): void {
  // Read current redact_patterns for mgov-0007
  const row = db.prepare(
    `SELECT redact_patterns FROM memory_governance WHERE id = 'mgov-0000-0000-4000-8000-000000000007'`,
  ).get() as { redact_patterns: string } | undefined;

  if (!row) {
    // Rule missing — nothing to patch (m37 not applied yet)
    return;
  }

  let patterns: string[] = [];
  try { patterns = JSON.parse(row.redact_patterns) as string[]; } catch { /* leave empty */ }

  const additions: string[] = [
    // Database/service connection-string credentials
    // Matches: scheme://user:PASSWORD@host  (captures the password segment)
    '(?:postgresql|postgres|mysql|mongodb|redis|amqp|jdbc|smtp)s?://[^:/@\\s]+:[^@\\s]+@',

    // JWT / HMAC signing key values expressed as a named token
    // Matches: jwt_secret_key_XXXX, signing_secret_XXXX, hmac_secret_XXXX
    '(?:jwt[_-]?(?:secret[_-]?)?key|signing[_-]?(?:secret|key)|hmac[_-]?secret)[_-]?\\w{8,}',

    // Broad SSN fallback — catches 9xx-xx-xxxx numbers not matched by the strict m37 pattern
    '\\b\\d{3}-\\d{2}-\\d{4}\\b',
  ];

  // Only add patterns not already present (idempotent)
  for (const p of additions) {
    if (!patterns.includes(p)) {
      patterns.push(p);
    }
  }

  db.prepare(`
    UPDATE memory_governance
    SET redact_patterns = ?,
        updated_at = datetime('now')
    WHERE id = 'mgov-0000-0000-4000-8000-000000000007'
  `).run(JSON.stringify(patterns));
}
