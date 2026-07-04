/**
 * use-settings.ts — react-query hook backing the notification settings (M8).
 *
 * Device-gated (auth provider + react-query). Wraps
 * `GET/PUT /api/me/notification-preferences` and exposes optimistic toggles for
 * the master switch, per-category switches, and the quiet-hours window. The
 * server stores `quietHours` as an opaque string; the IANA timezone is encoded
 * into it by the pure brain in `src/lib` (there is no separate tz column). All
 * normalization + encoding lives in `src/lib`; the settings screen is a thin
 * renderer over the returned prefs + handlers.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationPreferences } from '@weaveintel/api-client';
import { useAuth } from '../providers/auth-provider';
import {
  defaultNotificationPreferences,
  encodeQuietHours,
  normalizeNotificationPreferences,
  toggleCategory,
  type QuietHours,
} from '../../lib';

const PREFS_KEY = ['settings', 'notification-preferences'] as const;

export interface UseSettingsResult {
  prefs: NotificationPreferences;
  isLoading: boolean;
  isError: boolean;
  isSaving: boolean;
  error: string | null;
  refetch: () => void;
  /** Master notifications on/off. */
  setEnabled: (enabled: boolean) => void;
  /** Toggle a single category. */
  toggleCategory: (categoryId: string) => void;
  /** Set the quiet-hours window (tz encoded into the stored string). */
  setQuietHours: (window: QuietHours | null) => void;
}

export function useSettings(): UseSettingsResult {
  const { state, client } = useAuth();
  const authed = state.status === 'authenticated' && client !== null;
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const prefsQuery = useQuery({
    queryKey: PREFS_KEY,
    enabled: authed,
    queryFn: async (): Promise<NotificationPreferences> =>
      client ? normalizeNotificationPreferences(await client.getNotificationPreferences()) : defaultNotificationPreferences(),
  });

  const prefs = prefsQuery.data ?? defaultNotificationPreferences();

  const rollback = useRef<NotificationPreferences | null>(null);
  const save = useMutation({
    mutationFn: async (next: NotificationPreferences) => {
      if (!client) throw new Error('Not connected');
      return client.setNotificationPreferences(next);
    },
    onMutate: async (next: NotificationPreferences) => {
      await qc.cancelQueries({ queryKey: PREFS_KEY });
      rollback.current = qc.getQueryData<NotificationPreferences>(PREFS_KEY) ?? prefs;
      qc.setQueryData<NotificationPreferences>(PREFS_KEY, next);
      setError(null);
    },
    onError: (err) => {
      if (rollback.current) qc.setQueryData<NotificationPreferences>(PREFS_KEY, rollback.current);
      rollback.current = null;
      setError(err instanceof Error ? err.message : 'Could not save preferences.');
    },
    onSettled: () => {
      rollback.current = null;
      void qc.invalidateQueries({ queryKey: PREFS_KEY });
    },
  });

  const persist = useCallback((next: NotificationPreferences) => save.mutate(next), [save]);

  return useMemo(
    () => ({
      prefs,
      isLoading: prefsQuery.isLoading,
      isError: prefsQuery.isError,
      isSaving: save.isPending,
      error,
      refetch: () => void prefsQuery.refetch(),
      setEnabled: (enabled: boolean) => persist({ ...prefs, enabled }),
      toggleCategory: (categoryId: string) => persist(toggleCategory(prefs, categoryId)),
      setQuietHours: (window: QuietHours | null) =>
        persist({ ...prefs, quietHours: window ? encodeQuietHours(window) : null }),
    }),
    [prefs, prefsQuery.isLoading, prefsQuery.isError, prefsQuery, save.isPending, error, persist],
  );
}
