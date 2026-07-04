/**
 * action-list.test.ts — pure unit tests for the Actions tab logic (M7).
 */
import { describe, it, expect } from 'vitest';
import type { Reminder, Task } from '@weaveintel/api-client';
import {
  isOpenTask,
  isApproval,
  isDueToday,
  buildApprovals,
  buildActionItems,
  buildReminders,
  reminderFireAt,
  reminderIsRecurring,
  reminderLabel,
  reminderIsEnabled,
  countActionsBadge,
  removeTask,
  removeReminder,
  applyReminderReschedule,
  snoozeTargetIso,
  formatDueLabel,
  taskConversationId,
  reminderConversationId,
} from './action-list.js';

const NOW = Date.parse('2026-06-15T12:00:00.000Z'); // a Monday, noon UTC

/** An ISO timestamp at local noon `days` away from `now` — timezone-independent. */
function localDayIso(days: number, now: number = NOW): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    id: over.id,
    title: over.title ?? `Task ${over.id}`,
    status: over.status ?? 'pending',
    ...(over.assignee !== undefined ? { assignee: over.assignee } : {}),
    ...(over.description !== undefined ? { description: over.description } : {}),
    ...(over.dueAt !== undefined ? { dueAt: over.dueAt } : {}),
    ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
    ...(over.completedAt !== undefined ? { completedAt: over.completedAt } : {}),
    ...(over.provenance !== undefined ? { provenance: over.provenance } : {}),
    ...(over.data !== undefined ? { data: over.data } : {}),
  } as Task;
}

function reminder(over: Partial<Reminder> & { id: string }): Reminder {
  return { ...over } as Reminder;
}

describe('isOpenTask', () => {
  it('treats pending/assigned/in-review/escalated as open', () => {
    for (const s of ['pending', 'assigned', 'in-review', 'escalated']) {
      expect(isOpenTask(task({ id: 't', status: s }))).toBe(true);
    }
  });
  it('treats completed/rejected/expired as closed', () => {
    for (const s of ['completed', 'rejected', 'expired']) {
      expect(isOpenTask(task({ id: 't', status: s }))).toBe(false);
    }
  });
});

describe('isApproval', () => {
  it('is true only when data.actionable === true', () => {
    expect(isApproval(task({ id: 'a', data: { actionable: true } }))).toBe(true);
    expect(isApproval(task({ id: 'b', data: { actionable: false } }))).toBe(false);
    expect(isApproval(task({ id: 'c' }))).toBe(false);
    expect(isApproval(task({ id: 'd', data: null as unknown as Record<string, unknown> }))).toBe(false);
  });
});

describe('isDueToday', () => {
  it('matches same calendar day, rejects other days and bad input', () => {
    expect(isDueToday(localDayIso(0), NOW)).toBe(true);
    expect(isDueToday(localDayIso(1), NOW)).toBe(false);
    expect(isDueToday(localDayIso(-1), NOW)).toBe(false);
    expect(isDueToday(null, NOW)).toBe(false);
    expect(isDueToday('not-a-date', NOW)).toBe(false);
  });
});

describe('buildApprovals / buildActionItems', () => {
  const tasks = [
    task({ id: 'ap1', data: { actionable: true }, createdAt: '2026-06-15T09:00:00.000Z' }),
    task({ id: 'ap2', data: { actionable: true }, createdAt: '2026-06-15T11:00:00.000Z' }),
    task({ id: 'done', data: { actionable: true }, status: 'completed', createdAt: '2026-06-15T10:00:00.000Z' }),
    task({ id: 'todo1', dueAt: '2026-06-20T00:00:00.000Z' }),
    task({ id: 'todo2', dueAt: '2026-06-16T00:00:00.000Z' }),
    task({ id: 'todo3' }), // no due date → sorts last
  ];

  it('approvals: only open actionable tasks, newest first', () => {
    expect(buildApprovals(tasks).map((t) => t.id)).toEqual(['ap2', 'ap1']);
  });

  it('action-items: only open non-approvals, soonest due first, undated last', () => {
    expect(buildActionItems(tasks).map((t) => t.id)).toEqual(['todo2', 'todo1', 'todo3']);
  });
});

