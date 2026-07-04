/**
 * GeneWeave — DbToolApprovalGate (Phase 6)
 *
 * Implements the @weaveintel/tools `ToolApprovalGate` contract using the
 * `tool_approval_requests` SQLite table. When a policy-enforced tool call
 * requires operator approval, this gate:
 *
 *   1. Checks whether an approved request already exists for this tool + chat.
 *      If so, execution is permitted immediately.
 *   2. Checks whether a pending request already exists. If so, returns
 *      `{ status: 'pending', approvalRequestId }` so the LLM response can
 *      surface "awaiting approval" state to the user.
 *   3. Otherwise creates a new `tool_approval_requests` row with status
 *      `'pending'` and returns `{ status: 'pending', approvalRequestId }`.
 *
 * Operators approve or deny via `POST /api/admin/tool-approval-requests/:id/approve`
 * or `/deny`. Once approved the next tool invocation will find an approved row
 * and proceed without blocking.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { ToolApprovalGate, ApprovalDecision } from '@weaveintel/tools';
import type { ToolInput } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';

export class DbToolApprovalGate implements ToolApprovalGate {
  constructor(
    private readonly db: DatabaseAdapter,
    /** Optional: skill policy key that was active when the tool was invoked */
    private readonly skillPolicyKey?: string,
  ) {}

  async check(toolName: string, chatId: string, input: ToolInput): Promise<ApprovalDecision> {
    try {
      // 1. Is there already an approved request for this tool+chat? Allow immediately.
      const approved = await this.db.getApprovedToolRequest(toolName, chatId);
      if (approved) {
        return { status: 'approved' };
      }

      // 2. Is there already a pending request? Return its ID so the caller can
      //    surface "awaiting approval" state without creating a duplicate.
      const pending = await this.db.getPendingToolRequest(toolName, chatId);
      if (pending) {
        return { status: 'pending', approvalRequestId: pending.id };
      }

      // 3. No existing request — create a new one.
      const id = newUUIDv7();
      let inputJson = '{}';
      try {
        inputJson = JSON.stringify(input ?? {});
      } catch {
        // ignore serialisation errors — store empty object
      }

      await this.db.createToolApprovalRequest({
        id,
        tool_name: toolName,
        chat_id: chatId,
        user_id: null,
        input_json: inputJson,
        policy_key: null,
        skill_key: this.skillPolicyKey ?? null,
        status: 'pending',
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
      });

      return { status: 'pending', approvalRequestId: id };
    } catch (err) {
      // Gate failures are non-fatal — deny by default to be safe.
      return { status: 'denied', reason: `Approval gate error: ${String(err)}` };
    }
  }
}
