// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 2 — the WORKSPACE GOVERNANCE card (read-only).
 *
 * --- For someone new to this ---
 * This is the "is my workspace set up for enterprise?" panel. It shows the trust checklist for your
 * workspace — where your data lives, whether it is encrypted with your own key, whether your content
 * is ever used to train AI, whether sign-on is enforced, how long activity is kept, and so on — each
 * marked on or off. It is READ-ONLY here; an administrator sets these in the Builder.
 *
 * A self-contained DOM card (no framework). It just fetches the posture and renders the checklist.
 */
import { h } from './dom.js';
import { api } from './api.js';

interface PostureItem { key: string; label: string; status: 'on' | 'off' | 'na'; detail: string }

/** Render the workspace governance checklist card. */
export function renderGovernanceCard(): HTMLElement {
  const root = h('div', { className: 'gw-gov' }) as HTMLElement;
  root.appendChild(h('div', { className: 'gw-gov-loading' }, 'Loading workspace governance…'));

  void (async () => {
    let posture: PostureItem[] = []; let on = 0; let total = 0;
    try {
      const res = await api.get('/api/me/governance');
      const data = await res.json().catch(() => ({})) as { posture?: PostureItem[]; score?: { on: number; total: number } };
      posture = data.posture ?? [];
      on = data.score?.on ?? 0; total = data.score?.total ?? posture.length;
    } catch { /* show empty */ }

    root.innerHTML = '';
    root.appendChild(h('div', { className: 'gw-gov-head' },
      h('span', { className: 'gw-gov-title' }, '🛡️ Workspace governance'),
      h('span', { className: 'gw-gov-score' }, `${on}/${total} enterprise controls on`),
    ));
    if (posture.length === 0) { root.appendChild(h('div', { className: 'gw-gov-empty' }, 'Governance posture is unavailable.')); return; }
    const list = h('ul', { className: 'gw-gov-list' });
    for (const item of posture) {
      const badge = item.status === 'on' ? '✓' : item.status === 'off' ? '–' : '·';
      list.appendChild(h('li', { className: `gw-gov-item gw-gov-${item.status}` },
        h('span', { className: 'gw-gov-badge' }, badge),
        h('span', { className: 'gw-gov-label' }, item.label),
        h('span', { className: 'gw-gov-detail' }, item.detail),
      ));
    }
    root.appendChild(list);
    root.appendChild(h('p', { className: 'gw-gov-foot' }, 'Read-only. An administrator configures these in the Builder (Governance → Tenant Governance).'));
  })();

  return root;
}
