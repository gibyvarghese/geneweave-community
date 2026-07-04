/**
 * FIDO2 / WebAuthn passkey support (4.1)
 *
 * Implements server-side WebAuthn registration (attestation) and
 * authentication (assertion) without external dependencies using
 * Node.js built-in crypto primitives (SubtleCrypto via globalThis.crypto
 * and node:crypto for hashing).
 *
 * Supported:
 *  - ES256 (ECDSA P-256, COSE alg -7) — the universal baseline
 *  - RS256 (RSASSA-PKCS1-v1_5 SHA-256, COSE alg -257) — Windows Hello, TPMs
 *  - Attestation formats: 'none' and 'packed' (self-attestation only)
 *
 * Reference: https://www.w3.org/TR/webauthn-2/
 *
 * Flow overview
 * ─────────────
 * Registration:
 *   1. POST /api/auth/passkey/register/begin   → returns PublicKeyCredentialCreationOptions
 *   2. POST /api/auth/passkey/register/complete → verifies attestation, stores credential
 *
 * Authentication:
 *   1. POST /api/auth/passkey/auth/begin       → returns PublicKeyCredentialRequestOptions
 *   2. POST /api/auth/passkey/auth/complete    → verifies assertion, returns session token
 */

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from './db.js';
import type { AuthContext } from './auth.js';
import { newUUIDv7 } from '@weaveintel/core';

/* ─── Constants ──────────────────────────────────────────────────────── */

const CHALLENGE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

/* ─── Minimal CBOR decoder (RFC 7049 subset for COSE keys) ──────────── */

interface CborDecodeResult { value: unknown; bytesConsumed: number }

