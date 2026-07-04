// Account settings surface — recreated from "GeneWeave Account.dc.html".
//
// A full-bleed settings app: a 256px nav on the left (ACCOUNT + WORKSPACE groups), a centred content
// column, and a sticky Save bar. Everything under ACCOUNT is per-USER and DB-backed via /api/me/account
// (profile, formatting preferences, and the notifications matrix — see account-sql.ts). The WORKSPACE
// group shows real members (People) and deep-links into the Builder for the admin-only controls (Admin &
// governance, Plan & billing), so RBAC + persistence stay in one place rather than being reinvented here.
//
// The assistant can make the same profile/notification changes through the update_account_profile tool —
// this screen and that tool share the one validated service, so they never drift.
import { h } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { noticeDialog } from './dialog.js';
import { loadI18n, availableLocales } from './i18n.js';

// Inline line-icons (from "GeneWeave Account.dc.html"). Returns a <span> carrying the SVG so it inherits
// currentColor from its parent — no external icon dependency.
const ICONS: Record<string, string> = {
  user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  sliders: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h13M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  bell: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  users: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5"/><path d="M16 5.5a3.5 3.5 0 0 1 0 6.5M17.5 15c2.2.4 3.5 1.9 3.5 4.5"/></svg>',
  shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
  card: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>',
  key: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l7-7 3 3M15 8l2 2"/></svg>',
  laptop: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 20h20"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>',
};
function ic(name: string): HTMLElement {
  return h('span', { className: 'acct-ic', innerHTML: ICONS[name] ?? '' });
}

