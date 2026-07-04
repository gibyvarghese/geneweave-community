import { h } from './dom.js';
import { canSeeArea } from './workspace-access.js';
import { t } from './i18n.js';
import { iconEl } from './icons.js';
import { loadingPlaceholder } from './skeleton.js';
import {
  state,
  getCalendarFocusDate,
  setCalendarFocusDate,
  shiftCalendarMonth,
  toYMD,
  getTodayLabel,
  type ActionFeedItem,
  type AgendaItem,
} from './state.js';
import { getUserAvatarUrl } from './utils.js';
import { pushAdminHash } from './admin-ui.js';
import { bucketItems, bucketLabel, BUCKET_ORDER, itemCategoryColor, formatItemTime, quickAddAgendaItem } from './agenda-api.js';
import type { Chat } from './types.js';

function renderSidebarIcon(kind: 'home' | 'connectors' | 'admin' | 'dashboard' | 'calendar' | 'notes' | 'design' | 'builder') {
  // Single source of truth for every icon in the app (ui/icons.ts) — the same set the menus use.
  return iconEl(kind, 'side-icon');
}

export function renderWorkspaceNav(options: {
  render: () => void;
  openConnectorsView: () => void;
  loadDashboard: () => Promise<void>;
  loadAdmin: () => Promise<void>;
  clearAdminEditorState: () => void;
  selectChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
}): HTMLElement {
  if (typeof state.sidebarCollapsed !== 'boolean') {
    state.sidebarCollapsed = false;
  }

  const nav = h('aside', {
    className: state.sidebarCollapsed ? 'workspace-nav collapsed' : 'workspace-nav',
    'aria-label': 'Application navigation',
  });
  const navScroll = h('div', { className: 'workspace-nav-scroll', id: 'workspace-nav-scroll' });
  navScroll.addEventListener('scroll', () => {
    // Ignore scroll events fired by the programmatic scroll-restore (they can be clamped/transient during a
    // render burst); only persist real user scrolls.
    if (!state.suppressSidebarScrollPersist) state.sidebarScrollTop = navScroll.scrollTop;
  }, { passive: true });
  const scrollSidebarBy = (delta: number) => {
    navScroll.scrollBy({ top: delta, behavior: 'smooth' });
  };
  nav.appendChild(
    h('div', { className: 'brand' },
      // The logo lockup is a real control that routes HOME from any view (WCAG-friendly + expected UX).
      h('button', {
        type: 'button',
        className: 'brand-home',
        'aria-label': 'geneWeave home',
        title: 'Home',
        onClick: () => { state.view = 'chat'; options.render(); },
      },
        h('span', { className: 'brand-mark', 'aria-hidden': 'true' }, '✦'),
        h('span', { className: 'word' }, 'geneWeave'),
      ),
      h('button', {
        type: 'button',
        className: 'sidebar-collapse-btn',
        title: state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        'aria-label': state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        'aria-expanded': state.sidebarCollapsed ? 'false' : 'true',
        'aria-controls': 'workspace-nav-scroll',
        onClick: (e: Event) => {
          e.stopPropagation();
          state.sidebarCollapsed = !state.sidebarCollapsed;
          if (state.sidebarCollapsed) {
            state.adminMenuExpanded = false;
          }
          options.render();
        },
      }, state.sidebarCollapsed ? '»' : '«')
    )
  );

  if (!state.sidebarCollapsed) {
    nav.appendChild(
      h('div', { className: 'sidebar-scroll-controls' },
        h('button', {
          className: 'sidebar-scroll-btn',
          title: 'Scroll up',
          onClick: () => scrollSidebarBy(-240),
        }, '↑'),
        h('button', {
          className: 'sidebar-scroll-btn',
          title: 'Scroll down',
          onClick: () => scrollSidebarBy(240),
        }, '↓')
      )
    );
  }

  const adminSchema = ((typeof window !== 'undefined' && (window as any).ADMIN_SCHEMA) || {}) as Record<string, any>;
  const adminTabs = Object.keys(adminSchema);
  const adminGroups = (((typeof window !== 'undefined' && (window as any).ADMIN_GROUPS) || []) as any[])
    .map((group: any) => ({
      key: String(group.key || group.label || 'group').toLowerCase().replace(/\s+/g, '-'),
      label: String(group.label || 'Group'),
      icon: String(group.icon || '▸'),
      tabs: Array.isArray(group.tabs)
        ? group.tabs.filter((tab: any) => adminTabs.includes(tab.key))
        : [],
    }))
    .filter((group: any) => group.tabs.length > 0);

  if (typeof state.adminMenuExpanded !== 'boolean') {
    state.adminMenuExpanded = false;
  }
  if (!state.adminGroupExpanded || typeof state.adminGroupExpanded !== 'object') {
    state.adminGroupExpanded = {};
  }

  adminGroups.forEach((group: any, index: number) => {
    if (typeof state.adminGroupExpanded[group.key] !== 'boolean') {
      state.adminGroupExpanded[group.key] = index === 0;
    }
  });

  const navBtn = (view: string, label: string, icon: HTMLElement, action: () => void) => {
    const isActive = state.view === view;
    return h('button', {
      type: 'button',
      className: isActive ? 'active' : '',
      title: label,
      'aria-label': label,
      'aria-current': isActive ? 'page' : null,
      onClick: action,
    }, icon, h('span', { className: 'nav-label' }, label));
  };

  const menu = h('div', { className: 'workspace-menu', role: 'navigation', 'aria-label': 'Main menu' });
  // m145 — labels come from the i18n catalog (t()) so the nav is shown in the reader's language.
  menu.appendChild(navBtn('chat', t('nav.home'), renderSidebarIcon('home'), () => { state.view = 'chat'; options.render(); }));
  menu.appendChild(navBtn('calendar', t('nav.calendar'), renderSidebarIcon('calendar'), () => { state.view = 'calendar'; options.render(); }));
  menu.appendChild(navBtn('notes', t('nav.notes'), renderSidebarIcon('notes'), () => { state.view = 'notes'; options.render(); }));
  // m143 — RBAC surface parity: only show an area if this user is allowed to (server-computed). Chat / Notes /
  // Calendar / Home are always visible; Builder + Admin are admin-only; Design / Dashboard / Connectors are
  // member-visible only when the workspace's role policy allows.
  if (canSeeArea('design')) menu.appendChild(navBtn('design', t('nav.design'), renderSidebarIcon('design'), () => { state.view = 'design'; options.render(); }));
  if (canSeeArea('builder')) menu.appendChild(navBtn('builder', t('nav.builder'), renderSidebarIcon('builder'), () => { state.view = 'builder'; options.render(); }));
  if (canSeeArea('dashboard')) menu.appendChild(navBtn('dashboard', t('nav.dashboard'), renderSidebarIcon('dashboard'), () => { state.view = 'dashboard'; void options.loadDashboard(); }));
  if (canSeeArea('connectors')) menu.appendChild(navBtn('connectors', t('nav.connectors'), renderSidebarIcon('connectors'), () => { options.openConnectorsView(); }));
  menu.appendChild(h('button', {
    type: 'button',
    className: state.view === 'scientific-validation' ? 'active' : '',
    title: 'Scientific Validation',
    'aria-label': 'Scientific Validation',
    'aria-current': state.view === 'scientific-validation' ? 'page' : null,
    onClick: () => { state.view = 'scientific-validation'; options.render(); },
  },
    h('span', { className: 'side-icon', style: 'font-size:15px', 'aria-hidden': 'true' }, '🔬'),
    h('span', { className: 'nav-label' }, t('nav.validation'))
  ));

  const adminNode = h('div', { className: 'admin-nav-tree' });
  const adminActive = state.view === 'admin';
  adminNode.appendChild(h('button', {
    type: 'button',
    className: adminActive ? 'active admin-parent' : 'admin-parent',
    'aria-label': 'Admin',
    'aria-current': adminActive ? 'page' : null,
    'aria-expanded': state.adminMenuExpanded ? 'true' : 'false',
    'aria-haspopup': 'true',
    onClick: () => {
      state.view = 'admin';
      state.adminMenuExpanded = !state.adminMenuExpanded;
      if (state.adminMenuExpanded && !state.adminTab && adminTabs.length) {
        state.adminTab = adminTabs[0];
      }
      options.render();
      void options.loadAdmin();
    },
  }, renderSidebarIcon('admin'), h('span', { className: 'nav-label' }, t('nav.admin')), h('span', { className: `admin-caret${state.adminMenuExpanded ? ' open' : ''}`, 'aria-hidden': 'true' }, '▾')));

  if (state.adminMenuExpanded && !state.sidebarCollapsed) {
    const sub = h('div', { className: 'admin-nav-sub' });
    adminGroups.forEach((group: any) => {
      const groupOpen = !!state.adminGroupExpanded[group.key];
      sub.appendChild(h('button', {
        className: 'admin-group-btn',
        onClick: () => {
          state.adminGroupExpanded[group.key] = !groupOpen;
          options.render();
        },
      }, h('span', { className: 'nav-label' }, group.label), h('span', { className: `admin-caret${groupOpen ? ' open' : ''}` }, '▾')));

      if (groupOpen) {
        const groupList = h('div', { className: 'admin-group-list' });
        group.tabs.forEach((tab: any) => {
          groupList.appendChild(h('button', {
            className: `admin-subtab${state.view === 'admin' && state.adminTab === tab.key ? ' active' : ''}`,
            'data-admin-tab': tab.key,
            'data-focus-key': `admin-tab-${tab.key}`,
            'aria-current': state.view === 'admin' && state.adminTab === tab.key ? 'page' : null,
            onClick: () => {
              state.view = 'admin';
              if (state.adminTab !== tab.key) {
                state.adminTab = tab.key;
                options.clearAdminEditorState();
                state.promptWizard = null;
              }
              pushAdminHash(tab.key);
              options.render();
              void options.loadAdmin();
            },
          }, tab.label));
        });
        sub.appendChild(groupList);
      }
    });

    const orphanTabs = adminTabs.filter((tabKey) => !adminGroups.some((group: any) => group.tabs.some((tab: any) => tab.key === tabKey)));
    if (orphanTabs.length) {
      const groupList = h('div', { className: 'admin-group-list' });
      orphanTabs.forEach((tabKey) => {
        groupList.appendChild(h('button', {
          className: `admin-subtab${state.view === 'admin' && state.adminTab === tabKey ? ' active' : ''}`,
          'data-admin-tab': tabKey,
          'data-focus-key': `admin-tab-${tabKey}`,
          'aria-current': state.view === 'admin' && state.adminTab === tabKey ? 'page' : null,
          onClick: () => {
            state.view = 'admin';
            if (state.adminTab !== tabKey) {
              state.adminTab = tabKey;
              options.clearAdminEditorState();
              state.promptWizard = null;
            }
            pushAdminHash(tabKey);
            options.render();
            void options.loadAdmin();
          },
        }, tabKey.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())));
      });
      sub.appendChild(groupList);
    }

    adminNode.appendChild(sub);
  }
  if (canSeeArea('admin')) menu.appendChild(adminNode); // m143 — Admin tree is admin-only (surface parity)
  navScroll.appendChild(menu);

  if (typeof state.recentChatsExpanded !== 'boolean') {
    state.recentChatsExpanded = true;
  }

  const history = h('div', { className: 'workspace-history' },
    h('button', {
      className: 'workspace-history-toggle',
      onClick: () => {
        state.recentChatsExpanded = !state.recentChatsExpanded;
        options.render();
      },
    },
      h('span', { className: 'workspace-history-label' }, t('nav.recentChats')),
      h('span', { className: `admin-caret${state.recentChatsExpanded ? ' open' : ''}` }, '▾')
    ),
    ...(!state.sidebarCollapsed && state.recentChatsExpanded
      ? (state.chats.length
          ? state.chats.slice(0, 14).map((chat: Chat) =>
              h('div', {
                  className: 'chat-item' + (state.currentChatId === chat.id ? ' active' : ''),
                  // Keyboard-operable + SR-navigable: a role=button div (can't be a real <button> because it
                  // wraps a nested delete <button>), tab-focusable, Enter/Space activates, and aria-current
                  // marks the open chat for assistive tech.
                  role: 'button',
                  tabindex: '0',
                  'data-focus-key': `chat-${chat.id}`,
                  'aria-current': state.currentChatId === chat.id ? 'page' : null,
                  'aria-label': `Open chat: ${chat.title || 'New Chat'}`,
                  onClick: () => {
                    state.view = 'chat';
                    if (state.currentChatId !== chat.id) void options.selectChat(chat.id);
                  },
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      state.view = 'chat';
                      if (state.currentChatId !== chat.id) void options.selectChat(chat.id);
                    }
                  },
                },
                h('div', { className: 'chat-item-copy' },
                  h('div', { className: 'chat-item-title' }, chat.title || 'New Chat'),
                  h('div', { className: 'chat-item-meta' }, new Date(chat.updated_at || chat.created_at || Date.now()).toLocaleString())
                ),
                h('button', {
                  className: 'del',
                  title: 'Delete chat',
                  onClick: (e: Event) => {
                    e.stopPropagation();
                    void options.deleteChat(chat.id);
                  },
                }, '×')
              )
            )
          : [h('div', { className: 'workspace-history-empty' }, 'No saved chats yet')])
      : [])
  );
  navScroll.appendChild(history);
  nav.appendChild(navScroll);
  return nav;
}

