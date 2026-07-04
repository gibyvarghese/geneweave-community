/**
 * Shared message-shaping utilities used by both the send and stream chat paths.
 *
 * H-15: `historyToMessages` was duplicated in chat-send-message.ts and
 * chat-stream-message.ts. Any change to history → Message mapping had to be
 * applied twice, with a risk of divergence.
 *
 * M-18: `extractToolEvidence` (the filter/map pipeline that builds the tool-
 * evidence string for guardrail context) was identically duplicated in both
 * files. Centralised here so guardrail context is computed consistently.
 */

import type { Message, AgentStep } from '@weaveintel/core';
import type { MessageRow } from './db.js';
import { SUPERVISOR_INTERNAL_TOOLS } from './chat-eval-utils.js';

// ── H-15: history → Message array ───────────────────────────────────────────

/**
 * Convert stored message rows to the `Message[]` shape expected by model
 * adapters. Preserves `role` as-is (stored values already match the union).
 */
export function historyToMessages(rows: MessageRow[]): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
  }));
}

// ── M-18: extract tool evidence string for guardrail context ─────────────────

/**
 * Build a single space-joined string of tool/delegation result content from
 * an agent step list. Used to populate `toolEvidence` in the guardrail context
 * so post-execution guardrails can inspect what tools returned, not just the
 * final LLM output.
 *
 * Excluded from evidence:
 *  - Non-tool/delegation steps (thinking, response)
 *  - Empty results and "(Worker returned no output)" sentinels
 *  - PLANNING/REASONING/SYNTHESIS/REFLECTION tagged results (internal reasoning)
 *  - Calls to internal supervisor routing tools (SUPERVISOR_INTERNAL_TOOLS)
 *
 * Returns `undefined` when no qualifying evidence exists so the guardrail
 * context omits the field entirely rather than passing an empty string.
 */
export function extractToolEvidence(steps: AgentStep[] | undefined | null): string | undefined {
  if (!steps?.length) return undefined;
  const evidence = steps
    .filter((s) => {
      if (s.type !== 'tool_call' && s.type !== 'delegation') return false;
      const result = (s.toolCall?.result ?? s.delegation?.result ?? '') as string;
      if (!result || result === '(Worker returned no output)') return false;
      if (/^\[(PLANNING|REASONING|SYNTHESIS|REFLECTION)\]/.test(result)) return false;
      if (s.type === 'tool_call' && SUPERVISOR_INTERNAL_TOOLS.has(s.toolCall?.name ?? '')) return false;
      return true;
    })
    .map((s) => (s.toolCall?.result ?? s.delegation?.result ?? '') as string)
    .join(' ');
  return evidence || undefined;
}
