/**
 * action-feed.ts — WC1 data loader and merge logic.
 *
 * Fetches /api/me/tasks and /api/me/reminders, merges them with any proposed
 * agenda items from /api/me/agenda?status=proposed, and produces a unified
 * ActionFeedItem list sorted by urgency:
 *   overdue → due-soon (within 24 h) → proposed → normal
 *
 * Each item carries a type badge ('approval' | 'task' | 'reminder' | 'agenda')
 * so the widget can render the correct chip color without re-fetching.
 */

import { state } from './state.js';
import { api } from './api.js';
import type { ActionFeedItem } from './state.js';

const NOW_MS = () => Date.now();
const H24 = 24 * 60 * 60 * 1000;

function urgency(dueAt: string | null | undefined): ActionFeedItem['urgency'] {
  if (!dueAt) return 'normal';
  const ms = new Date(dueAt).getTime() - NOW_MS();
  if (ms < 0) return 'overdue';
  if (ms < H24) return 'due-soon';
  return 'normal';
}

function urgencyRank(u: ActionFeedItem['urgency']): number {
  switch (u) {
    case 'overdue': return 0;
    case 'due-soon': return 1;
    case 'proposed': return 2;
    default: return 3;
  }
}

function formatDue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = d.getTime() - Date.now();
  if (diff < 0) return `Overdue ${d.toLocaleDateString()}`;
  if (diff < H24) return `Due ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  return `Due ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export async function loadActionFeed(): Promise<void> {
  if (state.actionFeedLoading) return;
  state.actionFeedLoading = true;

  try {
    const [tasksRes, remindersRes, agendaRes] = await Promise.allSettled([
      api.get('/api/me/tasks'),
      api.get('/api/me/reminders'),
      api.get('/api/me/agenda?status=proposed&limit=20'),
    ]);

    const items: ActionFeedItem[] = [];

    // ── Tasks ──────────────────────────────────────────────────────────────
    if (tasksRes.status === 'fulfilled' && tasksRes.value.ok) {
      const { tasks } = await tasksRes.value.json() as { tasks: Array<{
        id: string; title: string; status: string; due_at?: string | null;
        data?: { actionable?: boolean };
        metadata?: { conversationId?: string; conversation_id?: string };
      }> };
      for (const t of tasks) {
        if (t.status === 'completed' || t.status === 'rejected' || t.status === 'cancelled' || t.status === 'expired') continue;
        const isApproval = t.data?.actionable === true;
        const dueAt = t.due_at ?? null;
        const u = urgency(dueAt);
        items.push({
          id: t.id,
          type: isApproval ? 'approval' : 'task',
          title: t.title,
          sub: dueAt ? formatDue(dueAt) : 'Task',
          urgency: u,
          conversationId: t.metadata?.conversationId ?? t.metadata?.conversation_id,
          dueAt: dueAt ?? undefined,
        });
      }
    }

    // ── Reminders ──────────────────────────────────────────────────────────
    if (remindersRes.status === 'fulfilled' && remindersRes.value.ok) {
      const { reminders } = await remindersRes.value.json() as { reminders: Array<{
        id: string;
        enabled: boolean;
        metadata?: { label?: string; oneShot?: boolean };
        source?: { config?: { fireAt?: string; label?: string } };
        target?: { config?: { label?: string } };
      }> };
      for (const r of reminders) {
        if (!r.enabled) continue;
        const fireAt = r.source?.config?.fireAt ?? null;
        const label = r.metadata?.label ?? r.target?.config?.label ?? r.source?.config?.label ?? 'Reminder';
        const u = urgency(fireAt);
        items.push({
          id: r.id,
          type: 'reminder',
          title: label,
          sub: fireAt ? formatDue(fireAt) : 'Reminder',
          urgency: u,
          dueAt: fireAt ?? undefined,
        });
      }
    }

    // ── Proposed agenda items ──────────────────────────────────────────────
    if (agendaRes.status === 'fulfilled' && agendaRes.value.ok) {
      const { items: agendaItems } = await agendaRes.value.json() as { items: Array<{
        id: string; title: string; start_at: string | null; status: string;
      }> };
      for (const a of agendaItems) {
        if (a.status !== 'proposed') continue;
        items.push({
          id: a.id,
          type: 'agenda',
          title: a.title,
          sub: a.start_at ? formatDue(a.start_at) : 'Proposed event',
          urgency: 'proposed',
          dueAt: a.start_at ?? undefined,
        });
      }
    }

    // Sort by urgency rank first, then by dueAt
    items.sort((a, b) => {
      const rankDiff = urgencyRank(a.urgency) - urgencyRank(b.urgency);
      if (rankDiff !== 0) return rankDiff;
      const ams = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const bms = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      return ams - bms;
    });

    state.actionFeed = items;
  } catch (err) {
    console.warn('[action-feed] load error', err);
  } finally {
    state.actionFeedLoading = false;
  }
}
