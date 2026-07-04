// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 3 — the SCHEDULED AGENTS panel.
 *
 * --- For someone new to this ---
 * This is the "set it and forget it" panel. You create a small AI helper that runs on a schedule over
 * YOUR notes — e.g. "every weekday morning, write a digest of the notes I touched yesterday". It runs
 * by itself, inside a budget so it can't run away, and it only ever CREATES a new note (it never
 * changes your existing notes). You can also press "Run now" to try it immediately, and see a history
 * of every run. A self-contained DOM panel (no framework).
 */
import { h } from './dom.js';
import { api } from './api.js';

interface AgentView { id: string; name: string; recipe: string; cron: string; timezone: string; scope: string; enabled: boolean; lastRunAt: string | null; nextRunAt: number | null }
interface RunRow { status: string; steps: number; tokens_used: number; notes_scanned: number; summary: string | null; started_at: string; output_note_id: string | null }

const RECIPES: Array<{ id: string; label: string }> = [
  { id: 'daily_digest', label: 'Daily digest' },
  { id: 'action_items', label: 'Action-item extractor' },
  { id: 'link_suggester', label: 'Link suggester' },
  { id: 'stale_flagger', label: 'Stale-note flagger' },
  { id: 'custom', label: 'Custom task' },
];

export function renderScheduledAgentsPanel(onOpenNote: (id: string) => void): HTMLElement {
  const root = h('div', { className: 'gw-sched' }) as HTMLElement;
  let agents: AgentView[] = [];
  let busy = false; let err = '';

  async function load(): Promise<void> {
    try { const r = await api.get('/api/me/scheduled-agents'); const d = await r.json().catch(() => ({})) as { agents?: AgentView[] }; agents = d.agents ?? []; } catch { agents = []; }
    paint();
  }
  async function create(form: Record<string, unknown>): Promise<void> {
    if (busy) return; busy = true; err = ''; paint();
    try { const r = await api.post('/api/me/scheduled-agents', form); if (!r.ok) { const e = await r.json().catch(() => ({})) as { error?: string }; err = e.error ?? `Could not create (${r.status})`; } }
    finally { busy = false; await load(); }
  }
  async function run(id: string): Promise<void> {
    if (busy) return; busy = true; err = ''; paint();
    try {
      const r = await api.post(`/api/me/scheduled-agents/${id}/run`, {});
      const d = await r.json().catch(() => ({})) as { ok?: boolean; outputNoteId?: string; status?: string; error?: string };
      if (d.ok && d.outputNoteId) { onOpenNote(d.outputNoteId); document.querySelector('.gw-modal-overlay')?.remove(); return; }
      err = d.error ?? `Run ${d.status ?? 'failed'}`;
    } catch { err = 'Could not run.'; }
    busy = false; await load();
  }
  async function showRuns(id: string, host: HTMLElement): Promise<void> {
    const r = await api.get(`/api/me/scheduled-agents/${id}/runs`); const d = await r.json().catch(() => ({})) as { runs?: RunRow[] };
    host.innerHTML = '';
    for (const run of (d.runs ?? []).slice(0, 5)) {
      host.appendChild(h('div', { className: 'gw-sched-run' }, `${run.started_at.slice(0, 16).replace('T', ' ')} · ${run.status} · ${run.steps} steps · ${run.tokens_used} tokens · ${run.summary ?? ''}`));
    }
    if (!(d.runs ?? []).length) host.appendChild(h('div', { className: 'gw-sched-run' }, 'No runs yet.'));
  }
  async function del(id: string): Promise<void> { await api.del(`/api/me/scheduled-agents/${id}`); await load(); }

  function paint(): void {
    root.innerHTML = '';
    root.appendChild(h('p', { className: 'gw-sched-intro' }, 'A scheduled agent runs an AI task over YOUR notes on a schedule — within a budget, and it only ever creates a NEW note (your existing notes are never changed). Press “Run now” to try one immediately.'));

    // Existing agents.
    if (agents.length === 0) root.appendChild(h('div', { className: 'gw-sched-empty' }, 'No scheduled agents yet — create one below.'));
    for (const a of agents) {
      const runsHost = h('div', { className: 'gw-sched-runs' });
      const card = h('div', { className: 'gw-sched-card' },
        h('div', { className: 'gw-sched-card-head' },
          h('b', null, a.name),
          h('span', { className: 'gw-sched-tag' }, RECIPES.find((r) => r.id === a.recipe)?.label ?? a.recipe),
        ),
        h('div', { className: 'gw-sched-meta' }, `${a.cron} · ${a.timezone} · scope: ${a.scope}${a.lastRunAt ? ` · last run ${a.lastRunAt.slice(0, 16).replace('T', ' ')}` : ''}`),
        h('div', { className: 'gw-sched-actions' },
          h('button', { className: 'gw-btn-emerald gw-sched-run', disabled: busy, onClick: () => void run(a.id) }, busy ? '…' : '▶ Run now'),
          h('button', { className: 'gw-sched-link', onClick: () => void showRuns(a.id, runsHost) }, 'History'),
          h('button', { className: 'gw-sched-link gw-sched-del', onClick: () => void del(a.id) }, 'Delete'),
        ),
        runsHost,
      );
      root.appendChild(card);
    }

    // Create form.
    const name = h('input', { className: 'gw-sched-input', placeholder: 'Name, e.g. Morning digest' }) as HTMLInputElement;
    const recipe = h('select', { className: 'gw-sched-input' }) as HTMLSelectElement;
    for (const r of RECIPES) recipe.appendChild(h('option', { value: r.id }, r.label) as HTMLOptionElement);
    const cron = h('input', { className: 'gw-sched-input', value: '0 8 * * MON-FRI' }) as HTMLInputElement;
    const scope = h('select', { className: 'gw-sched-input' },
      h('option', { value: 'recent' }, 'Recent notes'), h('option', { value: 'all' }, 'All notes'), h('option', { value: 'tag' }, 'Tagged notes'),
    ) as HTMLSelectElement;
    if (err) root.appendChild(h('p', { className: 'gw-sched-error' }, err));
    root.appendChild(h('div', { className: 'gw-sched-form' },
      h('div', { className: 'gw-sched-form-title' }, '➕ New scheduled agent'),
      name, recipe,
      h('label', { className: 'gw-sched-lbl' }, 'Schedule (cron)'), cron,
      h('label', { className: 'gw-sched-lbl' }, 'Notes'), scope,
      h('button', { className: 'gw-btn-emerald gw-sched-create', disabled: busy, onClick: () => void create({ name: name.value || 'Scheduled task', recipe: recipe.value, cron: cron.value, scope: scope.value, triggerType: 'schedule' }) }, busy ? 'Creating…' : 'Create'),
    ));
  }

  void load();
  return root;
}
