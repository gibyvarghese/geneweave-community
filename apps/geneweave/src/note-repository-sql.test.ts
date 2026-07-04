/**
 * Conformance test — geneWeave's SQL NoteRepository adapter (weaveNotes Phase 0).
 * Runs the SAME `noteRepositoryContract` the in-memory reference adapter passes,
 * proving the refactor to the port did not change note behaviour. Each test gets a
 * fresh on-disk SQLite database with the real m46 notes schema.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { noteRepositoryContract, type NoteRepository } from '@weaveintel/notes';
import { SQLiteAdapter } from './db-sqlite.js';
import { createSqlNoteRepository } from './note-repository-sql.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-notes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function makeRepo(): Promise<NoteRepository> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  return createSqlNoteRepository(db);
}

noteRepositoryContract(makeRepo, { describe, it, beforeEach, expect } as never);

describe('SQL NoteRepository — geneWeave specifics', () => {
  it('lists the m46-seeded system templates via listTemplates', async () => {
    const repo = await makeRepo();
    const templates = await repo.listTemplates();
    // The migration seeds Meeting Notes / Weekly Review / Research Note.
    expect(templates.some((t) => t.template_key === 'meeting')).toBe(true);
    expect(templates.every((t) => t.is_template === 1)).toBe(true);
  });

  it('a real run-linked note round-trips (the AI-research capture shape)', async () => {
    const repo = await makeRepo();
    await repo.createNote({
      id: 'n-research', owner_user_id: 'alice', tenant_id: 'tA', title: 'Tides research',
      doc_json: JSON.stringify({ type: 'doc', content: [{ type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Verify the lunar-cycle claim' }] }] },
      ] }] }),
    });
    await repo.createLink({ id: 'lnk-1', note_id: 'n-research', target_kind: 'run', target_id: 'run-123' });
    expect((await repo.getNote('n-research', 'alice'))?.title).toBe('Tides research');
    expect((await repo.listBacklinks('run', 'run-123')).map((l) => l.note_id)).toContain('n-research');
  });
});