export function renderWorkspaceTopCard(options: {
  render: () => void;
  createChat: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  renderProfileDropdown: () => HTMLElement;
}): HTMLElement {
  const userName = (state.user?.name || 'User') as string;
  const userEmail = (state.user?.email || '') as string;
  const openProfile = (e: Event) => {
    e.stopPropagation();
    state.showNotifications = false;
    state.showProfile = !state.showProfile;
    options.render();
  };

  const profileAnchor = h('div', { className: 'dropdown-anchor' });
  const profileBtn = h(
    'button',
    {
      className: 'profile-avatar',
      title: 'Profile and preferences',
      'aria-label': 'Profile and preferences',
      'aria-haspopup': 'true',
      'aria-expanded': state.showProfile ? 'true' : 'false',
      onClick: openProfile,
    },
    h('img', {
      src: getUserAvatarUrl(),
      alt: userName,
      style: 'width:100%;height:100%;border-radius:50%;object-fit:cover;',
    })
  );
  profileAnchor.appendChild(profileBtn);

  if (state.showProfile) {
    const dd = options.renderProfileDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(() => {
      const r = profileBtn.getBoundingClientRect();
      (dd as HTMLElement).style.top = `${r.bottom + 8}px`;
      (dd as HTMLElement).style.right = `${window.innerWidth - r.right}px`;
    });
  }

  return h(
    'div',
    { className: 'workspace-top-card' },
    h(
      'div',
      { className: 'user-chip' },
      h('img', { src: getUserAvatarUrl(), alt: userName }),
      h(
        'div',
        null,
        h('div', { className: 'name' }, userName),
        h('div', { className: 'role' }, userEmail || 'Signed in')
      )
    ),
    h('div', { className: 'today-badge' }, '◷ ', getTodayLabel()),
    h('div', { className: 'semantic-search' },
      h('input', {
        type: 'text',
        value: state.chatSearchQuery || '',
        placeholder: t('chat.searchPlaceholder'),
        onInput: (e: Event) => {
          state.chatSearchQuery = (e.target as HTMLInputElement).value || '';
          options.render();
        },
      }),
      state.chatSearchQuery
        ? h(
            'div',
            { className: 'search-dd' },
            ...state.chats
              .filter((chat: Chat) =>
                (chat.title || '').toLowerCase().includes(String(state.chatSearchQuery).toLowerCase())
              )
              .slice(0, 8)
              .map((chat: Chat) =>
                h(
                  'div',
                  {
                    className: 'search-item',
                    // H11 — keyboard-operable + SR-navigable (was a bare div onClick).
                    role: 'button',
                    tabindex: '0',
                    'aria-label': `Open chat: ${chat.title || 'New Chat'}`,
                    onClick: () => {
                      state.chatSearchQuery = '';
                      void options.selectChat(chat.id);
                    },
                    onKeyDown: (e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        state.chatSearchQuery = '';
                        void options.selectChat(chat.id);
                      }
                    },
                  },
                  h('div', { className: 'ttl' }, chat.title || 'New Chat'),
                  h(
                    'div',
                    { className: 'sub' },
                    new Date(chat.updated_at || chat.created_at || Date.now()).toLocaleString()
                  )
                )
              )
          )
        : null
    ),
    h('div', { className: 'top-actions' },
      h('button', {
        className: 'nav-btn',
        title: 'Developer Documentation',
        onClick: () => { window.open('/docs', '_blank', 'noopener'); },
      }, `? ${t('action.docs')}`),
      h('button', { className: 'nav-btn', onClick: () => { void options.createChat(); } }, `+ ${t('action.newChat')}`),
      profileAnchor
    )
  );
}

