/**
 * auth-email-verify.ts — Email address verification for new registrations.
 *
 * Security model:
 *   • Token = 32 crypto-random bytes (hex) — 256 bits of entropy; brute-force
 *     infeasible (2^256 search space at any realistic RPS).
 *   • DB stores SHA-256(token) so a breach of email_verifications exposes no
 *     usable tokens (SHA-256 is pre-image resistant).
 *   • 24-hour expiry, single-use (used_at set on claim).
 *   • Non-enumerable error message on verify: same response whether the token
 *     was never issued, already used, or expired (OWASP A07:2021).
 *   • Resend is rate-limited: one request per 60s per user.
 *   • Sign-in is blocked when email_verified = 0 (checked in login route).
 *
 * OAuth users (no password) are trusted-verified because the provider asserts
 * the email — set email_verified=1 on account creation for them.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseAdapter } from './db.js';
import { newUUIDv7 } from '@weaveintel/core';

export const VERIFICATION_EXPIRY_HOURS = 24;
export const RESEND_COOLDOWN_SECONDS = 60;

export interface EmailVerificationRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Issue a new verification token. Old tokens for the same user remain valid until expiry. */
export async function issueVerificationToken(
  db: DatabaseAdapter,
  userId: string,
): Promise<string> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = sha256Hex(rawToken);
  const id = newUUIDv7();
  const expiresAt = new Date(Date.now() + VERIFICATION_EXPIRY_HOURS * 3_600_000).toISOString();

  await db.createEmailVerification({ id, userId, tokenHash, expiresAt });
  return rawToken;
}

/**
 * Validate and consume a verification token.
 *
 * Returns the userId on success, null on any failure.
 * Returns the SAME null for: token not found, already used, expired.
 * This prevents enumeration via differential responses.
 */
export async function consumeVerificationToken(
  db: DatabaseAdapter,
  rawToken: string,
): Promise<string | null> {
  if (!rawToken || rawToken.length !== 64) return null;

  const tokenHash = sha256Hex(rawToken);
  const row = await db.getEmailVerificationByTokenHash(tokenHash);

  if (!row) return null;
  if (row.used_at !== null) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  await db.markEmailVerificationUsed(row.id, row.user_id);
  return row.user_id;
}

/**
 * Check whether a resend is permitted (enforces per-user cooldown).
 * Returns true if allowed, false if the cooldown has not elapsed.
 */
export async function canResendVerification(
  db: DatabaseAdapter,
  userId: string,
): Promise<boolean> {
  const latest = await db.getLatestEmailVerification(userId);
  if (!latest) return true;
  // SQLite datetime('now') is UTC but lacks a timezone suffix ('2026-01-02 10:11:12').
  // Normalise to ISO 8601 so Node.js parses it as UTC, not local time.
  const isoTs = latest.created_at.includes('T') ? latest.created_at : latest.created_at.replace(' ', 'T') + 'Z';
  const sentAt = new Date(isoTs).getTime();
  return Date.now() - sentAt >= RESEND_COOLDOWN_SECONDS * 1_000;
}
