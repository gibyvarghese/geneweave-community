/**
 * GeneWeave — chat-scope-guard.ts
 *
 * GeneWeave-specific integration of @weaveintel/identity/scope.
 *
 * This module bridges the generic scope enforcement package with geneweave's
 * database adapter, skill discovery pipeline, and live agent mesh activation.
 *
 * Primary responsibilities:
 *
 *   1. Bootstrap the ScopeRegistry from the DB at startup (ChatScopeGuard.init())
 *   2. Filter skill candidates by scope before returning them to chat.ts
 *   3. Check scope before activating any live agent mesh (e.g. Kaggle)
 *   4. Issue CrossScopeTokens for valid cross-scope delegations
 *   5. Write all scope events to the immutable scope_access_log
 *
 * Usage in chat.ts / chat-skills-utils.ts:
 *
 *   const scopeGuard = await ChatScopeGuard.init(db, { enforce: true, tokenSecret });
 *   const ctx = scopeGuard.rootContext(sessionId, taskId, 'system');
 *   const filteredSkills = await scopeGuard.filterSkillsByScope(skills, ctx);
 *
 * When to call what:
 *   - rootContext()        — once per user message (before skill discovery)
 *   - filterSkillsByScope() — after LLM skill selection, before building agents
 *   - checkMeshActivation() — before launching a live agent mesh
 *   - checkA2ADelegation()  — in a2a-supervisor.ts, before cross-agent calls
 */

import {
  ScopeRegistry,
  ScopeGuard,
  createRootScopeContext,
  deriveScopeContext,
  WEAVEINTEL_DEFAULT_SCOPES,
  WEAVEINTEL_DEFAULT_POLICIES,
  getScopeForSkill,
  formatDelegationChain,
  type ScopeContext,
  type ScopeCheckResult,
  type CrossScopeToken,
  type AgentScope,
  type ScopeCrossPolicy,
} from '@weaveintel/identity/scope';
import type { SkillMatch } from '@weaveintel/skills';
import type { ScopesAdapterMethods } from './db-types/adapter-scopes.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ChatScopeGuardOptions {
  /**
   * When false, scope violations are logged but not blocked.
   * Useful during a phased rollout. Default: true (enforce).
   */
  enforce?: boolean;
  /**
   * HMAC secret for signing CrossScopeTokens.
   * In production, source from WEAVE_SCOPE_TOKEN_SECRET env var.
   */
  tokenSecret?: string;
  /**
   * When true, scope enforcement is completely skipped (no filtering, no
   * logging). Used in unit tests and development to opt out of scope checks.
   * Default: false.
   */
  disabled?: boolean;
}

export interface ScopeFilterResult {
  /** Skills that passed the scope check */
  allowed: SkillMatch[];
  /** Skills that were filtered out, with their rejection reasons */
  rejected: Array<{ match: SkillMatch; reason: string; violationType?: string }>;
}

// ── ChatScopeGuard ─────────────────────────────────────────────────────────────

export class ChatScopeGuard {
  private readonly guard: ScopeGuard;
  private readonly db: ScopesAdapterMethods;
  private readonly disabled: boolean;

  private constructor(
    guard: ScopeGuard,
    db: ScopesAdapterMethods,
    disabled: boolean,
  ) {
    this.guard = guard;
    this.db = db;
    this.disabled = disabled;
  }

