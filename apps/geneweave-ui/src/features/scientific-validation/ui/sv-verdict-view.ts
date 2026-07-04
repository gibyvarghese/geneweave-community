/**
 * Hypothesis Validation — Verdict View (v3)
 * Uses only CSS classes (no inline styles) — required by CSP hash on <style>.
 * Confidence bar uses inline SVG (SVG presentation attributes bypass style-src).
 */
import { h } from '../../../ui/dom.js';
import { api } from '../../../ui/api.js';
import { state } from '../../../ui/state.js';
import { ensureSVStyles } from '../sv-css.js';

interface VerdictShape {
  id: string;
  verdict: string;
  confidenceLo: number;
  confidenceHi: number;
  limitations?: string;
  emittedBy?: string;
}

interface SubClaimVerdict {
  subClaimIndex: number;
  verdict: string;
  confidence: number;
  gradeQuality?: string;
}

interface SupervisorJson {
  verdict?: string;
  confidence?: number;
  gradeQuality?: string;
  bradfordHillScore?: number;
  summary?: string;
  subClaimVerdicts?: SubClaimVerdict[];
  strengthsOfEvidence?: string[];
  weaknessesOfEvidence?: string[];
  recommendedNextSteps?: string[];
}

interface SubClaim {
  id: string;
  statement: string;
  claimType: string;
  testabilityScore: number;
  falsificationCriterion?: string;
}

interface EvidenceEvent {
  evidenceId: string;
  kind: string;
  summary: string;
  agentId: string;
  toolKey?: string;
  sourceType?: string;
}

interface BundleData {
  hypothesis: { title: string; statement: string; domainTags?: string[]; traceId?: string };
  verdict: VerdictShape;
  supervisorJson?: SupervisorJson;
  subClaims: SubClaim[];
  evidenceEvents: EvidenceEvent[];
}

// Verdict config — keys must match API `verdict` strings
const VERDICT_CFG: Record<string, { label: string; icon: string; heroClass: string; textClass: string; fillColor: string }> = {
  supported:    { label: 'Supported',    icon: '✅', heroClass: 'sv-vd-hero-supported',    textClass: 'sv-vd-text-supported',    fillColor: '#059669' },
  refuted:      { label: 'Refuted',      icon: '❌', heroClass: 'sv-vd-hero-refuted',      textClass: 'sv-vd-text-refuted',      fillColor: '#dc2626' },
  inconclusive: { label: 'Inconclusive', icon: '⚠️', heroClass: 'sv-vd-hero-inconclusive', textClass: 'sv-vd-text-inconclusive', fillColor: '#d97706' },
  ill_posed:    { label: 'Ill-posed',    icon: '🔄', heroClass: 'sv-vd-hero-ill-posed',    textClass: 'sv-vd-text-ill-posed',    fillColor: '#7c3aed' },
  out_of_scope: { label: 'Out of Scope', icon: '📭', heroClass: 'sv-vd-hero-out-of-scope', textClass: 'sv-vd-text-out-of-scope', fillColor: '#6b7280' },
};

const GRADE_CLASS: Record<string, string> = {
  HIGH: 'sv-grade-high', MODERATE: 'sv-grade-moderate', LOW: 'sv-grade-low', VERY_LOW: 'sv-grade-very-low',
};

const VPILL_CLASS: Record<string, string> = {
  supported: 'sv-vp-supported', refuted: 'sv-vp-refuted', inconclusive: 'sv-vp-inconclusive',
};

const AGENT_EMOJI: Record<string, string> = {
  decomposer: '🧩', literature: '📚', statistical: '📊',
  mathematical: '∑', simulation: '🔬', adversarial: '⚔️', supervisor: '🧠',
};

function agentKey(id: string) { return id.replace(/^sv-/, ''); }

