/**
 * agenda-api.ts — WC2/WC4 loaders for agenda items and categories.
 *
 * loadCalendarItems() fetches the current month's agenda items and caches
 * them in state.calendarItems. It also loads categories into state.calendarCategories.
 *
 * quickAddAgendaItem() sends a POST to /api/me/agenda with either structured
 * fields or a free-text `nlText` for NL quick-add (WC4). The server does a
 * heuristic date/kind parse and returns the persisted item.
 */

import { state } from './state.js';
import { api } from './api.js';
import type { AgendaItem, AgendaCategory } from './state.js';
import { getCalendarFocusDate } from './state.js';

export async function loadCalendarCategories(): Promise<void> {
  try {
    const res = await api.get('/api/me/agenda/categories');
    if (!res.ok) return;
    const { categories } = await res.json() as { categories: AgendaCategory[] };
    state.calendarCategories = categories;
  } catch {
    // fail silently — widget degrades to uncategorised
  }
}

export async function loadCalendarItems(opts?: {
  start?: string;
  end?: string;
  categoryId?: string;
}): Promise<void> {
  if (state.calendarLoading) return;
  state.calendarLoading = true;
  try {
    const focus = getCalendarFocusDate();
    const start = opts?.start ?? new Date(focus.getFullYear(), focus.getMonth(), 1).toISOString().slice(0, 10);
    // Load three months of items so month/week views are populated without re-fetching
    const endDate = new Date(focus.getFullYear(), focus.getMonth() + 3, 0);
    const end = opts?.end ?? endDate.toISOString().slice(0, 10);

    const params = new URLSearchParams({ start, end, limit: '300' });
    if (opts?.categoryId) params.set('category', opts.categoryId);
    if (state.calendarCategoryFilter) params.set('category', state.calendarCategoryFilter);

    const res = await api.get(`/api/me/agenda?${params.toString()}`);
    if (!res.ok) return;
    const { items } = await res.json() as { items: AgendaItem[] };
    state.calendarItems = items;
  } catch (err) {
    console.warn('[agenda-api] load error', err);
  } finally {
    state.calendarLoading = false;
  }
}

export async function quickAddAgendaItem(input: {
  nlText?: string;
  title?: string;
  kind?: string;
  startAt?: string;
  allDay?: boolean;
  categoryId?: string;
}): Promise<AgendaItem | null> {
  state.calendarQuickAddLoading = true;
  try {
    const body: Record<string, unknown> = {};
    if (input.nlText) body['nlText'] = input.nlText;
    if (input.title) body['title'] = input.title;
    if (input.kind) body['kind'] = input.kind;
    if (input.startAt) body['start_at'] = input.startAt;
    if (input.allDay !== undefined) body['all_day'] = input.allDay ? 1 : 0;
    if (input.categoryId) body['category_id'] = input.categoryId;

    const res = await api.post('/api/me/agenda', body);
    if (!res.ok) return null;
    const item = await res.json() as AgendaItem;
    // Prepend to local state so UI updates immediately
    state.calendarItems = [item, ...state.calendarItems];
    state.calendarQuickAdd = '';
    return item;
  } catch (err) {
    console.warn('[agenda-api] quick-add error', err);
    return null;
  } finally {
    state.calendarQuickAddLoading = false;
  }
}

/** Bucket label for an agenda item's start_at relative to today. */
export function bucketLabel(startAt: string | null): string {
  if (!startAt) return 'Unscheduled';
  const d = new Date(startAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return 'Overdue';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return 'This week';
  if (diff < 14) return 'Next week';
  return 'Later';
}

export const BUCKET_ORDER = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Next week', 'Later', 'Unscheduled'];

/** Group agenda items into named buckets. */
export function bucketItems(items: AgendaItem[]): Map<string, AgendaItem[]> {
  const map = new Map<string, AgendaItem[]>();
  for (const bucket of BUCKET_ORDER) map.set(bucket, []);
  for (const item of items) {
    const label = bucketLabel(item.start_at);
    const bucket = map.get(label) ?? [];
    bucket.push(item);
    map.set(label, bucket);
  }
  // Remove empty buckets except Today
  for (const [key, list] of map) {
    if (list.length === 0 && key !== 'Today') map.delete(key);
  }
  return map;
}

/** Category colour for an agenda item (falls back to accent). */
export function itemCategoryColor(item: AgendaItem, categories: AgendaCategory[]): string {
  if (!item.category_id) return '#7C5CFC';
  const cat = categories.find((c) => c.id === item.category_id);
  return cat?.color ?? '#7C5CFC';
}

/** Format a time label for an agenda item chip. */
export function formatItemTime(item: AgendaItem): string {
  if (!item.start_at) return '';
  if (item.all_day) return 'All day';
  return new Date(item.start_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