function decodeCbor(buf: Uint8Array, offset = 0): CborDecodeResult {
  const first = buf[offset]!;
  const majorType = first >> 5;
  const addInfo = first & 0x1f;

  function readLength(ai: number, off: number): { length: number; off: number } {
    if (ai < 24) return { length: ai, off };
    if (ai === 24) return { length: buf[off]!, off: off + 1 };
    if (ai === 25) return { length: (buf[off]! << 8) | buf[off + 1]!, off: off + 2 };
    if (ai === 26) {
      const v = ((buf[off]! << 24) >>> 0) + ((buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!);
      return { length: v, off: off + 4 };
    }
    throw new Error(`CBOR: unsupported additional info ${ai}`);
  }

  let off = offset + 1;

  if (majorType === 0) {
    // Unsigned integer
    const { length, off: newOff } = readLength(addInfo, off);
    return { value: length, bytesConsumed: newOff - offset };
  }
  if (majorType === 1) {
    // Negative integer: -1 - n
    const { length, off: newOff } = readLength(addInfo, off);
    return { value: -1 - length, bytesConsumed: newOff - offset };
  }
  if (majorType === 2) {
    // Byte string
    const { length, off: newOff } = readLength(addInfo, off);
    return { value: buf.slice(newOff, newOff + length), bytesConsumed: newOff + length - offset };
  }
  if (majorType === 3) {
    // Text string
    const { length, off: newOff } = readLength(addInfo, off);
    const text = Buffer.from(buf.slice(newOff, newOff + length)).toString('utf8');
    return { value: text, bytesConsumed: newOff + length - offset };
  }
  if (majorType === 4) {
    // Array
    const { length: numItems, off: newOff } = readLength(addInfo, off);
    const arr: unknown[] = [];
    let cur = newOff;
    for (let i = 0; i < numItems; i++) {
      const r = decodeCbor(buf, cur);
      arr.push(r.value);
      cur += r.bytesConsumed;
    }
    return { value: arr, bytesConsumed: cur - offset };
  }
  if (majorType === 5) {
    // Map
    const { length: numPairs, off: newOff } = readLength(addInfo, off);
    const map = new Map<unknown, unknown>();
    let cur = newOff;
    for (let i = 0; i < numPairs; i++) {
      const k = decodeCbor(buf, cur);
      cur += k.bytesConsumed;
      const v = decodeCbor(buf, cur);
      cur += v.bytesConsumed;
      map.set(k.value, v.value);
    }
    return { value: map, bytesConsumed: cur - offset };
  }
  if (majorType === 6) {
    // Tag — skip tag number, return tagged value
    const { off: newOff } = readLength(addInfo, off);
    const r = decodeCbor(buf, newOff);
    return { value: r.value, bytesConsumed: newOff + r.bytesConsumed - offset };
  }
  throw new Error(`CBOR: unsupported major type ${majorType}`);
}

/* ─── COSE key → SubjectPublicKeyInfo DER ───────────────────────────── */

/**
 * Convert a COSE public key (encoded as CBOR map) to a CryptoKey for
 * signature verification. Only ES256 (P-256) and RS256 are supported.
 */
async function importCoseKey(coseKeyBytes: Uint8Array): Promise<CryptoKey> {
  const { value } = decodeCbor(coseKeyBytes);
  if (!(value instanceof Map)) throw new Error('COSE key must be a CBOR map');
  const map = value as Map<unknown, unknown>;

  const kty = map.get(1) as number; // 1=kty
  const alg = map.get(3) as number; // 3=alg

  if (kty === 2 && alg === -7) {
    // EC2, ES256 (ECDSA P-256 SHA-256)
    const x = map.get(-2) as Uint8Array;
    const y = map.get(-3) as Uint8Array;
    if (!x || !y || x.length !== 32 || y.length !== 32) {
      throw new Error('COSE EC2 key missing or invalid x/y coordinates');
    }
    // Uncompressed EC point: 0x04 || x || y
    const rawKey = new Uint8Array(65);
    rawKey[0] = 0x04;
    rawKey.set(x, 1);
    rawKey.set(y, 33);
    return globalThis.crypto.subtle.importKey(
      'raw', rawKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
  }
  if (kty === 3 && alg === -257) {
    // RSA, RS256 (RSASSA-PKCS1-v1_5 SHA-256)
    const n = map.get(-1) as Uint8Array;
    const e = map.get(-2) as Uint8Array;
    if (!n || !e) throw new Error('COSE RSA key missing n/e');
    // Build JWK for RSA key import
    const jwk = {
      kty: 'RSA',
      alg: 'RS256',
      n: Buffer.from(n).toString('base64url'),
      e: Buffer.from(e).toString('base64url'),
      key_ops: ['verify'],
      ext: true,
    };
    return globalThis.crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
  }
  throw new Error(`Unsupported COSE algorithm kty=${kty} alg=${alg}. Only ES256 and RS256 are supported.`);
}

/* ─── Authenticator data parsing ────────────────────────────────────── */

interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  attestedCredentialData?: {
    aaguid: string;
    credentialId: Uint8Array;
    credentialPublicKey: Uint8Array;
  };
}

function parseAuthenticatorData(buf: Uint8Array): AuthenticatorData {
  if (buf.length < 37) throw new Error('authenticatorData too short');
  const rpIdHash = buf.slice(0, 32);
  const flags = buf[32]!;
  const signCount = (buf[33]! << 24) | (buf[34]! << 16) | (buf[35]! << 8) | buf[36]!;

  let attestedCredentialData: AuthenticatorData['attestedCredentialData'] | undefined;
  if (flags & 0x40) {
    // Attested Credential Data present (AT flag)
    let off = 37;
    const aaguidBytes = buf.slice(off, off + 16);
    off += 16;
    const aaguid = Array.from(aaguidBytes)
      .map((b, i) => {
        const hex = b.toString(16).padStart(2, '0');
        return [4, 6, 8, 10].includes(i) ? `-${hex}` : hex;
      })
      .join('');
    const credIdLen = (buf[off]! << 8) | buf[off + 1]!;
    off += 2;
    const credentialId = buf.slice(off, off + credIdLen);
    off += credIdLen;
    const credentialPublicKey = buf.slice(off);
    attestedCredentialData = { aaguid, credentialId, credentialPublicKey };
  }

  return { rpIdHash, flags, signCount, attestedCredentialData };
}

/* ─── Registration ───────────────────────────────────────────────────── */

/**
 * Step 1: Generate a registration challenge and return the
 * PublicKeyCredentialCreationOptions payload for the browser.
 */
export async function handlePasskeyRegisterBegin(
  _req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
  db: DatabaseAdapter,
  config: { rpId: string; rpName: string; origin: string },
  json: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<void> {
  const challenge = randomBytes(32);
  const challengeB64 = challenge.toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

  // Store the challenge in DB for later verification.
  await db.createWebAuthnChallenge({
    id: newUUIDv7(),
    userId: auth.userId,
    challenge: challengeB64,
    type: 'registration',
    expiresAt,
  });

  // Fetch existing credentials to populate excludeCredentials.
  const existing = await db.listPasskeyCredentials(auth.userId);

  json(res, 200, {
    challenge: challengeB64,
    rp: { id: config.rpId, name: config.rpName },
    user: {
      id: Buffer.from(auth.userId).toString('base64url'),
      name: auth.email,
      displayName: auth.email,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },   // ES256
      { type: 'public-key', alg: -257 },  // RS256
    ],
    timeout: CHALLENGE_TTL_MS,
    attestation: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((c) => ({
      type: 'public-key',
      id: c.credential_id,
    })),
  });
}

/**
 * Step 2: Verify the attestation and store the new credential.
 * Body: { id, rawId, response: { clientDataJSON, attestationObject }, type }
 */
export async function handlePasskeyRegisterComplete(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
  db: DatabaseAdapter,
  config: { rpId: string; origin: string },
  json: (res: ServerResponse, status: number, body: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<unknown>,
): Promise<void> {
  const body = await readBody(req) as Record<string, unknown> | null;
  if (!body) { json(res, 400, { error: 'missing body' }); return; }

  const credentialId = typeof body['id'] === 'string' ? body['id'] : null;
  const responseObj = body['response'] as Record<string, unknown> | undefined;
  if (!credentialId || !responseObj) { json(res, 400, { error: 'invalid credential' }); return; }

  // Retrieve and consume the pending challenge.
  const pendingChallenge = await db.consumeWebAuthnChallenge(auth.userId, 'registration');
  if (!pendingChallenge) { json(res, 400, { error: 'no_pending_challenge' }); return; }
  if (new Date(pendingChallenge.expires_at).getTime() < Date.now()) {
    json(res, 400, { error: 'challenge_expired' });
    return;
  }

  try {
    const clientDataJSON = Buffer.from(responseObj['clientDataJSON'] as string, 'base64url').toString('utf8');
    const clientData = JSON.parse(clientDataJSON) as Record<string, unknown>;

    // Verify type
    if (clientData['type'] !== 'webauthn.create') {
      json(res, 400, { error: 'invalid_client_data_type' }); return;
    }
    // Verify challenge
    if (clientData['challenge'] !== pendingChallenge.challenge) {
      json(res, 400, { error: 'challenge_mismatch' }); return;
    }
    // Verify origin
    if (clientData['origin'] !== config.origin) {
      json(res, 400, { error: 'origin_mismatch' }); return;
    }

    // Parse attestationObject (CBOR)
    const attestationObjectBytes = Buffer.from(responseObj['attestationObject'] as string, 'base64url');
    const { value: attestationMap } = decodeCbor(new Uint8Array(attestationObjectBytes));
    if (!(attestationMap instanceof Map)) { json(res, 400, { error: 'invalid_attestation' }); return; }

    const authDataBytes = attestationMap.get('authData') as Uint8Array | undefined;
    if (!authDataBytes) { json(res, 400, { error: 'missing_authData' }); return; }

    const authData = parseAuthenticatorData(authDataBytes);

    // Verify RP ID hash
    const expectedRpIdHash = createHash('sha256').update(config.rpId).digest();
    if (!expectedRpIdHash.equals(Buffer.from(authData.rpIdHash))) {
      json(res, 400, { error: 'rp_id_mismatch' }); return;
    }
    // Verify user-present flag (UP)
    if (!(authData.flags & 0x01)) {
      json(res, 400, { error: 'user_not_present' }); return;
    }

    if (!authData.attestedCredentialData) {
      json(res, 400, { error: 'no_attested_credential_data' }); return;
    }

    const { aaguid, credentialId: credIdBytes, credentialPublicKey } = authData.attestedCredentialData;

    // Verify credential ID matches what the browser reported
    const reportedCredId = credentialId; // base64url
    const derivedCredId = Buffer.from(credIdBytes).toString('base64url');
    if (reportedCredId !== derivedCredId) {
      json(res, 400, { error: 'credential_id_mismatch' }); return;
    }

    // Validate the COSE public key is parseable/importable (throws on unsupported alg).
    await importCoseKey(credentialPublicKey);

    const transports = Array.isArray(responseObj['transports'])
      ? (responseObj['transports'] as string[]).join(',')
      : null;

    await db.createPasskeyCredential({
      id: newUUIDv7(),
      userId: auth.userId,
      credentialId: derivedCredId,
      publicKeyCose: Buffer.from(credentialPublicKey).toString('base64'),
      aaguid,
      counter: authData.signCount,
      transports,
    });

    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: 'verification_failed', detail: (err as Error).message });
  }
}