// Confidence bar using inline SVG (SVG presentation attributes bypass style-src CSP)
function makeCiBar(lo: number, hi: number, fillColor: string): HTMLElement {
  const ns  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 8');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'sv-vd-ci-svg');

  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
  bg.setAttribute('width', '100'); bg.setAttribute('height', '8');
  bg.setAttribute('rx', '4');
  bg.setAttribute('class', 'sv-vd-ci-track');
  svg.appendChild(bg);

  const loX = Math.max(0, Math.round(lo * 100));
  const wiX = Math.max(2, Math.round((hi - lo) * 100));
  const fill = document.createElementNS(ns, 'rect');
  fill.setAttribute('x', String(loX)); fill.setAttribute('y', '0');
  fill.setAttribute('width', String(wiX)); fill.setAttribute('height', '8');
  fill.setAttribute('rx', '4');
  fill.setAttribute('fill', fillColor);
  svg.appendChild(fill);

  const nums = document.createElement('div');
  nums.className = 'sv-vd-ci-nums';
  const lo_s = document.createElement('span'); lo_s.textContent = `${Math.round(lo * 100)}%`;
  const mi_s = document.createElement('span'); mi_s.textContent = `CI ${Math.round(lo * 100)}–${Math.round(hi * 100)}%`;
  const hi_s = document.createElement('span'); hi_s.textContent = `${Math.round(hi * 100)}%`;
  nums.appendChild(lo_s); nums.appendChild(mi_s); nums.appendChild(hi_s);

  const wrap = document.createElement('div');
  wrap.appendChild(svg);
  wrap.appendChild(nums);
  return wrap;
}

function verdictPillClass(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v.includes('support')) return 'sv-vd-vpill sv-vp-supported';
  if (v.includes('refut') || v.includes('contra')) return 'sv-vd-vpill sv-vp-refuted';
  return 'sv-vd-vpill sv-vp-inconclusive';
}

function scvLabel(v: string): string {
  const v2 = v.toLowerCase();
  if (v2.includes('support')) return 'Supported';
  if (v2.includes('refut') || v2.includes('contra')) return 'Refuted';
  return 'Inconclusive';
}

function section(title: string, children: (HTMLElement | null)[]): HTMLElement {
  const el = h('div', { className: 'sv-vd-sec' },
    h('div', { className: 'sv-vd-sec-title' }, title),
  );
  children.forEach(c => { if (c) el.appendChild(c); });
  return el;
}

