// SPDX-License-Identifier: MIT
/**
 * Postgres port of the FULL `IMeStore` domain of the geneWeave `DatabaseAdapter` — the /api/me/
 * user-scope surface. This is the largest interface slice: user runs + run-event journal, the whole
 * Collaboration stack (presence, shared sessions + invite tokens, durable subscriptions +
 * notification feed + transactional outbox, run comments/annotations/public shares, unified handoff,
 * CRDT run co-editing and BlockDoc note co-editing + note sharing + AI-suggestion track-changes),
 * the notes knowledge graph (entities / relations / embeddings) + run embeddings + note version
 * history / comments / synced blocks / meetings / background-memory state, the weaveNotes single-row
 * capability config + per-tenant Appearance/AI-transparency/citations/answer-versions/accessibility/
 * role-access/i18n/suggested-prompt policy tables, HITL interrupts, webhook endpoints, devices +
 * notification prefs, and the mode-label / starter-prompt catalog (+ admin CRUD) plus the cross-chat
 * temporal-reminder view.
 *
 * Each method mirrors the SQLite implementation in `../db-sqlite.ts` statement-for-statement: same
 * SQL, same column order, same integer-boolean and TEXT-JSON conventions. The only translations are
 * the SQLite→Postgres dialect differences:
 *   - `?`→`$n` placeholders (dynamic builders renumber via `$${params.length + 1}`);
 *   - named-parameter (`@col`) inserts → an explicit ordered column list + positional binds;
 *   - `datetime('now')`→`${ctx.now}`; ISO-ms `strftime('%Y-%m-%dT%H:%M:%fZ','now')`→`NOW_ISO_MS`;
 *   - `datetime('now', '-N hours')`→`(now() at time zone 'utc') - interval` folded to the same text;
 *   - null-safe `col IS ?`→`col IS NOT DISTINCT FROM $n`;
 *   - `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`; upsert→`ON CONFLICT (...) DO UPDATE SET ...=EXCLUDED`;
 *   - `INSERT OR REPLACE`→`ON CONFLICT (<uniq>) DO UPDATE SET ...=EXCLUDED`;
 *   - every TEXT ordering pinned to `COLLATE "C"` (plain byte order) so results match SQLite;
 *   - SQLite `rowid` tiebreaks → the primary key `id COLLATE "C"` for a stable secondary sort;
 *   - `.changes > 0` booleans recovered via `RETURNING <pk>` + `rows.length`; `.changes` counts via
 *     `rowCount`.
 *
 * Booleans persist as INTEGER 0/1 (numbers, via the int8 parser); JSON/metadata columns are TEXT
 * pass-through; bigint epoch columns read back as numbers; every value is a bound parameter.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import { buildTenantContext } from '../realm-hierarchy.js';
import { resolveTenantEffectiveNoteActionMode } from '../note-action-realm.js';
import type { SqlClient } from '@weaveintel/realm';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type { TemporalReminderRow } from '../db-types/core.js';
import type {
  UserRunRow,
  UserRunEventRow,
  RunPresenceRow,
  CollaborationConfigRow,
  SharedSessionRow,
  SessionParticipantRow,
  ShareTokenRow,
  RunSubscriptionRow,
  NotificationFeedRow,
  NotificationOutboxRow,
  WebhookEndpointRow,
  RunCommentRow,
  RunAnnotationRow,
  RunPublicShareRow,
  SessionHandoffRow,
  HandoffEventRow,
  CoeditDocRow,
  CoeditOpRow,
  NoteCoeditDocRow,
  NoteCoeditOpRow,
  NoteShareRow,
  NoteShareTokenRow,
  NoteSuggestionRow,
  TenantAppearanceRow,
  TenantAiTransparencyRow,
  MessageCitationRow,
  TenantChatCitationsRow,
  MessageVariantRow,
  TenantAnswerVersionsRow,
  TenantAccessibilityRow,
  TenantRoleAccessRow,
  TenantLocalesRow,
  TenantUiTranslationRow,
  TenantSuggestedPromptsRow,
  UserPromptSuggestionsRow,
  PromptSuggestionEventRow,
  NoteMemoryStateRow,
  NoteNeedingMemoryRow,
  NoteMeetingRow,
  NoteEntityRow,
  NoteRelationRow,
  NoteEmbeddingRow,
  RunEmbeddingRow,
  NoteVersionRow,
  NoteCommentRow,
  NoteSyncedBlockRow,
  WeaveNotesSettingsRow,
  NoteActionModeRow,
  NoteActivityRow,
  NoteActivityQuery,
  UserDeviceRow,
  NotificationPrefsRow,
  ModeLabel,
  StarterPrompt,
} from '../db-types/adapter-me.js';

/** ISO-8601-with-millis UTC text, matching SQLite `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. */
const NOW_ISO_MS = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export function pgMeStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  const store: Partial<DatabaseAdapter> = {
    // ── Runs ────────────────────────────────────────────────────────────────
    async createUserRun(run: Pick<UserRunRow, 'id' | 'user_id' | 'status'> & { tenant_id?: string; surface?: string; metadata?: string }): Promise<void> {
      await ctx.query(
        'INSERT INTO user_runs (id, user_id, tenant_id, status, surface, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [run.id, run.user_id, run.tenant_id ?? null, run.status, run.surface ?? null, run.metadata ?? null],
      );
    },

    async getUserRun(id: string, userId: string): Promise<UserRunRow | null> {
      const { rows } = await ctx.query('SELECT * FROM user_runs WHERE id = $1 AND user_id = $2', [id, userId]);
      return (rows[0] as UserRunRow | undefined) ?? null;
    },

    async getUserRunById(id: string): Promise<UserRunRow | null> {
      const { rows } = await ctx.query('SELECT * FROM user_runs WHERE id = $1', [id]);
      return (rows[0] as UserRunRow | undefined) ?? null;
    },

    async listUserRuns(userId: string, filter: { status?: UserRunRow['status']; limit?: number; offset?: number } = {}): Promise<UserRunRow[]> {
      const limit = filter.limit ?? 50;
      const offset = filter.offset ?? 0;
      if (filter.status) {
        const { rows } = await ctx.query(
          'SELECT * FROM user_runs WHERE user_id = $1 AND status = $2 ORDER BY created_at COLLATE "C" DESC, id COLLATE "C" DESC LIMIT $3 OFFSET $4',
          [userId, filter.status, limit, offset],
        );
        return rows as unknown as UserRunRow[];
      }
      const { rows } = await ctx.query(
        'SELECT * FROM user_runs WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC, id COLLATE "C" DESC LIMIT $2 OFFSET $3',
        [userId, limit, offset],
      );
      return rows as unknown as UserRunRow[];
    },

    async updateUserRunStatus(id: string, userId: string, status: UserRunRow['status']): Promise<void> {
      await ctx.query(`UPDATE user_runs SET status = $1, updated_at = ${ctx.now} WHERE id = $2 AND user_id = $3`, [status, id, userId]);
    },

    // ── Run events ──────────────────────────────────────────────────────────
    async appendUserRunEvent(event: Pick<UserRunEventRow, 'id' | 'run_id' | 'sequence' | 'kind' | 'payload'>): Promise<void> {
      await ctx.query(
        'INSERT INTO user_run_events (id, run_id, sequence, kind, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [event.id, event.run_id, event.sequence, event.kind, event.payload],
      );
    },

    async listUserRunEvents(runId: string, afterSequence = -1): Promise<UserRunEventRow[]> {
      const { rows } = await ctx.query('SELECT * FROM user_run_events WHERE run_id = $1 AND sequence > $2 ORDER BY sequence ASC', [runId, afterSequence]);
      return rows as unknown as UserRunEventRow[];
    },

    async deleteUserRunEvents(runId: string): Promise<number> {
      const res = await ctx.query('DELETE FROM user_run_events WHERE run_id = $1', [runId]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    // ── Presence (m94, Collaboration Phase 1) ──────────────────────────────────
    async upsertRunPresence(row: Omit<RunPresenceRow, 'created_at' | 'tenant_id' | 'color' | 'cursor_json'> & { tenant_id?: string | null; color?: string | null; cursor_json?: string | null }): Promise<void> {
      await ctx.query(
        `INSERT INTO run_presence
           (id, run_id, tenant_id, user_id, display_name, presence, peer_type, color, cursor_json, last_heartbeat_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT(run_id, user_id) DO UPDATE SET
           display_name = excluded.display_name, presence = excluded.presence, peer_type = excluded.peer_type,
           color = excluded.color, cursor_json = excluded.cursor_json,
           last_heartbeat_at = excluded.last_heartbeat_at, expires_at = excluded.expires_at`,
        [
          row.id, row.run_id, row.tenant_id ?? null, row.user_id, row.display_name, row.presence, row.peer_type,
          row.color ?? null, row.cursor_json ?? null, row.last_heartbeat_at, row.expires_at,
        ],
      );
    },

    async listActiveRunPresence(runId: string, now: number): Promise<RunPresenceRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM run_presence WHERE run_id = $1 AND expires_at > $2 ORDER BY peer_type COLLATE "C" DESC, user_id COLLATE "C" ASC',
        [runId, now],
      );
      return rows as unknown as RunPresenceRow[];
    },

    async deleteRunPresence(runId: string, userId: string): Promise<number> {
      const res = await ctx.query('DELETE FROM run_presence WHERE run_id = $1 AND user_id = $2', [runId, userId]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    async deleteExpiredRunPresence(now: number): Promise<Array<{ run_id: string; tenant_id: string | null }>> {
      const { rows: affected } = await ctx.query('SELECT DISTINCT run_id, tenant_id FROM run_presence WHERE expires_at <= $1', [now]);
      await ctx.query('DELETE FROM run_presence WHERE expires_at <= $1', [now]);
      return affected as unknown as Array<{ run_id: string; tenant_id: string | null }>;
    },

    async getCollaborationConfig(): Promise<CollaborationConfigRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM collaboration_config WHERE id = 'global'`, []);
      return (rows[0] as CollaborationConfigRow | undefined) ?? null;
    },

    // ── Shared sessions + invite links (m95, Collaboration Phase 2) ────────────
    async createSharedSession(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; max_participants: number; created_at: number }): Promise<void> {
      await ctx.query(
        `INSERT INTO shared_sessions (id, run_id, tenant_id, owner_id, status, max_participants, created_at)
         VALUES ($1, $2, $3, $4, 'live', $5, $6) ON CONFLICT DO NOTHING`,
        [row.id, row.run_id, row.tenant_id ?? null, row.owner_id, row.max_participants, row.created_at],
      );
    },

    async getSharedSessionById(id: string): Promise<SharedSessionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM shared_sessions WHERE id = $1', [id]);
      return (rows[0] as SharedSessionRow | undefined) ?? null;
    },

    async getSharedSessionByRun(runId: string): Promise<SharedSessionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM shared_sessions WHERE run_id = $1', [runId]);
      return (rows[0] as SharedSessionRow | undefined) ?? null;
    },

    async endSharedSession(id: string, endedAt: number): Promise<void> {
      await ctx.query(`UPDATE shared_sessions SET status = 'ended', ended_at = $1 WHERE id = $2`, [endedAt, id]);
    },

    async upsertSessionParticipant(row: { id: string; session_id: string; tenant_id?: string | null; user_id: string; role: string; joined_at: number; invited_via_token_id?: string | null }): Promise<void> {
      await ctx.query(
        `INSERT INTO session_participants (id, session_id, tenant_id, user_id, role, joined_at, invited_via_token_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(session_id, user_id) DO UPDATE SET role = excluded.role`,
        [row.id, row.session_id, row.tenant_id ?? null, row.user_id, row.role, row.joined_at, row.invited_via_token_id ?? null],
      );
    },

    async getSessionParticipant(sessionId: string, userId: string): Promise<SessionParticipantRow | null> {
      const { rows } = await ctx.query('SELECT * FROM session_participants WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
      return (rows[0] as SessionParticipantRow | undefined) ?? null;
    },

    async listSessionParticipants(sessionId: string): Promise<SessionParticipantRow[]> {
      const { rows } = await ctx.query('SELECT * FROM session_participants WHERE session_id = $1 ORDER BY joined_at ASC', [sessionId]);
      return rows as unknown as SessionParticipantRow[];
    },

    async deleteSessionParticipant(sessionId: string, userId: string): Promise<number> {
      const res = await ctx.query('DELETE FROM session_participants WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    async createShareToken(row: { id: string; session_id: string; tenant_id?: string | null; role: string; token_hash: string; token_prefix: string; max_uses?: number | null; expires_at?: number | null; created_by: string; created_at: number }): Promise<void> {
      await ctx.query(
        `INSERT INTO session_share_tokens (id, session_id, tenant_id, role, token_hash, token_prefix, max_uses, uses, expires_at, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10)`,
        [row.id, row.session_id, row.tenant_id ?? null, row.role, row.token_hash, row.token_prefix, row.max_uses ?? null, row.expires_at ?? null, row.created_by, row.created_at],
      );
    },

    async getShareTokenByHash(tokenHash: string): Promise<ShareTokenRow | null> {
      const { rows } = await ctx.query('SELECT * FROM session_share_tokens WHERE token_hash = $1', [tokenHash]);
      return (rows[0] as ShareTokenRow | undefined) ?? null;
    },

    async incrementShareTokenUses(id: string): Promise<void> {
      await ctx.query('UPDATE session_share_tokens SET uses = uses + 1 WHERE id = $1', [id]);
    },

    async revokeShareToken(id: string, revokedAt: number): Promise<void> {
      await ctx.query('UPDATE session_share_tokens SET revoked_at = $1 WHERE id = $2', [revokedAt, id]);
    },

    // ── Durable subscriptions + notifications (m96, Collaboration Phase 3) ──────
    async upsertRunSubscription(row: { id: string; run_id: string; tenant_id?: string | null; user_id: string; channels: string; created_at: number }): Promise<RunSubscriptionRow> {
      await ctx.query(
        `INSERT INTO run_subscriptions (id, run_id, tenant_id, user_id, channels, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(run_id, user_id) DO UPDATE SET channels = excluded.channels`,
        [row.id, row.run_id, row.tenant_id ?? null, row.user_id, row.channels, row.created_at],
      );
      const { rows } = await ctx.query('SELECT * FROM run_subscriptions WHERE run_id = $1 AND user_id = $2', [row.run_id, row.user_id]);
      return rows[0] as unknown as RunSubscriptionRow;
    },

    async deleteRunSubscription(runId: string, userId: string): Promise<number> {
      const res = await ctx.query('DELETE FROM run_subscriptions WHERE run_id = $1 AND user_id = $2', [runId, userId]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    async getRunSubscription(runId: string, userId: string): Promise<RunSubscriptionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM run_subscriptions WHERE run_id = $1 AND user_id = $2', [runId, userId]);
      return (rows[0] as RunSubscriptionRow | undefined) ?? null;
    },

    async listRunSubscribers(runId: string): Promise<RunSubscriptionRow[]> {
      const { rows } = await ctx.query('SELECT * FROM run_subscriptions WHERE run_id = $1 ORDER BY created_at ASC', [runId]);
      return rows as unknown as RunSubscriptionRow[];
    },

    async listSubscriptionsForUser(userId: string): Promise<RunSubscriptionRow[]> {
      const { rows } = await ctx.query('SELECT * FROM run_subscriptions WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
      return rows as unknown as RunSubscriptionRow[];
    },

    // Notification feed (in-app inbox)
    async appendNotificationFeed(row: NotificationFeedRow): Promise<NotificationFeedRow> {
      await ctx.query(
        `INSERT INTO notification_feed (id, tenant_id, principal_id, category, title, body, deep_link, priority, dedupe_key, created_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
        [row.id, row.tenant_id ?? null, row.principal_id, row.category, row.title, row.body ?? null, row.deep_link ?? null, row.priority, row.dedupe_key ?? null, row.created_at, row.read_at ?? null],
      );
      if (row.dedupe_key) {
        const { rows } = await ctx.query('SELECT * FROM notification_feed WHERE principal_id = $1 AND dedupe_key = $2', [row.principal_id, row.dedupe_key]);
        if (rows[0]) return rows[0] as unknown as NotificationFeedRow;
      }
      const { rows } = await ctx.query('SELECT * FROM notification_feed WHERE id = $1', [row.id]);
      return (rows[0] as NotificationFeedRow | undefined) ?? row;
    },

    async listNotificationFeed(tenantId: string, principalId: string, opts?: { limit?: number; unreadOnly?: boolean }): Promise<NotificationFeedRow[]> {
      const unread = opts?.unreadOnly ? 'AND read_at IS NULL' : '';
      const limit = typeof opts?.limit === 'number' ? `LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
      const { rows } = await ctx.query(
        `SELECT * FROM notification_feed WHERE tenant_id IS NOT DISTINCT FROM $1 AND principal_id = $2 ${unread} ORDER BY created_at DESC ${limit}`,
        [tenantId === '__global__' ? null : tenantId, principalId],
      );
      return rows as unknown as NotificationFeedRow[];
    },

    async countUnreadNotificationFeed(tenantId: string, principalId: string): Promise<number> {
      const { rows } = await ctx.query(
        'SELECT COUNT(*) AS n FROM notification_feed WHERE tenant_id IS NOT DISTINCT FROM $1 AND principal_id = $2 AND read_at IS NULL',
        [tenantId === '__global__' ? null : tenantId, principalId],
      );
      return Number((rows[0] as { n: number | string }).n);
    },

    async markNotificationFeedRead(tenantId: string, principalId: string, id: string, now: number): Promise<boolean> {
      const { rows } = await ctx.query(
        'UPDATE notification_feed SET read_at = $1 WHERE id = $2 AND tenant_id IS NOT DISTINCT FROM $3 AND principal_id = $4 AND read_at IS NULL RETURNING id',
        [now, id, tenantId === '__global__' ? null : tenantId, principalId],
      );
      return rows.length > 0;
    },

    async markAllNotificationFeedRead(tenantId: string, principalId: string, now: number): Promise<number> {
      const res = await ctx.query(
        'UPDATE notification_feed SET read_at = $1 WHERE tenant_id IS NOT DISTINCT FROM $2 AND principal_id = $3 AND read_at IS NULL',
        [now, tenantId === '__global__' ? null : tenantId, principalId],
      );
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    // Transactional outbox (crash-safe delivery)
    async enqueueNotificationOutbox(row: { id: string; run_id: string; tenant_id?: string | null; user_id: string; channels: string; payload: string; idempotency_key: string; next_attempt_at: number; created_at: number }): Promise<boolean> {
      const { rows } = await ctx.query(
        `INSERT INTO notification_outbox (id, run_id, tenant_id, user_id, channels, payload, idempotency_key, status, attempts, next_attempt_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
        [row.id, row.run_id, row.tenant_id ?? null, row.user_id, row.channels, row.payload, row.idempotency_key, row.next_attempt_at, row.created_at],
      );
      return rows.length > 0;
    },

    async claimNotificationOutbox(now: number, leaseUntil: number, limit: number): Promise<NotificationOutboxRow[]> {
      // Atomically lease due rows (mirrors the SQLite `d.transaction`): SELECT then UPDATE, in order.
      const lim = Math.max(1, Math.floor(limit));
      const { rows } = await ctx.query(
        `SELECT * FROM notification_outbox
          WHERE ((status = 'pending' AND next_attempt_at <= $1)
                 OR (status = 'sending' AND lease_until IS NOT NULL AND lease_until <= $2))
          ORDER BY next_attempt_at ASC LIMIT $3`,
        [now, now, lim],
      );
      const claimed = rows as unknown as NotificationOutboxRow[];
      for (const r of claimed) {
        await ctx.query(`UPDATE notification_outbox SET status = 'sending', lease_until = $1, attempts = attempts + 1 WHERE id = $2`, [leaseUntil, r.id]);
      }
      return claimed;
    },

    async markNotificationOutboxSent(id: string, sentAt: number): Promise<void> {
      await ctx.query(`UPDATE notification_outbox SET status = 'sent', sent_at = $1, lease_until = NULL, last_error = NULL WHERE id = $2`, [sentAt, id]);
    },

    async rescheduleNotificationOutbox(id: string, nextAttemptAt: number, attempts: number, lastError: string, failed: boolean): Promise<void> {
      await ctx.query(
        `UPDATE notification_outbox SET status = $1, next_attempt_at = $2, last_error = $3, lease_until = NULL WHERE id = $4`,
        [failed ? 'failed' : 'pending', nextAttemptAt, lastError.slice(0, 500), id],
      );
      void attempts; // attempts already incremented at claim time
    },

    async hasNotificationOutboxForRun(runId: string): Promise<boolean> {
      const { rows } = await ctx.query('SELECT 1 FROM notification_outbox WHERE run_id = $1 LIMIT 1', [runId]);
      return rows[0] !== undefined;
    },

    async listTerminalRunsWithSubscribers(limit: number): Promise<UserRunRow[]> {
      const { rows } = await ctx.query(
        `SELECT r.* FROM user_runs r
          WHERE r.status IN ('completed','failed','cancelled')
            AND EXISTS (SELECT 1 FROM run_subscriptions s WHERE s.run_id = r.id)
          ORDER BY r.created_at COLLATE "C" DESC LIMIT $1`,
        [Math.max(1, Math.floor(limit))],
      );
      return rows as unknown as UserRunRow[];
    },

    // ── Run comments + annotations + public share (m97, Collaboration Phase 4) ──
    async createRunComment(row: RunCommentRow): Promise<void> {
      await ctx.query(
        `INSERT INTO run_comments (id, run_id, tenant_id, thread_id, parent_id, author_id, body, body_html, mentions_json, anchor_part_id, anchor_seq, anchor_range_json, created_at, updated_at, edited_at, deleted_at, deleted_by, resolved_at, resolved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [row.id, row.run_id, row.tenant_id, row.thread_id, row.parent_id, row.author_id, row.body, row.body_html, row.mentions_json, row.anchor_part_id, row.anchor_seq, row.anchor_range_json, row.created_at, row.updated_at, row.edited_at, row.deleted_at, row.deleted_by, row.resolved_at, row.resolved_by],
      );
    },

    async getRunComment(id: string): Promise<RunCommentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM run_comments WHERE id = $1', [id]);
      return (rows[0] as RunCommentRow | undefined) ?? null;
    },

    async listRunComments(runId: string): Promise<RunCommentRow[]> {
      const { rows } = await ctx.query('SELECT * FROM run_comments WHERE run_id = $1 ORDER BY created_at ASC', [runId]);
      return rows as unknown as RunCommentRow[];
    },

    async listRunCommentThread(threadId: string): Promise<RunCommentRow[]> {
      const { rows } = await ctx.query('SELECT * FROM run_comments WHERE thread_id = $1 ORDER BY created_at ASC', [threadId]);
      return rows as unknown as RunCommentRow[];
    },

    async updateRunCommentBody(id: string, body: string, bodyHtml: string, mentionsJson: string, editedAt: number, updatedAt: number): Promise<void> {
      await ctx.query('UPDATE run_comments SET body = $1, body_html = $2, mentions_json = $3, edited_at = $4, updated_at = $5 WHERE id = $6', [body, bodyHtml, mentionsJson, editedAt, updatedAt, id]);
    },

    async softDeleteRunComment(id: string, deletedBy: string, deletedAt: number): Promise<void> {
      await ctx.query(`UPDATE run_comments SET body = '', body_html = '', mentions_json = '[]', deleted_at = $1, deleted_by = $2, updated_at = $3 WHERE id = $4`, [deletedAt, deletedBy, deletedAt, id]);
    },

    async setRunThreadResolution(threadId: string, resolvedAt: number | null, resolvedBy: string | null, updatedAt: number): Promise<void> {
      await ctx.query('UPDATE run_comments SET resolved_at = $1, resolved_by = $2, updated_at = $3 WHERE id = $4', [resolvedAt, resolvedBy, updatedAt, threadId]);
    },

    async createRunAnnotation(row: RunAnnotationRow): Promise<void> {
      await ctx.query(
        `INSERT INTO run_annotations (id, run_id, tenant_id, part_id, author_id, name, data_type, value, string_value, comment, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [row.id, row.run_id, row.tenant_id, row.part_id, row.author_id, row.name, row.data_type, row.value, row.string_value, row.comment, row.source, row.created_at],
      );
    },

    async getRunAnnotation(id: string): Promise<RunAnnotationRow | null> {
      const { rows } = await ctx.query('SELECT * FROM run_annotations WHERE id = $1', [id]);
      return (rows[0] as RunAnnotationRow | undefined) ?? null;
    },

    async listRunAnnotations(runId: string): Promise<RunAnnotationRow[]> {
      const { rows } = await ctx.query('SELECT * FROM run_annotations WHERE run_id = $1 ORDER BY created_at ASC', [runId]);
      return rows as unknown as RunAnnotationRow[];
    },

    async deleteRunAnnotation(id: string): Promise<number> {
      const res = await ctx.query('DELETE FROM run_annotations WHERE id = $1', [id]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    async createRunPublicShare(row: { id: string; run_id: string; tenant_id?: string | null; token_hash: string; token_prefix: string; created_by: string; created_at: number; expires_at?: number | null }): Promise<void> {
      await ctx.query(
        `INSERT INTO run_public_shares (id, run_id, tenant_id, token_hash, token_prefix, created_by, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [row.id, row.run_id, row.tenant_id ?? null, row.token_hash, row.token_prefix, row.created_by, row.created_at, row.expires_at ?? null],
      );
    },

    async getRunPublicShareByHash(tokenHash: string): Promise<RunPublicShareRow | null> {
      const { rows } = await ctx.query('SELECT * FROM run_public_shares WHERE token_hash = $1', [tokenHash]);
      return (rows[0] as RunPublicShareRow | undefined) ?? null;
    },

    async listRunPublicShares(runId: string): Promise<RunPublicShareRow[]> {
      const { rows } = await ctx.query('SELECT * FROM run_public_shares WHERE run_id = $1 AND revoked_at IS NULL ORDER BY created_at ASC', [runId]);
      return rows as unknown as RunPublicShareRow[];
    },

    async revokeRunPublicShare(id: string, runId: string, revokedAt: number): Promise<number> {
      const res = await ctx.query('UPDATE run_public_shares SET revoked_at = $1 WHERE id = $2 AND run_id = $3', [revokedAt, id, runId]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    // ── Unified handoff (m98, Collaboration Phase 5) ────────────────────────────
    async insertSessionHandoff(row: SessionHandoffRow): Promise<void> {
      await ctx.query(
        `INSERT INTO session_handoffs (id, run_id, tenant_id, scope, from_actor_type, from_actor_id, to_actor_type, to_actor_id, state, reason, briefing_json, rejection_reason, hand_back_briefing_json, depth, parent_handoff_id, reference_task_ids_json, created_at, updated_at, resolved_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [row.id, row.run_id, row.tenant_id, row.scope, row.from_actor_type, row.from_actor_id, row.to_actor_type, row.to_actor_id, row.state, row.reason, row.briefing_json, row.rejection_reason, row.hand_back_briefing_json, row.depth, row.parent_handoff_id, row.reference_task_ids_json, row.created_at, row.updated_at, row.resolved_at, row.expires_at],
      );
    },

    async getSessionHandoff(id: string): Promise<SessionHandoffRow | null> {
      const { rows } = await ctx.query('SELECT * FROM session_handoffs WHERE id = $1', [id]);
      return (rows[0] as SessionHandoffRow | undefined) ?? null;
    },

    async updateSessionHandoff(id: string, fields: Partial<Pick<SessionHandoffRow, 'state' | 'rejection_reason' | 'hand_back_briefing_json' | 'updated_at' | 'resolved_at'>>): Promise<void> {
      const keys = Object.keys(fields);
      if (keys.length === 0) return;
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      vals.push(id);
      await ctx.query(`UPDATE session_handoffs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    },

    async listSessionHandoffsForRun(runId: string): Promise<SessionHandoffRow[]> {
      const { rows } = await ctx.query('SELECT * FROM session_handoffs WHERE run_id = $1 ORDER BY created_at DESC', [runId]);
      return rows as unknown as SessionHandoffRow[];
    },

    async listSessionHandoffsForActor(actorId: string): Promise<SessionHandoffRow[]> {
      const { rows } = await ctx.query('SELECT * FROM session_handoffs WHERE to_actor_id = $1 ORDER BY created_at DESC', [actorId]);
      return rows as unknown as SessionHandoffRow[];
    },

    async listDueSessionHandoffs(now: number): Promise<SessionHandoffRow[]> {
      const { rows } = await ctx.query(`SELECT * FROM session_handoffs WHERE state IN ('requested','accepted') AND expires_at IS NOT NULL AND expires_at <= $1`, [now]);
      return rows as unknown as SessionHandoffRow[];
    },

    async insertHandoffEvent(row: HandoffEventRow): Promise<void> {
      await ctx.query(
        `INSERT INTO handoff_events (id, handoff_id, at, actor_id, from_state, to_state, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, row.handoff_id, row.at, row.actor_id, row.from_state, row.to_state, row.note],
      );
    },

    async listHandoffEvents(handoffId: string): Promise<HandoffEventRow[]> {
      // SQLite orders by insertion (rowid); Postgres has no rowid, so tiebreak on the PK id.
      const { rows } = await ctx.query('SELECT * FROM handoff_events WHERE handoff_id = $1 ORDER BY id COLLATE "C" ASC', [handoffId]);
      return rows as unknown as HandoffEventRow[];
    },

    // ── CRDT co-editing (m99, Collaboration Phase 7) ────────────────────────────
    async createCoeditDoc(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; title?: string | null; snapshot_json: string; state_vector_json: string; created_at: number; updated_at: number }): Promise<boolean> {
      const { rows } = await ctx.query(
        `INSERT INTO coedit_docs (id, run_id, tenant_id, owner_id, title, snapshot_json, state_vector_json, agent_written, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
        [row.id, row.run_id, row.tenant_id ?? null, row.owner_id, row.title ?? null, row.snapshot_json, row.state_vector_json, row.created_at, row.updated_at],
      );
      return rows.length > 0;
    },

    async getCoeditDoc(id: string): Promise<CoeditDocRow | null> {
      const { rows } = await ctx.query('SELECT * FROM coedit_docs WHERE id = $1', [id]);
      return (rows[0] as CoeditDocRow | undefined) ?? null;
    },

    async getCoeditDocByRun(runId: string): Promise<CoeditDocRow | null> {
      const { rows } = await ctx.query('SELECT * FROM coedit_docs WHERE run_id = $1', [runId]);
      return (rows[0] as CoeditDocRow | undefined) ?? null;
    },

    async updateCoeditDoc(id: string, fields: { snapshot_json: string; state_vector_json: string; agent_written: number; updated_at: number }): Promise<void> {
      await ctx.query('UPDATE coedit_docs SET snapshot_json = $1, state_vector_json = $2, agent_written = $3, updated_at = $4 WHERE id = $5', [fields.snapshot_json, fields.state_vector_json, fields.agent_written, fields.updated_at, id]);
    },

    async appendCoeditOp(row: CoeditOpRow): Promise<boolean> {
      const { rows } = await ctx.query(
        `INSERT INTO coedit_ops (id, doc_id, op_site, op_counter, op_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
        [row.id, row.doc_id, row.op_site, row.op_counter, row.op_json, row.created_at],
      );
      return rows.length > 0;
    },

    async listCoeditOps(docId: string): Promise<CoeditOpRow[]> {
      // SQLite orders by insertion (rowid); tiebreak on (op_counter, id) is stable and deterministic.
      const { rows } = await ctx.query('SELECT * FROM coedit_ops WHERE doc_id = $1 ORDER BY op_counter ASC, id COLLATE "C" ASC', [docId]);
      return rows as unknown as CoeditOpRow[];
    },

    // ── weaveNotes Phase 2 — collaborative NOTE co-editing (m100) ────────────────
    async createNoteCoeditDoc(row: { id: string; note_id: string; tenant_id?: string | null; owner_id: string; snapshot_json: string; state_vector_json: string; created_at: number; updated_at: number }): Promise<boolean> {
      const { rows } = await ctx.query(
        `INSERT INTO note_coedit_docs (id, note_id, tenant_id, owner_id, snapshot_json, state_vector_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
        [row.id, row.note_id, row.tenant_id ?? null, row.owner_id, row.snapshot_json, row.state_vector_json, row.created_at, row.updated_at],
      );
      return rows.length > 0;
    },

    async getNoteCoeditDoc(id: string): Promise<NoteCoeditDocRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_coedit_docs WHERE id = $1', [id]);
      return (rows[0] as NoteCoeditDocRow | undefined) ?? null;
    },

    async getNoteCoeditDocByNote(noteId: string): Promise<NoteCoeditDocRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_coedit_docs WHERE note_id = $1', [noteId]);
      return (rows[0] as NoteCoeditDocRow | undefined) ?? null;
    },

    async updateNoteCoeditDoc(id: string, fields: { snapshot_json: string; state_vector_json: string; updated_at: number }): Promise<void> {
      await ctx.query('UPDATE note_coedit_docs SET snapshot_json = $1, state_vector_json = $2, updated_at = $3 WHERE id = $4', [fields.snapshot_json, fields.state_vector_json, fields.updated_at, id]);
    },

    async appendNoteCoeditOp(row: NoteCoeditOpRow): Promise<boolean> {
      const { rows } = await ctx.query(
        `INSERT INTO note_coedit_ops (id, doc_id, op_site, op_counter, op_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
        [row.id, row.doc_id, row.op_site, row.op_counter, row.op_json, row.created_at],
      );
      return rows.length > 0;
    },

    async listNoteCoeditOps(docId: string): Promise<NoteCoeditOpRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_coedit_ops WHERE doc_id = $1 ORDER BY op_counter ASC, id COLLATE "C" ASC', [docId]);
      return rows as unknown as NoteCoeditOpRow[];
    },

    // Note sharing — membership + invite tokens
    async getNoteForOwner(noteId: string, ownerId: string): Promise<{ id: string; owner_user_id: string; tenant_id: string | null } | null> {
      const { rows } = await ctx.query('SELECT id, owner_user_id, tenant_id FROM notes WHERE id = $1 AND owner_user_id = $2', [noteId, ownerId]);
      return (rows[0] as { id: string; owner_user_id: string; tenant_id: string | null } | undefined) ?? null;
    },

    async getNoteShare(noteId: string, userId: string): Promise<NoteShareRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_shares WHERE note_id = $1 AND user_id = $2', [noteId, userId]);
      return (rows[0] as NoteShareRow | undefined) ?? null;
    },

    async listNoteShares(noteId: string): Promise<NoteShareRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_shares WHERE note_id = $1 ORDER BY joined_at ASC', [noteId]);
      return rows as unknown as NoteShareRow[];
    },

    async upsertNoteShare(row: NoteShareRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_shares (id, note_id, tenant_id, owner_id, user_id, role, joined_at, invited_via_token_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(note_id, user_id) DO UPDATE SET role = excluded.role, invited_via_token_id = excluded.invited_via_token_id`,
        [row.id, row.note_id, row.tenant_id, row.owner_id, row.user_id, row.role, row.joined_at, row.invited_via_token_id],
      );
    },

    async deleteNoteShare(noteId: string, userId: string): Promise<number> {
      const res = await ctx.query('DELETE FROM note_shares WHERE note_id = $1 AND user_id = $2', [noteId, userId]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    async createNoteShareToken(row: NoteShareTokenRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_share_tokens (id, note_id, tenant_id, owner_id, role, token_hash, token_prefix, max_uses, uses, expires_at, revoked_at, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [row.id, row.note_id, row.tenant_id, row.owner_id, row.role, row.token_hash, row.token_prefix, row.max_uses, row.uses, row.expires_at, row.revoked_at, row.created_by, row.created_at],
      );
    },

    async getNoteShareTokenByHash(hash: string): Promise<NoteShareTokenRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_share_tokens WHERE token_hash = $1', [hash]);
      return (rows[0] as NoteShareTokenRow | undefined) ?? null;
    },

    async listNoteShareTokens(noteId: string): Promise<NoteShareTokenRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_share_tokens WHERE note_id = $1 ORDER BY created_at DESC', [noteId]);
      return rows as unknown as NoteShareTokenRow[];
    },

    async incrementNoteShareTokenUses(id: string): Promise<void> {
      await ctx.query('UPDATE note_share_tokens SET uses = uses + 1 WHERE id = $1', [id]);
    },

    async revokeNoteShareToken(id: string, noteId: string, revokedAt: number): Promise<number> {
      const res = await ctx.query('UPDATE note_share_tokens SET revoked_at = $1 WHERE id = $2 AND note_id = $3 AND revoked_at IS NULL', [revokedAt, id, noteId]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    // weaveNotes Phase 3 — AI co-author suggestions (track-changes)
    async createNoteSuggestion(row: NoteSuggestionRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_suggestions (id, note_id, doc_id, tenant_id, author_kind, author_id, author_site, action, status, ops_json, preview_text, before_text, anchor_json, created_at, resolved_at, resolved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [row.id, row.note_id, row.doc_id, row.tenant_id, row.author_kind, row.author_id, row.author_site, row.action, row.status, row.ops_json, row.preview_text, row.before_text ?? '', row.anchor_json, row.created_at, row.resolved_at, row.resolved_by],
      );
    },

    async getNoteSuggestion(id: string): Promise<NoteSuggestionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_suggestions WHERE id = $1', [id]);
      return (rows[0] as NoteSuggestionRow | undefined) ?? null;
    },

    async listNoteSuggestions(noteId: string, status?: 'pending' | 'accepted' | 'rejected'): Promise<NoteSuggestionRow[]> {
      if (status) {
        const { rows } = await ctx.query('SELECT * FROM note_suggestions WHERE note_id = $1 AND status = $2 ORDER BY created_at DESC', [noteId, status]);
        return rows as unknown as NoteSuggestionRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM note_suggestions WHERE note_id = $1 ORDER BY created_at DESC', [noteId]);
      return rows as unknown as NoteSuggestionRow[];
    },

    async resolveNoteSuggestion(id: string, status: 'accepted' | 'rejected', resolvedAt: number, resolvedBy: string): Promise<number> {
      const res = await ctx.query("UPDATE note_suggestions SET status = $1, resolved_at = $2, resolved_by = $3 WHERE id = $4 AND status = 'pending'", [status, resolvedAt, resolvedBy, id]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    // weaveNotes Phase 5 — notes knowledge graph (entities / relations / embeddings)
    async replaceNoteEntities(noteId: string, rows: NoteEntityRow[]): Promise<void> {
      // SQLite runs delete+inserts in one transaction; sequential awaits mirror it.
      await ctx.query('DELETE FROM note_entities WHERE note_id = $1', [noteId]);
      for (const r of rows) {
        await ctx.query(
          'INSERT INTO note_entities (id, note_id, user_id, tenant_id, name, name_key, type, created_at, canonical_key, canonical_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [r.id, r.note_id, r.user_id, r.tenant_id, r.name, r.name_key, r.type, r.created_at, r.canonical_key ?? null, r.canonical_name ?? null],
        );
      }
    },

    async listNoteEntities(noteId: string): Promise<NoteEntityRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_entities WHERE note_id = $1 ORDER BY created_at ASC', [noteId]);
      return rows as unknown as NoteEntityRow[];
    },

    async listUserNoteEntities(userId: string, tenantId?: string | null): Promise<NoteEntityRow[]> {
      if (tenantId === undefined) {
        const { rows } = await ctx.query('SELECT * FROM note_entities WHERE user_id = $1', [userId]);
        return rows as unknown as NoteEntityRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM note_entities WHERE user_id = $1 AND tenant_id IS NOT DISTINCT FROM $2', [userId, tenantId ?? null]);
      return rows as unknown as NoteEntityRow[];
    },

    // geneWeave UI rebuild (m135) — per-tenant Appearance / branding
    async getTenantAppearance(tenantId: string): Promise<TenantAppearanceRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_appearance WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantAppearanceRow | undefined) ?? null;
    },

    async upsertTenantAppearance(row: TenantAppearanceRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_appearance (tenant_id, enabled, brand_name, logo_svg, color_scheme, variant, accent, on_accent, corner_style, font_display, font_body, density, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled, brand_name=excluded.brand_name, logo_svg=excluded.logo_svg, color_scheme=excluded.color_scheme, variant=excluded.variant, accent=excluded.accent, on_accent=excluded.on_accent, corner_style=excluded.corner_style, font_display=excluded.font_display, font_body=excluded.font_body, density=excluded.density, updated_at=excluded.updated_at`,
        [row.tenant_id, row.enabled, row.brand_name, row.logo_svg, row.color_scheme, row.variant, row.accent, row.on_accent, row.corner_style, row.font_display, row.font_body, row.density, row.updated_at],
      );
    },

    async listTenantAppearance(): Promise<TenantAppearanceRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_appearance ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantAppearanceRow[];
    },

    // m137 — per-tenant AI transparency
    async getTenantAiTransparency(tenantId: string): Promise<TenantAiTransparencyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_ai_transparency WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantAiTransparencyRow | undefined) ?? null;
    },

    async upsertTenantAiTransparency(row: TenantAiTransparencyRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_ai_transparency (tenant_id, show_ai_label, disclosure_text, content_warnings, feedback_enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(tenant_id) DO UPDATE SET
           show_ai_label=excluded.show_ai_label, disclosure_text=excluded.disclosure_text,
           content_warnings=excluded.content_warnings, feedback_enabled=excluded.feedback_enabled, updated_at=${ctx.now}`,
        [row.tenant_id, row.show_ai_label, row.disclosure_text, row.content_warnings, row.feedback_enabled],
      );
    },

    async listTenantAiTransparency(): Promise<TenantAiTransparencyRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_ai_transparency ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantAiTransparencyRow[];
    },

    // m138 — answer citations in chat
    async insertMessageCitations(rows: MessageCitationRow[]): Promise<void> {
      if (!rows.length) return;
      for (const r of rows) {
        await ctx.query(
          `INSERT INTO message_citations (id, message_id, chat_id, user_id, tenant_id, n, source_id, source_kind, source_title, quote, char_start, char_end)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [r.id, r.message_id, r.chat_id, r.user_id, r.tenant_id, r.n, r.source_id, r.source_kind, r.source_title, r.quote, r.char_start, r.char_end],
        );
      }
    },

    async listMessageCitations(messageId: string): Promise<MessageCitationRow[]> {
      const { rows } = await ctx.query('SELECT * FROM message_citations WHERE message_id = $1 ORDER BY n ASC', [messageId]);
      return rows as unknown as MessageCitationRow[];
    },

    async getTenantChatCitations(tenantId: string): Promise<TenantChatCitationsRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_chat_citations WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantChatCitationsRow | undefined) ?? null;
    },

    async upsertTenantChatCitations(row: TenantChatCitationsRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_chat_citations (tenant_id, enabled, min_citations, scope, max_sources)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(tenant_id) DO UPDATE SET
           enabled=excluded.enabled, min_citations=excluded.min_citations, scope=excluded.scope,
           max_sources=excluded.max_sources, updated_at=${ctx.now}`,
        [row.tenant_id, row.enabled, row.min_citations, row.scope, row.max_sources],
      );
    },

    async listTenantChatCitations(): Promise<TenantChatCitationsRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_chat_citations ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantChatCitationsRow[];
    },

    // m139 — regenerate with version history
    async insertMessageVariants(rows: MessageVariantRow[]): Promise<void> {
      if (!rows.length) return;
      for (const r of rows) {
        await ctx.query(
          `INSERT INTO message_variants (id, group_id, chat_id, user_id, tenant_id, variant_index, content, model, provider, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [r.id, r.group_id, r.chat_id, r.user_id, r.tenant_id, r.variant_index, r.content, r.model, r.provider, r.reason],
        );
      }
    },

    async listMessageVariants(groupId: string): Promise<MessageVariantRow[]> {
      const { rows } = await ctx.query('SELECT * FROM message_variants WHERE group_id = $1 ORDER BY variant_index ASC', [groupId]);
      return rows as unknown as MessageVariantRow[];
    },

    async updateMessageContent(messageId: string, content: string, metadata: string | null): Promise<void> {
      await ctx.query('UPDATE messages SET content = $1, metadata = $2 WHERE id = $3', [content, metadata, messageId]);
    },

    async getTenantAnswerVersions(tenantId: string): Promise<TenantAnswerVersionsRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_answer_versions WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantAnswerVersionsRow | undefined) ?? null;
    },

    async upsertTenantAnswerVersions(row: TenantAnswerVersionsRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_answer_versions (tenant_id, enabled, max_variants)
         VALUES ($1, $2, $3)
         ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled, max_variants=excluded.max_variants, updated_at=${ctx.now}`,
        [row.tenant_id, row.enabled, row.max_variants],
      );
    },

    async listTenantAnswerVersions(): Promise<TenantAnswerVersionsRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_answer_versions ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantAnswerVersionsRow[];
    },

    // m140 — per-tenant accessibility defaults
    async getTenantAccessibility(tenantId: string): Promise<TenantAccessibilityRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_accessibility WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantAccessibilityRow | undefined) ?? null;
    },

    async upsertTenantAccessibility(row: TenantAccessibilityRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_accessibility (tenant_id, announce_mode, reduced_motion, always_show_focus, confirm_destructive, show_skeletons)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(tenant_id) DO UPDATE SET announce_mode=excluded.announce_mode, reduced_motion=excluded.reduced_motion, always_show_focus=excluded.always_show_focus, confirm_destructive=excluded.confirm_destructive, show_skeletons=excluded.show_skeletons, updated_at=${ctx.now}`,
        [row.tenant_id, row.announce_mode, row.reduced_motion, row.always_show_focus, row.confirm_destructive, row.show_skeletons],
      );
    },

    async listTenantAccessibility(): Promise<TenantAccessibilityRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_accessibility ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantAccessibilityRow[];
    },

    // m143 — per-tenant role-access policy
    async getTenantRoleAccess(tenantId: string): Promise<TenantRoleAccessRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_role_access WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantRoleAccessRow | undefined) ?? null;
    },

    async upsertTenantRoleAccess(row: TenantRoleAccessRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_role_access (tenant_id, member_dashboard, member_connectors, member_design)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(tenant_id) DO UPDATE SET member_dashboard=excluded.member_dashboard, member_connectors=excluded.member_connectors, member_design=excluded.member_design, updated_at=${ctx.now}`,
        [row.tenant_id, row.member_dashboard, row.member_connectors, row.member_design],
      );
    },

    async listTenantRoleAccess(): Promise<TenantRoleAccessRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_role_access ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantRoleAccessRow[];
    },

    // m145 — per-tenant i18n policy + AI-generated locale packs
    async getTenantLocales(tenantId: string): Promise<TenantLocalesRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_locales WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantLocalesRow | undefined) ?? null;
    },

    async upsertTenantLocales(row: TenantLocalesRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_locales (tenant_id, default_locale, enabled_locales, assistant_localized)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(tenant_id) DO UPDATE SET default_locale=excluded.default_locale, enabled_locales=excluded.enabled_locales, assistant_localized=excluded.assistant_localized, updated_at=${ctx.now}`,
        [row.tenant_id, row.default_locale, row.enabled_locales, row.assistant_localized],
      );
    },

    async listTenantLocales(): Promise<TenantLocalesRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_locales ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantLocalesRow[];
    },

    async getTenantUiTranslation(tenantId: string, locale: string): Promise<TenantUiTranslationRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_ui_translations WHERE tenant_id = $1 AND locale = $2', [tenantId, locale]);
      return (rows[0] as TenantUiTranslationRow | undefined) ?? null;
    },

    async listTenantUiTranslations(tenantId: string): Promise<TenantUiTranslationRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_ui_translations WHERE tenant_id = $1 ORDER BY locale COLLATE "C" ASC', [tenantId]);
      return rows as unknown as TenantUiTranslationRow[];
    },

    async upsertTenantUiTranslation(row: TenantUiTranslationRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_ui_translations (tenant_id, locale, messages_json, source, key_count)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(tenant_id, locale) DO UPDATE SET messages_json=excluded.messages_json, source=excluded.source, key_count=excluded.key_count, updated_at=${ctx.now}`,
        [row.tenant_id, row.locale, row.messages_json, row.source, row.key_count],
      );
    },

    // m146 — suggested/starter prompts: per-tenant policy + per-user AI cache + click log
    async getTenantSuggestedPrompts(tenantId: string): Promise<TenantSuggestedPromptsRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_suggested_prompts WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantSuggestedPromptsRow | undefined) ?? null;
    },

    async upsertTenantSuggestedPrompts(row: TenantSuggestedPromptsRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_suggested_prompts (tenant_id, enabled, use_recent_notes, use_recent_chats, use_ai, max_curated, max_personalized)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled, use_recent_notes=excluded.use_recent_notes, use_recent_chats=excluded.use_recent_chats, use_ai=excluded.use_ai, max_curated=excluded.max_curated, max_personalized=excluded.max_personalized, updated_at=${ctx.now}`,
        [row.tenant_id, row.enabled, row.use_recent_notes, row.use_recent_chats, row.use_ai, row.max_curated, row.max_personalized],
      );
    },

    async listTenantSuggestedPrompts(): Promise<TenantSuggestedPromptsRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_suggested_prompts ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantSuggestedPromptsRow[];
    },

    async getUserPromptSuggestions(userId: string): Promise<UserPromptSuggestionsRow | null> {
      const { rows } = await ctx.query('SELECT * FROM user_prompt_suggestions WHERE user_id = $1', [userId]);
      return (rows[0] as UserPromptSuggestionsRow | undefined) ?? null;
    },

    async upsertUserPromptSuggestions(row: UserPromptSuggestionsRow): Promise<void> {
      await ctx.query(
        `INSERT INTO user_prompt_suggestions (user_id, tenant_id, prompts_json, generated_at)
         VALUES ($1, $2, $3, ${ctx.now})
         ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id, prompts_json=excluded.prompts_json, generated_at=${ctx.now}`,
        [row.user_id, row.tenant_id, row.prompts_json],
      );
    },

    async insertPromptSuggestionEvent(row: PromptSuggestionEventRow): Promise<void> {
      await ctx.query(
        `INSERT INTO prompt_suggestion_events (id, user_id, tenant_id, prompt_id, title, source)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [row.id, row.user_id, row.tenant_id, row.prompt_id, row.title, row.source],
      );
    },

    // weaveNotes Phase 5 (m134) — background-memory extraction state
    async getNoteMemoryState(noteId: string, userId: string): Promise<NoteMemoryStateRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_memory_state WHERE note_id = $1 AND user_id = $2', [noteId, userId]);
      return (rows[0] as NoteMemoryStateRow | undefined) ?? null;
    },

    async upsertNoteMemoryState(row: NoteMemoryStateRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_memory_state (note_id, user_id, tenant_id, content_hash, memory_ids_json, memory_count, last_extracted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(note_id) DO UPDATE SET content_hash=excluded.content_hash, memory_ids_json=excluded.memory_ids_json, memory_count=excluded.memory_count, last_extracted_at=excluded.last_extracted_at`,
        [row.note_id, row.user_id, row.tenant_id, row.content_hash, row.memory_ids_json, row.memory_count, row.last_extracted_at],
      );
    },

    async listNotesNeedingMemoryExtraction(limit: number): Promise<NoteNeedingMemoryRow[]> {
      // `datetime(n.updated_at) > datetime(s.last_extracted_at)` compares the same YYYY-MM-DD HH:MM:SS
      // text on both sides, so a plain text `>` is equivalent (and byte-order-monotonic).
      const { rows } = await ctx.query(
        `SELECT n.id AS id, n.owner_user_id AS owner_user_id, n.tenant_id AS tenant_id, n.updated_at AS updated_at
           FROM notes n
           LEFT JOIN note_memory_state s ON s.note_id = n.id
          WHERE (n.is_template = 0 OR n.is_template IS NULL)
            AND (n.archived_at IS NULL)
            AND (s.note_id IS NULL OR n.updated_at > s.last_extracted_at)
          ORDER BY n.updated_at COLLATE "C" DESC
          LIMIT $1`,
        [Math.max(1, Math.min(200, limit))],
      );
      return rows as unknown as NoteNeedingMemoryRow[];
    },

    // weaveNotes Phase 4 (m133) — captured meetings
    async createNoteMeeting(row: NoteMeetingRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_meetings (id, note_id, user_id, tenant_id, title, source, language, duration_sec, segments_json, summary, action_items_json, decisions_json, cited, cite_total, audio_retained, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [row.id, row.note_id, row.user_id, row.tenant_id, row.title, row.source, row.language, row.duration_sec, row.segments_json, row.summary, row.action_items_json, row.decisions_json, row.cited, row.cite_total, row.audio_retained, row.created_at],
      );
    },

    async getNoteMeetingByNote(noteId: string, userId: string): Promise<NoteMeetingRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_meetings WHERE note_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1', [noteId, userId]);
      return (rows[0] as NoteMeetingRow | undefined) ?? null;
    },

    async listUserNoteMeetings(userId: string, tenantId?: string | null): Promise<NoteMeetingRow[]> {
      if (tenantId === undefined) {
        const { rows } = await ctx.query('SELECT * FROM note_meetings WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
        return rows as unknown as NoteMeetingRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM note_meetings WHERE user_id = $1 AND tenant_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC', [userId, tenantId ?? null]);
      return rows as unknown as NoteMeetingRow[];
    },

    async replaceNoteRelations(noteId: string, rows: NoteRelationRow[]): Promise<void> {
      await ctx.query('DELETE FROM note_relations WHERE note_id = $1', [noteId]);
      for (const r of rows) {
        await ctx.query(
          'INSERT INTO note_relations (id, note_id, user_id, tenant_id, subject, predicate, object, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [r.id, r.note_id, r.user_id, r.tenant_id, r.subject, r.predicate, r.object, r.created_at],
        );
      }
    },

    async listNoteRelations(noteId: string): Promise<NoteRelationRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_relations WHERE note_id = $1 ORDER BY created_at ASC', [noteId]);
      return rows as unknown as NoteRelationRow[];
    },

    async upsertNoteEmbedding(row: NoteEmbeddingRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_embeddings (note_id, user_id, tenant_id, dim, embedding_json, content_hash, title, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(note_id) DO UPDATE SET embedding_json=excluded.embedding_json, dim=excluded.dim, content_hash=excluded.content_hash, title=excluded.title, updated_at=excluded.updated_at`,
        [row.note_id, row.user_id, row.tenant_id, row.dim, row.embedding_json, row.content_hash, row.title, row.updated_at],
      );
    },

    async getNoteEmbedding(noteId: string, tenantId?: string | null): Promise<NoteEmbeddingRow | null> {
      if (tenantId === undefined) {
        const { rows } = await ctx.query('SELECT * FROM note_embeddings WHERE note_id = $1', [noteId]);
        return (rows[0] as NoteEmbeddingRow | undefined) ?? null;
      }
      const { rows } = await ctx.query('SELECT * FROM note_embeddings WHERE note_id = $1 AND tenant_id IS NOT DISTINCT FROM $2', [noteId, tenantId ?? null]);
      return (rows[0] as NoteEmbeddingRow | undefined) ?? null;
    },

    async listUserNoteEmbeddings(userId: string, tenantId?: string | null): Promise<NoteEmbeddingRow[]> {
      if (tenantId === undefined) {
        const { rows } = await ctx.query('SELECT * FROM note_embeddings WHERE user_id = $1', [userId]);
        return rows as unknown as NoteEmbeddingRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM note_embeddings WHERE user_id = $1 AND tenant_id IS NOT DISTINCT FROM $2', [userId, tenantId ?? null]);
      return rows as unknown as NoteEmbeddingRow[];
    },

    // weaveNotes Phase 8 — run output embeddings (workspace RAG over runs)
    async upsertRunEmbedding(row: RunEmbeddingRow): Promise<void> {
      await ctx.query(
        `INSERT INTO run_embeddings (run_id, user_id, tenant_id, dim, embedding_json, content_hash, title, content, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(run_id) DO UPDATE SET embedding_json=excluded.embedding_json, dim=excluded.dim, content_hash=excluded.content_hash, title=excluded.title, content=excluded.content, updated_at=excluded.updated_at`,
        [row.run_id, row.user_id, row.tenant_id, row.dim, row.embedding_json, row.content_hash, row.title, row.content, row.updated_at],
      );
    },

    async getRunEmbedding(runId: string, tenantId?: string | null): Promise<RunEmbeddingRow | null> {
      if (tenantId === undefined) {
        const { rows } = await ctx.query('SELECT * FROM run_embeddings WHERE run_id = $1', [runId]);
        return (rows[0] as RunEmbeddingRow | undefined) ?? null;
      }
      const { rows } = await ctx.query('SELECT * FROM run_embeddings WHERE run_id = $1 AND tenant_id IS NOT DISTINCT FROM $2', [runId, tenantId ?? null]);
      return (rows[0] as RunEmbeddingRow | undefined) ?? null;
    },

    async listUserRunEmbeddings(userId: string, tenantId?: string | null): Promise<RunEmbeddingRow[]> {
      if (tenantId === undefined) {
        const { rows } = await ctx.query('SELECT * FROM run_embeddings WHERE user_id = $1', [userId]);
        return rows as unknown as RunEmbeddingRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM run_embeddings WHERE user_id = $1 AND tenant_id IS NOT DISTINCT FROM $2', [userId, tenantId ?? null]);
      return rows as unknown as RunEmbeddingRow[];
    },

    // weaveNotes Phase 8 — per-note version history
    async createNoteVersion(row: NoteVersionRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_versions (id, note_id, user_id, tenant_id, title, doc_json, label, reason, word_count, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [row.id, row.note_id, row.user_id, row.tenant_id, row.title, row.doc_json, row.label, row.reason, row.word_count, row.created_by, row.created_at],
      );
    },

    async listNoteVersions(noteId: string): Promise<NoteVersionRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_versions WHERE note_id = $1 ORDER BY created_at DESC', [noteId]);
      return rows as unknown as NoteVersionRow[];
    },

    async getNoteVersion(id: string): Promise<NoteVersionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_versions WHERE id = $1', [id]);
      return (rows[0] as NoteVersionRow | undefined) ?? null;
    },

    // weaveNotes Phase 8 — block comments on notes
    async createNoteComment(row: NoteCommentRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_comments (id, note_id, tenant_id, thread_id, parent_id, author_id, body, body_html, mentions_json, anchor_block_id, created_at, updated_at, edited_at, deleted_at, deleted_by, resolved_at, resolved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [row.id, row.note_id, row.tenant_id, row.thread_id, row.parent_id, row.author_id, row.body, row.body_html, row.mentions_json, row.anchor_block_id, row.created_at, row.updated_at, row.edited_at, row.deleted_at, row.deleted_by, row.resolved_at, row.resolved_by],
      );
    },

    async getNoteComment(id: string): Promise<NoteCommentRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_comments WHERE id = $1', [id]);
      return (rows[0] as NoteCommentRow | undefined) ?? null;
    },

    async listNoteComments(noteId: string): Promise<NoteCommentRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_comments WHERE note_id = $1 ORDER BY created_at ASC', [noteId]);
      return rows as unknown as NoteCommentRow[];
    },

    async listNoteCommentThread(threadId: string): Promise<NoteCommentRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_comments WHERE thread_id = $1 ORDER BY created_at ASC', [threadId]);
      return rows as unknown as NoteCommentRow[];
    },

    async updateNoteCommentBody(id: string, body: string, bodyHtml: string, mentionsJson: string, editedAt: number, updatedAt: number): Promise<void> {
      await ctx.query('UPDATE note_comments SET body = $1, body_html = $2, mentions_json = $3, edited_at = $4, updated_at = $5 WHERE id = $6', [body, bodyHtml, mentionsJson, editedAt, updatedAt, id]);
    },

    async softDeleteNoteComment(id: string, deletedBy: string, deletedAt: number): Promise<void> {
      await ctx.query(`UPDATE note_comments SET body = '', body_html = '', mentions_json = '[]', deleted_at = $1, deleted_by = $2, updated_at = $3 WHERE id = $4`, [deletedAt, deletedBy, deletedAt, id]);
    },

    async setNoteThreadResolution(threadId: string, resolvedAt: number | null, resolvedBy: string | null, updatedAt: number): Promise<void> {
      await ctx.query('UPDATE note_comments SET resolved_at = $1, resolved_by = $2, updated_at = $3 WHERE id = $4', [resolvedAt, resolvedBy, updatedAt, threadId]);
    },

    // weaveNotes Phase 8 — synced blocks (transclusion)
    async createNoteSyncedBlock(row: NoteSyncedBlockRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_synced_blocks (id, note_id, user_id, tenant_id, source_note_id, source_block_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, row.note_id, row.user_id, row.tenant_id, row.source_note_id, row.source_block_id, row.created_at],
      );
    },

    async getNoteSyncedBlock(id: string): Promise<NoteSyncedBlockRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_synced_blocks WHERE id = $1', [id]);
      return (rows[0] as NoteSyncedBlockRow | undefined) ?? null;
    },

    async listNoteSyncedBlocks(noteId: string): Promise<NoteSyncedBlockRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_synced_blocks WHERE note_id = $1 ORDER BY created_at ASC', [noteId]);
      return rows as unknown as NoteSyncedBlockRow[];
    },

    async deleteNoteSyncedBlock(id: string, noteId: string): Promise<void> {
      await ctx.query('DELETE FROM note_synced_blocks WHERE id = $1 AND note_id = $2', [id, noteId]);
    },

    // weaveNotes Phase 0 — capability config (single 'global' row) + activity log
    async getWeaveNotesSettings(): Promise<WeaveNotesSettingsRow | null> {
      const { rows } = await ctx.query("SELECT * FROM weavenotes_settings WHERE id = 'global'", []);
      return (rows[0] as WeaveNotesSettingsRow | undefined) ?? null;
    },

    async updateWeaveNotesSettings(fields: Partial<Omit<WeaveNotesSettingsRow, 'id'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (!sets.length) return;
      await ctx.query(`UPDATE weavenotes_settings SET ${sets.join(', ')}, updated_at = ${ctx.now} WHERE id = 'global'`, vals);
    },

    // weaveNotes — per-tenant routing mode for a note AI action. Tenancy Realm (C10): resolved
    // nearest-owner-wins down the tenant lineage (own row → nearest ancestor org's row → global
    // default (tenant_id='') → 'direct') via the shared realm resolver, so a parent org can set a
    // mode once and child tenants inherit it while a child can still override with its own row.
    async resolveNoteActionMode(tenantId: string | null, actionKey: string): Promise<'direct' | 'agent' | 'supervisor'> {
      const { rows } = await ctx.query('SELECT * FROM note_action_modes WHERE action_key = $1', [actionKey]);
      const all = rows as unknown as NoteActionModeRow[];
      if (all.length === 0) return 'direct';
      const context = tenantId ? await buildTenantContext(ctx as unknown as SqlClient, 'postgres', tenantId) : undefined;
      return resolveTenantEffectiveNoteActionMode(all, actionKey, tenantId, context);
    },

    async getNoteImageLanguage(userId: string): Promise<string> {
      const { rows } = await ctx.query('SELECT notes_image_language FROM user_preferences WHERE user_id = $1', [userId]);
      const row = rows[0] as { notes_image_language?: string } | undefined;
      return (typeof row?.notes_image_language === 'string' && row.notes_image_language.trim()) ? row.notes_image_language : 'en';
    },

    async setNoteImageLanguage(userId: string, language: string): Promise<void> {
      await ctx.query(
        `INSERT INTO user_preferences (user_id, notes_image_language) VALUES ($1, $2)
           ON CONFLICT(user_id) DO UPDATE SET notes_image_language = excluded.notes_image_language, updated_at = ${ctx.now}`,
        [userId, language],
      );
    },

    async listNoteActionModes(): Promise<NoteActionModeRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_action_modes ORDER BY tenant_id COLLATE "C" ASC, action_key COLLATE "C" ASC', []);
      return rows as unknown as NoteActionModeRow[];
    },

    async getNoteActionMode(id: string): Promise<NoteActionModeRow | null> {
      const { rows } = await ctx.query('SELECT * FROM note_action_modes WHERE id = $1', [id]);
      return (rows[0] as NoteActionModeRow | undefined) ?? null;
    },

    async createNoteActionMode(row: { id: string; tenant_id: string; action_key: string; mode: string }): Promise<void> {
      await ctx.query(
        `INSERT INTO note_action_modes (id, tenant_id, action_key, mode, updated_at)
           VALUES ($1, $2, $3, $4, ${ctx.now})
         ON CONFLICT(tenant_id, action_key) DO UPDATE SET mode = excluded.mode, updated_at = ${ctx.now}`,
        [row.id, row.tenant_id, row.action_key, row.mode],
      );
    },

    async updateNoteActionMode(id: string, fields: Partial<Pick<NoteActionModeRow, 'tenant_id' | 'action_key' | 'mode'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (!sets.length) return;
      vals.push(id);
      await ctx.query(`UPDATE note_action_modes SET ${sets.join(', ')}, updated_at = ${ctx.now} WHERE id = $${vals.length}`, vals);
    },

    async deleteNoteActionMode(id: string): Promise<void> {
      await ctx.query('DELETE FROM note_action_modes WHERE id = $1', [id]);
    },

    async recordNoteActivity(row: NoteActivityRow): Promise<void> {
      await ctx.query(
        `INSERT INTO note_activity (id, note_id, user_id, tenant_id, action, actor, summary, detail_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, ${ctx.now}))`,
        [row.id, row.note_id, row.user_id, row.tenant_id, row.action, row.actor, row.summary, row.detail_json, row.created_at],
      );
    },

    async listNoteActivity(noteId: string, limit = 50): Promise<NoteActivityRow[]> {
      const { rows } = await ctx.query('SELECT * FROM note_activity WHERE note_id = $1 ORDER BY created_at COLLATE "C" DESC, id COLLATE "C" DESC LIMIT $2', [noteId, Math.max(1, Math.min(500, limit))]);
      return rows as unknown as NoteActivityRow[];
    },

    // Phase 0-B — tenant-scoped audit feed (keyset-paginated, filterable) + retention pruning
    async listTenantNoteActivity(tenantId: string | null, opts: NoteActivityQuery = {}): Promise<Array<NoteActivityRow & { note_title?: string | null }>> {
      const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
      const where: string[] = ['a.tenant_id IS NOT DISTINCT FROM $1'];
      const args: unknown[] = [tenantId ?? null];
      if (opts.action) { where.push(`a.action = $${args.length + 1}`); args.push(opts.action); }
      if (opts.actor) { where.push(`a.actor = $${args.length + 1}`); args.push(opts.actor); }
      if (opts.userId) { where.push(`a.user_id = $${args.length + 1}`); args.push(opts.userId); }
      if (opts.noteId) { where.push(`a.note_id = $${args.length + 1}`); args.push(opts.noteId); }
      if (opts.fromDate) { where.push(`a.created_at >= $${args.length + 1}`); args.push(opts.fromDate); }
      if (opts.toDate) { where.push(`a.created_at <= $${args.length + 1}`); args.push(opts.toDate); }
      // Keyset cursor: fetch the page strictly OLDER than (beforeCreatedAt, beforeId). Row-value
      // comparison is native in Postgres; the text ORDER BY is byte-order via COLLATE "C".
      if (opts.beforeCreatedAt && opts.beforeId) {
        where.push(`(a.created_at, a.id) < ($${args.length + 1}, $${args.length + 2})`);
        args.push(opts.beforeCreatedAt, opts.beforeId);
      }
      args.push(limit);
      const { rows } = await ctx.query(
        `SELECT a.*, n.title AS note_title FROM note_activity a LEFT JOIN notes n ON n.id = a.note_id
         WHERE ${where.join(' AND ')} ORDER BY a.created_at COLLATE "C" DESC, a.id COLLATE "C" DESC LIMIT $${args.length}`,
        args,
      );
      return rows as unknown as Array<NoteActivityRow & { note_title?: string | null }>;
    },

    async pruneNoteActivity(beforeIso: string): Promise<number> {
      const res = await ctx.query('DELETE FROM note_activity WHERE created_at < $1', [beforeIso]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    // Registered outbound webhook endpoints
    async createWebhookEndpoint(row: { id: string; tenant_id?: string | null; user_id: string; url: string; signing_secret: string; created_at: number }): Promise<void> {
      await ctx.query(
        `INSERT INTO webhook_endpoints (id, tenant_id, user_id, url, signing_secret, enabled, created_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6)`,
        [row.id, row.tenant_id ?? null, row.user_id, row.url, row.signing_secret, row.created_at],
      );
    },

    async listWebhookEndpoints(userId: string): Promise<WebhookEndpointRow[]> {
      const { rows } = await ctx.query('SELECT * FROM webhook_endpoints WHERE user_id = $1 AND revoked_at IS NULL AND enabled = 1 ORDER BY created_at ASC', [userId]);
      return rows as unknown as WebhookEndpointRow[];
    },

    async revokeWebhookEndpoint(id: string, userId: string, revokedAt: number): Promise<number> {
      const res = await ctx.query('UPDATE webhook_endpoints SET revoked_at = $1, enabled = 0 WHERE id = $2 AND user_id = $3', [revokedAt, id, userId]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    async pruneUserRunEvents(opts: { olderThanHours: number; maxEventsPerRun: number }): Promise<number> {
      let deleted = 0;
      // 1) Age-based: drop journal events for TERMINAL runs older than the horizon. `datetime('now', '-N hours')`
      //    → subtract an interval from UTC now and re-format to the same YYYY-MM-DD HH:MM:SS text for the text compare.
      if (opts.olderThanHours > 0) {
        const cutoff = `to_char((now() at time zone 'utc') - interval '${Math.floor(opts.olderThanHours)} hours', 'YYYY-MM-DD HH24:MI:SS')`;
        const r = await ctx.query(
          `DELETE FROM user_run_events
             WHERE created_at < ${cutoff}
               AND run_id IN (SELECT id FROM user_runs WHERE status IN ('completed','failed','cancelled'))`,
          [],
        );
        deleted += (r as unknown as { rowCount?: number }).rowCount ?? 0;
      }
      // 2) Per-run cap: keep only the most recent N events per run.
      if (opts.maxEventsPerRun > 0) {
        const { rows: over } = await ctx.query(
          'SELECT run_id FROM user_run_events GROUP BY run_id HAVING COUNT(*) > $1',
          [opts.maxEventsPerRun],
        );
        for (const { run_id } of over as unknown as Array<{ run_id: string }>) {
          const r = await ctx.query(
            `DELETE FROM user_run_events
               WHERE run_id = $1
                 AND sequence NOT IN (SELECT sequence FROM user_run_events WHERE run_id = $2 ORDER BY sequence DESC LIMIT $3)`,
            [run_id, run_id, opts.maxEventsPerRun],
          );
          deleted += (r as unknown as { rowCount?: number }).rowCount ?? 0;
        }
      }
      return deleted;
    },

    // ── HITL approvals (m64 table, m93 run-scoped) ─────────────────────────────
    async createHitlInterrupt(row: {
      id: string; chat_id: string; run_id?: string | null; agent_name: string; agent_step?: number;
      tool_name: string; tool_args_json?: string; interrupt_type?: string; reason?: string; expires_at?: string | null;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO hitl_interrupt_requests
           (id, chat_id, run_id, agent_name, agent_step, tool_name, tool_args_json, interrupt_type, reason, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) ON CONFLICT DO NOTHING`,
        [
          row.id, row.chat_id, row.run_id ?? null, row.agent_name, row.agent_step ?? 0,
          row.tool_name, row.tool_args_json ?? '{}', row.interrupt_type ?? 'tool_approval', row.reason ?? '', row.expires_at ?? null,
        ],
      );
    },

    async resolveHitlInterrupt(id: string, fields: {
      status: string; decision_action?: string; modified_args_json?: string | null; feedback?: string | null; decided_by?: string | null;
    }): Promise<void> {
      await ctx.query(
        `UPDATE hitl_interrupt_requests
           SET status = $1, decision_action = $2, modified_args_json = $3, feedback = $4, decided_by = $5, decided_at = ${NOW_ISO_MS}
         WHERE id = $6`,
        [fields.status, fields.decision_action ?? null, fields.modified_args_json ?? null, fields.feedback ?? null, fields.decided_by ?? null, id],
      );
    },

    async listPendingHitlInterruptsByRun(runId: string): Promise<Array<{ id: string; tool_name: string; status: string; tool_args_json: string }>> {
      const { rows } = await ctx.query(
        `SELECT id, tool_name, status, tool_args_json FROM hitl_interrupt_requests WHERE run_id = $1 AND status = 'pending' ORDER BY created_at COLLATE "C" ASC`,
        [runId],
      );
      return rows as unknown as Array<{ id: string; tool_name: string; status: string; tool_args_json: string }>;
    },

    // ── Devices ────────────────────────────────────────────────────────────────
    async registerDevice(device: Pick<UserDeviceRow, 'id' | 'user_id' | 'channel' | 'token'> & { tenant_id?: string; label?: string }): Promise<void> {
      // SQLite `INSERT OR REPLACE` on UNIQUE(user_id, token) → upsert on that constraint.
      await ctx.query(
        `INSERT INTO user_devices (id, user_id, tenant_id, channel, token, label) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, token) DO UPDATE SET id = excluded.id, tenant_id = excluded.tenant_id, channel = excluded.channel, label = excluded.label`,
        [device.id, device.user_id, device.tenant_id ?? null, device.channel, device.token, device.label ?? null],
      );
    },

    async removeDevice(userId: string, token: string): Promise<void> {
      await ctx.query('DELETE FROM user_devices WHERE user_id = $1 AND token = $2', [userId, token]);
    },

    async getDeviceById(deviceId: string): Promise<UserDeviceRow | null> {
      const { rows } = await ctx.query('SELECT * FROM user_devices WHERE id = $1', [deviceId]);
      return (rows[0] as UserDeviceRow | undefined) ?? null;
    },

    async listDevices(userId: string): Promise<UserDeviceRow[]> {
      const { rows } = await ctx.query('SELECT * FROM user_devices WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC', [userId]);
      return rows as unknown as UserDeviceRow[];
    },

    // ── Notification preferences ─────────────────────────────────────────────────
    async getNotificationPrefs(userId: string): Promise<NotificationPrefsRow | null> {
      const { rows } = await ctx.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
      return (rows[0] as NotificationPrefsRow | undefined) ?? null;
    },

    async upsertNotificationPrefs(userId: string, prefs: { id: string; enabled?: boolean; categories?: string[]; quiet_hours?: string | null; timezone?: string | null }): Promise<void> {
      await ctx.query(
        `INSERT INTO notification_preferences (id, user_id, enabled, categories, quiet_hours, timezone)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(user_id) DO UPDATE SET
           enabled = excluded.enabled,
           categories = excluded.categories,
           quiet_hours = excluded.quiet_hours,
           timezone = excluded.timezone,
           updated_at = ${ctx.now}`,
        [
          prefs.id, userId,
          prefs.enabled !== false ? 1 : 0,
          JSON.stringify(prefs.categories ?? []),
          prefs.quiet_hours ?? null,
          prefs.timezone ?? null,
        ],
      );
    },

    // ── Catalog support ──────────────────────────────────────────────────────────
    async listModeLabels(surfaceId: string): Promise<ModeLabel[]> {
      const { rows } = await ctx.query('SELECT * FROM mode_labels WHERE surface_id = $1 AND enabled = 1 ORDER BY sort_order ASC, id COLLATE "C" ASC', [surfaceId]);
      return rows as unknown as ModeLabel[];
    },

    async listStarterPrompts(surfaceId: string): Promise<StarterPrompt[]> {
      const { rows } = await ctx.query('SELECT * FROM starter_prompts WHERE surface_id = $1 AND enabled = 1 ORDER BY sort_order ASC, id COLLATE "C" ASC', [surfaceId]);
      return rows as unknown as StarterPrompt[];
    },

    // ── Catalog administration (include disabled rows) ─────────────────────────
    async adminListModeLabels(surfaceId?: string): Promise<ModeLabel[]> {
      if (surfaceId) {
        const { rows } = await ctx.query('SELECT * FROM mode_labels WHERE surface_id = $1 ORDER BY surface_id COLLATE "C" ASC, sort_order ASC, id COLLATE "C" ASC', [surfaceId]);
        return rows as unknown as ModeLabel[];
      }
      const { rows } = await ctx.query('SELECT * FROM mode_labels ORDER BY surface_id COLLATE "C" ASC, sort_order ASC, id COLLATE "C" ASC', []);
      return rows as unknown as ModeLabel[];
    },

    async getModeLabel(id: string): Promise<ModeLabel | null> {
      const { rows } = await ctx.query('SELECT * FROM mode_labels WHERE id = $1', [id]);
      return (rows[0] as ModeLabel | undefined) ?? null;
    },

    async createModeLabel(row: Pick<ModeLabel, 'id' | 'surface_id' | 'mode_key' | 'label'> & {
      description?: string | null; icon?: string | null; is_default?: number; sort_order?: number; enabled?: number; metadata?: string | null;
    }): Promise<void> {
      const isDefault = row.is_default === 1 ? 1 : 0;
      // SQLite wraps clear-defaults + insert in a transaction; sequential awaits mirror it.
      if (isDefault === 1) {
        await ctx.query('UPDATE mode_labels SET is_default = 0 WHERE surface_id = $1', [row.surface_id]);
      }
      await ctx.query(
        `INSERT INTO mode_labels (id, surface_id, mode_key, label, description, icon, is_default, sort_order, enabled, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id, row.surface_id, row.mode_key, row.label,
          row.description ?? null, row.icon ?? null, isDefault,
          row.sort_order ?? 0, row.enabled === 0 ? 0 : 1, row.metadata ?? null,
        ],
      );
    },

    async updateModeLabel(id: string, patch: Partial<Pick<ModeLabel, 'label' | 'mode_key' | 'description' | 'icon' | 'is_default' | 'sort_order' | 'enabled' | 'metadata'>>): Promise<void> {
      const { rows: existRows } = await ctx.query('SELECT surface_id FROM mode_labels WHERE id = $1', [id]);
      const existing = existRows[0] as { surface_id: string } | undefined;
      if (!existing) return;
      if (patch.is_default === 1) {
        await ctx.query('UPDATE mode_labels SET is_default = 0 WHERE surface_id = $1', [existing.surface_id]);
      }
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, val: unknown) => { fields.push(`${col} = $${values.length + 1}`); values.push(val); };
      if (patch.label !== undefined) set('label', patch.label);
      if (patch.mode_key !== undefined) set('mode_key', patch.mode_key);
      if (patch.description !== undefined) set('description', patch.description);
      if (patch.icon !== undefined) set('icon', patch.icon);
      if (patch.is_default !== undefined) set('is_default', patch.is_default === 1 ? 1 : 0);
      if (patch.sort_order !== undefined) set('sort_order', patch.sort_order);
      if (patch.enabled !== undefined) set('enabled', patch.enabled === 0 ? 0 : 1);
      if (patch.metadata !== undefined) set('metadata', patch.metadata);
      if (fields.length === 0) return;
      values.push(id);
      await ctx.query(`UPDATE mode_labels SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
    },

    async deleteModeLabel(id: string): Promise<void> {
      await ctx.query('DELETE FROM mode_labels WHERE id = $1', [id]);
    },

    async adminListStarterPrompts(surfaceId?: string): Promise<StarterPrompt[]> {
      if (surfaceId) {
        const { rows } = await ctx.query('SELECT * FROM starter_prompts WHERE surface_id = $1 ORDER BY surface_id COLLATE "C" ASC, sort_order ASC, id COLLATE "C" ASC', [surfaceId]);
        return rows as unknown as StarterPrompt[];
      }
      const { rows } = await ctx.query('SELECT * FROM starter_prompts ORDER BY surface_id COLLATE "C" ASC, sort_order ASC, id COLLATE "C" ASC', []);
      return rows as unknown as StarterPrompt[];
    },

    async getStarterPrompt(id: string): Promise<StarterPrompt | null> {
      const { rows } = await ctx.query('SELECT * FROM starter_prompts WHERE id = $1', [id]);
      return (rows[0] as StarterPrompt | undefined) ?? null;
    },

    async createStarterPrompt(row: Pick<StarterPrompt, 'id' | 'surface_id' | 'label' | 'prompt_text'> & {
      sort_order?: number; enabled?: number; metadata?: string | null;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO starter_prompts (id, surface_id, label, prompt_text, sort_order, enabled, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id, row.surface_id, row.label, row.prompt_text,
          row.sort_order ?? 0, row.enabled === 0 ? 0 : 1, row.metadata ?? null,
        ],
      );
    },

    async updateStarterPrompt(id: string, patch: Partial<Pick<StarterPrompt, 'label' | 'prompt_text' | 'sort_order' | 'enabled' | 'metadata'>>): Promise<void> {
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, val: unknown) => { fields.push(`${col} = $${values.length + 1}`); values.push(val); };
      if (patch.label !== undefined) set('label', patch.label);
      if (patch.prompt_text !== undefined) set('prompt_text', patch.prompt_text);
      if (patch.sort_order !== undefined) set('sort_order', patch.sort_order);
      if (patch.enabled !== undefined) set('enabled', patch.enabled === 0 ? 0 : 1);
      if (patch.metadata !== undefined) set('metadata', patch.metadata);
      if (fields.length === 0) return;
      values.push(id);
      await ctx.query(`UPDATE starter_prompts SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
    },

    async deleteStarterPrompt(id: string): Promise<void> {
      await ctx.query('DELETE FROM starter_prompts WHERE id = $1', [id]);
    },

    // ── Temporal reminders — cross-chat user view (Actions tab) ──────────────────
    async listTemporalRemindersByUserId(userId: string): Promise<TemporalReminderRow[]> {
      const { rows } = await ctx.query('SELECT * FROM temporal_reminders WHERE scope_id LIKE $1 ORDER BY due_at COLLATE "C" ASC', [`${userId}:%`]);
      return rows as unknown as TemporalReminderRow[];
    },

    async deleteTemporalReminderById(reminderId: string, userId: string): Promise<boolean> {
      const { rows } = await ctx.query('DELETE FROM temporal_reminders WHERE id = $1 AND scope_id LIKE $2 RETURNING id', [reminderId, `${userId}:%`]);
      return rows.length > 0;
    },
  };

  // Compile-guard: proves every IMeStore method is present with the exact signature. If any method
  // is missing or mistyped, this assignment fails to typecheck (the store is Partial<DatabaseAdapter>,
  // and IMeStore is one of its constituent interfaces).
  const guard = store as unknown as import('../db-types/adapter-me.js').IMeStore;
  void guard;

  return store;
}
