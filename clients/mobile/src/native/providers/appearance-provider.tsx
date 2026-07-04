/**
 * appearance-provider.tsx — local theme-preference store (M8).
 *
 * Holds the user's appearance choice (`system` / `light` / `dark`) above the
 * theme provider so the Settings screen can change it at runtime and the whole
 * app re-skins. There is no server route for appearance (build-plan flag #2),
 * so the preference is persisted LOCALLY (non-hardware-backed store) and defaults
 * to `system`. Wrap this OUTSIDE {@link AppProviders} and feed `preference` into
 * its `themePreference` prop; the Settings screen reads/writes via
 * {@link useAppearance}.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ThemePreference } from '../../lib';
import { createAsyncStoreKv } from '../adapters/expo-async-store';

const PREF_KEY = 'geneweave.appearance.preference';
const VALID: readonly ThemePreference[] = ['system', 'light', 'dark'];

interface AppearanceContextValue {
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const kv = useMemo(() => createAsyncStoreKv(), []);
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  // Load the persisted preference once on mount.
  useEffect(() => {
    let active = true;
    void Promise.resolve(kv.getItem(PREF_KEY)).then((raw: string | null) => {
      if (active && raw && (VALID as readonly string[]).includes(raw)) {
        setPreferenceState(raw as ThemePreference);
      }
    });
    return () => {
      active = false;
    };
  }, [kv]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      preference,
      setPreference: (pref: ThemePreference) => {
        setPreferenceState(pref);
        void kv.setItem(PREF_KEY, pref);
      },
    }),
    [preference, kv],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

/** Read + update the local appearance preference. */
export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used within an AppearanceProvider');
  return ctx;
}
