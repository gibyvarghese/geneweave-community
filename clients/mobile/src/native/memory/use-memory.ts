/**
 * use-memory.ts — react-query hook backing the Memory screens (M8).
 *
 * Device-gated (auth provider + react-query). Wraps the api-client memory
 * surface (`GET/POST/PATCH/DELETE /api/me/memories`) and layers on:
 *   • one query holding the grouped {@link MemoryGroups} (semantic / entity /
 *     user-authored), with the server already hiding superseded originals,
 *   • optimistic mutations with rollback — add a note, correct a memory as a
 *     sentence (preserving lineage), delete a row, and clear-all,
 *   • org-managed detection: when the server fails a write with 403
 *     {@link ManagedByOrgError}, the hook flips `managedByOrg` so the screen can
 *     show a read-only banner and lock the controls.
 *
 * All grouping / provenance / lineage math lives in the pure brain in `src/lib`;
 * the screen is a thin renderer over the returned groups + handlers.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ManagedByOrgError, type CreatedMemory } from '@weaveintel/api-client';
import { useAuth } from '../providers/auth-provider';
import {
  addAuthoredMemory,
  applyCorrection,
  clearAllMemories,
  countMemories,
  memoryIsLocked,
  removeMemoryItem,
  type MemoryGroups,
} from '../../lib';

const MEMORY_KEY = ['memory', 'list'] as const;

function emptyGroups(): MemoryGroups {
  return { semantic: [], entity: [], 'user-authored': [] };
}

function tempCreated(content: string): CreatedMemory {
  return {
    id: `temp-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    content,
    kind: 'user-authored',
    createdAt: new Date().toISOString(),
  };
}

export interface UseMemoryResult {
  groups: MemoryGroups;
  total: number;
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  refetch: () => void;
  /** True once any item is locked or a write was rejected as org-managed. */
  managedByOrg: boolean;
  isMutating: boolean;
  /** The last mutation error message (cleared on the next successful mutate). */
  error: string | null;
  /** Add a new user-authored note (validated content). */
  addNote: (content: string) => void;
  /** Correct an existing memory by rewriting it; preserves lineage server-side. */
  correct: (id: string, content: string, reason?: string) => void;
  /** Delete a single memory row. */
  remove: (id: string) => void;
  /** Clear every memory (typed double-confirm enforced by the screen). */
  clearAll: () => Promise<void>;
}

export function useMemory(): UseMemoryResult {
  const { state, client } = useAuth();
  const authed = state.status === 'authenticated' && client !== null;
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [managedFromWrite, setManagedFromWrite] = useState(false);

  const listQuery = useQuery({
    queryKey: MEMORY_KEY,
    enabled: authed,
    queryFn: async (): Promise<MemoryGroups> => (client ? (await client.listMemories()).memories : emptyGroups()),
  });

  const groups = listQuery.data ?? emptyGroups();

  const lockedFromItems = useMemo(
    () =>
      groups.semantic.some(memoryIsLocked) ||
      groups.entity.some(memoryIsLocked) ||
      groups['user-authored'].some(memoryIsLocked),
    [groups],
  );

  // ── optimistic plumbing ───────────────────────────────────────────────
  const rollback = useRef<MemoryGroups | null>(null);
  const snapshot = useCallback(async () => {
    await qc.cancelQueries({ queryKey: MEMORY_KEY });
    rollback.current = qc.getQueryData<MemoryGroups>(MEMORY_KEY) ?? emptyGroups();
    setError(null);
  }, [qc]);
  const onError = useCallback((err: unknown) => {
    if (rollback.current) qc.setQueryData<MemoryGroups>(MEMORY_KEY, rollback.current);
    rollback.current = null;
    if (err instanceof ManagedByOrgError) {
      setManagedFromWrite(true);
      setError('Your organization manages this memory. It is read-only.');
    } else {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }, [qc]);
  const onSettled = useCallback(() => {
    rollback.current = null;
    void qc.invalidateQueries({ queryKey: MEMORY_KEY });
  }, [qc]);

  const addMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!client) throw new Error('Not connected');
      return client.createMemory({ content });
    },
    onMutate: async (content: string) => {
      await snapshot();
      qc.setQueryData<MemoryGroups>(MEMORY_KEY, (prev) => addAuthoredMemory(prev ?? emptyGroups(), tempCreated(content)));
    },
    onError,
    onSettled,
  });

  const correctMutation = useMutation({
    mutationFn: async (vars: { id: string; content: string; reason?: string }) => {
      if (!client) throw new Error('Not connected');
      return client.correctMemory(vars.id, { content: vars.content, ...(vars.reason !== undefined ? { reason: vars.reason } : {}) });
    },
    onMutate: async (vars) => {
      await snapshot();
      qc.setQueryData<MemoryGroups>(MEMORY_KEY, (prev) =>
        applyCorrection(prev ?? emptyGroups(), vars.id, { ...tempCreated(vars.content), correctedFrom: vars.id }),
      );
    },
    onError,
    onSettled,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!client) throw new Error('Not connected');
      return client.deleteMemory(id);
    },
    onMutate: async (id: string) => {
      await snapshot();
      qc.setQueryData<MemoryGroups>(MEMORY_KEY, (prev) => removeMemoryItem(prev ?? emptyGroups(), id));
    },
    onError,
    onSettled,
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Not connected');
      return client.clearMemories();
    },
    onMutate: async () => {
      await snapshot();
      qc.setQueryData<MemoryGroups>(MEMORY_KEY, clearAllMemories());
    },
    onError,
    onSettled,
  });

  const isMutating =
    addMutation.isPending || correctMutation.isPending || deleteMutation.isPending || clearMutation.isPending;

  return {
    groups,
    total: countMemories(groups),
    isLoading: listQuery.isLoading,
    isRefetching: listQuery.isRefetching,
    isError: listQuery.isError,
    refetch: () => void listQuery.refetch(),
    managedByOrg: lockedFromItems || managedFromWrite,
    isMutating,
    error,
    addNote: (content) => addMutation.mutate(content),
    correct: (id, content, reason) => correctMutation.mutate({ id, content, ...(reason !== undefined ? { reason } : {}) }),
    remove: (id) => deleteMutation.mutate(id),
    clearAll: () => clearMutation.mutateAsync(),
  };
}