// ── data loading ────────────────────────────────────────────────────────────────────────────────────
async function loadAccount(render: () => void): Promise<void> {
  if (state.accountLoading) return;
  state.accountLoading = true;
  state.accountError = false;
  try {
    const [acc, ppl] = await Promise.all([
      api.get('/me/account').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      api.get('/me/account/people').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (acc?.account) {
      state.account = acc.account;
      state.accountDraft = JSON.parse(JSON.stringify({ profile: acc.account.profile, preferences: acc.account.preferences }));
      state.accountLoaded = true;
    } else {
      // Load failed (e.g. not authenticated / server error) — surface a friendly retry, never a blank app.
      state.accountError = true;
    }
    if (ppl) state.accountPeople = ppl;
  } finally {
    state.accountLoading = false;
    render();
  }
}

function isDirty(): boolean {
  if (!state.account || !state.accountDraft) return false;
  const live = JSON.stringify({ profile: state.account.profile, preferences: state.account.preferences });
  const draft = JSON.stringify(state.accountDraft);
  return live !== draft;
}

async function saveAccount(render: () => void): Promise<void> {
  if (!state.accountDraft || state.accountSaving) return;
  state.accountSaving = true; render();
  try {
    const p = state.accountDraft.profile, pr = state.accountDraft.preferences;
    const body: Record<string, unknown> = {
      display_name: p.display_name, pronouns: p.pronouns, role_title: p.role_title,
      working_hours: p.working_hours, about: p.about, status_text: p.status_text, status_emoji: p.status_emoji,
      language: pr.language, timezone: pr.timezone, date_format: pr.date_format, week_start: pr.week_start, ui_variant: pr.ui_variant,
    };
    const r = await api.put('/me/account/profile', body).then((x) => x.json()).catch(() => null);
    if (r?.account) {
      state.account = r.account;
      state.accountDraft = JSON.parse(JSON.stringify({ profile: r.account.profile, preferences: r.account.preferences }));
    }
  } finally {
    state.accountSaving = false; render();
  }
}

// ── small builders ──────────────────────────────────────────────────────────────────────────────────
const initials = (name: string): string => {
  if (!name || name.includes('@')) return '?';
  return name.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
};

function pill(text: string, kind: 'ok' | 'warn' | 'muted' = 'ok'): HTMLElement {
  return h('span', { className: `acct-pill ${kind}` }, text);
}

function field(label: string, value: string, onInput: (v: string) => void, opts: { full?: boolean; textarea?: boolean } = {}): HTMLElement {
  const control = opts.textarea
    ? h('textarea', { className: 'acct-textarea', rows: '3', onInput: function (this: HTMLTextAreaElement) { onInput(this.value); } }, value)
    : h('input', { className: 'acct-input', value, onInput: function (this: HTMLInputElement) { onInput(this.value); } });
  return h('div', { className: 'acct-field' + (opts.full ? ' full' : '') },
    h('label', { className: 'acct-label' }, label), control);
}

/** A labelled dropdown row inside a card (Preferences). */
function selectRow(label: string, desc: string, value: string, options: Array<[string, string]>, onChange: (v: string) => void): HTMLElement {
  const sel = h('select', { className: 'acct-select', onChange: function (this: HTMLSelectElement) { onChange(this.value); } },
    ...options.map(([v, l]) => h('option', { value: v, ...(v === value ? { selected: 'selected' } : {}) }, l))) as HTMLSelectElement;
  return h('div', { className: 'acct-row' },
    h('div', { style: 'flex:1;' },
      h('div', { className: 'acct-row-title' }, label),
      h('div', { className: 'acct-row-sub' }, desc)),
    sel);
}

/** The mini pill toggle used in the notifications matrix. */
function miniToggle(on: boolean, onToggle: () => void): HTMLElement {
  return h('button', { className: 'acct-toggle' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), onClick: onToggle },
    h('span', { className: 'acct-toggle-knob' }));
}

// ── sections ────────────────────────────────────────────────────────────────────────────────────────
const SECTIONS: Record<string, { group: string; label: string; ic: string; eyebrow: string; title: string; desc: string; badge?: string }> = {
  profile:  { group: 'ACCOUNT', label: 'Profile', ic: 'user', eyebrow: 'ACCOUNT', title: 'Profile', desc: 'How you appear across geneWeave to your team and the assistant.' },
  security: { group: 'ACCOUNT', label: 'Account & security', ic: 'lock', eyebrow: 'ACCOUNT', title: 'Account & security', desc: 'Your sign-in, two-factor, and the devices with access.' },
  prefs:    { group: 'ACCOUNT', label: 'Preferences', ic: 'sliders', eyebrow: 'ACCOUNT', title: 'Preferences', desc: 'Theme, language, and formatting defaults for your account.' },
  notifs:   { group: 'ACCOUNT', label: 'Notifications', ic: 'bell', eyebrow: 'ACCOUNT', title: 'Notifications', desc: 'Choose what reaches you, and where.' },
  members:  { group: 'WORKSPACE', label: 'People', ic: 'users', eyebrow: 'WORKSPACE', title: 'People', desc: 'Everyone in your workspace and the access they hold.' },
  admin:    { group: 'WORKSPACE', label: 'Admin & governance', ic: 'shield', eyebrow: 'WORKSPACE', title: 'Admin & governance', desc: 'Sign-in, compliance, and the rules the assistant works within.' },
  billing:  { group: 'WORKSPACE', label: 'Plan & billing', ic: 'card', eyebrow: 'WORKSPACE', title: 'Plan & billing', desc: 'Your subscription, seats, usage, and invoices.' },
};

function renderProfile(render: () => void): HTMLElement {
  const p = state.accountDraft.profile;
  const set = (k: string, v: string) => { p[k] = v; queueSaveBar(render); };
  const name = p.display_name || state.user?.name || 'You';
  const band = h('div', { className: 'acct-card acct-profile-band' },
    h('div', { className: 'acct-avatar-lg' }, initials(name)),
    h('div', { style: 'flex:1;' },
      h('div', { style: 'display:flex;align-items:center;gap:10px;' },
        h('span', { className: 'acct-profile-name' }, name),
        pill(state.account.profile.persona === 'tenant_admin' || state.account.profile.persona === 'platform_admin' ? 'Admin' : 'Member', 'ok')),
      h('div', { className: 'acct-profile-role' }, [p.role_title, state.user?.email].filter(Boolean).join(' · ') || 'Set your role below'),
      h('div', { className: 'acct-profile-status' },
        h('span', { className: 'acct-status-dot' }),
        h('span', {}, p.status_text ? `${p.status_emoji || ''} ${p.status_text}`.trim() : 'No status set'))));

  const grid = h('div', { className: 'acct-grid2' },
    field('Display name', p.display_name || '', (v) => set('display_name', v)),
    field('Pronouns', p.pronouns || '', (v) => set('pronouns', v)),
    field('Role / title', p.role_title || '', (v) => set('role_title', v)),
    field('Working hours', p.working_hours || '', (v) => set('working_hours', v)),
    field('Status', p.status_text || '', (v) => set('status_text', v)),
    field('Status emoji', p.status_emoji || '', (v) => set('status_emoji', v)),
    field('About', p.about || '', (v) => set('about', v), { full: true, textarea: true }));

  return h('div', { style: 'display:flex;flex-direction:column;gap:22px;' }, band, grid);
}

function renderSecurity(): HTMLElement {
  const prof = state.account.profile;
  const rows = h('div', { className: 'acct-card acct-rowlist' },
    h('div', { className: 'acct-row' },
      h('div', { style: 'flex:1;' }, h('div', { className: 'acct-row-title' }, 'Email'), h('div', { className: 'acct-row-sub' }, prof.email)),
      prof.email_verified ? pill('Verified', 'ok') : pill('Unverified', 'warn'),
      h('button', { className: 'acct-btn-ghost' }, 'Change')),
    h('div', { className: 'acct-row' },
      h('div', { style: 'flex:1;' }, h('div', { className: 'acct-row-title' }, 'Password'), h('div', { className: 'acct-row-sub' }, 'Sign-in password')),
      h('button', { className: 'acct-btn-ghost' }, 'Update')),
    h('div', { className: 'acct-row last' },
      h('div', { style: 'flex:1;' }, h('div', { className: 'acct-row-title' }, 'Two-factor authentication'), h('div', { className: 'acct-row-sub' }, prof.mfa_enabled ? 'Authenticator app' : 'Not enrolled')),
      prof.mfa_enabled ? pill('On', 'ok') : pill('Off', 'muted'),
      h('button', { className: 'acct-btn-ghost' }, 'Manage')));

  const ua = navigator.userAgent || '';
  const dev = ua.includes('Mobile') ? 'Mobile browser' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : 'Browser';
  const sessions = h('div', {},
    h('div', { className: 'acct-subhead' }, 'ACTIVE SESSIONS'),
    h('div', { className: 'acct-card acct-rowlist' },
      h('div', { className: 'acct-row last' },
        h('span', { className: 'acct-sess-ic' }, ic('laptop') ?? '💻'),
        h('div', { style: 'flex:1;' }, h('div', { className: 'acct-row-title' }, `This device · ${dev}`), h('div', { className: 'acct-row-sub' }, 'Signed in now')),
        pill('Active now', 'ok'))),
    h('button', { className: 'acct-btn-danger-ghost', style: 'align-self:flex-start;margin-top:11px;' }, 'Sign out all other sessions'));

  return h('div', { style: 'display:flex;flex-direction:column;gap:16px;' }, rows, sessions);
}

function renderPrefs(render: () => void): HTMLElement {
  const pr = state.accountDraft.preferences;
  const set = (k: string, v: string) => { pr[k] = v; queueSaveBar(render); };
  const themeCard = (variant: 'pro' | 'creative', title: string, sub: string, swatch: HTMLElement) => {
    const active = pr.ui_variant === variant;
    return h('div', { className: 'acct-theme-card' + (active ? ' active' : ''), onClick: () => { set('ui_variant', variant); render(); } },
      swatch,
      h('div', { style: 'display:flex;align-items:center;gap:8px;' },
        h('span', { className: 'acct-theme-radio' + (active ? ' on' : '') }),
        h('span', { style: 'font-size:13px;font-weight:600;' }, title),
        h('span', { style: 'font-size:12px;color:var(--fg3);' }, sub)));
  };
  const themeBlock = h('div', {},
    h('div', { className: 'acct-label', style: 'margin-bottom:10px;' }, 'Default editor look'),
    h('div', { className: 'acct-theme-grid' },
      themeCard('pro', 'Pro', 'Clean & focused', h('div', { className: 'acct-theme-swatch pro' }, h('span', { className: 'acct-theme-bar dark' }))),
      themeCard('creative', 'Creative', 'Warm & playful', h('div', { className: 'acct-theme-swatch creative' }, h('span', { className: 'acct-theme-bar gold' })))));

  // m145 — the language list = the built-in choices PLUS any language an admin added with AI (from the i18n
  // catalog), and picking one re-labels the whole app LIVE (loadI18n → render) before you even hit Save.
  const baseLangs: [string, string][] = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['hi', 'हिन्दी'], ['ja', '日本語'], ['zh', '中文']];
  const haveCodes = new Set(baseLangs.map(([c]) => c.split('-')[0]));
  for (const loc of availableLocales().locales) { if (!haveCodes.has(loc.code)) { baseLangs.push([loc.code, loc.name]); haveCodes.add(loc.code); } }
  const rows = h('div', { className: 'acct-card acct-rowlist' },
    selectRow('Language', 'Interface language', pr.language, baseLangs, (v) => { set('language', v); void loadI18n(v).then(() => render()); }),
    selectRow('Date format', 'How dates are shown', pr.date_format, [['D MMM YYYY', '12 Jan 2027'], ['MMM D, YYYY', 'Jan 12, 2027'], ['YYYY-MM-DD', '2027-01-12'], ['DD/MM/YYYY', '12/01/2027'], ['MM/DD/YYYY', '01/12/2027']], (v) => { set('date_format', v); render(); }),
    selectRow('Start of week', 'First day in calendars', pr.week_start, [['monday', 'Monday'], ['sunday', 'Sunday'], ['saturday', 'Saturday']], (v) => { set('week_start', v); render(); }));
  // Timezone free-text (very long enum otherwise).
  const tz = h('div', { className: 'acct-row last', style: 'border-top:1px solid var(--bg3);' },
    h('div', { style: 'flex:1;' }, h('div', { className: 'acct-row-title' }, 'Timezone'), h('div', { className: 'acct-row-sub' }, 'Used for reminders and activity')),
    h('input', { className: 'acct-input', style: 'max-width:220px;', value: pr.timezone || '', placeholder: 'e.g. GMT+5:30', onInput: function (this: HTMLInputElement) { set('timezone', this.value); } }));
  rows.appendChild(tz);

  return h('div', { style: 'display:flex;flex-direction:column;gap:22px;' }, themeBlock, rows);
}

