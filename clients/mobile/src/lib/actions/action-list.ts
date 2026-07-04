/**
 * action-list.ts — pure presentation logic for the Actions tab (M7).
 *
 * Frameworks-free: no React, no react-native, no network. Takes the `Task[]`
 * from `GET /api/me/tasks` and the `Reminder[]` from `GET /api/me/reminders`
 * and produces the three segments the Actions screen renders — Approvals,
 * Action-items, and Reminders — plus the tab badge count and the optimistic
 * local mutations. The native screen stays a thin view over these functions, so
 * the segmentation, sorting, snooze math, and badge rules are unit-tested in
 * Node.
 *
 * Segments:
 *   approvals    — open tasks flagged `data.actionable` (an agent/principal is
 *                  asking for an explicit approve/deny decision).
 *   action-items — every other open task assigned to the user (a plain to-do
 *                  completed via /complete, dismissed via /cancel).
 *   reminders    — scheduled nudges (one-shot `fireAt` or recurring `rrule`).
 *
 * A task is "open" until it reaches a terminal state (completed / rejected /
 * expired); terminal tasks drop out of every segment, so an optimistic
 * approve / complete simply removes the row.
 */

import type { Reminder, Task } from '@weaveintel/api-client';

// ---------------------------------------------------------------------------
// Task status helpers
// ---------------------------------------------------------------------------

/** Task statuses that mean "resolved" — these never appear in the active lists. */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'rejected', 'expired']);

/** True when a task is still awaiting the user (i.e. not in a terminal state). */
export function isOpenTask(task: Task): boolean {
  return !TERMINAL_TASK_STATUSES.has(task.status);
}

/**
 * True when a task is an "approval" — it requires an explicit approve/deny
 * decision. Grounded in the persisted `data.actionable` flag (set by the
 * server at create time), not a client-side guess.
 */
export function isApproval(task: Task): boolean {
  const data = task.data;
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>)['actionable'] === true;
}

/** Parse an ISO timestamp to epoch ms, or null when missing / unparseable. */
function toEpoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** True when `iso` falls on the same calendar day as `now` (local time). */
export function isDueToday(iso: string | null | undefined, now: number = Date.now()): boolean {
  const t = toEpoch(iso);
  if (t === null) return false;
  const a = new Date(t);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/** The three Actions segments. */
export type ActionSegment = 'approvals' | 'tasks' | 'reminders';

/** Ascending compare on `dueAt` (soonest first); tasks with no due date sort last. */
function byDueThenCreated(a: Task, b: Task): number {
  const da = toEpoch(a.dueAt);
  const db = toEpoch(b.dueAt);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  // Stable tiebreak: newest created first.
  const ca = toEpoch(a.createdAt) ?? 0;
  const cb = toEpoch(b.createdAt) ?? 0;
  return cb - ca;
}

/** Descending compare on `createdAt` (newest first). */
function byCreatedDesc(a: Task, b: Task): number {
  return (toEpoch(b.createdAt) ?? 0) - (toEpoch(a.createdAt) ?? 0);
}

/** Open approval tasks, newest decision request first. Pure. */
export function buildApprovals(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => isOpenTask(t) && isApproval(t)).sort(byCreatedDesc);
}

/** Open action-item tasks (non-approvals), soonest due first. Pure. */
export function buildActionItems(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => isOpenTask(t) && !isApproval(t)).sort(byDueThenCreated);
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** The next fire time of a reminder as ISO, or null for a recurring/undated one. */
export function reminderFireAt(reminder: Reminder): string | null {
  return reminder.source?.config?.fireAt ?? null;
}

/** True when a reminder repeats on an RRULE rather than firing once. */
export function reminderIsRecurring(reminder: Reminder): boolean {
  return typeof reminder.source?.config?.rrule === 'string' && reminder.source.config.rrule.length > 0;
}

/** Human label for a reminder, falling back through metadata then a default. */
export function reminderLabel(reminder: Reminder): string {
  return reminder.label?.trim() || reminder.metadata?.label?.trim() || 'Reminder';
}

/** True when a reminder is currently enabled (defaults to true when unset). */
export function reminderIsEnabled(reminder: Reminder): boolean {
  return reminder.enabled !== false;
}

/**
 * Reminders sorted by next fire time (soonest first); recurring / undated
 * reminders sort after dated one-shots. Pure.
 */
