/**
 * Hypothesis Validation — Live Deliberation View (v3)
 * Uses only CSS classes (no inline styles) — required by CSP hash on <style>.
 */
import { h } from '../../../ui/dom.js';
import { api } from '../../../ui/api.js';
import { state } from '../../../ui/state.js';
import { ensureSVStyles } from '../sv-css.js';

interface EvidenceEvent {
  evidenceId: string;
  stepId: string;
  agentId: string;
  kind: string;
  summary: string;
  sourceType?: string;
  toolKey?: string;
}

interface DialogueTurn {
  roundIndex: number;
  fromAgent: string;
  toAgent?: string;
  message: string;
  dissent?: boolean;
}

interface VerdictEvent {
  verdictId: string;
  verdict: string;
  confidenceLo: number;
  confidenceHi: number;
}

const AGENT_META: Record<string, { emoji: string; name: string; role: string }> = {
  decomposer:   { emoji: '🧩', name: 'Dylan',     role: 'Decomposer'   },
  literature:   { emoji: '📚', name: 'Larry',     role: 'Literature'   },
  statistical:  { emoji: '📊', name: 'Stella',    role: 'Statistical'  },
  mathematical: { emoji: '∑',  name: 'Max',       role: 'Mathematical' },
  simulation:   { emoji: '🔬', name: 'Sima',      role: 'Simulation'   },
  adversarial:  { emoji: '⚔️', name: 'Ada',       role: 'Adversarial'  },
  supervisor:   { emoji: '🧠', name: 'geneWeave', role: 'Supervisor'   },
};

const KNOWN_AGENTS = Object.keys(AGENT_META);
const KNOWN_KINDS  = ['tool-call','tool-error','model-inference','supports','refutes','neutral','inconclusive'];

function agentKey(id: string): string {
  return id.replace(/^sv-/, '').replace(/-/g, '_');
}

function agentMeta(id: string) {
  return AGENT_META[agentKey(id)] ?? { emoji: '🤖', name: id, role: id };
}

function agentColorKey(id: string): string {
  const k = agentKey(id);
  return KNOWN_AGENTS.includes(k) ? k : 'unknown';
}

function kindClass(kind: string): string {
  const k = kind.replace(/_/g, '-');
  return `sv-kp sv-kp-${KNOWN_KINDS.includes(k) ? k : 'default'}`;
}

