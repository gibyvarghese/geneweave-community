/**
 * GeneWeave — scope-guard-registry.ts
 *
 * Wraps a ToolRegistry with cross-scope enforcement. Placed in the tool
 * execution chain AFTER createPolicyEnforcedRegistry() so scope checks run
 * inside the existing policy/audit/rate-limit envelope.
 *
 * Decision logic per tool invocation:
 *   callerScope === 'system' → fast-path allow (supervisor / admin contexts)
 *   toolScope   === 'system' → fast-path allow (utility tools accessible everywhere)
 *   callerScope === toolScope → same-domain call, no policy lookup needed
 *   otherwise:
 *     find matching policy in scope_cross_policies
 *     policy.allowed = false OR no policy → log violation, throw if sandboxed
 *     policy.allowed = true, requiresA2a = true  → log as 'delegation', allow
 *     policy.allowed = true, requiresA2a = false → log as 'allowed', allow
 */

import type { ToolRegistry, Tool, ExecutionContext } from '@weaveintel/core';

/** Resolved cross-scope policy data needed by the guard. */
export interface ScopePolicyResult {
  allowed: boolean;
  requiresA2a: boolean;
  /** True when violations in the caller's scope are hard-blocked (not just logged). */
  sandboxed: boolean;
}

/** Minimal event shape passed to scope_access_log. */
export interface ScopeLogEvent {
  event_type: string;           // 'allowed' | 'delegation' | 'violation'
  from_scope: string;
  to_scope: string;
  skill_id: string | null;
  tool_name: string | null;
  session_id: string | null;
  task_id: string | null;
  user_id: string | null;
  allowed: number;              // SQLite int: 1 = allowed, 0 = denied
  reason: string | null;
  delegation_chain_json: string | null;
}

/** All callbacks needed by the scope guard. Injected from ChatEngine. */
export interface ScopeGuardCallbacks {
  /** Scope the calling agent operates in.  'system' bypasses all checks. */
  callerScope: string;
  /** Returns the agentic_scope for a tool by its schema name or tool_key. 'system' if unknown. */
  getToolScope(toolName: string): Promise<string>;
  /**
   * Returns the applicable cross-scope policy for fromScope→toScope,
   * honouring wildcard to_scope='*' as a fallback.
   * Returns null if no matching policy exists (triggers default-deny).
   */
  checkPolicy(fromScope: string, toScope: string): Promise<ScopePolicyResult | null>;
  /** Appends an entry to scope_access_log. */
  logEvent(event: ScopeLogEvent): Promise<void>;
  /** Chat session ID — forwarded into scope_access_log.session_id. */
  sessionId?: string;
  /** User ID — forwarded into scope_access_log.user_id. */
  userId?: string;
}

/**
 * Returns a new ToolRegistry whose get() and list() return scope-checked
 * Tool objects. Execution is blocked or allowed according to policy.
 */
export function wrapWithScopeGuard(registry: ToolRegistry, opts: ScopeGuardCallbacks): ToolRegistry {
  function wrapTool(tool: Tool): Tool {
    const original = tool.invoke.bind(tool);
    return {
      schema: tool.schema,
      async invoke(ctx: ExecutionContext, input: import('@weaveintel/core').ToolInput) {
        const toolName = tool.schema.name;

        // Fast-path: system caller or system-scoped tool — no enforcement needed.
        const toolScope = await opts.getToolScope(toolName);
        if (
          opts.callerScope === 'system' ||
          toolScope === 'system' ||
          opts.callerScope === toolScope
        ) {
          return original(ctx, input);
        }

        // Cross-scope path: look up the governing policy.
        const policy = await opts.checkPolicy(opts.callerScope, toolScope);

        if (!policy || !policy.allowed) {
          const reason = policy
            ? `Policy explicitly denies ${opts.callerScope} → ${toolScope}`
            : `No cross-scope policy defined for ${opts.callerScope} → ${toolScope} (default deny)`;

          await opts.logEvent({
            event_type: 'violation',
            from_scope: opts.callerScope,
            to_scope: toolScope,
            skill_id: null,
            tool_name: toolName,
            session_id: opts.sessionId ?? null,
            task_id: null,
            user_id: opts.userId ?? null,
            allowed: 0,
            reason,
            delegation_chain_json: null,
          }).catch(() => { /* log failures must not abort execution */ });

          // Sandboxed scope → hard block; non-sandboxed → audit-only, let through.
          if (policy?.sandboxed ?? true) {
            throw new Error(
              `[ScopeGuard] Tool access denied: ${toolName} (${toolScope} scope) ` +
              `cannot be called from ${opts.callerScope} scope. ${reason}`,
            );
          }
          return original(ctx, input);
        }

        // Policy allows — log the crossing, then execute.
        const eventType = policy.requiresA2a ? 'delegation' : 'allowed';
        await opts.logEvent({
          event_type: eventType,
          from_scope: opts.callerScope,
          to_scope: toolScope,
          skill_id: null,
          tool_name: toolName,
          session_id: opts.sessionId ?? null,
          task_id: null,
          user_id: opts.userId ?? null,
          allowed: 1,
          reason: policy.requiresA2a
            ? `Cross-scope delegation ${opts.callerScope} → ${toolScope} (A2A pattern expected)`
            : `Policy allows ${opts.callerScope} → ${toolScope}`,
          delegation_chain_json: null,
        }).catch(() => { /* log failures must not abort execution */ });

        return original(ctx, input);
      },
    };
  }

  return {
    register(tool: Tool): void { registry.register(tool); },
    unregister(name: string): void { registry.unregister(name); },
    get(name: string): Tool | undefined {
      const t = registry.get(name);
      return t ? wrapTool(t) : undefined;
    },
    list(): Tool[] { return registry.list().map(wrapTool); },
    listByTag(tag: string): Tool[] { return registry.listByTag(tag).map(wrapTool); },
    toDefinitions() { return registry.toDefinitions(); },
  };
}
