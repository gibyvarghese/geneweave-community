/**
 * host.ts — validate that a host is a reachable geneWeave server.
 *
 * Pure logic over an injected {@link HostProbe}: the production probe creates a
 * throwaway api-client and calls `getCatalog('mobile')` (the lightest
 * authenticated-optional surface that proves the server speaks the mobile
 * protocol); tests inject a fake probe. No React / RN / expo imports.
 */

import { tryNormalizeHost } from '../config/env.js';

/**
 * Probes a normalized host. Resolves `{ reachable: true, surfaceId }` when the
 * server answers the mobile catalog, `{ reachable: false }` otherwise. A probe
 * MUST NOT throw — network/parse failures are reported as `reachable: false`.
 */
export interface HostProbe {
  (host: string): Promise<{ reachable: boolean; surfaceId?: string }>;
}

/** Result of validating a candidate host. */
export type HostValidation =
  | { ok: true; host: string; surfaceId: string }
  | { ok: false; host: string; reason: string };

const FRIENDLY_UNREACHABLE =
  "Couldn't reach that server. Check the address and your connection, then try again.";
const FRIENDLY_INVALID = "That doesn't look like a valid server address.";

/**
 * Normalizes and probes a candidate host, returning a UI-friendly result.
 * Never throws: an unparseable address or an unreachable server both come back
 * as `{ ok: false, reason }` so the picker screen can render a calm message.
 */
export async function validateHost(probe: HostProbe, rawHost: string): Promise<HostValidation> {
  const host = tryNormalizeHost(rawHost);
  if (!host) return { ok: false, host: rawHost, reason: FRIENDLY_INVALID };
  let result: { reachable: boolean; surfaceId?: string };
  try {
    result = await probe(host);
  } catch {
    return { ok: false, host, reason: FRIENDLY_UNREACHABLE };
  }
  if (!result.reachable) return { ok: false, host, reason: FRIENDLY_UNREACHABLE };
  return { ok: true, host, surfaceId: result.surfaceId ?? 'mobile' };
}