export function renderSVLiveView(options: { render: () => void }): HTMLElement {
  ensureSVStyles();
  const { render } = options;
  const hypothesisId = (state as any).svHypothesisId as string | null;
  const cachedHyp = (state as any).svHypothesis as {
    title?: string; statement?: string; domainTags?: string[];
  } | null;

  if (!hypothesisId) {
    return h('div', { className: 'dash-view' },
      h('div', { className: 'sv-live-pg' },
        h('p', { className: 'sv-live-empty-text' }, 'No hypothesis selected.'),
        h('button', {
          className: 'nav-btn',
          onClick: () => { (state as any).svView = 'submit'; render(); },
        }, '← Back to Submit'),
      )
    );
  }

  // ── Mutable state ──────────────────────────────────────────────────────────
  let statusPoll: ReturnType<typeof setInterval> | null = null;
  let evidenceES: EventSource | null = null;
  let dialogueES: EventSource | null = null;
  let startTime = Date.now();
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let hypothesisData: { title: string; statement: string; domainTags: string[]; status: string } | null = null;
  let eventCount = 0;
  let turnCount  = 0;

  // ── DOM nodes ──────────────────────────────────────────────────────────────
  const statusEl  = h('span', { className: 'sv-live-status'  }, 'Connecting…');
  const elapsedEl = h('span', { className: 'sv-live-elapsed' }, '0:00');
  const pillsEl   = h('div',  { className: 'sv-live-pills'   });
  const evCountEl = h('span', { className: 'sv-live-panel-count' }, '');
  const tuCountEl = h('span', { className: 'sv-live-panel-count' }, '');
  const eventsEl  = h('div',  { className: 'sv-live-panel-body' });
  const turnsEl   = h('div',  { className: 'sv-live-panel-body' });

  const hypTitleEl = h('div', { className: 'sv-live-hyp-title' }, cachedHyp?.title ?? 'Loading…');
  const hypStmtEl  = h('div', { className: 'sv-live-hyp-stmt'  }, cachedHyp?.statement ?? '');
  const hypTagsEl  = h('div', { className: 'sv-live-hyp-tags'  });

  // ── Agent pills ────────────────────────────────────────────────────────────
  const pillMap = new Map<string, HTMLElement>();

  function buildAgentPills() {
    while (pillsEl.firstChild) pillsEl.removeChild(pillsEl.firstChild);
    pillMap.clear();
    Object.entries(AGENT_META).forEach(([key, meta]) => {
      const dot  = h('span', { className: 'sv-live-pill-dot sv-hidden' });
      const pill = h('div',  { className: 'sv-live-pill' },
        h('span', { className: 'sv-live-pill-emoji' }, meta.emoji),
        h('span', { className: 'sv-live-pill-name'  }, meta.name),
        dot,
      );
      pillMap.set(key, pill);
      pillsEl.appendChild(pill);
    });
  }
  buildAgentPills();

  function activatePill(key: string) {
    const pill = pillMap.get(key);
    if (!pill) return;
    pill.classList.add('sv-active');
    pill.querySelector('.sv-live-pill-dot')?.classList.remove('sv-hidden');
  }

  // ── Timer ──────────────────────────────────────────────────────────────────
  function startTimer() {
    startTime = Date.now();
    timerHandle = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      elapsedEl.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }, 1000);
  }

  // ── Evidence event rendering ───────────────────────────────────────────────
  function appendEvidence(ev: EvidenceEvent) {
    const meta = agentMeta(ev.agentId);
    const ac   = agentColorKey(ev.agentId);
    activatePill(agentKey(ev.agentId));
    eventCount++;
    evCountEl.textContent = `(${eventCount})`;

    const empty = eventsEl.querySelector('.sv-live-empty');
    if (empty) eventsEl.removeChild(empty);

    eventsEl.appendChild(h('div', { className: 'sv-live-ev' },
      h('div', { className: `sv-live-ev-av sv-bg-${ac}` }, meta.emoji),
      h('div', { className: 'sv-live-ev-body' },
        h('div', { className: 'sv-live-ev-meta' },
          h('span', { className: `sv-live-ev-name sv-color-${ac}` }, meta.name),
          h('span', { className: 'sv-live-ev-role' }, meta.role),
          h('span', { className: kindClass(ev.kind) }, ev.kind.replace(/_/g, ' ')),
          ev.toolKey ? h('span', { className: 'sv-live-ev-tool' }, ev.toolKey) : h('span', null, ''),
        ),
        h('div', { className: 'sv-live-ev-text' }, ev.summary),
      ),
    ));
    eventsEl.scrollTop = eventsEl.scrollHeight;
  }

  // ── Dialogue turn rendering ────────────────────────────────────────────────
  function appendTurn(turn: DialogueTurn) {
    const meta = agentMeta(turn.fromAgent);
    const ac   = agentColorKey(turn.fromAgent);
    activatePill(agentKey(turn.fromAgent));
    turnCount++;
    tuCountEl.textContent = `(${turnCount})`;

    const empty = turnsEl.querySelector('.sv-live-empty');
    if (empty) turnsEl.removeChild(empty);

    const msg = turn.message.length > 400 ? turn.message.slice(0, 400) + '…' : turn.message;
    turnsEl.appendChild(h('div', { className: `sv-live-turn${turn.dissent ? ' sv-dissent' : ''}` },
      h('div', { className: `sv-live-turn-av sv-bg-${ac}` }, meta.emoji),
      h('div', { className: 'sv-live-turn-body' },
        h('div', { className: 'sv-live-turn-meta' },
          h('span', { className: `sv-live-turn-name sv-color-${ac}` }, meta.name),
          turn.toAgent
            ? h('span', { className: 'sv-live-turn-to' }, `→ ${agentMeta(turn.toAgent).name}`)
            : h('span', null, ''),
          h('span', { className: 'sv-live-turn-round' }, `Round ${turn.roundIndex}`),
          turn.dissent ? h('span', { className: 'sv-live-turn-dissent' }, 'DISSENT') : h('span', null, ''),
        ),
        h('div', { className: 'sv-live-turn-msg' }, msg),
      ),
    ));
    turnsEl.scrollTop = turnsEl.scrollHeight;
  }

  // ── Empty states ───────────────────────────────────────────────────────────
  function makeEmpty(text: string): HTMLElement {
    return h('div', { className: 'sv-live-empty' },
      h('div', { className: 'sv-live-spinner' }),
      h('div', { className: 'sv-live-empty-text' }, text),
    );
  }
  eventsEl.appendChild(makeEmpty('Waiting for evidence…'));
  turnsEl.appendChild(makeEmpty('Waiting for agent dialogue…'));

  // ── SSE streams ────────────────────────────────────────────────────────────
  function startStreams() {
    evidenceES = new EventSource(`/api/sv/hypotheses/${hypothesisId}/events`, { withCredentials: true });
    evidenceES.addEventListener('evidence', (e: MessageEvent) => {
      appendEvidence(JSON.parse(e.data) as EvidenceEvent);
    });
    evidenceES.onerror = () => { statusEl.textContent = 'Evidence stream closed'; };

    dialogueES = new EventSource(`/api/sv/hypotheses/${hypothesisId}/dialogue`, { withCredentials: true });
    dialogueES.addEventListener('turn', (e: MessageEvent) => {
      appendTurn(JSON.parse(e.data) as DialogueTurn);
    });
    dialogueES.addEventListener('verdict', (e: MessageEvent) => {
      const v = JSON.parse(e.data) as VerdictEvent;
      (state as any).svVerdict = v;
      (state as any).svView = 'verdict';
      cleanup();
      render();
    });
    dialogueES.onerror = () => { statusEl.textContent = 'Dialogue stream closed'; };
  }

  function cleanup() {
    if (statusPoll)  clearInterval(statusPoll);
    if (timerHandle) clearInterval(timerHandle);
    if (evidenceES)  { evidenceES.close();  evidenceES = null; }
    if (dialogueES)  { dialogueES.close(); dialogueES = null; }
  }

  // ── Status polling ─────────────────────────────────────────────────────────
  async function pollStatus() {
    try {
      const r = await api.get(`/api/sv/hypotheses/${hypothesisId}`);
      if (!r.ok) return;
      const data = await r.json() as {
        hypothesis: { title: string; statement: string; domainTags: string[]; status: string };
        verdict: { id?: string } | null;
      };
      const hyp = data.hypothesis;

      if (!hypothesisData) {
        hypothesisData = hyp;
        hypTitleEl.textContent = hyp.title;
        hypStmtEl.textContent  = hyp.statement;
        while (hypTagsEl.firstChild) hypTagsEl.removeChild(hypTagsEl.firstChild);
        (hyp.domainTags ?? []).forEach(tag => {
          hypTagsEl.appendChild(h('span', { className: 'sv-live-tag' }, tag));
        });
      }

      const labels: Record<string, string> = {
        queued:    'Queued — waiting for agent pool…',
        running:   'Deliberating…',
        verdict:   'Verdict ready',
        abandoned: 'Abandoned',
      };
      statusEl.textContent = labels[hyp.status] ?? hyp.status;

      if (hyp.status === 'verdict' || hyp.status === 'abandoned') {
        (state as any).svHypothesis = hyp;
        if (data.verdict) (state as any).svVerdict = data.verdict;
        (state as any).svView = hyp.status === 'verdict' ? 'verdict' : 'submit';
        if (hyp.status !== 'verdict') (state as any).svHypothesisId = null;
        cleanup();
        render();
      }
    } catch { /* ignore */ }
  }

  // ── Kick off ───────────────────────────────────────────────────────────────
  setTimeout(() => {
    startStreams();
    startTimer();
    statusPoll = setInterval(() => { void pollStatus(); }, 4_000);
    void pollStatus();
  }, 100);

  // ── Layout ─────────────────────────────────────────────────────────────────
  const view = h('div', { className: 'dash-view' },
    h('div', { className: 'sv-live-pg' },

      h('div', { className: 'sv-live-header' },
        h('div', { className: 'sv-live-icon' }, '🔬'),
        h('div', { className: 'sv-live-hyp' },
          hypTitleEl,
          hypStmtEl,
          hypTagsEl,
        ),
        h('div', { className: 'sv-live-ctrl' },
          h('div', { className: 'sv-live-meta' },
            statusEl,
            h('span', { className: 'sv-live-sep' }, '·'),
            elapsedEl,
          ),
          h('div', { className: 'sv-live-btns' },
            h('button', {
              className: 'sv-live-cancel-btn',
              onClick: async () => {
                try { await api.post(`/api/sv/hypotheses/${hypothesisId}/cancel`, {}); } catch { /* ignore */ }
                (state as any).svView = 'submit';
                (state as any).svHypothesisId = null;
                cleanup();
                render();
              },
            }, 'Cancel'),
            h('button', {
              className: 'sv-live-back-btn',
              onClick: () => {
                (state as any).svView = 'submit';
                (state as any).svHypothesisId = null;
                cleanup();
                render();
              },
            }, '← Back'),
          ),
        ),
      ),

      h('div', { className: 'sv-live-agents' },
        h('div', { className: 'sv-live-agents-title' }, 'Agent Activity'),
        pillsEl,
      ),

      h('div', { className: 'sv-live-cols' },
        h('div', { className: 'sv-live-panel' },
          h('div', { className: 'sv-live-panel-head' },
            h('span', { className: 'sv-live-panel-label' }, 'Evidence'),
            evCountEl,
          ),
          eventsEl,
        ),
        h('div', { className: 'sv-live-panel' },
          h('div', { className: 'sv-live-panel-head' },
            h('span', { className: 'sv-live-panel-label' }, 'Agent Dialogue'),
            tuCountEl,
          ),
          turnsEl,
        ),
      ),
    ),
  );

  const obs = new MutationObserver(() => {
    if (!document.body.contains(view)) { cleanup(); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  return view;
}