export function renderCalendarWidget(render: () => void): HTMLElement {
  const focus = getCalendarFocusDate();
  const year = focus.getFullYear();
  const month = focus.getMonth();
  const selectedYMD = toYMD(focus);

  // Dot counts per calendar day from real agenda items
  const items: AgendaItem[] = state.calendarItems ?? [];
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (item.start_at) {
      const ymd = item.start_at.slice(0, 10);
      counts[ymd] = (counts[ymd] ?? 0) + 1;
    }
  }

  const focusDays: Date[] = [];
  for (let i = -1; i <= 3; i++) focusDays.push(new Date(year, month, focus.getDate() + i));

  const monthFirst = new Date(year, month, 1);
  const monthLast = new Date(year, month + 1, 0);
  const monthCells: HTMLElement[] = [];
  for (let i = 0; i < monthFirst.getDay(); i++) monthCells.push(h('div', { className: 'md empty' }, ''));
  for (let day = 1; day <= monthLast.getDate(); day++) {
    const d = new Date(year, month, day);
    const dYMD = toYMD(d);
    monthCells.push(h('div', {
      className: `md${counts[dYMD] ? ' has' : ''}${dYMD === selectedYMD ? ' active' : ''}`,
      // H11 + FP-D — keyboard-operable + the selected day marked for assistive tech.
      role: 'button',
      tabindex: '0',
      'aria-label': d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + (counts[dYMD] ? `, ${counts[dYMD]} item${counts[dYMD] === 1 ? '' : 's'}` : ''),
      'aria-current': dYMD === selectedYMD ? 'date' : null,
      onClick: () => { setCalendarFocusDate(d); render(); },
      onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCalendarFocusDate(d); render(); } },
    }, String(day)));
  }

  // Bucket view: items for the selected day and nearby (agenda-first)
  const focusYMD = toYMD(focus);
  const dayItems = items.filter((it) => it.start_at?.slice(0, 10) === focusYMD);
  const upcomingItems = items.filter((it) => {
    const ymd = it.start_at?.slice(0, 10);
    return ymd && ymd > focusYMD;
  }).slice(0, 5);
  const allDayItems = [...dayItems, ...upcomingItems];
  const bucketed = bucketItems(allDayItems.length > 0 ? allDayItems : items.slice(0, 20));

  const categories: import('./state.js').AgendaCategory[] = state.calendarCategories ?? [];

  const renderItemChip = (item: AgendaItem) => {
    const color = itemCategoryColor(item, categories);
    const timeLabel = formatItemTime(item);
    return h('div', { className: 'cal-item-chip', style: `border-left:3px solid ${color}` },
      h('div', { className: 'cal-item-title' }, item.title),
      timeLabel ? h('div', { className: 'cal-item-time' }, timeLabel) : null,
    );
  };

  const bucketSections: HTMLElement[] = [];
  for (const bucket of BUCKET_ORDER) {
    const list = bucketed.get(bucket);
    if (!list || list.length === 0) continue;
    bucketSections.push(
      h('div', { className: 'cal-bucket' },
        h('div', { className: 'cal-bucket-label' }, bucket),
        ...list.map(renderItemChip)
      )
    );
  }

  // Quick-add input (WC4)
  const quickAdd = h('div', { className: 'cal-quick-add' },
    h('input', {
      className: 'cal-qa-input',
      type: 'text',
      placeholder: 'Quick add… "dentist tomorrow at 3pm"',
      value: state.calendarQuickAdd as string,
      onInput: (e: Event) => { state.calendarQuickAdd = (e.target as HTMLInputElement).value; },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (state.calendarQuickAdd as string).trim()) {
          void quickAddAgendaItem({ nlText: (state.calendarQuickAdd as string).trim() }).then(() => render());
        }
      },
    }),
    h('button', {
      className: 'cal-qa-btn',
      disabled: state.calendarQuickAddLoading as boolean,
      onClick: () => {
        if ((state.calendarQuickAdd as string).trim()) {
          void quickAddAgendaItem({ nlText: (state.calendarQuickAdd as string).trim() }).then(() => render());
        }
      },
    }, state.calendarQuickAddLoading ? '…' : '+')
  );

  return h('div', { className: 'side-card schedule-card' },
    h('div', { className: 'schedule-head' },
      h('div', { className: 'ttl' }, '◷ Schedule'),
      h('div', { className: 'month-nav' },
        h('button', { className: 'icon-btn-sm', title: 'Previous month', onClick: () => { shiftCalendarMonth(-1); render(); } }, '‹'),
        h('div', { className: 'month-pill' }, focus.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })),
        h('button', { className: 'icon-btn-sm', title: 'Next month', onClick: () => { shiftCalendarMonth(1); render(); } }, '›')
      ),
      h('button', {
        className: 'see-all',
        title: 'Open full calendar',
        onClick: () => { state.view = 'calendar'; render(); },
      }, 'Full view')
    ),
    !state.calendarShowAll
      ? h('div', { className: 'day-strip' },
          ...focusDays.map((d) =>
            h('div', {
              className: `day-chip${toYMD(d) === selectedYMD ? ' active' : ''}`,
              title: `${counts[toYMD(d)] ?? 0} items`,
              // H11 + FP-D — keyboard-operable day chip with the selected day marked.
              role: 'button',
              tabindex: '0',
              'aria-label': d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + `, ${counts[toYMD(d)] ?? 0} items`,
              'aria-current': toYMD(d) === selectedYMD ? 'date' : null,
              onClick: () => { setCalendarFocusDate(d); render(); },
              onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCalendarFocusDate(d); render(); } },
            },
            h('div', { className: 'dw' }, d.toLocaleDateString(undefined, { weekday: 'short' })),
            h('div', { className: 'dn' }, String(d.getDate()).padStart(2, '0'))
            )
          )
        )
      : h('div', { className: 'month-grid' },
          ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('div', { className: 'mh' }, x)),
          ...monthCells
        ),
    quickAdd,
    h('div', { className: 'cal-bucket-list' },
      ...bucketSections,
      bucketSections.length === 0
        ? h('div', { className: 'cal-empty' }, state.calendarLoading ? 'Loading…' : 'No upcoming items')
        : null
    ),
    h('div', { className: 'schedule-view-toggle' },
      h('button', { className: 'see-all', onClick: () => { state.calendarShowAll = !state.calendarShowAll; render(); } },
        state.calendarShowAll ? 'Hide month' : 'Month view')
    )
  );
}