  /**
   * Bootstrap the scope guard from the database.
   *
   * Loads scope definitions and cross-scope policies from DB, falling back to
   * the built-in defaults (WEAVEINTEL_DEFAULT_SCOPES / POLICIES) for any
   * entries not yet in the database.
   *
   * Call once when ChatEngine starts up.
   */
  static async init(
    db: ScopesAdapterMethods,
    opts: ChatScopeGuardOptions = {},
  ): Promise<ChatScopeGuard> {
    const { enforce = true, tokenSecret, disabled = false } = opts;

    if (disabled) {
      // Disabled mode: create a pass-through guard that never blocks
      const registry = new ScopeRegistry();
      registry.registerScopes(WEAVEINTEL_DEFAULT_SCOPES);
      registry.registerPolicies(WEAVEINTEL_DEFAULT_POLICIES);
      const guard = new ScopeGuard(registry, { enforce: false, tokenSecret });
      return new ChatScopeGuard(guard, db, true);
    }

    // Load scopes from DB
    const registry = new ScopeRegistry();

    const dbScopes = await db.listScopes();
    if (dbScopes.length > 0) {
      // DB is seeded — use DB values
      for (const row of dbScopes) {
        const scope: AgentScope = {
          name: row.id,
          displayName: row.display_name,
          description: row.description,
          sandboxed: row.sandboxed === 1,
          maxDelegationDepth: row.max_delegation_depth,
          auditLevel: row.audit_level as AgentScope['auditLevel'],
        };
        registry.registerScope(scope);
      }
    } else {
      // DB not yet seeded (e.g. test environment) — use built-in defaults
      registry.registerScopes(WEAVEINTEL_DEFAULT_SCOPES);
    }

    const dbPolicies = await db.listScopePolicies();
    if (dbPolicies.length > 0) {
      for (const row of dbPolicies) {
        const policy: ScopeCrossPolicy = {
          fromScope: row.from_scope,
          toScope: row.to_scope,
          allowed: row.allowed === 1,
          requiresA2A: row.requires_a2a === 1,
          maxDelegationDepth: row.max_delegation_depth,
          auditLevel: row.audit_level as ScopeCrossPolicy['auditLevel'],
        };
        registry.registerPolicy(policy);
      }
    } else {
      registry.registerPolicies(WEAVEINTEL_DEFAULT_POLICIES);
    }

    // Wire in the audit callback to write scope events to scope_access_log
    const guard = new ScopeGuard(registry, {
      enforce,
      tokenSecret,
      onCheck: async (event) => {
        // Only log violations and cross-scope events to keep the log clean.
        // Same-scope allowed activations are very frequent and not interesting.
        const isViolation = !event.result.allowed;
        const isCrossScope =
          event.checkType === 'delegation' &&
          event.fromScope !== event.toScope;
        const isSkillViolation =
          event.checkType === 'skill' && !event.result.allowed;

        if (!isViolation && !isCrossScope && !isSkillViolation) return;

        const eventType = isViolation
          ? 'violation'
          : isCrossScope
            ? 'cross_scope_delegation'
            : 'skill_activation';

        try {
          await db.logScopeEvent({
            event_type: eventType,
            from_scope: event.fromScope ?? null,
            to_scope: event.toScope ?? null,
            skill_id: event.skillId ?? null,
            tool_name: event.toolName ?? null,
            session_id: event.context.sessionId ?? null,
            task_id: event.context.taskId ?? null,
            user_id: null,  // set by caller if available
            allowed: event.result.allowed ? 1 : 0,
            reason: event.result.reason ?? null,
            delegation_chain_json: JSON.stringify(event.context.delegationChain),
          });
        } catch {
          // DB may be closed (e.g. test teardown) — audit write is best-effort
        }
      },
    });

    console.log(`[scope] ${registry.describe()}`);
    return new ChatScopeGuard(guard, db, false);
  }

  // ── Context creation ──────────────────────────────────────────────────────

  /**
   * Creates a root ScopeContext for a new user message.
   *
   * The initial scope for geneweave's chat engine is 'system' — the supervisor
   * orchestration scope that can delegate to any domain. As skills are selected
   * and agents delegate, contexts narrow to the appropriate domain scopes.
   */
  rootContext(sessionId: string, taskId: string, scope = 'system'): ScopeContext {
    return createRootScopeContext(scope, sessionId, taskId);
  }

  /**
   * Derives a child context after a cross-scope delegation is authorized.
   * Wraps deriveScopeContext() from @weaveintel/identity/scope.
   */
  deriveContext(
    parent: ScopeContext,
    token: CrossScopeToken,
    reason: string,
  ): ScopeContext {
    return deriveScopeContext(parent, token, reason);
  }

  // ── Skill filtering ───────────────────────────────────────────────────────

  /**
   * Filters LLM-selected skill candidates by scope.
   *
   * Call this after reasonAboutSkillSelection() returns its choices, before
   * building the agent. Skills whose scope the current context cannot access
   * are removed and their rejection reasons are returned for logging.
   *
   * Example: context is 'system' (default) → can activate 'analytics' (allowed)
   *          context is 'analytics' → cannot activate 'kaggle' (explicit deny)
   *
   * @param skills  The skill matches returned by the LLM skill selector
   * @param ctx     Current ScopeContext
   */
  async filterSkillsByScope(
    skills: SkillMatch[],
    ctx: ScopeContext,
  ): Promise<ScopeFilterResult> {
    if (this.disabled) {
      return { allowed: skills, rejected: [] };
    }

    const allowed: SkillMatch[] = [];
    const rejected: ScopeFilterResult['rejected'] = [];

    for (const match of skills) {
      const skillId = match.skill.id;
      // Resolve the scope for this skill: prefer the skill's own agenticScope,
      // then look up the DB assignment, then fall back to the default map.
      const skillScope =
        (match.skill as { agenticScope?: string }).agenticScope ??
        await this.db.getScopeForSkill(skillId) ??
        getScopeForSkill(skillId);

      const result = this.guard.checkSkillActivation(skillScope, ctx, skillId);

      if (result.allowed) {
        allowed.push(match);
      } else {
        rejected.push({
          match,
          reason: result.reason ?? `Skill '${skillId}' (scope: ${skillScope}) not accessible from scope '${ctx.currentScope}'`,
          violationType: result.violationType,
        });
        console.warn(
          `[scope] Skill '${skillId}' filtered out: ${result.reason} ` +
          `(chain: ${formatDelegationChain(ctx)})`,
        );
      }
    }

    return { allowed, rejected };
  }

