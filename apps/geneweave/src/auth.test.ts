import { describe, expect, it } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from './db.js';
import {
  authenticateRequest,
  clearAuthCookie,
  hashPassword,
  setAuthCookie,
  signJWT,
  verifyJWT,
  verifyPasswordDetailed,
} from './auth.js';

describe('password hashing', () => {
  it('writes current scrypt v2 password format and verifies without migration', async () => {
    const hash = await hashPassword('Sup3rStr0ng!');
    expect(hash.startsWith('scrypt$v2$')).toBe(true);

    const result = await verifyPasswordDetailed('Sup3rStr0ng!', hash);
    expect(result).toEqual({ ok: true, needsRehash: false });
  });

  it('accepts legacy password hashes and flags them for lazy migration', async () => {
    const salt = randomBytes(32).toString('hex');
    const legacyHash = scryptSync('legacy-pass', salt, 64).toString('hex');
    const stored = `${salt}:${legacyHash}`;

    const result = await verifyPasswordDetailed('legacy-pass', stored);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it('rejects wrong passwords', async () => {
    const hash = await hashPassword('CorrectHorseBatteryStaple');
    const result = await verifyPasswordDetailed('WrongPassword', hash);
    expect(result).toEqual({ ok: false, needsRehash: false });
  });
});

describe('JWT and cookie hardening', () => {
  it('rejects JWT tokens with a non-HS256 alg header', () => {
    const secret = 'jwt-test-secret';
    const token = signJWT({ userId: 'u1', email: 'user@example.com', sessionId: 's1' }, secret, 300);
    const parts = token.split('.');
    expect(parts.length).toBe(3);
    const payload = parts[1] ?? '';
    const sig = parts[2] ?? '';
    const badHeader = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');

    const forged = `${badHeader}.${payload}.${sig}`;
    expect(verifyJWT(forged, secret)).toBeNull();
  });

  it('enforces session-to-user binding in authenticateRequest', async () => {
    const secret = 'jwt-test-secret';
    const token = signJWT({ userId: 'user-jwt', email: 'user@example.com', sessionId: 'session-1' }, secret, 300);
    const req = {
      headers: {
        cookie: `gw_token=${token}`,
      },
    } as IncomingMessage;

    const db = {
      getSession: async () => ({
        id: 'session-1',
        user_id: 'different-user',
        csrf_token: 'csrf',
        expires_at: '2999-01-01T00:00:00.000Z',
        created_at: '2020-01-01T00:00:00.000Z',
      }),
      getUserById: async () => ({
        id: 'user-jwt',
        email: 'user@example.com',
        password_hash: 'x',
        created_at: '2020-01-01T00:00:00.000Z',
        persona: 'tenant_user',
        tenant_id: null,
      }),
    } as unknown as DatabaseAdapter;

    const auth = await authenticateRequest(req, db, secret);
    expect(auth).toBeNull();
  });

  it('adds Secure cookie attribute in production for set and clear cookie helpers', () => {
    const originalNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const headers = new Map<string, string>();
    const res = {
      setHeader: (name: string, value: string) => {
        headers.set(name.toLowerCase(), value);
      },
    } as unknown as ServerResponse;

    setAuthCookie(res, 'token-value', 60);
    const setCookie = headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Secure');

    clearAuthCookie(res);
    const clearCookie = headers.get('set-cookie') ?? '';
    expect(clearCookie).toContain('Secure');

    process.env['NODE_ENV'] = originalNodeEnv;
  });
});
