/**
 * GeneWeave — DbToolAuditEmitter
 *
 * Phase 3 of the Tool Platform. Persists every ToolAuditEvent emitted by the
 * policy-enforced registry into the `tool_audit_events` SQLite table.
 *
 * Replace the `consoleAuditEmitter` stub in ChatEngine with this implementation
 * so every tool invocation produces a durable, queryable audit record.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { ToolAuditEmitter } from '@weaveintel/tools';
import type { ToolAuditEvent } from '@weaveintel/core';
import type { DatabaseAdapter } from './db-types.js';

export class DbToolAuditEmitter implements ToolAuditEmitter {
  constructor(private readonly db: DatabaseAdapter) {}

  async emit(event: ToolAuditEvent): Promise<void> {
    try {
      await this.db.insertToolAuditEvent({
        id: newUUIDv7(),
        tool_name: event.toolName,
        chat_id: event.chatId ?? null,
        user_id: event.userId ?? null,
        agent_persona: event.agentPersona ?? null,
        skill_key: event.skillKey ?? null,
        policy_id: event.policyId ?? null,
        outcome: event.outcome,
        violation_reason: event.violationReason ?? null,
        duration_ms: event.durationMs ?? null,
        input_preview: event.inputPreview ?? null,
        output_preview: event.outputPreview ?? null,
        error_message: event.errorMessage ?? null,
        metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      });
    } catch (err) {
      // Audit persistence is best-effort — never block the main request path.
      process.stderr.write(`[DbToolAuditEmitter] Failed to persist audit event for '${event.toolName}': ${err}\n`);
    }
  }
}
