/**
 * /api/me/agenda — user-scoped calendar agenda endpoints (WC2, WC4)
 *
 *   Categories:
 *     GET    /api/me/agenda/categories             list (system defaults + user-owned)
 *     POST   /api/me/agenda/categories             create user category
 *     PATCH  /api/me/agenda/categories/:id         update
 *     DELETE /api/me/agenda/categories/:id         delete (user-owned only)
 *
 *   Items:
 *     GET    /api/me/agenda                        list items (filters: start, end, kind, status, category)
 *     POST   /api/me/agenda                        create item (title, kind, start_at, end_at, all_day, …)
 *     GET    /api/me/agenda/:id                    get single item
 *     PATCH  /api/me/agenda/:id                    update
 *     DELETE /api/me/agenda/:id                    delete
 *
 *   Quick-add (WC4) — POST body may include `nlText` for natural-language parsing:
 *     The server does a lightweight heuristic parse (date extraction, duration, kind)
 *     before persisting. Full LLM NL parse can be added later as an agent call.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { Router } from '../server-core.js';
import { readBody } from '../server-core.js';
import type { DatabaseAdapter } from '../db-types.js';
import type { AgendaItemKind, AgendaItemStatus, AgendaItemSensitivity } from '../db-types/adapter-agenda-notes.js';
import { safePageInt } from './index.js';

// ── NL quick-parse heuristic ───────────────────────────────────────────────────
// Lightweight heuristic: extracts an ISO date/time from free text. Good enough
// for common patterns ("tomorrow at 3pm", "2026-06-20", "next Monday"). Falls
// back gracefully — if no date is found, start_at remains null.

// Simple +N day offsets — "tomorrow" always means +1 day, regardless of current DOW.
const DAY_OFFSETS: Record<string, number> = {
  'day after tomorrow': 2,
  tomorrow: 1,
  today: 0,
};
// Day-of-week targets (Sunday=0 … Saturday=6) — resolved to the NEXT occurrence.
const DOW_TARGETS: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6, sunday: 0,
};

// Format a Date as a local-time ISO string (no UTC conversion) so that
// "2pm tomorrow" typed by the user stays as 14:00 local in the DB.
function localISODateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function localISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function applyTime(d: Date, lower: string): { startAt: string; allDay: boolean } {
  // Named times: noon, midnight
  if (/\bnoon\b/.test(lower)) {
    d.setHours(12, 0, 0, 0);
    return { startAt: localISODateTime(d), allDay: false };
  }
  if (/\bmidnight\b/.test(lower)) {
    d.setHours(0, 0, 0, 0);
    return { startAt: localISODateTime(d), allDay: false };
  }
  const timeMatch = lower.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1] ?? '9', 10);
    const min = parseInt(timeMatch[2] ?? '0', 10);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    d.setHours(hour, min, 0, 0);
    return { startAt: localISODateTime(d), allDay: false };
  }
  return { startAt: localISODate(d), allDay: true };
}

function parseNlDate(text: string): { startAt: string | null; allDay: boolean } {
  const lower = text.toLowerCase();
  const now = new Date();

  // ISO date literal: 2026-06-20 or 2026-06-20T15:00
  const isoMatch = lower.match(/(\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2})?)?)/);
  if (isoMatch?.[1]) {
    const hasTime = isoMatch[1].includes('t');
    return { startAt: isoMatch[1].replace('t', 'T'), allDay: !hasTime };
  }

  // "today" / "tomorrow" / "day after tomorrow" — simple day offset
  for (const [word, offset] of Object.entries(DAY_OFFSETS)) {
    if (lower.includes(word)) {
      const d = new Date(now);
      d.setDate(d.getDate() + offset);
      return applyTime(d, lower);
    }
  }

  // "next Monday", "this Friday", "on Wednesday" — next occurrence of that DOW
  for (const [word, targetDow] of Object.entries(DOW_TARGETS)) {
    if (lower.includes(word)) {
      const d = new Date(now);
      const currentDow = d.getDay();
      let delta = (targetDow - currentDow + 7) % 7;
      if (delta === 0) delta = 7; // always future
      d.setDate(d.getDate() + delta);
      return applyTime(d, lower);
    }
  }

  return { startAt: null, allDay: false };
}

function inferKind(text: string): AgendaItemKind {
  const lower = text.toLowerCase();
  if (/reminder|remind|don.t forget/.test(lower)) return 'reminder';
  if (/deadline|due|submit|deliver/.test(lower)) return 'deadline';
  if (/meet|call|sync|standup|zoom|teams|appointment|checkup|dentist|doctor|consult|visit|clinic/.test(lower)) return 'appointment';
  if (/every|weekly|daily|monthly|recurring/.test(lower)) return 'recurring';
  if (/follow.?up|check.?in/.test(lower)) return 'follow-up';
  return 'event';
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerMeAgendaRoutes(router: Router, db: DatabaseAdapter): void {

  // ── Categories ──────────────────────────────────────────────────────────────

  router.get('/api/me/agenda/categories', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const categories = await db.listAgendaCategories(auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ categories }));
  }, { auth: true });

  router.post('/api/me/agenda/categories', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (!body['name']) { res.writeHead(400); res.end(JSON.stringify({ error: 'name is required' })); return; }
    await db.createAgendaCategory({
      id: newUUIDv7(),
      user_id: auth.userId,
      tenant_id: auth.tenantId ?? null,
      name: String(body['name']),
      color: typeof body['color'] === 'string' ? body['color'] : '#7C5CFC',
      icon: typeof body['icon'] === 'string' ? body['icon'] : '◆',
    });
    const categories = await db.listAgendaCategories(auth.userId);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ categories }));
  }, { auth: true });

  router.add('PATCH','/api/me/agenda/categories/:id', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const patch: Record<string, string> = {};
    if (typeof body['name'] === 'string') patch['name'] = body['name'];
    if (typeof body['color'] === 'string') patch['color'] = body['color'];
    if (typeof body['icon'] === 'string') patch['icon'] = body['icon'];
    await db.updateAgendaCategory(params['id']!, patch);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });

  router.del('/api/me/agenda/categories/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    await db.deleteAgendaCategory(params['id']!, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });

  // ── Items ───────────────────────────────────────────────────────────────────

  router.get('/api/me/agenda', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', `http://localhost`);
    const filter = {
      startAt: url.searchParams.get('start') ?? undefined,
      endAt: url.searchParams.get('end') ?? undefined,
      kind: (url.searchParams.get('kind') ?? undefined) as AgendaItemKind | undefined,
      status: (url.searchParams.get('status') ?? undefined) as AgendaItemStatus | undefined,
      categoryId: url.searchParams.get('category') ?? undefined,
      limit: safePageInt(url.searchParams.get('limit'), 50, 1, 500),
    };
    const items = await db.listAgendaItems(auth.userId, filter);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
  }, { auth: true });

  router.post('/api/me/agenda', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    // Natural-language quick-add: if `nlText` is provided, parse it.
    let title = typeof body['title'] === 'string' ? body['title'] : '';
    let startAt = typeof body['start_at'] === 'string' ? body['start_at'] : null;
    let allDay = typeof body['all_day'] === 'number' ? body['all_day'] : 0;
    let kind = (typeof body['kind'] === 'string' ? body['kind'] : 'event') as AgendaItemKind;

    if (typeof body['nlText'] === 'string' && body['nlText'].trim()) {
      const nlText = body['nlText'] as string;
      if (!title) title = nlText.split(/[.!?\n]/)[0]?.trim() ?? nlText;
      const parsed = parseNlDate(nlText);
      if (parsed.startAt && !startAt) startAt = parsed.startAt;
      if (parsed.allDay) allDay = 1;
      kind = inferKind(nlText);
    }

    if (!title) { res.writeHead(400); res.end(JSON.stringify({ error: 'title or nlText is required' })); return; }

    const id = newUUIDv7();
    await db.createAgendaItem({
      id,
      user_id: auth.userId,
      tenant_id: auth.tenantId ?? null,
      title,
      kind,
      category_id: typeof body['category_id'] === 'string' ? body['category_id'] : null,
      start_at: startAt,
      end_at: typeof body['end_at'] === 'string' ? body['end_at'] : null,
      all_day: allDay,
      location: typeof body['location'] === 'string' ? body['location'] : null,
      description: typeof body['description'] === 'string' ? body['description'] : null,
      recurrence_rule: typeof body['recurrence_rule'] === 'string' ? body['recurrence_rule'] : null,
      status: (typeof body['status'] === 'string' ? body['status'] : 'confirmed') as AgendaItemStatus,
      sensitivity: (typeof body['sensitivity'] === 'string' ? body['sensitivity'] : 'normal') as AgendaItemSensitivity,
      amount: typeof body['amount'] === 'string' ? body['amount'] : null,
      currency: typeof body['currency'] === 'string' ? body['currency'] : null,
      provenance: typeof body['provenance'] === 'object' && body['provenance'] !== null
        ? JSON.stringify(body['provenance'])
        : (typeof body['provenance'] === 'string' ? body['provenance'] : JSON.stringify({ source: 'manual' })),
    });

    const item = await db.getAgendaItem(id, auth.userId);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(item));
  }, { auth: true });

  router.get('/api/me/agenda/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const item = await db.getAgendaItem(params['id']!, auth.userId);
    if (!item) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(item));
  }, { auth: true });

  router.add('PATCH','/api/me/agenda/:id', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const patch: Parameters<typeof db.updateAgendaItem>[2] = {};
    if (typeof body['title'] === 'string') patch.title = body['title'];
    if (typeof body['kind'] === 'string') patch.kind = body['kind'] as AgendaItemKind;
    if ('category_id' in body) patch.category_id = typeof body['category_id'] === 'string' ? body['category_id'] : null;
    if ('start_at' in body) patch.start_at = typeof body['start_at'] === 'string' ? body['start_at'] : null;
    if ('end_at' in body) patch.end_at = typeof body['end_at'] === 'string' ? body['end_at'] : null;
    if (typeof body['all_day'] === 'number') patch.all_day = body['all_day'];
    if ('location' in body) patch.location = typeof body['location'] === 'string' ? body['location'] : null;
    if ('description' in body) patch.description = typeof body['description'] === 'string' ? body['description'] : null;
    if ('recurrence_rule' in body) patch.recurrence_rule = typeof body['recurrence_rule'] === 'string' ? body['recurrence_rule'] : null;
    if (typeof body['status'] === 'string') patch.status = body['status'] as AgendaItemStatus;
    if (typeof body['sensitivity'] === 'string') patch.sensitivity = body['sensitivity'] as AgendaItemSensitivity;
    if ('amount' in body) patch.amount = typeof body['amount'] === 'string' ? body['amount'] : null;
    if ('currency' in body) patch.currency = typeof body['currency'] === 'string' ? body['currency'] : null;
    if ('linked_task_id' in body) patch.linked_task_id = typeof body['linked_task_id'] === 'string' ? body['linked_task_id'] : null;
    if ('linked_run_id' in body) patch.linked_run_id = typeof body['linked_run_id'] === 'string' ? body['linked_run_id'] : null;
    if ('linked_note_id' in body) patch.linked_note_id = typeof body['linked_note_id'] === 'string' ? body['linked_note_id'] : null;

    await db.updateAgendaItem(params['id']!, auth.userId, patch);
    const item = await db.getAgendaItem(params['id']!, auth.userId);
    if (!item) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(item));
  }, { auth: true });

  router.del('/api/me/agenda/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const deleted = await db.deleteAgendaItem(params['id']!, auth.userId);
    if (!deleted) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });
}