describe('reminders', () => {
  it('reads fireAt / rrule / label / enabled', () => {
    const oneShot = reminder({ id: 'r1', label: 'Call back', source: { kind: 'cron', config: { fireAt: '2026-06-16T09:00:00.000Z' } } });
    const recurring = reminder({ id: 'r2', source: { kind: 'cron', config: { rrule: 'FREQ=DAILY;BYHOUR=9' } }, metadata: { label: 'Daily standup' } });
    expect(reminderFireAt(oneShot)).toBe('2026-06-16T09:00:00.000Z');
    expect(reminderFireAt(recurring)).toBeNull();
    expect(reminderIsRecurring(recurring)).toBe(true);
    expect(reminderIsRecurring(oneShot)).toBe(false);
    expect(reminderLabel(oneShot)).toBe('Call back');
    expect(reminderLabel(recurring)).toBe('Daily standup');
    expect(reminderIsEnabled(reminder({ id: 'r3', enabled: false }))).toBe(false);
    expect(reminderIsEnabled(reminder({ id: 'r4' }))).toBe(true);
  });

  it('sorts soonest fire first, undated/recurring last', () => {
    const items = [
      reminder({ id: 'late', source: { config: { fireAt: '2026-06-20T09:00:00.000Z' } } }),
      reminder({ id: 'recur', source: { config: { rrule: 'FREQ=DAILY' } } }),
      reminder({ id: 'soon', source: { config: { fireAt: '2026-06-16T09:00:00.000Z' } } }),
    ];
    expect(buildReminders(items).map((r) => r.id)).toEqual(['soon', 'late', 'recur']);
  });
});

describe('countActionsBadge', () => {
  it('counts pending approvals + action-items due today', () => {
    const tasks = [
      task({ id: 'ap', data: { actionable: true } }),
      task({ id: 'dueToday', dueAt: localDayIso(0) }),
      task({ id: 'dueLater', dueAt: localDayIso(5) }),
      task({ id: 'doneAp', data: { actionable: true }, status: 'completed' }),
    ];
    expect(countActionsBadge(tasks, NOW)).toBe(2);
  });
  it('is zero with nothing pending', () => {
    expect(countActionsBadge([], NOW)).toBe(0);
  });
});

describe('optimistic mutations', () => {
  it('removeTask / removeReminder drop by id', () => {
    expect(removeTask([task({ id: 'a' }), task({ id: 'b' })], 'a').map((t) => t.id)).toEqual(['b']);
    expect(removeReminder([reminder({ id: 'a' }), reminder({ id: 'b' })], 'b').map((r) => r.id)).toEqual(['a']);
  });

  it('applyReminderReschedule updates fireAt and re-enables', () => {
    const before = [reminder({ id: 'r', enabled: false, source: { config: { fireAt: '2026-06-16T09:00:00.000Z' } } })];
    const after = applyReminderReschedule(before, 'r', '2026-06-17T09:00:00.000Z');
    expect(after[0]!.enabled).toBe(true);
    expect(reminderFireAt(after[0]!)).toBe('2026-06-17T09:00:00.000Z');
  });
});

describe('snoozeTargetIso', () => {
  it('1h is exactly one hour later', () => {
    expect(snoozeTargetIso('1h', NOW)).toBe(new Date(NOW + 3600_000).toISOString());
  });
  it('tonight is 8pm local, or +1h if already past', () => {
    const morning = new Date(NOW);
    morning.setHours(6, 0, 0, 0);
    const tonight = new Date(snoozeTargetIso('tonight', morning.getTime()));
    expect(tonight.getHours()).toBe(20);
    // Past 8pm local → falls back to +1h.
    const late = new Date(NOW);
    late.setHours(23, 0, 0, 0);
    const fallback = snoozeTargetIso('tonight', late.getTime());
    expect(new Date(fallback).getTime()).toBe(late.getTime() + 3600_000);
  });
  it('tomorrow is 9am local next day', () => {
    const out = new Date(snoozeTargetIso('tomorrow', NOW));
    expect(out.getHours()).toBe(9);
    const today = new Date(NOW);
    expect(out.getDate()).toBe(today.getDate() + 1);
  });
});

describe('formatDueLabel', () => {
  it('labels relative days', () => {
    expect(formatDueLabel(localDayIso(0), NOW)).toBe('Today');
    expect(formatDueLabel(localDayIso(1), NOW)).toBe('Tomorrow');
    expect(formatDueLabel(localDayIso(-5), NOW)).toBe('Overdue');
    expect(formatDueLabel(null, NOW)).toBe('');
    expect(formatDueLabel('bad', NOW)).toBe('');
  });
  it('uses in-Nd for the coming week', () => {
    expect(formatDueLabel(localDayIso(3), NOW)).toBe('in 3d');
  });
});

describe('provenance deep-links', () => {
  it('reads sourceRunId from task and reminder provenance', () => {
    expect(taskConversationId(task({ id: 't', provenance: { sourceRunId: 'conv-1', createdBy: 'agent' } }))).toBe('conv-1');
    expect(taskConversationId(task({ id: 't' }))).toBeNull();
    expect(reminderConversationId(reminder({ id: 'r', provenance: { sourceRunId: 'conv-2' } }))).toBe('conv-2');
    expect(reminderConversationId(reminder({ id: 'r' }))).toBeNull();
  });
});