const ACTION_BADGE_COLORS: Record<ActionFeedItem['type'], { bg: string; fg: string; label: string }> = {
  approval: { bg: '#3B82F6', fg: '#fff', label: 'Approve' },
  task:     { bg: '#8B5CF6', fg: '#fff', label: 'Task' },
  reminder: { bg: '#F59E0B', fg: '#fff', label: 'Remind' },
  agenda:   { bg: '#10B981', fg: '#fff', label: 'Agenda' },
};

const URGENCY_BORDER: Record<ActionFeedItem['urgency'], string> = {
  overdue:  '#EF4444',
  'due-soon': '#F59E0B',
  proposed: '#3B82F6',
  normal:   'transparent',
};

export function renderActionsWidget(selectChat: (chatId: string) => Promise<void>, render: () => void): HTMLElement {
  const feed = state.actionFeed as ActionFeedItem[];
  const filter = state.actionFeedFilter as string;

  const filtered = filter === 'all'
    ? feed
    : feed.filter((a) => a.type === filter);

  const filterBtn = (label: string, key: string) =>
    h('button', {
      className: `af-filter${filter === key ? ' active' : ''}`,
      onClick: () => { state.actionFeedFilter = key; render(); },
    }, label);

  const header = h('div', { className: 'af-header' },
    h('div', { className: 'af-title-row' },
      h('span', { className: 'af-title' }, 'My Actions'),
      state.actionFeedLoading
        ? h('span', { className: 'af-loading' }, '…')
        : h('span', { className: 'af-count' }, String(feed.length) + (feed.length === 1 ? ' item' : ' items'))
    ),
    h('div', { className: 'af-filters' },
      filterBtn('All', 'all'),
      filterBtn('Approvals', 'approval'),
      filterBtn('Tasks', 'task'),
      filterBtn('Reminders', 'reminder'),
    )
  );

  const list = h('div', { className: 'action-list' },
    ...filtered.slice(0, 10).map((item: ActionFeedItem) => {
      const badge = ACTION_BADGE_COLORS[item.type];
      const borderColor = URGENCY_BORDER[item.urgency];
      const isActive = state.currentChatId === item.conversationId;

      return h('div', {
        className: `action-item selectable${isActive ? ' active' : ''}`,
        style: `border-left:3px solid ${borderColor}`,
        onClick: () => {
          if (item.type === 'approval' && item.conversationId) {
            void selectChat(item.conversationId);
          }
        },
      },
        h('div', { className: 'af-row' },
          h('span', {
            className: 'af-badge',
            style: `background:${badge.bg};color:${badge.fg}`,
          }, badge.label),
          h('div', { className: 'af-body' },
            h('div', { className: 'at' }, item.title),
            h('div', { className: 'as' }, item.sub),
          )
        )
      );
    }),
    filtered.length === 0
      ? h('div', { className: 'action-item' }, h('div', { className: 'as' }, state.actionFeedLoading ? 'Loading…' : 'No actions'))
      : null,
    filtered.length > 10
      ? h('div', { className: 'af-more', role: 'button', tabindex: '0', 'aria-label': `Show all ${filtered.length} actions`,
          onClick: () => { state.view = 'actions'; render(); },
          onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.view = 'actions'; render(); } },
        }, `+${filtered.length - 10} more`)
      : null,
  );

  return h('div', { className: 'side-card actions-card' }, header, list);
}

