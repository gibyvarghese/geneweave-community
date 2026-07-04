/**
 * calendar-view.ts — WC3 full-page calendar view
 *
 * Renders state.view === 'calendar' with three sub-views:
 *   • Agenda — default; bucket list (Today/Tomorrow/This week…); WC2 layout
 *   • Week   — 7-column week grid with hourly slots and event chips
 *   • Month  — traditional month grid with event chips + "+N more" popover
 *
 * All data comes from state.calendarItems (loaded by loadCalendarItems).
 * Category colours come from state.calendarCategories.
 * Quick-add is always visible at the top via an inline text input (WC4).
 */

import { h } from './dom.js';
import {
  state,
  getCalendarFocusDate,
  setCalendarFocusDate,
  shiftCalendarMonth,
  toYMD,
  type AgendaItem,
  type AgendaCategory,
} from './state.js';
import {
  bucketItems,
  bucketLabel,
  BUCKET_ORDER,
  itemCategoryColor,
  formatItemTime,
  quickAddAgendaItem,
  loadCalendarItems,
} from './agenda-api.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const WEEK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(d: Date): boolean {
  return sameDay(d, new Date());
}

function itemsForDay(items: AgendaItem[], d: Date): AgendaItem[] {
  const ymd = toYMD(d);
  return items.filter((it) => it.start_at?.slice(0, 10) === ymd);
}

function hourOf(iso: string | null): number {
  if (!iso) return 0;
  return new Date(iso).getHours();
}

// ── Quick-add bar ─────────────────────────────────────────────────────────────

function renderQuickAddBar(render: () => void): HTMLElement {
  return h('div', { className: 'cal-qa-bar' },
    h('input', {
      className: 'cal-qa-full-input',
      type: 'text',
      placeholder: '+ Add event… "team meeting next Monday at 2pm" or "dentist tomorrow"',
      value: state.calendarQuickAdd as string,
      onInput: (e: Event) => { state.calendarQuickAdd = (e.target as HTMLInputElement).value; },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (state.calendarQuickAdd as string).trim()) {
          void quickAddAgendaItem({ nlText: (state.calendarQuickAdd as string).trim() }).then(() => {
            void loadCalendarItems().then(render);
          });
        }
      },
    }),
    h('button', {
      className: 'cal-qa-submit',
      disabled: state.calendarQuickAddLoading as boolean,
      onClick: () => {
        if ((state.calendarQuickAdd as string).trim()) {
          void quickAddAgendaItem({ nlText: (state.calendarQuickAdd as string).trim() }).then(() => {
            void loadCalendarItems().then(render);
          });
        }
      },
    }, state.calendarQuickAddLoading ? '…' : 'Add')
  );
}

// ── Event chip ────────────────────────────────────────────────────────────────

function renderEventChip(item: AgendaItem, categories: AgendaCategory[], compact = false): HTMLElement {
  const color = itemCategoryColor(item, categories);
  const timeLabel = formatItemTime(item);
  return h('div', {
    className: `cal-chip${compact ? ' compact' : ''}`,
    style: `background:${color}22;border-left:3px solid ${color}`,
    title: `${item.title}${timeLabel ? ` · ${timeLabel}` : ''}`,
  },
    compact
      ? h('span', { className: 'cal-chip-title-sm' }, item.title)
      : h('div', null,
          h('div', { className: 'cal-chip-title' }, item.title),
          timeLabel ? h('div', { className: 'cal-chip-time' }, timeLabel) : null,
        )
  );
}

// ── Agenda view (default) ─────────────────────────────────────────────────────

