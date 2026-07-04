/**
 * profile-view.ts — pure presentation logic for the Profile screen (M8).
 *
 * Frameworks-free: no React, no react-native, no network. Takes the `MeUser`
 * from `GET /api/auth/me` and derives the display fields the profile tree
 * renders — the avatar initials, a friendly display name, and the gate that
 * decides whether the "Manage on web →" affordance is shown (admins only). The
 * native screen stays a thin view over these helpers, so the persona gating and
 * label derivation are unit-tested in Node.
 */

import type { MeUser } from '@weaveintel/api-client';

/**
 * Personas that may administer the tenant on the web console. A persona is
 * treated as an admin when it is one of the known admin roles OR it ends in
 * `_admin` / `_owner` (forward-compatible with new tenant-scoped admin roles),
 * so a server that introduces `billing_admin` later still lights up the link
 * without a client change.
 */
const KNOWN_ADMIN_PERSONAS = new Set(['tenant_admin', 'platform_admin', 'owner', 'admin']);

/**
 * True when the signed-in persona may manage the organization on the web. Only
 * admins see the "Manage on web →" deep link; a regular `tenant_user` does not.
 * Unknown / missing persona is treated as non-admin (fail-closed).
 */
export function canManageOnWeb(persona: string | null | undefined): boolean {
  if (!persona) return false;
  const p = persona.trim().toLowerCase();
  if (KNOWN_ADMIN_PERSONAS.has(p)) return true;
  return p.endsWith('_admin') || p.endsWith('_owner');
}

/**
 * The web console URL for the signed-in user's host. The mobile app talks to a
 * normalized `host` (e.g. `https://app.example.com`); the web console lives at
 * `${host}/admin`. Returns null when the host is missing so the caller can hide
 * the link rather than render a broken one.
 */
export function buildManageUrl(host: string | null | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  return `${trimmed}/admin`;
}

/** A friendly display name: the user's `name`, falling back to the email local-part. */
export function displayName(user: Pick<MeUser, 'name' | 'email'>): string {
  const name = user.name?.trim();
  if (name) return name;
  const email = user.email?.trim() ?? '';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email || 'You';
}

/**
 * Up to two uppercase initials for the avatar. Derived from the display name:
 * two words → first letter of each; one word → its first two letters. Falls
 * back to a single dot when nothing usable is present.
 */
export function avatarInitials(user: Pick<MeUser, 'name' | 'email'>): string {
  const base = displayName(user).trim();
  if (!base) return '·';
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return base.slice(0, 2).toUpperCase();
}

/** A human label for the persona shown under the name (e.g. `Tenant admin`). */
export function personaLabel(persona: string | null | undefined): string {
  const p = persona?.trim();
  if (!p) return 'Member';
  return p
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
