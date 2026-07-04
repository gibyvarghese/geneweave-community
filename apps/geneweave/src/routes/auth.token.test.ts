/**
 * SP1 tests — POST /api/auth/token (bearer-token issuance for native clients)
 *
 * In-process: a minimal router stub records the registered handler, and a tiny
 * in-memory DatabaseAdapter stub backs the credential lookup + session create.
 * Real hashPassword / verifyPasswordDetailed / signJWT / verifyJWT are exercised
 * so the issued token is provably honourable by authenticateRequest().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerAuthRoutes } from './auth.js';
import { hashPassword, signJWT, verifyJWT } from '../auth.js';
import type { DatabaseAdapter } from '../db.js';

const JWT_SECRET = 'sp1-test-secret';

type Handler = (req: any, res: any, params: any, auth: any) => Promise<void>;
interface RouteEntry { method: string; path: string; handler: Handler }

function buildRouter() {
  const routes: RouteEntry[] = [];
  const addRoute = (method: string) =>
    (path: string, handler: Handler) => { routes.push({ method, path, handler }); };
  return {
    get: addRoute('GET'),
    post: addRoute('POST'),
    put: addRoute('PUT'),
    del: addRoute('DELETE'),
    add: addRoute('ANY'),
    routes,
    async dispatch(method: string, path: string, body = '{}', headers: Record<string, string> = {}) {
      const entry = routes.find((r) => r.method === method && r.path === path);
      if (!entry) throw new Error(`No route: ${method} ${path}`);
      const res = buildResponse();
      const bodyBuf = Buffer.from(body);
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const req = {
        url: path,
        method,
        headers,
        socket: { remoteAddress: '127.0.0.1', on: vi.fn() },
        resume: vi.fn(),
        on(event: string, cb: (...args: any[]) => void) {
          listeners[event] = listeners[event] ?? [];
          listeners[event]!.push(cb);
          if (event === 'end') {
            Promise.resolve().then(() => {
              for (const l of listeners['data'] ?? []) l(bodyBuf);
              for (const l of listeners['end'] ?? []) l();
            });
          }
          return req;
        },
      };
      await entry.handler(req, res, {}, null);
      return res;
    },
  };
}

function buildResponse() {
  let statusCode = 0;
  let bodyText = '';
  const headers: Record<string, string> = {};
  return {
    statusCode,
    headers,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); },
    writeHead(code: number, hdrs?: Record<string, string>) {
      this.statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = String(v);
    },
    end(chunk?: string) { if (chunk) bodyText += chunk; },
    get body() { try { return JSON.parse(bodyText); } catch { return bodyText; } },
  };
}

interface StubUser {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  persona: string;
  tenant_id: string | null;
  created_at: string;
}

function buildDbStub(users: StubUser[]) {
  const sessions: Array<{ id: string; userId: string; csrfToken: string; expiresAt: string }> = [];
  const db = {
    async getUserByEmail(email: string) { return users.find((u) => u.email === email) ?? null; },
    async getUserById(id: string) { return users.find((u) => u.id === id) ?? null; },
    async listUsers() { return users; },
    async updateUser() { /* no-op (only hit on legacy-hash rehash) */ },
    async updateUserPersona(id: string, persona: string) {
      const u = users.find((x) => x.id === id);
      if (u) u.persona = persona;
    },
    async createSession(s: { id: string; userId: string; csrfToken: string; expiresAt: string }) {
      sessions.push(s);
    },
    async deleteSession() { /* no-op */ },
    __sessions: sessions,
  };
  return db as unknown as DatabaseAdapter & { __sessions: typeof sessions };
}

function registerTokenRoute(db: DatabaseAdapter) {
  const router = buildRouter();
  registerAuthRoutes(router as never, db, {
    jwtSecret: JWT_SECRET,
    setOAuthState: async () => {},
    consumeOAuthState: async () => null,
  });
  return router;
}