function renderAgendaView(items: AgendaItem[], categories: AgendaCategory[], render: () => void): HTMLElement {
  const bucketed = bucketItems(items);
  const today = new Date();

  const sections: HTMLElement[] = [];
  for (const bucket of BUCKET_ORDER) {
    const list = bucketed.get(bucket);
    if (!list || list.length === 0) continue;

    const rows = list.map((item) => {
      const color = itemCategoryColor(item, categories);
      const cat = categories.find((c) => c.id === item.category_id);
      return h('div', { className: 'cal-agenda-row' },
        h('div', { className: 'cal-agenda-color', style: `background:${color}` }),
        h('div', { className: 'cal-agenda-content' },
          h('div', { className: 'cal-agenda-title' }, item.title),
          h('div', { className: 'cal-agenda-meta' },
            cat ? h('span', { className: 'cal-cat-chip', style: `background:${color}22;color:${color}` }, `${cat.icon} ${cat.name}`) : null,
            item.location ? h('span', { className: 'cal-agenda-loc' }, `📍 ${item.location}`) : null,
            item.amount ? h('span', { className: 'cal-agenda-amount' }, `${item.currency ?? ''} ${item.amount}`) : null,
          ),
          item.start_at
            ? h('div', { className: 'cal-agenda-time' }, formatItemTime(item) || new Date(item.start_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))
            : null,
        ),
        h('button', {
          className: 'cal-agenda-edit',
          title: 'Edit',
          onClick: () => {
            // TODO: open edit modal
            console.log('edit', item.id);
          },
        }, '✎')
      );
    });

    sections.push(h('div', { className: 'cal-section' },
      h('div', { className: `cal-section-label${bucket === 'Overdue' ? ' overdue' : bucket === 'Today' ? ' today' : ''}` }, bucket),
      ...rows
    ));
  }

  return h('div', { className: 'cal-agenda-view' },
    sections.length > 0 ? h('div', { className: 'cal-sections' }, ...sections) : null,
    sections.length === 0 ? h('div', { className: 'cal-empty-state' },
      h('div', { className: 'cal-empty-icon' }, '📅'),
      h('div', { className: 'cal-empty-msg' }, 'No upcoming items'),
      h('div', { className: 'cal-empty-sub' }, 'Use the quick-add bar above to create your first event')
    ) : null,
  );
}

// ── Week view ─────────────────────────────────────────────────────────────────

function renderWeekView(focus: Date, items: AgendaItem[], categories: AgendaCategory[]): HTMLElement {
  // Start of week (Sunday)
  const weekStart = new Date(focus);
  weekStart.setDate(focus.getDate() - focus.getDay());

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  // All-day items row
  const allDayItems = weekDays.map((d) => itemsForDay(items, d).filter((it) => it.all_day));

  // Timed items per column
  const timedItems = weekDays.map((d) => itemsForDay(items, d).filter((it) => !it.all_day && it.start_at));

  const header = h('div', { className: 'cal-week-header' },
    h('div', { className: 'cal-week-time-gutter' }),
    ...weekDays.map((d, i) =>
      h('div', {
        className: `cal-week-day-hdr${isToday(d) ? ' today' : ''}`,
        onClick: () => { setCalendarFocusDate(d); },
      },
        h('div', { className: 'cal-week-dw' }, WEEK_DAYS[i] ?? ''),
        h('div', { className: `cal-week-dn${isToday(d) ? ' today' : ''}` }, String(d.getDate()))
      )
    )
  );

  const allDayRow = h('div', { className: 'cal-week-allday-row' },
    h('div', { className: 'cal-week-time-gutter' }, 'all day'),
    ...allDayItems.map((dayList) =>
      h('div', { className: 'cal-week-allday-cell' },
        ...dayList.map((it) => renderEventChip(it, categories, true))
      )
    )
  );

  // Hourly grid
  const hourRows = HOURS.slice(6, 22).map((hour) =>
    h('div', { className: 'cal-week-row' },
      h('div', { className: 'cal-week-time-gutter' }, hour === 12 ? '12pm' : hour < 12 ? `${hour}am` : `${hour - 12}pm`),
      ...timedItems.map((dayList) => {
        const inHour = dayList.filter((it) => hourOf(it.start_at) === hour);
        return h('div', { className: 'cal-week-cell' },
          ...inHour.map((it) => renderEventChip(it, categories, true))
        );
      })
    )
  );

  return h('div', { className: 'cal-week-view' },
    header,
    allDayRow,
    h('div', { className: 'cal-week-grid' }, ...hourRows)
  );
}

// ── Month view ────────────────────────────────────────────────────────────────

