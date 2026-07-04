import type { DatabaseAdapter } from './db.js';
import type { TemporalStore, TimerRecord, StopwatchRecord, ReminderRecord } from '@weaveintel/tools/time';

export function createTemporalStore(db: DatabaseAdapter): TemporalStore {
  return {
    async saveTimer(scope, timer) {
      await db.upsertTemporalTimer({
        id: timer.id,
        scopeId: scope,
        label: timer.label ?? null,
        durationMs: timer.durationMs ?? null,
        state: timer.state,
        createdAt: timer.createdAt,
        startedAt: timer.startedAt ?? null,
        pausedAt: timer.pausedAt ?? null,
        resumedAt: timer.resumedAt ?? null,
        stoppedAt: timer.stoppedAt ?? null,
        elapsedMs: timer.elapsedMs,
      });
    },
    async getTimer(scope, timerId) {
      const row = await db.getTemporalTimer(scope, timerId);
      if (!row) return null;
      const timer: TimerRecord = {
        id: row.id,
        label: row.label ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        state: row.state as TimerRecord['state'],
        createdAt: row.created_at,
        startedAt: row.started_at ?? undefined,
        pausedAt: row.paused_at ?? undefined,
        resumedAt: row.resumed_at ?? undefined,
        stoppedAt: row.stopped_at ?? undefined,
        elapsedMs: row.elapsed_ms,
      };
      return timer;
    },
    async listTimers(scope) {
      const rows = await db.listTemporalTimers(scope);
      return rows.map((row) => ({
        id: row.id,
        label: row.label ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        state: row.state as TimerRecord['state'],
        createdAt: row.created_at,
        startedAt: row.started_at ?? undefined,
        pausedAt: row.paused_at ?? undefined,
        resumedAt: row.resumed_at ?? undefined,
        stoppedAt: row.stopped_at ?? undefined,
        elapsedMs: row.elapsed_ms,
      }));
    },
    async saveStopwatch(scope, watch) {
      await db.upsertTemporalStopwatch({
        id: watch.id,
        scopeId: scope,
        label: watch.label ?? null,
        state: watch.state,
        createdAt: watch.createdAt,
        startedAt: watch.startedAt ?? null,
        pausedAt: watch.pausedAt ?? null,
        resumedAt: watch.resumedAt ?? null,
        stoppedAt: watch.stoppedAt ?? null,
        elapsedMs: watch.elapsedMs,
        lapsJson: JSON.stringify(watch.laps ?? []),
      });
    },
    async getStopwatch(scope, watchId) {
      const row = await db.getTemporalStopwatch(scope, watchId);
      if (!row) return null;
      let laps: number[] = [];
      try {
        const parsed = JSON.parse(row.laps_json);
        if (Array.isArray(parsed)) laps = parsed.map((n) => Number(n));
      } catch {
        laps = [];
      }
      const watch: StopwatchRecord = {
        id: row.id,
        label: row.label ?? undefined,
        state: row.state as StopwatchRecord['state'],
        createdAt: row.created_at,
        startedAt: row.started_at ?? undefined,
        pausedAt: row.paused_at ?? undefined,
        resumedAt: row.resumed_at ?? undefined,
        stoppedAt: row.stopped_at ?? undefined,
        elapsedMs: row.elapsed_ms,
        laps,
      };
      return watch;
    },
    async listStopwatches(scope) {
      const rows = await db.listTemporalStopwatches(scope);
      return rows.map((row) => {
        let laps: number[] = [];
        try {
          const parsed = JSON.parse(row.laps_json);
          if (Array.isArray(parsed)) laps = parsed.map((n) => Number(n));
        } catch {
          laps = [];
        }
        return {
          id: row.id,
          label: row.label ?? undefined,
          state: row.state as StopwatchRecord['state'],
          createdAt: row.created_at,
          startedAt: row.started_at ?? undefined,
          pausedAt: row.paused_at ?? undefined,
          resumedAt: row.resumed_at ?? undefined,
          stoppedAt: row.stopped_at ?? undefined,
          elapsedMs: row.elapsed_ms,
          laps,
        };
      });
    },
    async saveReminder(scope, reminder) {
      await db.upsertTemporalReminder({
        id: reminder.id,
        scopeId: scope,
        text: reminder.text,
        dueAt: reminder.dueAt,
        timezone: reminder.timezone,
        status: reminder.status,
        createdAt: reminder.createdAt,
        cancelledAt: reminder.cancelledAt ?? null,
      });
    },
    async getReminder(scope, reminderId) {
      const row = await db.getTemporalReminder(scope, reminderId);
      if (!row) return null;
      const reminder: ReminderRecord = {
        id: row.id,
        text: row.text,
        dueAt: row.due_at,
        timezone: row.timezone,
        status: row.status as ReminderRecord['status'],
        createdAt: row.created_at,
        cancelledAt: row.cancelled_at ?? undefined,
      };
      return reminder;
    },
    async listReminders(scope) {
      const rows = await db.listTemporalReminders(scope);
      return rows.map((row) => ({
        id: row.id,
        text: row.text,
        dueAt: row.due_at,
        timezone: row.timezone,
        status: row.status as ReminderRecord['status'],
        createdAt: row.created_at,
        cancelledAt: row.cancelled_at ?? undefined,
      }));
    },
  };
}