function renderNotifs(render: () => void): HTMLElement {
  const table = h('div', { className: 'acct-card acct-notif' });
  table.appendChild(h('div', { className: 'acct-notif-head' },
    h('span', {}, 'EVENT'), h('span', { style: 'text-align:center;' }, 'IN-APP'),
    h('span', { style: 'text-align:center;' }, 'EMAIL'), h('span', { style: 'text-align:center;' }, 'PUSH')));
  const list: any[] = state.account.notifications || [];
  const setChan = async (ev: string, chan: 'in_app' | 'email' | 'push', next: boolean) => {
    const row = list.find((r) => r.event_key === ev); if (row) row[chan] = next;
    render();
    const r = await api.put('/me/account/notifications', { event: ev, [chan]: next }).then((x) => x.json()).catch(() => null);
    if (r?.account) { state.account.notifications = r.account.notifications; }
  };
  list.forEach((n, i) => {
    table.appendChild(h('div', { className: 'acct-notif-row' + (i === list.length - 1 ? ' last' : '') },
      h('div', { style: 'min-width:0;' }, h('div', { className: 'acct-row-title' }, n.label), h('div', { className: 'acct-row-sub' }, n.desc)),
      h('div', { style: 'display:flex;justify-content:center;' }, miniToggle(n.in_app, () => setChan(n.event_key, 'in_app', !n.in_app))),
      h('div', { style: 'display:flex;justify-content:center;' }, miniToggle(n.email, () => setChan(n.event_key, 'email', !n.email))),
      h('div', { style: 'display:flex;justify-content:center;' }, miniToggle(n.push, () => setChan(n.event_key, 'push', !n.push)))));
  });
  return table;
}