/* ─── Authentication ─────────────────────────────────────────────────── */

/**
 * Step 1: Generate an authentication challenge.
 * Body (optional): { credentialId?: string }
 */
export async function handlePasskeyAuthBegin(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseAdapter,
  config: { rpId: string; origin: string },
  json: (res: ServerResponse, status: number, body: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<unknown>,
): Promise<void> {
  const body = await readBody(req) as Record<string, unknown> | null;
  const credentialId = typeof body?.['credentialId'] === 'string' ? body['credentialId'] : null;

  const challenge = randomBytes(32);
  const challengeB64 = challenge.toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

  // For resident-key / usernameless flows, userId is unknown at this stage.
  // Store challenge under a temporary anonymous ID.
  const challengeId = newUUIDv7();
  await db.createWebAuthnChallenge({
    id: challengeId,
    userId: null,
    challenge: challengeB64,
    type: 'authentication',
    expiresAt,
  });

  const allowCredentials = credentialId
    ? [{ type: 'public-key', id: credentialId }]
    : [];

  json(res, 200, {
    challengeId,        // client echoes this back in /auth/complete
    challenge: challengeB64,
    rpId: config.rpId,
    timeout: CHALLENGE_TTL_MS,
    userVerification: 'preferred',
    allowCredentials,
  });
}

/**
 * Step 2: Verify the assertion and return an auth token.
 * Body: { challengeId, id, rawId, response: { clientDataJSON, authenticatorData, signature, userHandle }, type }
 */
export async function handlePasskeyAuthComplete(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseAdapter,
  config: { rpId: string; origin: string },
  json: (res: ServerResponse, status: number, body: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<unknown>,
  issueSession: (userId: string, email: string) => Promise<{ token: string; csrfToken: string }>,
): Promise<void> {
  const body = await readBody(req) as Record<string, unknown> | null;
  if (!body) { json(res, 400, { error: 'missing body' }); return; }

  const challengeId = typeof body['challengeId'] === 'string' ? body['challengeId'] : null;
  const credentialId = typeof body['id'] === 'string' ? body['id'] : null;
  const responseObj = body['response'] as Record<string, unknown> | undefined;

  if (!challengeId || !credentialId || !responseObj) {
    json(res, 400, { error: 'invalid request' }); return;
  }

  // Retrieve and consume the challenge.
  const pendingChallenge = await db.consumeWebAuthnChallengeById(challengeId);
  if (!pendingChallenge) { json(res, 400, { error: 'no_pending_challenge' }); return; }
  if (new Date(pendingChallenge.expires_at).getTime() < Date.now()) {
    json(res, 400, { error: 'challenge_expired' }); return;
  }

  // Look up the stored credential.
  const credential = await db.getPasskeyCredentialById(credentialId);
  if (!credential) { json(res, 401, { error: 'credential_not_found' }); return; }

  try {
    const clientDataJSON = Buffer.from(responseObj['clientDataJSON'] as string, 'base64url').toString('utf8');
    const clientData = JSON.parse(clientDataJSON) as Record<string, unknown>;

    if (clientData['type'] !== 'webauthn.get') {
      json(res, 400, { error: 'invalid_client_data_type' }); return;
    }
    if (clientData['challenge'] !== pendingChallenge.challenge) {
      json(res, 400, { error: 'challenge_mismatch' }); return;
    }
    if (clientData['origin'] !== config.origin) {
      json(res, 400, { error: 'origin_mismatch' }); return;
    }

    const authDataBytes = Buffer.from(responseObj['authenticatorData'] as string, 'base64url');
    const authData = parseAuthenticatorData(new Uint8Array(authDataBytes));

    // Verify RP ID hash
    const expectedRpIdHash = createHash('sha256').update(config.rpId).digest();
    if (!expectedRpIdHash.equals(Buffer.from(authData.rpIdHash))) {
      json(res, 400, { error: 'rp_id_mismatch' }); return;
    }
    // Verify user-present flag
    if (!(authData.flags & 0x01)) {
      json(res, 400, { error: 'user_not_present' }); return;
    }

    // Verify signature over authData || SHA-256(clientDataJSON)
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    const verificationData = Buffer.concat([authDataBytes, clientDataHash]);
    const signatureBytes = Buffer.from(responseObj['signature'] as string, 'base64url');
    const coseKeyBytes = Buffer.from(credential.public_key_cose, 'base64');
    const publicKey = await importCoseKey(new Uint8Array(coseKeyBytes));

    const verified = await globalThis.crypto.subtle.verify(
      publicKey.algorithm,
      publicKey,
      signatureBytes,
      verificationData,
    );

    if (!verified) { json(res, 401, { error: 'signature_invalid' }); return; }

    // Verify signature counter (replay attack prevention).
    // A counter of 0 from the authenticator means the device doesn't
    // track a counter (e.g. platform authenticators) — skip the check.
    if (authData.signCount > 0 && authData.signCount <= credential.counter) {
      json(res, 401, { error: 'counter_mismatch' }); return;
    }

    // Update the counter.
    await db.updatePasskeyCounter(credential.id, authData.signCount);

    // Look up the user and issue a session.
    const user = await db.getUserById(credential.user_id);
    if (!user) { json(res, 401, { error: 'user_not_found' }); return; }

    const { token, csrfToken } = await issueSession(user.id, user.email);
    json(res, 200, { ok: true, token, csrfToken });
  } catch (err) {
    json(res, 400, { error: 'verification_failed', detail: (err as Error).message });
  }
}
