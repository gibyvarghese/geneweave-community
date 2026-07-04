// SPDX-License-Identifier: MIT
/**
 * Unit tests for the PII-safe web-query helper used by database auto-fill (weaveNotes Phase 2).
 * Personal data in a row must never leave to an external search engine.
 */
import { describe, it, expect } from 'vitest';
import { piiSafeWebQuery } from './note-db-sql.js';

describe('piiSafeWebQuery', () => {
  it('passes a clean query through unchanged', () => {
    const r = piiSafeWebQuery('Acme Robotics industry sector');
    expect(r.hadPii).toBe(false);
    expect(r.usable).toBe(true);
    expect(r.query).toBe('Acme Robotics industry sector');
  });

  it('scrubs an email but keeps the useful terms', () => {
    const r = piiSafeWebQuery('alice@acme.com company headquarters');
    expect(r.hadPii).toBe(true);
    expect(r.query).not.toMatch(/@|alice/);
    expect(r.query).toContain('company headquarters');
    expect(r.usable).toBe(true);
  });

  it('scrubs phone + SSN + card numbers', () => {
    expect(piiSafeWebQuery('call 555-123-4567 about sales').query).not.toMatch(/555-123-4567/);
    expect(piiSafeWebQuery('ssn 123-45-6789 record').query).not.toMatch(/123-45-6789/);
    expect(piiSafeWebQuery('card 4111 1111 1111 1111 charge').query).not.toMatch(/4111/);
  });

  it('marks a query as NOT usable when redaction leaves nothing meaningful', () => {
    const r = piiSafeWebQuery('bob@example.com');
    expect(r.hadPii).toBe(true);
    expect(r.usable).toBe(false);    // only PII → nothing safe to search with
  });

  it('never throws on junk/empty input', () => {
    expect(piiSafeWebQuery('').usable).toBe(false);
    expect(piiSafeWebQuery(undefined as unknown as string).hadPii).toBe(false);
  });
});
