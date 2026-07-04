/**
 * use-profile.ts — react-query hook backing the Profile screen (M8).
 *
 * Device-gated (auth provider + react-query). Fetches the authoritative
 * `GET /api/auth/me` record so the persona-gated "Manage on web →" affordance
 * reflects the current server truth (not just the cached login snapshot), and
 * derives the display fields via the pure brain in `src/lib`. Falls back to the
 * auth-store `user` while the fetch is in flight so the screen never flashes
 * empty. Biometric + sign-out stay on the controller; this hook only owns the
 * identity + web-management surface.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MeUser } from '@weaveintel/api-client';
import { useAuth } from '../providers/auth-provider';
import {
  avatarInitials,
  buildManageUrl,
  canManageOnWeb,
  displayName,
  personaLabel,
} from '../../lib';

const ME_KEY = ['profile', 'me'] as const;

export interface UseProfileResult {
  user: MeUser | null;
  host: string | null;
  name: string;
  initials: string;
  persona: string;
  /** True when the signed-in persona may administer the org on the web. */
  canManageWeb: boolean;
  /** The `${host}/admin` URL, or null when unavailable / not an admin. */
  manageUrl: string | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useProfile(): UseProfileResult {
  const { state, client } = useAuth();
  const authed = state.status === 'authenticated' && client !== null;
  const fallbackUser = state.status === 'authenticated' ? state.user : null;
  const host = state.status === 'authenticated' ? state.host : null;

  const meQuery = useQuery({
    queryKey: ME_KEY,
    enabled: authed,
    queryFn: async (): Promise<MeUser | null> => (client ? client.getCurrentUser() : null),
  });

  const user = meQuery.data ?? fallbackUser;
  const persona = user?.persona ?? null;

  return useMemo(() => {
    const canManageWeb = canManageOnWeb(persona);
    return {
      user,
      host,
      name: user ? displayName(user) : 'You',
      initials: user ? avatarInitials(user) : '·',
      persona: personaLabel(persona),
      canManageWeb,
      manageUrl: canManageWeb ? buildManageUrl(host) : null,
      isLoading: meQuery.isLoading && !fallbackUser,
      isError: meQuery.isError,
      refetch: () => void meQuery.refetch(),
    };
  }, [user, host, persona, fallbackUser, meQuery.isLoading, meQuery.isError, meQuery]);
}
