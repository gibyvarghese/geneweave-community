// SPDX-License-Identifier: MIT
/**
 * Generate the Postgres schema for the geneWeave app database from the *live* SQLite schema.
 *
 * This is the review's recommended approach — don't hand-translate 258 tables; reflect the real,
 * fully-migrated SQLite schema (SCHEMA_SQL + every migration) and emit an equivalent Postgres DDL.
 * The output (`src/db-postgres-schema.ts`) is a static committed file used by the Postgres adapter's
 * `initialize()`. Re-run this whenever the SQLite schema changes:
 *
 *   npx tsx scripts/gen-postgres-schema.ts
 *
 * The type/DEFAULT mapping is chosen so a row read from Postgres is byte-identical to the same row
 * read from SQLite (see db-postgres.ts): booleans stay INTEGER (0/1), counts stay INTEGER, reals →
 * DOUBLE PRECISION, timestamps stay TEXT in SQLite's format. Text ordering parity (COLLATE "C") is
 * applied at query time in the adapter, not in the schema.
 */
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteAdapter } from '../src/db-sqlite.js';

const NOW_TEXT = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')`;
const NOW_MS_TEXT = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function mapType(sqliteType: string): string {
  const t = (sqliteType || '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'DOUBLE PRECISION';
  if (t.includes('BLOB')) return 'BYTEA';
  if (t.includes('NUMERIC') || t.includes('DECIMAL')) return 'NUMERIC';
  return 'TEXT';
}

function mapDefault(dflt: string): string {
  const d = dflt.trim();
  if (/datetime\('now'\)/i.test(d) || /^CURRENT_TIMESTAMP$/i.test(d)) return NOW_TEXT;
  if (/strftime\(\s*'%Y-%m-%dT%H:%M:%fZ'/i.test(d)) return NOW_MS_TEXT;
  if (/strftime\(/i.test(d)) return NOW_TEXT;
  if (/unixepoch\('now'\)/i.test(d)) return `extract(epoch from now())::bigint`;
  if (/lower\(hex\(randomblob/i.test(d)) return `md5(random()::text)`;
  return d; // numeric / quoted-string literal — valid as-is in Postgres
}

interface Col { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
interface Fk { table: string; from: string; to: string; on_delete: string }

function generate(sqlitePath: string): string {
  const db = new Database(sqlitePath, { readonly: true });
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const cols: Record<string, Col[]> = {};
  const fks: Record<string, Fk[]> = {};
  for (const t of tables) {
    cols[t] = db.prepare(`PRAGMA table_info("${t}")`).all() as Col[];
    fks[t] = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as Fk[];
  }

  // Indexes (incl. UNIQUE constraints) — table_info doesn't expose UNIQUE, so reflect them here.
  // Named indexes (origin 'c') come with their CREATE sql in sqlite_master (preserves partial WHERE
  // and expressions); inline UNIQUE constraints (origin 'u') are auto-indexes with no sql, so we
  // synthesise a CREATE UNIQUE INDEX from their columns.
  interface IdxMeta { name: string; unique: number; origin: string; partial: number }
  interface IdxCol { name: string | null }
  const indexDdls: string[] = [];
  const masterSql = new Map<string, string>();
  for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as { name: string; sql: string }[]) {
    masterSql.set(r.name, r.sql);
  }
  for (const t of tables) {
    for (const idx of db.prepare(`PRAGMA index_list("${t}")`).all() as IdxMeta[]) {
      if (idx.origin === 'pk') continue; // PK already emitted inline
      const cols2 = (db.prepare(`PRAGMA index_info("${idx.name}")`).all() as IdxCol[]);
      if (cols2.some((c) => c.name === null)) continue; // expression/collation index — skip (rare)
      const colList = cols2.map((c) => `"${c.name}"`).join(', ');
      if (idx.origin === 'c' && masterSql.has(idx.name)) {
        // Translate the real CREATE INDEX (keeps UNIQUE + partial WHERE). SQLite ≈ Postgres syntax.
        let sql = masterSql.get(idx.name)!.trim();
        sql = sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_m, u) => `CREATE ${u ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS `);
        sql = sql.replace(/datetime\('now'\)/gi, NOW_TEXT);
        indexDdls.push(sql.endsWith(';') ? sql : `${sql};`);
      } else {
        const name = `uq_${t}_${cols2.map((c) => c.name).join('_')}`.slice(0, 60);
        indexDdls.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "${t}" (${colList});`);
      }
    }
  }
  db.close();

  // Topological order so REFERENCES targets are created first (ignore back-edges to break cycles).
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (t: string): void => {
    if (done.has(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const fk of fks[t] ?? []) if (fk.table !== t && tables.includes(fk.table)) visit(fk.table);
    visiting.delete(t); done.add(t); ordered.push(t);
  };
  for (const t of tables) visit(t);

  const parts: string[] = [];
  for (const t of ordered) {
    const lines: string[] = [];
    const pkCols = cols[t]!.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    for (const c of cols[t]!) {
      let line = `  "${c.name}" ${mapType(c.type)}`;
      if (c.notnull) line += ' NOT NULL';
      if (c.dflt_value !== null && c.dflt_value !== undefined) line += ` DEFAULT ${mapDefault(String(c.dflt_value))}`;
      lines.push(line);
    }
    if (pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.map((c) => `"${c}"`).join(', ')})`);
    for (const fk of fks[t] ?? []) {
      if (!tables.includes(fk.table)) continue;
      const onDel = fk.on_delete && fk.on_delete !== 'NO ACTION' ? ` ON DELETE ${fk.on_delete}` : '';
      lines.push(`  FOREIGN KEY ("${fk.from}") REFERENCES "${fk.table}" ("${fk.to}")${onDel}`);
    }
    parts.push(`CREATE TABLE IF NOT EXISTS "${t}" (\n${lines.join(',\n')}\n);`);
  }
  return `${parts.join('\n\n')}\n\n-- Indexes & UNIQUE constraints\n${indexDdls.join('\n')}`;
}

async function main(): Promise<void> {
  const p = join(mkdtempSync(join(tmpdir(), 'gw-schemagen-')), 'schema.db');
  const sq = new SQLiteAdapter(p);
  await sq.initialize();
  await sq.close();
  const ddl = generate(p);
  const tableCount = (ddl.match(/CREATE TABLE/g) ?? []).length;
  const out = `// SPDX-License-Identifier: MIT
// AUTO-GENERATED by scripts/gen-postgres-schema.ts from the live SQLite schema. DO NOT EDIT BY HAND.
// Regenerate with: npx tsx scripts/gen-postgres-schema.ts
// ${tableCount} tables, mirroring the fully-migrated SQLite schema for the Postgres adapter.

/** The complete geneWeave app schema in Postgres DDL, at type/row parity with SQLite. */
export const POSTGRES_FULL_SCHEMA = \`
${ddl.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}
\`;
`;
  writeFileSync(join(import.meta.dirname, '../src/db-postgres-schema.ts'), out);
  // eslint-disable-next-line no-console
  console.log(`Wrote src/db-postgres-schema.ts — ${tableCount} tables.`);
}

void main();
