/**
 * Kaggle Competition — List + Start view.
 *
 * Operator workflow:
 *  1. Pick or type a competition reference (slug / URL).
 *  2. Optionally describe an objective / constraints.
 *  3. Click "Start Competition" → POST /api/kaggle/competition-runs with a
 *     fresh `Idempotency-Key` so multiple clicks are safe.
 *  4. UI transitions to the flow timeline view for that run.
 *
 * The right rail lists past runs ordered by `created_at DESC`. Status pills
 * use the same colour palette as the SV recent panel for visual consistency.
 */
import { h } from '../../../ui/dom.js';
import { state } from '../../../ui/state.js';

const STATUS_COLOR: Record<string, string> = {
  queued: '#6366f1',
  running: '#f59e0b',
  completed: '#059669',
  abandoned: '#6b7280',
  failed: '#dc2626',
};

interface RunRow {
  id: string;
  competition_ref: string;
  title: string | null;
  status: string;
  step_count: number;
  event_count: number;
  mesh_id: string | null;
  started_at: string | null;
  created_at: string;
}

function freshIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `kgl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fmtRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(t).toLocaleDateString();
}

export function renderKaggleListView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  let submitting = false;

  const competitionInput = h('input', {
    type: 'text',
    placeholder: 'Kaggle competition slug (e.g. titanic, playground-series-s4e1)',
    style: 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;box-sizing:border-box',
  }) as HTMLInputElement;

  const titleInput = h('input', {
    type: 'text',
    placeholder: 'Optional friendly title for this run',
    style: 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;box-sizing:border-box',
  }) as HTMLInputElement;

  const objectiveArea = h('textarea', {
    placeholder: 'What does success look like for this run? (e.g. "beat the public LB baseline by 0.5%, prefer interpretable models")',
    rows: '3',
    style: 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:13px;font-family:var(--font);resize:vertical;box-sizing:border-box',
  }) as HTMLTextAreaElement;

  const errorEl = h('div', {
    style: 'color:var(--danger);font-size:13px;min-height:18px;margin-top:4px',
  });

  const startBtn = h('button', {
    className: 'nav-btn active',
    style: 'padding:11px 32px;font-size:14px;font-weight:600',
    onClick: async () => {
      if (submitting) return;
      const competitionRef = competitionInput.value.trim();
      if (!competitionRef) { errorEl.textContent = 'Competition reference is required.'; return; }
      errorEl.textContent = '';
      submitting = true;
      startBtn.setAttribute('disabled', '');
      startBtn.textContent = 'Starting…';
      try {
        const res = await fetch('/api/kaggle/competition-runs', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': freshIdempotencyKey(),
          },
          body: JSON.stringify({
            competitionRef,
            title: titleInput.value.trim() || undefined,
            objective: objectiveArea.value.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          errorEl.textContent = body.error ?? `Error ${res.status}`;
          startBtn.removeAttribute('disabled');
          startBtn.textContent = 'Start Competition';
          submitting = false;
          return;
        }
        const created = await res.json() as { id: string };
        (state as any).kaggleRunId = created.id;
        (state as any).kaggleView = 'flow';
        render();
      } catch (err: unknown) {
        errorEl.textContent = err instanceof Error ? err.message : 'Network error';
        startBtn.removeAttribute('disabled');
        startBtn.textContent = 'Start Competition';
        submitting = false;
      }
    },
  }, 'Start Competition');

  const field = (label: string, input: HTMLElement, hint?: string) => h('div', {
    style: 'margin-bottom:18px',
  },
    h('label', {
      style: 'display:block;font-size:12px;color:var(--fg2);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.04em',
    }, label),
    input,
    hint ? h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:4px' }, hint) : null,
  );

  // ── Past runs panel ────────────────────────────────────────────────────
  const runsEl = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  const runsCard = h('div', {
    style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:14px;padding:22px 24px',
  },
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px' },
      h('div', { style: 'font-size:13px;font-weight:600;color:var(--fg2);text-transform:uppercase;letter-spacing:.04em' }, 'Recent Runs'),
      h('button', {
        className: 'nav-btn',
        style: 'padding:4px 12px;font-size:11px',
        onClick: () => { void loadRuns(); },
      }, 'Refresh'),
    ),
    runsEl,
  );

  async function loadRuns() {
    try {
      const res = await fetch('/api/kaggle/competition-runs', { credentials: 'include' });
      if (!res.ok) {
        runsEl.innerHTML = '';
        runsEl.appendChild(h('div', { style: 'color:var(--fg3);font-size:13px' }, 'Could not load runs.'));
        return;
      }
      const data = await res.json() as { runs: RunRow[] };
      runsEl.innerHTML = '';
      if (!data.runs.length) {
        runsEl.appendChild(h('div', { style: 'color:var(--fg3);font-size:13px' }, 'No runs yet. Start your first competition above.'));
        return;
      }
      for (const run of data.runs) {
        const color = STATUS_COLOR[run.status] ?? '#6b7280';
        const card = h('div', {
          style: 'display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg);border:1px solid var(--bg4);border-radius:10px;cursor:pointer;transition:border-color .15s',
          onMouseEnter: (e: Event) => { (e.currentTarget as HTMLElement).style.borderColor = color; },
          onMouseLeave: (e: Event) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--bg4)'; },
          onClick: () => {
            (state as any).kaggleRunId = run.id;
            (state as any).kaggleView = 'flow';
            render();
          },
        },
          h('span', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0` }),
          h('div', { style: 'flex:1;min-width:0' },
            h('div', { style: 'font-size:13px;font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, run.title || run.competition_ref),
            h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:2px' },
              `${run.competition_ref} · ${run.step_count} steps · ${run.event_count} events · ${fmtRelative(run.created_at)}`,
            ),
          ),
          h('span', {
            style: `font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.05em;flex-shrink:0`,
          }, run.status),
        );
        runsEl.appendChild(card);
      }
    } catch {
      runsEl.innerHTML = '';
      runsEl.appendChild(h('div', { style: 'color:var(--fg3);font-size:13px' }, 'Could not load runs.'));
    }
  }
  setTimeout(() => { void loadRuns(); }, 50);

  return h('div', { className: 'dash-view' },
    h('div', { style: 'max-width:860px;margin:0 auto' },
      h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:28px' },
        h('span', { style: 'font-size:28px' }, '🏆'),
        h('div', null,
          h('h2', { style: 'font-size:22px;font-weight:700;color:var(--fg);margin:0 0 4px' }, 'Kaggle Competitions'),
          h('p', { style: 'color:var(--fg3);font-size:13px;margin:0' },
            'Provision a fresh live-agents mesh per run, watch the discoverer → strategist → implementer → validator → submitter flow in real time.'),
        ),
      ),
      h('div', {
        style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:14px;padding:26px 28px;margin-bottom:24px',
      },
        h('div', { style: 'font-size:15px;font-weight:600;color:var(--fg);margin-bottom:18px' }, 'Start a New Run'),
        field('Competition', competitionInput, 'Kaggle competition slug. Pulled into the discoverer agent\'s context.'),
        field('Run Title', titleInput, 'Optional. Shown in the recent-runs list.'),
        field('Objective', objectiveArea, 'Optional. Steers the strategist agent\'s plan.'),
        errorEl,
        h('div', { style: 'margin-top:6px;display:flex;align-items:center;gap:12px' },
          startBtn,
          h('span', { style: 'font-size:11px;color:var(--fg3)' }, 'Each run gets its own UUIDv7 mesh + step ledger.'),
        ),
      ),
      runsCard,
    ),
  );
}
