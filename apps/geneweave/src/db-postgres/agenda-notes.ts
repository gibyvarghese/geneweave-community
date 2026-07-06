// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `IAgendaNotesStore` domain slice of the geneWeave `DatabaseAdapter` (m46) —
 * agenda categories & items, notes, note links, note databases + rows, and flashcards (SM-2/FSRS).
 *
 * Mirrors the SQLite implementation (see `SQLiteAdapter` in `../db-sqlite.ts`) statement-for-statement:
 * same SQL, same column order, same integer-boolean and TEXT-JSON conventions. The only translations
 * are the SQLite→Postgres dialect differences (`?`→`$n` placeholders, `datetime('now')`→`${ctx.now}`,
 * `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`, and `COLLATE "C"` on TEXT orderings to preserve
 * byte-order sort parity). SQLite `.changes > 0` booleans are recovered via `RETURNING`/row count,
 * and multi-statement transactions become sequential awaits.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  AgendaCategoryRow,
  AgendaItemRow,
  AgendaListFilter,
  NoteRow,
  NoteListFilter,
  NoteLinkRow,
  NoteLinkTargetKind,
  NoteDatabaseRow,
  NoteDbRowRow,
  NoteFlashcardRow,
} from '../db-types/adapter-agenda-notes.js';

export function pgAgendaNotesStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ── Agenda categories ──────────────────────────────────────────────────────
    async listAgendaCategories(userId: string): Promise<AgendaCategoryRow[]> {
      const { rows } = await ctx.query(
        `SELECT * FROM agenda_categories
         WHERE user_id = $1 OR user_id IS NULL
         ORDER BY user_id NULLS FIRST, name COLLATE "C" ASC`,
        [userId],
      );
      return rows as unknown as AgendaCategoryRow[];
    },

    async getAgendaCategory(id: string): Promise<AgendaCategoryRow | null> {
      const { rows } = await ctx.query('SELECT * FROM agenda_categories WHERE id = $1', [id]);
      return (rows[0] as AgendaCategoryRow | undefined) ?? null;
    },

    async createAgendaCategory(row: Pick<AgendaCategoryRow, 'id' | 'name'> & {
      tenant_id?: string | null; user_id?: string | null;
      color?: string; icon?: string; template_key?: string | null;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO agenda_categories (id, tenant_id, user_id, name, color, icon, template_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id, row.tenant_id ?? null, row.user_id ?? null, row.name,
          row.color ?? '#7C5CFC', row.icon ?? '◆', row.template_key ?? null,
        ],
      );
    },

    async updateAgendaCategory(id: string, patch: Partial<Pick<AgendaCategoryRow, 'name' | 'color' | 'icon'>>): Promise<void> {
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, val: unknown) => { fields.push(`${col} = $${values.length + 1}`); values.push(val); };
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.color !== undefined) set('color', patch.color);
      if (patch.icon !== undefined) set('icon', patch.icon);
      if (fields.length === 0) return;
      values.push(id);
      await ctx.query(`UPDATE agenda_categories SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
    },

    async deleteAgendaCategory(id: string, userId: string): Promise<void> {
      await ctx.query('DELETE FROM agenda_categories WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    // ── Agenda items ───────────────────────────────────────────────────────────
    async listAgendaItems(userId: string, filter?: AgendaListFilter): Promise<AgendaItemRow[]> {
      const conditions = ['user_id = $1'];
      const params: unknown[] = [userId];
      if (filter?.startAt) { conditions.push(`(start_at >= $${params.length + 1} OR start_at IS NULL)`); params.push(filter.startAt); }
      if (filter?.endAt) {
        // Extend date-only strings to end of day so events on that day are included
        const endBound = /^\d{4}-\d{2}-\d{2}$/.test(filter.endAt) ? `${filter.endAt}T23:59:59` : filter.endAt;
        conditions.push(`(start_at <= $${params.length + 1} OR start_at IS NULL)`);
        params.push(endBound);
      }
      if (filter?.kind) { conditions.push(`kind = $${params.length + 1}`); params.push(filter.kind); }
      if (filter?.status) { conditions.push(`status = $${params.length + 1}`); params.push(filter.status); }
      if (filter?.categoryId) { conditions.push(`category_id = $${params.length + 1}`); params.push(filter.categoryId); }
      if (filter?.search) { conditions.push(`LOWER(title) LIKE $${params.length + 1}`); params.push(`%${filter.search.toLowerCase()}%`); }
      const limit = filter?.limit ?? 50;
      const { rows } = await ctx.query(
        `SELECT * FROM agenda_items WHERE ${conditions.join(' AND ')}
         ORDER BY COALESCE(start_at, created_at) COLLATE "C" ASC LIMIT $${params.length + 1}`,
        [...params, limit],
      );
      return rows as unknown as AgendaItemRow[];
    },

    async findSimilarAgendaItems(userId: string, title: string, dateBucket?: string): Promise<AgendaItemRow[]> {
      const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\b(a|an|the|my|for|at|on|with|and|or|to|in)\b/g, '').trim();
      const tokens = (s: string) => new Set(normalized(s).split(/\s+/).filter(Boolean));
      const jaccard = (a: Set<string>, b: Set<string>) => {
        const inter = [...a].filter(x => b.has(x)).length;
        const union = new Set([...a, ...b]).size;
        return union === 0 ? 0 : inter / union;
      };
      const incomingTokens = tokens(title);
      const windowStart = dateBucket ? `${dateBucket.slice(0, 10)}T00:00:00` : undefined;
      const windowEnd = dateBucket ? `${dateBucket.slice(0, 10)}T23:59:59` : undefined;
      const candidates = await this.listAgendaItems!(userId, {
        startAt: windowStart,
        endAt: windowEnd,
        limit: 100,
      });
      return candidates.filter(item => jaccard(incomingTokens, tokens(item.title)) >= 0.5);
    },

    async getAgendaItem(id: string, userId: string): Promise<AgendaItemRow | null> {
      const { rows } = await ctx.query('SELECT * FROM agenda_items WHERE id = $1 AND user_id = $2', [id, userId]);
      return (rows[0] as AgendaItemRow | undefined) ?? null;
    },

    async createAgendaItem(row: Pick<AgendaItemRow, 'id' | 'user_id' | 'title'> & {
      tenant_id?: string | null; kind?: AgendaItemRow['kind']; category_id?: string | null;
      start_at?: string | null; end_at?: string | null; all_day?: number;
      location?: string | null; description?: string | null; recurrence_rule?: string | null;
      status?: AgendaItemRow['status']; sensitivity?: AgendaItemRow['sensitivity'];
      amount?: string | null; currency?: string | null; provenance?: string | null;
      linked_task_id?: string | null; linked_run_id?: string | null; linked_note_id?: string | null;
      parent_item_id?: string | null;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO agenda_items
           (id, user_id, tenant_id, title, kind, category_id, start_at, end_at, all_day,
            location, description, recurrence_rule, status, sensitivity,
            amount, currency, provenance, linked_task_id, linked_run_id, linked_note_id, parent_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [
          row.id, row.user_id, row.tenant_id ?? null, row.title,
          row.kind ?? 'event', row.category_id ?? null,
          row.start_at ?? null, row.end_at ?? null, row.all_day ?? 0,
          row.location ?? null, row.description ?? null, row.recurrence_rule ?? null,
          row.status ?? 'confirmed', row.sensitivity ?? 'normal',
          row.amount ?? null, row.currency ?? null, row.provenance ?? null,
          row.linked_task_id ?? null, row.linked_run_id ?? null,
          row.linked_note_id ?? null, row.parent_item_id ?? null,
        ],
      );
    },

    async updateAgendaItem(id: string, userId: string, patch: Partial<Pick<AgendaItemRow,
      'title' | 'kind' | 'category_id' | 'start_at' | 'end_at' | 'all_day' |
      'location' | 'description' | 'recurrence_rule' | 'status' | 'sensitivity' |
      'amount' | 'currency' | 'linked_task_id' | 'linked_run_id' | 'linked_note_id'
    >>): Promise<void> {
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, val: unknown) => { fields.push(`${col} = $${values.length + 1}`); values.push(val); };
      if (patch.title !== undefined) set('title', patch.title);
      if (patch.kind !== undefined) set('kind', patch.kind);
      if (patch.category_id !== undefined) set('category_id', patch.category_id);
      if (patch.start_at !== undefined) set('start_at', patch.start_at);
      if (patch.end_at !== undefined) set('end_at', patch.end_at);
      if (patch.all_day !== undefined) set('all_day', patch.all_day);
      if (patch.location !== undefined) set('location', patch.location);
      if (patch.description !== undefined) set('description', patch.description);
      if (patch.recurrence_rule !== undefined) set('recurrence_rule', patch.recurrence_rule);
      if (patch.status !== undefined) set('status', patch.status);
      if (patch.sensitivity !== undefined) set('sensitivity', patch.sensitivity);
      if (patch.amount !== undefined) set('amount', patch.amount);
      if (patch.currency !== undefined) set('currency', patch.currency);
      if (patch.linked_task_id !== undefined) set('linked_task_id', patch.linked_task_id);
      if (patch.linked_run_id !== undefined) set('linked_run_id', patch.linked_run_id);
      if (patch.linked_note_id !== undefined) set('linked_note_id', patch.linked_note_id);
      if (fields.length === 0) return;
      fields.push(`updated_at = ${ctx.now}`);
      values.push(id, userId);
      await ctx.query(`UPDATE agenda_items SET ${fields.join(', ')} WHERE id = $${values.length - 1} AND user_id = $${values.length}`, values);
    },

    async deleteAgendaItem(id: string, userId: string): Promise<boolean> {
      const { rows } = await ctx.query('DELETE FROM agenda_items WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
      return rows.length > 0;
    },

    // ── Notes ──────────────────────────────────────────────────────────────────
    async listNotes(userId: string, filter?: NoteListFilter): Promise<NoteRow[]> {
      const conditions = ['owner_user_id = $1', 'is_template = 0'];
      const params: unknown[] = [userId];
      if (filter?.parentNoteId !== undefined) {
        if (filter.parentNoteId === null) {
          conditions.push('parent_note_id IS NULL');
        } else {
          conditions.push(`parent_note_id = $${params.length + 1}`);
          params.push(filter.parentNoteId);
        }
      }
      if (filter?.favorite) { conditions.push('favorite = 1'); }
      // weaveNotes Phase 6: by default show only ACTIVE notes; `archived` shows only the trash.
      conditions.push(filter?.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
      if (filter?.search) {
        conditions.push(`(title LIKE $${params.length + 1} OR doc_json LIKE $${params.length + 2})`);
        const q = `%${filter.search}%`;
        params.push(q, q);
      }
      const limit = filter?.limit ?? 100;
      const { rows } = await ctx.query(
        `SELECT id, owner_user_id, tenant_id, title, icon, cover, parent_note_id,
                sensitivity, is_template, template_key, favorite,
                page_theme, freeform_mode, cover_image_artifact_id, archived_at, created_at, updated_at
         FROM notes WHERE ${conditions.join(' AND ')}
         ORDER BY favorite DESC, updated_at COLLATE "C" DESC LIMIT $${params.length + 1}`,
        [...params, limit],
      );
      return rows as unknown as NoteRow[];
    },

    async listNoteTemplates(): Promise<NoteRow[]> {
      const { rows } = await ctx.query('SELECT * FROM notes WHERE is_template = 1 ORDER BY title COLLATE "C" ASC', []);
      return rows as unknown as NoteRow[];
    },

    async getNote(id: string, userId: string): Promise<NoteRow | null> {
      const { rows } = await ctx.query(
        `SELECT * FROM notes WHERE id = $1 AND (owner_user_id = $2 OR owner_user_id = '_system')`,
        [id, userId],
      );
      return (rows[0] as NoteRow | undefined) ?? null;
    },

    async createNote(row: Pick<NoteRow, 'id' | 'owner_user_id' | 'title'> & {
      tenant_id?: string | null; icon?: string | null; cover?: string | null;
      parent_note_id?: string | null; sensitivity?: NoteRow['sensitivity'];
      doc_json?: string; is_template?: number; template_key?: string | null; favorite?: number;
      page_theme?: string; freeform_mode?: number; cover_image_artifact_id?: string | null;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO notes
           (id, owner_user_id, tenant_id, title, icon, cover, parent_note_id,
            sensitivity, doc_json, is_template, template_key, favorite,
            page_theme, freeform_mode, cover_image_artifact_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          row.id, row.owner_user_id, row.tenant_id ?? null, row.title,
          row.icon ?? null, row.cover ?? null, row.parent_note_id ?? null,
          row.sensitivity ?? 'normal',
          row.doc_json ?? '{"type":"doc","content":[]}',
          row.is_template ?? 0, row.template_key ?? null, row.favorite ?? 0,
          row.page_theme ?? 'pro', row.freeform_mode ?? 0, row.cover_image_artifact_id ?? null,
        ],
      );
    },

    async updateNote(id: string, userId: string, patch: Partial<Pick<NoteRow,
      'title' | 'icon' | 'cover' | 'parent_note_id' | 'sensitivity' | 'doc_json' | 'favorite'
      | 'page_theme' | 'freeform_mode' | 'cover_image_artifact_id'
    >>): Promise<void> {
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, val: unknown) => { fields.push(`${col} = $${values.length + 1}`); values.push(val); };
      if (patch.title !== undefined) set('title', patch.title);
      if (patch.icon !== undefined) set('icon', patch.icon);
      if (patch.cover !== undefined) set('cover', patch.cover);
      if (patch.parent_note_id !== undefined) set('parent_note_id', patch.parent_note_id);
      if (patch.sensitivity !== undefined) set('sensitivity', patch.sensitivity);
      if (patch.doc_json !== undefined) set('doc_json', patch.doc_json);
      if (patch.favorite !== undefined) set('favorite', patch.favorite);
      if (patch.page_theme !== undefined) set('page_theme', patch.page_theme);
      if (patch.freeform_mode !== undefined) set('freeform_mode', patch.freeform_mode);
      if (patch.cover_image_artifact_id !== undefined) set('cover_image_artifact_id', patch.cover_image_artifact_id);
      if (fields.length === 0) return;
      fields.push(`updated_at = ${ctx.now}`);
      values.push(id, userId);
      await ctx.query(`UPDATE notes SET ${fields.join(', ')} WHERE id = $${values.length - 1} AND owner_user_id = $${values.length}`, values);
    },

    async archiveNote(id: string, userId: string, at: string): Promise<boolean> {
      // Owner-scoped soft-delete; only flips an ACTIVE note (archived_at IS NULL) so re-archiving is a no-op.
      const { rows } = await ctx.query(
        `UPDATE notes SET archived_at = $1, updated_at = ${ctx.now}
         WHERE id = $2 AND owner_user_id = $3 AND archived_at IS NULL RETURNING id`,
        [at, id, userId],
      );
      return rows.length > 0;
    },

    async restoreNote(id: string, userId: string): Promise<boolean> {
      const { rows } = await ctx.query(
        `UPDATE notes SET archived_at = NULL, updated_at = ${ctx.now}
         WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NOT NULL RETURNING id`,
        [id, userId],
      );
      return rows.length > 0;
    },

    async deleteNote(id: string, userId: string): Promise<boolean> {
      // Delete sub-pages recursively (one level; production would use recursive CTE).
      // SQLite wraps this in a transaction + returns `.changes > 0` of the FINAL delete; we run the
      // statements sequentially and use RETURNING on the final delete for the same boolean.
      const { rows: subRows } = await ctx.query('SELECT id FROM notes WHERE parent_note_id = $1 AND owner_user_id = $2', [id, userId]);
      const subIds = (subRows as unknown as Array<{ id: string }>).map((r) => r.id);
      for (const subId of subIds) {
        await ctx.query('DELETE FROM note_links WHERE note_id = $1', [subId]);
        await ctx.query('DELETE FROM notes WHERE id = $1 AND owner_user_id = $2', [subId, userId]);
      }
      await ctx.query('DELETE FROM note_links WHERE note_id = $1', [id]);
      const { rows } = await ctx.query('DELETE FROM notes WHERE id = $1 AND owner_user_id = $2 RETURNING id', [id, userId]);
      return rows.length > 0;
    },

    // ── Note links ─────────────────────────────────────────────────────────────
    async listNoteLinks(noteId: string): Promise<NoteLinkRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_links WHERE note_id = $1 ORDER BY created_at COLLATE "C" ASC', [noteId]);
      return rows as unknown as NoteLinkRow[];
    },

    async listNoteBacklinks(targetKind: NoteLinkTargetKind, targetId: string): Promise<NoteLinkRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_links WHERE target_kind = $1 AND target_id = $2 ORDER BY created_at COLLATE "C" DESC', [targetKind, targetId]);
      return rows as unknown as NoteLinkRow[];
    },

    async createNoteLink(row: Pick<NoteLinkRow, 'id' | 'note_id' | 'target_kind' | 'target_id'>): Promise<void> {
      await ctx.query(
        `INSERT INTO note_links (id, note_id, target_kind, target_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [row.id, row.note_id, row.target_kind, row.target_id],
      );
    },

    async deleteNoteLink(id: string, noteId: string): Promise<void> {
      await ctx.query('DELETE FROM note_links WHERE id = $1 AND note_id = $2', [id, noteId]);
    },

    // ── Note databases ─────────────────────────────────────────────────────────
    async listNoteDatabases(userId: string): Promise<NoteDatabaseRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_databases WHERE owner_user_id = $1 ORDER BY name COLLATE "C" ASC', [userId]);
      return rows as unknown as NoteDatabaseRow[];
    },

    async getNoteDatabase(id: string, userId: string): Promise<NoteDatabaseRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_databases WHERE id = $1 AND owner_user_id = $2', [id, userId]);
      return (rows[0] as NoteDatabaseRow | undefined) ?? null;
    },

    async createNoteDatabase(row: Pick<NoteDatabaseRow, 'id' | 'owner_user_id' | 'name'> & {
      tenant_id?: string | null; source?: NoteDatabaseRow['source']; view_type?: NoteDatabaseRow['view_type'];
      filter_json?: string; sort_json?: string; columns_json?: string;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO note_databases (id, owner_user_id, tenant_id, name, source, view_type, filter_json, sort_json, columns_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.id, row.owner_user_id, row.tenant_id ?? null, row.name,
          row.source ?? 'generic', row.view_type ?? 'table',
          row.filter_json ?? '{}', row.sort_json ?? '[]', row.columns_json ?? '[]',
        ],
      );
    },

    async deleteNoteDatabase(id: string, userId: string): Promise<void> {
      // SQLite runs both deletes in a transaction; sequential awaits mirror it.
      await ctx.query('DELETE FROM note_db_rows WHERE database_id = $1', [id]);
      await ctx.query('DELETE FROM note_databases WHERE id = $1 AND owner_user_id = $2', [id, userId]);
    },

    // ── Note database rows ─────────────────────────────────────────────────────
    async listNoteDbRows(databaseId: string): Promise<NoteDbRowRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_db_rows WHERE database_id = $1 ORDER BY created_at COLLATE "C" ASC', [databaseId]);
      return rows as unknown as NoteDbRowRow[];
    },

    async createNoteDbRow(row: Pick<NoteDbRowRow, 'id' | 'database_id'> & { fields_json?: string }): Promise<void> {
      await ctx.query('INSERT INTO note_db_rows (id, database_id, fields_json) VALUES ($1, $2, $3)', [row.id, row.database_id, row.fields_json ?? '{}']);
    },

    async updateNoteDbRow(id: string, databaseId: string, fieldsJson: string): Promise<void> {
      await ctx.query('UPDATE note_db_rows SET fields_json = $1 WHERE id = $2 AND database_id = $3', [fieldsJson, id, databaseId]);
    },

    async deleteNoteDbRow(id: string, databaseId: string): Promise<void> {
      await ctx.query('DELETE FROM note_db_rows WHERE id = $1 AND database_id = $2', [id, databaseId]);
    },

    // ─── weaveNotes Phase 5: flashcards (SM-2 / FSRS) ───────────────────────────
    async createNoteFlashcard(row: NoteFlashcardRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_flashcards (id, note_id, owner_user_id, tenant_id, front, back, ease_factor, interval_days, repetitions, due_at, last_reviewed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          row.id, row.note_id, row.owner_user_id, row.tenant_id, row.front, row.back,
          row.ease_factor, row.interval_days, row.repetitions, row.due_at, row.last_reviewed_at, row.created_at,
        ],
      );
    },

    async listNoteFlashcards(noteId: string, ownerUserId: string): Promise<NoteFlashcardRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_flashcards WHERE note_id = $1 AND owner_user_id = $2 ORDER BY created_at ASC', [noteId, ownerUserId]);
      return rows as unknown as NoteFlashcardRow[];
    },

    async getNoteFlashcard(id: string, ownerUserId: string): Promise<NoteFlashcardRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_flashcards WHERE id = $1 AND owner_user_id = $2', [id, ownerUserId]);
      return (rows[0] as NoteFlashcardRow | undefined) ?? null;
    },

    async listDueFlashcards(ownerUserId: string, nowMs: number, limit: number): Promise<NoteFlashcardRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM note_flashcards WHERE owner_user_id = $1 AND due_at <= $2 ORDER BY due_at ASC LIMIT $3',
        [ownerUserId, nowMs, Math.max(1, Math.min(500, limit))],
      );
      return rows as unknown as NoteFlashcardRow[];
    },

    async updateNoteFlashcardSchedule(id: string, ownerUserId: string, sched: { ease_factor: number; interval_days: number; repetitions: number; due_at: number; last_reviewed_at: number; stability?: number | null; difficulty?: number | null }): Promise<void> {
      await ctx.query(
        'UPDATE note_flashcards SET ease_factor = $1, interval_days = $2, repetitions = $3, due_at = $4, last_reviewed_at = $5, stability = $6, difficulty = $7 WHERE id = $8 AND owner_user_id = $9',
        [sched.ease_factor, sched.interval_days, sched.repetitions, sched.due_at, sched.last_reviewed_at, sched.stability ?? null, sched.difficulty ?? null, id, ownerUserId],
      );
    },

    async countNoteFlashcards(noteId: string, ownerUserId: string): Promise<number> {
      const { rows } = await ctx.query('SELECT COUNT(*) AS n FROM note_flashcards WHERE note_id = $1 AND owner_user_id = $2', [noteId, ownerUserId]);
      return Number((rows[0] as { n: number | string }).n);
    },
  };
}