export function buildReminders(reminders: readonly Reminder[]): Reminder[] {
  return [...reminders].sort((a, b) => {
    const fa = toEpoch(reminderFireAt(a));
    const fb = toEpoch(reminderFireAt(b));
    if (fa === fb) return 0;
    if (fa === null) return 1;
    if (fb === null) return -1;
    return fa - fb;
  });
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/**
 * The Actions tab badge: pending approvals + action-items due today. Reminders
 * never contribute (they self-fire). Pure — `now` injectable for tests.
 */
export function countActionsBadge(tasks: readonly Task[], now: number = Date.now()): number {
  let n = 0;
  for (const t of tasks) {
    if (!isOpenTask(t)) continue;
    if (isApproval(t)) n += 1;
    else if (isDueToday(t.dueAt, now)) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Optimistic mutations
// ---------------------------------------------------------------------------

/** Drop a task from a local list (optimistic approve / deny / complete / cancel). Pure. */
export function removeTask(tasks: readonly Task[], id: string): Task[] {
  return tasks.filter((t) => t.id !== id);
}

/** Drop a reminder from a local list (optimistic delete). Pure. */
export function removeReminder(reminders: readonly Reminder[], id: string): Reminder[] {
  return reminders.filter((r) => r.id !== id);
}

/** Merge a fresh `fireAt` into a reminder after a snooze/reschedule. Pure. */
export function applyReminderReschedule(
  reminders: readonly Reminder[],
  id: string,
  fireAt: string,
): Reminder[] {
  return reminders.map((r) => {
    if (r.id !== id) return r;
    return {
      ...r,
      enabled: true,
      source: {
        ...(r.source ?? {}),
        config: { ...(r.source?.config ?? {}), fireAt },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Snooze math
// ---------------------------------------------------------------------------

/** The snooze chip choices offered on a reminder row. */
export type SnoozeChoice = '1h' | 'tonight' | 'tomorrow';

/**
 * Resolve a snooze choice to an absolute ISO fire time. Pure — `now`
 * injectable for deterministic tests.
 *   1h       — exactly one hour from now.
 *   tonight  — 8:00 PM local today (or +1h if it is already past 8 PM).
 *   tomorrow — 9:00 AM local tomorrow.
 */
export function snoozeTargetIso(choice: SnoozeChoice, now: number = Date.now()): string {
  const base = new Date(now);
  switch (choice) {
    case '1h':
      return new Date(now + 60 * 60 * 1000).toISOString();
    case 'tonight': {
      const tonight = new Date(base);
      tonight.setHours(20, 0, 0, 0);
      if (tonight.getTime() <= now) return new Date(now + 60 * 60 * 1000).toISOString();
      return tonight.toISOString();
    }
    case 'tomorrow': {
      const tomorrow = new Date(base);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return tomorrow.toISOString();
    }
  }
}

// ---------------------------------------------------------------------------
// Due-date formatting
// ---------------------------------------------------------------------------

/**
 * Compact due-date label for a task / reminder row: "Overdue", "Today",
 * "Tomorrow", "in 3d", or a short calendar date for anything further out.
 * Pure — `now` injectable. Missing / invalid input → ''.
 */
export function formatDueLabel(iso: string | null | undefined, now: number = Date.now()): string {
  const t = toEpoch(iso);
  if (t === null) return '';
  if (isDueToday(iso, now)) return 'Today';

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const target = new Date(t);
  target.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((target.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000));

  if (dayDiff < 0) return 'Overdue';
  if (dayDiff === 1) return 'Tomorrow';
  if (dayDiff < 7) return `in ${dayDiff}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Provenance / deep-linking
// ---------------------------------------------------------------------------

/**
 * The conversation a task deep-links to, taken from its provenance
 * (`sourceRunId`). Null when the task carries no run provenance. Pure.
 */
export function taskConversationId(task: Task): string | null {
  const p = task.provenance;
  if (typeof p !== 'object' || p === null) return null;
  const id = (p as Record<string, unknown>)['sourceRunId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The conversation a reminder deep-links to, taken from its provenance
 * (`sourceRunId`). Null when the reminder carries no run provenance. Pure.
 */
export function reminderConversationId(reminder: Reminder): string | null {
  const p = reminder.provenance;
  if (typeof p !== 'object' || p === null) return null;
  const id = (p as Record<string, unknown>)['sourceRunId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}
