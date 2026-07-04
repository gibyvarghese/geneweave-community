/**
 * geneWeave SQL adapter for the `@weaveintel/notes` {@link NoteRepository} PORT
 * (weaveNotes Phase 0).
 *
 * This is the DRIVEN-port adapter in the hexagonal/ports-&-adapters sense (the
 * repository pattern IS the storage adapter, per the mid-2026 architecture
 * consensus): it implements the one notes interface by delegating to geneWeave's
 * existing `DatabaseAdapter` note methods. It is a deliberately THIN pass-through
 * — Phase 0 introduces the seam with ZERO behaviour change, so the routes can be
 * refactored onto the port and a future CRDT co-editing relay can replace this
 * adapter without touching the routes. It passes the SAME `noteRepositoryContract`
 * the in-memory reference adapter passes.
 */
import type {
  NoteRepository,
  Note,
  NoteLink,
  NoteDatabase,
  NoteDbRow,
  NoteListFilter,
  CreateNoteInput,
  UpdateNotePatch,
  CreateNoteLinkInput,
  CreateNoteDatabaseInput,
  CreateNoteDbRowInput,
  NoteLinkTargetKind,
} from '@weaveintel/notes';
import type { DatabaseAdapter } from './db-types.js';

/** The notes subset of the `DatabaseAdapter` this adapter needs. */
type NotesDb = Pick<DatabaseAdapter,
  'listNotes' | 'listNoteTemplates' | 'getNote' | 'createNote' | 'updateNote' | 'archiveNote' | 'restoreNote' | 'deleteNote' |
  'listNoteLinks' | 'listNoteBacklinks' | 'createNoteLink' | 'deleteNoteLink' |
  'listNoteDatabases' | 'getNoteDatabase' | 'createNoteDatabase' | 'deleteNoteDatabase' |
  'listNoteDbRows' | 'createNoteDbRow' | 'updateNoteDbRow' | 'deleteNoteDbRow'>;

/** Wrap a geneWeave `DatabaseAdapter` as a {@link NoteRepository}. */
export function createSqlNoteRepository(db: NotesDb): NoteRepository {
  return {
    listNotes: (userId: string, filter?: NoteListFilter) => db.listNotes(userId, filter) as Promise<Note[]>,
    listTemplates: () => db.listNoteTemplates() as Promise<Note[]>,
    getNote: (id: string, userId: string) => db.getNote(id, userId) as Promise<Note | null>,
    createNote: (input: CreateNoteInput) => db.createNote(input),
    updateNote: (id: string, userId: string, patch: UpdateNotePatch) => db.updateNote(id, userId, patch),
    archiveNote: (id: string, userId: string, at: string) => db.archiveNote(id, userId, at),
    restoreNote: (id: string, userId: string) => db.restoreNote(id, userId),
    deleteNote: (id: string, userId: string) => db.deleteNote(id, userId),

    listLinks: (noteId: string) => db.listNoteLinks(noteId) as Promise<NoteLink[]>,
    listBacklinks: (kind: NoteLinkTargetKind, targetId: string) => db.listNoteBacklinks(kind, targetId) as Promise<NoteLink[]>,
    createLink: (input: CreateNoteLinkInput) => db.createNoteLink(input),
    deleteLink: (id: string, noteId: string) => db.deleteNoteLink(id, noteId),

    listDatabases: (userId: string) => db.listNoteDatabases(userId) as Promise<NoteDatabase[]>,
    getDatabase: (id: string, userId: string) => db.getNoteDatabase(id, userId) as Promise<NoteDatabase | null>,
    createDatabase: (input: CreateNoteDatabaseInput) => db.createNoteDatabase(input),
    deleteDatabase: (id: string, userId: string) => db.deleteNoteDatabase(id, userId),

    listRows: (databaseId: string) => db.listNoteDbRows(databaseId) as Promise<NoteDbRow[]>,
    createRow: (input: CreateNoteDbRowInput) => db.createNoteDbRow(input),
    updateRow: (id: string, databaseId: string, fieldsJson: string) => db.updateNoteDbRow(id, databaseId, fieldsJson),
    deleteRow: (id: string, databaseId: string) => db.deleteNoteDbRow(id, databaseId),
  };
}
