/**
 * use-actions.ts — react-query hook backing the Actions tab (M7).
 *
 * Device-gated (depends on the auth provider + react-query). It wraps the
 * api-client's task + reminder surface and layers on:
 *   • two queries — `listTasks` (approvals + action-items) and `listReminders`,
 *   • client-side segmentation + badge math via the pure brain in `src/lib`,
 *   • optimistic mutations with rollback: approve / deny (idempotent — an
 *     already-resolved task resolves quietly), complete / cancel, snooze
 *     (reschedule) and delete.
 *
 * The screen stays a thin renderer over the returned segments + handlers.
 */
import { useCallback, useMemo, useRef } from 'react';
import type React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationAction, Reminder, Task } from '@weaveintel/api-client';
import { useAuth } from '../providers/auth-provider';
import {
  applyReminderReschedule,
  buildActionItems,
  buildApprovals,
  buildReminders,
  countActionsBadge,
  removeReminder,
  removeTask,
  snoozeTargetIso,
  type SnoozeChoice,
} from '../../lib';

const TASKS_KEY = ['actions', 'tasks'] as const;
const REMINDERS_KEY = ['actions', 'reminders'] as const;

export interface UseActionsResult {
  approvals: Task[];
  actionItems: Task[];
  reminders: Reminder[];
  /** Tab badge: pending approvals + action-items due today. */
  badgeCount: number;
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  refetch: () => void;
  isMutating: boolean;
  /** Approve or deny an approval task. Optimistically removes the row. */
  resolveApproval: (taskId: string, actionId: NotificationAction) => void;
  /** Mark an action-item done. Optimistically removes the row. */
  completeTask: (taskId: string) => void;
  /** Dismiss an action-item. Optimistically removes the row. */
  cancelTask: (taskId: string) => void;
  /** Snooze a reminder to a relative target (1h / tonight / tomorrow). */
  snoozeReminder: (reminderId: string, choice: SnoozeChoice) => void;
  /** Delete a reminder. Optimistically removes the row. */
  deleteReminder: (reminderId: string) => void;
}

const EMPTY_TASKS: Task[] = [];
const EMPTY_REMINDERS: Reminder[] = [];

