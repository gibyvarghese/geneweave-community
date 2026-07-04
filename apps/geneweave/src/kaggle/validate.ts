/**
 * ./index.js — pure-TS submission validator
 *
 * In-process pre-checks for a Kaggle submission CSV. Runs locally with no
 * subprocess or container; meant as a cheap fail-fast guard before paying for
 * Kaggle API rate limits or container compute. Used by the
 * `kaggle.local.validate_submission` MCP tool.
 */

export interface ValidateSubmissionInput {
  /** Raw CSV text. */
  csvContent: string;
  /** Headers the file MUST contain in this exact order. */
  expectedHeaders: string[];
  /** If set, the file must have exactly this many data rows (excluding header). */
  expectedRowCount?: number;
  /** Column name expected to hold the row identifier. Used for duplicate / coverage checks. */
  idColumn?: string;
  /**
   * If set, every value in `idColumn` must appear in this allow-list AND every
   * id in the allow-list must appear at least once. Order does not matter.
   */
  expectedIds?: string[];
  /** Optional cap on accepted CSV byte length. Default 100 MiB. */
  maxBytes?: number;
}

export interface ValidateSubmissionResult {
  valid: boolean;
  rows: number;
  headers: string[];
  /** Hard violations that must block submission. */
  errors: string[];
  /** Soft observations (e.g. extra columns, trailing whitespace). */
  warnings: string[];
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function parseCsvLine(line: string): string[] {
  // Minimal RFC-4180-ish split: handles double-quoted cells with escaped quotes.
  const out: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cell);
        cell = '';
      } else if (ch === '"' && cell === '') {
        inQuotes = true;
      } else {
        cell += ch;
      }
    }
  }
  out.push(cell);
  return out;
}

export function validateSubmissionCsv(input: ValidateSubmissionInput): ValidateSubmissionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const csv = input.csvContent ?? '';

  if (csv.length === 0) {
    return { valid: false, rows: 0, headers: [], errors: ['empty submission'], warnings };
  }
  if (Buffer.byteLength(csv, 'utf8') > maxBytes) {
    errors.push(`submission exceeds maxBytes (${maxBytes})`);
  }

  // Strip BOM, normalize line endings.
  const text = csv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  // Trim a single trailing empty line if present.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) {
    return { valid: false, rows: 0, headers: [], errors: ['no header row found'], warnings };
  }

  const headers = parseCsvLine(lines[0]!).map((h) => h.trim());
  const dataLines = lines.slice(1);
  const rowCount = dataLines.length;

  // Header order/value match.
  if (headers.length !== input.expectedHeaders.length) {
    errors.push(`header count mismatch: got ${headers.length}, expected ${input.expectedHeaders.length}`);
  } else {
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] !== input.expectedHeaders[i]) {
        errors.push(`header[${i}] mismatch: got "${headers[i]}", expected "${input.expectedHeaders[i]}"`);
      }
    }
  }

  // Row count.
  if (input.expectedRowCount !== undefined && rowCount !== input.expectedRowCount) {
    errors.push(`row count mismatch: got ${rowCount}, expected ${input.expectedRowCount}`);
  }

  // ID checks.
  if (input.idColumn) {
    const idIdx = headers.indexOf(input.idColumn);
    if (idIdx === -1) {
      errors.push(`idColumn "${input.idColumn}" not found in headers`);
    } else {
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const line of dataLines) {
        const cells = parseCsvLine(line);
        const id = cells[idIdx];
        if (id === undefined || id === '') {
          errors.push('empty id value found');
          continue;
        }
        if (seen.has(id)) {
          dupes.add(id);
        } else {
          seen.add(id);
        }
      }
      if (dupes.size > 0) {
        const sample = Array.from(dupes).slice(0, 5).join(', ');
        errors.push(`duplicate ids: ${sample}${dupes.size > 5 ? ` (+${dupes.size - 5} more)` : ''}`);
      }
      if (input.expectedIds) {
        const expected = new Set(input.expectedIds);
        const missing: string[] = [];
        const extra: string[] = [];
        for (const id of expected) if (!seen.has(id)) missing.push(id);
        for (const id of seen) if (!expected.has(id)) extra.push(id);
        if (missing.length > 0) {
          errors.push(`missing ${missing.length} expected id(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
        }
        if (extra.length > 0) {
          errors.push(`unexpected ${extra.length} id(s): ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? '…' : ''}`);
        }
      }
    }
  }

  // Soft trailing whitespace check.
  for (let i = 0; i < dataLines.length; i++) {
    if (dataLines[i] !== dataLines[i]!.trimEnd()) {
      warnings.push(`row ${i + 1} has trailing whitespace`);
      break; // only report first occurrence
    }
  }

  return {
    valid: errors.length === 0,
    rows: rowCount,
    headers,
    errors,
    warnings,
  };
}