export function renderSVVerdictView(options: { render: () => void }): HTMLElement {
  ensureSVStyles();
  const { render } = options;
  const hypothesisId = (state as any).svHypothesisId as string | null;

  let bundleData: BundleData | null = null;
  let loading = true;
  let loadError = '';
  let supervisorJson: SupervisorJson | null = null;

  const container = h('div', { className: 'dash-view' });

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderContent() {
    while (container.firstChild) container.removeChild(container.firstChild);

    const inner = h('div', { className: 'sv-vd-pg' });

    // Top bar
    const topTitle = bundleData?.hypothesis.title || 'Validation Verdict';
    const topBar = h('div', { className: 'sv-vd-topbar' },
      h('div', { className: 'sv-vd-topbar-icon' }, '🔬'),
      h('div', { className: 'sv-vd-topbar-text' },
        h('h2', { className: 'sv-vd-topbar-title' }, topTitle),
        h('div', { className: 'sv-vd-topbar-sub' }, 'Scientific Validation Result'),
      ),
      h('div', { className: 'sv-vd-topbar-btns' },
        bundleData?.hypothesis.traceId
          ? h('button', {
              className: 'nav-btn',
              title: 'Copy trace ID',
              onClick: () => { void navigator.clipboard?.writeText(bundleData?.hypothesis.traceId ?? ''); },
            }, '📋 Trace')
          : null,
        h('button', {
          className: 'nav-btn active',
          onClick: () => {
            (state as any).svView = 'submit';
            (state as any).svHypothesisId = null;
            (state as any).svVerdict = null;
            render();
          },
        }, '+ New Hypothesis'),
      ),
    );
    inner.appendChild(topBar);

    if (loadError) {
      inner.appendChild(h('div', { className: 'sv-vd-error' }, loadError));
      container.appendChild(inner);
      return;
    }
    if (loading || !bundleData) {
      inner.appendChild(h('div', { className: 'sv-vd-loading' }, 'Loading verdict…'));
      container.appendChild(inner);
      return;
    }

    const v    = bundleData.verdict;
    const cfg  = VERDICT_CFG[v.verdict] ?? VERDICT_CFG['inconclusive']!;
    const sj   = supervisorJson;
    const gradeQ  = sj?.gradeQuality;
    const bhScore = sj?.bradfordHillScore;

    // Hero card
    const heroEl = h('div', { className: `sv-vd-hero ${cfg.heroClass}` },
      h('div', { className: 'sv-vd-hero-row' },
        h('div', { className: 'sv-vd-vleft' },
          h('span', { className: 'sv-vd-vicon' }, cfg.icon),
          h('div', null,
            h('div', { className: `sv-vd-vlabel ${cfg.textClass}` }, cfg.label),
            h('div', { className: 'sv-vd-badges' },
              gradeQ && GRADE_CLASS[gradeQ]
                ? h('span', { className: `sv-vd-grade ${GRADE_CLASS[gradeQ]}`, title: 'GRADE evidence quality' }, `GRADE: ${gradeQ}`)
                : null,
              bhScore !== undefined && bhScore > 0
                ? h('span', { className: 'sv-vd-bh', title: 'Bradford Hill causality score (0–9)' }, `BH: ${bhScore}/9`)
                : null,
              h('span', { className: 'sv-vd-emitted' }, `by ${v.emittedBy ?? 'supervisor'}`),
            ),
          ),
        ),
        h('div', { className: 'sv-vd-ci-side' },
          h('div', { className: 'sv-vd-ci-label' }, 'Confidence Interval'),
          makeCiBar(v.confidenceLo, v.confidenceHi, cfg.fillColor),
        ),
      ),
    );

    if (sj?.summary) {
      heroEl.appendChild(h('div', { className: 'sv-vd-summary' }, sj.summary));
    } else if (v.limitations) {
      heroEl.appendChild(h('div', { className: 'sv-vd-summary' }, v.limitations));
    }
    inner.appendChild(heroEl);

    // Hypothesis statement
    if (bundleData.hypothesis.statement) {
      const stmtEl = section('Hypothesis', [
        h('div', { className: 'sv-vd-hyp-stmt' }, bundleData.hypothesis.statement),
        bundleData.hypothesis.domainTags?.length
          ? h('div', { className: 'sv-vd-hyp-tags' },
              ...bundleData.hypothesis.domainTags.map(t =>
                h('span', { className: 'sv-vd-hyp-tag' }, t)
              )
            )
          : null,
      ]);
      inner.appendChild(stmtEl);
    }

    // Sub-claim verdicts
    if (sj?.subClaimVerdicts?.length) {
      const listEl = h('div', { className: 'sv-vd-subclaims' });
      sj.subClaimVerdicts.forEach((scv, i) => {
        const label = scvLabel(scv.verdict ?? '');
        const pillCls = verdictPillClass(scv.verdict ?? '');
        const icon = label === 'Supported' ? '✅' : label === 'Refuted' ? '❌' : '⚠️';
        const sc = bundleData!.subClaims[scv.subClaimIndex] ?? bundleData!.subClaims[i];
        const row = h('div', { className: 'sv-vd-sc' },
          h('span', { className: 'sv-vd-sc-icon' }, icon),
          h('div', { className: 'sv-vd-sc-body' },
            h('div', { className: 'sv-vd-sc-meta' },
              h('span', { className: pillCls }, label),
              h('span', { className: 'sv-vd-emitted' }, `${Math.round((scv.confidence ?? 0) * 100)}% confidence`),
              scv.gradeQuality && GRADE_CLASS[scv.gradeQuality]
                ? h('span', { className: `sv-vd-grade ${GRADE_CLASS[scv.gradeQuality]}` }, `GRADE: ${scv.gradeQuality}`)
                : null,
            ),
            sc
              ? h('div', { className: 'sv-vd-sc-stmt' }, sc.statement)
              : h('div', { className: 'sv-vd-sc-stmt' }, `Sub-claim ${scv.subClaimIndex}`),
          ),
        );
        listEl.appendChild(row);
      });
      inner.appendChild(section(`Sub-claim Verdicts`, [listEl]));
    } else if (bundleData.subClaims.length) {
      const listEl = h('div', { className: 'sv-vd-subclaims' });
      bundleData.subClaims.forEach(sc => {
        listEl.appendChild(h('div', { className: 'sv-vd-sc' },
          h('span', { className: 'sv-vd-sc-icon' },
            h('span', { className: 'sv-vd-ev-kind' }, sc.claimType),
          ),
          h('div', { className: 'sv-vd-sc-body' },
            h('div', { className: 'sv-vd-sc-stmt' }, sc.statement),
            h('div', { className: 'sv-vd-emitted' }, `Testability: ${(sc.testabilityScore * 100).toFixed(0)}%`),
          ),
        ));
      });
      inner.appendChild(section('Sub-claims', [listEl]));
    }

    // Strengths + weaknesses
    if (sj?.strengthsOfEvidence?.length || sj?.weaknessesOfEvidence?.length) {
      const swGrid = h('div', { className: 'sv-vd-sw-grid' });

      if (sj.strengthsOfEvidence?.length) {
        const list = h('ul', { className: 'sv-vd-sw-list' });
        sj.strengthsOfEvidence.forEach(s => {
          list.appendChild(h('li', { className: 'sv-vd-sw-item' },
            h('span', { className: 'sv-vd-s-dot' }, '·'),
            h('span', null, s),
          ));
        });
        swGrid.appendChild(h('div', { className: 'sv-vd-strengths' },
          h('div', { className: 'sv-vd-sw-title sv-vd-s-title' }, '✅ Evidence Strengths'),
          list,
        ));
      } else {
        swGrid.appendChild(h('div', null));
      }

      if (sj.weaknessesOfEvidence?.length) {
        const list = h('ul', { className: 'sv-vd-sw-list' });
        sj.weaknessesOfEvidence.forEach(w => {
          list.appendChild(h('li', { className: 'sv-vd-sw-item' },
            h('span', { className: 'sv-vd-w-dot' }, '·'),
            h('span', null, w),
          ));
        });
        swGrid.appendChild(h('div', { className: 'sv-vd-weaknesses' },
          h('div', { className: 'sv-vd-sw-title sv-vd-w-title' }, '⚠️ Evidence Weaknesses'),
          list,
        ));
      } else {
        swGrid.appendChild(h('div', null));
      }

      inner.appendChild(swGrid);
    }

    // Recommended next steps
    if (sj?.recommendedNextSteps?.length) {
      const ol = h('ol', { className: 'sv-vd-steps' });
      sj.recommendedNextSteps.forEach((step, i) => {
        ol.appendChild(h('li', { className: 'sv-vd-step' },
          h('span', { className: 'sv-vd-step-num' }, String(i + 1)),
          h('span', null, step),
        ));
      });
      inner.appendChild(section('Recommended Next Steps', [ol]));
    }

    // Evidence events
    if (bundleData.evidenceEvents.length) {
      const maxShown = 12;
      const shown = bundleData.evidenceEvents.slice(0, maxShown);
      const extra = bundleData.evidenceEvents.length - shown.length;
      const list  = h('div', { className: 'sv-vd-evlist' });

      shown.forEach(ev => {
        const key   = agentKey(ev.agentId);
        const emoji = AGENT_EMOJI[key] ?? '🤖';
        list.appendChild(h('div', { className: 'sv-vd-ev' },
          h('span', { className: 'sv-vd-ev-icon' }, emoji),
          h('div', { className: 'sv-vd-ev-body' },
            h('div', { className: 'sv-vd-ev-meta' },
              h('span', { className: 'sv-vd-ev-agent' }, key),
              h('span', { className: 'sv-vd-ev-kind' }, ev.kind),
              ev.toolKey ? h('span', { className: 'sv-vd-ev-tool' }, ev.toolKey) : null,
            ),
            h('div', { className: 'sv-vd-ev-text' }, ev.summary),
          ),
        ));
      });
      if (extra > 0) {
        list.appendChild(h('div', { className: 'sv-vd-extra' }, `… and ${extra} more events`));
      }
      inner.appendChild(section(`Evidence Events (${bundleData.evidenceEvents.length})`, [list]));
    }

    // Actions
    const actions = h('div', { className: 'sv-vd-actions' });
    if (bundleData.verdict.id) {
      const dl = document.createElement('a');
      dl.href     = `/api/sv/verdicts/${bundleData.verdict.id}/bundle`;
      dl.download = `verdict-${bundleData.verdict.id}.json`;
      dl.className = 'nav-btn sv-vd-dl-link';
      dl.textContent = '⬇ Download Evidence Bundle';
      actions.appendChild(dl);
    }
    actions.appendChild(h('button', {
      className: 'nav-btn',
      onClick: () => {
        if (!bundleData) return;
        const text = [
          `Hypothesis: ${bundleData.hypothesis.title}`,
          `Statement: ${bundleData.hypothesis.statement}`,
          `Verdict: ${cfg.label}`,
          `Confidence: ${Math.round(v.confidenceLo * 100)}–${Math.round(v.confidenceHi * 100)}%`,
          gradeQ ? `GRADE Quality: ${gradeQ}` : '',
          sj?.summary ? `Summary: ${sj.summary}` : '',
        ].filter(Boolean).join('\n');
        void navigator.clipboard?.writeText(text);
      },
    }, '📋 Copy Summary'));
    inner.appendChild(actions);

    container.appendChild(inner);
  }

  // ── Load bundle ────────────────────────────────────────────────────────────
  async function loadBundle() {
    if (!hypothesisId) { loadError = 'No hypothesis selected.'; renderContent(); return; }
    try {
      const hRes = await api.get(`/api/sv/hypotheses/${hypothesisId}`);
      if (!hRes.ok) { loadError = `HTTP ${hRes.status}`; renderContent(); return; }
      const hData = await hRes.json() as {
        hypothesis: { title: string; statement: string; domainTags?: string[]; traceId?: string };
        verdict: VerdictShape | null;
      };
      if (!hData.verdict) { loadError = 'No verdict available yet.'; renderContent(); return; }

      const bRes = await api.get(`/api/sv/verdicts/${hData.verdict.id}/bundle`);
      if (bRes.ok) {
        const b = await bRes.json() as BundleData;
        bundleData    = b;
        supervisorJson = b.supervisorJson ?? null;
      } else {
        bundleData = { hypothesis: hData.hypothesis, verdict: hData.verdict, subClaims: [], evidenceEvents: [] };
      }

      if (!supervisorJson && bundleData.verdict.limitations) {
        try {
          const parsed = JSON.parse(bundleData.verdict.limitations) as SupervisorJson;
          if (parsed.verdict) supervisorJson = parsed;
        } catch { /* plain text */ }
      }

      loading = false;
    } catch (err: unknown) {
      loadError = err instanceof Error ? err.message : 'Network error';
    }
    renderContent();
  }

  // ── Kick off ───────────────────────────────────────────────────────────────
  const cachedVerdict = (state as any).svVerdict as VerdictShape | null;
  if (cachedVerdict && hypothesisId) {
    loading    = false;
    bundleData = { hypothesis: { title: '', statement: '' }, verdict: cachedVerdict, subClaims: [], evidenceEvents: [] };
    renderContent();
  }
  void loadBundle();

  return container;
}
