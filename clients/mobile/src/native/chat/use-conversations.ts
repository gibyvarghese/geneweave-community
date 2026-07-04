/**
 * use-conversations.ts — react-query hook backing the Chats tab (M6).
 *
 * Device-gated (depends on the auth provider + react-query). It wraps the
 * api-client's `listConversations` / `updateConversation` and layers on:
 *   • a debounced server-side text search (the server also matches message
 *     bodies, which the client can't see, so search stays server-backed),
 *   • client-side chip + mode filtering and sectioning via the pure
 *     `buildConversationView` brain in `src/lib`,
 *   • optimistic pin / archive / rename mutations with rollback on error.
 *
 * The screen stays a thin renderer over the returned `sections`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Conversation } from '@weaveintel/api-client';
import { useAuth } from '../providers/auth-provider';
import {
  applyConversationPatch,
  buildConversationView,
  type ConversationChip,
  type ConversationFlagPatch,
  type ConversationSection,
} from '../../lib';

const QUERY_KEY_PREFIX = 'conversations' as const;
const SEARCH_DEBOUNCE_MS = 300;

export interface UseConversationsParams {
  /** Raw search box text (debounced internally before hitting the server). */
  query: string;
  /** Active filter chip (client-side). */
  chip: ConversationChip;
  /** Optional conversation mode filter (client-side). */
  mode?: string | null;
}

export interface UseConversationsResult {
  sections: ConversationSection[];
  total: number;
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  /** Optimistically pin / unpin / archive / rename a conversation. */
  setFlags: (id: string, patch: ConversationFlagPatch) => void;
  isMutating: boolean;
}

/** Debounce a changing string value. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function useConversations(params: UseConversationsParams): UseConversationsResult {
  const { query, chip, mode = null } = params;
  const { state, client } = useAuth();
  const authed = state.status === 'authenticated' && client !== null;
  const qc = useQueryClient();

  const debouncedQuery = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const queryKey = useMemo(() => [QUERY_KEY_PREFIX, debouncedQuery] as const, [debouncedQuery]);

  const list = useQuery({
    queryKey,
    enabled: authed,
    queryFn: async (): Promise<Conversation[]> => {
      if (!client) return [];
      // Server filters archived out ('active') and matches message bodies for
      // the text query; chip/mode narrowing happens client-side below.
      return client.listConversations({
        filter: 'active',
        ...(debouncedQuery ? { query: debouncedQuery } : {}),
      });
    },
  });

  const data = list.data ?? EMPTY;

  // Sectioning is pure; chip + mode are applied client-side. The text query is
  // NOT re-applied here — the server already filtered on it (and saw more than
  // the client can), so re-filtering would hide valid matches.
  const sections = useMemo(
    () => buildConversationView(data, { chip, mode }),
    [data, chip, mode],
  );

  const total = useMemo(() => sections.reduce((n, s) => n + s.items.length, 0), [sections]);

  // Track in-flight optimistic context for rollback.
  const rollbackRef = useRef<Array<[readonly unknown[], Conversation[]]>>([]);

  const mutation = useMutation({
    mutationFn: async (vars: { id: string; patch: ConversationFlagPatch }) => {
      if (!client) throw new Error('Not connected');
      return client.updateConversation(vars.id, vars.patch);
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: [QUERY_KEY_PREFIX] });
      const snapshots = qc.getQueriesData<Conversation[]>({ queryKey: [QUERY_KEY_PREFIX] });
      rollbackRef.current = snapshots.map(([key, value]) => [key, value ?? []]);
      for (const [key, value] of snapshots) {
        qc.setQueryData<Conversation[]>(key, applyConversationPatch(value ?? [], vars.id, vars.patch));
      }
    },
    onError: () => {
      for (const [key, value] of rollbackRef.current) {
        qc.setQueryData<Conversation[]>(key, value);
      }
      rollbackRef.current = [];
    },
    onSettled: () => {
      rollbackRef.current = [];
      void qc.invalidateQueries({ queryKey: [QUERY_KEY_PREFIX] });
    },
  });

  return {
    sections,
    total,
    isLoading: list.isLoading,
    isRefetching: list.isRefetching,
    isError: list.isError,
    error: list.error,
    refetch: () => void list.refetch(),
    setFlags: (id, patch) => mutation.mutate({ id, patch }),
    isMutating: mutation.isPending,
  };
}

const EMPTY: Conversation[] = [];
