/**
 * GeneWeave — chat-scope.test.ts
 *
 * Integration tests for the full agentic scope isolation stack in geneweave.
 * Tests the ChatScopeGuard against a real SQLite DB (same pattern as other
 * geneweave integration tests).
 *
 * Test categories:
 *   Positive  — valid skill selections and delegations
 *   Negative  — blocked scope crossings (analytics→kaggle, etc.)
 *   Security  — confused deputy, chain depth exhaustion, expired contexts
 *   Stress    — 1000 rapid scope checks, concurrent sessions
 *
 * The scenario that triggered this feature:
 *   User: "Can you review this sales data and find my hero product?"
 *   Expected: analytics scope activated, Kaggle mesh NOT triggered
 *   Before fix: Kaggle mesh was spuriously activated (scope bleed)
 *   After fix: scope guard blocks the analytics→kaggle crossing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteAdapter } from './db-sqlite.js';
import { ChatScopeGuard } from './chat-scope-guard.js';
import { createRootScopeContext, deriveScopeContext } from '@weaveintel/identity/scope';
import { issueCrossScopeToken } from '@weaveintel/identity/scope';
import type { ScopeContext } from '@weaveintel/identity/scope';
import type { SkillMatch } from '@weaveintel/skills';

const SECRET = 'test-scope-secret-do-not-use-in-production';

function makeTempDbPath(): string {
  return join(tmpdir(), `weaveintel-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// Build a minimal SkillMatch for testing without needing to load the full skill catalog
function makeSkillMatch(skillId: string, agenticScope?: string): SkillMatch {
  return {
    skill: {
      id: skillId,
      name: skillId,
      summary: `Test skill: ${skillId}`,
      enabled: true,
      ...(agenticScope ? { agenticScope } : {}),
    },
    score: 0.9,
    matchedPatterns: [],
    rationale: 'Test match',
    source: 'semantic' as const,
  };
}

describe('ChatScopeGuard — integration tests', () => {
  let db: SQLiteAdapter;
  let guard: ChatScopeGuard;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    await db.seedDefaultData();
    // Init the scope guard with DB-loaded scopes + strict enforcement
    guard = await ChatScopeGuard.init(db, { enforce: true, tokenSecret: SECRET });
  });

  afterEach(async () => {
    await db.close();
  });

  // ── DB seeding verification ─────────────────────────────────────────────────

  describe('DB seeding (m75)', () => {
    it('has all 7 default scopes in the DB', async () => {
      const scopes = await db.listScopes();
      const ids = scopes.map((s) => s.id);
      expect(ids).toContain('system');
      expect(ids).toContain('analytics');
      expect(ids).toContain('kaggle');
      expect(ids).toContain('code');
      expect(ids).toContain('browser');
      expect(ids).toContain('voice');
      expect(ids).toContain('memory');
    });

    it('kaggle scope has audit_level=alert', async () => {
      const scope = await db.getScope('kaggle');
      expect(scope?.audit_level).toBe('alert');
    });

    it('has analytics→kaggle DENY policy', async () => {
      const policies = await db.listScopePolicies();
      const deny = policies.find((p) => p.from_scope === 'analytics' && p.to_scope === 'kaggle');
      expect(deny).toBeDefined();
      expect(deny?.allowed).toBe(0);
    });

    it('maps data-pipeline skill to analytics scope', async () => {
      const scope = await db.getScopeForSkill('data-pipeline');
      expect(scope).toBe('analytics');
    });

    it('maps code-execution skill to code scope', async () => {
      const scope = await db.getScopeForSkill('code-execution');
      expect(scope).toBe('code');
    });

    it('maps unknown skill to system scope (permissive fallback)', async () => {
      const scope = await db.getScopeForSkill('unknown-skill-xyz');
      expect(scope).toBe('system');
    });

    it('maps kaggle mesh roles to kaggle scope', async () => {
      const scope = await db.getScopeForMeshRole('kaggle', 'strategist');
      expect(scope).toBe('kaggle');
    });

    it('maps unknown mesh to system scope (permissive fallback)', async () => {
      const scope = await db.getScopeForMeshRole('sv-science', 'analyst');
      expect(scope).toBe('system');
    });
  });

  // ── Positive: rootContext and scope derivation ──────────────────────────────

  describe('positive — context creation and scope resolution', () => {
    it('rootContext creates a valid system scope context', () => {
      const ctx = guard.rootContext('session-1', 'task-1');
      expect(ctx.currentScope).toBe('system');
      expect(ctx.delegationChain).toHaveLength(0);
      expect(ctx.sessionId).toBe('session-1');
      expect(ctx.taskId).toBe('task-1');
    });

    it('deriveContext creates a narrowed child context', () => {
      const parent = guard.rootContext('session-2', 'task-2', 'analytics');
      const token = issueCrossScopeToken('analytics', 'code', parent.taskId, parent.sessionId, ['code:execute'], SECRET);
      const child = guard.deriveContext(parent, token, 'run analysis script');
      expect(child.currentScope).toBe('code');
      expect(child.delegationChain).toHaveLength(1);
    });
  });

  // ── Positive: skill filtering allows valid skills ───────────────────────────

  describe('positive — filterSkillsByScope', () => {
    it('analytics skills pass through in analytics context', async () => {
      const ctx = guard.rootContext('s', 't', 'analytics');
      const skills: SkillMatch[] = [
        makeSkillMatch('data-pipeline', 'analytics'),
        makeSkillMatch('research-synthesis', 'analytics'),
      ];
      const { allowed, rejected } = await guard.filterSkillsByScope(skills, ctx);
      expect(allowed).toHaveLength(2);
      expect(rejected).toHaveLength(0);
    });

    it('system-scope skills pass from any context', async () => {
      for (const scope of ['analytics', 'kaggle', 'code', 'browser']) {
        const ctx = guard.rootContext('s', 't', scope);
        const skills: SkillMatch[] = [makeSkillMatch('general-chat', 'system')];
        const { allowed } = await guard.filterSkillsByScope(skills, ctx);
        expect(allowed).toHaveLength(1);
      }
    });

    it('system context can activate any skill', async () => {
      const ctx = guard.rootContext('s', 't', 'system');
      const skills: SkillMatch[] = [
        makeSkillMatch('data-pipeline', 'analytics'),
        makeSkillMatch('code-execution', 'code'),
        // Note: kaggle skills are not in the a2a_skills table but the test
        // exercises the system→kaggle allow policy
      ];
      const { allowed, rejected } = await guard.filterSkillsByScope(skills, ctx);
      expect(allowed).toHaveLength(2);
      expect(rejected).toHaveLength(0);
    });

    it('all skills allowed when no scope guard provided (backwards compat)', async () => {
      // discoverSkillsForInput without scopeGuard param should return all skills
      // This tests the optional nature of the scope parameters
      const ctx: ScopeContext = createRootScopeContext('analytics', 's', 't');
      const skills: SkillMatch[] = [
        makeSkillMatch('data-pipeline', 'analytics'),
        makeSkillMatch('code-execution', 'code'),
      ];
      // Direct call to filterSkillsByScope on a disabled guard
      const disabledGuard = await ChatScopeGuard.init(db, { disabled: true });
      const { allowed, rejected } = await disabledGuard.filterSkillsByScope(skills, ctx);
      expect(allowed).toHaveLength(2);
      expect(rejected).toHaveLength(0);
    });
  });

  // ── NEGATIVE: the core scenario — analytics cannot activate kaggle ──────────

  describe('negative — analytics→kaggle isolation (the original bug)', () => {
    it('kaggle skill is FILTERED OUT from analytics context', async () => {
      // This is the exact scenario the user reported:
      // "analyze my sales data" → system selects data-pipeline AND somehow kaggle
      // With scope enforcement, the kaggle skill is removed from the list
      const ctx = guard.rootContext('sess-sales', 'task-sales', 'analytics');
      const skills: SkillMatch[] = [
        makeSkillMatch('data-pipeline', 'analytics'),      // should pass
        makeSkillMatch('research-synthesis', 'analytics'), // should pass
        makeSkillMatch('kaggle-competition', 'kaggle'),    // should be BLOCKED
      ];
      const { allowed, rejected } = await guard.filterSkillsByScope(skills, ctx);
      expect(allowed).toHaveLength(2);
      expect(allowed.map((m) => m.skill.id)).not.toContain('kaggle-competition');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.match.skill.id).toBe('kaggle-competition');
      expect(rejected[0]?.violationType).toBe('explicit-deny');
    });

    it('kaggle mesh activation is blocked from analytics context', async () => {
      const ctx = guard.rootContext('sess-mesh', 'task-mesh', 'analytics');
      const result = await guard.checkMeshActivation('kaggle', 'strategist', ctx);
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('explicit-deny');
    });

    it('analytics→kaggle scope delegation is blocked', () => {
      const ctx = guard.rootContext('s', 't', 'analytics');
      const { result } = guard.checkAndAuthorizeA2ADelegation('analytics', 'kaggle', ctx);
      expect(result.allowed).toBe(false);
    });

    it('violation is logged to scope_access_log', async () => {
      const ctx = guard.rootContext('sess-log', 'task-log', 'analytics');
      await guard.checkMeshActivation('kaggle', 'discoverer', ctx);
      // Give the async log write a moment to complete
      await new Promise((r) => setTimeout(r, 50));
      const log = await db.listScopeAccessLog({ onlyViolations: true });
      expect(log.length).toBeGreaterThan(0);
      const violation = log.find((e) => e.session_id === 'sess-log');
      expect(violation).toBeDefined();
      expect(violation?.allowed).toBe(0);
    });
  });

  // ── Negative: other blocked boundaries ─────────────────────────────────────

  describe('negative — other blocked scope crossings', () => {
    it('code skill blocked from memory context', async () => {
      const ctx = guard.rootContext('s', 't', 'memory');
      const skills: SkillMatch[] = [makeSkillMatch('code-execution', 'code')];
      const { allowed, rejected } = await guard.filterSkillsByScope(skills, ctx);
      expect(allowed).toHaveLength(0);
      expect(rejected).toHaveLength(1);
    });

    it('browser skill blocked from kaggle context (no direct browser→kaggle path)', async () => {
      // kaggle can go to browser, but browser cannot go to kaggle
      const ctx = guard.rootContext('s', 't', 'browser');
      const skills: SkillMatch[] = [makeSkillMatch('kaggle-competition', 'kaggle')];
      const { allowed } = await guard.filterSkillsByScope(skills, ctx);
      expect(allowed).toHaveLength(0);
    });
  });

  // ── Security: confused deputy and chain depth ───────────────────────────────

  describe('security — confused deputy and escalation', () => {
    it('no scope can escalate to system via direct delegation', () => {
      for (const scope of ['analytics', 'kaggle', 'code', 'browser', 'voice', 'memory']) {
        const ctx = guard.rootContext('s', 't', scope);
        const { result } = guard.checkAndAuthorizeA2ADelegation(scope, 'system', ctx);
        expect(result.allowed, `'${scope}'→'system' should be blocked`).toBe(false);
        expect(result.violationType).toBe('confused-deputy');
      }
    });

    it('delegation chain depth limit blocks runaway chains', () => {
      let ctx = createRootScopeContext('analytics', 's', 't');
      // analytics → code has maxDelegationDepth=2; exhaust it
      for (let i = 0; i < 2; i++) {
        const token = issueCrossScopeToken('analytics', 'code', ctx.taskId, ctx.sessionId, ['code:execute'], SECRET);
        ctx = deriveScopeContext(ctx, token, `hop ${i + 1}`);
      }
      // Third attempt should fail
      const { result } = guard.checkAndAuthorizeA2ADelegation('analytics', 'code', ctx);
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('delegation-depth');
    });

    it('tool invocation blocked when scope not allowed', () => {
      const ctx = createRootScopeContext('analytics', 's', 't');
      // python_exec is only for the code scope
      const result = guard.checkToolInvocation('python_exec', ['code'], ctx);
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('scope-boundary');
    });

    it('tool with no scope restriction is allowed from any context', () => {
      const ctx = createRootScopeContext('analytics', 's', 't');
      const result = guard.checkToolInvocation('datetime', [], ctx);
      expect(result.allowed).toBe(true);
    });
  });

  // ── Positive: valid cross-scope delegations with tokens ─────────────────────

  describe('positive — valid A2A delegations', () => {
    it('analytics→code delegation produces a valid token', () => {
      const ctx = guard.rootContext('s', 't', 'analytics');
      const { result, token } = guard.checkAndAuthorizeA2ADelegation('analytics', 'code', ctx, ['code:execute']);
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(true);
      expect(token).toBeDefined();
      expect(token?.fromScope).toBe('analytics');
      expect(token?.toScope).toBe('code');
      expect(token?.permissions).toContain('code:execute');
    });

    it('system→kaggle delegation is allowed without A2A', () => {
      const ctx = guard.rootContext('s', 't', 'system');
      const { result, token } = guard.checkAndAuthorizeA2ADelegation('system', 'kaggle', ctx);
      expect(result.allowed).toBe(true);
      // system→* has requiresA2A=false
      expect(result.requiresA2A).toBe(false);
      expect(token).toBeUndefined();  // no token needed for non-A2A delegation
    });

    it('kaggle→analytics delegation for result interpretation', () => {
      const ctx = guard.rootContext('s', 't', 'kaggle');
      const { result } = guard.checkAndAuthorizeA2ADelegation('kaggle', 'analytics', ctx, ['analytics:read']);
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(true);
    });
  });

  // ── Stress tests ─────────────────────────────────────────────────────────────

  describe('stress — performance and concurrency', () => {
    it('1000 skill filter operations complete in < 2s', async () => {
      const ctx = guard.rootContext('stress-session', 'stress-task', 'analytics');
      const skills: SkillMatch[] = [
        makeSkillMatch('data-pipeline', 'analytics'),
        makeSkillMatch('research-synthesis', 'analytics'),
        makeSkillMatch('kaggle-competition', 'kaggle'),  // will be blocked
      ];
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        await guard.filterSkillsByScope(skills, ctx);
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });

    it('100 concurrent sessions with independent contexts', async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, async (_, i) => {
          const ctx = guard.rootContext(`session-${i}`, `task-${i}`, 'analytics');
          const skills: SkillMatch[] = [
            makeSkillMatch('data-pipeline', 'analytics'),
            makeSkillMatch('kaggle-competition', 'kaggle'),
          ];
          const { allowed, rejected } = await guard.filterSkillsByScope(skills, ctx);
          return { allowed: allowed.length, rejected: rejected.length };
        }),
      );
      // Every session should have: 1 allowed (data-pipeline), 1 rejected (kaggle)
      expect(results.every((r) => r.allowed === 1)).toBe(true);
      expect(results.every((r) => r.rejected === 1)).toBe(true);
    });

    it('health summary returns valid counts', async () => {
      const summary = await guard.healthSummary();
      expect(summary.enabled).toBe(true);
      expect(summary.scopeCount).toBeGreaterThan(0);
      expect(summary.policyCount).toBeGreaterThan(0);
      expect(typeof summary.recentViolations).toBe('number');
    });
  });

  // ── Audit log integrity ───────────────────────────────────────────────────────

  describe('audit log — integrity', () => {
    it('scope violations are logged with full context', async () => {
      const ctx = guard.rootContext('audit-session', 'audit-task', 'analytics');
      // Trigger a violation
      await guard.checkMeshActivation('kaggle', 'strategist', ctx);
      await new Promise((r) => setTimeout(r, 50));

      const log = await db.listScopeAccessLog({ sessionId: 'audit-session' });
      expect(log.length).toBeGreaterThan(0);
      const entry = log[0];
      expect(entry).toBeDefined();
      expect(entry?.from_scope).toBe('analytics');
      expect(entry?.to_scope).toBe('kaggle');
      expect(entry?.allowed).toBe(0);
      expect(entry?.session_id).toBe('audit-session');
      expect(entry?.task_id).toBe('audit-task');
    });

    it('countScopeViolations reflects logged violations', async () => {
      const ctx = guard.rootContext('count-session', 'count-task', 'analytics');
      // Trigger multiple violations
      await guard.checkMeshActivation('kaggle', 'discoverer', ctx);
      await guard.checkMeshActivation('kaggle', 'strategist', ctx);
      await new Promise((r) => setTimeout(r, 100));
      const count = await db.countScopeViolations(1);
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });
});