function renderMembers(render: () => void): HTMLElement {
  const data = state.accountPeople || { people: [], canManage: false };
  const gotoBuilder = () => { state.view = 'builder'; state.adminTab = 'users'; render(); };
  const head = h('div', { style: 'display:flex;gap:10px;' },
    h('div', { className: 'acct-search' }, h('span', { className: 'acct-search-ic' }, ic('search') ?? '⌕'), h('span', {}, `${data.people.length} people`)),
    data.canManage ? h('button', { className: 'acct-btn-emerald', onClick: gotoBuilder }, h('span', { style: 'font-size:15px;' }, '+'), ' Invite people') : h('span', {}));
  const rows = h('div', { className: 'acct-card acct-rowlist' });
  (data.people as any[]).forEach((m, i) => {
    const nm = m.name || m.email;
    // m143 — an admin can change another member's role inline (self + platform admins stay read-only).
    const editable = data.canManage && !m.is_you && m.persona !== 'platform_admin';
    const roleEl = editable
      ? (() => {
          const sel = h('select', { className: 'acct-role-select', 'aria-label': `Role for ${nm}`,
            onChange: async (e: Event) => {
              const persona = (e.target as HTMLSelectElement).value;
              const res = await api.post(`/api/me/account/people/${encodeURIComponent(m.id)}/role`, { persona });
              if (res && (res as Response).ok) { m.persona = persona; render(); }
              else { const b = await (res as Response)?.json?.().catch(() => ({})) as { error?: string }; void noticeDialog({ title: 'Couldn’t change role', message: b?.error || 'Please try again.' }); render(); }
            },
          }) as HTMLSelectElement;
          for (const [val, label] of [['tenant_admin', 'Admin'], ['tenant_user', 'Member']] as const) {
            const opt = h('option', { value: val }, label) as HTMLOptionElement;
            if ((m.persona === 'tenant_admin' && val === 'tenant_admin') || (m.persona !== 'tenant_admin' && val === 'tenant_user')) opt.selected = true;
            sel.appendChild(opt);
          }
          return sel;
        })()
      : h('span', { className: 'acct-role-chip' }, roleLabel(m.persona));
    rows.appendChild(h('div', { className: 'acct-row' + (i === data.people.length - 1 ? ' last' : '') },
      h('span', { className: 'acct-member-av' }, initials(nm)),
      h('div', { style: 'flex:1;min-width:0;' }, h('div', { className: 'acct-row-title' }, nm), h('div', { className: 'acct-row-sub' }, m.email || '')),
      m.is_you ? pill('You', 'muted') : pill('Active', 'ok'),
      roleEl));
  });
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px;' }, head, rows);
}