export function renderProfileDropdown(options: {
  render: () => void;
  doLogout: () => Promise<void>;
  loadDashboard: () => Promise<void>;
  loadAdmin: () => Promise<void>;
}): HTMLElement {
  const user = state.user || {};
  const avatar = h('img', {
    src: getUserAvatarUrl(),
    alt: user.name || 'User',
    style: 'width:48px;height:48px;border-radius:50%;object-fit:cover;margin-bottom:10px;',
  });

  return h('div', { className: 'dropdown profile-dd', onClick: (e: Event) => e.stopPropagation() },
    avatar,
    h('div', { className: 'pf-name' }, user.name || 'User'),
    h('div', { className: 'pf-email' }, user.email || ''),
    h('div', { className: 'pf-divider' }),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'account'; state.accountSection = 'profile'; state.showProfile = false; options.render(); } }, '👤 Profile & account'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'account'; state.accountSection = 'prefs'; state.showProfile = false; options.render(); } }, '⚙ Preferences'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'dashboard'; state.showProfile = false; options.render(); void options.loadDashboard(); } }, '📊 Dashboard'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'admin'; state.adminMenuExpanded = true; state.showProfile = false; options.render(); void options.loadAdmin(); } }, '⚙ Admin'),
    h('div', { className: 'pf-divider' }),
    h('button', { className: 'pf-btn danger', onClick: async () => { state.showProfile = false; await options.doLogout(); options.render(); } }, '🚪 Sign Out')
  );
}