function renderMonthView(focus: Date, items: AgendaItem[], categories: AgendaCategory[], render: () => void): HTMLElement {
  const year = focus.getFullYear();
  const month = focus.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const todayYMD = toYMD(new Date());
  const focusYMD = toYMD(focus);

  const MAX_VISIBLE = 3;

  // Popover state (which cell is expanded)
  let openPopoverYMD: string | null = null;

  const cells: HTMLElement[] = [];
  // Leading empty cells
  for (let i = 0; i < firstDay.getDay(); i++) cells.push(h('div', { className: 'cal-month-cell empty' }));

  for (let day = 1; day <= lastDay.getDate(); day++) {
    const d = new Date(year, month, day);
    const ymd = toYMD(d);
    const dayItems = itemsForDay(items, d);
    const overflow = dayItems.length - MAX_VISIBLE;

    const chipEls = dayItems.slice(0, MAX_VISIBLE).map((it) => renderEventChip(it, categories, true));

    if (overflow > 0) {
      chipEls.push(h('div', {
        className: 'cal-chip-more',
        onClick: (e: Event) => {
          e.stopPropagation();
          openPopoverYMD = openPopoverYMD === ymd ? null : ymd;
          render();
        },
      }, `+${overflow} more`));
    }

    // Popover for overflow items
    const popover = openPopoverYMD === ymd
      ? h('div', { className: 'cal-chip-popover' },
          h('div', { className: 'cal-popover-title' }, d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })),
          ...dayItems.map((it) => renderEventChip(it, categories, false)),
          h('button', { className: 'cal-popover-close', onClick: () => { openPopoverYMD = null; render(); } }, '✕')
        )
      : null;

    cells.push(h('div', {
      className: `cal-month-cell${ymd === todayYMD ? ' today' : ''}${ymd === focusYMD ? ' focused' : ''}`,
      onClick: () => { setCalendarFocusDate(d); render(); },
    },
      h('div', { className: 'cal-month-dn' }, String(day)),
      ...chipEls,
      popover
    ));
  }

  return h('div', { className: 'cal-month-view' },
    h('div', { className: 'cal-month-header' },
      ...WEEK_DAYS.map((wd) => h('div', { className: 'cal-month-wh' }, wd))
    ),
    h('div', { className: 'cal-month-grid' }, ...cells)
  );
}

// ── Main calendar view ────────────────────────────────────────────────────────

export function renderCalendarView(render: () => void): HTMLElement {
  const focus = getCalendarFocusDate();
  const items: AgendaItem[] = state.calendarItems ?? [];
  const categories: AgendaCategory[] = state.calendarCategories ?? [];
  const calView = state.calendarView as string;

  const navBtn = (label: string, onClick: () => void, active = false) =>
    h('button', { className: `cal-nav-btn${active ? ' active' : ''}`, onClick }, label);

  const viewToggle = h('div', { className: 'cal-view-toggle' },
    navBtn('Agenda', () => { state.calendarView = 'agenda'; render(); }, calView === 'agenda'),
    navBtn('Week', () => { state.calendarView = 'week'; render(); }, calView === 'week'),
    navBtn('Month', () => { state.calendarView = 'month'; render(); }, calView === 'month'),
  );

  const monthNav = h('div', { className: 'cal-month-nav' },
    h('button', { className: 'cal-nav-arrow', onClick: () => { shiftCalendarMonth(-1); void loadCalendarItems().then(render); } }, '‹'),
    h('span', { className: 'cal-month-label' }, focus.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
    h('button', { className: 'cal-nav-arrow', onClick: () => { shiftCalendarMonth(1); void loadCalendarItems().then(render); } }, '›'),
    h('button', { className: 'cal-today-btn', onClick: () => { setCalendarFocusDate(new Date()); void loadCalendarItems().then(render); } }, 'Today'),
  );

  const topBar = h('div', { className: 'cal-top-bar' },
    h('div', { className: 'cal-top-left' },
      h('button', { className: 'cal-back-btn', onClick: () => { state.view = 'chat'; render(); } }, '← Back'),
      monthNav,
    ),
    viewToggle,
  );

  let content: HTMLElement;
  if (calView === 'week') {
    content = renderWeekView(focus, items, categories);
  } else if (calView === 'month') {
    content = renderMonthView(focus, items, categories, render);
  } else {
    content = renderAgendaView(items, categories, render);
  }

  return h('div', { className: 'cal-full-view' },
    topBar,
    renderQuickAddBar(render),
    state.calendarLoading ? h('div', { className: 'cal-loading' }, 'Loading calendar…') : content,
  );
}
