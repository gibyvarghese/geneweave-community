/**
 * Hypothesis Validation — Submit View (v4)
 *
 * Uses CSS classes exclusively (no inline styles) so the CSP hash on <style>
 * is respected. All layout/colour lives in styles.ts under the .sv-* prefix.
 */
import { h } from '../../../ui/dom.js';
import { api } from '../../../ui/api.js';
import { state } from '../../../ui/state.js';
import { ensureSVStyles } from '../sv-css.js';

// ── Templates ─────────────────────────────────────────────────────────────────

interface HypothesisTemplate {
  id: string;
  icon: string;
  name: string;
  category: string;
  title: string;
  statement: string;
  tags: string[];
}

const TEMPLATES: HypothesisTemplate[] = [
  {
    id: 'blank',
    icon: '✏️',
    name: 'Blank',
    category: 'General',
    title: '',
    statement: '',
    tags: [],
  },
  {
    id: 'clinical-rct',
    icon: '🏥',
    name: 'Clinical Trial',
    category: 'Medicine',
    title: 'Intervention effect in target population',
    statement: 'In adults aged 40–70 with hypertension (P), daily administration of [intervention] (I) compared to placebo/standard-of-care (C) reduces systolic blood pressure by ≥10 mmHg at 12 weeks (O).',
    tags: ['medicine', 'epidemiology', 'pharmacology'],
  },
  {
    id: 'epidemiology',
    icon: '📈',
    name: 'Epidemiological',
    category: 'Public Health',
    title: 'Exposure–outcome association in population',
    statement: 'In [population] (P), [exposure/risk factor] (I) compared to non-exposed controls (C) is associated with a ≥[X]% increase in [outcome] incidence over [time period] (O).',
    tags: ['epidemiology', 'biology', 'medicine'],
  },
  {
    id: 'mathematical',
    icon: '∑',
    name: 'Mathematical',
    category: 'Mathematics',
    title: 'Mathematical identity or closed-form result',
    statement: 'The definite integral ∫[expression] dx from [a] to [b] equals [exact value]. Equivalently: [algebraic identity / series convergence / equation solution].',
    tags: ['mathematics'],
  },
  {
    id: 'ml-performance',
    icon: '🤖',
    name: 'ML / AI',
    category: 'Computer Science',
    title: 'Model architecture improvement on benchmark',
    statement: 'A [model type] trained on [dataset] with [modification] (I) compared to the standard baseline (C) achieves ≥[X]% relative improvement on [benchmark metric] (O) across [N] independent runs.',
    tags: ['engineering', 'mathematics', 'economics'],
  },
  {
    id: 'materials',
    icon: '⚗️',
    name: 'Materials Science',
    category: 'Chemistry',
    title: 'Material property under synthesis conditions',
    statement: 'Synthesising [material] using [method/conditions] (I) compared to the conventional synthesis route (C) yields a ≥[X]% improvement in [property: tensile strength/conductivity/etc.] as measured by [instrument/standard] (O).',
    tags: ['chemistry', 'materials', 'engineering'],
  },
  {
    id: 'economics',
    icon: '💰',
    name: 'Economic Effect',
    category: 'Economics',
    title: 'Policy or market intervention economic impact',
    statement: 'Implementation of [policy/intervention] in [region/market] (I) compared to the pre-intervention baseline or control region (C) leads to a ≥[X]% change in [economic metric: GDP growth, unemployment, consumer spending] over [time horizon] (O).',
    tags: ['economics', 'psychology'],
  },
  {
    id: 'neuroscience',
    icon: '🧠',
    name: 'Neuroscience',
    category: 'Biology',
    title: 'Neural mechanism or cognitive effect',
    statement: 'In [organism/population] (P), [intervention/condition] (I) compared to sham/control (C) produces a statistically significant change in [neural measure: BOLD activation/spike rate/LFP power] in [brain region] (O), as measured by [modality].',
    tags: ['neuroscience', 'biology', 'medicine'],
  },
];