function roleLabel(persona: string): string {
  return persona === 'tenant_admin' || persona === 'platform_admin' ? 'Admin' : persona === 'analyst' ? 'Editor' : persona === 'viewer' ? 'Viewer' : 'Member';
}

function renderAdmin(render: () => void): HTMLElement {
  const gotoBuilder = (tab: string) => { state.view = 'builder'; state.adminTab = tab; render(); };
  const cards: Array<[string, string, string, string, string]> = [
    ['Single sign-on', 'key', 'Configure SAML/OIDC SSO and SCIM provisioning for your workspace.', 'Open in Builder', 'users'],
    ['AI governance', 'shield', 'Which models the assistant may use, data boundaries, and guardrails on its output.', 'Open in Builder', 'guardrails'],
    ['Data & retention', 'lock', 'Retention windows, data residency, legal hold, and eDiscovery export.', 'Open in Builder', 'tenant-governance'],
    ['Appearance & branding', 'sliders', 'Your workspace colour scheme, brand accent, corner style and density.', 'Open in Builder', 'tenant-appearance'],
  ];
  const grid = h('div', { className: 'acct-grid2' });
  cards.forEach(([title, icName, desc, cta, tab]) => {
    grid.appendChild(h('div', { className: 'acct-admin-card' },
      h('div', { style: 'display:flex;align-items:center;gap:10px;' },
        h('span', { className: 'acct-admin-ic' }, ic(icName)),
        h('span', { style: 'font-size:14px;font-weight:600;' }, title)),
      h('div', { className: 'acct-row-sub', style: 'line-height:1.5;' }, desc),
      h('span', { className: 'acct-admin-cta', onClick: () => gotoBuilder(tab) }, `${cta} ›`)));
  });
  const note = h('div', { className: 'acct-card', style: 'font-size:13px;color:var(--fg2);line-height:1.6;' },
    'Workspace-wide controls live in the ', h('span', { className: 'acct-admin-cta', onClick: () => { state.view = 'builder'; render(); } }, 'Builder'),
    ' so every admin change is audited and permission-checked in one place.');
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px;' }, grid, note);
}

