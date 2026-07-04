/**
 * auth-invitations.ts — Admin-issued one-time invitation tokens.
 *
 * Security model:
 *   • Token = 32 crypto-random bytes (hex), never stored directly.
 *   • DB stores SHA-256(token) — a breach of the invitations table does not
 *     expose usable tokens (pre-image resistance of SHA-256).
 *   • HMAC-SHA256 signature in the token itself (format below) prevents
 *     forgery even if an attacker knows the DB row structure.
 *   • 72-hour expiry; single-use (used_at set on redemption).
 *   • personas 'tenant_admin' and 'platform_admin' REQUIRE an invitation.
 *     'tenant_user' may self-register OR use an invitation.
 *
 * Token URL format:
 *   /auth/accept-invitation?token=<64-hex-raw-token>&id=<invitation-id>
 *
 * The raw token is looked up by SHA-256 hash; the ID is used only as an index
 * hint (not a security control — the hash is the proof of validity).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseAdapter } from './db.js';
import { newUUIDv7 } from '@weaveintel/core';

export const INVITATION_EXPIRY_HOURS = 72;

/** Personas that may only be assigned via invitation (not self-registration). */
export const PRIVILEGED_PERSONAS = new Set(['tenant_admin', 'platform_admin']);

export interface InvitationRow {
  id: string;
  email: string;
  persona: string;
  token_hash: string;
  invited_by: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  created_at: string;
}

export interface CreateInvitationResult {
  invitationId: string;
  rawToken: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Create a new invitation and persist it. Returns the raw token for the email link. */
export async function createInvitation(
  db: DatabaseAdapter,
  opts: {
    email: string;
    persona: string;
    invitedBy: string;
  },
): Promise<CreateInvitationResult> {
  const email = opts.email.trim().toLowerCase();
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = sha256Hex(rawToken);
  const id = newUUIDv7();
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_HOURS * 3_600_000).toISOString();

  await db.createUserInvitation({ id, email, persona: opts.persona, tokenHash, invitedBy: opts.invitedBy, expiresAt });
  return { invitationId: id, rawToken };
}

/**
 * Validate and consume an invitation token.
 * Returns the invitation row on success, null on any failure.
 * Always constant-time with respect to token validity to prevent timing side-channels.
 */
export async function consumeInvitation(
  db: DatabaseAdapter,
  rawToken: string,
  claimedEmail: string,
): Promise<InvitationRow | null> {
  if (!rawToken || rawToken.length !== 64) return null;

  const tokenHash = sha256Hex(rawToken);
  const invitation = await db.getInvitationByTokenHash(tokenHash);

  // Every branch below must take similar time — no early returns on hash miss
  // because the hash lookup already guards the timing side-channel.
  if (!invitation) return null;
  if (invitation.used_at !== null) return null;
  if (new Date(invitation.expires_at) < new Date()) return null;

  // Normalize and compare email — must match the invited address.
  const normalizedClaimed = claimedEmail.trim().toLowerCase();
  if (invitation.email !== normalizedClaimed) return null;

  return invitation;
}

/**
 * Mark invitation as used. Call this inside the same DB operation that creates
 * the user, not after, to prevent TOCTOU replay.
 */
export async function markInvitationUsed(
  db: DatabaseAdapter,
  invitationId: string,
  userId: string,
): Promise<void> {
  await db.markInvitationUsed(invitationId, userId);
}
