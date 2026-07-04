/**
 * GeneWeave — DB-backed Tool Policy Resolver and Rate Limiter
 *
 * Implements the ToolPolicyResolver and ToolRateLimiter contracts
 * from @weaveintel/tools against the SQLite tool_policies and
 * tool_rate_limit_buckets tables.
 */

import type { EffectiveToolPolicy, ToolAuditEvent } from '@weaveintel/core';
import { createLogger } from '@weaveintel/core';
import type { ToolInput } from '@weaveintel/core';

const logger = createLogger('tool-audit');
import type {
  ToolPolicyResolver,
  PolicyResolutionContext,
  ToolRateLimiter,
  ToolAuditEmitter,
} from '@weaveintel/tools';
import { DEFAULT_TOOL_POLICY } from '@weaveintel/tools';
import type { DatabaseAdapter } from './db.js';

/**
 * Resolves the effective policy for a tool by querying the tool_policies table.
 *
 * Resolution order:
 *  1. skillPolicyKey from the resolution context (skill-level override)
 *  2. 'default' fallback policy
 *
 * Returns DEFAULT_TOOL_POLICY (pass-through) if no DB record is found or the record is disabled.
 */
export class DbToolPolicyResolver implements ToolPolicyResolver {
  constructor(private readonly db: DatabaseAdapter) {}

  async resolve(toolName: string, ctx?: PolicyResolutionContext): Promise<EffectiveToolPolicy> {
    // If the tool is explicitly enabled at the chat level, bypass the skill
    // policy so a wrongly-matched skill cannot block tools the operator
    // intentionally granted. Fall straight through to 'default'.
    const isExplicitlyEnabled = ctx?.explicitEnabledTools?.includes(toolName) ?? false;

    // Try the skill-scoped policy first (unless bypassed), then fall back to 'default'.
    const candidateKeys = [
      isExplicitlyEnabled ? undefined : ctx?.skillPolicyKey,
      'default',
    ].filter(Boolean) as string[];

    for (const key of candidateKeys) {
      const row = await this.db.getToolPolicyByKey(key);
      if (!row || !row.enabled) continue;

      // Check persona scope if configured
      if (row.persona_scope && ctx?.agentPersona) {
        const allowedPersonas: string[] = JSON.parse(row.persona_scope);
        if (allowedPersonas.length > 0 && !allowedPersonas.includes(ctx.agentPersona)) {
          continue;
        }
      }

      // Check expiry
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        continue;
      }

      // M-9: Enforce the active_hours_utc time window.
      // The column is stored as JSON `{ "start": "HH:MM", "end": "HH:MM" }` in
      // UTC. If the current UTC time falls outside the window, treat the policy
      // as if it does not exist (fall through to the next candidate key).
      // This allows operators to restrict tools to business hours, maintenance
      // windows, etc. without creating separate policies per time-of-day.
      if (row.active_hours_utc) {
        let window: { start?: string; end?: string } | null = null;
        try { window = JSON.parse(row.active_hours_utc) as { start?: string; end?: string }; } catch { window = null; }
        if (window?.start && window?.end) {
          const now = new Date();
          // Convert HH:MM strings to fractional hours for comparison.
          const toFrac = (hhmm: string): number => {
            const [h, m] = hhmm.split(':').map(Number);
            return (h ?? 0) + (m ?? 0) / 60;
          };
          const nowFrac = now.getUTCHours() + now.getUTCMinutes() / 60;
          const startFrac = toFrac(window.start);
          const endFrac = toFrac(window.end);
          // Handle windows that span midnight (e.g. start=22:00, end=06:00).
          const inWindow = startFrac <= endFrac
            ? nowFrac >= startFrac && nowFrac < endFrac
            : nowFrac >= startFrac || nowFrac < endFrac;
          if (!inWindow) continue;
        }
      }

      const allowedRiskLevels = row.allowed_risk_levels
        ? JSON.parse(row.allowed_risk_levels)
        : DEFAULT_TOOL_POLICY.allowedRiskLevels;

      return {
        ...DEFAULT_TOOL_POLICY,
        enabled: !!row.enabled,
        requiresApproval: !!row.approval_required,
        rateLimitPerMinute: row.rate_limit_per_minute ?? undefined,
        maxConcurrent: row.max_concurrent ?? undefined,
        timeoutMs: row.max_execution_ms ?? undefined,
        allowedRiskLevels,
        requireDryRun: !!row.require_dry_run,
        logInputOutput: !!row.log_input_output,
        source: 'global_policy',
        policyId: row.id,
      };
    }

    return DEFAULT_TOOL_POLICY;
  }
}

/**
 * SQLite-backed rate limiter using 1-minute tumbling windows.
 * Stored in tool_rate_limit_buckets with (tool_name, scope_key, window_start) uniqueness.
 */
export class DbToolRateLimiter implements ToolRateLimiter {
  constructor(private readonly db: DatabaseAdapter) {}

  private currentWindowStart(): string {
    const now = new Date();
    // Truncate to the current minute boundary (UTC).
    now.setSeconds(0, 0);
    return now.toISOString();
  }

  async check(toolName: string, scopeKey: string, limitPerMinute: number): Promise<boolean> {
    return this.db.checkAndIncrementRateLimit(
      toolName,
      scopeKey,
      this.currentWindowStart(),
      limitPerMinute,
    );
  }

  async remaining(toolName: string, scopeKey: string, limitPerMinute: number): Promise<number> {
    // M-10: Query the actual bucket count for the current 1-minute window so
    // callers get an accurate remaining-capacity value rather than always seeing
    // the full limit. This is read-only — it does NOT increment the counter.
    const windowStart = this.currentWindowStart();
    const used = await this.db.getToolRateLimitCount(toolName, scopeKey, windowStart);
    return Math.max(0, limitPerMinute - used);
  }
}

/**
 * Simple no-op audit emitter for environments where persistence is not required.
 * The full DB-backed emitter would persist to a tool_audit_events table.
 * Exposed here so callers can start wiring without a full audit table.
 */
export const consoleAuditEmitter: ToolAuditEmitter = {
  async emit(event: ToolAuditEvent): Promise<void> {
    if (event.outcome !== 'success') {
      logger.warn(`${event.toolName} → ${event.outcome}`, {
        chatId: event.chatId,
        violationReason: event.violationReason,
        policyId: event.policyId,
        durationMs: event.durationMs,
      });
    }
  },
};