export function renderDashboardView(options: {
  render: () => void;
  loadAdmin: () => Promise<void>;
  formatCompactNumber: (value: number) => string;
  formatCurrencyCompact: (value: number, digits?: number) => string;
  formatMaybeCompactValue: (value: any) => string;
}): HTMLElement {
  const dashboard = state.dashboard;
  const view = h('div', { className: 'dash-view' }, h('h2', null, 'Dashboard'));
  if (!dashboard || !dashboard.overview) {
    view.appendChild(loadingPlaceholder('cards', 'Loading dashboard…')); // m144 — skeleton instead of a blank flash
    return view;
  }

  const summary = dashboard.overview.summary || {};
  const executionCount = Array.isArray(dashboard.agentActivity) ? dashboard.agentActivity.length : 0;
  const traceCount = Array.isArray(dashboard.traces) ? dashboard.traces.length : 0;
  const evalRunCount = Array.isArray(dashboard.evals?.evals) ? dashboard.evals.evals.length : 0;
  view.appendChild(
    h('div', { className: 'cards' },
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Executions'), h('div', { className: 'value' }, options.formatCompactNumber(executionCount))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Total Tokens'), h('div', { className: 'value tokens' }, options.formatCompactNumber(Number(summary.total_tokens || 0)))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Total Cost'), h('div', { className: 'value cost' }, options.formatCurrencyCompact(Number(summary.total_cost || 0), 4))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Avg Latency'), h('div', { className: 'value latency' }, options.formatMaybeCompactValue(summary.avg_latency_ms || 0) + 'ms')),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Messages'), h('div', { className: 'value' }, options.formatCompactNumber(Number(summary.total_messages || 0)))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Chats'), h('div', { className: 'value' }, options.formatCompactNumber(Number(summary.total_chats || 0)))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Eval Runs'), h('div', { className: 'value' }, options.formatCompactNumber(evalRunCount))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Traces'), h('div', { className: 'value' }, options.formatCompactNumber(traceCount)))
    )
  );

  view.appendChild(
    h('div', { className: 'table-wrap', style: 'margin-top:12px;' },
      h('div', { style: 'padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;' },
        h('div', { style: 'font-size:12px;color:var(--fg2);' }, 'For traces, flow details, and evaluation diagnostics use Monitoring in Admin.'),
        h('button', {
          className: 'nav-btn',
          onClick: () => {
            state.view = 'admin';
            state.adminMenuExpanded = true;
            state.adminGroupExpanded['monitoring'] = true;
            state.adminTab = 'workflow-runs';
            options.render();
            void options.loadAdmin();
          },
        }, 'Open Monitoring')
      )
    )
  );

  return view;
}