const STATEMENT_MAX = 1500;

const DOMAINS = [
  'biology','chemistry','physics','mathematics','medicine',
  'epidemiology','climate','economics','psychology','neuroscience',
  'materials','engineering','nutrition','genetics','pharmacology',
];

const STATUS_META: Record<string, { label: string; color: string }> = {
  running:   { label: 'Running',   color: '#f59e0b' },
  queued:    { label: 'Queued',    color: '#6366f1' },
  verdict:   { label: 'Complete',  color: '#059669' },
  abandoned: { label: 'Abandoned', color: '#6b7280' },
};

// ── Component ─────────────────────────────────────────────────────────────────

export function renderSVSubmitView(options: { render: () => void }): HTMLElement {
  ensureSVStyles();
  const { render } = options;

  let submitting = false;
  const tags: string[] = [];
  let selectedId = 'blank';

  // ── Inputs ────────────────────────────────────────────────────────────────
  const titleInput = h('input', {
    type: 'text',
    className: 'sv-field',
    placeholder: 'Short, memorable title for this validation run…',
  }) as HTMLInputElement;

  const charCount = h('div', { className: 'sv-char-count' }, `0 / ${STATEMENT_MAX}`);

  const statementArea = h('textarea', {
    rows: '9',
    className: 'sv-textarea',
    placeholder: 'Write a falsifiable, precisely scoped statement.\n\nPICO format: "In [population] (P), [intervention] (I) compared to [comparison] (C) results in [outcome with measurable direction and magnitude] (O)."\n\nExample: "In adults aged 50–70 with no prior diagnosis, 150 min/week of moderate aerobic exercise compared to sedentary lifestyle reduces 10-year cardiovascular event risk by ≥15%."',
    onInput: () => {
      const n = statementArea.value.length;
      charCount.textContent = `${n} / ${STATEMENT_MAX}`;
      if (n > STATEMENT_MAX * 0.9) charCount.classList.add('sv-warn');
      else charCount.classList.remove('sv-warn');
    },
  }) as HTMLTextAreaElement;

  // ── Tag chips ─────────────────────────────────────────────────────────────
  const chipsRow = h('div', { className: 'sv-chips-row' });

  function renderChips() {
    while (chipsRow.firstChild) chipsRow.removeChild(chipsRow.firstChild);
    tags.forEach(tag =>
      chipsRow.appendChild(h('div', { className: 'sv-chip' },
        h('span', null, tag),
        h('button', {
          className: 'sv-chip-remove',
          onClick: () => { const i = tags.indexOf(tag); if (i >= 0) { tags.splice(i, 1); renderChips(); } },
        }, '×'),
      ))
    );
  }

  const tagInput = h('input', {
    type: 'text',
    className: 'sv-tag-input',
    placeholder: 'Type a domain and press Enter…',
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ',') && tagInput.value.trim()) {
        e.preventDefault();
        addTag(tagInput.value.trim());
        tagInput.value = '';
      }
    },
  }) as HTMLInputElement;

  function addTag(raw: string) {
    const t = raw.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 24);
    if (!t || tags.includes(t)) return;
    tags.push(t);
    renderChips();
  }

  const suggRow = h('div', { className: 'sv-sugg-row' });
  DOMAINS.forEach(d => {
    const btn = h('button', { className: 'sv-sugg-btn', onClick: () => addTag(d) }, d);
    suggRow.appendChild(btn);
  });

  // ── Template grid ─────────────────────────────────────────────────────────
  const tplGrid = h('div', { className: 'sv-tpl-grid' });

  function renderTplGrid() {
    while (tplGrid.firstChild) tplGrid.removeChild(tplGrid.firstChild);
    TEMPLATES.forEach(tpl => {
      const active = tpl.id === selectedId;
      const card = h('div', {
        className: `sv-tpl-card${active ? ' sv-active' : ''}`,
        onClick: () => applyTemplate(tpl),
      },
        h('div', { className: 'sv-tpl-head' },
          h('span', { className: 'sv-tpl-icon' }, tpl.icon),
          active ? h('span', { className: 'sv-tpl-badge' }, 'selected') : h('span', null, ''),
        ),
        h('div', { className: `sv-tpl-name${active ? ' sv-active' : ''}` }, tpl.name),
        h('div', { className: 'sv-tpl-cat' }, tpl.category),
      );
      tplGrid.appendChild(card);
    });
  }
  renderTplGrid();

  function applyTemplate(tpl: HypothesisTemplate) {
    selectedId = tpl.id;
    titleInput.value = tpl.title;
    statementArea.value = tpl.statement;
    const n = tpl.statement.length;
    charCount.textContent = `${n} / ${STATEMENT_MAX}`;
    if (n > STATEMENT_MAX * 0.9) charCount.classList.add('sv-warn');
    else charCount.classList.remove('sv-warn');
    tags.length = 0;
    tpl.tags.forEach(t => tags.push(t));
    renderChips();
    renderTplGrid();
    setTimeout(() => (tpl.title ? statementArea.focus() : titleInput.focus()), 80);
  }

  // ── Error / submit ────────────────────────────────────────────────────────
  const errorEl = h('div', { className: 'sv-error' });

  function showError(msg: string) { errorEl.textContent = msg; errorEl.classList.add('sv-show'); }
  function clearError() { errorEl.textContent = ''; errorEl.classList.remove('sv-show'); }

  const submitBtn = h('button', {
    className: 'sv-submit-btn',
    onClick: async () => {
      if (submitting) return;
      clearError();
      const title     = titleInput.value.trim();
      const statement = statementArea.value.trim();
      if (!title) { showError('Please enter a title for this hypothesis.'); return; }
      if (!statement) { showError('Please write the hypothesis statement.'); return; }
      if (statement.split(/\s+/).length < 8) { showError('Statement is too brief — describe the population, intervention, comparison, and expected outcome.'); return; }
      if (statement.length > STATEMENT_MAX) { showError(`Statement is too long (${statement.length} / ${STATEMENT_MAX} chars).`); return; }

      submitting = true;
      submitBtn.setAttribute('disabled', '');
      submitBtn.textContent = 'Submitting…';

      try {
        const res = await api.post('/api/sv/hypotheses', { title, statement, domainTags: tags });
        if (!res.ok) {
          const body = await res.json() as { error?: string };
          showError(body.error ?? `Server error (${res.status})`);
          return;
        }
        const created = await res.json() as { id: string };
        (state as any).svHypothesisId = created.id;
        (state as any).svHypothesis = { title, statement, domainTags: [...tags] };
        (state as any).svView = 'live';
        render();
      } catch (err: unknown) {
        showError(err instanceof Error ? err.message : 'Network error — check your connection.');
      } finally {
        submitting = false;
        submitBtn.removeAttribute('disabled');
        submitBtn.textContent = 'Submit for Validation';
      }
    },
  }, 'Submit for Validation');

  // ── Recent hypotheses ─────────────────────────────────────────────────────
  const recentPanel = h('div', { className: 'sv-hidden' });

  async function loadRecent() {
    try {
      const res = await api.get('/api/sv/hypotheses');
      if (!res.ok) return;
      const data = await res.json() as { hypotheses?: Array<{ id: string; title: string; status: string }> };
      if (!data.hypotheses?.length) return;

      const list = h('div', { className: 'sv-recent-list' });
      data.hypotheses.slice(0, 5).forEach(hyp => {
        const st = STATUS_META[hyp.status] ?? { label: hyp.status, color: '#6b7280' };
        const clickable = hyp.status === 'running' || hyp.status === 'queued' || hyp.status === 'verdict';
        const statusKey = hyp.status in STATUS_META ? hyp.status : 'abandoned';
        const dot = h('span', { className: `sv-recent-dot sv-dot-${statusKey}` });
        const statusEl = h('span', { className: `sv-recent-status sv-status-${statusKey}` }, st.label);
        const row = h('div', {
          className: 'sv-recent-row',
          onClick: () => {
            if (!clickable) return;
            (state as any).svHypothesisId = hyp.id;
            (state as any).svView = hyp.status === 'verdict' ? 'verdict' : 'live';
            render();
          },
        },
          dot,
          h('span', { className: 'sv-recent-title' }, hyp.title),
          statusEl,
          clickable ? h('span', { className: 'sv-recent-arr' }, '→') : h('span', null, ''),
        );
        list.appendChild(row);
      });

      while (recentPanel.firstChild) recentPanel.removeChild(recentPanel.firstChild);
      recentPanel.appendChild(h('div', { className: 'sv-recent-wrap' },
        h('div', { className: 'sv-recent-head' }, 'Recent Validations'),
        list,
      ));
      recentPanel.classList.remove('sv-hidden');
    } catch { /* ignore */ }
  }
  setTimeout(() => { void loadRecent(); }, 80);

  // ── Tips ─────────────────────────────────────────────────────────────────
  const TIPS = [
    { icon: '🎯', head: 'PICO',        body: 'Population · Intervention · Comparison · Outcome' },
    { icon: '⚗️', head: 'Falsifiable', body: 'What evidence would definitively disprove it?' },
    { icon: '📐', head: 'Precise',     body: 'Include direction and magnitude — "≥15% reduction"' },
    { icon: '🔬', head: 'Scoped',      body: 'One testable claim per submission' },
  ];

  const tipsGrid = h('div', { className: 'sv-tips-grid' },
    ...TIPS.map(t => h('div', { className: 'sv-tip-card' },
      h('div', { className: 'sv-tip-head' },
        h('span', { className: 'sv-tip-icon' }, t.icon),
        h('span', { className: 'sv-tip-title' }, t.head),
      ),
      h('div', { className: 'sv-tip-body' }, t.body),
    )),
  );

  // ── Label helper ─────────────────────────────────────────────────────────
  function label(text: string, hint?: string): HTMLElement {
    return h('div', null,
      h('div', { className: 'sv-label' }, text),
      hint ? h('div', { className: 'sv-label-hint' }, hint) : h('span', null, ''),
    );
  }

  // ── Assemble ─────────────────────────────────────────────────────────────
  return h('div', { className: 'dash-view' },
    h('div', { className: 'sv-page' },

      // Header
      h('div', { className: 'sv-page-header' },
        h('div', { className: 'sv-page-icon' }, '🔬'),
        h('div', null,
          h('h2', { className: 'sv-page-title' }, 'Validate a Hypothesis'),
          h('p', { className: 'sv-page-sub' }, 'Multi-agent evidence gathering, statistical analysis, simulation, and adversarial review.'),
        ),
      ),

      // Recent runs
      recentPanel,

      // Tips
      tipsGrid,

      // Template selector
      h('div', null,
        h('div', { className: 'sv-section-title' }, 'Start from a template'),
        tplGrid,
      ),

      // Form card
      h('div', { className: 'sv-form-card' },
        h('div', { className: 'sv-form-head' },
          h('span', { className: 'sv-form-head-icon' }, '📝'),
          'Hypothesis Details',
        ),

        // Title
        h('div', { className: 'sv-form-sec' },
          label('Title', 'A concise, memorable name for this validation run.'),
          titleInput,
        ),

        // Statement
        h('div', { className: 'sv-form-sec' },
          label('Statement', 'The full, falsifiable hypothesis claim. Use PICO format for empirical claims.'),
          statementArea,
          charCount,
        ),

        // Domain tags
        h('div', { className: 'sv-form-sec' },
          label('Domain Tags', 'Help route the hypothesis to the right specialist tools.'),
          chipsRow,
          tagInput,
          h('div', { className: 'sv-sugg-label' }, 'Quick-add:'),
          suggRow,
        ),

        // Error + submit
        errorEl,
        h('div', { className: 'sv-submit-row' }, submitBtn),
      ),
    ),
  );
}