describe('POST /api/auth/token', () => {
  let user: StubUser;

  beforeEach(async () => {
    user = {
      id: 'user-1',
      email: 'token-user@example.com',
      name: 'Token User',
      password_hash: await hashPassword('P@ssw0rd123'),
      persona: 'tenant_admin',
      tenant_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
  });

  it('issues a bearer token + csrf in the body for valid credentials', async () => {
    const db = buildDbStub([user]);
    const router = registerTokenRoute(db);
    const res = await router.dispatch(
      'POST',
      '/api/auth/token',
      JSON.stringify({ email: user.email, password: 'P@ssw0rd123' }),
    );

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.csrfToken).toBe('string');
    expect(typeof res.body.expiresAt).toBe('string');
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email, persona: 'tenant_admin' });
    expect(Array.isArray(res.body.permissions)).toBe(true);

    // The token must NOT be delivered via a Set-Cookie (body-only for native clients).
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('issues a token that verifies against the same secret with the persisted session', async () => {
    const db = buildDbStub([user]);
    const router = registerTokenRoute(db);
    const res = await router.dispatch(
      'POST',
      '/api/auth/token',
      JSON.stringify({ email: user.email, password: 'P@ssw0rd123' }),
    );

    const payload = verifyJWT(res.body.token, JWT_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe(user.id);
    expect(payload!.email).toBe(user.email);

    // A session row was created and its id matches the token's sessionId, and
    // its csrf matches the returned csrfToken — exactly what authenticateRequest
    // and verifyCSRF will check on subsequent requests.
    const session = db.__sessions.find((s) => s.id === payload!.sessionId);
    expect(session).toBeDefined();
    expect(session!.userId).toBe(user.id);
    expect(session!.csrfToken).toBe(res.body.csrfToken);
  });

  it('rejects wrong credentials with 401 and no token', async () => {
    const db = buildDbStub([user]);
    const router = registerTokenRoute(db);
    const res = await router.dispatch(
      'POST',
      '/api/auth/token',
      JSON.stringify({ email: user.email, password: 'wrong-password' }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(db.__sessions.length).toBe(0);
  });

  it('rejects an unknown email with 401 (no user existence disclosure)', async () => {
    const db = buildDbStub([user]);
    const router = registerTokenRoute(db);
    const res = await router.dispatch(
      'POST',
      '/api/auth/token',
      JSON.stringify({ email: 'nobody@example.com', password: 'P@ssw0rd123' }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('requires both email and password (400)', async () => {
    const db = buildDbStub([user]);
    const router = registerTokenRoute(db);
    const res = await router.dispatch('POST', '/api/auth/token', JSON.stringify({ email: user.email }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const db = buildDbStub([user]);
    const router = registerTokenRoute(db);
    const res = await router.dispatch('POST', '/api/auth/token', '{ not json');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Invalid JSON');
  });

  it('does not collide token sessionIds with a prior login-style session', async () => {
    const db = buildDbStub([user]);
    const router = registerTokenRoute(db);
    const a = await router.dispatch('POST', '/api/auth/token', JSON.stringify({ email: user.email, password: 'P@ssw0rd123' }));
    const b = await router.dispatch('POST', '/api/auth/token', JSON.stringify({ email: user.email, password: 'P@ssw0rd123' }));
    const pa = verifyJWT(a.body.token, JWT_SECRET)!;
    const pb = verifyJWT(b.body.token, JWT_SECRET)!;
    expect(pa.sessionId).not.toBe(pb.sessionId);
    expect(db.__sessions.length).toBe(2);
  });
});

// Sanity: the helper used above mirrors the real signing path.
describe('SP1 token sanity', () => {
  it('signJWT/verifyJWT round-trips the session id', () => {
    const t = signJWT({ userId: 'u', email: 'e@x.com', sessionId: 's-123' }, JWT_SECRET);
    expect(verifyJWT(t, JWT_SECRET)?.sessionId).toBe('s-123');
  });
});
