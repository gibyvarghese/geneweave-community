// SPDX-License-Identifier: MIT
/**
 * Integration test — the weaveNotes Phase 6 database SERVICE against a real on-disk
 * SQLite database (m46 note_databases/note_db_rows), with a deterministic fake LLM.
 * Proves: typed view rendering, relation + rollup computation across two databases,
 * AI column auto-fill (value coerced + citations stored under _citations), and
 * owner-scoping + bad-property handling.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from '@weaveintel/core';
import { SQLiteAdapter } from './db-sqlite.js';
import { createNoteDbService } from './note-db-sql.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

function tmpDb(): string { return join(tmpdir(), `gw-notedb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function makeDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); return db;
}
async function makeDatabase(db: SQLiteAdapter, owner: string, name: string, columns: unknown[], viewType = 'table'): Promise<string> {
  const id = newUUIDv7();
  await db.createNoteDatabase({ id, owner_user_id: owner, tenant_id: null, name, source: 'generic', view_type: viewType, columns_json: JSON.stringify(columns) });
  return id;
}
async function addRow(db: SQLiteAdapter, databaseId: string, fields: Record<string, unknown>): Promise<string> {
  const id = newUUIDv7();
  await db.createNoteDbRow({ id, database_id: databaseId, fields_json: JSON.stringify(fields) });
  return id;
}

// Fake LLM: echoes a value+citation for every rowId it sees in the prompt.
const fakeGen: NoteAiGenerate = async ({ user }) => {
  const ids = [...user.matchAll(/rowId: ([0-9a-fA-F-]{8,})/g)].map((m) => m[1]);
  return JSON.stringify(ids.map((id) => ({ rowId: id, value: `Auto for ${String(id).slice(0, 4)}`, citations: ['row'] })));
};

describe('note databases — typed views', () => {
  it('renders schema + rows for a typed table', async () => {
    const db = await makeDb();
    const svc = createNoteDbService(db, { generate: fakeGen });
    const dbId = await makeDatabase(db, 'alice', 'Companies', [
      { key: 'name', name: 'Name', type: 'text' },
      { key: 'tier', name: 'Tier', type: 'select', options: ['Enterprise', 'SMB'] },
      { key: 'employees', name: 'Employees', type: 'number' },
    ], 'gallery');
    await addRow(db, dbId, { name: 'Acme', tier: 'Enterprise', employees: 500 });
    await addRow(db, dbId, { name: 'Globex', tier: 'SMB', employees: '20' });

    const v = await svc.view(dbId, 'alice');
    expect(v!.viewType).toBe('gallery');
    expect(v!.schema.map((p) => p.key)).toEqual(['name', 'tier', 'employees']);
    expect(v!.rows.length).toBe(2);
    expect(v!.rows.find((r) => r.fields['name'] === 'Acme')!.fields['employees']).toBe(500);
  });

  it('owner-scoped: another user cannot view the database', async () => {
    const db = await makeDb();
    const svc = createNoteDbService(db, { generate: fakeGen });
    const dbId = await makeDatabase(db, 'alice', 'Private', [{ key: 'name', name: 'Name', type: 'text' }]);
    expect(await svc.view(dbId, 'mallory')).toBeNull();
  });
});

describe('note databases — relations + rollups', () => {
  it('computes a percent_checked rollup across a relation to another database', async () => {
    const db = await makeDb();
    const svc = createNoteDbService(db, { generate: fakeGen });
    // Tasks database.
    const tasksDb = await makeDatabase(db, 'alice', 'Tasks', [
      { key: 'title', name: 'Title', type: 'text' },
      { key: 'complete', name: 'Done', type: 'checkbox' },
    ]);
    const t1 = await addRow(db, tasksDb, { title: 'A', complete: true });
    const t2 = await addRow(db, tasksDb, { title: 'B', complete: false });
    const t3 = await addRow(db, tasksDb, { title: 'C', complete: true });
    // Projects database with a relation → Tasks and a rollup over `complete`.
    const projDb = await makeDatabase(db, 'alice', 'Projects', [
      { key: 'name', name: 'Name', type: 'text' },
      { key: 'tasks', name: 'Tasks', type: 'relation', relationDatabaseId: tasksDb },
      { key: 'progress', name: 'Progress', type: 'rollup', rollup: { relationKey: 'tasks', targetKey: 'complete', fn: 'percent_checked' } },
    ]);
    await addRow(db, projDb, { name: 'Launch', tasks: [t1, t2, t3] });

    const v = await svc.view(projDb, 'alice');
    expect(v!.rows[0]!.rollups['progress']).toBe(67); // 2 of 3 complete
  });
});

describe('note databases — AI auto-fill', () => {
  it('fills a column from row context, coercing the value + storing citations', async () => {
    const db = await makeDb();
    const svc = createNoteDbService(db, { generate: fakeGen });
    const dbId = await makeDatabase(db, 'alice', 'Notes', [
      { key: 'name', name: 'Name', type: 'text' },
      { key: 'summary', name: 'Summary', type: 'text' },
    ]);
    const r1 = await addRow(db, dbId, { name: 'Quantum primer' });
    const r2 = await addRow(db, dbId, { name: 'Pasta guide' });

    const res = await svc.autofillColumn({ databaseId: dbId, userId: 'alice', propertyKey: 'summary' });
    expect(res.ok).toBe(true);
    expect(res.filled!.length).toBe(2);
    // The value was written + a citation recorded under _citations.
    const v = await svc.view(dbId, 'alice');
    const row1 = v!.rows.find((r) => r.id === r1)!;
    expect(String(row1.fields['summary'])).toContain('Auto for');
    expect(row1.citations['summary']).toEqual([{ label: 'this row' }]);
    void r2;
  });

  it('refuses to auto-fill a rollup/relation column + an unknown property', async () => {
    const db = await makeDb();
    const svc = createNoteDbService(db, { generate: fakeGen });
    const dbId = await makeDatabase(db, 'alice', 'X', [
      { key: 'name', name: 'Name', type: 'text' },
      { key: 'rel', name: 'Rel', type: 'relation', relationDatabaseId: 'other' },
    ]);
    await addRow(db, dbId, { name: 'a' });
    expect((await svc.autofillColumn({ databaseId: dbId, userId: 'alice', propertyKey: 'rel' })).ok).toBe(false);
    expect((await svc.autofillColumn({ databaseId: dbId, userId: 'alice', propertyKey: 'nope' })).code).toBe(400);
    // Owner gate: a stranger cannot auto-fill.
    expect((await svc.autofillColumn({ databaseId: dbId, userId: 'mallory', propertyKey: 'name' })).code).toBe(404);
  });

  it('agentAutofill returns a compact filled count', async () => {
    const db = await makeDb();
    const svc = createNoteDbService(db, { generate: fakeGen });
    const dbId = await makeDatabase(db, 'alice', 'Y', [{ key: 'name', name: 'Name', type: 'text' }, { key: 'note', name: 'Note', type: 'text' }]);
    await addRow(db, dbId, { name: 'one' });
    const r = await svc.agentAutofill({ userId: 'alice', databaseId: dbId, propertyKey: 'note' });
    expect(r).toEqual({ ok: true, filled: 1 });
  });
});
