/**
 * GeneWeave: SQLite-backed AuditEmitter for @weaveintel/encryption.
 * Best-effort: failures are logged and swallowed, never thrown.
 */

import type { AuditEmitter, EncryptionAuditEvent } from '@weaveintel/encryption';
import type { DatabaseAdapter } from '../db-types.js';

export function createDbEncryptionAuditEmitter(db: DatabaseAdapter): AuditEmitter {
  return {
    async emit(event: EncryptionAuditEvent): Promise<void> {
      try {
        await db.insertEncryptionAudit({
          id: event.id,
          tenant_id: event.tenantId,
          event_kind: event.eventKind,
          actor: event.actor,
          details: event.details ? JSON.stringify(event.details) : null,
          created_at: event.createdAt,
        });
      } catch (err) {
        console.error('[encryption-audit] failed to persist event', { kind: event.eventKind, err });
      }
    },
  };
}
