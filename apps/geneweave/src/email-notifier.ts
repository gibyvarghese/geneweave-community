/**
 * email-notifier.ts — Pluggable email notification interface.
 *
 * GeneWeave ships a ConsoleEmailNotifier that writes the rendered email to
 * stdout (safe for development, CI, and early production where SMTP is not yet
 * wired). Replace it at boot with any real implementation:
 *
 *   import { ResendEmailNotifier } from './email-notifier-resend.js';
 *   app.setEmailNotifier(new ResendEmailNotifier({ apiKey: process.env.RESEND_API_KEY }));
 *
 * The interface is intentionally narrow — only the transactional mails the auth
 * system needs. Marketing, digest, and notification emails belong in a separate
 * notification system (see packages/notifications).
 */

export interface EmailNotifier {
  /** Send a one-time email-address verification link. */
  sendVerificationEmail(opts: {
    to: string;
    name: string;
    verificationUrl: string;
    expiresInHours: number;
  }): Promise<void>;

  /** Send an admin-issued invitation to join the platform. */
  sendInvitationEmail(opts: {
    to: string;
    inviterName: string;
    invitationUrl: string;
    persona: string;
    expiresInHours: number;
  }): Promise<void>;
}

// ── Console implementation (dev / fallback) ──────────────────────────────────

import { createLogger } from '@weaveintel/core';
const emailLogger = createLogger('email-notifier');

export class ConsoleEmailNotifier implements EmailNotifier {
  async sendVerificationEmail(opts: {
    to: string;
    name: string;
    verificationUrl: string;
    expiresInHours: number;
  }): Promise<void> {
    emailLogger.info([
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║  [EMAIL] Verify your email address                           ║',
      '╚══════════════════════════════════════════════════════════════╝',
      `To      : ${opts.to}`,
      `Name    : ${opts.name}`,
      `Expires : ${opts.expiresInHours}h`,
      '',
      `  Click to verify: ${opts.verificationUrl}`,
      '',
      '(No real email was sent — configure an EmailNotifier for production)',
      '',
    ].join('\n'));
  }

  async sendInvitationEmail(opts: {
    to: string;
    inviterName: string;
    invitationUrl: string;
    persona: string;
    expiresInHours: number;
  }): Promise<void> {
    emailLogger.info([
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║  [EMAIL] You have been invited to WeaveIntel                 ║',
      '╚══════════════════════════════════════════════════════════════╝',
      `To      : ${opts.to}`,
      `Inviter : ${opts.inviterName}`,
      `Role    : ${opts.persona}`,
      `Expires : ${opts.expiresInHours}h`,
      '',
      `  Accept invitation: ${opts.invitationUrl}`,
      '',
      '(No real email was sent — configure an EmailNotifier for production)',
      '',
    ].join('\n'));
  }
}

// ── Module-level singleton (swappable at boot) ───────────────────────────────

let _notifier: EmailNotifier = new ConsoleEmailNotifier();

export function getEmailNotifier(): EmailNotifier {
  return _notifier;
}

export function setEmailNotifier(notifier: EmailNotifier): void {
  _notifier = notifier;
}
