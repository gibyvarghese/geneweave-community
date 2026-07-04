/**
 * routes/me-compliance.ts — GDPR / privacy self-service endpoints
 *
 *   DELETE /api/me/account
 *     Initiates account deletion. Creates a durable compliance audit record via
 *     @weaveintel/guardrails/compliance, then immediately deletes all user data through
 *     the existing db.deleteUser() path. Returns 202 Accepted so callers can
 *     handle async semantics if a durable backend is added later.
 *
 *   GET /api/me/export
 *     Returns a portable JSON archive of all data held for the calling user:
 *     profile, conversations (with messages), notes, agenda items, and all
 *     AI-derived memory (semantic, episodic, entity, procedural).
 *     M5-4: memory tables were previously excluded; now included.
 *     Formatted for both human readability and machine import.
 */

import type { Router } from '../server-core.js';
import { json } from '../server-core.js';
import type { DatabaseAdapter } from '../db-types.js';
import type { WeaveRuntime } from '@weaveintel/core';
import {
  createDurableDeletionManager,
  createDurableAuditExportManager,
} from '@weaveintel/guardrails/compliance';

export function registerMeComplianceRoutes(
  router: Router,
  db: DatabaseAdapter,
  runtime?: WeaveRuntime,
): void {
  // Phase 6: prefer the runtime compliance slot (shared KV, no duplicate managers).
  // Fall back to per-route durable managers when the slot is absent (tests, legacy).
  const deletionManager = runtime?.compliance?.deletion
    ?? createDurableDeletionManager({ runtime, namespace: 'gdpr-deletion' });
  const exportManager = runtime?.compliance?.auditExport
    ?? createDurableAuditExportManager({ runtime, namespace: 'gdpr-export' });

  // ── DELETE /api/me/account ─────────────────────────────────────────────
  // GDPR Art. 17 / CCPA "right to delete". Requires the caller to supply their
  // current password or a confirmation token so accidental deletions cannot be
  // triggered by a stale session.  For now we accept an explicit `confirm: true`
  // body flag as the confirmation signal (UI must present a two-step dialogue).
  router.del('/api/me/account', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }

    // Require explicit confirmation in the request body to prevent CSRF-triggered deletions
    // even on sessions where the CSRF token matches. The 'confirm' field acts as
    // a second-factor acknowledgement from the UI.
    let body: { confirm?: unknown; reason?: unknown } = {};
    try {
      const { readBody } = await import('../server-core.js');
      const raw = await readBody(req);
      if (raw) body = JSON.parse(raw);
    } catch { /* empty body or invalid JSON — will fail the confirm check below */ }

    if (body.confirm !== true) {
      json(res, 400, { error: 'Account deletion requires { "confirm": true } in the request body' });
      return;
    }

    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : 'User-initiated self-service deletion';

    // Record the deletion request for the compliance audit trail
    const deletionReq = await deletionManager.create(
      auth.userId,
      auth.userId,
      reason,
      ['profile', 'conversations', 'messages', 'notes', 'agenda', 'memories', 'sessions'],
    );
    await deletionManager.process(deletionReq.id);

    try {
      // Perform the actual deletion via the existing db.deleteUser path which
      // cascades across all user-owned tables (chats, messages, sessions, notes,
      // agenda_items, etc. — see db-sqlite.ts deleteUser for the full cascade).
      await db.deleteUser(auth.userId);
      await deletionManager.complete(deletionReq.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deletionManager.fail(deletionReq.id, msg);
      json(res, 500, { error: 'Account deletion failed', details: msg.slice(0, 200) });
      return;
    }

    // 202 Accepted — data is gone synchronously in this implementation; the
    // 202 status signals to clients that they should treat this as async (no
    // guarantee of immediate completion) which is correct once a durable queue
    // is introduced.
    json(res, 202, {
      message: 'Account deletion initiated. All data has been scheduled for removal.',
      requestId: deletionReq.id,
    });
  }, { auth: true, csrf: true });

  // ── GET /api/me/export ─────────────────────────────────────────────────
  // GDPR Art. 20 / CCPA "right to data portability". Returns a portable JSON
  // archive of all data held for the authenticated user.
  // M5-4 fix: includes all AI-derived memory tables (semantic, episodic, entity,
  // procedural) which were previously excluded — 8,229 records affected in live DB.
  router.get('/api/me/export', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }

    const now = Date.now();
    const exportRecord = await exportManager.create(
      auth.userId,
      auth.userId,
      'json',
      ['profile', 'conversations', 'notes', 'agenda', 'memories'],
      0,
      now,
    );

    try {
      // Gather user profile
      const user = await db.getUserById(auth.userId);
      if (!user) {
        await exportManager.markFailed(exportRecord.id);
        json(res, 404, { error: 'User not found' });
        return;
      }

      // Gather conversations with messages
      const conversations = await db.listUserConversations(auth.userId, { filter: 'all', limit: 10_000 });
      const conversationsWithMessages = await Promise.all(
        conversations.map(async (conv) => {
          const messages = await db.getMessages(conv.id);
          return {
            id: conv.id,
            title: conv.title,
            mode: conv.mode,
            pinned: conv.pinned === 1,
            archived: conv.archived === 1,
            createdAt: conv.created_at,
            updatedAt: conv.updated_at,
            messages: messages
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                createdAt: m.created_at,
              })),
          };
        }),
      );

      // Gather notes
      const notes = await db.listNotes(auth.userId, { limit: 10_000 });

      // Gather agenda items
      const agendaItems = await db.listAgendaItems(auth.userId);

      // ── M5-4: AI-derived memory tables ────────────────────────────────
      // All four memory stores now included in the portability export.
      const [semanticMemories, episodicMemories, entityMemories, proceduralMemories] = await Promise.all([
        db.listSemanticMemory(auth.userId, 10_000),
        db.listEpisodicMemory(auth.userId, 10_000),
        db.listEntities(auth.userId),
        db.listProceduralMemory(auth.userId),
      ]);

      const recordCount =
        1 +
        conversationsWithMessages.length +
        notes.length +
        agendaItems.length +
        semanticMemories.length +
        episodicMemories.length +
        entityMemories.length +
        proceduralMemories.length;

      const archive = {
        exportedAt: new Date(now).toISOString(),
        exportId: exportRecord.id,
        subject: auth.userId,
        profile: {
          id: user.id,
          email: user.email,
          name: user.name,
          persona: user.persona,
          createdAt: user.created_at,
        },
        conversations: conversationsWithMessages,
        notes: notes.map((n) => ({
          id: n.id,
          title: n.title,
          bodyJson: n.doc_json,
          favorite: n.favorite === 1,
          sensitivity: n.sensitivity,
          createdAt: n.created_at,
          updatedAt: n.updated_at,
        })),
        agendaItems: agendaItems.map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          kind: a.kind,
          status: a.status,
          startAt: a.start_at,
          endAt: a.end_at,
          location: a.location,
          createdAt: a.created_at,
          updatedAt: a.updated_at,
        })),
        memories: {
          semantic: semanticMemories.map((m) => ({
            id: m.id,
            content: m.content,
            memoryType: m.memory_type,
            source: m.source,
            createdAt: m.created_at,
          })),
          episodic: episodicMemories.map((m) => ({
            id: m.id,
            role: m.message_role,
            content: m.content,
            importance: m.importance,
            tags: m.tags,
            createdAt: m.created_at,
          })),
          entity: entityMemories.map((e) => ({
            id: e.id,
            entityName: e.entity_name,
            entityType: e.entity_type,
            facts: e.facts,
            confidence: e.confidence,
            source: e.source,
            createdAt: e.created_at,
          })),
          procedural: proceduralMemories.map((p) => ({
            id: p.id,
            instructionDelta: p.instruction_delta,
            proposedBy: p.proposed_by,
            status: p.status,
            confidence: p.confidence,
            createdAt: p.created_at,
          })),
        },
      };

      const archiveJson = JSON.stringify(archive, null, 2);
      await exportManager.markReady(exportRecord.id, recordCount, Buffer.byteLength(archiveJson));

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="weaveintel-export-${auth.userId}-${new Date(now).toISOString().slice(0, 10)}.json"`,
        'Content-Length': Buffer.byteLength(archiveJson),
      });
      res.end(archiveJson);
    } catch (err) {
      await exportManager.markFailed(exportRecord.id);
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: 'Export failed', details: msg.slice(0, 200) });
    }
  }, { auth: true });
}