export function useActions(): UseActionsResult {
  const { state, client } = useAuth();
  const authed = state.status === 'authenticated' && client !== null;
  const qc = useQueryClient();

  const tasksQuery = useQuery({
    queryKey: TASKS_KEY,
    enabled: authed,
    queryFn: async (): Promise<Task[]> => (client ? client.listTasks() : []),
  });

  const remindersQuery = useQuery({
    queryKey: REMINDERS_KEY,
    enabled: authed,
    queryFn: async (): Promise<Reminder[]> => (client ? client.listReminders() : []),
  });

  const tasks = tasksQuery.data ?? EMPTY_TASKS;
  const reminders = remindersQuery.data ?? EMPTY_REMINDERS;

  const approvals = useMemo(() => buildApprovals(tasks), [tasks]);
  const actionItems = useMemo(() => buildActionItems(tasks), [tasks]);
  const reminderList = useMemo(() => buildReminders(reminders), [reminders]);
  const badgeCount = useMemo(() => countActionsBadge(tasks), [tasks]);

  // ── Task mutations (approve/deny/complete/cancel all optimistically drop the row) ──
  // M-15: Each mutation gets its own rollback ref so concurrent mutations don't
  // overwrite each other's snapshot (shared ref would let the last onMutate win).
  const approveRollback = useRef<Task[] | null>(null);
  const completeRollback = useRef<Task[] | null>(null);
  const cancelRollback = useRef<Task[] | null>(null);

  const makeOptimisticDrop = useCallback(
    (rollback: React.MutableRefObject<Task[] | null>) =>
      async (taskId: string) => {
        await qc.cancelQueries({ queryKey: TASKS_KEY });
        rollback.current = qc.getQueryData<Task[]>(TASKS_KEY) ?? [];
        qc.setQueryData<Task[]>(TASKS_KEY, (prev) => removeTask(prev ?? [], taskId));
      },
    [qc],
  );
  const makeRollback = useCallback(
    (rollback: React.MutableRefObject<Task[] | null>) =>
      () => {
        if (rollback.current) qc.setQueryData<Task[]>(TASKS_KEY, rollback.current);
        rollback.current = null;
      },
    [qc],
  );
  const makeSettle = useCallback(
    (rollback: React.MutableRefObject<Task[] | null>) =>
      () => {
        rollback.current = null;
        void qc.invalidateQueries({ queryKey: TASKS_KEY });
      },
    [qc],
  );

  const approveMutation = useMutation({
    mutationFn: async (vars: { taskId: string; actionId: NotificationAction }) => {
      if (!client) throw new Error('Not connected');
      // Idempotent server-side: an already-resolved task returns quietly; the
      // row is already gone optimistically, so there is nothing more to do.
      return client.resolveNotificationAction(vars);
    },
    onMutate: (vars) => makeOptimisticDrop(approveRollback)(vars.taskId),
    onError: makeRollback(approveRollback),
    onSettled: makeSettle(approveRollback),
  });

  const completeMutation = useMutation({
    mutationFn: async (taskId: string) => {
      if (!client) throw new Error('Not connected');
      return client.completeTask(taskId);
    },
    onMutate: makeOptimisticDrop(completeRollback),
    onError: makeRollback(completeRollback),
    onSettled: makeSettle(completeRollback),
  });

  const cancelMutation = useMutation({
    mutationFn: async (taskId: string) => {
      if (!client) throw new Error('Not connected');
      return client.cancelTask(taskId);
    },
    onMutate: makeOptimisticDrop(cancelRollback),
    onError: makeRollback(cancelRollback),
    onSettled: makeSettle(cancelRollback),
  });

  // ── Reminder mutations ──────────────────────────────────────────────────
  const reminderRollback = useRef<Reminder[] | null>(null);
  const snapshotReminders = useCallback(async () => {
    await qc.cancelQueries({ queryKey: REMINDERS_KEY });
    reminderRollback.current = qc.getQueryData<Reminder[]>(REMINDERS_KEY) ?? [];
  }, [qc]);
  const rollbackReminders = useCallback(() => {
    if (reminderRollback.current) qc.setQueryData<Reminder[]>(REMINDERS_KEY, reminderRollback.current);
    reminderRollback.current = null;
  }, [qc]);
  const settleReminders = useCallback(() => {
    reminderRollback.current = null;
    void qc.invalidateQueries({ queryKey: REMINDERS_KEY });
  }, [qc]);

  const snoozeMutation = useMutation({
    mutationFn: async (vars: { reminderId: string; fireAt: string }) => {
      if (!client) throw new Error('Not connected');
      return client.rescheduleReminder(vars.reminderId, vars.fireAt);
    },
    onMutate: async (vars) => {
      await snapshotReminders();
      qc.setQueryData<Reminder[]>(REMINDERS_KEY, (prev) =>
        applyReminderReschedule(prev ?? [], vars.reminderId, vars.fireAt),
      );
    },
    onError: rollbackReminders,
    onSettled: settleReminders,
  });

  const deleteMutation = useMutation({
    mutationFn: async (reminderId: string) => {
      if (!client) throw new Error('Not connected');
      return client.deleteReminder(reminderId);
    },
    onMutate: async (reminderId) => {
      await snapshotReminders();
      qc.setQueryData<Reminder[]>(REMINDERS_KEY, (prev) => removeReminder(prev ?? [], reminderId));
    },
    onError: rollbackReminders,
    onSettled: settleReminders,
  });

  const isMutating =
    approveMutation.isPending ||
    completeMutation.isPending ||
    cancelMutation.isPending ||
    snoozeMutation.isPending ||
    deleteMutation.isPending;

  return {
    approvals,
    actionItems,
    reminders: reminderList,
    badgeCount,
    isLoading: tasksQuery.isLoading || remindersQuery.isLoading,
    isRefetching: tasksQuery.isRefetching || remindersQuery.isRefetching,
    isError: tasksQuery.isError || remindersQuery.isError,
    refetch: () => {
      void tasksQuery.refetch();
      void remindersQuery.refetch();
    },
    isMutating,
    resolveApproval: (taskId, actionId) => approveMutation.mutate({ taskId, actionId }),
    completeTask: (taskId) => completeMutation.mutate(taskId),
    cancelTask: (taskId) => cancelMutation.mutate(taskId),
    snoozeReminder: (reminderId, choice) =>
      snoozeMutation.mutate({ reminderId, fireAt: snoozeTargetIso(choice) }),
    deleteReminder: (reminderId) => deleteMutation.mutate(reminderId),
  };
}
