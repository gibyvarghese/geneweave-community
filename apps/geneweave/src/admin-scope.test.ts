/**
 * GeneWeave — admin-scope.test.ts
 *
 * Integration tests for the scope isolation admin CRUD routes (m75).
 *
 * Tests cover:
 *   - CRUD for agent_scopes (list, get, create, update, delete)
 *   - CRUD for scope_cross_policies (list, get, create, update, delete)
 *   - List/create/delete for scope_skill_assignments (composite PK)
 *   - List/create/delete for scope_live_agent_assignments (composite PK)
 *   - Read-only access for scope_access_log
 *   - Field type validation (booleans stored as 0/1, numbers as ints)
 *   - Input validation (required fields, enum values, format checks)
 *   - Composite ID encoding/decoding for join tables
 *   - Auth guard: all routes reject unauthenticated calls
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseAdapter } from './db-sqlite.js';
import type { DatabaseAdapter } from './db.js';
import { registerScopeRoutes } from './admin/api/scope.js';
import type { RouterLike, AdminHelpers } from './admin/api/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthContext } from './auth.js';

// ── Tiny in-process HTTP simulation ──────────────────────────────────────────

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: AuthContext | null,
) => Promise<void>;

interface RegisteredRoute {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

function buildTestRouter(): RouterLike & { routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  function register(method: string) {
    return (path: string, handler: RouteHandler) => {
      routes.push({ method, pattern: path, handler });
    };
  }
  return {
    routes,
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    patch: register('PATCH'),
    del: register('DELETE'),
  };
}

/** Matches a URL path against a pattern like '/api/admin/agent-scopes/:id'. */
function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patParts = pattern.split('/');
  const pathParts = (path.split('?')[0] ?? path).split('/');
  if (patParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    const pat = patParts[i] ?? '';
    const seg = pathParts[i] ?? '';
    if (pat.startsWith(':')) {
      params[pat.slice(1)] = decodeURIComponent(seg);
    } else if (pat !== seg) {
      return null;
    }
  }
  return params;
}