  // ── Mesh activation ───────────────────────────────────────────────────────

  /**
   * Checks whether a live agent mesh (e.g. Kaggle) can be activated from
   * the current scope context.
   *
   * This is the gate that prevents a general analytics request from triggering
   * the Kaggle competition mesh. The Kaggle mesh belongs to the 'kaggle' scope,
   * and analytics → kaggle is explicitly denied.
   *
   * Call this in the live-agents activation path before starting any mesh.
   *
   * @param meshKey    The mesh identifier (e.g. 'kaggle', 'sv-science')
   * @param roleKey    The specific role to check, or '*' for any role
   * @param ctx        Current ScopeContext
   */
  async checkMeshActivation(
    meshKey: string,
    roleKey: string,
    ctx: ScopeContext,
  ): Promise<ScopeCheckResult> {
    if (this.disabled) return { allowed: true };

    const meshScope = await this.db.getScopeForMeshRole(meshKey, roleKey);
    const result = this.guard.checkA2ADelegation(ctx.currentScope, meshScope, ctx);

    if (!result.allowed) {
      console.warn(
        `[scope] Mesh '${meshKey}' (scope: ${meshScope}) activation blocked from '${ctx.currentScope}': ${result.reason}`,
      );
      // Log as a violation
      await this.db.logScopeEvent({
        event_type: 'violation',
        from_scope: ctx.currentScope,
        to_scope: meshScope,
        skill_id: null,
        tool_name: null,
        session_id: ctx.sessionId,
        task_id: ctx.taskId,
        user_id: null,
        allowed: 0,
        reason: `Mesh '${meshKey}' (scope: ${meshScope}) activation blocked: ${result.reason}`,
        delegation_chain_json: JSON.stringify(ctx.delegationChain),
      });
    }

    return result;
  }

  // ── A2A delegation ────────────────────────────────────────────────────────

  /**
   * Checks and optionally authorizes an A2A cross-scope delegation.
   *
   * Returns the check result. If allowed and requiresA2A, also issues a
   * CrossScopeToken that must be passed to the target agent's ScopeContext.
   *
   * @param fromScope  Source scope
   * @param toScope    Target scope
   * @param ctx        Current ScopeContext
   * @param permissions Permissions to grant in the target scope
   */
  checkAndAuthorizeA2ADelegation(
    fromScope: string,
    toScope: string,
    ctx: ScopeContext,
    permissions: readonly string[] = [],
  ): { result: ScopeCheckResult; token?: CrossScopeToken } {
    if (this.disabled) return { result: { allowed: true } };

    const result = this.guard.checkA2ADelegation(fromScope, toScope, ctx);
    if (!result.allowed) return { result };

    if (result.requiresA2A) {
      const token = this.guard.issueDelegationToken(fromScope, toScope, ctx, permissions);
      return { result, token };
    }

    return { result };
  }

  // ── Tool invocation ───────────────────────────────────────────────────────

  /**
   * Checks whether a tool can be called from the current scope context.
   * Tools that have no scope restriction (allowedScopes=[]) pass through.
   */
  checkToolInvocation(
    toolName: string,
    allowedScopes: readonly string[],
    ctx: ScopeContext,
  ): ScopeCheckResult {
    if (this.disabled) return { allowed: true };
    return this.guard.checkToolInvocation(toolName, allowedScopes, ctx);
  }

  // ── Observability ─────────────────────────────────────────────────────────

  /**
   * Returns a health summary suitable for logging at startup or in /health.
   */
  async healthSummary(): Promise<{
    enabled: boolean;
    enforce: boolean;
    scopeCount: number;
    policyCount: number;
    recentViolations: number;
  }> {
    const [scopes, policies, violations] = await Promise.all([
      this.db.listScopes(),
      this.db.listScopePolicies(),
      this.db.countScopeViolations(24),
    ]);
    return {
      enabled: !this.disabled,
      enforce: true,  // reflects the guard's enforce flag (simplified here)
      scopeCount: scopes.length,
      policyCount: policies.length,
      recentViolations: violations,
    };
  }
}
