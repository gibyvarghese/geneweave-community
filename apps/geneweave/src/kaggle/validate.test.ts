/**
 * ./index.js — pure-TS validator tests
 */
import { describe, it, expect } from 'vitest';
import { validateSubmissionCsv } from './validate.js';

const HEADERS = ['PassengerId', 'Survived'];
const VALID = `PassengerId,Survived\n1,0\n2,1\n3,0\n`;

describe('validateSubmissionCsv', () => {
  it('accepts a well-formed submission', () => {
    const r = validateSubmissionCsv({ csvContent: VALID, expectedHeaders: HEADERS });
    expect(r.valid).toBe(true);
    expect(r.rows).toBe(3);
    expect(r.headers).toEqual(HEADERS);
    expect(r.errors).toEqual([]);
  });

  it('rejects empty content', () => {
    const r = validateSubmissionCsv({ csvContent: '', expectedHeaders: HEADERS });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/empty/);
  });

  it('flags header mismatch', () => {
    const bad = `Id,Outcome\n1,0\n`;
    const r = validateSubmissionCsv({ csvContent: bad, expectedHeaders: HEADERS });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('header[0]'))).toBe(true);
  });

  it('flags row-count mismatch when expectedRowCount supplied', () => {
    const r = validateSubmissionCsv({ csvContent: VALID, expectedHeaders: HEADERS, expectedRowCount: 5 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /row count mismatch/.test(e))).toBe(true);
  });

  it('detects duplicate ids', () => {
    const dup = `PassengerId,Survived\n1,0\n2,1\n2,0\n`;
    const r = validateSubmissionCsv({ csvContent: dup, expectedHeaders: HEADERS, idColumn: 'PassengerId' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /duplicate ids/.test(e))).toBe(true);
  });

  it('detects missing and extra ids', () => {
    const r = validateSubmissionCsv({
      csvContent: VALID,
      expectedHeaders: HEADERS,
      idColumn: 'PassengerId',
      expectedIds: ['1', '2', '4'],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /missing 1 expected id/.test(e))).toBe(true);
    expect(r.errors.some((e) => /unexpected 1 id/.test(e))).toBe(true);
  });

  it('reports unknown idColumn', () => {
    const r = validateSubmissionCsv({ csvContent: VALID, expectedHeaders: HEADERS, idColumn: 'Nope' });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/idColumn "Nope"/);
  });
});