function renderBilling(): HTMLElement {
  const plan = h('div', { className: 'acct-plan-card' },
    h('div', { style: 'flex:1;' },
      h('div', { className: 'acct-plan-eyebrow' }, 'CURRENT PLAN'),
      h('div', { className: 'acct-plan-name' }, 'Workspace'),
      h('div', { className: 'acct-plan-sub' }, 'Your geneWeave subscription')),
    h('div', { style: 'text-align:right;' },
      h('button', { className: 'acct-plan-btn' }, 'Manage plan')));
  const usage = h('div', { className: 'acct-grid2' },
    usageCard('Seats used', `${(state.accountPeople?.people?.length ?? 1)}`, 'People in this workspace', Math.min(1, (state.accountPeople?.people?.length ?? 1) / 25)),
    usageCard('AI usage this month', '—', 'Assistant tokens', 0.4));
  const note = h('div', { className: 'acct-card', style: 'font-size:13px;color:var(--fg2);line-height:1.6;' },
    'Plan, seat and invoice management is handled by your workspace administrator.');
  return h('div', { style: 'display:flex;flex-direction:column;gap:14px;' }, plan, usage, note);
}

function usageCard(label: string, value: string, sub: string, frac: number): HTMLElement {
  return h('div', { className: 'acct-card acct-usage' },
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;' },
      h('span', { className: 'acct-row-sub' }, label), h('span', { style: 'font-size:13px;font-weight:600;' }, value)),
    h('div', { className: 'acct-usage-bar' }, h('div', { className: 'acct-usage-fill', style: `width:${Math.round(frac * 100)}%;` })),
    h('div', { className: 'acct-row-sub', style: 'margin-top:9px;' }, sub));
}

// keep the save bar in sync as fields change without a full re-render churn
let _saveBarTimer: number | undefined;
function queueSaveBar(render: () => void): void {
  if (_saveBarTimer) return;
  _saveBarTimer = window.setTimeout(() => { _saveBarTimer = undefined; render(); }, 120);
}