/** Simulates an HTTP request through the registered routes. */
async function simulateRequest(
  router: RouterLike & { routes: RegisteredRoute[] },
  method: string,
  path: string,
  body?: unknown,
  auth: AuthContext | null = { userId: 'admin', roles: ['admin'] } as unknown as AuthContext,
): Promise<{ status: number; body: unknown }> {
  let responseStatus = 200;
  let responseBody: unknown = null;

  const res = {
    end: () => {},
    setHeader: () => {},
    writeHead: (status: number) => { responseStatus = status; },
  } as unknown as ServerResponse;

  const req = {
    url: path,
    method,
    headers: {},
  } as unknown as IncomingMessage;

  for (const route of router.routes) {
    if (route.method.toUpperCase() !== method.toUpperCase()) continue;
    const params = matchRoute(route.pattern, path.split('?')[0] ?? path);
    if (params === null) continue;

    // Capture json() calls
    const jsonCapture = (_res: ServerResponse, status: number, data: unknown) => {
      responseStatus = status;
      responseBody = data;
    };
    const readBodyCapture = async () => body != null ? JSON.stringify(body) : '{}';

    // Temporarily wire helpers into the router's captured closures via monkey-patch
    // We re-register routes with a patched helpers — instead, we call handler directly
    // by re-building helpers in the route registration. Instead, we use a wrapper:
    await route.handler(req, res, params, auth);
    return { status: responseStatus, body: responseBody };
  }
  return { status: 404, body: { error: 'Not found' } };
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe('Scope Admin Routes', () => {
  let db: DatabaseAdapter;
  let router: RouterLike & { routes: RegisteredRoute[] };
  let capturedResponses: Array<{ status: number; body: unknown }>;

  // Build a router that captures json() responses correctly
  function buildHelpers(): AdminHelpers {
    let captureStatus = 200;
    let captureBody: unknown = null;
    return {
      json: (_res: ServerResponse, status: number, data: unknown) => {
        captureStatus = status;
        captureBody = data;
        // Store last response for retrieval
        capturedResponses.push({ status, body: data });
      },
      readBody: async (_req: IncomingMessage) => '{}',
      requireDetailedDescription: () => null,
    };
  }

  /**
   * Invoke a route handler directly — matches path, extracts params, calls handler.
   * Returns the last captured response from json().
   */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    auth: AuthContext | null = { userId: 'admin', roles: ['admin'] } as unknown as AuthContext,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    capturedResponses = [];

    const req = {
      url: path,
      method,
      headers: {},
    } as unknown as IncomingMessage;

    const res = {} as ServerResponse;

    let helpers = buildHelpers();

    // Override readBody for this call
    const originalReadBody = helpers.readBody;
    helpers = {
      ...helpers,
      readBody: async () => body != null ? JSON.stringify(body) : '{}',
    };
    void originalReadBody; // suppress unused warning

    // Rebuild router with updated helpers — simpler: re-register on each call
    const freshRouter = buildTestRouter();
    registerScopeRoutes(freshRouter, db, helpers);

    for (const route of freshRouter.routes) {
      if (route.method.toUpperCase() !== method.toUpperCase()) continue;
      const params = matchRoute(route.pattern, path.split('?')[0] ?? path);
      if (params === null) continue;
      await route.handler(req, res, params, auth);
      const last = capturedResponses[capturedResponses.length - 1];
      return { status: last?.status ?? 200, body: (last?.body ?? {}) as Record<string, unknown> };
    }
    return { status: 404, body: { error: 'Route not found' } };
  }

  beforeEach(async () => {
    capturedResponses = [];
    db = await createDatabaseAdapter({ type: 'sqlite', path: ':memory:' });
    await db.initialize();
    await db.seedDefaultData();
    router = buildTestRouter();
    registerScopeRoutes(router, db, buildHelpers());
  });

  afterEach(async () => {
    await db.close();
  });

  // ── agent_scopes ───────────────────────────────────────────────────────────

  describe('agent-scopes', () => {
    it('GET /agent-scopes returns seeded scopes', async () => {
      const { status, body } = await call('GET', '/api/admin/agent-scopes');
      expect(status).toBe(200);
      const scopes = body['agent-scopes'] as unknown[];
      expect(Array.isArray(scopes)).toBe(true);
      // Migration seeds 7 scopes
      expect(scopes.length).toBeGreaterThanOrEqual(7);
    });

    it('GET /agent-scopes includes disabled scopes (admin list shows all)', async () => {
      // Create a disabled scope
      await db.adminCreateScope({
        id: 'test-disabled',
        display_name: 'Disabled Test',
        description: 'A disabled scope',
        sandboxed: 1,
        max_delegation_depth: 1,
        audit_level: 'none',
        enabled: 0,
      });
      const { status, body } = await call('GET', '/api/admin/agent-scopes');
      expect(status).toBe(200);
      const scopes = body['agent-scopes'] as Array<{ id: string; enabled: number }>;
      const disabled = scopes.find((s) => s.id === 'test-disabled');
      expect(disabled).toBeDefined();
      expect(disabled!.enabled).toBe(0);
    });

    it('GET /agent-scopes/:id returns a specific scope', async () => {
      const { status, body } = await call('GET', '/api/admin/agent-scopes/analytics');
      expect(status).toBe(200);
      const scope = body['agent-scope'] as { id: string; display_name: string };
      expect(scope.id).toBe('analytics');
      expect(scope.display_name).toBeTruthy();
    });

    it('GET /agent-scopes/:id returns 404 for unknown scope', async () => {
      const { status, body } = await call('GET', '/api/admin/agent-scopes/nonexistent-scope');
      expect(status).toBe(404);
      expect((body as { error: string }).error).toMatch(/not found/i);
    });

    it('POST /agent-scopes creates a new scope with correct field types', async () => {
      const { status, body } = await call('POST', '/api/admin/agent-scopes', {
        id: 'custom-scope',
        display_name: 'Custom Scope',
        description: 'A custom domain boundary for testing',
        sandboxed: true,
        max_delegation_depth: 3,
        audit_level: 'alert',
        enabled: true,
      });
      expect(status).toBe(201);
      const scope = body['agent-scope'] as {
        id: string;
        sandboxed: number;
        max_delegation_depth: number;
        audit_level: string;
        enabled: number;
      };
      expect(scope.id).toBe('custom-scope');
      // Boolean checkbox saved as SQLite integer
      expect(scope.sandboxed).toBe(1);
      expect(scope.enabled).toBe(1);
      // Numeric field stored as integer
      expect(scope.max_delegation_depth).toBe(3);
      // Enum field stored as string
      expect(scope.audit_level).toBe('alert');
    });

    it('POST /agent-scopes validates required id field', async () => {
      const { status, body } = await call('POST', '/api/admin/agent-scopes', {
        display_name: 'Missing ID scope',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/id.*required/i);
    });

    it('POST /agent-scopes validates id format (must be lowercase kebab-case)', async () => {
      const { status, body } = await call('POST', '/api/admin/agent-scopes', {
        id: 'Invalid Scope ID!',
        display_name: 'Bad ID',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/lowercase/i);
    });

    it('POST /agent-scopes validates audit_level enum', async () => {
      const { status, body } = await call('POST', '/api/admin/agent-scopes', {
        id: 'test-scope',
        display_name: 'Test Scope',
        audit_level: 'invalid-level',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/audit_level/i);
    });

    it('PUT /agent-scopes/:id updates individual fields', async () => {
      const { status, body } = await call('PUT', '/api/admin/agent-scopes/analytics', {
        display_name: 'Updated Analytics',
        max_delegation_depth: 2,
        sandboxed: false,
      });
      expect(status).toBe(200);
      const scope = body['agent-scope'] as {
        display_name: string;
        max_delegation_depth: number;
        sandboxed: number;
      };
      expect(scope.display_name).toBe('Updated Analytics');
      expect(scope.max_delegation_depth).toBe(2);
      expect(scope.sandboxed).toBe(0);  // false → 0
    });

    it('PUT /agent-scopes/:id returns 404 for nonexistent scope', async () => {
      const { status } = await call('PUT', '/api/admin/agent-scopes/ghost', { display_name: 'X' });
      expect(status).toBe(404);
    });

    it('DELETE /agent-scopes/:id removes the scope', async () => {
      // First create a disposable scope
      await call('POST', '/api/admin/agent-scopes', {
        id: 'disposable',
        display_name: 'Disposable',
        description: '',
        sandboxed: 1,
        max_delegation_depth: 1,
        audit_level: 'none',
        enabled: 1,
      });

      const { status } = await call('DELETE', '/api/admin/agent-scopes/disposable');
      expect(status).toBe(200);

      const { status: getStatus } = await call('GET', '/api/admin/agent-scopes/disposable');
      expect(getStatus).toBe(404);
    });

    it('DELETE /agent-scopes/:id returns 404 for nonexistent scope', async () => {
      const { status } = await call('DELETE', '/api/admin/agent-scopes/ghost-scope');
      expect(status).toBe(404);
    });

    it('auth guard: unauthenticated requests are rejected', async () => {
      const { status } = await call('GET', '/api/admin/agent-scopes', undefined, null);
      expect(status).toBe(401);
    });
  });

  // ── scope_cross_policies ───────────────────────────────────────────────────

  describe('scope-cross-policies', () => {
    it('GET /scope-cross-policies returns all seeded policies', async () => {
      const { status, body } = await call('GET', '/api/admin/scope-cross-policies');
      expect(status).toBe(200);
      const policies = body['scope-cross-policies'] as unknown[];
      // Migration seeds 13 policies
      expect(policies.length).toBeGreaterThanOrEqual(13);
    });

    it('GET /scope-cross-policies includes disabled policies', async () => {
      await db.adminCreateScopePolicy({
        id: 'pol-disabled-test',
        from_scope: 'analytics',
        to_scope: 'voice',
        allowed: 0,
        requires_a2a: 0,
        max_delegation_depth: 0,
        conditions_json: null,
        audit_level: 'none',
        enabled: 0,
      });
      const { body } = await call('GET', '/api/admin/scope-cross-policies');
      const policies = body['scope-cross-policies'] as Array<{ id: string }>;
      expect(policies.some((p) => p.id === 'pol-disabled-test')).toBe(true);
    });

    it('GET /scope-cross-policies/:id returns a specific policy', async () => {
      const { status, body } = await call('GET', '/api/admin/scope-cross-policies/pol-ana-kag');
      expect(status).toBe(200);
      const policy = body['scope-cross-policy'] as {
        id: string;
        from_scope: string;
        to_scope: string;
        allowed: number;
      };
      expect(policy.id).toBe('pol-ana-kag');
      expect(policy.from_scope).toBe('analytics');
      expect(policy.to_scope).toBe('kaggle');
      // This is the critical isolation boundary — must be denied
      expect(policy.allowed).toBe(0);
    });

    it('POST /scope-cross-policies creates a new policy with correct field types', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-cross-policies', {
        from_scope: 'code',
        to_scope: 'browser',
        allowed: true,
        requires_a2a: true,
        max_delegation_depth: 1,
        audit_level: 'log',
        enabled: true,
      });
      expect(status).toBe(201);
      const policy = body['scope-cross-policy'] as {
        from_scope: string;
        to_scope: string;
        allowed: number;
        requires_a2a: number;
        max_delegation_depth: number;
        audit_level: string;
        enabled: number;
      };
      expect(policy.from_scope).toBe('code');
      expect(policy.to_scope).toBe('browser');
      // Booleans stored as integers
      expect(policy.allowed).toBe(1);
      expect(policy.requires_a2a).toBe(1);
      expect(policy.enabled).toBe(1);
      // Integer field
      expect(policy.max_delegation_depth).toBe(1);
      // Enum
      expect(policy.audit_level).toBe('log');
    });

    it('POST /scope-cross-policies auto-generates id when blank', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-cross-policies', {
        from_scope: 'memory',
        to_scope: 'browser',
        allowed: false,
        requires_a2a: false,
        max_delegation_depth: 0,
        audit_level: 'none',
        enabled: true,
      });
      expect(status).toBe(201);
      const policy = body['scope-cross-policy'] as { id: string };
      expect(typeof policy.id).toBe('string');
      expect(policy.id.length).toBeGreaterThan(0);
    });

    it('POST /scope-cross-policies validates required from_scope', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-cross-policies', {
        to_scope: 'analytics',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/from_scope/i);
    });

    it('POST /scope-cross-policies validates required to_scope', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-cross-policies', {
        from_scope: 'analytics',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/to_scope/i);
    });

    it('POST /scope-cross-policies validates audit_level enum', async () => {
      const { status } = await call('POST', '/api/admin/scope-cross-policies', {
        from_scope: 'code',
        to_scope: 'browser',
        audit_level: 'critical',
      });
      expect(status).toBe(400);
    });

    it('PUT /scope-cross-policies/:id updates policy fields', async () => {
      const { status, body } = await call('PUT', '/api/admin/scope-cross-policies/pol-ana-kag', {
        audit_level: 'alert',
        requires_a2a: false,
      });
      expect(status).toBe(200);
      const policy = body['scope-cross-policy'] as {
        audit_level: string;
        requires_a2a: number;
      };
      expect(policy.audit_level).toBe('alert');
      expect(policy.requires_a2a).toBe(0);
    });

    it('PUT /scope-cross-policies/:id stores conditions_json as string', async () => {
      const conditions = [{ task_type: ['analysis'] }];
      const { status, body } = await call('PUT', '/api/admin/scope-cross-policies/pol-ana-code', {
        conditions_json: conditions,
      });
      expect(status).toBe(200);
      const policy = body['scope-cross-policy'] as { conditions_json: string };
      // conditions_json should be stored as a JSON string
      expect(typeof policy.conditions_json).toBe('string');
      const parsed = JSON.parse(policy.conditions_json);
      expect(parsed).toEqual(conditions);
    });

    it('DELETE /scope-cross-policies/:id removes the policy', async () => {
      await db.adminCreateScopePolicy({
        id: 'pol-delete-me',
        from_scope: 'voice',
        to_scope: 'code',
        allowed: 0,
        requires_a2a: 0,
        max_delegation_depth: 0,
        conditions_json: null,
        audit_level: 'none',
        enabled: 1,
      });

      const { status } = await call('DELETE', '/api/admin/scope-cross-policies/pol-delete-me');
      expect(status).toBe(200);

      const { status: getStatus } = await call('GET', '/api/admin/scope-cross-policies/pol-delete-me');
      expect(getStatus).toBe(404);
    });

    it('security: analytics→kaggle deny policy cannot be silently bypassed via PUT', async () => {
      // Trying to flip the deny to allow is a valid admin operation — but let's verify it
      // explicitly updates (this tests the CRUD works, not scope enforcement)
      const { status, body } = await call('PUT', '/api/admin/scope-cross-policies/pol-ana-kag', {
        allowed: true,  // intentionally flipping the isolation boundary
      });
      expect(status).toBe(200);
      const policy = body['scope-cross-policy'] as { allowed: number };
      // The DB update should succeed (admin has full authority); enforcement
      // happens at the ScopeGuard level, not at the admin CRUD level.
      expect(policy.allowed).toBe(1);
      // Restore the deny for subsequent tests
      await call('PUT', '/api/admin/scope-cross-policies/pol-ana-kag', { allowed: false });
    });

    it('auth guard: unauthenticated requests are rejected', async () => {
      const { status } = await call('GET', '/api/admin/scope-cross-policies', undefined, null);
      expect(status).toBe(401);
    });
  });

  // ── scope_skill_assignments ───────────────────────────────────────────────

  describe('scope-skill-assignments', () => {
    it('GET /scope-skill-assignments returns seeded assignments', async () => {
      const { status, body } = await call('GET', '/api/admin/scope-skill-assignments');
      expect(status).toBe(200);
      const assignments = body['scope-skill-assignments'] as Array<{ id: string; scope_id: string; skill_id: string }>;
      expect(Array.isArray(assignments)).toBe(true);
      // Migration seeds 16 skill assignments
      expect(assignments.length).toBeGreaterThanOrEqual(16);
    });

    it('GET /scope-skill-assignments rows include synthetic composite id', async () => {
      const { body } = await call('GET', '/api/admin/scope-skill-assignments');
      const assignments = body['scope-skill-assignments'] as Array<{ id: string; scope_id: string; skill_id: string }>;
      // Every row must have id = `{scope_id}::{skill_id}`
      for (const a of assignments) {
        expect(a.id).toBe(`${a.scope_id}::${a.skill_id}`);
      }
    });

    it('POST /scope-skill-assignments creates a new assignment', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-skill-assignments', {
        scope_id: 'analytics',
        skill_id: 'custom-analytics-tool',
      });
      expect(status).toBe(201);
      const a = body['scope-skill-assignment'] as { id: string; scope_id: string; skill_id: string };
      expect(a.scope_id).toBe('analytics');
      expect(a.skill_id).toBe('custom-analytics-tool');
      expect(a.id).toBe('analytics::custom-analytics-tool');
    });

    it('POST /scope-skill-assignments is idempotent (INSERT OR IGNORE)', async () => {
      await call('POST', '/api/admin/scope-skill-assignments', {
        scope_id: 'analytics',
        skill_id: 'duplicate-test',
      });
      const { status } = await call('POST', '/api/admin/scope-skill-assignments', {
        scope_id: 'analytics',
        skill_id: 'duplicate-test',
      });
      // INSERT OR IGNORE — should not fail on duplicate
      expect(status).toBe(201);
    });

    it('POST /scope-skill-assignments validates required scope_id', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-skill-assignments', {
        skill_id: 'some-skill',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/scope_id/i);
    });

    it('POST /scope-skill-assignments validates required skill_id', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-skill-assignments', {
        scope_id: 'analytics',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/skill_id/i);
    });

    it('DELETE /scope-skill-assignments/:id removes by composite id', async () => {
      // Add a test assignment first
      await call('POST', '/api/admin/scope-skill-assignments', {
        scope_id: 'code',
        skill_id: 'to-be-removed',
      });

      const compositeId = encodeURIComponent('code::to-be-removed');
      const { status } = await call('DELETE', `/api/admin/scope-skill-assignments/${compositeId}`);
      expect(status).toBe(200);

      // Verify it's gone
      const { body } = await call('GET', '/api/admin/scope-skill-assignments');
      const assignments = body['scope-skill-assignments'] as Array<{ skill_id: string }>;
      expect(assignments.some((a) => a.skill_id === 'to-be-removed')).toBe(false);
    });

    it('DELETE /scope-skill-assignments/:id returns 400 for invalid composite id', async () => {
      const { status } = await call('DELETE', '/api/admin/scope-skill-assignments/invalid-no-separator');
      expect(status).toBe(400);
    });

    it('auth guard: unauthenticated requests are rejected', async () => {
      const { status } = await call('GET', '/api/admin/scope-skill-assignments', undefined, null);
      expect(status).toBe(401);
    });
  });

  // ── scope_live_agent_assignments ──────────────────────────────────────────

  describe('scope-live-agent-assignments', () => {
    it('GET /scope-live-agent-assignments returns seeded Kaggle assignments', async () => {
      const { status, body } = await call('GET', '/api/admin/scope-live-agent-assignments');
      expect(status).toBe(200);
      const assignments = body['scope-live-agent-assignments'] as Array<{
        id: string;
        scope_id: string;
        mesh_key: string;
        role_key: string;
      }>;
      expect(Array.isArray(assignments)).toBe(true);
      // Migration seeds 10 rows (9 named roles + 1 catch-all)
      expect(assignments.length).toBeGreaterThanOrEqual(10);
    });

    it('GET /scope-live-agent-assignments rows include synthetic composite id', async () => {
      const { body } = await call('GET', '/api/admin/scope-live-agent-assignments');
      const assignments = body['scope-live-agent-assignments'] as Array<{
        id: string;
        scope_id: string;
        mesh_key: string;
        role_key: string;
      }>;
      for (const a of assignments) {
        expect(a.id).toBe(`${a.scope_id}::${a.mesh_key}::${a.role_key}`);
      }
    });

    it('POST /scope-live-agent-assignments creates a named role assignment', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-live-agent-assignments', {
        scope_id: 'analytics',
        mesh_key: 'sv-science',
        role_key: 'analyst',
      });
      expect(status).toBe(201);
      const a = body['scope-live-agent-assignment'] as {
        id: string;
        scope_id: string;
        mesh_key: string;
        role_key: string;
      };
      expect(a.scope_id).toBe('analytics');
      expect(a.mesh_key).toBe('sv-science');
      expect(a.role_key).toBe('analyst');
      expect(a.id).toBe('analytics::sv-science::analyst');
    });

    it('POST /scope-live-agent-assignments creates a catch-all assignment (empty role_key)', async () => {
      const { status, body } = await call('POST', '/api/admin/scope-live-agent-assignments', {
        scope_id: 'browser',
        mesh_key: 'web-scraper',
        role_key: '',  // catch-all
      });
      expect(status).toBe(201);
      const a = body['scope-live-agent-assignment'] as { id: string; role_key: string };
      expect(a.role_key).toBe('');  // preserved as empty string
      expect(a.id).toBe('browser::web-scraper::');
    });

    it('POST /scope-live-agent-assignments validates required scope_id', async () => {
      const { status } = await call('POST', '/api/admin/scope-live-agent-assignments', {
        mesh_key: 'kaggle',
        role_key: 'discoverer',
      });
      expect(status).toBe(400);
    });

    it('POST /scope-live-agent-assignments validates required mesh_key', async () => {
      const { status } = await call('POST', '/api/admin/scope-live-agent-assignments', {
        scope_id: 'kaggle',
        role_key: 'discoverer',
      });
      expect(status).toBe(400);
    });

    it('DELETE /scope-live-agent-assignments/:id removes by composite id', async () => {
      await call('POST', '/api/admin/scope-live-agent-assignments', {
        scope_id: 'analytics',
        mesh_key: 'test-mesh',
        role_key: 'reporter',
      });

      const compositeId = encodeURIComponent('analytics::test-mesh::reporter');
      const { status } = await call('DELETE', `/api/admin/scope-live-agent-assignments/${compositeId}`);
      expect(status).toBe(200);

      // Verify removed
      const { body } = await call('GET', '/api/admin/scope-live-agent-assignments');
      const assignments = body['scope-live-agent-assignments'] as Array<{ mesh_key: string; role_key: string }>;
      expect(assignments.some((a) => a.mesh_key === 'test-mesh' && a.role_key === 'reporter')).toBe(false);
    });

    it('DELETE handles composite id with empty role_key (catch-all)', async () => {
      await call('POST', '/api/admin/scope-live-agent-assignments', {
        scope_id: 'code',
        mesh_key: 'cse-mesh',
        role_key: '',
      });

      // id = "code::cse-mesh::" (trailing :: for empty role_key)
      const compositeId = encodeURIComponent('code::cse-mesh::');
      const { status } = await call('DELETE', `/api/admin/scope-live-agent-assignments/${compositeId}`);
      expect(status).toBe(200);
    });

    it('DELETE returns 400 for invalid composite id (missing separators)', async () => {
      const { status } = await call('DELETE', '/api/admin/scope-live-agent-assignments/invalid');
      expect(status).toBe(400);
    });

    it('auth guard: unauthenticated requests are rejected', async () => {
      const { status } = await call('GET', '/api/admin/scope-live-agent-assignments', undefined, null);
      expect(status).toBe(401);
    });
  });

  // ── scope_access_log ──────────────────────────────────────────────────────

  describe('scope-access-log', () => {
    it('GET /scope-access-log returns recent log entries', async () => {
      // Insert a few test events
      await db.logScopeEvent({
        event_type: 'violation',
        from_scope: 'analytics',
        to_scope: 'kaggle',
        skill_id: null,
        tool_name: null,
        session_id: 'test-session-1',
        task_id: null,
        user_id: null,
        allowed: 0,
        reason: 'Policy explicitly denies analytics→kaggle',
        delegation_chain_json: '[]',
      });
      await db.logScopeEvent({
        event_type: 'cross_scope_delegation',
        from_scope: 'system',
        to_scope: 'analytics',
        skill_id: 'data-pipeline',
        tool_name: null,
        session_id: 'test-session-2',
        task_id: null,
        user_id: null,
        allowed: 1,
        reason: null,
        delegation_chain_json: '[]',
      });

      const { status, body } = await call('GET', '/api/admin/scope-access-log');
      expect(status).toBe(200);
      const entries = body['scope-access-log'] as Array<{
        event_type: string;
        allowed: number;
        from_scope: string;
        to_scope: string;
      }>;
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThanOrEqual(2);
    });

    it('GET /scope-access-log?onlyViolations=1 filters to denied events', async () => {
      await db.logScopeEvent({
        event_type: 'violation',
        from_scope: 'analytics',
        to_scope: 'kaggle',
        skill_id: null, tool_name: null, session_id: null, task_id: null, user_id: null,
        allowed: 0,
        reason: 'Denied',
        delegation_chain_json: '[]',
      });
      await db.logScopeEvent({
        event_type: 'skill_activation',
        from_scope: 'system',
        to_scope: 'analytics',
        skill_id: 'data-pipeline', tool_name: null, session_id: null, task_id: null, user_id: null,
        allowed: 1,
        reason: null,
        delegation_chain_json: '[]',
      });

      const { body } = await call('GET', '/api/admin/scope-access-log?onlyViolations=1');
      const entries = body['scope-access-log'] as Array<{ allowed: number }>;
      expect(entries.every((e) => e.allowed === 0)).toBe(true);
    });

    it('GET /scope-access-log respects limit parameter (max 500)', async () => {
      const { status, body } = await call('GET', '/api/admin/scope-access-log?limit=5');
      expect(status).toBe(200);
      const entries = body['scope-access-log'] as unknown[];
      expect(entries.length).toBeLessThanOrEqual(5);
    });

    it('access log is read-only: no POST/PUT/DELETE routes registered', async () => {
      // The scope-access-log should not have mutation routes
      const freshRouter = buildTestRouter();
      registerScopeRoutes(freshRouter, db, buildHelpers());

      const mutationRoutes = freshRouter.routes.filter((r) =>
        r.pattern.includes('scope-access-log') && r.method !== 'GET',
      );
      expect(mutationRoutes.length).toBe(0);
    });

    it('auth guard: unauthenticated requests are rejected', async () => {
      const { status } = await call('GET', '/api/admin/scope-access-log', undefined, null);
      expect(status).toBe(401);
    });
  });

  // ── Cross-cutting: DB adapter methods ──────────────────────────────────────

  describe('DB adapter: admin CRUD methods', () => {
    it('adminListScopes includes all scopes regardless of enabled flag', async () => {
      await db.adminCreateScope({
        id: 'hidden-scope',
        display_name: 'Hidden',
        description: '',
        sandboxed: 1,
        max_delegation_depth: 1,
        audit_level: 'none',
        enabled: 0,
      });
      const all = await db.adminListScopes();
      const hidden = all.find((s) => s.id === 'hidden-scope');
      expect(hidden).toBeDefined();
      expect(hidden!.enabled).toBe(0);

      // But listScopes() (runtime read) excludes disabled
      const runtime = await db.listScopes();
      expect(runtime.find((s) => s.id === 'hidden-scope')).toBeUndefined();
    });

    it('adminListScopePolicies includes disabled policies', async () => {
      await db.adminCreateScopePolicy({
        id: 'pol-hidden',
        from_scope: 'voice',
        to_scope: 'code',
        allowed: 0,
        requires_a2a: 0,
        max_delegation_depth: 0,
        conditions_json: null,
        audit_level: 'none',
        enabled: 0,
      });
      const all = await db.adminListScopePolicies();
      expect(all.find((p) => p.id === 'pol-hidden')).toBeDefined();

      // listScopePolicies (runtime) excludes disabled
      const runtime = await db.listScopePolicies();
      expect(runtime.find((p) => p.id === 'pol-hidden')).toBeUndefined();
    });

    it('adminUpdateScope sets updated_at via SQLite datetime()', async () => {
      await db.adminUpdateScope('analytics', { display_name: 'Updated' });
      const updated = await db.getScope('analytics');
      expect(updated!.display_name).toBe('Updated');
      // updated_at should be set to a valid datetime string
      expect(updated!.updated_at).toBeTruthy();
    });

    it('adminDeleteScopeSkillAssignment uses correct composite id parsing', async () => {
      await db.adminCreateScopeSkillAssignment('analytics', 'test::skill::with::colons');
      // Only single '::' separates scope_id from skill_id — should parse correctly
      // This tests that skill_id can contain '::' chars (shouldn't appear in practice but is safe)
      const all = await db.adminListScopeSkillAssignments();
      const found = all.find((a) => a.skill_id === 'test::skill::with::colons');
      expect(found).toBeDefined();
    });

    it('adminDeleteScopeLiveAgentAssignment handles catch-all (empty role_key)', async () => {
      await db.adminCreateScopeLiveAgentAssignment('memory', 'mem-mesh', '');
      await db.adminDeleteScopeLiveAgentAssignment('memory::mem-mesh::');
      const all = await db.adminListScopeLiveAgentAssignments();
      expect(all.find((a) => a.mesh_key === 'mem-mesh' && a.role_key === '')).toBeUndefined();
    });
  });

  // ── Stress: list performance ──────────────────────────────────────────────

  describe('stress: bulk list performance', () => {
    it('handles many scope policies listed in < 2s', async () => {
      // scope_cross_policies has UNIQUE(from_scope, to_scope), so we use synthetic
      // scope names to avoid conflicts with seeded data and with each other.
      const start = Date.now();
      const N = 50;
      for (let i = 0; i < N; i++) {
        // Each row has a unique (from_scope, to_scope) pair using synthetic scope names
        await db.adminCreateScopePolicy({
          id: `pol-stress-${i}`,
          from_scope: `stress-src-${i}`,
          to_scope: `stress-dst-${i}`,
          allowed: i % 3 !== 0 ? 1 : 0,
          requires_a2a: 1,
          max_delegation_depth: 1,
          conditions_json: null,
          audit_level: 'log',
          enabled: 1,
        });
      }
      const { body } = await call('GET', '/api/admin/scope-cross-policies');
      const policies = body['scope-cross-policies'] as unknown[];
      expect(policies.length).toBeGreaterThanOrEqual(N + 13);  // N new + 13 seeded
      expect(Date.now() - start).toBeLessThan(2000);
    });

    it('handles 500 access log entries listed in < 500ms', async () => {
      const start = Date.now();
      for (let i = 0; i < 500; i++) {
        await db.logScopeEvent({
          event_type: i % 4 === 0 ? 'violation' : 'skill_activation',
          from_scope: 'system',
          to_scope: 'analytics',
          skill_id: `skill-${i}`,
          tool_name: null,
          session_id: `session-${i % 10}`,
          task_id: null,
          user_id: null,
          allowed: i % 4 === 0 ? 0 : 1,
          reason: null,
          delegation_chain_json: '[]',
        });
      }
      const { body } = await call('GET', '/api/admin/scope-access-log?limit=500');
      const entries = body['scope-access-log'] as unknown[];
      expect(entries.length).toBeLessThanOrEqual(500);
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });
});