// ── main view ───────────────────────────────────────────────────────────────────────────────────────
export function renderAccountView(render: () => void): HTMLElement {
  if (!state.accountLoaded && !state.accountLoading) void loadAccount(render);
  const section = state.accountSection || 'profile';
  const app = h('div', { className: 'acct-app' });

  // ── nav ──
  const nav = h('nav', { className: 'acct-nav' });
  nav.appendChild(h('div', { className: 'acct-nav-head' },
    h('span', { className: 'acct-nav-mark', innerHTML: WEAVE_MARK }),
    h('div', {},
      h('div', { className: 'acct-nav-word' }, h('span', { style: 'color:var(--fg2);font-weight:600;' }, 'gene'), 'Weave'),
      h('div', { className: 'acct-nav-eyebrow' }, 'SETTINGS'))));
  const body = h('div', { className: 'acct-nav-body' });
  for (const group of ['ACCOUNT', 'WORKSPACE']) {
    const g = h('div', { className: 'acct-nav-group' }, h('div', { className: 'acct-nav-grouplabel' }, group));
    for (const [key, def] of Object.entries(SECTIONS)) {
      if (def.group !== group) continue;
      const active = section === key;
      g.appendChild(h('div', { className: 'acct-nav-item' + (active ? ' active' : ''), onClick: () => { state.accountSection = key; render(); } },
        h('span', { className: 'acct-nav-ic' }, ic(def.ic)),
        h('span', { style: 'flex:1;' }, def.label),
        ...(def.badge ? [h('span', { className: 'acct-nav-badge' }, def.badge)] : [])));
    }
    body.appendChild(g);
  }
  nav.appendChild(body);
  nav.appendChild(h('div', { className: 'acct-nav-foot' },
    h('div', { className: 'acct-user-card' },
      h('span', { className: 'acct-user-avatar' }, initials(state.user?.name || 'You')),
      h('div', { style: 'flex:1;min-width:0;' },
        h('div', { className: 'acct-user-name' }, state.user?.name || 'You'),
        h('div', { className: 'acct-user-org' }, state.user?.email || '')),
      h('span', { className: 'acct-nav-back', title: 'Back to workspace', onClick: () => { state.view = 'chat'; render(); },
        innerHTML: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>' }))));
  app.appendChild(nav);

  // ── main ──
  const main = h('main', { className: 'acct-main' });
  const content = h('div', { className: 'acct-content' });
  const def = SECTIONS[section] ?? SECTIONS['profile']!;
  content.appendChild(h('div', { className: 'acct-header' },
    h('div', { className: 'acct-eyebrow' }, def.eyebrow),
    h('h1', { className: 'acct-title' }, def.title),
    h('p', { className: 'acct-desc' }, def.desc)));

  // Robust states: a failed/slow load must NEVER blank the app (the profile/security/prefs/notifs
  // sections read state.account — guard them so a null never throws out of render()).
  const ready = !!(state.account && state.accountDraft);
  const needsAccount = section === 'profile' || section === 'security' || section === 'prefs' || section === 'notifs';
  if (state.accountError && !ready) {
    content.appendChild(h('div', { className: 'acct-card', style: 'display:flex;flex-direction:column;gap:12px;align-items:flex-start;' },
      h('div', { style: 'font-size:14px;font-weight:600;' }, 'Couldn’t load your account'),
      h('div', { className: 'acct-row-sub' }, 'You may need to sign in again. Check your connection and try once more.'),
      h('button', { className: 'acct-btn-emerald', onClick: () => { state.accountLoaded = false; state.accountError = false; state.account = null; state.accountDraft = null; render(); } }, 'Retry')));
  } else if (needsAccount && !ready) {
    content.appendChild(h('div', { className: 'acct-card', style: 'color:var(--fg3);font-size:13px;' }, 'Loading your account…'));
  } else {
    if (section === 'profile') content.appendChild(renderProfile(render));
    else if (section === 'security') content.appendChild(renderSecurity());
    else if (section === 'prefs') content.appendChild(renderPrefs(render));
    else if (section === 'notifs') content.appendChild(renderNotifs(render));
    else if (section === 'members') content.appendChild(renderMembers(render));
    else if (section === 'admin') content.appendChild(renderAdmin(render));
    else if (section === 'billing') content.appendChild(renderBilling());
  }
  main.appendChild(content);
  app.appendChild(main);

  // ── sticky save bar (only for the dirty-tracked Profile/Preferences sections) ──
  if ((section === 'profile' || section === 'prefs') && ready) {
    const dirty = isDirty();
    app.appendChild(h('div', { className: 'acct-savebar' + (dirty ? ' dirty' : '') },
      h('span', { className: 'acct-savebar-status' }, dirty ? 'Unsaved changes' : 'All changes saved'),
      h('div', { className: 'acct-savebar-actions' },
        h('button', { className: 'acct-btn-ghost', disabled: dirty ? undefined : 'disabled',
          onClick: () => { if (state.account) state.accountDraft = JSON.parse(JSON.stringify({ profile: state.account.profile, preferences: state.account.preferences })); render(); } }, 'Cancel'),
        h('button', { className: 'acct-btn-emerald', disabled: (!dirty || state.accountSaving) ? 'disabled' : undefined,
          onClick: () => void saveAccount(render) }, state.accountSaving ? 'Saving…' : 'Save changes'))));
  }

  return app;
}

const WEAVE_MARK = '<svg width="24" height="24" viewBox="0 0 34 34" fill="none"><path d="M7 11 C 13 11, 13 23, 19 23 C 25 23, 25 11, 31 11" stroke="#0E9A6E" stroke-width="3.4" stroke-linecap="round"/><path d="M3 23 C 9 23, 9 11, 15 11 C 21 11, 21 23, 27 23" stroke="#14201B" stroke-width="3.4" stroke-linecap="round" opacity="0.9"/></svg>';
