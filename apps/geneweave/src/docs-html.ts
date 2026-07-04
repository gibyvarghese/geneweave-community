/**
 * geneWeave — Developer Documentation HTML
 * Served at GET /docs. Full geneWeave branding, independent scroll, hierarchical nav.
 */
// no-raw-fetch: allow (reason: fetch occurrences are inside HTML/JS code
// samples shown in the documentation, never executed by the server)

// ── Build-time helpers ────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let _codeIdx = 0;
function code(lang: string, src: string, deps?: string[]): string {
  const id = `cb${++_codeIdx}`;
  const depsAttr = deps ? ` data-deps="${deps.join(',')}"` : '';
  return `<div class="cb" id="${id}"${depsAttr}><div class="cb-hdr"><span class="cb-lang">${lang}</span><div class="cb-actions"><button class="copy-btn" onclick="copyCode(this)">Copy</button><button class="run-btn" onclick="showRun('${id}')">▶ Run</button></div></div><pre><code class="language-${lang}">${esc(src.trim())}</code></pre></div>`;
}

function callout(type: 'info' | 'tip' | 'warn' | 'danger', icon: string, title: string, body: string): string {
  return `<div class="callout callout-${type}"><span class="callout-icon">${icon}</span><div><strong>${title}</strong> ${body}</div></div>`;
}

function params(rows: [string, string, string, string][]): string {
  const trs = rows.map(([n, t, r, d]) =>
    `<tr><td class="pname"><code>${n}</code></td><td class="ptype"><code>${t}</code></td><td>${r === 'required' ? '<span class="req">required</span>' : '<span class="opt">optional</span>'}</td><td class="pdesc">${d}</td></tr>`
  ).join('');
  return `<div class="tbl-wrap"><table class="ptable"><thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${trs}</tbody></table></div>`;
}

function returns(rows: [string, string][]): string {
  const trs = rows.map(([f, d]) => `<tr><td><code>${f}</code></td><td>${d}</td></tr>`).join('');
  return `<div class="tbl-wrap"><table class="ptable"><thead><tr><th>Field</th><th>Description</th></tr></thead><tbody>${trs}</tbody></table></div>`;
}

function exlinks(links: [string, string][]): string {
  const items = links.map(([file, title]) =>
    `<a class="ex-link" href="https://github.com/weaveintel/weaveintel/blob/main/examples/${file}" target="_blank" rel="noopener">
      <span class="ex-icon">&#128196;</span>
      <span class="ex-title">${title}</span>
      <span class="ex-ext">&#8599;</span>
    </a>`
  ).join('');
  return `<div class="ex-links"><div class="ex-links-label">Related Examples</div><div class="ex-links-list">${items}</div></div>`;
}

function section(id: string, title: string, body: string): string {
  return `<section id="${id}" class="doc-section"><h2 class="sec-title"><span class="sec-anchor">#</span>${title}</h2>${body}</section>`;
}

function subsection(id: string, title: string, body: string): string {
  return `<div id="${id}" class="doc-subsection"><h3 class="subsec-title">${title}</h3>${body}</div>`;
}

function featureCards(cards: [string, string][]): string {
  const items = cards.map(([t, d]) => `<div class="fcard"><div class="fcard-title">${t}</div><div class="fcard-desc">${d}</div></div>`).join('');
  return `<div class="fcard-grid">${items}</div>`;
}

function typeTable(rows: [string, string][]): string {
  const trs = rows.map(([t, d]) => `<tr><td><code>${t}</code></td><td>${d}</td></tr>`).join('');
  return `<div class="tbl-wrap"><table class="ptable"><thead><tr><th>Value</th><th>Description</th></tr></thead><tbody>${trs}</tbody></table></div>`;
}

// ── Section: Home ─────────────────────────────────────────────────────────

function sHome(): string {
  const pkgs = [
    // Agent Layer
    ['agents',       '🤖', 'Agents',          'ReAct tool-calling loops, supervisor mode, worker delegation'],
    ['workflows',    '⚙️', 'Workflows',        'Durable multi-step orchestration with checkpointing and human gates'],
    ['a2a',          '🔄', 'A2A Protocol',     'Agent-to-Agent typed messaging — in-process bus or HTTP transport'],
    ['live-agents',  '⚡', 'Live Agents',      'Long-running agents in meshes: per-tick execution, backlog, state persistence'],
    // Agent Layer (continued)
    ['skills',       '🎯', 'Skills',           'Named capability bundles — instructions + tools + model in one unit'],
    // Model Layer
    ['routing',      '🔀', 'Model Routing',    'Capability-based selection with health tracking and cost-aware failover'],
    ['providers',    '☁️', 'Providers',        'OpenAI, Anthropic, Google, Ollama, llama.cpp — same Model interface'],
    ['models',       '🧠', 'Models',           'Named model registry, smart capability-based routing, cost tracking'],
    ['prompts',      '💬', 'Prompts',          'Versioned prompts, output contracts, A/B experiments, evaluation'],
    ['cost-governor','💰', 'Cost Governor',    '8-lever cost optimisation with tier policies and model cascade'],
    // Memory & Knowledge
    ['memory',       '🧩', 'Memory',           'Semantic, entity, conversation and working memory with vector search'],
    ['retrieval',    '🔍', 'Retrieval',        'Chunking, embedding pipelines, hybrid RAG + BM25, query rewriting'],
    ['extraction',   '🔬', 'Extraction',       'Schema-driven LLM extraction from unstructured text, batch-capable'],
    // Tools
    ['oauth',         '🔑', 'OAuth',            'Per-user OAuth 2.0 with PKCE, durable flow state, and auto token refresh'],
    ['tools',         '🔧', 'Tool Framework',   'Risk classification, policy enforcement, approval gates, audit, health tracking'],
    ['tools-time',    '🕐', 'tools-time',       '16 time-aware tools: datetime, timers, stopwatches, reminders'],
    ['tools-browser', '🌐', 'Browser Tools',    'Web fetch, content extraction, scraping, Playwright automation'],
    ['tools-search',  '🔎', 'Search Tools',     'Multi-provider search with auto-failover (9 providers)'],
    ['sandbox',       '📦', 'Sandbox',          'Safe execution of LLM-generated code with resource limits'],
    ['mcp',           '🔌', 'MCP',              'Model Context Protocol client and server — cross-system tool sharing'],
    ['triggers',      '⚡', 'Triggers',         'Event-driven workflow/agent invocation: cron, webhook, DB change'],
    // Quality & Safety
    ['guardrails',   '🛡️', 'Guardrails',       'Pre/post-execution risk, PII, confidence and cost gates'],
    ['evals',        '📊', 'Evals',            'Rubric-based LLM-as-judge evaluation, model comparison, CI gate'],
    ['redaction',    '✂️', 'Redaction',        'PII detection & redaction middleware — LLMs never see raw sensitive data'],
    ['resilience',   '♻️', 'Resilience',       'Token bucket, circuit breaker, retry and concurrency primitives'],
    ['observability','📈', 'Observability',    'Tracing, usage tracking, budget monitoring and span export'],
    // Security & Operations
    ['security',     '🔒', 'Security',         'SSRF protection, TLS floor, durable audit, PII redaction, DNS pinning'],
    ['tenancy',      '🏢', 'Tenancy',          'Multi-tenant context, per-tenant budgets and capability bindings'],
    ['compliance',   '📋', 'Compliance',       'Legal hold, consent, retention, GDPR deletion — all durable'],
    ['durability',   '💾', 'Durability',       'DLQ, idempotency keys, retry budgets, health checks, backpressure'],
    ['persistence',  '🗄️', 'Persistence',      '8-adapter KV + high-level stores; RuntimePersistenceSlot factories'],
    ['encryption',   '🔐', 'Encryption',       'AES-256-GCM field encryption, BYOK, blind indexes, key rotation'],
    // Evidence & Reproducibility
    ['contracts',    '📜', 'Contracts',         'Append-only evidence ledger — signed records of every agent decision'],
    ['artifacts',    '📎', 'Artifacts',         'Versioned file storage for agent outputs — charts, PDFs, code files'],
    ['replay',       '⏮️', 'Replay',            'Deterministic re-execution of workflow runs from saved snapshots'],
    ['trace-tools',  '🔭', 'Trace Tools',       'Agent-callable tools for inspecting live mesh state and contracts'],
    // Core
    ['core',         '⚛️', 'Core',             'Zero-dependency contract layer — every interface lives here'],
  ].map(([id, icon, name, desc]) =>
    `<div class="pkg-card" onclick="nav('${id}')"><div class="pkg-icon">${icon}</div><div class="pkg-name">${name}</div><div class="pkg-desc">${desc}</div></div>`
  ).join('');

  return `
<div class="hero">
  <div class="hero-icon">🧬</div>
  <h1 class="hero-title">WeaveIntel Developer Documentation</h1>
  <p class="hero-sub">A modular, production-grade TypeScript monorepo for building AI-powered applications. Every capability is a standalone package — use one or all.</p>
  <div class="hero-badges">
    <span class="badge badge-accent">TypeScript-native</span>
    <span class="badge badge-muted">Zero vendor lock-in</span>
    <span class="badge badge-muted">Dependency injection</span>
    <span class="badge badge-muted">Production-ready</span>
  </div>
</div>

${callout('info', '💡', 'Architecture principle.', 'Every interface lives in <code>@weaveintel/core</code>. No package imports a concrete implementation — swap any model, store, or transport without touching business logic.')}

<h2 class="sec-title"><span class="sec-anchor">#</span>Quick Start — First agent in 3 steps</h2>

<div class="qs-steps">
  <div class="qs-step"><div class="qs-num">1</div><div class="qs-label">Install</div></div>
  <div class="qs-step"><div class="qs-num">2</div><div class="qs-label">Configure</div></div>
  <div class="qs-step"><div class="qs-num">3</div><div class="qs-label">Run</div></div>
</div>

${code('bash', `npm install @weaveintel/agents @weaveintel/core @weaveintel/provider-anthropic`)}

${code('typescript', `// agent.ts
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveRuntime, weaveContext, weaveTool, weaveToolRegistry } from '@weaveintel/core';

// 1. One runtime — wires egress, secrets, audit, tracer
const runtime = weaveRuntime();

// 2. A simple tool
const tools = weaveToolRegistry();
tools.register(weaveTool({
  name: 'get_time',
  description: 'Return the current UTC time.',
  parameters: { type: 'object', properties: {} },
  execute: async () => new Date().toUTCString(),
}));

// 3. An agent
const agent = weaveAgent({
  model:        weaveAnthropicModel('claude-haiku-4-5-20251001'),
  tools,
  systemPrompt: 'You are a helpful assistant. Use tools when you need live data.',
  maxSteps:     4,
});

// 4. Run it
const ctx    = weaveContext({ runtime, userId: 'alice' });
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What time is it right now?' }],
});
console.log(result.output);`, ['@weaveintel/agents', '@weaveintel/core', '@weaveintel/provider-anthropic'])}

${code('bash', `ANTHROPIC_API_KEY=sk-ant-... npx tsx agent.ts`)}

${callout('tip', '🚀', 'Next steps.', 'Add persistence: <code>weaveRuntime({ persistence: weaveSqlitePersistence({ path: \'./data.db\' }) })</code> — DLQ, audit log, memory, and checkpoints all become durable at once. See <strong>Security</strong> for the full runtime options reference.')}

<h2 class="sec-title" style="margin-top:40px"><span class="sec-anchor">#</span>Packages</h2>
<div class="pkg-grid">${pkgs}</div>

<h2 class="sec-title" style="margin-top:40px"><span class="sec-anchor">#</span>Layer overview</h2>
${code('text', `Applications (geneweave, your app)
  └─ Agent Layer    @weaveintel/agents · @weaveintel/workflows · @weaveintel/live-agents
                    @weaveintel/a2a · @weaveintel/skills · @weaveintel/cost-governor
  └─ Capability     @weaveintel/prompts · @weaveintel/memory · @weaveintel/retrieval
                    @weaveintel/extraction · @weaveintel/memory · @weaveintel/collab
                    @weaveintel/testing/evals · @weaveintel/guardrails · @weaveintel/resilience
  └─ Integration    @weaveintel/providers · @weaveintel/mcp-client · @weaveintel/mcp-server
                    @weaveintel/tools-* · @weaveintel/sandbox · @weaveintel/identity/oauth
  └─ Platform       @weaveintel/security · @weaveintel/identity/tenancy · @weaveintel/guardrails/compliance
                    @weaveintel/encryption · @weaveintel/resilience · @weaveintel/persistence
  └─ Contracts      @weaveintel/core  (zero runtime dependencies)`)}
${callout('info', '🔌', 'Where "run plumbing" lives.', 'A <strong>run registry</strong> (what runs exist + their status) and a <strong>run journal</strong> (the numbered, append-only log of everything a run did, so a dropped connection can resume from "event 41") are now single <em>interfaces</em> in <code>@weaveintel/core</code>. geneWeave stores them in SQL; a key-value adapter ships in core — same interface, swappable storage, no duplicate code. The one Server-Sent-Events stream parser lives there too. New to this? Think of an interface as a power socket: anything that fits the socket (SQL, key-value) works, and nothing that plugs in needs to know what is behind the wall.')}
${callout('tip', '👀', 'Presence — "who else is watching this run".', 'Open a run and other viewers (and the AI agent itself!) show up live, like the avatars in a shared document. The browser of each viewer sends a tiny "still here" ping (a <strong>heartbeat</strong>) every ~15 seconds; if the pings stop for ~30 seconds, that viewer is removed. The current list is broadcast to everyone over the same live stream as a <code>presence.update</code> event and lands in the client as <code>vm.presence</code>. It is stored in a small <code>run_presence</code> table that only ever holds "who is here right now" — it is deliberately kept OUT of the permanent run log (presence is throw-away, not history). The running agent appears as a peer with a "working" status while it produces output. Your identity always comes from your login, never from the browser, so nobody can pretend to be someone else.')}
${callout('tip', '🔗', 'Sharing a run — invite links + roles.', 'Exactly like sharing a Google Doc, but for a live AI run. The owner clicks "share", picks a level, and sends a link. Whoever opens it gets <em>only</em> that level: a <strong>viewer</strong> can watch the run live (and appears in presence) but cannot touch it; a <strong>collaborator</strong> can also send input; only the <strong>owner</strong> can cancel the run or share it further. Every request is checked on the SERVER against your role — the app never trusts what your browser claims you are allowed to do. The invite link is a long random code; only a one-way fingerprint (hash) of it is stored, so even someone reading the database cannot reconstruct the link. Links can expire or be revoked, and a share link can never cross between organisations (tenants). New to this? An "access role" is just a label (viewer / collaborator / owner) that decides what each person is allowed to do — checked every single time, on the server, so it cannot be faked.')}
${callout('warn', '🛡️', 'Removing someone really disconnects them (CVE-2026-53843).', 'A live stream is permission-checked when it opens — but a run can stream for a long time. So when an owner removes a member (or ends sharing), geneWeave does not wait for that person to reload the page: it <strong>immediately closes the live stream they hold</strong> with an "access revoked" signal, and it also re-checks access on every heartbeat as a backstop. The result: a removed viewer can neither act on the run nor keep watching it. New to this? Think of it like changing the locks the moment someone hands back their key — not the next time they happen to try the door.')}
${callout('tip', '🔔', 'Get notified when a run finishes, even after you close the tab.', 'Click "Notify me" on a long run, then walk away. When it finishes you get a notification in your bell inbox (and, if you set them up, a webhook or push) — no need to sit and watch. The important part is that this is <strong>crash-proof</strong>: the moment a run ends, the system writes a durable "to deliver" record in the database for each subscriber, and a background worker delivers it and only then ticks it off. If the server restarts halfway through, the record is still there and delivery simply resumes — so a notification you are owed is never silently lost. You can never get the SAME notification twice (each one carries a stable fingerprint). Outgoing webhooks are cryptographically signed (so the receiver can prove it really came from us) and may only point at public internet addresses, never at internal machines. New to this? A "webhook" is just an automated message from one app to another that says "this thing finished", sent to a web address you registered.')}
${callout('tip', '💬', 'Comment on a run, like Google Docs.', 'Open a finished run and leave a sticky note pinned to ONE step — "this tool call used the wrong argument". Replies form a thread you can mark resolved; you can @mention a teammate (they get a notification); and you can leave a SCORE (a thumbs-up, or "4 out of 5") that turns into evaluation data the system can learn from. A comment is pinned to a stable step id (not a character position), so if the run text shifts the note is flagged as "stale" rather than silently moving to the wrong place. The owner can also publish a <strong>read-only public link</strong>: it shows the output and the review with reviewer display names only — never any emails, the internal ids, the system prompt, or the raw tool inputs — and tells search engines not to index it. Everything you type is cleaned before display, so a comment can never smuggle in a script. New to this? "Annotating" just means attaching little judgements (a rating, a note) to specific parts of something, so people can review it together.')}
${callout('tip', '🤝', 'Hand a run off — to a teammate, a human expert, or another agent.', 'Sometimes whoever is holding a task wants someone else to take over: pass a live session to a colleague, or let an AI run that hits something uncertain ESCALATE to a human who steps in and then hands it back. geneWeave models this as one clear lifecycle — <strong>requested → accepted (or rejected, with a reason) → in progress → handed back → completed</strong> — and writes down EVERY step (who, when, why) in a tamper-evident log, so the whole exchange is auditable. The context that travels with a handoff is a short <strong>briefing</strong> (a summary, the open questions, the next step) — never the entire raw transcript, which would be slow and bury the important bits. When a human accepts, they are automatically given access to take over the session; a rejection must say why; a handoff that nobody picks up eventually times out so a run is never stuck waiting forever; and a chain of handoffs cannot loop endlessly. New to this? A "handoff" is just passing the baton in a relay — the task keeps going, a new runner takes it, and there is a clear record of the exchange.')}
${callout('tip', '📡', 'Live updates that survive a dropped connection.', 'A run streams its output to your browser as it happens. This makes that stream tough: every event is numbered, so if your connection blips the browser reconnects and the server replays ONLY what you missed (no gaps, no repeats) using the standard "Last-Event-ID" mechanism. The multiplayer signals (who is present, comments, handoffs) are sent in the standard AG-UI way — a one-time SNAPSHOT of the shared state, then tiny EDITS (a "JSON Patch", RFC 6902) as things change — so any AG-UI-compatible app can show them. There is also a separate two-way CONTROL channel (a WebSocket) the page uses to talk back: cancel the run, nudge it with a steer, or send a presence heartbeat. It is hardened: it checks the request really came from our own site (blocking cross-site hijacking), authenticates with a short-lived one-time ticket (never a cookie), and treats repeated commands as one (so a retry after a reconnect never cancels twice). When it reconnects it resends a fresh snapshot, so your control + presence survive switching tabs, not just reloading. New to this? "Server-Sent Events" is the server streaming text to your browser; a "WebSocket" is a two-way always-on line; "JSON Patch" is a small list of edits instead of resending everything.')}
${callout('tip', '✍️', 'Co-edit a document WITH the AI, like Google Docs.', 'A human and the AI agent can type into the SAME document at the same time and it never scrambles — the trick behind multiplayer editors like Google Docs and Figma, called a <strong>CRDT</strong>. Instead of "insert at position 5" (which drifts when two people edit at once), every character gets a permanent unique id and edits say "insert AFTER character X". With one fixed rule for ordering two characters that land in the same spot, every copy rebuilds the identical text — guaranteed, with no central lock. The AI is just another editor (a "peer") whose streamed writing merges with yours automatically. If your connection drops and you keep editing, your changes reconcile when you reconnect (the system sends only the edits each side is missing). You see little coloured <strong>cursors</strong> showing where everyone — including the AI — is working; those are deliberately kept separate and never saved. And because the convergence math assumes everyone plays fair, the SERVER checks every edit: it stamps each edit with WHO made it (so nobody can forge an edit as someone else), and caps how much you can send at once. New to this? A "CRDT" is just a clever data structure that lets many people change the same thing at once and always agree on the result, without a lock or a central referee.')}
${callout('info', '🔩', 'The co-editing engine is swappable — you are never locked into ours (a “port”, not a hard-wire).', 'The live co-editing you just read about is powered by our own small, no-dependencies engine — but it is deliberately NOT welded in. Everything that touches a shared document (the merging, the coloured cursors, the AI writing alongside you) talks to ONE tidy interface we call a <strong>port</strong>. Our engine is simply the appliance that ships in the box; a team that already runs a popular alternative like <strong>Yjs</strong> can write one small adapter with the same plug and swap the engine underneath — <em>without</em> changing the sharing, the cursors, or the AI co-author. To prove a swapped-in engine behaves identically, we ship a <strong>conformance test</strong> the new engine must pass (the exact same one our built-in engine passes). This is the open-core promise in miniature: the useful part is the socket, and the socket is yours. Adopters can read the full guide — with a worked Yjs adapter — in <code>@weaveintel/collab</code>’s <code>docs/adapters.md</code>. New to this? A “port” is like a wall socket: anything that fits the socket works, and the wiring in the wall never has to change when you swap the appliance.')}
${callout('info', '📝', 'Notes are getting a clean "doorway" — the first step toward AI co-edited notes.', 'The Notes feature is becoming an AI-native research workspace where humans and AI agents write together. The very first step (done now) is plumbing, not a visible feature: all note reading and writing now goes through ONE well-defined interface (a "repository") instead of the web routes poking the database directly. Why bother? Because that single doorway is what lets us, in the next steps, swap the storage for a real-time CRDT co-editing engine WITHOUT rewriting the app — and it lets us test the notes feature on its own. Behaviour is intentionally identical to before; this is a safe refactor proven by a shared test that both the in-memory version and the real database version must pass. New to this? A "repository" here just means the one place the code goes to load or save notes — like a single front desk instead of everyone wandering into the storage room.')}
${callout('tip', '🧱', 'Notes can now be co-edited block-by-block, like Notion.', 'A note is built from BLOCKS — a heading, a paragraph, a bullet, a to-do, a code block. weaveNotes This makes that whole structure safely co-editable by humans AND the AI at the same time, using the same conflict-free technology behind the live co-editing you saw earlier. The clever trick: instead of a complicated tree, the whole note is kept as one long line of tiny pieces, where some pieces are characters and some are little "a new block starts here" markers. Because it is just one line, the proven co-editing math works unchanged — splitting a paragraph is just inserting a marker, merging two is deleting one — and everyone always ends up with the identical note. On top of that, the AI can read a note as Markdown (the format AI models speak) and contribute new blocks just like a person typing. There is a new read-only endpoint that shows a note as blocks, as Markdown, or as clean HTML, and it always repairs the structure so the result is valid even after lots of simultaneous edits. New to this? A "block" is one chunk of a document (a heading, a list item, a code box); "Markdown" is plain text with light formatting like # for a heading and - for a bullet.')}
${callout('tip', '👥', 'Two people (and the AI) can now co-edit the SAME note live, with sharing and presence.', 'This made a note conflict-free; This turns that into real teamwork. You can <strong>Share</strong> a note with a link: whoever opens it joins as a co-editor (or a read-only viewer) and you both edit the same note at once, always ending up with the identical result — nobody overwrites anybody. A small badge shows how many people are editing right now (that is "presence"), and those live signals are never saved because they only ever mean "right this second". The server is the trusted referee in the middle: it checks every edit before sharing it — it stamps WHO made each edit so nobody can pretend to be someone else, it blocks viewers from editing, and it caps how much you can send so nobody can flood the note. If your connection drops, your edits reconcile when you return: the server sends back only the edits you missed, not the whole note. Behind the scenes your save is turned into the smallest set of changes and merged in, so the older single-user save still works too. New to this? "Sharing" here means handing someone a link that lets them into one specific note; "presence" is just the little live indicator of who else is here, like the faces you see at the top of a shared document.')}
${callout('tip', '🤖', 'The AI can now help write your notes — as suggestions you Accept or Reject.', 'This brings the AI right into the note. An <strong>AI toolbar</strong> lets you ask it to Continue your writing, Rewrite a passage, Summarize the page, or Answer a question about it. Crucially, the AI does NOT change your note straight away: its output appears as a <strong>suggestion</strong> — like "tracked changes" in a word processor — that you Accept (apply it) or Reject (throw it away). This is the safe, modern way to let an AI edit a document: it can never silently rewrite your words, which also protects you if a webpage or email tries to trick the AI into changing things ("prompt injection"). You can also drop in an <strong>AI block</strong>: a paragraph generated from a prompt that remembers the prompt, so you can Refresh it later to regenerate it with the latest information. And during a normal chat, the agent itself can <strong>create a brand-new note</strong> for you and fill it with whatever you asked about (a research summary, a plan, a checklist) — then co-write a note using a built-in note-editing tool, joining your note as just another editor so its writing merges with yours and never clobbers it. The same safety rules from before still apply: read-only viewers cannot trigger AI edits, and the AI can only touch notes you are allowed to edit. New to this? A "suggestion" is a proposed change shown to you before it is applied; "prompt injection" is when sneaky text tries to hijack an AI — staging every AI edit for your approval is how we stop that from quietly editing your notes.')}
${callout('tip', '📤', 'Turn a note into a shareable document with a public link — safely.', 'When a note is ready to share beyond your team, you can <strong>Publish</strong> it: weaveNotes turns the note into a self-contained document (an "artifact") and gives you a public, read-only link anyone can open — no account needed. Before anything is shared, a safety pass scans the content and <strong>redacts</strong> (blacks out) things you almost never mean to publish — passwords, API keys and tokens are always removed, and for notes you have marked <strong>confidential</strong>, personal details like email addresses and phone numbers are removed too. A note marked <strong>restricted</strong> simply cannot be published at all. The agent can publish on your behalf when you ask, but it always creates the document privately — it never makes a public link by itself, so a sneaky instruction hidden in some text can never quietly put your note on the open web; making it public is always a deliberate human click. Behind the scenes this reuses the same trusted document-sharing system the rest of the app uses, so published notes get the same versioning and share controls (optional password, expiry) as any other artifact. New to this? An "artifact" here is just a saved, shareable document; "redaction" means automatically hiding sensitive bits before others can see them, like the black bars on a released public record.')}
${callout('tip', '🕸️', 'Your notes now connect into a knowledge graph — backlinks, "related notes", and a map.', 'Notes are far more useful when they are connected, not just a pile of separate pages. This adds that web of connections. Write <strong>[[Another Note]]</strong> inside a note to LINK to it (like a hyperlink, but by title) — and the other note automatically gets a <strong>backlink</strong> ("which notes point at me?"). The app also spots <strong>unlinked mentions</strong>: places where you typed another note\'s title in plain text but did not link it yet, so you can connect them with one click. Separately, the AI reads each note and pulls out the people, organizations and concepts it is about (its <strong>entities</strong>) and how they relate, building a little <strong>knowledge graph</strong> you can see as a map. And because each note is turned into a list of numbers that captures its meaning (an "embedding"), the app can surface <strong>related notes</strong> — pages about similar topics — even when you never linked them. A new 🔗 Connections panel in the editor shows all of this: backlinks, unlinked mentions, related notes with a match score, and the graph. The agent can use the same semantic search to look through your notes when you ask it about something. New to this? A "backlink" is the reverse of a link (it shows who links to the current note); an "embedding" is a way of turning text into numbers so a computer can tell which notes are about similar things.')}
${callout('tip', '🗃️', 'Notes can now be organized as databases (tables) — with typed columns and AI that fills them in.', 'Sometimes a pile of pages is better viewed as a TABLE. This adds Notion-style <strong>databases</strong>: a set of rows with typed <strong>columns</strong> — text, a number, a date, a checkbox, a dropdown (with fixed choices), a link to another table — so your data has structure, not just prose. You can look at the same rows as a plain <strong>table</strong>, a <strong>gallery</strong> of cards, or a <strong>board</strong> grouped by a dropdown. A <strong>relation</strong> column connects rows across tables ("this Project has these Tasks"), and a <strong>rollup</strong> then summarises across that link ("what percent of the tasks are done?"). The headline feature is <strong>AI auto-fill</strong>: press ✨ on a column and the AI fills that column for every row — a summary, a category, or a looked-up fact — reading what each row already contains and, if you click 🌐, searching the web. It is now also <strong>relation-aware</strong>: when a row links to a row in another table, the AI reads that linked row too, so it can fill a person’s "work city" from their company’s headquarters, for example. And it is <strong>privacy-safe</strong>: before any web search, personal details in the row (emails, phone numbers, card/ID-like numbers) are <strong>scrubbed out of the search words</strong>, so a row’s private data never leaves to the search engine — and an admin can switch web search off for auto-fill entirely, or turn the scrubbing on/off, in weaveNotes Settings. Crucially, every value it fills comes with a small 🔖 <strong>citation</strong> showing where it got the answer (the row, a linked row, or a web page), so you can check it rather than trust it blindly. The agent can do the same when you ask ("fill the summary column of my table"). New to this? A "column type" just means what kind of data a column holds (a number behaves differently from text); a "rollup" is an automatic summary number computed from linked rows, like a total or a percentage; a "citation" is the source the AI used, shown so you can verify it.')}
${callout('tip', '✚', 'Capture anything into your notes — a chat answer, a web page, an email, a quick thought.', 'Good ideas arrive from everywhere, so This adds fast on-ramps to get them INTO your notes as tidy, structured pages instead of a scratchpad you lose track of. There are four ways to capture. <strong>From a chat run</strong>: turn an answer the AI just gave you into a saved note with one call, and the note even records a link back to the run it came from. <strong>From the web</strong>: paste a public link and the server fetches the page, pulls out just the readable article (dropping menus and ads), and saves it as a note — the agent can do this for you too when you ask it to save a page. <strong>From email</strong>: hand it a message (either the separate fields, or a whole raw email) and it becomes a note. <strong>A quick jot</strong>: type a one-line thought and it is appended to a running inbox note for the day, titled "Daily Jots" with the date, so every loose thought from a day gathers in one place to sort through later. Every capture lands with a small <strong>provenance</strong> header — a note of where it came from and when — like a citation, so future-you always knows the source. Two safety rules matter here. Clipping a web page is <strong>SSRF-guarded</strong>: only real public web addresses are allowed, and attempts to point it at internal or private addresses (your own machine, a company intranet, a cloud server secret-metadata address) are refused — this stops a sneaky link from tricking the server into fetching something it should not. And every capture is private to you and your tenant: nobody can capture a run that belongs to someone else, or read another person inbox of jots. New to this? "Capture" just means saving something for later; "provenance" is a little where-this-came-from label; "SSRF" is a trick where a link tries to make a server fetch internal addresses, which the guard blocks.')}
${callout('tip', '✦', 'Ask your whole workspace, roll back any note, comment, and mirror blocks.', 'This makes your notes ASKABLE, REVIEWABLE, and time-travelable — four features in one. <strong>Ask your workspace</strong> (RAG): instead of hunting through pages, ask a question like "what did we learn about Project Polaris?" and the system searches your OWN material — both your notes AND your past chat conversations — finds the most relevant passages, and hands them to the AI so it answers FROM your content, with numbered <strong>citations</strong> "[1] [2]" you can click back to the exact source. (The clever bit: it ranks your notes and your chats separately and then merges the two lists fairly, so a strong hit in either shows up — a standard technique called reciprocal rank fusion.) The agent can do this for you mid-chat with a workspace_search tool. <strong>Version history</strong>: a note keeps "save points" you can browse and RESTORE — and a restore is undoable, because it tucks your current draft into history first, so you can never lose work by rolling back. <strong>Comments</strong>: leave threaded notes on a specific paragraph (a "block"), reply, and mark a thread resolved — exactly like comments in a shared doc, and they stick to their paragraph even as the note is edited. <strong>Synced blocks</strong> (transclusion): show a paragraph from another note here, kept live — you are not copying it, you are pointing at it, so editing the original updates every place it appears. Everything stays private to you and your tenant: workspace search only ever sees your own notes and chats, and you can only comment on, version, or mirror notes you have access to. New to this? "RAG" means the AI looks things up in your stuff before answering instead of guessing; a "citation" is the clickable source behind a claim; "transclusion" is a fancy word for showing the same content live in two places at once.')}
${callout('tip', '🎨', 'The foundation for AI-co-edited notes: colour shows who did what, AI changes are suggestions you approve, and you can tune it all.', 'This lays the groundwork for notes you write TOGETHER with the assistant — and it is built so you always stay in charge. <strong>Colour encodes agency</strong>: anything YOU own is shown in calm neutral colours (and your own hand-drawn ink is coral); anything the ASSISTANT made wears a soft mint-green with a little woven badge and a byline. So you can glance at a page and instantly see "I wrote this / the assistant suggested that" — no guessing. <strong>Changes are suggestions, not silent edits</strong>: when the assistant rewrites a sentence or colours your text, it does not just change your page — it proposes the change like tracked-changes in a word processor, and you click ✓ to keep it or ✕ to throw it away. Several proposals can wait in line while you review. <strong>You can tune the behaviour</strong>: a new <strong>weaveNotes Settings</strong> page (in the Builder) lets an admin set the default look, whether the assistant must ask before changing your words, how long to keep a little history of what changed, and a spending cap per AI edit — all saved in the database, no code needed. And the assistant keeps a small <strong>activity log</strong> of what happened to a note (created, edited, AI-edited) so that before it acts, it can check "what just changed here?" and avoid undoing your recent work. New to this? "colour encodes agency" just means the colour tells you who did something; a "suggestion" is a proposed change shown to you before it is applied; the "activity log" is a short list of recent changes the assistant can read so it understands the note before editing it.')}
${callout('tip', '🖍️', 'Notes get colour, highlights, callouts, images and two looks — Pro and Creative (creative editor).', 'This makes a note a place you actually want to write. You can now <strong>colour your text</strong>, paint a phrase with a <strong>four-colour highlighter</strong> (amber, pink, teal, blue), drop in a <strong>callout</strong> box for a note/tip/warning, add an <strong>image</strong>, a collapsible <strong>toggle</strong>, a fun <strong>sticker</strong>, or a decorative <strong>washi divider</strong> — all from the same slash menu and the little toolbar that pops up when you select text. Every note also has two <strong>looks</strong> you flip between with one toggle: <strong>Pro</strong> is the clean office look (crisp white page, sharp title); <strong>Creative</strong> is the cosy notebook look (warm paper, a handwritten title, a felt-tip underline highlight, and a ✨ sticker tool). The look is remembered per note, and a brand-new note opens in whatever default an admin picked in weaveNotes Settings. The colours follow the same who-did-what rule from before: a callout the assistant wrote wears mint, your own stays calm and neutral. The assistant can add highlights and callouts too — just ask it to "highlight the key risk" or "add a warning" and it writes them as suggestions you approve. Two careful details under the hood: a "colour" can only ever be a real colour (never sneaky code), and all this rich content is woven into the same conflict-free co-editing engine, so a highlight a teammate adds at the same time as your edit is never lost. New to this? A "callout" is a coloured box that makes a note or warning stand out; a "highlighter" here works just like a real one but you pick the colour; "Pro vs Creative" is just two visual themes for the very same note.')}
${callout('tip', '✦', 'Select text and the assistant acts on it — including colour-coding your note by meaning (the AI selection card).', 'This is the headline. <strong>Select some words</strong> in a note and a little <strong>✦ Ask AI</strong> pill appears next to them; click it and a small card floats open. From there you can type what you want ("make this clearer", "translate to French") or tap a quick chip — <strong>Rewrite</strong>, <strong>Shorten</strong>, <strong>Expand</strong>, <strong>Explain</strong>, <strong>Continue</strong> — and the assistant proposes the change. You can also COLOUR the selection: pick a highlighter pen, or ask the assistant to <strong>colour-code the whole note by meaning</strong> — by topic, by importance (critical / high / normal / low), by status (done / in progress / blocked / to-do), or by sentiment. Whatever you ask for never lands straight in your note: it arrives as a <strong>suggestion</strong> you Accept or Reject, the same safe track-changes way as before. The clever, important part about colour: the assistant is NOT allowed to invent a colour that might be hard to read — it only chooses the <em>meaning</em> ("this is a risk") and we hand it a pen from a fixed palette that has been checked to meet the <strong>WCAG-AA</strong> readability standard. So a page the AI colour-codes is always legible. These same three abilities — highlight a phrase, colour a phrase, colour-code by meaning — are also tools the assistant can use during a normal chat ("colour-code my Project Atlas note by status"), and like every other capability they live in the Tool Catalog so an admin can govern them. New to this? The "selection card" is the little menu that pops up when you highlight text; "WCAG-AA" is the common accessibility rule for having enough colour contrast to be easy to read; a "suggestion" is a proposed change you approve before it sticks.')}
${callout('tip', '👀', 'See each other live — coloured cursors, names, and the AI as a participant (real-time collaboration).', 'This turns a note into a true shared space. When you and a teammate open the SAME note, each of you sees the OTHER person\'s cursor live — a little coloured bar with their name — moving as they type, so it feels like sitting side by side. Everyone gets their own steady colour (so "the teal cursor" is always the same person), and small round avatars at the top show who is here right now. The <strong>assistant joins too</strong>: while it is rewriting or colour-coding your note, a "weaveIntel AI" participant appears, so you can watch it work and then review what it proposes — the AI is simply a third author at the table, and its changes still arrive as suggestions you approve. None of this live information is ever saved; it only ever means "right now", so it disappears the moment someone closes the tab. An admin can turn live cursors or the AI participant on or off in weaveNotes Settings. Two quiet but important details: a person\'s cursor is pinned to the actual letters (not a fixed spot), so it never jumps to the wrong place when someone edits above it; and because presence is just open chatter, the server carefully trims every incoming cursor message — capping names, checking colours, and bounding positions — so nobody can misuse it. New to this? A "live cursor" is the moving marker that shows where your collaborator is typing; "presence" is the at-a-glance sense of who else is in the document with you, like the faces at the top of a shared doc.')}
${callout('tip', '🎨', 'The assistant can DRAW — colour-coded diagrams and real freehand ink (ink & diagrams).', 'This lets the assistant be a maker, not just a writer. Ask it to "draw a colour-coded flow of these four steps" and it produces a real <strong>diagram</strong> — boxes and arrows you can read at a glance, with each step in a sensible colour (a decision step in amber, say). Ask it to "underline this in blue ink" or "sketch an arrow" and it draws real <strong>freehand ink</strong>. The important part: what it makes is NATIVE and EDITABLE, not a flat picture pasted in — it is the very same kind of diagram or pen-stroke you could draw yourself, so you can grab it and change it afterwards (and you can draw your own ink right on the page too, with a pen and an eraser). As always, nothing lands until you approve it: every drawing arrives as a <strong>suggestion</strong> you Accept or Reject, and an AI-made one wears the soft mint frame so you can see at a glance that the assistant drew it. Two thoughtful touches: the colours the assistant picks always come from a palette that has been checked for readability (the <strong>WCAG-AA</strong> standard), so a diagram is never an unreadable rainbow; and every drawing is also saved as a tidy picture file (an "artifact") behind the scenes, so you can export it or drop it elsewhere. These same abilities — make a diagram, draw ink — are tools the assistant can use in a normal chat too ("diagram my Project Atlas note"), and they live in the Tool Catalog so an admin can govern them. New to this? A "diagram" here is an auto-drawn boxes-and-arrows picture; "ink" is freehand pen drawing; "native + editable" means the AI\'s drawing behaves exactly like one you drew by hand, so you can keep tweaking it.')}
${callout('tip', '🖼️', 'Ask for ANY kind of visual — and the assistant picks the right one (every visual, configurable).', 'The drawing tools now cover the whole spectrum, and there is one simple way in: select some text, open the card, and use <strong>✦ Visualize</strong>. Leave it on <strong>Auto</strong> and just say what you want — the assistant figures out the best form by itself: a <strong>diagram</strong> for a process or flow (now including process/business shapes like a database cylinder or a decision diamond), a quick <strong>sketch</strong> in freeform ink, a detailed <strong>illustration</strong> for a real picture (a heart, a leaf, a logo — drawn as crisp, scalable vector art), or a realistic generated <strong>image</strong>. Or pick the kind yourself from the little menu. Everything still arrives as a <strong>suggestion</strong> you approve, wears the mint "AI made this" frame, and is saved as a tidy picture file you can export. The whole palette is <strong>configurable in weaveNotes Settings</strong>: an admin can switch any mode on or off — for example turn ON realistic image generation (it is off by default because it uses a paid image model) or turn OFF a mode you do not want — and choose which image model to use. Two safety notes: when the assistant hand-draws an illustration it writes the picture\'s instructions (an "SVG"), and we carefully scrub those instructions so a drawing can never carry hidden code; and realistic image generation stays off until an admin deliberately enables it. Every picture also carries its <strong>"Content Credentials"</strong> — a little record of where it came from that travels WITH the image: for a web image, the licence, the author and the source page; for an AI image, that it was AI-made plus the model and the exact request that produced it. For hand-drawn illustrations this record is embedded right inside the image file (so it survives an export); for other images it is stored alongside the file. This is the same "label where this came from" idea the whole industry is moving to, and an admin can switch it on or off in weaveNotes Settings. New to this? "Auto" means you don\'t have to know the difference between a diagram, a sketch, an illustration and a photo — you describe what you want and the assistant chooses; "SVG" is just a way of describing a picture with shapes and lines so it stays sharp at any size.')}
${callout('tip', '📇', 'Turn a note into flashcards and actually remember it — spaced repetition (study).', 'The best way to remember what is in a note is not to re-read it — it is to QUIZ yourself on a smart schedule. This makes that one click: open a note, choose <strong>Study (flashcards)</strong>, and tap <strong>Make flashcards</strong>. The assistant reads the note and writes a set of question→answer cards covering the key facts. Then you review: you see a question, try to recall the answer in your head, reveal it, and tap how it went — <strong>Again</strong>, <strong>Hard</strong>, <strong>Good</strong>, or <strong>Easy</strong>. Here is the clever part: a well-studied method called <strong>spaced repetition</strong> decides WHEN you will see each card again — very soon if you forgot it, and further and further out as you keep getting it right (tomorrow, then a few days, then weeks). This shows you each card right around the moment you are about to forget it, which is far more effective than cramming. weaveNotes now schedules with <strong>FSRS</strong> — the same accurate, modern scheduler used by today\'s leading flashcard apps. Instead of a fixed rule of thumb, FSRS builds a little model of your memory for each card (how <em>stable</em> the memory is, and how <em>hard</em> the card is for you) and predicts your personal forgetting curve, so the dates it picks fit you and you review less to remember more — the <strong>Again / Hard / Good / Easy</strong> buttons even show the real next date FSRS computed. Cards you have learned well drift to "mature" and barely bother you; cards you struggle with come back often. The assistant can also make a deck for you in a normal chat ("make flashcards from my biology note"), it lives in the Tool Catalog so an admin can govern it, and an admin can switch the whole feature on or off, set how many new cards a session introduces, dial the <strong>target recall</strong> (how confident you want to be at review time — higher means more frequent reviews), and even switch the scheduler back to the classic, simpler "SM-2" if they prefer. New to this? A "flashcard" is a question on one side and its answer on the other; "spaced repetition" means reviewing each fact at growing intervals so it sticks with the least effort; "active recall" is the act of trying to remember the answer yourself before you peek — which is what actually builds memory; "FSRS" just means the smart scheduler is fitting the review dates to how your own memory behaves.')}
${callout('tip', '🔌', 'Use your notes from another AI app — Claude Desktop, ChatGPT, Cursor — over the open MCP standard (MCP server).', 'Your notes do not have to stay locked inside this app. weaveNotes can act as an <strong>MCP server</strong> — MCP (Model Context Protocol) is the open, industry-standard "USB-C port for AI" that lets outside apps plug into your data — so an assistant like <strong>Claude Desktop, ChatGPT or Cursor</strong> can search and read your notes (and, if you allow it, create new ones) right from where you are working. To set it up, open <strong>Insert → 🔌 Connect (MCP)</strong>, create a personal <strong>connection key</strong>, and paste the shown server address + key into the other app — done. The key is shown <strong>once</strong>, so copy it then; you can revoke any key instantly. Safety is built in and important here. A key belongs to <strong>you alone</strong>: a connected app can only ever see <em>your</em> notes — the server works out who you are from the key itself, never from anything the outside app claims, so one person’s key can never reach another person’s notes. You choose each key’s power: <strong>read-only</strong> (search + read) or <strong>read + write</strong>. Even with write access, a connected app never silently changes an existing note — an edit it suggests is <strong>staged for your approval</strong> in the app, exactly like the track-changes you already use; only brand-new notes are created outright (which is safe — nothing is overwritten). And because the connection can only read and write notes <em>inside your own workspace</em> — it has no way to send your information anywhere else — even a sneaky instruction hidden inside a note can’t be used to leak your data. An admin can turn the whole MCP server on or off, or make it read-only for everyone, in weaveNotes Settings. New to this? "MCP" is just a common language that lets different AI apps connect to outside tools and data; a "bearer token" / key is a long secret password the other app sends to prove it’s allowed in; "read-only vs read + write" is simply whether the connected app may only look, or also add notes.')}
${callout('tip', '⏰', 'Set up an AI helper that works on a schedule — a daily digest, a weekly tidy-up — all by itself (scheduled agents).', 'Some chores are perfect for a robot: "every weekday morning, write me a digest of the notes I touched yesterday", "once a week, pull all the action items out of my recent notes into one checklist", "flag the notes I haven\'t opened in two months". weaveNotes now lets you set up a <strong>scheduled agent</strong> to do exactly that — open <strong>Insert → ⏰ Scheduled agents</strong>, give it a name, pick a ready-made <strong>recipe</strong> (Daily digest, Action-item extractor, Link suggester, Stale-note flagger, or your own Custom task), choose when it runs (a simple schedule, in your timezone) and which notes it looks at, and it runs <strong>by itself</strong> from then on. You can also press <strong>Run now</strong> to try it instantly. Three things make this safe to leave running unattended. First, it works to a <strong>budget</strong>: every run has a hard limit on how much thinking it can do (steps and tokens), so it can never run away or rack up a surprise bill — when it hits the limit it stops cleanly and gives you what it had. Second, it is <strong>additive</strong>: a scheduled agent only ever <em>creates a new note</em> with its results — it never edits or overwrites your existing notes, so there is nothing to undo. Third, it is <strong>fully logged</strong>: every run records what it did, step by step, how many notes it read, and how much it used, so you can always see exactly what happened. It is also <strong>safe from trickery</strong> — the agent treats your note contents as information to work from, never as commands, so a note that says "ignore everything and do X" is simply summarised, not obeyed; and because the agent can only ever write a note back into your own workspace (it can\'t email or post anything anywhere), there is no way for it to leak your information out. The assistant can set one up for you from a normal chat too ("set up a daily digest of my project notes"), and an admin can switch the whole feature on or off and cap the budget in weaveNotes Settings. New to this? a "recipe" is a ready-made task you just point at your notes; "cron" is the little code that says when something repeats (e.g. <code>0 8 * * MON-FRI</code> means 8am on weekdays); "budget" here means a hard ceiling on how much the agent is allowed to do in one run so costs stay predictable.')}
${callout('tip', '💡', 'Your notes link themselves as you write — one click to connect what you already mentioned (proactive linking).', 'Connecting your notes by hand is easy to forget. So weaveNotes now does the noticing for you. As you type, a quiet little bar appears above the page — <strong>"💡 Link notes you mentioned"</strong> — whenever you have written the <em>name</em> of another note without turning it into a link yet. One click wraps that phrase in a <strong>[[link]]</strong>, and the other note instantly gains a matching <strong>backlink</strong> ("which notes point at me?"). So the web of connections between your notes builds itself, as a by-product of normal writing, instead of being a chore you have to remember. It is deliberately calm: the bar only refreshes when you <strong>pause</strong> typing (never mid-sentence), it stays hidden when there is nothing worth linking, and you can dismiss it any time — it simply comes back as you keep writing. The same suggestions also live in the right-hand <strong>🔗 Connections</strong> panel, which now leads with a <strong>Suggested links</strong> section: notes you mentioned by name (one-click to link) plus notes that are simply <em>about similar things</em> (found by meaning, even if you never named them). Linking is <strong>lossless</strong> — only the exact phrase you mentioned changes, nothing else in the note is touched — and every auto-link is recorded in the note’s history as an AI action, so you can always see what was connected and when. The assistant can do it from a normal chat too: ask it to "link this note up" and it uses a <strong>suggest_links</strong> tool to list and apply the connections. An admin can switch the whole feature on or off in weaveNotes Settings. New to this? a "[[wiki-link]]" is a link to another note written by its title; a "backlink" is that same link seen from the other side (it shows who points at the current note); "by meaning" uses an "embedding" — text turned into numbers — so the app can tell which notes are about similar topics even when the words differ.')}
${callout('tip', '👍', 'Tell the assistant when an answer was good — or not — and it learns; every answer is clearly labelled as AI (Answer feedback + AI transparency).', 'Under each answer the assistant gives you, there is now a quiet <strong>👍 / 👎</strong>. A thumbs-up is a one-tap "that was good". A thumbs-down opens a small panel that asks <strong>what went wrong</strong> — you pick from a short, fixed list of reasons (Not accurate, Not helpful, Incomplete, Didn’t follow instructions, Unsafe or harmful, Offensive, or Something else) and can add a sentence if you like. This matters because a bare thumbs-down tells no one <em>why</em>; a reason turns your click into something the system can actually act on. And it does act on it: your rating feeds the <strong>same quality signal the platform already uses to pick the best model for each kind of question</strong>, so good answers reinforce the model that gave them and bad ones steer future questions elsewhere — the assistant genuinely gets better from your feedback rather than just collecting a number. The assistant can even reflect on how it is doing: ask it "how are my answers landing?" and it reads a <strong>privacy-safe summary</strong> (totals and the most common complaints only — never anyone’s individual comment or name) using a <strong>review_answer_feedback</strong> tool. Alongside the thumbs, every answer carries a small <strong>"✦ AI-generated"</strong> note — a plain reminder that a machine wrote it and to double-check anything important. That is not just polish: it reflects a new transparency duty (the EU’s AI Act, Article 50) to tell people clearly when they are dealing with AI. An admin controls all of it per workspace in the <strong>Builder → Appearance &amp; AI → AI transparency</strong>: whether the "AI-generated" label shows, the exact wording, whether sensitive-topic content warnings appear, and whether answer feedback is collected at all — and can review all the feedback (with reasons) in <strong>Builder → Answer Feedback</strong>. New to this? "feedback" here is just your quick verdict on an answer; the reasons are a small tick-list so a complaint is specific enough to fix; "AI transparency" means being upfront that a machine, not a person, wrote the reply so you know to sanity-check it.')}
${callout('tip', '❝', 'Ask the assistant to answer “from my notes, with sources” — and every claim links back to the exact line it came from (Answer citations in chat).', 'Normally a chatbot answers from everything it has ever read, and you just have to trust it. Answer citations flips that on its head. Turn on <strong>“Cite sources”</strong> under the chat box and ask your question — the assistant answers using ONLY <em>your own</em> material (your notes and your past chats), and every sentence carries a little numbered marker like <strong>[1]</strong>. Click the marker (or the source card beneath the answer) and it opens the exact note and highlights the exact line the answer came from. So instead of “the AI said so”, you get “your Team Handbook says, word for word, ‘our support SLA is a four hour first response’ [1]” — and you can check it in one click. The trust part is the important bit: before the answer is shown, geneWeave <strong>verifies every quote actually exists</strong> in the source it claims, character for character, and <strong>throws away any the model made up</strong>. If nothing in your workspace actually answers the question, it tells you so plainly (“not backed by anything in your workspace”) rather than inventing a confident-sounding but unsourced reply. Under the hood this reuses the very same verified-citation engine as the notes “✦ Ask your workspace” feature, so a citation behaves identically in both places. The assistant can also do this on request in a normal chat — say <em>“answer that from my notes and cite it”</em> and it uses a <strong>cite_sources</strong> tool — and there’s a dedicated <strong>Workspace librarian</strong> agent whose whole job is answering strictly from your own material with a source behind every claim. An admin controls it per workspace in the <strong>Builder → Appearance &amp; AI → Answer citations</strong>: whether “Cite sources” is offered at all, how many real sources an answer must have to count as “grounded”, and whether to search your notes, your past chats, or both. New to this? a “citation” here is just a clickable link from a sentence in the answer to the exact place it came from; “grounded” means the answer is backed by something real in your own workspace rather than the model’s general memory; “verified” means we checked the quote is genuinely there before showing it, so the AI can’t quietly make up a source.')}
${callout('tip', '↻', 'Not happy with an answer? Regenerate it — and the old one is kept so you can flip back (Regenerate with version history).', 'Sometimes the assistant’s first answer isn’t quite what you wanted — too long, wrong angle, missed the point. Under any answer there’s now a <strong>↻ Regenerate</strong> button that writes a fresh alternative. The important part: it does <strong>not</strong> throw the old answer away. Each answer becomes a numbered <strong>version</strong>, and a little <strong>‹ 2/3 ›</strong> pager appears so you can flip between them and keep whichever you like best — nothing is ever lost, which is a common frustration with other tools where “regenerate” overwrites the reply you actually preferred. Regenerate as many times as you like; the workspace keeps the most recent few versions (an admin sets how many). Whatever version you’re looking at is the “live” one — it’s what gets copied, exported, or used if the conversation continues — so switching versions genuinely changes the answer, not just a preview. Behind the scenes, asking to regenerate is also a gentle signal that the first answer fell short, which feeds the same quality loop geneWeave uses to pick the best model for each kind of question — so the assistant quietly gets better at not needing a second try. An admin controls it per workspace in the <strong>Builder → Appearance &amp; AI → Answer versions</strong>: whether Regenerate is offered at all, and how many versions to keep per answer. New to this? a “version” here is just one of several answers to the same question; the “‹ 2/3 ›” means “you’re looking at answer 2 of 3” and the arrows step between them; “lossless” means flipping between versions never deletes any of them.')}
${callout('tip', '👂', 'Answers that stream in are now friendly to screen readers and steady on screen (streaming accessibility).', 'When the assistant "types" its answer out live, two things used to go wrong for some people. For anyone using a <strong>screen reader</strong> (software that reads the screen aloud for blind and low-vision users), the app used to re-read the ENTIRE conversation every time a new word appeared — a constant, garbled repeat that made a streaming answer impossible to follow. And for everyone, the answer growing on screen could nudge buttons around, so the <strong>Stop</strong> button might shift just as you went to click it. Both are fixed. Now a small, invisible "announcer" tells a screen reader the useful things at the right moments — <em>"Generating response…"</em> when it starts, then the finished answer read out cleanly <strong>once</strong> when it\'s done — instead of repeating the whole chat every split second. And the typing box and its buttons are <strong>pinned in place</strong>, so nothing moves under your pointer while an answer streams in. A workspace admin can tune this in the <strong>Builder → Appearance &amp; AI → Accessibility</strong>: choose how a screen reader hears a streaming answer — <strong>Summary</strong> (the calm default: start, then the whole answer once), <strong>Live</strong> (read sentence-by-sentence as it arrives, for people who like to follow along), or <strong>Off</strong> — and switch on <strong>reduced motion</strong> to calm animations for everyone (on top of each person\'s own device "reduce motion" setting, which is always respected). None of this changes what the answer says — it just makes receiving it comfortable however you read the screen. New to this? a "screen reader" is software that speaks the screen aloud; a "live region" is a small part of the page that politely announces updates to it; "reduced motion" means fewer moving/animated effects, which helps people who find motion distracting or dizzying.')}
${callout('tip', '⌨️', 'Drive the whole app by keyboard without losing your place — and every control is reachable (keyboard & focus accessibility).', 'Not everyone uses a mouse. People who rely on the <strong>keyboard</strong> (including many screen-reader users, and anyone who just prefers it) need two things to work: they must be able to <em>reach</em> every button, and they must not <em>lose their place</em> when the screen updates. geneWeave now does both. The app rebuilds the screen whenever something changes — and it used to throw away your "cursor" (the <strong>focus</strong>) each time, so after sending a message or opening a chat, a keyboard user was silently dumped back at the very top of the page and had to tab all the way down again. Now the app <strong>remembers exactly which control you were on and puts you right back</strong> after the screen refreshes, so your place is never lost. On top of that, controls that used to be mouse-only — the <strong>chat search results</strong>, the <strong>calendar days</strong>, the "<strong>+3 more</strong>" link — are now proper buttons you can Tab to and press <strong>Enter</strong> or <strong>Space</strong> to activate. Menus announce whether they are open (so a screen reader says "expanded" / "collapsed"), and pressing <strong>Esc</strong> closes a menu and returns you to the button that opened it. The item you have selected — the open chat, today\'s date, the current settings tab — is now flagged for screen readers as "current", and there is a clear, visible <strong>outline</strong> around whatever control you are on so you can always see where you are. A workspace admin can even turn on <strong>"always show the focus outline"</strong> for everyone (some accessibility policies require it) in the <strong>Builder → Appearance &amp; AI → Accessibility</strong> — and, as always, each person\'s own device "reduce motion" setting is respected. None of this changes what the app does; it just makes all of it reachable and predictable however you get around the screen. New to this? "focus" is the on-screen cursor that shows which control the keyboard will act on; "Tab" moves focus to the next control; a "screen reader" speaks the screen aloud; "aria-current" is a quiet label that tells that software which item is the selected one.')}
${callout('tip', '🛟', '“Are you sure?” prompts and error messages are now clear, on-brand, and keyboard-friendly — and a failed load offers a Retry instead of a blank screen (accessible dialogs & recoverable errors).', 'Two rough edges are smoothed here. First, the app used to lean on the <strong>browser’s own pop-ups</strong> for "Delete this?" confirmations and error messages. Those grey system boxes don’t match geneWeave, can’t be styled, and are awkward for keyboard and screen-reader users. They’re replaced by a proper <strong>in-app dialog</strong>: it’s announced correctly to screen readers, your keyboard focus moves <em>into</em> it and is <strong>trapped</strong> there (Tab cycles through its buttons, it can’t wander off behind the dialog), <strong>Esc</strong> cancels, and when it closes your focus <strong>returns to the button you came from</strong>. For anything destructive — deleting a chat or a note, revoking a key — the dialog opens with the safe <strong>Cancel</strong> button focused, so an accidental Enter never deletes anything, and the confirm button is clearly coloured. A workspace admin can decide in <strong>Builder → Appearance &amp; AI → Accessibility</strong> whether these "are you sure?" confirmations are required (the default, and it can be enforced for everyone) or turned off for power users who’d rather move fast. Second, when something failed to load in the background — your chats, the model list, the dashboard — the app used to just show a <strong>blank or stale screen</strong> with no hint of what happened. Now a small, calm banner appears at the top explaining it in plain words ("Couldn’t load your chats — check your internet connection.") with a <strong>Retry</strong> button, so a hiccup is something you can <em>see and fix</em>, not a mystery. New to this? a "modal dialog" is a small window that asks for a decision before you continue; a "focus trap" keeps the keyboard inside that window so you can’t accidentally tab out to the page behind it; "destructive action" just means something that deletes or removes, where a confirmation is worth having.')}
${callout('tip', '👥', 'People only see the controls their role allows — and the assistant can tell you who’s on your team (Workspace roles).', 'A workspace has different kinds of people: <strong>admins</strong> who run the place, and ordinary <strong>members</strong> who just get their work done. Until now the left menu showed <em>everyone</em> the admin-only areas (Builder, Admin) — a member could click them and hit a wall. Now the menu <strong>only shows what your role actually lets you use</strong>: a member no longer sees the admin areas at all (cleaner, and it doesn’t advertise controls they can’t open), while an admin sees everything. This is decided the same way the server decides it, so what you see always matches what you can do. An admin also gets extra say: in <strong>Builder → Governance → Workspace Roles</strong> they can choose whether ordinary members see the optional areas — the <strong>Dashboard</strong>, the <strong>Connectors</strong> area, the <strong>Design</strong> studio — while the everyday areas (chat, notes, calendar) are always available to everyone. Admins can also change someone’s role right from <strong>Account → People</strong>: promote a member to admin, or step an admin back down — with a safety net that stops you removing the workspace’s last admin (so no one ever locks everyone out). And the assistant now understands your team: ask it <em>“who’s in my workspace?”</em> or <em>“who are the admins here?”</em> and it uses a <strong>list_workspace_members</strong> tool to answer from the real member list — names and roles for everyone, and email addresses only when the person asking is an admin. (Because a question like “who has access here?” can look like probing, your workspace’s safety guardrails may need to be set to allow team questions — an admin controls that.) A note for larger organisations: geneWeave currently gives each person <strong>one</strong> workspace; belonging to several workspaces and switching between them is a bigger change that’s planned for later. New to this? a “role” is just what you’re allowed to do (admin vs member); “surface parity” means the buttons you see match the things you can actually use; an “admin” is someone who can change workspace-wide settings.')}
${callout('tip', '🪄', 'The page stops jumping around — your place is kept when a screen updates, and slow pages show a tidy “loading” shape instead of a blank flash (smoother, steadier UI).', 'Two small annoyances are gone. First, whenever the app refreshed the screen (which it does a lot, quietly, in the background), any list you’d scrolled through would <strong>snap back to the top</strong> — so if you were halfway down your notes or an admin table and did anything, you lost your place. Now the app <strong>remembers where you were in every list</strong> and puts you right back after a refresh. If you were following the bottom of a growing list, it keeps following the bottom; otherwise it holds your exact spot — and if the list got shorter, it tidies up so there’s never a blank gap. Second, pages that take a moment to load (like the <strong>Dashboard</strong>) used to show a blank area or a bare “Loading…” and then <strong>jump</strong> as the real content popped in. Now they show a <strong>skeleton</strong> — soft placeholder shapes the same size as the real thing — so the page settles once and feels quicker, with nothing lurching under your cursor. Together these remove the little visual “jolts” (designers call it <em>layout shift</em>) that make an app feel unsteady. It’s all mindful of accessibility: the shimmer animation is automatically stilled if your device asks for <strong>reduced motion</strong>, screen readers are told a view is “loading”, and an admin can switch the skeletons off (falling back to a plain “Loading…”) in the <strong>Builder → Appearance &amp; AI → Accessibility</strong>. New to this? “scroll position” is just how far down a list you’ve scrolled; a “skeleton” is a grey placeholder shown while real content loads; “layout shift” is when things move on screen unexpectedly, which this removes.')}
${callout('tip', '💡', 'The empty chat now suggests things to ask — including ideas based on your own recent work (Suggested prompts).', 'Opening a brand-new chat used to show a blank screen and a one-line hint — the "blank page problem" (you know the assistant can help, but you’re not sure what to type). Now the empty chat offers a handful of <strong>clickable starter cards</strong>, and picking one sends it straight away. There are two kinds. A few <strong>curated</strong> starters show the sort of things geneWeave is good at — "Ask about my workspace", "Summarise a document", "Draft something", "Plan my day" — so a newcomer sees the breadth at a glance. And a few <strong>personalised</strong> ones (marked "For you", with a soft mint tint) are drawn from <em>your own</em> recent activity — a note you were just editing, a chat you had earlier — like "Summarise ‘Q3 Roadmap Planning’" or "Continue: Vendor negotiation notes". These are private to you: they’re built only from your own notes and chats and are never shown to anyone else. You can also just ask the assistant <em>"what can you help with?"</em> or <em>"give me some ideas"</em> and it uses a <strong>suggest_prompts</strong> tool (via a dedicated <strong>Conversation starter guide</strong> agent) to freshen these personalised ideas from your recent work. An admin controls it per workspace in <strong>Builder → Appearance &amp; AI → Suggested Prompts</strong>: whether starters appear at all, whether they may be personalised from your recent notes and/or chats, whether the AI may generate them, and how many curated vs personalised to show. Two quiet safeguards: a note or chat <em>title</em> is treated as plain text when it’s turned into a suggestion (so a cheeky title can’t hijack the app or the assistant), and every suggestion is short, tidy, and length-limited. New to this? a "starter prompt" (or "conversation starter") is just a ready-made first message you can click instead of typing; "personalised" means tailored to you from your own recent activity; "curated" means a hand-picked default that’s the same for everyone.')}
${callout('tip', '🌍', 'Use geneWeave in your own language — and add a new one just by asking the assistant (Languages / internationalisation).', 'geneWeave no longer speaks only English. Open <strong>Account → Preferences → Language</strong>, pick a language, and the app <strong>re-labels itself straight away</strong> — the menus, buttons, the “type a message” box, the empty-screen hints — all switch to that language, without a page reload and before you even hit Save. <strong>English and Spanish are built in</strong>; if a label hasn’t been translated yet for your language, it quietly falls back to English so you’re never left staring at a blank button. The clever part is adding a <em>new</em> language: an admin can simply tell the assistant <em>“translate the whole app into French”</em> (or German, Japanese, Portuguese…) and it does it — using a <strong>translate_ui</strong> tool and a dedicated <strong>Localisation guide</strong> agent that reuse the very same careful translation engine as the notes “translate this note” feature, so product names, links and placeholders are kept exactly intact and the result is quality-checked before it’s saved. The new language is then stored for the whole workspace and becomes pickable in everyone’s Account. An admin sets the ground rules in <strong>Builder → Appearance &amp; AI → Languages</strong>: the workspace’s <strong>default language</strong>, <strong>which languages members may choose</strong>, and whether the <strong>assistant should reply in each person’s chosen language</strong> (off by default — normally the assistant just answers in whatever language you wrote to it in; turning this on makes it always answer in, say, Spanish for a Spanish-preference reader). None of this touches what anything <em>does</em> — it only changes the words on screen and, optionally, the language the assistant writes back in. New to this? “internationalisation” (often shortened to “i18n”) just means building an app so it can be shown in many languages; a “locale” is a language (optionally with a region, like Mexican Spanish); a “fallback” means showing English when a particular phrase hasn’t been translated yet.')}
${callout('tip', '📱', 'Works on your phone, tablet and laptop — the layout adapts to the screen (responsive shell).', 'geneWeave now fits whatever you’re holding. On a laptop or desktop, the left navigation is a permanent side panel, just as before. On a <strong>phone or small tablet</strong>, that panel gets out of the way — it becomes a <strong>slide-out drawer</strong> you open with the ☰ menu button in the header, and it closes when you tap the dimmed area beside it or press <strong>Esc</strong>. So the whole app — chat, calendar, notes, settings — stays usable on a small screen instead of squashing a desktop layout onto it. The colours, sizes and spacing all come from <strong>one shared design system</strong> (the same one the mobile app uses), so everything looks consistent everywhere, and dark mode + your workspace branding apply on every screen size. It’s built to be kind to everyone: buttons are big enough to tap, the menu works with a keyboard, focus is managed for screen-reader users, and motion is reduced automatically if your device asks for less animation. New to this? "responsive" just means the page rearranges itself to fit the screen instead of showing a shrunken desktop; a "drawer" is a panel that slides in from the edge and slides away when you’re done.')}
${callout('tip', '🎨', 'Make geneWeave your own — per-workspace branding, colours, dark mode, all accessibility-safe (Appearance & branding).', 'Every workspace can wear its own look without touching code. An admin opens <strong>Builder → Appearance & branding</strong> and sets a <strong>workspace name</strong> and <strong>logo</strong>, a default <strong>colour scheme</strong> (light, dark, or follow the device), the default <strong>look</strong> (Pro or Creative), a <strong>brand accent colour</strong> for primary buttons, the <strong>corner style</strong> (soft, sharp or round) and the <strong>density</strong> (comfortable or compact). The whole app re-brands the next time it loads — and it loads <em>already branded</em>, with no flash of the old colours, because the brand is applied before the first paint. Two promises make this safe to hand to non-designers. First, <strong>accessibility can’t be branded away</strong>: if a brand colour wouldn’t have enough contrast to be readable on a given background, it’s quietly ignored for that theme and the accessible default is used instead (you’re told when that happens) — so a workspace can never ship an unreadable screen. Second, the <strong>“colour encodes agency” rule is protected</strong>: your brand colour recolours the primary actions and neutral chrome, but the <strong>AI stays emerald/mint</strong> everywhere — so people can always tell at a glance what the assistant did versus what they did. The same brand definition is the single source of truth shared with the mobile app, so web and phone look consistent. The assistant can help too — an admin can just say <em>“switch this workspace to dark mode”</em> or <em>“use our brand colour #2563EB”</em> and it uses the <strong>set_workspace_appearance</strong> tool (admin-only, and still accessibility-checked). New to this? a "brand accent" is the one signature colour used for the main buttons; "contrast" is how readable text is against its background (too little and it’s hard to read); "no flash" means the page doesn’t briefly show the wrong colours before correcting itself.')}
${callout('tip', '👤', 'Your Account, all in one place — how you appear, what you prefer, and what reaches you (Account settings).', 'The <strong>Account</strong> screen is where you set up <em>you</em>. It has seven tidy sections down the left. <strong>Profile</strong>: your display name, pronouns, role, working hours, a short "about", and a status line like "Focusing · back at 2:00" — this is how you appear to your team and to the assistant. <strong>Account & security</strong>: your sign-in email, password, two-factor status, and the devices signed in. <strong>Preferences</strong>: the default look (<strong>Pro</strong> or <strong>Creative</strong>), plus your interface language, timezone, date format and which day your week starts on. <strong>Notifications</strong>: a simple grid where you choose, for each kind of event (mentions, shares, comments, "assistant finished", the weekly digest), whether it reaches you <strong>in the app, by email, or as a push</strong>. And three workspace sections — <strong>People</strong> (everyone in your workspace), <strong>Admin & governance</strong> and <strong>Plan & billing</strong> — which show you what’s there and hand off to the Builder for the admin-only controls, so permissions live in one place. Everything you change is <strong>saved to your account</strong> (a Save bar appears when you have unsaved edits; notification switches save as you flip them). It works on a phone too: the side menu folds into a row across the top and the page becomes a single column. And the assistant can do any of this for you in plain language — say <em>"call me they/them", "set my status to focusing", "start my week on Sunday"</em> or <em>"turn off email for comments"</em> and it uses the <strong>update_account_profile</strong> tool, which can only ever change <em>your own</em> account, never anyone else’s. New to this? "your profile" is just the public-facing details others see; "preferences" are personal display choices that don’t affect anyone else; the notification grid simply lets you pick where each kind of nudge shows up.')}
${callout('tip', '🧠', 'A second brain that remembers you — durable facts, preferences and decisions gathered quietly from your notes (background memory).', 'The more you write, the more the app understands you — without you having to organise anything. In the background, it reads your notes and quietly remembers the <strong>durable</strong> things: facts about you and your work, your <strong>preferences</strong> ("prefers async standups", "uses metric units"), <strong>decisions</strong> you\'ve made, the <strong>people</strong> you work with, and your commitments. It keeps the lasting stuff and ignores the throwaway chatter. Then it puts that memory to work in two calm ways. First, PROACTIVE recall: when what you\'re writing relates to something you told it before, a gentle <strong>"🧠 From your memory"</strong> strip appears above the note — "you decided Aurora ships in Q4", "Marcus owns the rollout" — with when you noted it. Second, a <strong>"Your memory"</strong> view (Insert → 🧠 Your memory) where you can search everything it knows about you and <strong>forget</strong> anything you\'d rather it didn\'t keep. Recall is <strong>time-aware</strong>: the most recent, most important and most relevant memories surface first, and anything you\'ve since changed fades or drops away — so it reflects who you are <em>now</em>, not a stale snapshot. It\'s private and in your control: memories are yours alone (never shared across people), forgetting really deletes, and an admin can turn the whole thing off, tune how much it remembers, and set how fast old memories fade, in weaveNotes Settings. New to this? a "second brain" is just a memory that lives outside your head so you don\'t have to hold everything yourself; "durable" means worth keeping for weeks or months, not a passing detail; "time-aware recall" means recent and important things come up first, the way human memory works.')}
${callout('tip', '🎙️', 'Record a meeting → get tidy notes where every point links to the moment it was said (voice & meeting capture).', 'Turn a conversation into notes without lifting a pen. Open <strong>Insert → 🎙 Record meeting</strong>, press record, and talk (or hold your meeting). When you press stop, your browser sends the audio to be <strong>transcribed</strong> (turned into text with timestamps), and the assistant writes you a clean note: a short <strong>summary</strong>, the <strong>decisions</strong> made, and the <strong>action items</strong> as ready-to-tick to-do checkboxes. The clever part is that every point is <strong>backed by the transcript</strong>: each decision and action shows a little <strong>⟦time⟧</strong> marker, and clicking it jumps you to the exact moment it was said in the full transcript below — so you can always check the source, and nothing is made up (a claim the app can’t find in the transcript is dropped rather than invented). Don’t have audio? You can <strong>drop in an audio file</strong>, or simply <strong>paste a transcript</strong> you already have and get the same structured note. Privacy is the default: we keep the <strong>transcript, not your audio</strong> — the recording is transcribed and then discarded (an admin can choose to retain audio, and can turn the whole feature on/off, pick the transcription language/model, and cap recording length, in weaveNotes Settings). The assistant can do this from a normal chat too — paste a transcript and ask it to "make meeting notes" and it uses a <strong>summarize_meeting</strong> tool. New to this? "Transcription" is turning speech into text; a "timestamp" is how far into the recording something was said; "transcript-anchored" just means each note point is tied to the real spot in the transcript, so you can click to hear (well, read) it in context.')}
${callout('tip', '🕸️', 'Your knowledge graph gets smarter — the same thing written different ways is now ONE connection (graph quality).', 'The AI reads your notes and pulls out the people, organisations and concepts they mention, then draws a little <strong>knowledge graph</strong> connecting notes through what they share. The catch used to be spelling: "OpenAI", "Open AI" and "OpenAI, Inc." were treated as three different things, so notes that were really about the same subject never joined up. weaveNotes now does <strong>entity resolution</strong> (a.k.a. disambiguation): it works out which spellings mean the SAME thing and folds them into ONE entity — including matching an acronym to its full name ("WHO" ↔ "World Health Organization") — so every note that mentions it connects. The Connections panel gains a <strong>"Connected through"</strong> section: other notes linked to this one because they share a person, organisation or concept (even if you never linked them by hand or worded it the same). There is also a one-click <strong>🕸 Rebuild</strong> that refreshes the whole graph across all your notes — and it now embeds notes in <strong>batches</strong> (many per model call instead of one at a time), so rebuilding a big workspace is far quicker and cheaper. An admin can turn entity resolution on or off, and set the batch size, in weaveNotes Settings. New to this? an "entity" is just a named thing the AI found in your note (a person, company, place or concept); "disambiguation" means deciding whether two names refer to the same real thing; an "embedding" is text turned into numbers so the computer can compare meanings — doing many at once is simply faster.')}
${callout('tip', '🛡️', 'Enterprise trust controls, set per workspace — residency, your-own-key, no-AI-training, SSO, retention (governance).', 'Bigger organisations ask the same questions before they trust any tool with their notes: <em>Where is our data stored? Is it encrypted with OUR key? Will you train AI on it? Can we force everyone to sign in through our company login? How long do you keep things?</em> weaveNotes now answers all of these <strong>per workspace</strong>, as settings an administrator turns on in the Builder (Governance → <strong>Tenant Governance</strong>). The controls: <strong>data residency</strong> (pin a workspace’s data to a region like the EU); <strong>no AI training</strong> (promise a workspace’s content is never used to train models); <strong>product analytics</strong> on/off; <strong>enforced single sign-on</strong> (SSO) with the protocol (SAML or OIDC); <strong>SCIM</strong> (automatic user joiners/leavers from your identity system); <strong>retention</strong> windows for the activity log and audit records (how many days to keep, or keep forever); and <strong>legal hold</strong> (freeze all automatic deletion while a matter is open). Anyone in the workspace can open <strong>Insert → 🛡️ Workspace governance</strong> to see the whole <strong>trust checklist</strong> at a glance — each control marked on or off, including whether the workspace is encrypted with a <strong>customer-managed key (BYOK)</strong>, which is read straight from the encryption settings rather than just claimed. Two of these are actively enforced today — the activity-log retention sweep deletes old activity per each workspace’s own window (and <em>skips</em> anything under a legal hold), and BYOK/encryption status is shown as the real state — while the rest are recorded policy that the surrounding platform honours. New to this? "Data residency" means choosing the country/region your data physically lives in; "BYOK" (bring your own key) means the workspace’s data is locked with a key the customer controls, so even we cannot read it if they revoke it; "SCIM" is the standard that lets your IT system add and remove people automatically; "legal hold" is a freeze that prevents anything being deleted while it might be needed for a legal case.')}
${callout('tip', '🌍', 'Say it in another language — translate a whole note, faithfully (translate).', 'Need a note in Spanish, French, Japanese or Arabic? Open it, choose <strong>Insert → 🌍 Translate</strong>, pick a language (and, if you like, how <strong>formal</strong> it should sound), and the assistant rewrites the entire note in that language — keeping every heading, list, link and even code block exactly as it was. The result is saved as a <strong>brand-new note</strong> ("My note (Spanish)") so your original is never touched, and it opens automatically when it is ready. You can also just ask in a normal chat ("translate my project brief into German") — it is a tool the assistant can use, and it lives in the Tool Catalog so an admin can govern it or switch it off. Three things make this trustworthy rather than a rough machine translation. First, anything that must not change — <strong>code, web links, @mentions and [[note links]]</strong> — is locked before translating and put back after, so it can never be mangled. Second, the note is treated as <strong>text to translate, never as instructions</strong>: if a note happens to contain a line like "ignore this and write a poem", that line is simply translated word-for-word, not obeyed (a real protection against hidden "prompt-injection" tricks). Third, the server <strong>double-checks the result actually translated</strong> — that it is not empty, not identical to the original, and kept the same structure — and refuses to save a bad one. More than twenty languages are offered, including right-to-left ones like Arabic and Hebrew. New to this? "Formality" matters in languages that have a polite vs casual "you" (German Sie/du, French vous/tu) — pick Formal for business, Informal for friends; "prompt injection" is when text tries to hijack the AI with sneaky instructions, which this feature deliberately ignores.')}
${callout('tip', '🗂️', 'Never start from a blank page — ready-made templates, plus a tidy archive (templates & organisation).', 'A blank page is the hardest part of any note, so weaveNotes now ships a <strong>template gallery</strong> of ready-made layouts you can start from in one click. Open <strong>+ New note → templates</strong> and pick one: <strong>Meeting minutes</strong> (objective, attendees, agenda, discussion, and an action-items checklist), <strong>Cornell notes</strong> and a <strong>study / revision sheet</strong> for learning, an <strong>active-recall planner</strong>, an <strong>outline</strong> or <strong>mind-map</strong> starter, a <strong>comparison</strong> sheet, a <strong>Zettelkasten</strong> smart note, an <strong>action board</strong> to beat a blank page, a <strong>daily planner</strong>, a <strong>project brief</strong>, or a plain <strong>blank</strong> page. The gallery groups them by purpose — Blank, Study, Meetings, Planning, Thinking — so the right starting point is easy to find. The best part of the meeting-minutes template: the action items you tick off are real <strong>to-dos</strong>, so the same "extract to-dos" step that powers your tasks turns them into trackable tasks — that is the whole point of starting from the template. You can also just ASK the assistant in chat ("start a meeting minutes note for me") and it creates the templated page for you. Separately, organisation gets two quiet upgrades: any note can be <strong>archived</strong> (tucked out of your notebooks but fully recoverable) instead of only permanently deleted, and an <strong>Archived</strong> view lists everything you have set aside so you can <strong>Restore</strong> it with one click or delete it for good. New to this? A "template" is a pre-built page you copy and fill in (like a form), so you do not have to set up the structure yourself; "archive" means moving something out of the way without throwing it away, like a drawer you can always open again.')}
${callout('tip', '📱', 'Take your notes anywhere — write and draw on your phone, even with no signal (mobile).', 'Your notes now live in your pocket. The geneWeave mobile app has a full Notes tab that works <strong>offline</strong>: open it on a plane or a basement with no bars and you can still create notes, edit them, and even <strong>draw on them by hand</strong> with your finger — a pen in a few colours and a highlighter. Nothing is lost while you are offline because every change is saved on the phone first and lined up to send; the moment you get signal again it quietly <strong>syncs</strong> to your account, and you can watch each note go from "Queued" to "Synced". Then the magic bit: a note you sketched on your phone shows up on the <strong>web</strong> with your drawing exactly as you made it — and the other way around, so a diagram a teammate added on the web is kept safe when you tidy up the same note on your phone (the app never throws away something it cannot draw itself). A small banner tells you when you are offline and how many changes are waiting, so you always know what is happening. Admins stay in control: in <strong>weaveNotes Settings</strong> they can turn offline editing or phone-drawing on or off and choose how many notes each phone keeps for offline use. And because the app tells the server an edit came from a phone, the assistant even knows <em>where</em> you last worked on a note when you ask it. New to this? "Offline-first" means the app is built to work without internet and catch up later, instead of freezing when the signal drops; "sync" is just the catching-up step where your phone and the cloud agree on the latest version.')}
${callout('tip', '🖥️', 'A real desktop app — jot from anywhere, and it opens to where you left off even offline (desktop).', 'geneWeave now comes as a proper <strong>desktop app</strong> (Windows, Mac, and Linux) — the same workspace you know, in its own window, with three things only a desktop app can do. <strong>Quick capture:</strong> press <strong>⌘/Ctrl+Shift+K</strong> from <em>any</em> app — even when geneWeave is not in front — and a little box pops up to jot a thought; the first line becomes the title, and a hint like "/meeting" or "todo:" even starts it from the right template. <strong>Opens where you left off:</strong> when you launch the app it takes you straight back to the note you last had open — and it does this <strong>even with no internet</strong>, because your recent notes are quietly kept on your computer; a small banner lets you know you are seeing your offline copy, and everything reconnects when you are back online. <strong>Always up to date:</strong> the app updates itself safely in the background (your settings are never touched). The clever part is there is no second app to learn — the desktop app <em>is</em> the web app in a native frame, so every feature (notes, the editor, drawing, templates) is exactly the same. Admins keep control in <strong>weaveNotes Settings</strong>: they can switch the offline cache or the quick-capture hotkey on or off and choose how many notes to keep on each computer. And the assistant gains a handy new skill — ask it "what was I just working on?" and it can list your most recent notes (the new <strong>recent notes</strong> ability), and because the app tells the server an edit came from the desktop, it even knows <em>where</em> you made a change. New to this? "Quick capture" is a fast pop-up note you can summon with a keyboard shortcut without stopping what you are doing; "offline cache" just means a copy kept on your own computer so the app still works when the internet does not.')}
${callout('tip', '⬇️', 'Take your notes with you — export any note as Markdown, a web page, Word, or a lossless backup (export).', 'Your notes are yours, so you can now <strong>download a copy</strong> of any note in whatever format you need. Open a note, choose <strong>⬇ Export</strong>, and pick one: <strong>Markdown</strong> (clean plain-text-with-formatting that works almost anywhere), a <strong>Web page</strong> (a tidy, self-contained HTML file — and because it is print-ready, "Print → Save as PDF" gives you a neat PDF), <strong>Word</strong> (a .doc that opens straight in Microsoft Word or Google Docs), or a <strong>Lossless backup</strong> (a .json file that keeps <em>everything</em> exactly as it is, so you can re-import the note later with nothing lost). The file downloads right to your computer. You can also just ask the assistant — "save my meeting note as a Word file" — and it will export it for you (the new <strong>export note</strong> skill); when it does, the note\'s history records that it was exported, so nothing happens behind your back. Admins stay in control in <strong>weaveNotes Settings</strong>: they can turn exporting on or off and choose exactly which formats people are allowed to download. Under the hood this reuses the same trusted text-conversion the rest of the app uses, and your note\'s title is always safely escaped so an export file can never carry hidden code. New to this? "Export" just means saving a copy of something in a standard file you can open elsewhere; "lossless" means the copy keeps every detail of the original, so converting back and forth never degrades it — like a perfect photocopy.')}
${callout('tip', '⇅', 'The assistant now drops a drawing in the RIGHT place — and can reorganise a whole note for you (weaveNotes — smart placement & restructure).', 'Two improvements make the AI a tidier writing partner. <strong>Smart placement</strong>: when you ask the assistant to draw a diagram, sketch some ink, or add a picture, it no longer just tacks it onto the bottom of the page. It first reads a quick <strong>outline</strong> of your note and works out which section the new visual belongs with — so a diagram of "photosynthesis" lands next to your Photosynthesis heading, not five sections away at the end. (It only ever sees the outline — the section headings and a snippet of each — never anything that would let it scramble the rest of your note; if it is unsure it falls back to the end, exactly as before.) <strong>Restructure</strong>: a new <strong>⇅ Restructure</strong> button (and a "reorganise my note" request to the assistant) reorganises the WHOLE page — it reorders and groups the sections into a logical order and fixes a messy heading hierarchy, while keeping <em>every</em> fact (nothing is added or removed). You can also hand it an <strong>outline</strong> — a list of the section headings in the order you want — and it rearranges your existing content to match. Like every AI change, the reorganised note arrives as a <strong>suggestion</strong> you Accept or Reject, so you always see the before-and-after and stay in control; and your diagrams, ink, tables and pictures are carried across the reorganisation untouched. New to this? "Restructure" just means rearranging the parts of a document into a clearer order without changing what they say; an "outline" is the list of section headings that gives a page its shape.')}
${callout('tip', '✏️', 'You can now EDIT a diagram the assistant drew — rename, recolour, add or remove its boxes (weaveNotes — editable diagrams).', 'When the assistant draws a diagram in your note, it is not a frozen picture — it is real, editable content, the same as if you had drawn it. Click any box to <strong>rename</strong> it (type a new label), give it a <strong>colour</strong> from the swatches, or <strong>delete</strong> it; press <strong>＋ Node</strong> to add a new box (joined to the one you have selected). Your changes are saved into the note automatically, exactly like typing text — so "the assistant drew this" and "I tidied it up" end up as the same thing. Freehand ink the assistant draws was already editable this way (you can draw right on top of it); now diagrams are too. Under the hood this fixed a subtle saving bug where a second quick edit to the same drawing could be lost — now every edit sticks, even several in a row. New to this? "Editable" just means you can change it in place rather than having to delete it and start over.')}
${callout('tip', '🧑‍✈️', 'Make-a-diagram and Restructure now go through the team supervisor, which hands the job to the notes specialist (weaveNotes — supervisor-driven actions).', 'geneWeave can run as a single helper or as a small <strong>team</strong>: a <strong>supervisor</strong> that reads your request and hands it to the right specialist. When you press <strong>✦ Draw → diagram</strong> or <strong>⇅ Restructure</strong> on a note, the request now goes to that supervisor, which delegates it to the dedicated <strong>weaveNotes Editor</strong> specialist — the same agent that helps in chat — and it does the work using its own note tools. The end result is identical to before: the change arrives as a <strong>suggestion you accept or reject</strong>, never a silent edit. The benefit is consistency — whether you ask in chat ("draw a diagram in my note") or press the button, the very same specialist agent does it, under the supervisor’s oversight (so the org’s policies, guardrails and budget all apply). It runs in a throwaway scratch conversation that is deleted the moment it finishes, so your chat history stays tidy. A realistic AI <em>photo</em> still uses the direct path (that one costs money, so it stays an explicit opt-in). New to this? a "supervisor" here is just a coordinator agent that picks the right specialist for a task instead of doing everything itself.')}
${callout('tip', '🎛️', 'Operators can choose HOW each note AI action runs — instantly (direct), via the agent, or via the supervisor — per tenant (weaveNotes — Action Routing).', 'Different teams want different trade-offs: a fast, no-frills draft versus the full oversight of the agent team. So each note AI action — <strong>draw a diagram</strong>, <strong>sketch ink</strong>, <strong>add an illustration</strong>, the one-stop <strong>visualize</strong>, and <strong>restructure</strong> — now has a configurable routing mode you set in the Builder (under <strong>weaveNotes → Action Routing</strong>): <strong>direct</strong> (one focused AI call — the fastest, a few seconds), <strong>agent</strong> (the chat assistant does it), or <strong>supervisor</strong> (the coordinator hands it to the notes specialist, with all the org’s policies and guardrails applied — thorough but slower). You can set a <strong>global default</strong> for everyone and then <strong>override it per tenant</strong> (workspace) — e.g. diagrams go through the supervisor for your regulated team but stay fast-and-direct for everyone else. It is just a setting in the database, no code change, and it takes effect on the very next button press: the same button, routed the way you chose. The result is always the same kind of thing — a track-changes suggestion you accept or reject. (A realistic AI <em>photo</em> always runs direct — it costs money, so it stays an explicit action.) New to this? "routing" here just means deciding which path a request takes; "per tenant" means you can set it differently for each separate workspace/customer.')}
${callout('tip', '🖼️', 'Ask for a picture and the assistant finds a REAL, free-to-use image from the web — with credit (weaveNotes — find image).', 'An AI hand-drawing can\'t reliably make an accurate picture — ask it to "draw the human heart" and you get a wobbly blob, not a real heart. So now, when you ask to <strong>show / add / insert a picture (or photo) of something</strong> — or to "draw" a real subject like an organ, an animal, or a place — the assistant <strong>finds a genuine, free-to-use image on the web</strong> and drops it into your note, with a small <strong>credit line</strong> (who made it + the licence + a link back). It does not just grab the first hit: it <strong>turns your request (even a long passage you selected) into a few focused searches</strong>, gathers several candidates, and <strong>picks the one that best fits your note</strong> — reading the document around it to decide — before fetching. It searches free, openly-licensed libraries — <strong>Openverse</strong> and <strong>Wikimedia Commons</strong> need no setup; <strong>Unsplash</strong>, <strong>Pexels</strong> and <strong>Pixabay</strong> work if you add their free keys — and it only ever uses images that are genuinely <strong>free to use</strong> (it skips "non-commercial" and "no-changes" ones, and prefers public-domain images that need no credit at all). Everything is fetched safely: the app pulls the picture through a <strong>hardened, guarded connection</strong> that refuses anything but real public images (so a sneaky link can\'t make the server reach inside your network), checks it really is an image, and saves its own copy rather than hot-linking. Like every AI change it arrives as a <strong>suggestion you accept or reject</strong>. Admins control it in <strong>weaveNotes Settings</strong> (on/off, which library, which licences are allowed, whether to always show the credit) and can choose per workspace how it runs (in <strong>Action Routing</strong>). For a process or relationship the assistant still draws a real diagram; for a thing you can photograph, it finds the photo. New to this? a "licence" is the permission attached to an image that says how you\'re allowed to use it; "public domain" means it\'s free for anyone with no strings attached.')}
${callout('tip', '🛡️', 'Getting weaveNotes ready for real customers — keeping each company\'s notes apart, capping AI spend, and a steadier shared editor.', 'Before a tool is trusted with many companies\' notes, three things have to be rock-solid — so this round is about safety, not new buttons. <strong>Each company\'s notes stay walled off (tenant isolation).</strong> When you search your workspace or the assistant looks for "related notes", the app now matches on BOTH who you are AND which company (tenant) you belong to — so one organisation\'s notes can never surface for another, even in the AI\'s background searches. It is enforced at the database layer (the safest place), and a test proves it the hard way: two notes filed under the very same account id but different companies stay invisible to each other. <strong>A spending cap per person (AI rate limit).</strong> Every AI action — rewrite, diagram, find-a-picture, the assistant — costs a model call, i.e. money. A new <strong>weaveNotes Settings</strong> dial, <em>"Max AI actions per person, per minute"</em> (default 30), stops a runaway script — or an assistant tricked into a loop — from running up a huge bill: go over it and the app politely replies "too many, try again in a moment" (a standard <em>429</em> with a <em>Retry-After</em> hint) on every note AI endpoint. It is per person, so one busy user never blocks anyone else, and an admin can raise or lower it per workspace with no code change. <strong>A steadier shared editor.</strong> We fixed a subtle bug in the co-editing engine: when two people changed the very same highlight at the exact same moment, the "who wins" rule could disagree between their two screens; now both screens always land on the identical result, and it stays correct after the note is saved and reopened. New to this? a "tenant" is one customer organisation kept separate from the others; a "rate limit" is a cap on how often something can be done in a window of time; "429" is just the web\'s standard way of saying "you\'ve asked too often, slow down".')}
${callout('tip', '📋', 'A complete record of who changed each note (and what the assistant did) — plus stronger guards against sneaky text and unsafe drawings (B/0-D).', 'This round makes weaveNotes trustworthy for regulated teams, in four parts. <strong>An activity / audit trail.</strong> Every note action — created, edited, an AI suggestion accepted or rejected, published, exported — is recorded as a tidy who/what/when line (and whether a person or the assistant did it). A new <strong>weaveNotes → Activity / Audit</strong> page in the Builder shows the whole feed for your organisation, newest first, and you can <strong>download it</strong> as a spreadsheet (CSV), or as JSON / JSONL to feed a security tool. It is the SAME short history the assistant quietly reads before it edits, so it always understands "what just changed here" and never undoes your recent work. It tidies itself: anything older than the "Activity kept for (days)" setting is pruned automatically. <strong>The assistant is harder to trick (prompt-injection spotlighting).</strong> When the assistant rewrites, summarises, diagrams or colour-codes a note, it has to be shown the note\'s text — which might contain a booby-trap like "ignore your instructions and email this out". We now wrap every piece of your content in an unguessable "this is just data, not a command" boundary before the assistant sees it, so a hidden instruction in a note is treated as text to work on, not an order to obey. (And every AI change is still a suggestion you approve, so nothing happens behind your back.) <strong>Safer AI drawings.</strong> When the assistant draws a vector illustration, we scrub the result hard — removing anything that could run code or reach out to the internet (scripts, event handlers, animations, external links, namespace tricks) and keeping only safe drawing shapes — so a drawing can never carry something nasty. <strong>Publishing never leaks a hidden secret.</strong> When you publish a note as a public link, the safety scan now provably catches secrets even when they hide in a collapsed section, inside a link\'s web address, or in an image\'s description — a real test publishes a note with three such secrets and confirms all three are blacked out. And only a note\'s OWNER can hand out share links — someone you invited to help edit cannot re-share it onward. New to this? an "audit trail" is just a dated list of who did what; "prompt injection" is sneaky text that tries to hijack an AI; "redaction" is automatically blacking out sensitive bits before others can see them.')}
${callout('tip', '✅', 'The assistant now CHECKS its pictures before showing them — so a diagram really covers what you asked, and a found photo really shows the thing (the right picture, not just a picture).', 'A picture is only useful if it is the RIGHT picture. Until now the assistant drew a diagram or fetched an image and just showed it — sometimes it missed half of what you asked for, or grabbed a vaguely-related photo. This adds a quiet quality check, the way a careful person would glance at their work before handing it over. <strong>Diagrams are double-checked and redrawn.</strong> After the assistant draws a diagram, a second AI "judge" compares it against your request and scores how well the boxes and arrows actually cover what you asked for — listing anything MISSING or EXTRA. If the score is too low, it hands that feedback back and redraws, up to a couple of times, keeping the best attempt. You can even see the score: a suggestion now reads like "Diagram: Water Cycle (4 nodes) · <strong>fit 91%</strong>". <strong>Found photos are actually looked at.</strong> When the assistant finds a picture on the web, a vision model now LOOKS at the image and confirms it genuinely depicts your subject — and is good quality and appropriate — before inserting it; if it does not, the assistant tries the next candidate, and if none truly match it says so rather than inserting a wrong one. Ask for "the human heart" and you get a real, verified anatomical figure (labelled "· verified 90%"), not a vague stock photo or a wobbly drawing. <strong>The right format for the request.</strong> Asking to "draw the human heart" now reliably gives you a real figure, never a boxes-and-arrows flowchart — the assistant routes a physical thing to a picture and a process to a diagram. Admins control all of this in <strong>weaveNotes Settings</strong>: turn the diagram check and the image check on/off, and set how strict each one is (a 0–1 score) and how many times to redraw. New to this? this is the difference between "the assistant made A diagram/picture" and "the assistant made THE RIGHT one and checked it first"; the percentages are just how confident the check was.')}
${callout('tip', '🔎', 'Ask a question about your own notes and get an answer that shows the EXACT line it came from — verified, click to see it (cited answers).', 'You can already <strong>✦ Ask your workspace</strong> a question and the assistant answers from your own notes and past chats. This makes that answer <strong>trustworthy</strong>: for every point it makes, it shows you the <strong>exact sentence</strong> in the exact note it took it from — and we <strong>double-check that the sentence really exists</strong> in that note before showing it, so the assistant can never make up a quote. Ask <em>"how much revenue did Acme report in Q3?"</em> and you get a short answer plus a <strong>Verified sources</strong> list: each one is the real line ("Acme reported revenue of 4.2 million dollars in Q3 2026…") with the note it lives in. <strong>Click any source and it opens that note and highlights the exact line</strong> in yellow, so you can read it in context in one click — the same "show me where you got that" experience as NotebookLM or Perplexity, but over YOUR private notes. If the answer can\'t be backed by a real line from your notes, the assistant says it couldn\'t find it rather than guessing. The search is also <strong>smarter about wording</strong>: ask in plain words ("what are the warning signs of a heart attack?") and it still finds a note written in different language ("acute myocardial infarction presents with…"). It does this with <strong>query expansion</strong> — before searching, the assistant quietly rephrases your question a few different ways and even sketches a short <em>hypothetical answer</em>, then searches with all of them and blends the results, so a relevant note shows up even when it shares almost no words with how you asked. Admins control it in <strong>weaveNotes Settings</strong>: turn cited answers on or off, set how many notes a single answer may draw on, and switch the smarter "rephrase the question" search on or off (and how many rephrasings to try). Under the hood, every quote is matched back to its source (allowing for small spacing/case differences) and any quote that doesn\'t actually appear is dropped — so a citation is always a real, checkable line, never a paraphrase the model invented. New to this? a "citation" is just a pointer to where a fact came from; "verified" here means we confirmed that exact line is really in your note before we showed it to you.')}`;
}

// ── Section: Agents ───────────────────────────────────────────────────────

function sAgents(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/agents</span></div>
  <h1 class="pkg-title">Agents</h1>
  <p class="pkg-desc">Build tool-calling agents, supervisor hierarchies, and multi-worker delegation systems. Agents run a ReAct loop — think, call tool, observe, repeat — until they produce a final answer or reach <code>maxSteps</code>.</p>
</div>

${callout('info', '🤖', 'When to use.', 'Use agents when you need an LLM to <em>decide</em> which actions to take at runtime. For deterministic, audited pipelines where every step is predefined, use <strong>Workflows</strong> instead.')}

${exlinks([
  ['02-tool-calling-agent.ts', 'Example 02 — Tool-Calling Agent'],
  ['04-hierarchical-agents.ts', 'Example 04 — Hierarchical Agents'],
  ['07-memory-augmented-agent.ts', 'Example 07 — Memory-Augmented Agent'],
  ['2y-supervisor-dynamic-workflow.ts', 'Example 2Y — Supervisor + Dynamic Workflow'],
])}

${section('weave-agent', 'weaveAgent — Creating an Agent', `
<p>The primary factory function. Returns an <code>Agent</code> that can be run with any input messages.</p>

${code('typescript', `import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';

const model = weaveAnthropicModel('claude-haiku-4-5-20251001');

const tools = weaveToolRegistry();
tools.register(weaveTool({
  name: 'get_price',
  description: 'Fetch the current stock price for a ticker symbol.',
  parameters: {
    type: 'object',
    required: ['ticker'],
    properties: { ticker: { type: 'string', description: 'Stock ticker, e.g. AAPL' } },
  },
  execute: async ({ ticker }) => {
    const price = await priceService.get(ticker);
    return JSON.stringify({ ticker, price, currency: 'USD' });
  },
}));

const agent = weaveAgent({
  name: 'market-analyst',
  model,
  tools,
  systemPrompt: 'You are a market analyst. Use tools to fetch live data before answering.',
  maxSteps: 8,
});

const ctx = weaveContext({ userId: 'alice', metadata: { sessionId: 'sess-001' } });
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is the current price of AAPL and MSFT?' }],
});

console.log(result.output);        // Final text answer
console.log(result.steps.length);  // Number of reasoning + tool-call steps`)}

<h4>weaveAgent options</h4>
${params([
  ['model', 'Model', 'required', 'Any <code>Model</code> instance. Obtained from provider packages or <code>weaveGetModel(key)</code>.'],
  ['tools', 'ToolRegistry', 'optional', 'Registry of tools the agent may call. Build with <code>weaveToolRegistry()</code>.'],
  ['workers', 'WorkerDefinition[]', 'optional', 'Enables supervisor mode. Agent auto-receives <code>delegate_to_worker</code>, <code>think</code>, and <code>plan</code> tools.'],
  ['systemPrompt', 'string', 'optional', 'System instructions prepended to every model call.'],
  ['maxSteps', 'number', 'optional', 'Hard cap on the number of tool-call iterations. Default: 20.'],
  ['name', 'string', 'optional', 'Agent identifier shown in traces and delegation messages.'],
  ['bus', 'EventBus', 'optional', 'Event bus for step-level observability. Every tool call and model response emits an event.'],
  ['memory', 'AgentMemory', 'optional', 'Attach a memory store to inject relevant context before each model call.'],
  ['policy', 'AgentPolicy', 'optional', 'Per-agent rate limiting, cost ceiling, and capability restrictions.'],
  ['additionalTools', 'ToolRegistry', 'optional', 'In supervisor mode: extra tools the supervisor calls directly (not delegated).'],
])}

<h4>AgentResult — what agent.run() returns</h4>
${returns([
  ['output', 'The agent\'s final text answer (last non-tool-call message content).'],
  ['steps', 'AgentStep[] — full reasoning trace (see below).'],
  ['usage', '{ inputTokens, outputTokens, totalTokens } — aggregate across all model calls.'],
  ['durationMs', 'Wall-clock time for the complete agent run.'],
  ['finishReason', '"max_steps" | "final_answer" | "error" — why the loop ended.'],
])}

<h4>AgentStep — individual loop iteration</h4>
${params([
  ['type', '"thinking" | "tool_call" | "tool_result" | "final_answer"', 'required', 'What kind of step this is.'],
  ['content', 'string', 'optional', 'Text content from the model (for thinking / final_answer steps).'],
  ['toolCall', 'ToolCallRecord', 'optional', 'Present for tool_call steps: <code>{ name, arguments, result, durationMs }</code>.'],
])}
`)}

${section('supervisor', 'Supervisor Mode', `
<p>When <code>workers</code> is provided, the agent becomes a supervisor. The WeaveIntel supervisor runtime automatically adds three tools to the supervisor's registry:</p>
<ul>
  <li><code>delegate_to_worker(worker, goal)</code> — runs a named worker agent and returns its output</li>
  <li><code>think(thought)</code> — structured chain-of-thought logging</li>
  <li><code>plan(steps)</code> — explicit decomposition before acting</li>
</ul>
<p>Workers run with complete isolation — their own model, tool registry, and step counter. The supervisor sees only their final <code>output</code> string.</p>

${code('typescript', `import { weaveAgent } from '@weaveintel/agents';
import type { WorkerDefinition } from '@weaveintel/agents';

// Worker 1: searches the web
const researchWorker: WorkerDefinition = {
  name: 'researcher',
  description: 'Searches the web and retrieves relevant information on any topic.',
  model: weaveAnthropicModel('claude-haiku-4-5-20251001'),
  tools: searchToolRegistry,
};

// Worker 2: writes polished reports
const writerWorker: WorkerDefinition = {
  name: 'writer',
  description: 'Takes structured notes and produces a well-formatted report.',
  model: weaveAnthropicModel('claude-sonnet-4-6'),
  // No tools — pure generation
};

const supervisor = weaveAgent({
  name: 'content-supervisor',
  model: weaveAnthropicModel('claude-sonnet-4-6'),
  workers: [researchWorker, writerWorker],
  systemPrompt:
    'You coordinate research and writing tasks. Delegate research to "researcher", ' +
    'then hand the findings to "writer" for a polished report. Synthesise the final output.',
  maxSteps: 6,
});

const ctx = weaveContext({ userId: 'bob' });
const result = await supervisor.run(ctx, {
  messages: [{ role: 'user', content: 'Write a report on the state of LLM inference in 2025.' }],
});

console.log(result.output);
// Shows reasoning: think → delegate_to_worker(researcher) → delegate_to_worker(writer) → final`)}

<h4>WorkerDefinition</h4>
${params([
  ['name', 'string', 'required', 'Identifier used in <code>delegate_to_worker({ worker: NAME })</code> calls.'],
  ['description', 'string', 'required', 'What this worker specialises in. The supervisor\'s model sees this to decide who to delegate to.'],
  ['model', 'Model', 'required', 'Independent model. Can differ from the supervisor\'s model — e.g. use a cheaper model for narrow tasks.'],
  ['tools', 'ToolRegistry', 'optional', 'Tools this worker may call. If omitted, worker is a pure-generation agent.'],
  ['maxSteps', 'number', 'optional', 'Step limit for this worker independently. Default: 10.'],
  ['systemPrompt', 'string', 'optional', 'System prompt for this worker. If omitted, built from its description.'],
])}

${callout('tip', '💡', 'Supervisor best practices.', 'Keep workers narrow and single-purpose. A researcher should only search; a writer should only write. Broad workers reduce delegation quality because the supervisor cannot predict their behaviour.')}
`)}

${section('agent-tools', 'Tool Binding', `
<p>Any tool registered on a <code>ToolRegistry</code> is available to the agent. The LLM sees the tool name, description, and parameter schema — write these carefully as they directly affect tool selection quality.</p>

${code('typescript', `import { weaveToolRegistry, weaveTool } from '@weaveintel/core';

const tools = weaveToolRegistry();

// Register individually
tools.register(weaveTool({
  name: 'send_slack_message',
  description:
    'Send a message to a Slack channel. Use this when the user asks to notify a team or send an update.',
  parameters: {
    type: 'object',
    required: ['channel', 'message'],
    properties: {
      channel: {
        type: 'string',
        description: 'Channel name without #, e.g. "engineering-alerts"',
      },
      message: { type: 'string' },
      urgent: { type: 'boolean', description: 'Whether to @here the channel' },
    },
  },
  requiresApproval: true,     // Human must approve before execution
  riskLevel: 'external-side-effect',
  tags: ['communication', 'slack'],
  execute: async ({ channel, message, urgent = false }, ctx) => {
    // ctx.userId, ctx.traceId, ctx.metadata available here
    await slackClient.post(channel, message, { mention: urgent ? 'here' : undefined });
    return \`Message sent to #\${channel}\`;
  },
}));

// Or register a pre-built pack (e.g. tools-time)
import { createTimeTools } from '@weaveintel/tools/time';
createTimeTools({ defaultTimezone: 'UTC' }).forEach(t => tools.register(t));`)}

${callout('warn', '⚠️', 'Tool description quality matters.', 'The model uses descriptions to decide <em>when</em> to call a tool. Vague descriptions like "does stuff" cause missed calls. Start with the trigger: <em>"Use this when…"</em> or <em>"Call this to…"</em>')}

<h4>Tool output format</h4>
<p>Tools must return a <code>string</code> or <code>ToolOutput = { content: string; isError?: boolean }</code>. For structured data, always <code>JSON.stringify</code> the result — the model parses it from the string:</p>
${code('typescript', `execute: async ({ query }) => {
  const results = await db.search(query);
  // Return structured data as a JSON string
  return JSON.stringify({ count: results.length, items: results });
}`)}
`)}

${section('agent-memory', 'Memory Integration', `
<p>Attach a memory store to give the agent cross-session context. Before each model call, relevant memories are retrieved and injected as additional context messages.</p>

${code('typescript', `import { weaveConversationMemory, weaveSemanticMemory } from '@weaveintel/memory';
import { weaveAgent } from '@weaveintel/agents';

// weaveConversationMemory implements AgentMemory — pass it straight to the agent
const memory = weaveConversationMemory({ maxHistory: 40 });

const agent = weaveAgent({
  model,
  tools,
  memory,   // the agent reads/writes conversation history through this
});

// For long-term recall, keep a semantic memory alongside and query it yourself:
const longTerm = weaveSemanticMemory(embeddingModel, myStore);
await longTerm.store(ctx, 'User is based in Berlin and prefers metric units.');
const relevant = await longTerm.recall(ctx, 'where is the user based?', 5);`)}
`)}

${section('agent-events', 'Event Bus & Observability', `
<p>Pass an <code>EventBus</code> to stream every agent step in real time. Events include model calls, tool invocations, and step completions.</p>

${code('typescript', `import { weaveEventBus, EventTypes } from '@weaveintel/core';

const bus = weaveEventBus();

// Stream steps to a client (e.g. SSE endpoint). All payload fields live on event.data.
bus.on(EventTypes.AgentStepEnd, (event) => {
  if (event.data.type === 'tool_call') {
    console.log(\`Tool step #\${event.data.stepIndex} on agent \${event.data.agent}\`);
  }
  if (event.data.type === 'final_answer') {
    console.log(\`Answer: \${event.data.content}\`);
  }
});

bus.on(EventTypes.ModelRequestEnd, (event) => {
  const usage = event.data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
  console.log(\`Tokens: \${usage?.inputTokens} in / \${usage?.outputTokens} out\`);
});

const agent = weaveAgent({ model, tools, bus });`)}
`)}

${section('agent-strategy', 'Agent Strategy Settings', `
<p>Think of <strong>Agent Strategy Settings</strong> as the global dial board for how all agents behave by default. Rather than hardcoding values like "how confident must an agent be before acting?" in every agent definition, you set them once in the database and every agent picks them up automatically.</p>

${callout('info', '⚙️', 'One row to rule them all.', 'A single <code>global</code> row in the <code>agent_strategy_settings</code> table sets the defaults for all agents. You can also create <em>tenant-scoped</em> rows that override the global defaults for specific tenants — useful when enterprise customers need stricter policies than your general user base.')}

<p>Four new controls were added in mid-2026 to cover human-in-the-loop approval, delegation depth, tool confirmation, and memory lifecycle. Three other key behaviours are now <em>on by default</em>: <code>a2a_enabled</code>, <code>reflect_enabled</code>, and <code>supervisor_parallel_delegation</code>.</p>

${featureCards([
  ['Human-in-the-loop (HITL)', 'The <code>hitl_threshold</code> field (0–1) is a risk score cutoff. When an agent\'s risk assessment exceeds this score, the system pauses and asks a human to approve before proceeding. Default: 0.75 — meaning anything riskier than 75% triggers approval.'],
  ['Agent hop limit', '<code>max_agent_hops</code> caps how deep the chain of AI-to-AI delegation can go. If agent A asks agent B, who asks agent C, that is 2 hops. Limiting this prevents runaway delegation chains that burn tokens without useful output. Default: 5.'],
  ['Tool confirmation level', '<code>tool_confirmation_level</code> controls which tool calls require explicit user confirmation before running. <code>\'none\'</code> — never ask; <code>\'medium\'</code> — ask for write operations; <code>\'high-risk-only\'</code> — ask only for destructive or privileged tools. Default: <code>\'high-risk-only\'</code>.'],
  ['Memory policy', '<code>memory_policy</code> decides how the agent\'s working memory is handled across turns. <code>\'none\'</code> — start fresh every turn (great for privacy-sensitive deployments); <code>\'session\'</code> — remember within a session, forget when it ends; <code>\'persistent\'</code> — remember across sessions indefinitely. Default: <code>\'session\'</code>.'],
])}

${code('typescript', `import { SQLiteAdapter } from '@weaveintel/geneweave-api';

const db = new SQLiteAdapter('./geneweave.db');
await db.initialize();

// Read the global defaults
const settings = await db.getAgentStrategySettings('global');
console.log(settings?.hitl_threshold);          // 0.75
console.log(settings?.max_agent_hops);          // 5
console.log(settings?.tool_confirmation_level); // 'high-risk-only'
console.log(settings?.memory_policy);           // 'session'

// These three flags are ON by default as of mid-2026
console.log(settings?.a2a_enabled);                   // 1 — agents may delegate to other agents
console.log(settings?.supervisor_parallel_delegation); // 1 — supervisor calls workers in parallel
console.log(settings?.reflect_enabled);               // 1 — agents self-review their answers

// Tighten settings for a high-stakes deployment
await db.updateAgentStrategySettings('global', {
  hitl_threshold:         0.85,       // require human approval for anything risky
  tool_confirmation_level: 'medium',  // also confirm write operations
});

// Create a per-tenant override (tenant row wins over global)
// Insert via your DB adapter or migration — same table, scope='tenant'

// List all rows (global + any tenant-scoped overrides)
const all = await db.listAgentStrategySettings();
console.log(all.map(s => \`\${s.id} (\${s.scope})\`));
// e.g. ['global (global)', 'acme-corp (tenant)']`)}

<h4>Full field reference</h4>
${params([
  ['hitl_threshold', 'number (0–1)', 'Agent control', 'Risk score at which human approval is required before the agent acts. 0 = always ask a human; 1 = never ask; 0.75 = ask when risk is high. Default: 0.75.'],
  ['max_agent_hops', 'number', 'Agent control', 'Maximum length of an agent delegation chain (A→B→C = 2 hops). Exceeding this hard-stops the run to prevent loops. Default: 5.'],
  ['tool_confirmation_level', 'string', 'Agent control', 'When to confirm before calling a tool. <code>\'none\'</code> | <code>\'medium\'</code> | <code>\'high-risk-only\'</code>. Default: <code>\'high-risk-only\'</code>.'],
  ['memory_policy', 'string', 'Agent control', 'Cross-turn memory retention. <code>\'none\'</code> | <code>\'session\'</code> | <code>\'persistent\'</code>. Default: <code>\'session\'</code>.'],
  ['a2a_enabled', 'number (0|1)', 'Core', 'Whether agents may delegate tasks to other agents via the A2A bus. Default: 1 (enabled since mid-2026).'],
  ['reflect_enabled', 'number (0|1)', 'Core', 'Whether agents review and optionally revise their own answer before returning it. Default: 1 (enabled since mid-2026).'],
  ['reflect_max_revisions', 'number', 'Core', 'Maximum self-revision rounds per response. Default: 1.'],
  ['verify_enabled', 'number (0|1)', 'Core', 'Whether a separate verification step scores the agent\'s answer before returning. Default: 0 (opt-in).'],
  ['supervisor_parallel_delegation', 'number (0|1)', 'Core', 'Whether a supervisor may dispatch multiple worker tasks simultaneously. Default: 1 (enabled since mid-2026).'],
  ['parallel_tool_calls', 'number (0|1)', 'Core', 'Whether the agent may call multiple tools in a single model turn. Default: 1.'],
  ['context_strategy', 'string | null', 'Core', 'How long histories are compressed: <code>\'sliding-window\'</code> | <code>\'summarise\'</code> | <code>\'hierarchical\'</code> | null (no compression).'],
  ['tool_retry_max_attempts', 'number', 'Core', 'How many times to retry a failed tool call before giving up. Default: 3.'],
])}

${callout('tip', '💡', 'Tenant overrides.', 'Create a row with <code>scope=\'tenant\'</code> and the relevant <code>tenant_id</code> to override defaults for one customer. The agent runtime merges global defaults with tenant rows — the tenant value wins on any field that is set. This lets you give enterprise customers stricter HITL thresholds or a different memory policy without touching the global defaults.')}
`)}`;
}

// ── Section: Workflows ────────────────────────────────────────────────────

function sWorkflows(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/workflows</span></div>
  <h1 class="pkg-title">Workflows</h1>
  <p class="pkg-desc">Durable, deterministic multi-step orchestration. Every step is checkpointed — runs survive process restarts, support human approval gates, retry with backoff, parallel branches, and runtime-generated sub-graphs.</p>
</div>

${callout('info', '⚙️', 'Workflows vs Agents.', 'Use <strong>Workflows</strong> when every step must be auditable, retryable, and deterministic. Use <strong>Agents</strong> when the LLM must decide what to do at runtime. The two compose: a workflow step can invoke an agent, and an agent can trigger a workflow.')}

${exlinks([
  ['13-workflow-engine.ts', 'Example 13 — Workflow Engine with Guardrails'],
  ['15-workflow-control-flow.ts', 'Example 15 — Control Flow (W1)'],
  ['16-workflow-reliability.ts', 'Example 16 — Reliability (W2)'],
  ['17-workflow-state-data.ts', 'Example 17 — State & Data (W3)'],
  ['18-workflow-durability.ts', 'Example 18 — Durability & Recovery (W4)'],
  ['19-workflow-governance.ts', 'Example 19 — Governance (W5)'],
  ['21-workflow-observability.ts', 'Example 21 — Observability (W6)'],
  ['2x-dynamic-workflows.ts', 'Example 2X — Dynamic Graphs (W7)'],
])}

${section('wf-engine', 'Engine Setup', `
<p>The <code>DefaultWorkflowEngine</code> wires together all stores, registries, and policies. Create one instance per application. Every method is async and safe to call concurrently.</p>

${code('typescript', `import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  createNoopResolver,
  createScriptResolver,
  InMemoryWorkflowRunRepository,
  InMemoryCheckpointStore,
  JsonFileWorkflowRunRepository,
  JsonFileCheckpointStore,
} from '@weaveintel/workflows';

// Development — in-memory, no persistence
const devEngine = new DefaultWorkflowEngine({
  resolverRegistry: myResolverRegistry,
});

// Production — file-backed persistence
const engine = new DefaultWorkflowEngine({
  runRepository:   new JsonFileWorkflowRunRepository('./data/runs.json'),
  checkpointStore: new JsonFileCheckpointStore('./data/checkpoints.json'),
  resolverRegistry: resolverRegistry,
  defaultPolicy: {
    maxSteps:          100,
    costCeiling:       5.00,      // USD — fail run when exceeded
    maxConcurrentRuns: 10,
    maxExpansionDepth: 3,         // W7 dynamic graphs
    maxGeneratedSteps: 50,
  },
  spanEmitter: mySpanEmitter,     // W6 observability
  auditLog: myAuditLog,           // W4 audit trail
  rateLimiter: myRateLimiter,     // W5 rate limiting
});

// Register domain handlers directly
engine.registerHandler('send-email', async (vars, config) => {
  await emailService.send(vars['to'] as string, config['subject'] as string);
  return { sent: true };
});

// Define and start a run
await engine.createDefinition(def);
const run = await engine.startRun(def.id, { orderId: 'ORD-001', amount: 99.99 });
console.log(run.status); // 'completed' | 'paused' | 'failed'`)}

<h4>WorkflowEngineOptions</h4>
${params([
  ['runRepository', 'WorkflowRunRepository', 'optional', 'Stores run records. Default: InMemoryWorkflowRunRepository.'],
  ['checkpointStore', 'CheckpointStore', 'optional', 'Stores step-level state snapshots for restart recovery.'],
  ['definitionStore', 'WorkflowDefinitionStore', 'optional', 'Persists workflow definitions independently of the engine.'],
  ['resolverRegistry', 'HandlerResolverRegistry', 'optional', 'Maps handler refs (e.g. <code>tool:send-email</code>) to async functions.'],
  ['defaultPolicy', 'WorkflowPolicy', 'optional', 'Engine-wide policy applied to all runs unless overridden per-definition.'],
  ['spanEmitter', 'WorkflowSpanEmitter', 'optional', 'W6: emits execution spans for tracing.'],
  ['auditLog', 'WorkflowAuditLog', 'optional', 'W4: records every state transition as an immutable audit event.'],
  ['rateLimiter', 'WorkflowRateLimiter', 'optional', 'W5: token-bucket rate limiting per workflow definition.'],
  ['runQueue', 'WorkflowRunQueue', 'optional', 'W5: priority queue for concurrent run slot management.'],
  ['costMeter', 'CostMeter', 'optional', 'Accumulates per-run cost from step handlers.'],
  ['humanTaskQueue', 'HumanTaskQueue', 'optional', 'Backend for human-task steps (approval queues).'],
  ['bus', 'EventBus', 'optional', 'Event bus for run-level lifecycle events.'],
])}
`)}

${section('wf-builder', 'Defining Workflows', `
<p>Use the fluent <code>defineWorkflow()</code> / <code>WorkflowBuilder</code> API to declare steps. The builder validates step references at build time.</p>

${code('typescript', `import { defineWorkflow } from '@weaveintel/workflows';

const def = defineWorkflow('Customer Onboarding')
  .setId('customer-onboarding-v2')
  .setVersion('2.0.0')
  .setDescription('Validates, enriches, and activates new customer accounts')
  .setPolicy({ maxSteps: 30, costCeiling: 1.00 })

  // Deterministic: pure computation or external call
  .addStep({
    id: 'validate',
    name: 'Validate Input',
    type: 'deterministic',
    handler: 'validate-customer',
    next: 'enrich',
    retries: 2,
    timeout: 5000,
    onError: 'handle-validation-error',
  })

  // Agentic: LLM-driven, output may vary
  .addStep({
    id: 'enrich',
    name: 'Enrich Profile (AI)',
    type: 'agentic',
    handler: 'agent:customer-enricher',  // resolver-kind ref
    next: 'approve',
    retries: 1,
    outputSchema: {                        // W3: validate output shape
      type: 'object',
      required: ['riskScore', 'segment'],
    },
    outputSchemaAction: 'fail',
  })

  // Human gate: pauses until a human approves/rejects
  .humanTask('approve', 'Manager Approval', {
    taskType: 'approval',
    title: 'Approve new customer?',
    priority: 'high',
    next: 'activate',
  })

  .addStep({ id: 'activate', name: 'Activate', type: 'deterministic', handler: 'activate-customer' })
  .addStep({ id: 'handle-validation-error', name: 'Error Handler', type: 'deterministic', handler: 'log-error' })
  .build();`)}
`)}

${section('wf-steps', 'All Step Types', `
<p>Every step type is designed for a specific execution pattern. Choosing the right type ensures the engine applies the correct execution semantics.</p>

${subsection('step-deterministic', 'deterministic', `
<p>Pure computation, external API calls, data transforms. The engine retries on failure and checkpoints after success.</p>
${code('typescript', `.addStep({
  id: 'call-payment-api',
  name: 'Charge Card',
  type: 'deterministic',
  handler: 'charge-card',
  next: 'send-receipt',
  retries: 3,
  retryDelayMs: 1000,
  retryBackoffMultiplier: 2,   // 1s → 2s → 4s
  retryMaxDelayMs: 30000,
  retryJitter: true,
  timeout: 10000,              // ms — step timeout (not retry timeout)
  idempotencyKey: '{{vars.orderId}}:payment',  // W2: deduplication
  fallbackHandler: 'use-cached-charge',        // Run on final failure
  onError: 'payment-failed',                   // Route here on unrecoverable error
  skipIf: '{{vars.alreadyPaid}}',              // JSONLogic expression
})`)}
`)}

${subsection('step-agentic', 'agentic', `
<p>LLM-driven step. Output is non-deterministic; the engine still checkpoints and retries on hard failures.</p>
${code('typescript', `.addStep({
  id: 'classify',
  name: 'Classify Order',
  type: 'agentic',
  handler: 'prompt:classify-order@v2',  // Resolver: executes a versioned prompt
  next: 'process',
  outputSchema: { type: 'object', required: ['category', 'confidence'] },
  outputSchemaAction: 'warn',   // 'fail' | 'warn' | 'coerce'
  maskFields: ['creditCard', 'ssn'],  // W3: mask PII in stored output
})`)}
`)}

${subsection('step-condition', 'condition', `
<p>Boolean branch. The handler must return a truthy or falsy value; the engine routes to <code>next[0]</code> (true) or <code>next[1]</code> (false).</p>
${code('typescript', `.addStep({
  id: 'is-premium',
  name: 'Is Premium Customer?',
  type: 'condition',
  handler: 'check-premium',   // Returns true/false
  next: ['process-premium', 'process-standard'],
})`)}
`)}

${subsection('step-switch', 'switch', `
<p>Multi-case routing. The handler returns a string case key; config.cases maps it to a step ID. Supports a <code>default</code> fallthrough.</p>
${code('typescript', `.switch('route-order', 'Route by Order Type', {
  handler: 'classify-order',
  cases: {
    digital:     'process-digital',
    physical:    'process-physical',
    subscription: 'process-subscription',
    default:     'process-unknown',
  },
})`)}
`)}

${subsection('step-forEach', 'forEach', `
<p>Iterates over an array. The iterator handler returns <code>string[] | object[]</code>; the body handler runs once per item. Supports bounded concurrency.</p>
${code('typescript', `.forEach('process-items', 'Process Line Items', {
  handler: 'list-items',       // Returns array to iterate
  bodyHandler: 'process-item', // Runs per item
  maxConcurrency: 5,           // Run up to 5 items in parallel
  next: 'summarise',
  config: { batchSize: 100 },
})

// Body handler receives:
interface LineItem { id: string; quantity: number }
engine.registerHandler('process-item', async (vars) => {
  const item = vars['__item'] as LineItem;   // Current item
  const index = vars['__itemIndex'] as number;
  return { processed: item.id, qty: item.quantity };
});`)}
`)}

${subsection('step-parallel', 'parallel (lanes)', `
<p>Named concurrent handlers. Results are keyed by lane name and merged into state variables. All lanes run simultaneously.</p>
${code('typescript', `.parallelLanes('enrich', 'Parallel Enrichment', {
  lanes: {
    pricing:   'fetch-pricing',
    inventory: 'check-inventory',
    credit:    'check-credit-score',
  },
  next: 'evaluate',
})

// Each handler runs concurrently. Results in state as:
// vars['__step_enrich'] = { pricing: {...}, inventory: {...}, credit: {...} }`)}
`)}

${subsection('step-fork-join', 'fork / join', `
<p>Fork fires N independent branch handlers concurrently (like parallel lanes but step-based). Join aggregates when all branches complete.</p>
${code('typescript', `.fork('fan-out', 'Fan Out to Regions', {
  branches: {
    us_east:  'process-us-east',
    us_west:  'process-us-west',
    eu_west:  'process-eu-west',
  },
  next: 'aggregate',
})

.join('aggregate', 'Aggregate Results', {
  forkStepId: 'fan-out',
  branches: ['us_east', 'us_west', 'eu_west'],
  next: 'done',
})`)}
`)}

${subsection('step-wait', 'wait', `
<p>Pauses the run until explicitly resumed via <code>engine.resumeRun(runId)</code> or automatically after <code>wakeAfterMs</code>.</p>
${code('typescript', `.wait('await-payment', 'Wait for Payment Confirmation', {
  next: 'fulfil',
  wakeAfterMs: 86_400_000,  // Auto-resume after 24h if not already resumed
})

// Resume from an external webhook:
app.post('/webhook/payment-confirmed', async (req) => {
  const { runId, payload } = req.body;
  await engine.resumeRun(runId, { paymentId: payload.id });
});`)}
`)}

${subsection('step-human-task', 'human-task', `
<p>Creates a structured human task in the queue, pauses the run, and resumes when the human submits a decision.</p>
${code('typescript', `.humanTask('review-kyc', 'KYC Review', {
  taskType: 'review',
  title: 'Review KYC documents for {{vars.customerName}}',
  description: 'Check government-issued ID and proof of address.',
  priority: 'high',
  next: 'post-review',
})

// Complete the task (e.g. from admin UI):
await engine.completeHumanTask(taskId, {
  decision: 'approved',
  data: { reviewerNotes: 'Documents verified.' },
});`)}
`)}

${subsection('step-dynamic', 'dynamic (W7)', `
<p>The handler returns a <code>DynamicExpansion</code> — a runtime-generated sub-graph that the engine validates, splices in, and executes before rejoining the main flow.</p>
${code('typescript', `import type { DynamicExpansion } from '@weaveintel/core';

engine.registerHandler('ai-planner', async (vars) => {
  const tasks = vars['tasks'] as string[];

  const expansion: DynamicExpansion = {
    steps: tasks.map((task, i) => ({
      id: \`task-\${i}\`,
      name: task,
      type: 'deterministic',
      handler: 'execute-task',
    })),
    entry: 'task-0',
    rejoin: 'summarise',  // Return to this step when sub-graph ends
  };
  return expansion;
});

.dynamic('plan', 'AI-Generated Plan', {
  handler: 'ai-planner',
  next: 'summarise',
})`)}

${callout('warn', '⚠️', 'Governance.', 'Every DynamicExpansion passes through <code>validateExpansion</code> before execution. Violations throw <code>WorkflowExpansionError</code> with a typed <code>code</code> field: <code>MAX_EXPANSION_DEPTH</code>, <code>MAX_GENERATED_STEPS</code>, <code>ID_COLLISION</code>, <code>DISALLOWED_HANDLER_KIND</code>, <code>LINT_ERROR</code>.')}
`)}
`)}

${section('wf-resolvers', 'Handler Resolvers', `
<p>Resolvers map string handler references (like <code>tool:my-tool</code>) to async handler functions at run startup. This decouples workflow definitions from concrete implementations.</p>

${code('typescript', `import {
  HandlerResolverRegistry,
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
  createPromptResolver,
  createAgentResolver,
  createMcpResolver,
  createSubWorkflowResolver,
  createPlannerResolver,   // W7 only — opt-in
} from '@weaveintel/workflows';

const reg = new HandlerResolverRegistry();

// Built-ins (no deps)
reg.register(createNoopResolver());    // handler: 'noop'
reg.register(createScriptResolver());  // handler: 'script:return vars.x * 2'

// Dependency-injected
reg.register(createToolResolver({
  getTool: async (key) => toolMap.get(key),  // handler: 'tool:send-email'
}));

reg.register(createPromptResolver({
  executePrompt: async (key, vars, cfg) =>   // handler: 'prompt:summarise@v2'
    promptRunner.execute(key, vars, cfg),
}));

reg.register(createAgentResolver({
  invokeAgent: async (key, vars, cfg) =>     // handler: 'agent:classifier'
    agentRunner.run(key, vars, cfg),
}));

reg.register(createMcpResolver({
  callMcp: async (server, method, input) =>  // handler: 'mcp:my-server:my-method'
    mcpClient.call(server, method, input),
}));

reg.register(createSubWorkflowResolver({
  resolveWorkflowKey: async (key) => db.getWorkflowId(key),
  startRun: async (id, input) => engine.startRun(id, input),
}));

// W7 planner (opt-in, requires LLM)
reg.register(createPlannerResolver({
  plan: async (goal, ctx) => llm.generateExpansion(goal, ctx),
}));`)}

<h4>Handler reference syntax</h4>
${typeTable([
  ['noop', 'No-op: returns <code>config</code>. Useful as a placeholder or terminal step.'],
  ['script:&lt;body&gt;', 'Inline JS. Body has access to <code>variables</code> and <code>config</code>. Must <code>return</code> a value. Trusted operators only.'],
  ['tool:&lt;toolKey&gt;', 'Looks up tool by key, forwards handler input as tool input.'],
  ['prompt:&lt;key&gt;@&lt;version&gt;', 'Renders and executes a registered prompt. <code>@version</code> is optional.'],
  ['agent:&lt;agentKey&gt;', 'Runs a registered agent, forwards variables as task input.'],
  ['mcp:&lt;server&gt;:&lt;method&gt;', 'Calls a method on an MCP server. Input forwarded as method args.'],
  ['subworkflow:&lt;key&gt;', 'Starts a child workflow run synchronously. Returns the child run record.'],
  ['plan:&lt;goal&gt;', 'W7 only. Calls the planner resolver with the goal string.'],
])}
`)}

${section('wf-policy', 'WorkflowPolicy', `
<p>Policies apply engine-wide (via <code>defaultPolicy</code>) or per-definition (via <code>setPolicy()</code>). Per-definition takes precedence.</p>

${params([
  ['maxSteps', 'number', 'optional', 'Hard cap on steps per run. Exceeding it fails the run with "Exceeded max steps". Default: 100.'],
  ['costCeiling', 'number', 'optional', 'USD ceiling. Run fails with cost_ceiling_exceeded when the step cost meter exceeds this.'],
  ['maxConcurrentRuns', 'number', 'optional', 'Max simultaneous runs for this definition. Excess runs queue in the RunQueue (W5).'],
  ['maxRetries', 'number', 'optional', 'Default retry count for all steps. Per-step retries override this.'],
  ['maxStepTimeoutMs', 'number', 'optional', 'Default timeout for all steps in ms. Per-step timeout overrides this.'],
  ['maxExpansionDepth', 'number', 'optional', 'W7: max recursive DynamicExpansion nesting. Default: 5.'],
  ['maxGeneratedSteps', 'number', 'optional', 'W7: cumulative generated steps budget per run. No default.'],
  ['dynamicHandlerKinds', 'string[]', 'optional', "W7: resolver kinds allowed in generated steps. Default: ['noop','tool','prompt','agent','mcp']. 'script' and 'subworkflow' blocked."],
])}
`)}

${section('wf-phases', 'Phase Capability Reference', `
${featureCards([
  ['W1 — Control Flow', 'switch, forEach, parallelLanes, fork/join, onError, skipIf'],
  ['W2 — Reliability', 'idempotency keys, circuit breakers, bulkheads, exponential backoff'],
  ['W3 — Data Layer', 'output schema validation, PII masking, payload offload to object store'],
  ['W4 — Durability', 'step-level locking, durable sleep, full audit log, replay from checkpoint'],
  ['W5 — Governance', 'rate limiting, concurrency queue, admin API (list/cancel/patch runs)'],
  ['W6 — Observability', 'span emitter, workflow linter, getWorkflowGraph, replay recorder'],
  ['W7 — Dynamic Graphs', 'dynamic step type, DynamicExpansion, createPlannerResolver, validateExpansion'],
])}
`)}`;
}

// ── Sections: Models, Prompts (combined for size) ─────────────────────────

function sModels(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/core/models</span></div>
  <h1 class="pkg-title">Models</h1>
  <p class="pkg-desc">Provider-agnostic model factory with named registration, capability-based routing, middleware, and cost tracking. Supports text generation, embeddings, image, and audio models.</p>
</div>

${exlinks([
  ['11-anthropic-provider.ts', 'Example 11 — Anthropic Provider'],
  ['14-smart-routing.ts', 'Example 14 — Smart Model Routing'],
])}

${section('models-register', 'Registration', `
${code('typescript', `import { weaveRegisterModel, weaveModel } from '@weaveintel/core/models';
import { weaveContext } from '@weaveintel/core';

// Register a provider factory once (provider packages usually do this for you)
weaveRegisterModel('anthropic', (modelId, options) => weaveAnthropicModel(modelId, options));
weaveRegisterModel('openai',    (modelId, options) => weaveOpenAIModel(modelId, options));
weaveRegisterModel('ollama',    (modelId, options) => weaveOllamaModel(modelId, options));

// Create model instances anywhere via the registered providers
const model = weaveModel({ provider: 'anthropic', model: 'claude-sonnet-4-6' });

const ctx = weaveContext();
const result = await model.generate(ctx, {
  messages: [{ role: 'user', content: 'Explain quantum entanglement in one sentence.' }],
  temperature: 0.2,
  maxTokens: 150,
});
console.log(result.content);
console.log(result.usage); // { inputTokens, outputTokens, totalTokens }`, ['@weaveintel/core'])}
`)}

${section('models-routing', 'Smart Routing', `
${code('typescript', `import { SmartModelRouter } from '@weaveintel/routing';

const router = new SmartModelRouter({
  candidates: [
    { modelId: 'claude-haiku-4-5-20251001', providerId: 'anthropic', capabilities: ['text', 'tool_calling'] },
    { modelId: 'claude-sonnet-4-6',         providerId: 'anthropic', capabilities: ['text', 'tool_calling', 'vision'] },
    { modelId: 'llama3.2',                  providerId: 'ollama',    capabilities: ['text'] },
  ],
  costs: [
    { modelId: 'claude-haiku-4-5-20251001', providerId: 'anthropic', inputCostPer1M: 0.25, outputCostPer1M: 1.25 },
    { modelId: 'claude-sonnet-4-6',         providerId: 'anthropic', inputCostPer1M: 3.00, outputCostPer1M: 15.0 },
    { modelId: 'llama3.2',                  providerId: 'ollama',    inputCostPer1M: 0,    outputCostPer1M: 0 },
  ],
});

// route(request, policy) picks the best model for the policy + constraints
const decision = await router.route(
  { prompt: 'Summarise this contract.' },
  {
    id: 'cheap-with-tools',
    name: 'Cheapest tool-capable model',
    strategy: 'cost-optimized',
    enabled: true,
    constraints: { requiredCapabilities: ['text', 'tool_calling'], maxCostPerRequest: 1.0 },
  },
);
console.log(decision.modelId, decision.providerId, decision.reason);`)}
`)}

${section('models-providers', 'Provider Reference', `
<table class="ptable"><thead><tr><th>Package</th><th>Factory</th><th>Current Models</th></tr></thead><tbody>
<tr><td><code>@weaveintel/provider-anthropic</code></td><td><code>weaveAnthropicModel(id)</code></td><td>claude-haiku-4-5-20251001, claude-sonnet-4-6, claude-opus-4-8, claude-fable-5</td></tr>
<tr><td><code>@weaveintel/provider-openai</code></td><td><code>weaveOpenAIModel(id)</code></td><td>gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, o3, o4-mini, text-embedding-3-*</td></tr>
<tr><td><code>@weaveintel/provider-google</code></td><td><code>weaveGoogleModel(id)</code></td><td>gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash, text-embedding-004</td></tr>
<tr><td><code>@weaveintel/provider-ollama</code></td><td><code>weaveOllamaModel(id)</code></td><td>Any model served by Ollama (llama3.3, llama4-scout, qwen3:30b-a3b, phi4, gemma3:27b, codestral:22b, deepseek-r1, mistral-nemo, etc.)</td></tr>
<tr><td><code>@weaveintel/provider-llamacpp</code></td><td><code>weaveLlamaCppModel(id)</code></td><td>Local GGUF models via llama.cpp server</td></tr>
</tbody></table>

${callout('warn', '⚠️', 'Deprecated model IDs.', 'The following model IDs are <strong>disabled</strong> in the model registry as of mid-2026 — they still exist in the DB but are not routed to. Replace them before using: <code>gemini-1.5-pro</code>, <code>gemini-1.5-flash</code> (succeeded by Gemini 2.5 series); <code>llama3</code>, <code>phi3</code>, <code>gemma2</code>, <code>qwen2.5</code> (succeeded by newer Ollama builds). Using a deprecated ID returns a <code>ModelNotRoutableError</code>.')}

<h4>Model capability flags</h4>
<p>Each model row carries boolean capability flags used by the smart router to select the right model for a task. Key flags:</p>
${typeTable([
  ['supports_vision', 'Model can interpret images. All current Anthropic, OpenAI, and Google models have this set.'],
  ['supports_thinking', 'Model supports extended chain-of-thought reasoning (o3, o4-mini, claude-opus-4-8, gemini-2.5-*).'],
  ['supports_json_mode', 'Model reliably emits valid JSON when instructed. All GPT-4 and Claude 3.5+ models have this set.'],
  ['supports_computer_use', 'Model can interpret screenshots and emit pointer/keyboard actions (Anthropic claude-* series with computer use enabled).'],
  ['supports_long_context', 'Model reliably handles >200K token contexts (gemini-2.5-pro at 1M tokens, gpt-4.1 at 1M tokens, claude-* at 200K tokens).'],
])}
`)}`;
}

function sPrompts(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/prompts</span></div>
  <h1 class="pkg-title">Prompts</h1>
  <p class="pkg-desc">Version-controlled prompt management with rendering, output contract validation, A/B experiments, LLM-graded evaluation, and structured frameworks (RTCE, CRITIQUE, JUDGE).</p>
</div>

${exlinks([
  ['17-prompt-management.ts', 'Example 17 — Prompt Management & A/B Testing'],
])}

${section('prompts-registry', 'Registry & Versioning', `
${code('typescript', `import { InMemoryPromptRegistry, renderPromptVersion } from '@weaveintel/prompts';
import type { PromptDefinition, TemplatePromptVersion } from '@weaveintel/core';

const registry = new InMemoryPromptRegistry();

const definition: PromptDefinition = {
  id: 'summarise-article',
  name: 'Summarise Article',
  currentVersion: '2.1.0',
  tags: ['summarisation', 'editorial'],
};

const version: TemplatePromptVersion = {
  id: 'summarise-article@2.1.0',
  promptId: 'summarise-article',
  version: '2.1.0',
  kind: 'template',
  createdAt: new Date().toISOString(),
  template: \`You are a professional editor.

Summarise the following article in {{language}} in no more than {{maxWords}} words.
Focus on: {{focusAreas}}.

Article:
{{article}}\`,
  variables: [
    { name: 'language',   type: 'string', required: false, defaultValue: 'English' },
    { name: 'maxWords',   type: 'number', required: true },
    { name: 'focusAreas', type: 'string', required: true },
    { name: 'article',    type: 'string', required: true },
  ],
};

// register(definition, version) is async
await registry.register(definition, version);

// get() is async and returns the version (or null)
const stored = await registry.get('summarise-article', '2.1.0');
const rendered = renderPromptVersion(stored!, {
  language: 'English',
  maxWords: 150,
  focusAreas: 'key findings, business impact',
  article: articleText,
});

// Use in a model call
const result = await model.generate({
  messages: [{ role: 'user', content: rendered }],
});`)}
`)}

${section('prompts-contracts', 'Output Contracts', `
<p>Contracts validate or repair model output against a schema — JSON structure, Markdown formatting, code fences, max length, forbidden phrases.</p>
${code('typescript', `import { createContract, DefaultCompletionValidator } from '@weaveintel/core/contracts';

// A contract declares its name, output schema, and acceptance criteria.
const contract = createContract({
  name: 'sentiment-classification',
  outputSchema: {
    type: 'object',
    required: ['sentiment', 'confidence', 'reason'],
    properties: {
      sentiment:  { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason:     { type: 'string', maxLength: 200 },
    },
  },
  acceptanceCriteria: [
    { id: 'schema', description: 'Output matches the JSON schema', type: 'schema', required: true },
  ],
});

const validator = new DefaultCompletionValidator();
const report = await validator.validate(llmOutput, contract);

// validate() returns a CompletionReport (status + per-criterion results)
if (report.status !== 'fulfilled') {
  console.log(report.results.filter(r => !r.passed));  // failing criteria
} else {
  console.log('confidence', report.confidence);
}`)}
`)}

${section('prompts-frameworks', 'Prompt Frameworks', `
${featureCards([
  ['RTCE', 'Role + Task + Context + Examples. Best for structured single-turn prompts where role clarity matters.'],
  ['FULL', 'All structured fields including persona, constraints, chain-of-thought instructions, and output format.'],
  ['CRITIQUE', 'Self-critique loop: model produces initial output → critiques it → revises. Improves quality on complex tasks.'],
  ['JUDGE', 'LLM-as-judge rubric. Evaluates a piece of text against named criteria with numeric scores and reasoning.'],
])}
${code('typescript', `import { renderFramework, FRAMEWORK_RTCE } from '@weaveintel/prompts';

// renderFramework(framework, contentMap) assembles the sections into one prompt
const result = renderFramework(FRAMEWORK_RTCE, {
  role:         'You are a senior security analyst.',
  task:         'Review the following code diff for security vulnerabilities.',
  context:      'This is a Node.js API endpoint that handles file uploads.',
  expectations: 'Flag path traversal, injection, and auth issues; rank by severity.',
});

const prompt = result.text;`, ['@weaveintel/prompts'])}
`)}

${section('prompts-execution', 'Execution Pipeline', `
<p><code>resolvePromptRecordForExecution</code> selects the right prompt version for a given key — resolving active experiments, selecting weighted variants, falling back through published versions to a base prompt.</p>

${code('typescript', `import {
  resolvePromptRecordForExecution,
  executePromptRecord,
} from '@weaveintel/prompts';

// Feed the prompt row + its versions/experiments (loaded from your DB).
// Resolution order: requested override → active experiment variant → active published → latest → base
const resolved = resolvePromptRecordForExecution({
  prompt:      promptRecord,
  versions:    promptVersions,
  experiments: promptExperiments,
  options: {
    requestedVersion: undefined,   // explicit override (e.g. from admin)
    assignmentKey:    'alice',     // deterministic experiment cohort assignment
  },
});

// resolved.meta.resolvedVersion / .experimentId / .selectedBy describe the choice
console.log(resolved.meta.resolvedVersion, resolved.meta.selectedBy);

// Execute the resolved record with variables (executePromptRecord is synchronous)
const result = executePromptRecord(resolved.record, {
  article:    articleText,
  maxWords:   150,
  focusAreas: 'key findings, business impact',
}, {
  strategyKey: 'deliberate',       // execution strategy override
});

console.log(result.content);
console.log(result.strategy.resolvedKey);`, ['@weaveintel/prompts'])}
`)}

${section('prompts-ab', 'A/B Experiments', `
<p>Create an experiment on a prompt key. Users are randomly assigned to variants based on weights. The winning variant can be promoted with a single call — all traffic switches automatically.</p>

${code('typescript', `import { InMemoryExperimentStore } from '@weaveintel/prompts';
import type { PromptExperiment } from '@weaveintel/core';

const experiments = new InMemoryExperimentStore();

// Register an A/B experiment on the summarise-article prompt
const experiment: PromptExperiment = {
  id:       'exp-summary-style',
  name:     'Bullet vs Paragraph Style',
  promptId: 'summarise-article',
  status:   'active',
  variants: [
    { id: 'control',      promptId: 'summarise-article', versionId: '2.0.0',        weight: 0.5, label: 'Paragraph' },
    { id: 'bullet-style', promptId: 'summarise-article', versionId: '2.1.0-bullet', weight: 0.5, label: 'Bullets' },
  ],
};
experiments.addExperiment(experiment);

// At serve time: pick a variant, record an impression, then score the outcome
const variant = await experiments.pickVariant(experiment.id);
if (variant) {
  await experiments.recordImpression(experiment.id, variant.id);
  await experiments.recordScore(experiment.id, variant.id, 0.87);   // e.g. user rating
}

// Inspect accumulated results per variant
const current = await experiments.getExperiment(experiment.id);
for (const [variantId, r] of Object.entries(current?.results ?? {})) {
  console.log(\`\${variantId}: impressions=\${r.impressions} score=\${r.score.toFixed(2)}\`);
}`, ['@weaveintel/prompts'])}
`)}`;
}

// ── Export map ────────────────────────────────────────────────────────────

export const DOCS_SECTIONS: Record<string, () => string> = {
  home:       sHome,
  agents:     sAgents,
  workflows:  sWorkflows,
  models:     sModels,
  prompts:    sPrompts,
};

// ── More sections ─────────────────────────────────────────────────────────

function sMemory(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/memory</span></div>
  <h1 class="pkg-title">Memory</h1>
  <p class="pkg-desc">Multi-type agent memory with semantic search, automatic extraction from conversations, deduplication, and pluggable backends (SQLite, Postgres, Redis, MongoDB).</p>
</div>

${exlinks([
  ['07-memory-augmented-agent.ts', 'Example 07 — Memory-Augmented Agent'],
  ['22-chat-memory-extraction.ts', 'Example 22 — Chat Memory Extraction'],
])}

${section('memory-types', 'Memory Types', `
${featureCards([
  ['Conversation Memory', 'Stores the full message history with configurable window size and compression for long sessions.'],
  ['Semantic Memory', 'Vector-indexed facts searchable by meaning. Best for cross-session user preferences and domain knowledge.'],
  ['Entity Memory', 'Structured facts about named entities — people, companies, products — with relationship tracking.'],
  ['Working Memory', 'Ephemeral scratch-pad for in-progress task state, cleared after each session or task.'],
])}

${code('typescript', `import {
  weaveSemanticMemory,
  weaveMemoryStore,
} from '@weaveintel/memory';
import { weaveOpenAIEmbeddingModel } from '@weaveintel/provider-openai';
import { weaveContext } from '@weaveintel/core';

// Semantic memory — remembers facts by meaning.
// weaveSemanticMemory(embeddingModel, store?) — the store defaults to in-memory.
const semantic = weaveSemanticMemory(
  weaveOpenAIEmbeddingModel('text-embedding-3-small'),
  weaveMemoryStore(),
);

const ctx = weaveContext({ userId: 'alice' });

// Store a memory explicitly (content + optional metadata)
await semantic.store(
  ctx,
  'User prefers concise bullet-point responses, not paragraphs.',
  { tags: ['preference', 'format'] },
);

// Recall — returns the top-K most relevant memories by embedding similarity
const memories = await semantic.recall(ctx, 'response style preferences', 5);
// memories[0] = { id, type, content, embedding, metadata, createdAt, userId }`)}
`)}

${section('memory-extraction', 'Automatic Extraction', `
<p>Conversation memory automatically extracts structured facts from each message turn using a combination of pattern rules and an optional LLM extractor.</p>
${code('typescript', `const convMemory = weaveConversationMemory({
  store: semantic,
  maxHistory: 40,         // Keep last 40 messages in context window
  compressionThreshold: 80, // Summarise when history exceeds 80 messages
  extractionRules: [
    { pattern: /i (?:live|am based) in (.+)/i,  category: 'location',    tags: ['location'] },
    { pattern: /i prefer (.+)/i,                category: 'preference',  tags: ['preference'] },
    { pattern: /(?:my name is|i'm|i am) (.+)/i, category: 'identity',   tags: ['identity'] },
    { pattern: /always (.+)/i,                  category: 'instruction', tags: ['instruction'] },
  ],
  llmExtractor: {        // Optional: use LLM for nuanced extraction
    model: weaveAnthropicModel('claude-haiku-4-5-20251001'),
    prompt: 'Extract key facts from this message. Return JSON array of {content, category, confidence}.',
    minConfidence: 0.8,
  },
});

// Called once per message turn
await convMemory.addMessage({ role: 'user', content: 'I live in Auckland and prefer dark mode.' });
// Automatically extracts: location=Auckland, preference=dark mode`)}
`)}

${section('memory-runtime', 'Runtime-Backed Memory Store (Recommended)', `
<p>The runtime-backed store routes all memory reads and writes through <code>runtime.persistence.kv</code>. Pass a <code>WeaveRuntime</code> with a persistence slot once and all memory entries survive process restarts — no per-backend configuration needed.</p>

${code('typescript', `import { weaveRuntimeMemoryStore } from '@weaveintel/memory';
import { weaveRuntime, weaveContext } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveSemanticMemory, weaveConversationMemory } from '@weaveintel/memory';
import { weaveOpenAIEmbeddingModel } from '@weaveintel/provider-openai';

// One runtime wires persistence for memory + audit + DLQ simultaneously
const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './memory.db' }),
});

// Runtime-backed MemoryStore — entries survive restarts
const store = weaveRuntimeMemoryStore({ runtime, namespace: 'mem' });

// Build semantic memory on top of the durable store (needs a real embedding model)
const semantic = weaveSemanticMemory(
  weaveOpenAIEmbeddingModel('text-embedding-3-small'),
  store,
);

// Build conversation memory on top of the same store
const conversation = weaveConversationMemory();

// Attach both to an agent
const agent = weaveAgent({
  model:   weaveAnthropicModel('claude-sonnet-4-6'),
  memory:  conversation,
  tools,
  systemPrompt: 'You have access to conversation history and semantic memory.',
});

const ctx = weaveContext({ runtime, userId: 'alice' });

// Store a user preference
await semantic.store(ctx, 'User prefers bullet-point responses, not paragraphs.');
await semantic.store(ctx, 'User works in the fintech industry in Auckland.');

// Run the agent — it loads history automatically
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'Summarise what you know about me.' }],
});
// Agent recalls: Auckland location, fintech industry, bullet-point preference`, ['@weaveintel/memory', '@weaveintel/core', '@weaveintel/persistence', '@weaveintel/agents', '@weaveintel/provider-anthropic'])}
`)}

${section('memory-backends', 'Backend Options', `
<p>Use <code>createConfiguredMemoryStore</code> when you need a specific named backend without a <code>WeaveRuntime</code>.</p>

${code('typescript', `import { createConfiguredMemoryStore } from '@weaveintel/memory';

// SQLite — single-process durable, zero external deps
const sqlite = createConfiguredMemoryStore({ backend: 'sqlite', sqlitePath: './mem.db' });

// Postgres — multi-process, horizontal scale
const pg = createConfiguredMemoryStore({ backend: 'postgres', postgresUrl: process.env['DATABASE_URL']! });

// Redis — low-latency, TTL-aware keys
const redis = createConfiguredMemoryStore({ backend: 'redis', redisUrl: process.env['REDIS_URL']! });

// MongoDB — flexible document model
const mongo = createConfiguredMemoryStore({ backend: 'mongodb', mongoUrl: process.env['MONGO_URL']! });

// Runtime KV — preferred, auto-wired, no separate config
const runtime = createConfiguredMemoryStore({ backend: 'runtime', runtime: myRuntime });`, ['@weaveintel/memory'])}

<h4>Backend comparison</h4>
<table class="ptable"><thead><tr><th>Backend</th><th>Persistence</th><th>Scale</th><th>Best for</th></tr></thead><tbody>
<tr><td><code>memory</code></td><td>Lost on restart</td><td>Single process</td><td>Tests, demos, ephemeral sessions</td></tr>
<tr><td><code>runtime</code></td><td>Durable (via slot)</td><td>Single node</td><td>Production default — one persistence config for everything</td></tr>
<tr><td><code>sqlite</code></td><td>Durable</td><td>Single process</td><td>Low-traffic single-node apps</td></tr>
<tr><td><code>postgres</code></td><td>Durable</td><td>Multi-process</td><td>High-traffic, pgvector for semantic search</td></tr>
<tr><td><code>redis</code></td><td>Configurable TTL</td><td>Multi-process</td><td>Session memory with auto-expiry</td></tr>
<tr><td><code>mongodb</code></td><td>Durable</td><td>Multi-process</td><td>Flexible schema, atlas vector search</td></tr>
</tbody></table>
${params([
  ['backend', 'string', 'required', 'Storage backend — see table above.'],
  ['runtime', 'WeaveRuntime', 'optional', 'Required when backend is <code>"runtime"</code>.'],
  ['sqlitePath', 'string', 'optional', 'File path for SQLite backend.'],
  ['postgresUrl', 'string', 'optional', 'Connection string for Postgres backend.'],
  ['redisUrl', 'string', 'optional', 'Connection URL for Redis backend.'],
  ['mongoUrl', 'string', 'optional', 'Connection URL for MongoDB backend.'],
  ['retentionDays', 'number', 'optional', 'Auto-expire memory entries older than N days.'],
])}
`)}`;
}

function sRetrieval(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/retrieval</span></div>
  <h1 class="pkg-title">Retrieval</h1>
  <p class="pkg-desc">Complete RAG pipeline: document chunking, embedding, vector indexing, hybrid dense + keyword search, query rewriting, and citation extraction.</p>
</div>

${exlinks([
  ['03-rag-pipeline.ts', 'Example 03 — RAG Pipeline'],
  ['113-extraction-pipeline.ts', 'Example 113 — Document Extraction Pipeline'],
])}

${section('retrieval-chunking', 'Chunking', `
${code('typescript', `import { weaveChunker } from '@weaveintel/retrieval';

const chunker = weaveChunker({
  strategy: 'token_aware',   // 'fixed_size' | 'token_aware' | 'semantic_boundary' | 'heading_aware' | 'code_aware' | ...
  chunkSize: 512,            // Target tokens per chunk
  chunkOverlap: 64,          // Token overlap between adjacent chunks
  maxChunks: 1000,           // Cap total chunks per document
});

// chunk() is synchronous and returns DocumentChunk[]
const chunks = chunker.chunk(documentText);

// chunks[i] = { id, documentId, content, index, metadata, source }
console.log(\`Split into \${chunks.length} chunks\`);`)}

${callout('tip', '💡', 'Strategy guide.', '<code>token_aware</code> is best for prose. <code>heading_aware</code> preserves headers as chunk boundaries. <code>code_aware</code> splits on function/class boundaries. <code>semantic_boundary</code> uses an embedding model to find natural meaning boundaries (higher quality, slower).')}
`)}

${section('retrieval-embedding', 'Embedding Pipeline', `
${code('typescript', `import { weaveEmbeddingPipeline } from '@weaveintel/retrieval';
import { weaveContext } from '@weaveintel/core';

const pipeline = weaveEmbeddingPipeline({
  embeddingModel: weaveOpenAIEmbeddingModel('text-embedding-3-small'),
  vectorStore,                                            // Any VectorStore implementation
  chunkerConfig:  { strategy: 'token_aware', chunkSize: 512 },
  batchSize:      100,                                    // Embed 100 chunks per API call
});

const ctx = weaveContext();

// Chunk + embed + index a whole document in one call
const chunks = await pipeline.ingestDocument(ctx, {
  id: 'policy-v2',
  content: documentText,
  metadata: { source: 'policy-v2.pdf', department: 'legal', version: '2024-Q4' },
});
console.log(\`Indexed \${chunks.length} chunks\`);

// Or index pre-chunked content directly
await pipeline.index(ctx, chunks);`)}
`)}

${section('retrieval-hybrid', 'Hybrid Search — Dense + BM25 + RRF', `
<p>Hybrid search combines dense vector similarity (semantic) with BM25 keyword matching. Results are merged using Reciprocal Rank Fusion (RRF), then optionally reranked by a cross-encoder. This consistently outperforms either approach alone.</p>

${code('typescript', `import {
  weaveHybridRetriever,
  weaveQueryRewriter,
  weaveCitationExtractor,
} from '@weaveintel/retrieval';
import { weaveContext } from '@weaveintel/core';

// Hybrid retriever — dense (vector) + keyword scoring, fused internally.
// The keyword side is driven by an in-memory corpus of the same content you embedded.
const corpus = new Map<string, { content: string; metadata: Record<string, unknown> }>();
for (const c of chunks) corpus.set(c.id, { content: c.content, metadata: c.metadata });

const retriever = weaveHybridRetriever({
  embeddingModel: weaveOpenAIEmbeddingModel('text-embedding-3-small'),
  vectorStore,                       // dense semantic search (any VectorStore)
  vectorWeight: 0.7,                 // 70% vector / 30% keyword
  defaultTopK:  20,
  corpus,
});

// Query rewriting — expand the question into several variants before retrieval
const rewriter = weaveQueryRewriter({
  model:       weaveAnthropicModel('claude-haiku-4-5-20251001'),
  maxRewrites: 3,
});

const ctx = weaveContext();
const queries = await rewriter.rewrite(ctx, { query: 'return policy for damaged goods' });
// queries = ['what is the return policy for damaged goods',
//            'how do I get a refund for a defective product']

// Retrieve for the best rewritten query
const result = await retriever.retrieve(ctx, {
  query: queries[0] ?? 'return policy for damaged goods',
  minScore: 0.35,
  filter: { department: 'legal' },
});

// Turn the retrieved chunks into structured citations
const extractor = weaveCitationExtractor();
const citations = extractor.extract(result);`, ['@weaveintel/retrieval', '@weaveintel/core'])}

<h4>Query rewriting</h4>
<p>The rewriter asks the model for several improved variants of the query (up to <code>maxRewrites</code>), one per line. Run retrieval on the variants and fuse the results to widen recall — a lay question can then match a clinically-worded passage.</p>
`)}

${section('retrieval-e2e', 'End-to-End: RAG Agent', `
${code('typescript', `import { weaveEmbeddingPipeline, weaveHybridRetriever } from '@weaveintel/retrieval';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';
import { weaveTool, weaveToolRegistry, weaveContext } from '@weaveintel/core';

const bootstrapCtx = weaveContext();

// 1. Chunk + embed + index documents once
const embedPipeline = weaveEmbeddingPipeline({
  embeddingModel: weaveOpenAIEmbeddingModel('text-embedding-3-small'),
  vectorStore, batchSize: 100,
});
const corpus = new Map<string, { content: string; metadata: Record<string, unknown> }>();
for (const doc of myDocuments) {
  const chunks = await embedPipeline.ingestDocument(bootstrapCtx, doc);
  for (const c of chunks) corpus.set(c.id, { content: c.content, metadata: c.metadata });
}

// 2. Build hybrid retriever (dense + keyword)
const retriever = weaveHybridRetriever({
  embeddingModel: weaveOpenAIEmbeddingModel('text-embedding-3-small'),
  vectorStore, vectorWeight: 0.7, defaultTopK: 10, corpus,
});

// 3. Create a retrieval tool the agent calls
const searchKbTool = weaveTool({
  name: 'search_knowledge_base',
  description: 'Search the internal knowledge base for relevant information. Call this before answering any factual question.',
  parameters: {
    type: 'object', required: ['query'],
    properties: { query: { type: 'string', description: 'Specific search query.' } },
  },
  riskLevel: 'read-only',
  execute: async ({ query }, ctx) => {
    const result = await retriever.retrieve(ctx, { query: query as string, topK: 4 });
    return JSON.stringify(result.chunks.map(c => ({
      content: c.content,
      source:  c.metadata['source'],
    })));
  },
});

// 4. Wire everything into an agent
const tools = weaveToolRegistry();
tools.register(searchKbTool);

const agent = weaveAgent({
  model:        weaveAnthropicModel('claude-sonnet-4-6'),
  tools,
  systemPrompt: \`You are a helpful assistant with access to the company knowledge base.
ALWAYS search the knowledge base before answering factual questions.
Cite the source of each fact you state.\`,
  maxSteps: 4,
});

const ctx    = weaveContext({ userId: 'alice' });
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is our refund policy for software purchases?' }],
});
console.log(result.output);`, ['@weaveintel/retrieval', '@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/core'])}
`)}`;
}

function sEvals(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/testing/evals</span></div>
  <h1 class="pkg-title">Evals</h1>
  <p class="pkg-desc">LLM-as-judge evaluation with rubric scoring, model comparison, CI quality gates, and dataset versioning. Run evals inline during development, as vitest/jest assertions, or as an automated CI gate that fails the build when quality regresses.</p>
</div>

${featureCards([
  ['Rubric scoring', 'Define weighted criteria (factual accuracy, completeness, tone, etc.). The judge model scores each criterion independently and returns reasoning.'],
  ['Model comparison', 'Run the same dataset through two models/prompts and compare scores side by side — detects regressions before deploy.'],
  ['CI quality gate', 'Assert minimum pass rate and mean score. Integrate with vitest/jest — the test fails when quality drops.'],
  ['Parallelism', 'Run up to N eval cases simultaneously to keep CI times short even with large datasets.'],
  ['Deterministic judge', 'Judge model runs at temperature=0 with a structured output contract — scores are reproducible.'],
])}

${exlinks([
  ['09-eval-suite.ts', 'Example 09 — Eval Suite'],
])}

${section('evals-runner', 'Basic Eval Run', `
${code('typescript', `import { weaveEvalRunner } from '@weaveintel/testing/evals';
import { weaveContext } from '@weaveintel/core';
import type { EvalDefinition, EvalCase } from '@weaveintel/core';

// The runner is given an executor: it runs each case's input and returns the output dict.
const runner = weaveEvalRunner({
  executor: async (ctx, input) => {
    const resp = await myAgent.run(ctx, { messages: [{ role: 'user', content: String(input['question']) }] });
    return { answer: resp.output };
  },
});

// An eval definition is a set of assertions applied to every case.
const definition: EvalDefinition = {
  name: 'qa-quality',
  type: 'agent',
  assertions: [
    { name: 'grounded', type: 'model_graded', config: { rubric: 'Is every factual claim verifiable and correct?', threshold: 0.8 } },
    { name: 'concise',  type: 'latency_threshold', config: { maxDurationMs: 8000 } },
  ],
};

const cases: EvalCase[] = [
  { id: 'q1', input: { question: 'What is the capital of France?' }, expected: { answer: 'Paris' } },
  { id: 'q2', input: { question: 'Explain quantum entanglement in one sentence.' } },
];

const ctx    = weaveContext();
const result = await runner.run(ctx, definition, cases);

// EvalSuiteResult carries the aggregates + the per-case results array
console.log(\`Passed \${result.passed}/\${result.totalCases}  mean=\${result.avgScore?.toFixed(3)}\`);
for (const r of result.results) {
  console.log(\`[\${r.caseId}] passed=\${r.passed} score=\${r.score?.toFixed(3)}\`);
}`, ['@weaveintel/testing/evals', '@weaveintel/core'])}
`)}

${section('evals-compare', 'Model Comparison', `
${code('typescript', `import { weaveEvalRunner } from '@weaveintel/testing/evals';
import { weaveContext } from '@weaveintel/core';

// One executor per candidate; same definition + cases for a fair comparison.
const baseline  = weaveEvalRunner({ executor: (ctx, input) => callModel(baselineModel, input) });
const candidate = weaveEvalRunner({ executor: (ctx, input) => callModel(candidateModel, input) });

const ctx = weaveContext();
const [baselineResult, candidateResult] = await Promise.all([
  baseline.run(ctx, definition, cases),
  candidate.run(ctx, definition, cases),
]);

const delta = (candidateResult.avgScore ?? 0) - (baselineResult.avgScore ?? 0);
console.log(\`Baseline mean:  \${baselineResult.avgScore?.toFixed(3)}\`);
console.log(\`Candidate mean: \${candidateResult.avgScore?.toFixed(3)}\`);
console.log(\`Delta: \${delta.toFixed(3)} (\${delta > 0 ? '✓ improved' : '✗ regressed'})\`);
console.log(\`Pass count: \${baselineResult.passed} → \${candidateResult.passed}\`);`, ['@weaveintel/testing/evals', '@weaveintel/core'])}
`)}

${section('evals-ci', 'CI Quality Gate', `
<p>Integrate with vitest or Jest to block deployments when quality regresses below threshold.</p>

${code('typescript', `// evals/quality.test.ts — runs in CI
import { describe, it, expect } from 'vitest';
import { weaveEvalRunner } from '@weaveintel/testing/evals';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';

const PASS_RATE_THRESHOLD  = 0.85;   // ≥ 85% of cases must pass
const MEAN_SCORE_THRESHOLD = 0.80;   // mean score must be ≥ 0.80

describe('agent quality gate', () => {
  it('meets minimum quality thresholds on the golden dataset', async () => {
    const agent = weaveAgent({ model: weaveAnthropicModel('claude-haiku-4-5-20251001'), tools });
    const ctx   = weaveContext();

    const runner = weaveEvalRunner({
      executor: async (c, input) => {
        const r = await agent.run(c, { messages: [{ role: 'user', content: String(input['question']) }] });
        return { answer: r.output };
      },
    });

    const result = await runner.run(ctx, goldenDefinition, goldenCases);

    const passRate  = result.passed / result.totalCases;
    const meanScore = result.avgScore ?? 0;

    expect(passRate).toBeGreaterThanOrEqual(PASS_RATE_THRESHOLD);
    expect(meanScore).toBeGreaterThanOrEqual(MEAN_SCORE_THRESHOLD);
  }, 60_000);   // allow up to 60 s for eval run
});`, ['@weaveintel/testing/evals', '@weaveintel/provider-anthropic', '@weaveintel/agents', '@weaveintel/core'])}
`)}`;
}

function sGuardrails(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/guardrails</span></div>
  <h1 class="pkg-title">Guardrails</h1>
  <p class="pkg-desc">Pre- and post-execution safety pipeline: risk classification, PII detection, sycophancy detection, confidence gating, cost guards, and action-level controls. Fully composable.</p>
</div>

${exlinks([
  ['08-pii-redaction.ts', 'Example 08 — PII Redaction'],
  ['23-chat-guardrails-pipeline.ts', 'Example 23 — Guardrails Pipeline'],
  ['21-guardrails-date-evidence.ts', 'Example 21 — Guardrails + Date Evidence'],
])}

${section('guardrails-pipeline', 'Building a Pipeline', `
${code('typescript', `import { createGuardrailPipeline } from '@weaveintel/guardrails';
import type { Guardrail } from '@weaveintel/core';

// A pipeline is built from a flat Guardrail[] — each declares its stage,
// type, and config. The pipeline runs the ones matching the requested stage.
const guardrails: Guardrail[] = [
  { id: 'pii-card', name: 'Credit card', type: 'regex', stage: 'pre-execution', enabled: true,
    config: { pattern: '\\\\d{4}[\\\\s-]?\\\\d{4}[\\\\s-]?\\\\d{4}[\\\\s-]?\\\\d{4}', action: 'deny' } },
  { id: 'pii-ssn', name: 'SSN', type: 'regex', stage: 'pre-execution', enabled: true,
    config: { pattern: '\\\\b(ssn|social security)\\\\b', flags: 'i', action: 'deny' } },
  { id: 'injection', name: 'Prompt injection', type: 'regex', stage: 'pre-execution', enabled: true,
    config: { pattern: 'ignore previous|forget instructions|jailbreak', flags: 'i', action: 'deny' } },
  { id: 'confidence', name: 'Confidence gate', type: 'model-graded', stage: 'post-execution', enabled: true,
    config: { minConfidence: 0.70 } },
  { id: 'blocked-actions', name: 'Blocked actions', type: 'blocklist', stage: 'post-execution', enabled: true,
    config: { deniedActions: ['delete_database', 'send_to_all_users', 'override_safety'] } },
];

const pipeline = createGuardrailPipeline(guardrails);

// Use in your chat handler. evaluate() returns a GuardrailResult[] —
// each result has { decision, guardrailId, explanation }.
const preResults = await pipeline.evaluate(userMessage, 'pre-execution', {
  metadata: { userId, sessionId },
});
const preDenied = preResults.find(r => r.decision === 'deny');
if (preDenied) {
  return { error: preDenied.explanation, code: preDenied.guardrailId };
}

const llmResponse = await model.generate(ctx, { messages });

const postResults = await pipeline.evaluate(llmResponse.content, 'post-execution', {
  metadata: { userId },
});
if (postResults.some(r => r.decision === 'deny')) {
  return { error: 'Response blocked by safety policy.' };
}`)}
`)}

${section('guardrails-checks', 'Built-in Checks', `
${params([
  ['DefaultRiskClassifier', 'Check', 'optional', 'Pattern-based risk classification. Supports regex patterns, categories, severity levels, and deny/warn/flag actions.'],
  ['DefaultConfidenceGate', 'Check', 'optional', 'Blocks responses where model expresses low confidence. Detects hedging phrases or explicit uncertainty markers.'],
  ['DefaultActionGate', 'Check', 'optional', 'Blocks specific named actions appearing in model output (e.g. from tool-use outputs).'],
  ['CostGuard', 'Check', 'optional', 'Fails requests that would push per-session or per-user cost over a USD budget.'],
  ['SycophancyDetector', 'Check', 'optional', 'Detects sycophantic patterns (excessive agreement, flattery) in post-execution responses.'],
  ['GroundingGuard', 'Check', 'optional', 'Checks that factual claims in the response are grounded in provided evidence (tool results, RAG context).'],
])}
`)}

${section('guardrails-2026', 'Mid-2026 Guardrail Expansion', `
<p>As AI systems became more capable and regulations tightened, weaveIntel's guardrail library expanded in mid-2026 to cover four new areas: EU AI Act compliance, AI-generated content detection, agent-specific safety controls, and intellectual property protection. These are stored in the <code>guardrail_rules</code> DB table and evaluated by the same pipeline as all other guardrails.</p>

<h4>EU AI Act Compliance (4 checks)</h4>
<p>The EU AI Act (effective 2025–2026) imposes transparency and safety obligations on AI systems. These checks help meet them:</p>
${typeTable([
  ['euaia-transparency-disclosure', 'Ensures AI-generated responses include a disclosure that the content was produced by an AI system. Required for "high-risk" AI use cases under Article 13.'],
  ['euaia-human-oversight-gate', 'Flags responses in high-stakes domains (medical, legal, financial) and requires a human reviewer before delivery. Supports Article 14 human-oversight requirements.'],
  ['euaia-prohibited-manipulation', 'Detects and blocks manipulative language patterns — techniques designed to exploit a user\'s emotions or beliefs against their own interests. Enforces Article 5 prohibited practices.'],
  ['euaia-bias-fairness-flag', 'Scores responses for demographic bias across protected characteristics (age, gender, nationality). Outputs above the bias threshold are flagged for review under Article 10 data-quality requirements.'],
])}

<h4>AI-Generated Content Detection (4 checks)</h4>
<p>These checks detect when AI-generated content could cause problems — either because it is being passed off as human-written where disclosure is required, or because it contains hallucinated facts:</p>
${typeTable([
  ['aigc-watermark-check', 'Verifies that AI-generated media (images, audio, documents) carries a C2PA-compatible watermark or provenance record before it is returned to users or stored.'],
  ['aigc-hallucination-detector', 'Cross-references factual claims in the response against the retrieved context (RAG chunks, tool results). Claims without supporting evidence are flagged as potential hallucinations.'],
  ['aigc-deepfake-audio-block', 'Blocks generation of realistic synthetic voice audio that mimics an identified real person unless the person\'s consent is on record.'],
  ['aigc-synthetic-media-disclosure', 'Automatically appends a disclosure notice to any response that includes AI-generated images, video, or audio — even if the user did not ask for one.'],
])}

<h4>Agent Safety Controls (5 checks)</h4>
<p>As agents become capable of taking real actions in the world (sending emails, running code, calling APIs), new safety controls are needed to prevent unintended or harmful actions:</p>
${typeTable([
  ['agent-tool-scope-enforcement', 'Compares the tool call\'s target (URL, file path, database, external service) against an allowlist for the current session scope. Calls outside the allowlist are blocked before execution.'],
  ['agent-irreversibility-gate', 'Detects "irreversible" tool calls (delete, publish, send to all users, overwrite production) and requires explicit human confirmation before allowing them to proceed.'],
  ['agent-pii-output-redaction', 'Scans agent responses and tool outputs for PII (names, emails, phone numbers, national IDs, credit card numbers) and redacts or masks them before they leave the system.'],
  ['agent-prompt-injection-shield', 'Detects prompt-injection patterns in external content the agent has retrieved (web pages, documents, tool results) — content that tries to override the agent\'s instructions. Strips or quarantines injections before they reach the model.'],
  ['agent-recursive-delegation-limit', 'Enforces <code>max_agent_hops</code> from the agent strategy settings. Terminates runs where the chain of A2A delegation exceeds the configured limit, preventing runaway loops.'],
])}

<h4>Intellectual Property & Data Residency (5 checks)</h4>
${typeTable([
  ['ip-copyright-content-filter', 'Pattern-matches responses against a registry of known copyrighted text fragments (book excerpts, song lyrics, source code). Matches above a similarity threshold are blocked or replaced with a citation.'],
  ['ip-trademark-usage-flag', 'Detects use of registered trademarks in a way that could imply endorsement or cause brand confusion. Flags responses containing registered marks in promotional contexts.'],
  ['data-residency-eu', 'Blocks data from EU-based user sessions from being processed by models or stored in infrastructure outside the EU/EEA. Requires <code>data_region</code> metadata in the execution context.'],
  ['data-residency-us-gov', 'Restricts US Government tenant data to FedRAMP-authorised model endpoints and US-based storage only.'],
  ['data-residency-au-nz', 'Restricts Australian and New Zealand regulated-industry data to Australia-region infrastructure in compliance with the Australian Privacy Act.'],
])}

${callout('info', '🗄️', 'Database-backed rules.', 'All 18 mid-2026 guardrail rules are seeded into the <code>guardrail_rules</code> table and evaluated by the same pipeline as the original built-in checks. You can enable or disable individual rules per tenant via the <code>tenant_guardrail_overrides</code> table, or add your own custom rules using <code>DefaultRiskClassifier</code> with project-specific patterns.')}
`)}

${section('guardrails-runtime', 'Runtime Slot — Ambient Guardrails (Recommended)', `
<p>The <code>RuntimeGuardrailsSlot</code> on <code>weaveRuntime</code> is the recommended path. Unlike the pipeline above (which requires explicit call-site integration), the runtime slot is consulted automatically by the agent loop for every tool call and model output — no call-site wiring required.</p>

${code('typescript', `import { weaveRuntime, weaveContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import type { RuntimeGuardrailsSlot } from '@weaveintel/core';

// Build the guardrails slot — same interface, zero call-site wiring
const guardrails: RuntimeGuardrailsSlot = {
  // Called automatically before EVERY tool invocation
  async checkToolCall(ctx, schema, args) {
    // Deny financial tools for free tier
    if (schema.riskLevel === 'financial' && ctx.metadata['plan'] === 'free') {
      return { allow: false, reason: 'financial tools require a paid plan' };
    }
    // Block prompt-injection attempts in tool arguments
    const argStr = JSON.stringify(args);
    if (/ignore previous|forget all|system prompt/i.test(argStr)) {
      return { allow: false, reason: 'potential prompt injection in tool arguments' };
    }
    return { allow: true };
  },

  // Called automatically on EVERY terminal agent response
  async checkOutput(ctx, text) {
    // Redact leaked API keys
    if (/sk-[A-Za-z0-9]{20,}/.test(text)) {
      return { allow: true, redactedText: text.replace(/sk-[A-Za-z0-9]{20,}/g, '[API_KEY]') };
    }
    // Block medical advice from non-clinical agents
    if (/take \d+mg|prescribed|diagnos/i.test(text) && ctx.metadata['agentType'] !== 'clinical') {
      return { allow: false, reason: 'medical advice from non-clinical agent is blocked' };
    }
    return { allow: true };
  },
};

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './app.db' }),
  guardrails,   // ← wired once, applies to every agent derived from this runtime
});

// Any agent that uses this runtime is automatically guarded
const agent = weaveAgent({ model: weaveAnthropicModel('claude-sonnet-4-6'), tools });
const ctx   = weaveContext({ runtime, userId: 'alice', metadata: { plan: 'free', agentType: 'assistant' } });

const result = await agent.run(ctx, { messages });
// Tool denials → audit entry: action:"agent.tool.invoke" outcome:"denied"
// Output denials → audit entry: action:"agent.output.denied" outcome:"denied"
// Output redactions → agent returns the redactedText instead of the raw response`, ['@weaveintel/core', '@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/persistence'])}

${callout('tip', '💡', 'Pipeline vs slot.', 'Use the <strong>pipeline</strong> (<code>@weaveintel/guardrails</code>) when you need full pre/post check composition with built-in checks, cost guards, and violation callbacks. Use the <strong>runtime slot</strong> when you want ambient coverage across all agents without any per-agent wiring. Both can coexist — the slot fires automatically, and the pipeline is called explicitly in your chat handler.')}
`)}`;
}

function sResilience(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/resilience</span></div>
  <h1 class="pkg-title">Resilience</h1>
  <p class="pkg-desc">Call-level resilience primitives: token bucket rate limiting, circuit breaker, concurrency limiter, and retry with exponential backoff + jitter. Compose all four with <code>runResilient()</code>.</p>
</div>

${exlinks([
  ['111-resilience.ts', 'Example 111 — Resilience Patterns'],
])}

${section('resilience-run', 'runResilient — All-in-One', `
${code('typescript', `import { runResilient, type ResilienceOptions } from '@weaveintel/resilience';

const options: ResilienceOptions = {
  // Endpoint key — all protections share state across every call with this key
  endpoint: 'anthropic-completions',
  rateLimit: {
    capacity:     60,     // Max burst of 60 calls
    refillPerSec: 1,      // Refill 1 token/second (~60/min)
  },
  circuit: {
    failureThreshold: 5,      // Open circuit after 5 consecutive failures
    cooldownMs:       30_000, // Stay open 30s before a probe
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 500,
    factor:      2,        // 500ms → 1s → 2s
    maxDelayMs:  10_000,
    jitter:      true,     // Add randomness to avoid a thundering herd
  },
  concurrency: {
    maxConcurrent: 20,     // At most 20 in-flight calls
    maxQueue:      100,    // Queue up to 100 waiting
  },
  timeoutMs: 10_000,       // Per-call timeout
};

// All four protections on a single call
const result = await runResilient(
  () => model.generate({ messages }),
  options,
);`)}
`)}

${section('resilience-primitives', 'Individual Primitives', `
${code('typescript', `import {
  createTokenBucket,
  createCircuitBreaker,
  createRetryPolicy,
  createConcurrencyLimiter,
  createResilienceSignalBus,
  PROVIDER_RESILIENCE_DEFAULTS,
} from '@weaveintel/resilience';

// PROVIDER_RESILIENCE_DEFAULTS — canonical shared defaults used by all built-in providers.
// Use these in your own provider or connector to stay consistent.
console.log(PROVIDER_RESILIENCE_DEFAULTS);
// { retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
//   circuit: { failureThreshold: 8, cooldownMs: 30_000 } }

// Signal bus — one listener receives every normalised event; branch on sig.kind
const bus = createResilienceSignalBus();
bus.on((sig) => {
  if (sig.kind === 'shed')     monitor.alert(\`Shed on \${sig.endpoint}: \${sig.reason}\`);
  if (sig.kind === 'retrying') metrics.increment('retry', { endpoint: sig.endpoint });
});

// Token bucket — shared rate quota across all callers with the same endpoint key
const bucket = createTokenBucket({ capacity: 60, refillPerSec: 1 });
// Try without waiting (returns false when empty)
if (!bucket.tryAcquire()) throw new Error('Rate limited — try again later');
// Wait up to 5 s for a token
await bucket.acquire(5_000);

// Circuit breaker — opens after N consecutive failures, half-opens after cooldown
const breaker = createCircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
const decision = breaker.canPass();
if (decision.allowed === false) {
  throw new Error(\`Circuit open, reopens in \${decision.reopensAt - Date.now()}ms\`);
}
try {
  const result = await callExternalService();
  breaker.recordSuccess();
  return result;
} catch (err) {
  const { transitionedToOpen } = breaker.recordFailure();
  if (transitionedToOpen) monitor.alert('Circuit opened on external service');
  throw err;
}

// Retry policy — decides whether/when to retry (drive it from your call loop)
const retry = createRetryPolicy({ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000, jitter: true });
// retry.shouldRetry(classifiedError, attempt) + retry.nextDelayMs(...) inform your loop.

// Concurrency limiter — cap in-flight requests. acquire() returns a release fn.
const limiter = createConcurrencyLimiter({ maxConcurrent: 10 });
const release = await limiter.acquire();
try {
  await heavyOperation();
} finally {
  release();
}`, ['@weaveintel/resilience'])}

<h4>Primitive API reference</h4>
${typeTable([
  ['createTokenBucket({ capacity, refillPerSec })', 'Token bucket with <code>tryAcquire()</code>, <code>acquire(timeoutMs?)</code>, <code>pauseFor(ms)</code>, <code>snapshot()</code>.'],
  ['createCircuitBreaker({ failureThreshold, cooldownMs })', 'Three-state (closed/open/half-open). <code>canPass()</code>, <code>recordSuccess()</code>, <code>recordFailure()</code>, <code>snapshot()</code>.'],
  ['createRetryPolicy({ maxAttempts, baseDelayMs, jitter })', 'Exponential backoff. <code>execute(fn)</code>, <code>shouldRetry(err)</code>, <code>nextDelayMs(attempt, err)</code>.'],
  ['createConcurrencyLimiter({ maxConcurrent })', 'Async semaphore. <code>run(fn)</code> waits for a slot; rejects when queue is full.'],
  ['PROVIDER_RESILIENCE_DEFAULTS', 'Canonical retry + circuit defaults used by all built-in LLM providers.'],
])}
`)}

${section('resilience-durable', 'Durable Endpoint Registry', `
<p>The module-level <code>getOrCreateEndpointState</code> is process-scoped. <code>createDurableEndpointRegistry</code> persists circuit-breaker state across restarts — a known-bad endpoint stays open through a deploy instead of triggering a thundering herd of retries.</p>

${code('typescript', `import { createDurableEndpointRegistry } from '@weaveintel/resilience';
import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './resilience.db' }),
});

const registry = createDurableEndpointRegistry({ runtime, namespace: 'er' });

// Circuit-breaker state is restored from KV on startup
const state = await registry.getOrCreateEndpointState('openai:rest', {
  rateLimit:   { capacity: 60, refillPerSec: 1 },
  concurrency: { maxConcurrent: 20 },
  circuit:     { failureThreshold: 8, cooldownMs: 30_000 },
});

// recordFailure() writes a snapshot to KV immediately
// → after a process restart, if the circuit was open and cooldown hasn't
//   elapsed, it is automatically re-tripped to protect the downstream service
state.circuit!.recordFailure();

// Inspect all registered endpoints
const all = registry.listEndpointStates();
all.forEach(s => console.log(s.endpoint, s.circuit?.state()));`, ['@weaveintel/resilience', '@weaveintel/core', '@weaveintel/persistence'])}
`)}

${section('resilience-e2e', 'End-to-End: Resilient External API Call', `
${code('typescript', `import { createResilientCallable, PROVIDER_RESILIENCE_DEFAULTS } from '@weaveintel/resilience';
import { createHardenedFetch } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext, weaveTool, weaveToolRegistry } from '@weaveintel/core';

const { fetch } = createHardenedFetch({ errorTag: 'stock-api', timeoutMs: 10_000 });

// Wrap the API call in a resilient callable — shared circuit + token bucket
const resilientStockFetch = createResilientCallable(
  async (ticker: string) => {
    const r = await fetch(\`https://api.stockdata.com/v1/data/quote?symbols=\${ticker}\`);
    return (await r.json()) as { data: { close: number }[] };
  },
  { endpoint: 'stockdata:quote', ...PROVIDER_RESILIENCE_DEFAULTS },
);

const stockTool = weaveTool({
  name: 'get_stock_price', description: 'Get the latest close price for a ticker.',
  parameters: { type:'object', required:['ticker'], properties:{ ticker: { type:'string' } } },
  riskLevel: 'read-only',
  execute: async ({ ticker }) => {
    const data = await resilientStockFetch(ticker as string);
    return JSON.stringify({ ticker, price: data.data[0]?.close });
  },
});

const tools = weaveToolRegistry();
tools.register(stockTool);

const agent  = weaveAgent({ model: weaveAnthropicModel('claude-haiku-4-5-20251001'), tools });
const ctx    = weaveContext();
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is AAPL trading at today?' }],
});
console.log(result.output);`, ['@weaveintel/resilience', '@weaveintel/core', '@weaveintel/agents', '@weaveintel/provider-anthropic'])}
`)}`;
}

function sCostGovernor(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/cost-governor</span></div>
  <h1 class="pkg-title">Cost Governor</h1>
  <p class="pkg-desc">8-lever cost optimisation that wraps models and tools with budget enforcement, tier-based policies, intent-RAG tool subset selection, model cascade, and automatic history compaction.</p>
</div>

${exlinks([
  ['103-cost-policy-binding.ts', 'Example 103 — Cost Policy Binding'],
  ['104-prompt-caching.ts', 'Example 104 — Prompt Caching (L3)'],
  ['105-model-cascade.ts', 'Example 105 — Model Cascade (L1)'],
  ['106-tool-subset.ts', 'Example 106 — Tool Subset (L2)'],
  ['107-intel-history.ts', 'Example 107 — Intel Gating + History Compaction (L4/L5)'],
  ['108-budget-governor.ts', 'Example 108 — Max Steps + Reasoning Effort + Budget Gate'],
  ['109-intent-rag-tool-retrieval.ts', 'Example 109 — Intent-RAG Tool Retrieval'],
])}

${section('cost-levers', 'The 8 Levers', `
<table class="ptable"><thead><tr><th>Lever</th><th>Strategy</th><th>Typical Savings</th><th>Config Key</th></tr></thead><tbody>
<tr><td>L1 Model Cascade</td><td>Try cheapest model first; escalate to smarter model if confidence is low</td><td>40–70%</td><td><code>modelCascade</code></td></tr>
<tr><td>L2 Tool Subset</td><td>Use intent-RAG to select only the 3–5 most relevant tools per query</td><td>10–30%</td><td><code>toolSubset</code></td></tr>
<tr><td>L3 Prompt Caching</td><td>Reuse Anthropic/OpenAI prefix cache for repeated system prompts</td><td>15–25%</td><td><code>promptCaching</code></td></tr>
<tr><td>L4 Intel Gating</td><td>Skip expensive context-enrichment sections for simple queries</td><td>20–40%</td><td><code>intelGating</code></td></tr>
<tr><td>L5 History Compaction</td><td>Summarise old message history to reduce context tokens</td><td>20–50%</td><td><code>historyCompaction</code></td></tr>
<tr><td>L6 Max Steps</td><td>Cap agent tool-call iterations per tier</td><td>Variable</td><td><code>maxSteps</code></td></tr>
<tr><td>L7 Reasoning Effort</td><td>Reduce thinking tokens (extended thinking models) for simple queries</td><td>10–40%</td><td><code>reasoningEffort</code></td></tr>
<tr><td>L8 Output Truncation</td><td>Cap response length by tier</td><td>5–20%</td><td><code>outputTruncation</code></td></tr>
</tbody></table>
`)}

${section('cost-setup', 'Setup & Usage', `
${code('typescript', `import { weaveCostGovernor, createInMemoryCostLedger } from '@weaveintel/cost-governor';

// weaveCostGovernor(policy, opts?) resolves a CostPolicy tier into a bundle of
// levers (model cascade, tool subset, history compaction, step cap, budget gate).
const governor = weaveCostGovernor(
  {
    tier: 'balanced',              // 'economy' | 'balanced' | 'performance' | 'max' | 'custom'
    maxStepsCap: 20,
    budgetCeilingUsd: 50.00,
    modelCascade: {
      cheap:     { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
      expensive: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    },
    toolSubset: { strategy: 'intent-rag', topK: 8 },
  },
  {
    // Pass the ledger + a run-id resolver so the budget gate can enforce spend
    costLedger:    createInMemoryCostLedger(),
    runIdResolver: (ctx) => ctx.runId ?? null,
  },
);

// The bundle exposes the resolved levers — the agent framework applies them.
console.log(governor.maxStepsCap, governor.reasoningEffort);

// e.g. ask the model resolver which model to actually use for this turn
const decision = await governor.modelResolver({ runId: 'run-1' });
console.log(decision?.modelIdOverride);   // null when no downgrade/upgrade applies`)}
`)}`;
}

function sTools(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/tools</span></div>
  <h1 class="pkg-title">Tool Framework</h1>
  <p class="pkg-desc">Versioned tool registration with risk classification, policy enforcement, approval gates, rate limiting, network guards, audit logging, and health tracking. Wraps any tool without modifying it.</p>
</div>

${featureCards([
  ['Risk levels', '<code>read-only</code>, <code>write</code>, <code>destructive</code>, <code>privileged</code>, <code>financial</code>, <code>external-side-effect</code> — enforced by policy at invocation.'],
  ['Capability requirements', '<code>requires: [RuntimeCapabilities.NetEgress]</code> asserts the ambient runtime provides needed capabilities at registration time.'],
  ['Approval gates', 'Side-effecting tools can require human approval. Requests queue in a persistent store; agent pauses until a human approves or rejects.'],
  ['Rate limiting', 'Per-tool per-user token-bucket rate limiting. Excess calls throw structured errors the agent can read.'],
  ['Health tracking', 'Success rate, p50/p95/p99 latency, and recent errors per tool — queryable for dashboards.'],
  ['Audit emission', 'Every invocation emits a structured audit event: tool name, args hash, outcome, latency, user, tenant.'],
])}

${section('tools-define', 'Defining Tools with Risk & Capability Requirements', `
${code('typescript', `import { weaveTool, weaveToolRegistry, RuntimeCapabilities } from '@weaveintel/core';

// Read-only tool — low risk, network egress required
const searchTool = weaveTool({
  name: 'web_search',
  description: 'Search the web and return the top results for a query.',
  parameters: {
    type: 'object', required: ['query'],
    properties: {
      query:      { type: 'string',  description: 'Search query.' },
      maxResults: { type: 'number',  description: 'Number of results. Default 5.' },
    },
  },
  riskLevel: 'read-only',
  requires:  [RuntimeCapabilities.NetEgress],   // asserted at registry.register() time
  execute: async ({ query, maxResults = 5 }) => {
    const results = await searchProvider.search(query as string, maxResults as number);
    return JSON.stringify(results);
  },
});

// Side-effecting tool — requires human approval before execution
const sendEmailTool = weaveTool({
  name: 'send_email',
  description: 'Send an email to a recipient. Use only when explicitly requested by the user.',
  parameters: {
    type: 'object', required: ['to', 'subject', 'body'],
    properties: {
      to:      { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string', description: 'Email subject line.' },
      body:    { type: 'string', description: 'Plain-text email body.' },
    },
  },
  riskLevel:        'external-side-effect',
  requiresApproval: true,
  tags:             ['email', 'communication'],
  requires:         [RuntimeCapabilities.NetEgress],
  execute: async ({ to, subject, body }) => {
    const id = await emailService.send(to as string, subject as string, body as string);
    return JSON.stringify({ messageId: id, status: 'sent' });
  },
});

// Register — runtime.net.egress assertion happens here, not at call time
const runtime = weaveRuntime({ /* ... */ });
const registry = weaveToolRegistry({ runtime });
registry.register(searchTool);
registry.register(sendEmailTool);`, ['@weaveintel/core'])}
`)}

${section('tools-policy', 'Policy-Enforced Registry', `
${code('typescript', `import { createPolicyEnforcedRegistry, weaveHealthTracker, InMemoryToolPolicyResolver } from '@weaveintel/tools';
import { weaveToolRegistry } from '@weaveintel/core';

const base = weaveToolRegistry();
base.register(searchTool);
base.register(sendEmailTool);

const tracker = weaveHealthTracker({ windowMs: 60_000 });

// The policy is supplied by a resolver keyed per tool. Higher-risk tools must
// be explicitly enabled and can require approval.
const resolver = new InMemoryToolPolicyResolver(new Map([
  ['web_search', { enabled: true, allowedRiskLevels: ['read-only'] }],
  ['send_email', { enabled: true, requiresApproval: true, allowedRiskLevels: ['read-only', 'external-side-effect'] }],
]));

const enforced = createPolicyEnforcedRegistry(base, {
  resolver,
  auditEmitter:  myAuditEmitter,
  approvalGate:  myApprovalGate,
  healthTracker: tracker,
});

// Query health after some calls
const health = tracker.get('send_email');
// { successRate: 0.99, avgLatencyMs: 320, p95LatencyMs: 580, ... }`, ['@weaveintel/tools', '@weaveintel/core'])}
`)}

${section('tools-e2e', 'End-to-End: Governed Agent', `
${code('typescript', `import { weaveTool, weaveToolRegistry, weaveContext, weaveRuntime, RuntimeCapabilities } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './app.db' }),
  guardrails: {
    async checkToolCall(ctx, schema) {
      if (schema.riskLevel === 'financial' && ctx.metadata['plan'] === 'free') {
        return { allow: false, reason: 'financial tools require a paid plan' };
      }
      return { allow: true };
    },
  },
});

const calcTool = weaveTool({
  name: 'calculate', description: 'Evaluate a mathematical expression.',
  parameters: { type: 'object', required: ['expression'],
    properties: { expression: { type: 'string' } } },
  riskLevel: 'read-only',
  execute: async ({ expression }) => {
    const result = Function(\`return (\${expression as string})\`)();
    return JSON.stringify({ expression, result });
  },
});

const registry = weaveToolRegistry({ runtime });
registry.register(calcTool);

const agent = weaveAgent({ model: weaveAnthropicModel('claude-haiku-4-5-20251001'), tools: registry });
const ctx   = weaveContext({ runtime, userId: 'alice', metadata: { plan: 'pro' } });

const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is 15% of 847.50?' }],
});
console.log(result.output);   // "15% of 847.50 is 127.125"`, ['@weaveintel/core', '@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/persistence'])}
`)}`;
}

function sToolsTime(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/tools/time</span></div>
  <h1 class="pkg-title">tools-time</h1>
  <p class="pkg-desc">16 time-aware tools: datetime retrieval, timezone conversion, arithmetic, named timers, stopwatches, and scheduled reminders. Fully stateful with a pluggable <code>TemporalStore</code> backend.</p>
</div>

${exlinks([
  ['117-tools-time.ts', 'Example 117 — tools-time end-to-end'],
])}

${section('tools-time-setup', 'Setup', `
${code('typescript', `import { createTimeTools, createInMemoryTemporalStore } from '@weaveintel/tools/time';

const tools = createTimeTools({
  defaultTimezone: 'Pacific/Auckland',
  locale: 'en-NZ',
  store: createInMemoryTemporalStore(),  // Or a durable TemporalStore for persistence
});

// Register all 16 tools at once
tools.forEach(t => agentToolRegistry.register(t));`)}

<h4>All 16 tools</h4>
<table class="ptable"><thead><tr><th>Tool</th><th>Description</th></tr></thead><tbody>
<tr><td><code>datetime</code></td><td>Current date/time in any IANA timezone with configurable format</td></tr>
<tr><td><code>timezone_info</code></td><td>UTC offset, DST status, abbreviation, and locale for any timezone</td></tr>
<tr><td><code>datetime_add</code></td><td>Add or subtract a duration (years, months, days, hours, minutes, seconds)</td></tr>
<tr><td><code>datetime_diff</code></td><td>Calculate the difference between two datetimes in any unit</td></tr>
<tr><td><code>datetime_format</code></td><td>Reformat a datetime string using a format pattern</td></tr>
<tr><td><code>timer_start</code></td><td>Start a named countdown timer with a duration</td></tr>
<tr><td><code>timer_stop</code></td><td>Stop a running timer and return elapsed time</td></tr>
<tr><td><code>timer_check</code></td><td>Check remaining time on a running timer</td></tr>
<tr><td><code>stopwatch_start</code></td><td>Start a named stopwatch</td></tr>
<tr><td><code>stopwatch_stop</code></td><td>Stop a stopwatch and return total elapsed time</td></tr>
<tr><td><code>stopwatch_lap</code></td><td>Record a lap split without stopping the stopwatch</td></tr>
<tr><td><code>stopwatch_check</code></td><td>Get current elapsed time without stopping</td></tr>
<tr><td><code>reminder_set</code></td><td>Schedule a named reminder at a specific datetime or after a duration</td></tr>
<tr><td><code>reminder_list</code></td><td>List all pending reminders, optionally filtered by tag</td></tr>
<tr><td><code>reminder_cancel</code></td><td>Cancel a pending reminder by name or ID</td></tr>
<tr><td><code>reminder_check</code></td><td>Check if a specific reminder has fired</td></tr>
</tbody></table>
`)}`;
}

function sMcp(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/mcp-client &amp; mcp-server</span></div>
  <h1 class="pkg-title">MCP Integration</h1>
  <p class="pkg-desc">Model Context Protocol client and server. Connect to any external MCP server as a tool source, or expose WeaveIntel tools to any MCP-compatible host (Claude Desktop, Cursor, etc.).</p>
</div>

${exlinks([
  ['05-mcp-integration.ts', 'Example 05 — MCP Integration'],
  ['05-mcp-integration-real.ts', 'Example 05 — MCP Integration (Real Servers)'],
])}

${section('mcp-client', 'MCP Client', `
${code('typescript', `import {
  weaveMCPClient,
  weaveMCPTools,
  createMCPStdioClientTransport,
  createMCPStreamableHttpTransport,
} from '@weaveintel/mcp-client';

// Connect to a stdio MCP server (subprocess)
const stdioTransport = createMCPStdioClientTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/alice/docs'],
  env: { HOME: process.env.HOME! },
});

// Connect to an HTTP MCP server (endpoint first, then options)
const httpTransport = createMCPStreamableHttpTransport('https://mcp.example.com/v1', {
  getHeaders: async () => ({ Authorization: \`Bearer \${process.env.MCP_TOKEN}\` }),
});

const client = weaveMCPClient();
await client.connect(stdioTransport);

// Discover the server's tools, then wrap them as a ToolRegistry
const toolDefs = await client.listTools();
const mcpToolRegistry = weaveMCPTools(client, toolDefs);

// Use in a weaveAgent
const agent = weaveAgent({ model, tools: mcpToolRegistry });

// Clean up
await client.disconnect();`)}
`)}

${section('mcp-server', 'MCP Server', `
${code('typescript', `import { weaveMCPServer, createMCPStreamableHttpServerTransport } from '@weaveintel/mcp-server';

const server = weaveMCPServer({
  name:        'acme-internal-tools',
  version:     '1.0.0',
  description: 'ACME internal tools exposed via MCP for Claude Desktop and Cursor.',
});

// Tools are added one at a time: addTool(definition, handler)
server.addTool(
  {
    name: 'company_search',
    description: 'Search the internal company knowledge base.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
  },
  async (ctx, args) => ({ content: [{ type: 'text', text: JSON.stringify(await kb.search(String(args['query']))) }] }),
);

// HTTP transport — for remote clients (Claude Desktop, Cursor, etc.)
const transport = createMCPStreamableHttpServerTransport({});
await server.start(transport);`)}
`)}

${section('mcp-e2e', 'End-to-End: Agent with MCP Tools', `
${code('typescript', `import { weaveMCPClient, weaveMCPTools, createMCPStdioClientTransport } from '@weaveintel/mcp-client';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext } from '@weaveintel/core';

// Connect to the official filesystem MCP server (no API key needed)
const transport = createMCPStdioClientTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', process.env['HOME']! + '/docs'],
});

const client   = weaveMCPClient();
await client.connect(transport);
const mcpTools = weaveMCPTools(client, await client.listTools());   // all MCP tools as a ToolRegistry

const agent  = weaveAgent({
  model:        weaveAnthropicModel('claude-sonnet-4-6'),
  tools:        mcpTools,
  systemPrompt: 'You have access to the user\\'s ~/docs directory via MCP tools. Help them find and summarise documents.',
  maxSteps:     5,
});

const ctx    = weaveContext({ userId: 'alice' });
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'Find and summarise the latest quarterly report in my docs folder.' }],
});
console.log(result.output);

// Clean up
await client.disconnect();`, ['@weaveintel/mcp-client', '@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/core'])}
`)}`;
}

function sObservability(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/observability</span></div>
  <h1 class="pkg-title">Observability</h1>
  <p class="pkg-desc">Distributed tracing, usage tracking, budget monitoring, and span export for agents and workflows. Observability is ambient — attach a tracer to <code>weaveRuntime</code> once and every agent, tool call, and model call emits spans automatically.</p>
</div>

${callout('info', '📈', 'Ambient wiring.', 'Attach the tracer to the runtime at construction. Every context derived from it inherits the tracer automatically — you never pass a tracer through function arguments.')}

${exlinks([
  ['10-observability.ts', 'Example 10 — Observability'],
  ['123-runtime-golden-path.ts', 'Example 123 — Runtime Golden Path (tracer wired)'],
  ['21-workflow-observability.ts', 'Example 21 — Workflow Observability (W6)'],
])}

${section('obs-tracer', 'Setting up Tracing', `
${code('typescript', `import { weaveConsoleTracer, weaveInMemoryTracer } from '@weaveintel/observability';
import { weaveRuntime, weaveContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

// Console tracer — prints spans to stdout (development)
const consoleRuntime = weaveRuntime({
  tracer: weaveConsoleTracer(),
});

// In-memory tracer — query spans programmatically (tests, CI)
const tracer = weaveInMemoryTracer();
const runtime = weaveRuntime({ tracer });

// Construct a context — it inherits the tracer automatically
const ctx = weaveContext({ runtime, userId: 'alice', tenantId: 'acme' });

// Run the agent — spans emit through the tracer with no extra wiring
const agent = weaveAgent({ model, tools });
await agent.run(ctx, {
  messages: [{ role: 'user', content: 'Analyse the latest earnings report.' }],
});

// Retrieve spans after the run (the in-memory tracer exposes a .spans array)
const spans = tracer.spans;
spans.forEach(s => {
  console.log(\`[\${s.name}] \${s.endTime - s.startTime}ms status=\${s.status}\`);
  if (s.attributes['tool.name']) {
    console.log('  tool:', s.attributes['tool.name']);
  }
});`, ['@weaveintel/observability', '@weaveintel/core', '@weaveintel/agents'])}

<h4>Span structure</h4>
${returns([
  ['spanId', 'Unique span identifier (UUIDv7).'],
  ['parentSpanId', 'Parent span id for trace tree reconstruction. Root spans have no parent.'],
  ['name', 'Span operation name, e.g. <code>agents.model.generate</code>, <code>agents.tool.invoke</code>.'],
  ['startTime', 'Unix ms timestamp when the span started.'],
  ['endTime', 'Unix ms timestamp when the span ended.'],
  ['status', '<code>"ok"</code> or <code>"error"</code>.'],
  ['attributes', 'Free-form key/value bag — includes model id, tool name, token counts, agent name.'],
])}
`)}

${section('obs-budget', 'Budget Tracking & Alerts', `
${code('typescript', `import { weaveBudgetTracker, weaveUsageTracker, type BudgetAlert } from '@weaveintel/observability';

// Budget tracker enforces per-hour / per-request token + cost ceilings
const budget = weaveBudgetTracker({
  maxTokensPerHour:   500_000,
  maxCostPerHour:     100.00,   // $100/hour
  maxTokensPerRequest: 50_000,
  onAlert: (alert: BudgetAlert) => {
    pagerDuty.trigger(\`Budget alert: \${alert.type} = \${alert.current} (limit \${alert.limit})\`);
  },
});

// Usage tracker accumulates token/cost records per execution
const usage = weaveUsageTracker();

usage.record({
  executionId: 'exec-1',
  model:       'claude-sonnet-4-6',
  provider:    'anthropic',
  promptTokens: 1200, completionTokens: 300, totalTokens: 1500,
  costUsd: 0.009, timestamp: Date.now(),
});

// Aggregate by execution or across everything
console.log(usage.getTotal('exec-1'));
console.log(usage.getAll());`, ['@weaveintel/observability'])}
`)}

${section('obs-otel', 'OpenTelemetry Export', `
${code('typescript', `import { createOtelTracer } from '@weaveintel/observability';
import { weaveRuntime, weaveContext } from '@weaveintel/core';

// createOtelTracer exports weaveIntel spans straight to an OTLP endpoint —
// no separate @opentelemetry/sdk-node wiring needed. Point it at your collector.
const runtime = weaveRuntime({
  tracer: createOtelTracer({
    serviceName: 'my-app',
    endpoint:    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://otel-collector:4318',
  }),
});
const ctx = weaveContext({ runtime });
// All spans now appear in your Jaeger / Tempo / Honeycomb dashboard`, ['@weaveintel/observability', '@weaveintel/core'])}
`)}`;
}

function sCore(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/core</span></div>
  <h1 class="pkg-title">@weaveintel/core</h1>
  <p class="pkg-desc">Zero-dependency contract layer. Every interface used across the monorepo — Model, Tool, Memory, EventBus, ExecutionContext, WeaveRuntime, AuditLogger — lives here. No package imports a concrete implementation from another; all use these contracts. This is what keeps the framework swappable and testable.</p>
</div>

${callout('info', '⚛️', 'The import rule.', 'Application code imports <em>contracts</em> from <code>@weaveintel/core</code> and <em>implementations</em> from specific packages. Never import a provider or adapter directly in shared business logic — this is what makes the whole system testable and swappable.')}

${exlinks([
  ['123-runtime-golden-path.ts', 'Example 123 — Runtime Golden Path'],
  ['124-ambient-agent.ts', 'Example 124 — Ambient Agent (all cross-cutting concerns wired)'],
])}

${section('core-runtime', 'weaveRuntime — The Composition Root', `
<p><code>weaveRuntime()</code> is the single object every adopter constructs once at boot. Every <code>ExecutionContext</code> is derived from it. Cross-cutting concerns (egress, secrets, audit, tracer, guardrails, persistence, resilience) are resolved from <code>ctx.runtime</code> — never constructed ad-hoc per call site.</p>

${code('typescript', `import {
  weaveRuntime,
  weaveContext,
  weaveAudit,
  weaveLogSafetyDowngrade,
  RuntimeCapabilities,
  assertRuntimeRequires,
} from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveConsoleTracer } from '@weaveintel/observability';
import { weaveRedactor } from '@weaveintel/guardrails/redaction';

const runtime = weaveRuntime({
  // 1. Tracer — every span, agent step, and tool call emits here
  tracer:   weaveConsoleTracer(),

  // 2. Secrets — API keys and credentials resolved through this, not process.env
  secrets:  envSecretResolver(),      // default — reads process.env

  // 3. Persistence — one slot, all durable subsystems inherit it
  persistence: weaveSqlitePersistence({ path: './weave.db' }),

  // 4. Audit — auto-wired from persistence; log is durable with no extra config
  //    (omit to use the auto-wired durable logger)

  // 5. Auto-redaction on audit write paths
  redactor: weaveRedactor({
    patterns: [
      { name: 'email', type: 'builtin', builtinType: 'email' },
      { name: 'phone', type: 'builtin', builtinType: 'phone' },
    ],
  }),

  // 6. Guardrails — consulted before every tool call and model output
  guardrails: {
    async checkToolCall(ctx, schema) {
      if (schema.riskLevel === 'financial' && ctx.metadata['plan'] === 'free') {
        return { allow: false, reason: 'financial tools require a paid plan' };
      }
      return { allow: true };
    },
    async checkOutput(ctx, text) {
      if (/sk-[A-Za-z0-9]{20,}/.test(text)) {
        return { allow: true, redactedText: text.replace(/sk-[A-Za-z0-9]{20,}/g, '[API_KEY]') };
      }
      return { allow: true };
    },
  },

  // 7. TLS floor — throw at construction if NODE_TLS_REJECT_UNAUTHORIZED=0
  tlsFloor: true,     // default

  // 8. Install as process-wide default tracer (for legacy call sites)
  installDefaultTracer: true,  // default
});

// Derive every context from the runtime
const ctx = weaveContext({ runtime, userId: 'alice', tenantId: 'acme' });

// Emit an audit entry — lands in the auto-wired durable logger
await weaveAudit(ctx, {
  action:   'user.login',
  outcome:  'success',
  resource: 'auth',
  details:  { email: 'alice@example.com' },  // auto-redacted to [EMAIL]
});

// Log an explicit safety downgrade (shows up in every audit sink)
await weaveLogSafetyDowngrade(ctx, {
  feature:   'guardrails',
  reason:    'trusted-internal-agent',
  component: 'batch-processor',
});`, ['@weaveintel/core', '@weaveintel/persistence', '@weaveintel/observability', '@weaveintel/guardrails/redaction'])}

<h4>WeaveRuntimeOptions — complete reference</h4>
${params([
  ['tracer', 'Tracer | "noop"', 'optional', 'Observability tracer. Default: built-in noop. Use <code>weaveConsoleTracer()</code> for dev, <code>weaveInMemoryTracer()</code> for tests, <code>createOtelTracer({ serviceName })</code> for production.'],
  ['secrets', 'SecretResolver', 'optional', 'Secret resolution strategy. Default: <code>envSecretResolver()</code>. Chain multiple resolvers with <code>chainSecretResolvers([])</code>.'],
  ['persistence', 'RuntimePersistenceSlot', 'optional', 'Durable KV backend. When set: DLQ, cost meter, audit, checkpoints, endpoint state all use it. Default: noop (in-memory only).'],
  ['audit', 'AuditLogger', 'optional', 'Explicit audit logger. When omitted and persistence is set, auto-wires a durable logger. When omitted with no persistence, uses noop.'],
  ['redactor', 'Redactor', 'optional', 'When set, wraps the audit logger to auto-redact <code>entry.details</code> before every write.'],
  ['guardrails', 'RuntimeGuardrailsSlot', 'optional', 'Consulted before every tool call (<code>checkToolCall</code>) and after every model response (<code>checkOutput</code>). Absent = allow-all.'],
  ['resilience', 'RuntimeResilienceSlot', 'optional', 'Signal bus for endpoint health events. Custom providers wire endpoint signals here.'],
  ['tlsFloor', 'boolean', 'optional', 'Throw at construction if <code>NODE_TLS_REJECT_UNAUTHORIZED=0</code>. Default: <code>true</code>. Set <code>false</code> only in test environments.'],
  ['installDefaultTracer', 'boolean', 'optional', 'Also call <code>weaveSetDefaultTracer(tracer)</code> so legacy call sites pick it up. Default: <code>true</code>.'],
  ['extraCapabilities', 'CapabilityId[]', 'optional', 'Additional capability IDs to advertise (e.g. <code>RuntimeCapabilities.Encryption</code> when the encryption package is configured).'],
])}
`)}

${section('core-capabilities', 'RuntimeCapabilities — Checking What the Runtime Provides', `
${code('typescript', `import { RuntimeCapabilities, assertRuntimeRequires } from '@weaveintel/core';

// Check a single capability
if (runtime.has(RuntimeCapabilities.Persistence)) {
  console.log('Durable storage is available');
}

// Assert multiple capabilities at registration time (throws a readable error if missing)
assertRuntimeRequires(
  runtime,
  [RuntimeCapabilities.NetEgress, RuntimeCapabilities.Audit],
  'my-feature',
);
// ↑ throws: "my-feature: runtime does not satisfy declared requires: missing runtime.audit"

// Describe everything the runtime provides
import { describeRuntimeCapabilities } from '@weaveintel/core';
console.log(describeRuntimeCapabilities(runtime));
// ['runtime.net.egress', 'runtime.observability', 'runtime.secrets', 'runtime.audit',
//  'runtime.persistence', 'runtime.guardrails']`, ['@weaveintel/core'])}

<h4>All capability IDs</h4>
${typeTable([
  ['RuntimeCapabilities.NetEgress       (runtime.net.egress)', 'Hardened egress client is available. Always present.'],
  ['RuntimeCapabilities.Observability   (runtime.observability)', 'A real tracer is wired. Always present (noop counts).'],
  ['RuntimeCapabilities.Secrets         (runtime.secrets)', 'Secret resolver is available. Always present.'],
  ['RuntimeCapabilities.Audit           (runtime.audit)', 'Audit logger is available. Always present (noop counts).'],
  ['RuntimeCapabilities.Persistence     (runtime.persistence)', 'KV persistence slot is configured. Present only when <code>persistence</code> is set.'],
  ['RuntimeCapabilities.Resilience      (runtime.resilience)', 'Resilience signal bus is wired. Present only when <code>resilience</code> is set.'],
  ['RuntimeCapabilities.Encryption      (runtime.encryption)', 'Tenant encryption is configured. Advertised via <code>extraCapabilities</code>.'],
  ['RuntimeCapabilities.Guardrails      (runtime.guardrails)', 'Guardrails slot is configured. Present only when <code>guardrails</code> is set.'],
])}
`)}

${section('core-context', 'ExecutionContext', `
${code('typescript', `import { weaveContext, weaveChildContext } from '@weaveintel/core';

// Root context — constructed once per request/run
const rootCtx = weaveContext({
  runtime,                       // inherits tracer, secrets, audit, guardrails
  userId:    'user-alice',
  tenantId:  'org-acme',
  metadata:  { plan: 'pro', region: 'ap-southeast-2' },
});

// Child context for a sub-operation — inherits all parent fields
const childCtx = weaveChildContext(rootCtx, {
  metadata: { ...rootCtx.metadata, subOp: 'embedding' },
});

// Cancellable context — abort after 30 s
const abortCtx = weaveContext({
  runtime,
  signal: AbortSignal.timeout(30_000),
  userId: 'alice',
});`, ['@weaveintel/core'])}

<h4>ExecutionContext fields</h4>
${returns([
  ['executionId', 'Unique trace root ID (UUIDv7). Auto-generated if not provided.'],
  ['runtime', 'The ambient WeaveRuntime. Carry cross-cutting services without function-argument threading.'],
  ['userId', 'User identity for access control and audit entries.'],
  ['tenantId', 'Tenant isolation — propagated to memory writes, audit entries, encryption context.'],
  ['metadata', 'Arbitrary request-scoped bag. Accessible inside every tool.execute() call.'],
  ['signal', 'AbortSignal for cancellation and timeout. Composited automatically with provider timeouts.'],
  ['tracer', 'Resolved from runtime.tracer when runtime is present; otherwise from the process-wide default.'],
])}
`)}

${section('core-tools', 'Tool Interfaces', `
${code('typescript', `import { weaveTool, weaveToolRegistry } from '@weaveintel/core';
import type { Tool, ToolRegistry, ToolOutput } from '@weaveintel/core';

const bookFlightTool = weaveTool({
  name:        'book_flight',
  description: 'Book a flight for a passenger. Use when the user wants to reserve a specific flight.',
  parameters: {
    type: 'object',
    required: ['from', 'to', 'date', 'passengerId'],
    properties: {
      from:        { type: 'string', description: 'IATA departure airport code.' },
      to:          { type: 'string', description: 'IATA destination airport code.' },
      date:        { type: 'string', format: 'date', description: 'Travel date YYYY-MM-DD.' },
      passengerId: { type: 'string' },
      cabinClass:  { type: 'string', enum: ['economy', 'business', 'first'] },
    },
  },
  requiresApproval: true,
  riskLevel:        'write',
  requires:         [RuntimeCapabilities.NetEgress],
  tags:             ['travel', 'booking'],
  execute: async ({ from, to, date, passengerId, cabinClass = 'economy' }, ctx) => {
    const booking = await flightService.book({ from, to, date, passengerId, cabinClass });
    return JSON.stringify({ bookingId: booking.id, status: 'confirmed', total: booking.totalUsd });
  },
});

// Return an error without throwing — agent sees "Error: ..." in its context
const errorTool = weaveTool({
  name: 'failing_tool', description: '…',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const output: ToolOutput = { content: 'Service is unavailable', isError: true };
    return output;   // agent continues; step.toolCall.result starts with "Error:"
  },
});

const registry = weaveToolRegistry({ runtime });   // runtime optional — enables capability check
registry.register(bookFlightTool);
const defs = registry.toDefinitions();             // shape sent to the LLM`, ['@weaveintel/core'])}
`)}

${section('core-events', 'EventBus', `
${code('typescript', `import { weaveEventBus, EventTypes } from '@weaveintel/core';

const bus = weaveEventBus();

// Listen to agent steps
bus.on(EventTypes.AgentRunStart, e => console.log(\`Agent started: \${e.data.agent}\`));
bus.on(EventTypes.ToolCallStart,  e => console.log(\`Tool call: \${e.data.tool}\`));
bus.on(EventTypes.ToolCallEnd,    e => console.log(\`Tool done: \${e.data.tool} result=\${String(e.data.result ?? '').slice(0,60)}\`));
bus.on(EventTypes.AgentRunEnd,    e => console.log(\`Agent done: steps=\${e.data.steps}\`));

// Listen to model calls for token metering (event.data is a free-form bag)
bus.on(EventTypes.ModelRequestEnd, e => {
  const usage = e.data.usage as { totalTokens?: number } | undefined;
  metrics.increment('llm.tokens', usage?.totalTokens ?? 0, { provider: String(e.data.provider) });
});

// One-time listener
const unsub = bus.on(EventTypes.AgentRunEnd, handler);
unsub();   // unsubscribe`, ['@weaveintel/core'])}
`)}

${section('core-audit', 'AuditEntry — Reference', `
${params([
  ['timestamp', 'string (ISO-8601)', 'required', 'When the entry was created. Auto-set by <code>weaveAudit()</code>.'],
  ['executionId', 'string', 'required', 'Trace root — <code>ctx.executionId</code>. Links audit entries to a specific run.'],
  ['tenantId', 'string', 'optional', 'From <code>ctx.tenantId</code>. Used for multi-tenant audit export and filtering.'],
  ['userId', 'string', 'optional', 'From <code>ctx.userId</code>. Links audit entries to a specific user.'],
  ['action', 'string', 'required', 'What happened. Framework standard actions: <code>agent.run.start</code>, <code>agent.tool.invoke</code>, <code>agent.run.end</code>, <code>agent.output.denied</code>, <code>workflow.run.start</code>, <code>workflow.step.start</code>, <code>live-agent.tick.start</code>.'],
  ['resource', 'string', 'optional', 'What was acted on — tool name, workflow id, agent name, etc.'],
  ['outcome', '"success" | "failure" | "denied"', 'required', 'The result of the action.'],
  ['details', 'Record&lt;string,unknown&gt;', 'optional', 'Structured context. Auto-redacted when a <code>Redactor</code> is configured on the runtime.'],
])}
`)}`;
}

// ── Section: Security & Hardening ────────────────────────────────────────

function sSecurity(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">Security &amp; Hardening</span></div>
  <h1 class="pkg-title">Security &amp; Hardening</h1>
  <p class="pkg-desc">Production-grade security is ambient in weaveIntel — not something you bolt on. Every outbound HTTP call is SSRF-blocked, every audit entry can auto-redact PII, TLS floor is enforced at runtime construction, and the agent loop is fail-closed against guardrails violations. This section covers every security primitive, what it protects against, and how to configure it.</p>
</div>

${callout('danger', '🔒', 'Security is default-on.', 'All safety primitives activate when you call <code>weaveRuntime()</code>. Disabling any is explicit, logged, and auditable. There is no silent way to bypass egress guards, TLS floor, or guardrails.')}

${exlinks([
  ['123-runtime-golden-path.ts', 'Example 123 — Runtime Golden Path (all safety on)'],
  ['127-phase5-security.ts', 'Example 127 — Security (TLS floor, durable audit, PII redaction, DNS pinning)'],
])}

${section('sec-egress', 'Hardened Egress — SSRF & Redirect Protection', `
<p>Every outbound HTTP call in weaveIntel packages goes through <code>hardenedFetch</code> — a pipeline that composes five safety primitives in sequence. No package calls the global <code>fetch</code> directly.</p>

${featureCards([
  ['SSRF blocking', 'Rejects cloud-metadata endpoints (AWS 169.254.169.254, GCP metadata.google.internal, Azure IMDS), all RFC1918 + link-local + ULA ranges, and loopback unless explicitly allowed.'],
  ['Redirect re-validation', 'Uses <code>redirect: "manual"</code> and re-runs the SSRF check on every Location header before following. A crafted 302 to a metadata endpoint is blocked.'],
  ['DNS rebinding (TOCTOU) fix', 'An undici Agent with a custom <code>connect.lookup</code> hook validates the resolved IP at connection time — the same IP that was checked during validation is the one used for the TCP handshake.'],
  ['TLS/HTTPS floor', 'Only HTTPS is allowed for non-loopback hosts. <code>http://</code> to external hosts throws immediately. Configurable <code>enforceHttps: false</code> for intranet-only callers.'],
  ['Outer timeout + size cap', 'Default: 60 s timeout, 50 MiB response cap. Both are configurable per-package and per-call. Streaming endpoints skip the cap via <code>timeoutMs: 0, maxBytes: 0</code>.'],
])}

<h4>Per-package usage (recommended)</h4>
${code('typescript', `import { createHardenedFetch } from '@weaveintel/core';

// Each package binds a closure with its own errorTag.
// Every call from this package uses the same safety pipeline.
const { fetch, fetchStream, assertSafe } = createHardenedFetch({
  errorTag:  'my-integration',   // appears in every thrown error
  timeoutMs: 30_000,             // per-call wall-clock limit (default 60 s)
  maxBytes:  10 * 1024 * 1024,   // 10 MiB response cap (default 50 MiB)
  policy: {
    allowedHosts: ['api.openai.com', 'api.anthropic.com'],  // allowlist
    blockedHosts: ['internal.corp'],                         // extra blocklist
    allowLoopback: false,         // deny even 127.0.0.1
  },
});

// Regular JSON call
const resp = await fetch('https://api.openai.com/v1/models', {
  headers: { Authorization: \`Bearer \${apiKey}\` },
});
const data = await resp.json();

// Long-lived SSE / NDJSON stream — SSRF guard still applies, timeout skipped
const stream = await fetchStream('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  body: JSON.stringify({ model: 'gpt-4o', stream: true, messages }),
  headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
});
const reader = stream.body!.getReader();`, ['@weaveintel/core'])}

<h4>One-off hardened call</h4>
${code('typescript', `import { hardenedFetch } from '@weaveintel/core';

// Use directly when you do not own the package, e.g. in app code.
const resp = await hardenedFetch('https://api.example.com/data', {
  method: 'POST',
  body: JSON.stringify({ q: userInput }),
  headers: { 'Content-Type': 'application/json' },
}, {
  errorTag:  'my-app',
  timeoutMs: 15_000,
  maxBytes:  2 * 1024 * 1024,
});`, ['@weaveintel/core'])}

<h4>Manual URL validation</h4>
${code('typescript', `import { assertSafeOutboundUrl, validateResolvedAddress } from '@weaveintel/core';

// Use when you handle fetch yourself (e.g. inside an undici Agent)
await assertSafeOutboundUrl('https://api.example.com/webhook', {
  errorTag: 'my-tool',
  allowLoopback: false,
});

// Use inside a custom DNS lookup hook to close the TOCTOU window
validateResolvedAddress('10.0.0.1', { errorTag: 'my-tool' });
// ↑ throws: "my-tool: host resolved to private address 10.0.0.1 — DNS rebinding detected"`, ['@weaveintel/core'])}

${params([
  ['errorTag', 'string', 'required', 'Prefix in every thrown error. Identifies the calling package.'],
  ['timeoutMs', 'number', 'optional', 'Outer AbortSignal timeout. Default 60 000. Pass 0 for streaming (disables timeout + size cap).'],
  ['maxBytes', 'number', 'optional', 'Maximum response body size in bytes. Default 50 MiB. Pass 0 to disable.'],
  ['enforceHttps', 'boolean', 'optional', 'Reject non-HTTPS non-loopback URLs. Default true.'],
  ['policy.allowedHosts', 'string[]', 'optional', 'If non-empty, only these hostnames (exact or suffix match) are permitted.'],
  ['policy.blockedHosts', 'string[]', 'optional', 'Extra hostnames to block in addition to the default cloud-metadata list.'],
  ['policy.allowLoopback', 'boolean', 'optional', 'Allow http://localhost / 127.0.0.1. Default true.'],
  ['policy.allowPrivateNetwork', 'boolean', 'optional', 'Allow RFC1918 / link-local destinations. Default false.'],
])}
`)}

${section('sec-tls', 'TLS Floor — NODE_TLS_REJECT_UNAUTHORIZED Guard', `
<p><code>NODE_TLS_REJECT_UNAUTHORIZED=0</code> silently disables TLS certificate verification for the entire Node.js process, making every HTTPS connection vulnerable to MITM. <code>assertTlsFloor()</code> detects this and throws at construction time.</p>

${code('typescript', `import { weaveRuntime, assertTlsFloor } from '@weaveintel/core';

// Default: assertTlsFloor() is called inside weaveRuntime()
// Throws immediately if NODE_TLS_REJECT_UNAUTHORIZED=0
const runtime = weaveRuntime();  // ← safe

// Test environments with self-signed certs — suppress the check
const testRuntime = weaveRuntime({ tlsFloor: false });

// Call directly to check from outside the runtime
assertTlsFloor(); // throws: "weaveRuntime: TLS floor violated — NODE_TLS_REJECT_UNAUTHORIZED=0 is set…"`, ['@weaveintel/core'])}

${callout('warn', '⚠️', 'Never disable in production.', 'Set <code>tlsFloor: false</code> only in CI/test environments with controlled self-signed certs (e.g. a local Vault dev server). Production deployments with valid certs should always leave it on.')}
`)}

${section('sec-audit', 'Durable Audit Logger — Auto-wired on Persistence', `
<p>Every agent run, tool call, workflow step, and policy denial emits a structured <code>AuditEntry</code> through <code>weaveAudit(ctx, entry)</code>. By default the runtime uses a noop logger. When you configure a <code>persistence</code> slot, a durable KV-backed logger is automatically wired — no extra configuration needed.</p>

${code('typescript', `import { weaveRuntime, weaveContext, weaveAudit } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

// Persistence slot = durable audit logger, auto-wired
const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './audit.db' }),
  tlsFloor: false,  // set true in production
});
const ctx = weaveContext({ runtime, userId: 'alice', tenantId: 'acme' });

// Emit a custom audit entry — same call the agent loop uses internally
await weaveAudit(ctx, {
  action:   'payment.initiated',
  outcome:  'success',
  resource: 'order/ORD-001',
  details:  { amount: 99.99, currency: 'USD' },
});

// Read back all audit entries from the KV store
const entries = await runtime.persistence!.kv.list('audit:');
for (const e of entries) {
  const entry = JSON.parse(e.value);
  console.log(entry.action, entry.outcome, entry.timestamp);
}`, ['@weaveintel/core', '@weaveintel/persistence'])}

<h4>Standalone durable logger (without a full runtime)</h4>
${code('typescript', `import { createDurableAuditLogger, weaveInMemoryPersistence } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

const logger = createDurableAuditLogger({
  persistence: weaveSqlitePersistence({ path: './audit.db' }),
  namespace:   'myapp',            // KV key prefix, default: "audit"
});

await logger.log({
  timestamp:   new Date().toISOString(),
  executionId: 'exec-001',
  tenantId:    'acme',
  userId:      'alice',
  action:      'tool.invoke',
  outcome:     'success',
  resource:    'web_search',
  details:     { query: 'latest AI news' },
});`, ['@weaveintel/core', '@weaveintel/persistence'])}

${params([
  ['persistence', 'RuntimePersistenceSlot', 'optional', 'KV backend. Falls back to <code>weaveInMemoryPersistence()</code> for zero-config DX.'],
  ['namespace', 'string', 'optional', 'KV key prefix. Default: <code>"audit"</code>. Keys are <code>audit:&lt;timestamp&gt;:&lt;uuid&gt;</code>.'],
])}
`)}

${section('sec-redaction', 'Auto-Redaction on Audit Write Paths', `
<p>When a <code>Redactor</code> is configured on the runtime, every audit entry's <code>details</code> object is automatically run through the redactor before the entry reaches the KV store. PII never lands in the audit trail, without any changes to call sites.</p>

${code('typescript', `import { weaveRuntime, weaveContext, weaveAudit } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveRedactor } from '@weaveintel/guardrails/redaction';

const redactor = weaveRedactor({
  patterns: [
    { name: 'email',       type: 'builtin', builtinType: 'email' },
    { name: 'phone',       type: 'builtin', builtinType: 'phone' },
    { name: 'ssn',         type: 'builtin', builtinType: 'ssn' },
    { name: 'credit-card', type: 'builtin', builtinType: 'credit_card' },
    { name: 'api-key',     type: 'regex',   pattern: 'sk-[A-Za-z0-9]{20,}' },
  ],
});

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './audit.db' }),
  redactor,   // ← wraps the durable audit logger with auto-redaction
});
const ctx = weaveContext({ runtime });

// This entry's details.email will be "[EMAIL]" in the store
await weaveAudit(ctx, {
  action: 'user.login', outcome: 'success',
  details: { email: 'alice@example.com', ip: '1.2.3.4' },
});`, ['@weaveintel/core', '@weaveintel/persistence', '@weaveintel/guardrails/redaction'])}

<h4>Wrap any logger manually</h4>
${code('typescript', `import { createRedactingAuditLogger } from '@weaveintel/core';

// Wrap any AuditLogger — e.g. your existing logging service
const redactingLogger = createRedactingAuditLogger(existingLogger, redactor);
// Every entry.details is JSON-stringified → redacted → parsed before forwarding`, ['@weaveintel/core'])}
`)}

${section('sec-guardrails', 'Ambient Guardrails — Tool Call & Output Gate', `
<p>The <code>RuntimeGuardrailsSlot</code> is a structural interface on <code>WeaveRuntime</code>. The agent loop consults it before every tool invocation (<code>checkToolCall</code>) and on every terminal response (<code>checkOutput</code>). A denial is always fail-closed: the tool call or response is blocked, and an audit entry is emitted.</p>

${code('typescript', `import { weaveRuntime, weaveContext } from '@weaveintel/core';
import type { RuntimeGuardrailsSlot } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

const guardrails: RuntimeGuardrailsSlot = {
  // Called before every tool invocation
  async checkToolCall(ctx, schema, args) {
    // Deny financial tools for read-only users
    if (schema.riskLevel === 'financial' && ctx.userId === 'viewer') {
      return { allow: false, reason: 'financial tools require write permission' };
    }
    // Deny if a URL argument is not HTTPS
    const url = args['url'];
    if (typeof url === 'string' && !url.startsWith('https://')) {
      return { allow: false, reason: 'only HTTPS URLs are permitted' };
    }
    return { allow: true };
  },

  // Called on every terminal agent response
  async checkOutput(ctx, text) {
    // Strip any leaked API keys
    if (/sk-[A-Za-z0-9]{20,}/.test(text)) {
      return {
        allow: true,
        redactedText: text.replace(/sk-[A-Za-z0-9]{20,}/g, '[API_KEY]'),
      };
    }
    // Block responses containing NSFW content (integrate your classifier here)
    if (await nsfwClassifier.isFlagged(text)) {
      return { allow: false, reason: 'content policy violation' };
    }
    return { allow: true };
  },
};

const runtime = weaveRuntime({ guardrails });
const agent = weaveAgent({ model, tools });
const ctx = weaveContext({ runtime });
const result = await agent.run(ctx, { messages });
// Tool denials → audit entry action:"agent.tool.invoke" outcome:"denied"
// Output denials → audit entry action:"agent.output.denied" outcome:"denied"`, ['@weaveintel/core', '@weaveintel/agents'])}

${params([
  ['checkToolCall', '(ctx, schema, args) => Promise<{ allow, reason? }>', 'optional', 'Called before every tool invocation. Return <code>{ allow: false, reason }</code> to block. Errors are treated as denials (fail-closed).'],
  ['checkOutput', '(ctx, text) => Promise<{ allow, redactedText?, reason? }>', 'optional', 'Called on every terminal agent response. Return <code>redactedText</code> to substitute, or <code>allow: false</code> to block entirely.'],
])}

${callout('info', '💡', 'Graceful by construction.', 'A missing <code>guardrails</code> slot is equivalent to allow-all. The agent loop never throws when guardrails are absent. Opting out of a configured guardrail must be explicit and logged via <code>weaveLogSafetyDowngrade(ctx, { feature, reason })</code>.')}
`)}

${section('sec-sandbox-egress', 'Sandbox Egress Allowlist', `
<p>The code-execution sandbox (<code>@weaveintel/sandbox</code>) runs containers with <code>--network=none</code> by default. Enabling outbound network access requires an explicit <code>networkAllowlist</code> — without one, <code>networkAccess: true</code> has no effect and the container stays isolated.</p>

${code('typescript', `import { createSandbox } from '@weaveintel/sandbox';
import type { SandboxPolicy } from '@weaveintel/core';

const sandbox = createSandbox();

// networkAccess: false by default → the container runs with --network=none.
// Opening egress is an explicit, per-policy decision.
const policy: SandboxPolicy = {
  id: 'python-net',
  name: 'Python with limited egress',
  networkAccess: true,                       // explicit opt-in
  allowedModules: ['requests', 'json'],      // only these modules may be imported
  fileSystemAccess: 'none',
  limits: { maxDurationMs: 30_000, maxMemoryMb: 512 },
  enabled: true,
};

const result = await sandbox.execute('import requests; print(requests.__version__)', policy);
// Full per-host filtering requires CNI-based egress (road-mapped).`, ['@weaveintel/sandbox', '@weaveintel/core'])}
`)}

${section('sec-runtime-secrets', 'Secret Resolution — Never Read process.env Directly', `
<p>Provider API keys and other secrets MUST flow through <code>runtime.secrets</code> rather than being read from <code>process.env</code> at call sites. This lets vault, KMS, or per-tenant override resolvers plug in without touching business logic.</p>

${code('typescript', `import { weaveRuntime, weaveContext, envSecretResolver, chainSecretResolvers, inMemorySecretResolver, requireSecret } from '@weaveintel/core';
import type { SecretResolver } from '@weaveintel/core';

// Default: reads from process.env (fine for development)
const runtime = weaveRuntime();
const ctx = weaveContext({ runtime });
const apiKey = await requireSecret(ctx.runtime!.secrets, 'OPENAI_API_KEY');

// A SecretResolver is just { resolve(key): Promise<string | undefined> }.
// Implement one for your secret store (Vault, AWS Secrets Manager, ...).
const vaultSecretResolver = (opts: { path: string }): SecretResolver => ({
  async resolve(key) {
    const res = await vaultClient.read(\`\${opts.path}/\${key}\`);
    return res?.data?.value;
  },
});

// Production: chain resolvers — Vault first, fall back to env
const chainedRuntime = weaveRuntime({
  secrets: chainSecretResolvers(
    vaultSecretResolver({ path: 'secret/data/myapp' }),
    envSecretResolver(),  // fallback
  ),
});

// Provide secrets in-memory (for testing)
const testRuntime = weaveRuntime({
  secrets: inMemorySecretResolver({ OPENAI_API_KEY: 'sk-test-...' }),
});`, ['@weaveintel/core'])}
`)}`;
}

// ── Section: Providers ────────────────────────────────────────────────────

function sProviders(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap">
    <span class="pkg-badge">@weaveintel/provider-*</span>
  </div>
  <h1 class="pkg-title">Providers</h1>
  <p class="pkg-desc">Provider packages implement the <code>Model</code> interface from <code>@weaveintel/core</code> for each LLM vendor or local runtime. Every provider: routes through the hardened egress client (SSRF-safe), wraps calls in a shared process-wide circuit breaker + token bucket, and resolves API keys through <code>runtime.secrets</code>.</p>
</div>

${callout('info', '🔌', 'All providers use the same interface.', 'Once you have a <code>Model</code> instance from any provider, you pass it to <code>weaveAgent</code>, <code>DefaultWorkflowEngine</code>, or any other consumer. Swapping providers requires changing one line.')}

${exlinks([
  ['01-simple-chat.ts', 'Example 01 — Simple Chat (OpenAI)'],
  ['11-anthropic-provider.ts', 'Example 11 — Anthropic Provider'],
])}

${section('prov-anthropic', 'Anthropic — Claude Models', `
${code('typescript', `import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

// All Claude 4 models
const haiku  = weaveAnthropicModel('claude-haiku-4-5-20251001');   // fastest, cheapest
const sonnet = weaveAnthropicModel('claude-sonnet-4-6');            // best balance
const opus   = weaveAnthropicModel('claude-opus-4-8');              // most capable

// With explicit options
const model = weaveAnthropicModel('claude-sonnet-4-6', {
  apiKey:  process.env['ANTHROPIC_API_KEY'],   // or omit to use ANTHROPIC_API_KEY env
  baseUrl: 'https://api.anthropic.com',        // override for proxy setups
  betaFeatures: ['interleaved-thinking-2025-05-14'],  // enable beta headers
  defaultHeaders: { 'anthropic-client-id': 'myapp' },
});

// Stream a response
const ctx = weaveContext();
const response = await model.generate(ctx, {
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript.' }],
  maxTokens: 100,
  temperature: 0.7,
});
console.log(response.content);
console.log(response.usage); // { promptTokens, completionTokens, totalTokens }`, ['@weaveintel/provider-anthropic', '@weaveintel/core'])}

${params([
  ['modelId', 'string', 'required', 'Anthropic model identifier. See <a href="https://docs.anthropic.com/models" target="_blank">Anthropic docs</a> for the full list.'],
  ['options.apiKey', 'string', 'optional', 'Defaults to <code>process.env[\'ANTHROPIC_API_KEY\']</code>.'],
  ['options.baseUrl', 'string', 'optional', 'Override for proxy or on-prem deployments.'],
  ['options.betaFeatures', 'string[]', 'optional', 'Beta feature strings appended to <code>anthropic-beta</code> header.'],
  ['options.defaultHeaders', 'Record&lt;string,string&gt;', 'optional', 'Extra headers on every request.'],
])}
`)}

${section('prov-openai', 'OpenAI — GPT Models', `
${code('typescript', `import { weaveOpenAIModel } from '@weaveintel/provider-openai';

const gpt4o     = weaveOpenAIModel('gpt-4o');
const gpt4oMini = weaveOpenAIModel('gpt-4o-mini');
const embed     = weaveOpenAIModel('text-embedding-3-small');    // for embeddings
const o4mini    = weaveOpenAIModel('o4-mini');                   // reasoning model

const model = weaveOpenAIModel('gpt-4o', {
  apiKey:       process.env['OPENAI_API_KEY'],
  organization: process.env['OPENAI_ORG'],
  baseUrl:      'https://api.openai.com/v1',
  defaultHeaders: { 'x-custom-header': 'value' },
});

// Tool-calling
import { weaveContext } from '@weaveintel/core';
const ctx = weaveContext();
const resp = await model.generate(ctx, {
  messages: [{ role: 'user', content: 'What files are in /tmp?' }],
  tools: [{ name: 'list_files', description: '…', parameters: { type: 'object', properties: {} } }],
  toolChoice: 'auto',
});
if (resp.toolCalls?.length) {
  console.log(resp.toolCalls[0].name, resp.toolCalls[0].arguments);
}`, ['@weaveintel/provider-openai', '@weaveintel/core'])}
`)}

${section('prov-google', 'Google — Gemini Models', `
${code('typescript', `import { weaveGoogleModel } from '@weaveintel/provider-google';

const flash = weaveGoogleModel('gemini-2.0-flash');
const pro   = weaveGoogleModel('gemini-1.5-pro');
const embed = weaveGoogleModel('text-embedding-004');  // embeddings

const model = weaveGoogleModel('gemini-2.0-flash', {
  apiKey:  process.env['GOOGLE_API_KEY'],
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
});

const ctx = weaveContext();
const resp = await model.generate(ctx, {
  messages: [{ role: 'user', content: 'Explain transformers in 2 sentences.' }],
  maxTokens: 150,
});`, ['@weaveintel/provider-google', '@weaveintel/core'])}
`)}

${section('prov-ollama', 'Ollama — Local Models', `
<p>Run any model locally via <a href="https://ollama.ai" target="_blank">Ollama</a>. No API key required. Ideal for development, privacy-sensitive workloads, or offline environments.</p>

${code('typescript', `// 1. Start Ollama: ollama serve
// 2. Pull a model: ollama pull llama3.2
import { weaveOllamaModel } from '@weaveintel/provider-ollama';

const llama  = weaveOllamaModel('llama3.2');
const mistral = weaveOllamaModel('mistral');
const phi3   = weaveOllamaModel('phi3');

// Custom Ollama host (e.g. remote GPU server)
const remote = weaveOllamaModel('llama3.2', {
  baseUrl: 'http://gpu-server.local:11434',
});

const ctx = weaveContext();
const resp = await llama.generate(ctx, {
  messages: [{ role: 'user', content: 'Hello!' }],
  temperature: 0.5,
});`, ['@weaveintel/provider-ollama', '@weaveintel/core'])}
`)}

${section('prov-llamacpp', 'llama.cpp — GGUF Local Models', `
${code('typescript', `// 1. Start llama.cpp server:
//    ./server -m model.gguf --port 8080 --host 0.0.0.0
import { weaveLlamaCppModel } from '@weaveintel/provider-llamacpp';

const model = weaveLlamaCppModel('local-gguf', {
  baseUrl: 'http://localhost:8080',
});

const ctx = weaveContext();
const resp = await model.generate(ctx, {
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});`, ['@weaveintel/provider-llamacpp', '@weaveintel/core'])}
`)}

${section('prov-resilience', 'Built-in Provider Resilience', `
<p>All built-in providers automatically wrap every outbound request in a process-wide circuit breaker + token bucket. The shared state means a single 429 from OpenAI pauses the bucket for <em>every caller</em> in the process — chats, agents, evals — instead of each one hammering independently. The defaults come from <code>PROVIDER_RESILIENCE_DEFAULTS</code> exported by <code>@weaveintel/resilience</code>.</p>

${code('typescript', `import { PROVIDER_RESILIENCE_DEFAULTS } from '@weaveintel/resilience';

console.log(PROVIDER_RESILIENCE_DEFAULTS);
// {
//   retry:   { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
//   circuit: { failureThreshold: 8, cooldownMs: 30_000 }
// }

// Custom providers should reuse these defaults:
import { createResilientCallable } from '@weaveintel/resilience';

const myCallable = createResilientCallable(myFetchFn, {
  endpoint: 'my-provider:rest',
  ...PROVIDER_RESILIENCE_DEFAULTS,
});`, ['@weaveintel/resilience'])}
`)}`;
}

// ── Section: Sandbox ─────────────────────────────────────────────────────

function sSandbox(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/sandbox</span></div>
  <h1 class="pkg-title">Sandbox — Safe Code Execution</h1>
  <p class="pkg-desc">Run LLM-generated code in isolated Docker containers with hard resource limits, a read-only filesystem, dropped Linux capabilities, and network-none by default. Supports ephemeral one-shot execution and persistent sessions for multi-turn REPL-style interactions.</p>
</div>

${featureCards([
  ['Security posture', '--network=none, --cap-drop=ALL, --read-only, --user=65534, --security-opt no-new-privileges, tmpfs with noexec'],
  ['Image digest pinning', 'Execution and browser images are pinned by digest so a supply-chain attack cannot substitute a malicious image at runtime.'],
  ['Resource limits', 'CPU cores, memory (MiB), wall-clock timeout, and output directory all configured per-request.'],
  ['Session containers', 'Reuse the same container across turns via chatId. Sessions self-destruct after configurable TTL.'],
  ['Cloud providers', 'Local Docker (dev), ACI, AKS (Kata), GKE (gVisor), Cloud Run — all behind one interface.'],
  ['Browser automation', 'Playwright-enabled image for web scraping, screenshot, and form interaction.'],
])}

${callout('info', '🔒', 'Network isolation.', '<code>networkAccess: true</code> alone does NOT open the network. You must also supply a <code>networkAllowlist</code> with the allowed hostnames. Without a list, the container always runs with <code>--network=none</code>.')}

${exlinks([
  ['sandbox-ephemeral.ts', 'Ephemeral code execution'],
  ['sandbox-session.ts', 'Session-based REPL'],
])}

${section('sandbox-setup', 'Setup & Configuration', `
${code('typescript', `import { createSandbox, createSimulatedSandbox } from '@weaveintel/sandbox';
import type { SandboxPolicy } from '@weaveintel/core';

// Production: createSandbox() declines execution until a real isolated executor
// (ContainerExecutor) is wired in — it never silently pretends to run code.
const sandbox = createSandbox();

// Dev / tests only: an in-process simulator (NOT real isolation).
const devSandbox = createSimulatedSandbox();

// Isolation is expressed per-run via a SandboxPolicy — CPU/memory/time limits,
// module allow/deny lists, filesystem + network posture.
const policy: SandboxPolicy = {
  id: 'python-default',
  name: 'Python (isolated)',
  networkAccess:    false,             // default: isolated (--network=none)
  fileSystemAccess: 'none',
  limits: { maxDurationMs: 30_000, maxMemoryMb: 512, maxCpuMs: 30_000 },
  enabled: true,
};

const result = await devSandbox.execute('print(2 + 2)', policy);
console.log(result.status); // 'success' | 'error' | 'timeout' | 'killed'`, ['@weaveintel/sandbox', '@weaveintel/core'])}
`)}

${section('sandbox-ephemeral', 'Ephemeral Execution', `
<p>Each call starts a fresh container, runs the code, captures stdout/stderr + output files, then destroys the container. Suitable for stateless code snippets.</p>

${code('typescript', `import { createSimulatedSandbox } from '@weaveintel/sandbox';
import type { SandboxPolicy } from '@weaveintel/core';

const sandbox = createSimulatedSandbox();

const policy: SandboxPolicy = {
  id: 'py-ephemeral',
  name: 'Ephemeral Python',
  networkAccess:    false,
  fileSystemAccess: 'none',
  allowedModules:   ['json', 'math'],   // only these imports are permitted
  limits: { maxDurationMs: 10_000, maxMemoryMb: 512 },
  enabled: true,
};

const result = await sandbox.execute(\`
import json, math
data = [1, 2, 3, 4, 5]
mean = sum(data) / len(data)
print(json.dumps({ "mean": mean, "std": math.sqrt(sum((x - mean)**2 for x in data) / len(data)) }))
\`, policy);

if (result.status === 'success') {
  console.log(result.output);         // captured stdout
  console.log(result.artifacts);      // files written under the workspace
} else {
  console.error(result.error);        // stderr / failure reason
}
console.log(\`Ran in \${result.resourceUsage.durationMs} ms\`);`, ['@weaveintel/sandbox', '@weaveintel/core'])}

${params([
  ['code', 'string', 'required', 'Source code to execute (first argument to <code>execute</code>).'],
  ['policy.limits', 'ExecutionLimits', 'required', 'CPU/memory/wall-clock/output caps enforced on the run.'],
  ['policy.allowedModules', 'string[]', 'optional', 'Import allowlist. Anything not listed is denied.'],
  ['policy.deniedModules', 'string[]', 'optional', 'Explicit import denylist.'],
  ['policy.networkAccess', 'boolean', 'required', 'Whether the container may reach the network. Default posture is isolated.'],
  ['policy.fileSystemAccess', '"none" | "read-only" | "read-write"', 'required', 'Filesystem posture for the run.'],
])}
`)}

${section('sandbox-policy', 'Reusing an Execution Policy', `
<p>A <code>SandboxPolicy</code> is a plain, reusable object — define it once and pass it to every <code>execute</code> call that should run under the same limits and module allowlist.</p>

${code('typescript', `import { createSimulatedSandbox } from '@weaveintel/sandbox';
import type { SandboxPolicy } from '@weaveintel/core';

const sandbox = createSimulatedSandbox();

const dataSciencePolicy: SandboxPolicy = {
  id: 'py-datasci',
  name: 'Data-science Python',
  networkAccess:    false,
  fileSystemAccess: 'read-write',
  allowedModules:   ['pandas', 'numpy', 'json'],
  limits: { maxDurationMs: 30_000, maxMemoryMb: 1024 },
  enabled: true,
};

const first = await sandbox.execute(\`
import pandas as pd
df = pd.DataFrame({'x': [1,2,3], 'y': [4,5,6]})
print(df.head())
\`, dataSciencePolicy);

const second = await sandbox.execute('import pandas as pd; print(pd.__version__)', dataSciencePolicy);
console.log(first.status, second.status);`, ['@weaveintel/sandbox', '@weaveintel/core'])}
`)}

${section('sandbox-agent', 'End-to-End: Code-Interpreter Agent', `
<p>A complete agent that uses the sandbox as a tool to execute Python code generated by the model.</p>

${code('typescript', `import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext, weaveTool, weaveToolRegistry } from '@weaveintel/core';
import type { SandboxPolicy } from '@weaveintel/core';
import { createSimulatedSandbox } from '@weaveintel/sandbox';

const sandbox = createSimulatedSandbox();
const pyPolicy: SandboxPolicy = {
  id: 'run-python', name: 'run_python',
  networkAccess: false, fileSystemAccess: 'none',
  limits: { maxDurationMs: 30_000, maxMemoryMb: 512 },
  enabled: true,
};

const tools = weaveToolRegistry();
tools.register(weaveTool({
  name: 'run_python',
  description: 'Execute a Python code snippet and return stdout. Use for calculations, data analysis, and visualisations.',
  parameters: {
    type: 'object', required: ['code'],
    properties: {
      code: { type: 'string', description: 'Valid Python 3 source code.' },
    },
  },
  riskLevel: 'write',
  execute: async ({ code }) => {
    const result = await sandbox.execute(code as string, pyPolicy);
    return result.status === 'success'
      ? JSON.stringify({ output: result.output })
      : JSON.stringify({ error: result.error });
  },
}));

const agent = weaveAgent({
  model: weaveAnthropicModel('claude-sonnet-4-6'),
  tools,
  systemPrompt: 'You are a data analyst. Run Python code to answer quantitative questions.',
  maxSteps: 6,
});

const ctx = weaveContext();
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'Simulate 10,000 rolls of two dice and plot the distribution of sums.' }],
});
console.log(result.output);`, ['@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/core', '@weaveintel/sandbox'])}
`)}`;
}

// ── Section: A2A ─────────────────────────────────────────────────────────

function sA2A(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/a2a</span></div>
  <h1 class="pkg-title">A2A — Agent-to-Agent Protocol v1.0</h1>
  <p class="pkg-desc">Structured message passing between agents — in-process via an in-memory bus, or distributed via HTTP using JSON-RPC 2.0. Agents declare capabilities via signed agent cards, discover each other, and communicate through typed A2A v1.0 envelopes. All communication is audited, traceable, and supports push notifications via HMAC-signed webhooks.</p>
</div>

${callout('info', '🔄', 'When to use A2A.', 'Use A2A when two agents run in <em>separate processes</em> or on separate machines, or when you need typed, versioned message contracts between agents. For single-process multi-agent patterns, the <strong>Supervisor</strong> mode in <code>@weaveintel/agents</code> is simpler.')}

${section('a2a-local', 'In-Process A2A Bus', `
${code('typescript', `import { weaveA2ABus } from '@weaveintel/a2a';
import { weaveContext } from '@weaveintel/core';
import type { A2AServer, A2ATask } from '@weaveintel/core';

// Shared in-process bus — one per application
const bus = weaveA2ABus();

// Build and register an agent server
const researchServer: A2AServer = {
  card: {
    name: 'researcher',
    description: 'Researches topics via web search',
    version: '1.0.0',
    skills: [{ id: 'web-search', name: 'Web Search', description: 'Search and summarise' }],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: false },
    supportedInterfaces: [{ url: 'http://localhost/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  },
  async handleMessage(ctx, params): Promise<A2ATask> {
    const query = params.message.parts.map((p) => p.text ?? '').join(' ');
    // … run research logic …
    return {
      id: 'task-1',
      contextId: params.message.contextId ?? 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
      artifacts: [{ artifactId: 'out', name: 'result', parts: [{ text: \`Research on: \${query}\` }] }],
      history: [params.message],
    };
  },
  async start() {},
  async stop() {},
};

bus.register('researcher', researchServer);

const ctx = weaveContext({ userId: 'u1' });

// Send a task in-process (no HTTP)
const task = await bus.send(ctx, 'researcher', {
  message: {
    role: 'user',
    parts: [{ text: 'Latest advances in quantum computing 2025' }],
    messageId: 'msg-1',
    contextId: 'ctx-1',
  },
});
console.log(task.artifacts[0]?.parts[0]?.text);

// Discover / list agents
const card = bus.discover('researcher');
const all  = bus.listAgents();`, ['@weaveintel/a2a', '@weaveintel/core'])}
`)}

${section('a2a-http', 'Distributed A2A over HTTP (JSON-RPC 2.0)', `
${code('typescript', `import { weaveA2AClient, createA2ADispatcher, createInMemoryA2ATaskStore, createInMemoryPushNotificationStore } from '@weaveintel/a2a';
import { weaveContext } from '@weaveintel/core';

const ctx = weaveContext({ userId: 'u1' });

// ── Server side: wire a JSON-RPC 2.0 dispatcher ─────────────────────────────
const taskStore = createInMemoryA2ATaskStore();
const pushStore = createInMemoryPushNotificationStore();
const dispatcher = createA2ADispatcher(myA2AServer, taskStore, pushStore);

// In your HTTP handler (e.g. POST /api/a2a):
const result = await dispatcher(ctx, { method: 'POST', body: rawBody, headers });
if (result.kind === 'json') {
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.data));
} else {
  // SSE streaming response
  for await (const chunk of streamToSse(result.events)) res.write(chunk);
  res.end();
}

// ── Client side: connect to any A2A v1.0 agent ──────────────────────────────
const client = weaveA2AClient();

// Discover and send a message
const card    = await client.discover('https://research-agent.example.com');
const agentUrl = card.supportedInterfaces?.[0]?.url ?? card.url!;

const task = await client.sendMessage(ctx, agentUrl, {
  message: {
    role: 'user',
    parts: [{ text: 'Summarise recent SEC filings for AAPL' }],
    messageId: 'msg-1',
    contextId: 'ctx-1',
  },
});
console.log(task.status.state); // 'TASK_STATE_COMPLETED'

// Stream events
for await (const event of client.streamMessage(ctx, agentUrl, { message: { role: 'user', parts: [{ text: 'Explain quantum' }], messageId: 'msg-2', contextId: 'ctx-1' } })) {
  if ('artifactUpdate' in event) process.stdout.write(event.artifactUpdate.artifact.parts[0]?.text ?? '');
  if ('task' in event) console.log('\\nDone:', event.task.status.state);
}

// Push notifications — register a webhook
const config = await client.createPushConfig(ctx, agentUrl, task.id, {
  url: 'https://my-server.example.com/webhooks/a2a',
  token: 'hmac-signing-secret',
});
console.log('Push config created:', config.pushConfigId);`, ['@weaveintel/a2a', '@weaveintel/core'])}
`)}

${section('a2a-skills', 'A2A Skills Taxonomy', `
<p>Every A2A agent publishes an <em>Agent Card</em> that lists its skills — the specific capabilities it can perform when another agent sends it a task. Skills are how agents describe themselves so that a supervisor, a discovery service, or a human operator can decide which agent to call.</p>

${callout('info', '📋', 'What is a skill?', 'A skill has an <code>id</code>, a human-readable name, a description, and optional <code>tags</code>. When you register an agent on the A2A bus, its skills are visible to everyone on the bus. The supervisor model reads skill descriptions to decide which agent to delegate to — so clear, specific descriptions matter.')}

<p>The weaveIntel DB seeds 15 standard skills covering the main categories of AI agent work in mid-2026:</p>

${featureCards([
  ['Agentic (chat & reasoning)', '<code>general-chat</code> — everyday conversation and Q&A. <code>ensemble-reasoning</code> — multiple models vote on the best answer. <code>research-synthesis</code> — deep literature search and evidence synthesis. <code>code-review</code> — pull-request review, security scanning, refactoring advice.'],
  ['Supervisor / orchestration', '<code>supervisor-orchestration</code> — decomposes a goal into sub-tasks and delegates to specialist workers. <code>workflow-orchestration</code> — runs complex multi-step durable workflows. <code>hypothesis-validation</code> — scientific method pipeline for testing claims with evidence.'],
  ['Document & data', '<code>document-intelligence</code> — PDF/DOCX/XLSX extraction, summarisation, and Q&A. <code>data-pipeline</code> — ETL, data transformation, pandas/SQL/dbt jobs. <code>memory-retrieval</code> — vector-search knowledge base retrieval and RAG pipelines.'],
  ['Multimodal & computer', '<code>image-analysis</code> — multi-image reasoning, OCR, chart interpretation. <code>image-generation</code> — DALL-E / Imagen image creation. <code>voice-interaction</code> — real-time audio transcription and text-to-speech. <code>computer-use</code> — GUI automation via screenshots (Anthropic computer use). <code>browser-automation</code> — live web browsing, scraping, form interaction. <code>code-execution</code> — sandboxed Python/JS interpreter for data analysis.'],
])}

${code('typescript', `import type { AgentCard } from '@weaveintel/core';

// Register an agent with multiple skills
const documentAgent: AgentCard = {
  name: 'document-processor',
  description: 'Processes and extracts information from documents',
  version: '2.0.0',
  skills: [
    {
      id: 'document-intelligence',
      name: 'Document Intelligence',
      description: 'Extract, summarise, and answer questions from PDF, Word, and Excel files',
      tags: ['document', 'extraction', 'pdf', 'qa'],
    },
    {
      id: 'data-pipeline',
      name: 'Data Pipeline',
      description: 'Transform, clean, and analyse structured data from CSV, JSON, and databases',
      tags: ['etl', 'pandas', 'sql', 'transform'],
    },
  ],
  capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: false },
  supportedInterfaces: [
    { url: 'https://agents.example.com/doc-processor', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
};`, ['@weaveintel/core'])}

<p>When a supervisor agent needs to pick which worker to call, it reads the skill list and matches by <code>id</code> or by the text in <code>description</code> and <code>tags</code>. Keep skill IDs consistent with the canonical list above so supervisors across different meshes can recognise each other's capabilities.</p>
`)}

${section('a2a-handler-kinds', 'Handler Kinds for Live Agents', `
<p>When a live agent receives an A2A message, the <strong>handler kind</strong> in its DB row decides how it processes it. Handler kinds separate the <em>shape of execution</em> from the agent's specific logic, making it easy to swap from an LLM-driven loop to a deterministic function or a human-approval gate without changing the rest of the system.</p>

${featureCards([
  ['agentic.react', 'The standard LLM reasoning loop (ReAct). The agent thinks, calls tools, observes results, and loops until it has a final answer. Best for open-ended tasks where the path is not known in advance.'],
  ['agentic.scripted', 'A fixed LLM pipeline with predefined stages. Less flexible than ReAct, but more predictable and auditable. Good for document processing or classification tasks with a known shape.'],
  ['deterministic.template', 'Renders a Mustache template with the incoming data. No LLM involved — pure text substitution. Fast, free, and fully auditable. Good for notification formatting or report assembly.'],
  ['deterministic.forward', 'Puts the incoming message directly into a queue or sends it to another system. The agent acts as a router, not a processor. Good for fan-out, buffering, or bridging to external queues.'],
  ['deterministic.observer', 'Records the incoming message to the audit log and takes no other action. Used for compliance monitoring or debugging — a tap on the wire.'],
  ['human.approval', 'Pauses the agent and creates a pending approval task in the human-task queue. The agent waits until an operator approves or rejects before continuing. Good for high-stakes decisions.'],
  ['external.webhook', 'Calls an external HTTP endpoint with the message payload. The response becomes the agent\'s output. Good for integrating third-party services or legacy systems into the mesh.'],
])}

${params([
  ['agentic.react', 'HandlerKind', '', 'Full ReAct loop with tool calls. Configured per agent via the <code>live_agent_handler_bindings</code> DB row.'],
  ['agentic.scripted', 'HandlerKind', '', 'Scripted LLM pipeline. Steps are defined in the handler config JSON.'],
  ['deterministic.template', 'HandlerKind', '', 'Mustache template render. Template body stored in handler config.'],
  ['deterministic.forward', 'HandlerKind', '', 'Queue/system forward. Destination URL or queue name in handler config.'],
  ['deterministic.observer', 'HandlerKind', '', 'Audit-only tap. No config required.'],
  ['human.approval', 'HandlerKind', '', 'Pause for human decision. Timeout and escalation path in handler config.'],
  ['external.webhook', 'HandlerKind', '', 'HTTP POST to external URL. URL, headers, and retry policy in handler config.'],
])}
`)}`;
}

// ── Register all sections ─────────────────────────────────────────────────

(DOCS_SECTIONS as Record<string, () => string>)['memory']       = sMemory;
(DOCS_SECTIONS as Record<string, () => string>)['retrieval']    = sRetrieval;
(DOCS_SECTIONS as Record<string, () => string>)['evals']        = sEvals;
(DOCS_SECTIONS as Record<string, () => string>)['guardrails']   = sGuardrails;
(DOCS_SECTIONS as Record<string, () => string>)['resilience']   = sResilience;
(DOCS_SECTIONS as Record<string, () => string>)['cost-governor']= sCostGovernor;
(DOCS_SECTIONS as Record<string, () => string>)['tools']        = sTools;
(DOCS_SECTIONS as Record<string, () => string>)['tools-time']   = sToolsTime;
(DOCS_SECTIONS as Record<string, () => string>)['mcp']          = sMcp;
(DOCS_SECTIONS as Record<string, () => string>)['observability']= sObservability;
(DOCS_SECTIONS as Record<string, () => string>)['core']         = sCore;
// ── Section: Live Agents ──────────────────────────────────────────────────

function sLiveAgents(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap">
    <span class="pkg-badge">@weaveintel/live-agents</span>
    <span class="pkg-badge" style="margin-left:6px">@weaveintel/live-agents-runtime</span>
  </div>
  <h1 class="pkg-title">Live Agents</h1>
  <p class="pkg-desc">Long-running agents that run continuously for hours or days, accumulate knowledge via contracts, coordinate in meshes with claim-based leasing, respond to external events, and survive process restarts. Built on the same <code>weaveAgent</code> core with a per-tick execution model layered on top.</p>
</div>

${callout('info', '⚡', 'Live Agents vs weaveAgent.', 'Use <strong>live-agents</strong> when an agent runs continuously, processes a queue of backlog items, or coordinates with other agents in a mesh. Use <strong>weaveAgent</strong> for single request/response or bounded ReAct loops.')}

${featureCards([
  ['Per-tick execution', 'Each heartbeat invokes the agent once with its current backlog + inbox. Ticks are claim-leased so multiple workers compete safely without double-processing.'],
  ['Mesh coordination', 'Agents form meshes with defined roles. Agents discover each other by role and exchange typed messages via an A2A bus.'],
  ['State persistence', 'Agent state, backlog, inbox, and contracts live in a StateStore — swappable between in-memory, SQLite, Postgres, Redis, MongoDB, DynamoDB.'],
  ['Handler registry', 'A HandlerRegistry maps role-key → handler kind (agentic.react, deterministic.forward, deterministic.template, human.approval).'],
  ['Capability parity', 'Same model/tools/memory/policy slots as weaveAgent. Per-tick resolution via ModelResolver so model can change between ticks.'],
  ['Audit integration', 'Every tick emits live-agent.tick.start / live-agent.tick.end audit entries into the runtime\'s ambient audit logger.'],
])}

${exlinks([
  ['110-live-agents-trace-tools.ts', 'Example 110 — Live Agents Trace Tools'],
  ['120-equity-analyst-mesh.ts', 'Example 120 — Equity Analyst Mesh'],
  ['122-live-equity-analysis.ts', 'Example 122 — Live Equity Analysis'],
])}

${section('la-mesh', 'Provisioning a Mesh', `
${code('typescript', `import { provisionMesh } from '@weaveintel/live-agents-runtime';
import { weaveInMemoryStateStore } from '@weaveintel/live-agents';

const store = weaveInMemoryStateStore();

// provisionMesh(db, opts) instantiates a mesh from a stored blueprint.
// 'db' reads the mesh + agent DEFINITIONS; the runtime rows are written for you.
const mesh = await provisionMesh(db, {
  meshDefId:    'equity-mesh',        // or meshDefKey to look up by key
  tenantId:     'acme',
  ownerHumanId: 'user-alice',
  store,                              // same StateStore the supervisor uses
});

// The result reports the ids that were created
console.log(mesh.meshId, mesh.agentIds);`, ['@weaveintel/live-agents-runtime', '@weaveintel/live-agents'])}
`)}

${section('la-supervisor', 'Starting the Heartbeat Supervisor', `
<p>The supervisor manages N parallel workers that each call <code>heartbeat.tick()</code> on every interval. It auto-rebuilds workers when new roles appear in the DB.</p>

${code('typescript', `import { createHeartbeatSupervisor, createDefaultHandlerRegistry } from '@weaveintel/live-agents-runtime';
import { weaveInMemoryStateStore } from '@weaveintel/live-agents';
import { weaveRuntime, weaveContext } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './agents.db' }),
});

const store = weaveInMemoryStateStore();

// createDefaultHandlerRegistry() ships with the built-in handler kinds
// (agentic.react etc.) already registered.
const handlerRegistry = createDefaultHandlerRegistry();

// db must implement SupervisorDb (list meshes, agents, handler bindings)
const supervisor = await createHeartbeatSupervisor({
  db:              yourDb,
  store,
  handlerRegistry,
  runtime,          // ← audit entries flow into the durable logger
  intervalMs:      5_000,   // tick every 5 s
  refreshMs:       30_000,  // re-check active roles every 30 s
  workers:         4,        // parallel heartbeat workers
});

// Stop cleanly on shutdown
process.on('SIGTERM', () => supervisor.stop());`, ['@weaveintel/live-agents-runtime', '@weaveintel/live-agents', '@weaveintel/core', '@weaveintel/persistence'])}

${params([
  ['db', 'SupervisorDb', 'required', 'Database adapter implementing listLiveMeshes, listLiveAgents, listLiveAgentHandlerBindings.'],
  ['store', 'StateStore', 'required', 'Live-agents state store. Use weaveInMemoryStateStore() for dev or a durable backend for prod.'],
  ['handlerRegistry', 'HandlerRegistry', 'required', 'Maps handler kinds to their implementation. Call registerBuiltins() to get agentic.react etc.'],
  ['runtime', 'WeaveRuntime', 'optional', 'When supplied, every tick emits audit entries and inherits the ambient runtime context.'],
  ['intervalMs', 'number', 'optional', 'How often ticks fire. Default 5000.'],
  ['workers', 'number', 'optional', 'Number of parallel tick workers. Default 4.'],
  ['modelFactory', '() => Promise&lt;Model|undefined&gt;', 'optional', 'Pinned model factory. Prefer modelResolver for per-tick routing.'],
  ['modelResolver', 'ModelResolver', 'optional', 'Per-tick model resolution. Takes precedence over modelFactory.'],
  ['policy', 'LiveAgentPolicy', 'optional', 'Tool policy, rate limiting, approval gates applied every tick.'],
])}
`)}

${section('la-state-stores', 'State Store Backends', `
${code('typescript', `import {
  weaveInMemoryStateStore,
  weaveSqliteStateStore,
  weavePostgresStateStore,
  weaveRedisStateStore,
  weaveMongoDbStateStore,
  weaveDynamoDbStateStore,
} from '@weaveintel/live-agents';

// Development — in-memory, lost on restart (synchronous)
const devStore = weaveInMemoryStateStore();

// Durable stores are async factories (they open a connection/pool):
// SQLite — single-process durable
const sqliteStore = await weaveSqliteStateStore({ path: './live-agents.db' });

// Postgres — multi-process, horizontal scale
const pgStore = await weavePostgresStateStore({ url: process.env['DATABASE_URL']! });

// Redis — low-latency, TTL-aware
const redisStore = await weaveRedisStateStore({ url: process.env['REDIS_URL']! });`, ['@weaveintel/live-agents'])}
`)}

${section('la-db-boot', 'DB-Backed Boot (Production Entry Points)', `
<p>In production, meshes and agents are defined in the database. <code>weaveLiveMeshFromDb</code> and <code>weaveLiveAgentFromDb</code> boot the full mesh from DB records, resolving models, tools, policies, and prepare configs automatically.</p>

${code('typescript', `import { weaveLiveMeshFromDb, weaveLiveAgentFromDb } from '@weaveintel/live-agents-runtime';
import { weaveSqliteStateStore } from '@weaveintel/live-agents';

const store = await weaveSqliteStateStore({ path: './live-agents.db' });

// Boot an entire mesh from the database — weaveLiveMeshFromDb(db, opts)
// db must have live_meshes + live_agents + live_agent_handler_bindings rows
const mesh = await weaveLiveMeshFromDb(db, {
  store,
  modelFactory: async () => weaveAnthropicModel('claude-sonnet-4-6'),
  policy:       weaveDbLiveAgentPolicy({ db }),
});

// Boot a single agent from its DB record — weaveLiveAgentFromDb(db, agentId, opts?)
const agent = await weaveLiveAgentFromDb(db, 'agent-researcher', {
  store,
  model: weaveAnthropicModel('claude-haiku-4-5-20251001'),
});

// Start ticking
const supervisor = await createHeartbeatSupervisor({ db, store, handlerRegistry: myHandlerRegistry, runtime });
// Agents now tick on their own schedule — supervisor manages lifecycle`, ['@weaveintel/live-agents-runtime', '@weaveintel/live-agents'])}
`)}

${section('la-e2e', 'End-to-End: Full Production Setup', `
${code('typescript', `import { createHeartbeatSupervisor, createDefaultHandlerRegistry, provisionMesh } from '@weaveintel/live-agents-runtime';
import { weaveSqliteStateStore } from '@weaveintel/live-agents';
import { weaveRuntime, weaveContext } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

// 1. Runtime — all durable subsystems inherit one persistence slot
const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './app.db' }),
});

// 2. State store — async factory; separate file/table for agent state
const store = await weaveSqliteStateStore({ path: './agents.db' });

// 3. Handler registry — built-in handler kinds pre-registered
const handlerRegistry = createDefaultHandlerRegistry();

// 4. Provision the initial mesh from its stored blueprint (idempotent)
await provisionMesh(yourDb, {
  meshDefId:    'equity-mesh',
  tenantId:     'acme',
  ownerHumanId: 'user-alice',
  store,
});

// 5. Start the supervisor — agents tick every intervalMs
const supervisor = await createHeartbeatSupervisor({
  db:              yourDb,
  store,
  handlerRegistry,
  runtime,           // audit + persistence flows through
  intervalMs:      5_000,
  workers:         4,
});

// 6. Graceful shutdown
process.on('SIGTERM', async () => {
  await supervisor.stop();
  process.exit(0);
});

console.log('Live agent mesh running. Ctrl+C to stop.');`, ['@weaveintel/live-agents-runtime', '@weaveintel/live-agents', '@weaveintel/core', '@weaveintel/persistence', '@weaveintel/provider-anthropic'])}
`)}

${section('la-kaggle-mesh', 'Kaggle Competition Mesh', `
<p>The Kaggle Competition Mesh is a <strong>built-in reference mesh</strong> in geneWeave that shows how to wire a team of nine specialised agents to tackle a machine-learning competition from end to end — automatically. It is not a toy demo; the same mesh runs against real Kaggle competitions.</p>

${callout('info', '🏆', 'Why nine agents?', 'A Kaggle competition involves many distinct activities that can run in parallel: discovering what the competition is about, building a strategy, implementing models, validating submissions, watching the leaderboard, and writing up findings. Splitting these across specialist agents lets the mesh work on multiple fronts simultaneously — faster than a single agent doing everything sequentially.')}

<h4>The nine agents and what they do</h4>
${typeTable([
  ['discoverer', 'Reads the competition description, downloads the dataset, and writes a structured brief for the other agents. Entry point — everything starts here.'],
  ['strategist', 'Takes the brief and proposes an overall approach: which model families to try, what feature engineering makes sense, how to structure the validation. Called by both the observer and the leaderboard monitor when strategy needs revisiting.'],
  ['implementer', 'Builds and trains one model at a time following the strategy. Sequential — one experiment at a time.'],
  ['parallel_implementer', 'Same role as implementer but runs multiple experiments in parallel lanes. Activated for competitions where many independent approaches need comparing quickly.'],
  ['validator', 'Scores the models from implementer / parallel_implementer using cross-validation, OOF scores, and leaderboard probes. Gates submissions.'],
  ['submitter', 'Prepares the winning model\'s predictions in the format Kaggle expects and makes the submission. Also triggers the debrief after each submission.'],
  ['observer', 'Watches the overall competition — time remaining, score trends, discussion forum activity — and nudges the strategist when it detects a course-correction opportunity.'],
  ['leaderboard_monitor', 'Specifically tracks public leaderboard movements, spots score gaps, and surfaces public kernel approaches. Feeds intelligence back to the strategist.'],
  ['debrief', 'Writes up what was tried, what worked, and what to do differently next time. Called after each submission and at competition end.'],
])}

<h4>Playbooks — pre-defined competition strategies</h4>
<p>The mesh ships with three playbooks that activate different tool configurations and agent behaviours depending on the competition type:</p>
${typeTable([
  ['NLP Classification Playbook', 'Activates transformer fine-tuning tools, text feature tools, and a no-baselines constraint (no bag-of-words TF-IDF as the final submission). Targets competitions with text classification tasks.'],
  ['Computer Vision Playbook', 'Activates image augmentation tools, CNN backbone tools, and an ensemble-required constraint. Enforces pre-trained backbone use (no from-scratch networks). Targets image classification and detection competitions.'],
  ['Time Series Playbook', 'Activates lag/rolling feature tools, gradient boosting tools, and a no-naive-baseline constraint (no mean/last-value baseline as the final entry). Targets forecasting competitions.'],
])}

${exlinks([
  ['76-kaggle-discover-and-ideate.ts', 'Example 76 — Kaggle: Discover + Strategise'],
  ['77-kaggle-submit-with-approval.ts', 'Example 77 — Kaggle: Validate + Submit with HITL Approval'],
  ['78-kaggle-replay-roundtrip.ts', 'Example 78 — Kaggle: Replay Round-Trip'],
  ['79-kaggle-live-agents-e2e.ts', 'Example 79 — Kaggle: Live Agents End-to-End'],
  ['96-live-agents-phase6-mesh-from-db.ts', 'Example 96 — Load Kaggle Mesh from DB'],
])}
`)}`;
}

// ── Section: Durability ───────────────────────────────────────────────────

function sDurability(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/resilience</span></div>
  <h1 class="pkg-title">Durability</h1>
  <p class="pkg-desc">Operational durability primitives: idempotency keys, dead-letter queue, retry budgets, health checks, and backpressure. All are runtime-aware — pass a <code>WeaveRuntime</code> with a persistence slot and every primitive automatically uses durable KV storage. Without a runtime, the zero-config in-memory path is the default.</p>
</div>

${callout('info', '💾', 'One home for resilience.', 'These operational-durability primitives (idempotency, dead-letter queue, retry budgets, health checks, backpressure) now live in <code>@weaveintel/resilience</code>, alongside the live per-call guards (circuit breaker, rate limiter, retry policy). They used to be split across three tiny packages — <code>reliability</code>, <code>durability</code> and <code>resilience</code> — which was more names than concepts. Same behaviour, one import.')}

${featureCards([
  ['Dead-letter queue', 'Captures failed operations for manual retry or investigation. Durable variant survives process restart.'],
  ['Idempotency keys', 'Prevents duplicate side effects on retry. Keys stored in KV with configurable TTL.'],
  ['Retry budget', 'Shared retry budget across callers so one hot path cannot exhaust retries for everyone.'],
  ['Health checks', 'Register health probes; aggregate status for liveness/readiness endpoints.'],
  ['Backpressure', 'Token-bucket style backpressure for queues and external system calls.'],
])}

${exlinks([
  ['125-durable-runtime.ts', 'Example 125 — Durable Runtime (DLQ + Cost Meter survive restart)'],
  ['126-durable-subsystems.ts', 'Example 126 — Durable Subsystems (all nine durable stores)'],
])}

${section('dur-dlq', 'Dead-Letter Queue', `
<p>The DLQ captures failed operations. The durable variant persists records to <code>runtime.persistence.kv</code> so entries survive restarts. Both sync and async interfaces are available.</p>

${code('typescript', `import { createDurableDeadLetterQueue } from '@weaveintel/resilience';
import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './ops.db' }),
});

const dlq = createDurableDeadLetterQueue({ runtime, namespace: 'payments' });

// Enqueue a failed operation
const record = await dlq.enqueue({
  type:       'payment.charge',
  payload:    { orderId: 'ORD-001', amountCents: 9999 },
  error:      'Stripe timeout after 30s',
  retryCount: 2,
});
console.log(record.id, record.firstFailedAt);

// List all unresolved records
const pending = await dlq.list({ resolved: false });

// Retry with a handler — marks resolved on success
const ok = await dlq.retry(record.id, async (payload) => {
  const p = payload as { orderId: string; amountCents: number };
  await stripe.charge(p.orderId, p.amountCents);
});

// Clear resolved records
const removed = await dlq.clear();
console.log(\`Cleared \${removed} resolved records\`);`, ['@weaveintel/resilience', '@weaveintel/core', '@weaveintel/persistence'])}

${params([
  ['runtime', 'WeaveRuntime', 'optional', 'When supplied and persistence is configured, records survive restarts. Falls back to in-memory.'],
  ['namespace', 'string', 'optional', 'KV key prefix. Default: <code>"dlq"</code>.'],
])}
`)}

${section('dur-idempotency', 'Idempotency Keys', `
${code('typescript', `import { createIdempotencyStore, createDurableIdempotencyStore } from '@weaveintel/resilience';

// In-memory (test / dev) — takes an IdempotencyPolicy
const store = createIdempotencyStore({ ttlMs: 60 * 60 * 1000, maxEntries: 10_000 });

// Durable (production) — policy + a DurableIdempotencyRepository (KV-backed)
const durableStore = createDurableIdempotencyStore(
  { ttlMs: 24 * 60 * 60 * 1000 },   // 24 h — keys expire after this
  paymentsRepository,
);

// Use before any state-mutating operation
const key = 'charge:ORD-001:attempt-3';
const existing = await durableStore.check(key);
if (existing.isDuplicate) {
  return existing.previousResult;   // replay cached result — no duplicate charge
}

const result = await stripe.charge(orderId, amount);
await durableStore.record(key, result);`, ['@weaveintel/resilience'])}
`)}

${section('dur-retry-budget', 'Retry Budget', `
<p>A shared retry budget prevents a single hot code path from burning all retry capacity. Unlike per-call retry policies, the budget is a process-wide counter.</p>

${code('typescript', `import { createRetryBudget } from '@weaveintel/resilience';

// Shared across all callers that import this instance
const budget = createRetryBudget({
  maxRetries:     3,
  baseDelayMs:    1_000,
  maxDelayMs:     30_000,
  retryableErrors: ['429', 'ECONNRESET', 'socket hang up'],
});

// Every caller uses the same budget — once exhausted, retries stop
const result = await budget.execute(async () => {
  return fetch('https://api.example.com/data');
});`, ['@weaveintel/resilience'])}
`)}

${section('dur-health', 'Health Checks', `
${code('typescript', `import { createHealthChecker } from '@weaveintel/resilience';

const health = createHealthChecker('api');

health.addCheck('database', async () => {
  await db.query('SELECT 1');
  return { ok: true };
});

health.addCheck('redis', async () => {
  const pong = await redis.ping();
  return { ok: pong === 'PONG', message: pong };
});

// Express / Hono liveness endpoint
app.get('/health', async (req, res) => {
  const result = await health.run();
  res.status(result.healthy ? 200 : 503).json(result);
});
// { service: 'api', healthy: true, checks: [{ name: 'database', ok: true, durationMs: 2 }, ...] }`, ['@weaveintel/resilience'])}
`)}`;
}

// ── Section: Persistence ──────────────────────────────────────────────────

function sPersistence(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/persistence</span></div>
  <h1 class="pkg-title">Persistence</h1>
  <p class="pkg-desc">8-adapter persistence layer for live-agents state and workflow stores, plus the <code>RuntimePersistenceSlot</code> factories that wire KV-backed durable storage into every runtime subsystem (DLQ, cost meter, audit, checkpoint, endpoint state).</p>
</div>

${featureCards([
  ['RuntimePersistenceSlot factories', 'weaveSqlitePersistence, and (road-mapped) weavePostgresPersistence, weaveRedisPersistence — drop one into weaveRuntime({ persistence }) to make every durable subsystem restart-safe at once.'],
  ['8 adapter types', 'In-memory, SQLite, Postgres, Redis, MongoDB, CosmosDB, DynamoDB for live-agents StateStore and workflow stores.'],
  ['Uniform KV interface', 'get / set / delete / list(prefix) — every durable subsystem (DLQ, cost meter, audit, checkpoint) uses this surface.'],
  ['Zero-config default', 'weaveInMemoryPersistence() (from @weaveintel/core) is the drop-in default so tests and tiny adopters never configure storage.'],
])}

${exlinks([
  ['125-durable-runtime.ts', 'Example 125 — Runtime Persistence (SQLite slot)'],
  ['119-sqlite-e2e.ts', 'Example 119 — SQLite E2E (workflows + live-agents)'],
])}

${section('pers-slot', 'RuntimePersistenceSlot — Wiring the Runtime', `
<p>The slot is the single switch that makes every runtime-aware durable subsystem restart-safe. Pass it to <code>weaveRuntime</code> once and everything inherits it.</p>

${code('typescript', `import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

// SQLite — recommended for single-node prod and all development
const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({
    path:  './weave.db',    // file path; ':memory:' for ephemeral
    table: 'runtime_kv',   // KV table name (default: runtime_kv)
  }),
});

// All of these now use the SQLite slot automatically:
// • createDurableDeadLetterQueue({ runtime })
// • createDurableCheckpointStore({ runtime })
// • createDurableAuditLogger — auto-wired inside weaveRuntime itself
// • createDurableEndpointRegistry({ runtime })
// • createDurableCostMeter({ runtime })
// • weaveRuntimeMemoryStore({ runtime })

const ctx = weaveContext({ runtime });`, ['@weaveintel/core', '@weaveintel/persistence'])}

${params([
  ['path', 'string', 'required', 'SQLite file path. Use <code>":memory:"</code> for an ephemeral instance (tests, demos).'],
  ['table', 'string', 'optional', 'KV table name inside the SQLite file. Default: <code>"runtime_kv"</code>. Multiple slots can share one file with different table names.'],
])}
`)}

${section('pers-kv', 'Direct KV Access', `
${code('typescript', `import { weaveSqlitePersistence } from '@weaveintel/persistence';

const slot = weaveSqlitePersistence({ path: './store.db' });
const kv   = slot.kv;

// Store arbitrary JSON (callers handle serialisation)
await kv.set('user:alice:prefs', JSON.stringify({ theme: 'dark', lang: 'en' }));
await kv.set('session:xyz',      JSON.stringify({ userId: 'alice' }), { ttlMs: 3_600_000 });

// Read
const raw = await kv.get('user:alice:prefs');
const prefs = raw ? JSON.parse(raw) : null;

// List by prefix — lexicographically sorted
const sessions = await kv.list('session:');
for (const { key, value } of sessions) {
  console.log(key, JSON.parse(value));
}

// Delete
const deleted = await kv.delete('session:xyz');  // true if key existed`, ['@weaveintel/persistence'])}
`)}

${section('pers-adapters', 'High-Level Adapters (Workflow Stores)', `
<p>Workflow stores (checkpoints, run repository, audit log, etc.) use typed adapters with CRUD operations on top of the underlying DB driver. These differ from the KV slot — they manage workflow-specific schemas and queries.</p>

${code('typescript', `import {
  weaveSqliteCheckpointStore,
  weaveSqliteWorkflowRunRepository,
  weaveSqliteAuditLog,
  weaveSqliteStepLockStore,
  weaveSqliteIdempotencyStore,
} from '@weaveintel/workflows';

// All SQLite-backed workflow stores share one file
const databasePath = './workflows.db';

const engine = new DefaultWorkflowEngine({
  checkpointStore: weaveSqliteCheckpointStore({ databasePath }),
  runRepository:   weaveSqliteWorkflowRunRepository({ databasePath }),
  auditLog:        weaveSqliteAuditLog({ databasePath }),
  stepLockStore:   weaveSqliteStepLockStore({ databasePath }),
  idempotencyStore: weaveSqliteIdempotencyStore({ databasePath }),
});`, ['@weaveintel/workflows'])}
`)}`;
}

// ── Section: Encryption ───────────────────────────────────────────────────

function sEncryption(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/encryption</span></div>
  <h1 class="pkg-title">Encryption</h1>
  <p class="pkg-desc">Per-tenant field-level AES-256-GCM encryption with automatic key rotation, blind indexes for equality search on encrypted columns, BYOK/HYOK support, multi-KMS provider routing, break-glass dual approval, and an attestation chain for audit.</p>
</div>

${callout('warn', '🔐', 'Opt-in per tenant.', 'Encryption is opt-in per tenant. Missing manager / missing policy / missing tenant_id → writes go plaintext, reads succeed without decryption. This is intentional: the app never crashes due to an absent encryption configuration.')}

${featureCards([
  ['AES-256-GCM field encryption', 'Encrypts individual DB columns, not whole rows. Sentinel format: enc:v1:<epoch>:<iv_b64>:<ct_b64>.'],
  ['Key hierarchy', 'MEK (master encryption key) → KEK (key encryption key) → DEK (data encryption key). DEKs are rotated on schedule; MEK lives in vault/env.'],
  ['Blind indexes', 'HMAC-SHA-256 companion columns for equality search on encrypted fields without decrypting all rows.'],
  ['5 KMS providers', 'Local (env-based), AWS KMS, Azure Key Vault, GCP KMS, HashiCorp Vault — per-tenant routing via cached resolver.'],
  ['BYOK / HYOK', 'Bring Your Own Key / Hold Your Own Key — adopters supply RSA-4096 wrapped keys. HYOK secrets never leave the tenant\'s environment.'],
  ['Break-glass', 'Dual-approval emergency access with a 24-hour window cap. All access is audited via an append-only attestation chain.'],
])}

${section('enc-setup', 'Setup', `
${code('typescript', `import { weaveTenantKeyManager, createKmsProviderRegistry } from '@weaveintel/encryption';

// 1. Register KMS providers via the factory. register() takes one
//    KmsProviderRegistration: { id, factory }.
const kmsRegistry = createKmsProviderRegistry();
kmsRegistry.register({ id: 'local',   factory: async () => localKmsProvider({ masterKey: process.env['WEAVE_ENCRYPTION_MASTER_KEY']! }) });
kmsRegistry.register({ id: 'aws-kms', factory: async () => awsKmsProvider({ keyArn: process.env['AWS_KMS_KEY_ARN']! }) });

// 2. Create a key manager. tenantId is passed per-operation, not here.
const manager = weaveTenantKeyManager({
  store: db,                                  // stores DEKs, KEKs, policy
  kms:   await kmsRegistry.build('local', {}), // or pass kmsResolver for per-tenant routing
});

// 3. Encrypt / decrypt a field value — one options object per call
const ciphertext = await manager.encrypt({
  tenantId: 'acme', table: 'users', column: 'email', rowId: 'user-001',
  plaintext: 'alice@example.com',
});
// → "enc:v1:1234567890:iv_base64:ciphertext_base64"

const plaintext = await manager.decrypt({
  tenantId: 'acme', table: 'users', column: 'email', rowId: 'user-001',
  value: ciphertext,
});
// → "alice@example.com"`, ['@weaveintel/encryption'])}
`)}

${section('enc-proxy', 'Multi-Table Encrypted DB Proxy', `
<p>The proxy wraps any DB adapter and transparently encrypts/decrypts specified columns on every read and write. Use this instead of calling encrypt/decrypt at each call site.</p>

${code('typescript', `import { withTenantEncryptedDb } from '../../src/encryption/db-encrypted-adapter.js';

// Wrap the raw DB adapter. The second arg is a live-binding accessor that
// returns the bootstrapped TenantKeyManager. The column specs (which fields on
// which tables are encrypted) are built in per method.
const encryptedDb = withTenantEncryptedDb(db, () => tenantKeyManager);

// All reads/writes through encryptedDb are automatically encrypted/decrypted
const user = await encryptedDb.getUserById('user-001');
console.log(user?.email); // already decrypted`, [])}
`)}

${section('enc-blind-index', 'Blind Indexes — Equality Search', `
${code('typescript', `// computeBlindIndex is a method on the TenantKeyManager (see Setup above)
const bidx = await manager.computeBlindIndex({
  tenantId: 'acme',
  table:  'users',
  column: 'email',
  value:  'alice@example.com',
});

// Search the companion column instead of decrypting all rows
const user = await db.query(
  'SELECT * FROM users WHERE email_bidx = ?',
  [bidx],
);`, [])}
`)}`;
}

// ── Section: Tenancy ─────────────────────────────────────────────────────

function sTenancy(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/identity/tenancy</span></div>
  <h1 class="pkg-title">Tenancy</h1>
  <p class="pkg-desc">Multi-tenant isolation for agents, models, and capabilities. Each tenant gets independent context propagation, budget enforcement, capability bindings, and optionally field-level encryption. Tenancy is ambient — set <code>tenantId</code> on the <code>ExecutionContext</code> and every subsystem picks it up.</p>
</div>

${featureCards([
  ['Context propagation', '<code>tenantId</code> flows through ExecutionContext to every tool call, memory write, audit entry, and model call automatically.'],
  ['Per-tenant budgets', 'Durable per-tenant spending ledger tracks token and USD spend, enforces monthly caps, and alerts on threshold crossings.'],
  ['Capability bindings', 'Tenants receive exactly the tools, models, and prompts their subscription tier entitles them to.'],
  ['Isolated encryption', 'Each tenant has its own DEK/KEK hierarchy. One tenant\'s data is unreadable by another — even on shared infrastructure.'],
])}

${exlinks([
  ['112-tenancy.ts', 'Example 112 — Tenancy & Per-Tenant Budgets'],
])}

${section('ten-context', 'Tenant Context', `
<p>Set <code>tenantId</code> once on the context. It propagates to audit entries, memory writes, observability spans, and cost tracking with no further wiring.</p>

${code('typescript', `import { weaveContext, weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveAgent } from '@weaveintel/agents';

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './ops.db' }),
});

// Derive a per-request context with the caller's tenant
function buildCtx(req: Request) {
  return weaveContext({
    runtime,
    tenantId: req.headers['x-tenant-id'] as string,
    userId:   req.headers['x-user-id']   as string,
    metadata: { plan: req.headers['x-plan'] as string },
  });
}

// Every agent run, tool call, and audit entry is scoped to this tenant
const agent = weaveAgent({ model, tools });
const ctx   = buildCtx(req);
const result = await agent.run(ctx, { messages });`, ['@weaveintel/core', '@weaveintel/persistence', '@weaveintel/agents'])}
`)}

${section('ten-budget', 'Per-Tenant Budget Enforcement', `
${code('typescript', `import { createDurableBudgetEnforcer } from '@weaveintel/identity/tenancy';
import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './budgets.db' }),
});

// One enforcer per deployment (manages the KV store for all tenants)
const enforcer = createDurableBudgetEnforcer({ runtime, namespace: 'tenant-budget' });

// Define the tenant's daily + monthly caps once
await enforcer.setBudget({
  tenantId: 'acme',
  daily:    { maxTokens: 1_000_000,  maxCostUsd: 100.00 },
  monthly:  { maxTokens: 30_000_000, maxCostUsd: 50.00 },
});

// Check before a model call
const check = await enforcer.checkBudget('acme');
if (!check.allowed) {
  return { error: \`Budget exceeded: \${check.reason}\` };
}

// Record spend after a model call: (tenantId, tokens, costUsd, steps)
await enforcer.recordUsage('acme', 1500, 0.0042, 1);

// Get current usage for a period
const usage = await enforcer.getUsage('acme', 'monthly');
if (usage) console.log(\`acme (monthly): $\${usage.costUsd.toFixed(4)} across \${usage.tokens} tokens\`);`, ['@weaveintel/identity/tenancy', '@weaveintel/core', '@weaveintel/persistence'])}

${params([
  ['runtime', 'WeaveRuntime', 'optional', 'Runtime with a persistence slot. Spend is stored under <code>namespace:tenantId:*</code> keys.'],
  ['namespace', 'string', 'optional', 'KV key prefix. Default: <code>"tenant-budget"</code>.'],
])}
`)}

${section('ten-caps', 'Capability Bindings', `
<p>Capability policy bindings determine which tools, models, and prompts each tenant (and each agent or mesh within a tenant) can access. Resolved at runtime with precedence: agent=100 > mesh=50 > workflow=10 > tenant=5 > package_default.</p>

${code('typescript', `import { resolveCapabilityBinding } from '@weaveintel/core';

// Load the tenant/agent's bindings from your DB, then resolve by precedence.
// resolveCapabilityBinding is a pure function: (bindings, bindingKind, bindingRef, policyKind)
const bindings = await db.listCapabilityBindings('acme');

const toolBinding = resolveCapabilityBinding(bindings, 'agent', 'agent-analyst', 'tool_policy');
if (toolBinding) {
  console.log(toolBinding.policyRef);   // → look up the referenced tool_policy row
}

// Check the tenant-level cost policy binding
const costBinding = resolveCapabilityBinding(bindings, 'tenant', 'acme', 'cost_policy');
const costPolicyRef = costBinding?.policyRef;`, ['@weaveintel/core'])}
`)}`;
}

// ── Section: Redaction ────────────────────────────────────────────────────

function sRedaction(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/guardrails/redaction</span></div>
  <h1 class="pkg-title">Redaction</h1>
  <p class="pkg-desc">PII detection and redaction middleware. Runs as a model-call interceptor so LLMs never see raw sensitive data. Supports built-in patterns (email, phone, SSN, credit card, IPv4), custom regex, allowlists, and optionally reversible tokenisation so the original value can be restored after the model response.</p>
</div>

${callout('info', '✂️', 'Redaction before the model call.', 'The canonical placement is as middleware on the model client — messages are redacted before being sent to the provider and tokens are de-redacted in the response. LLMs never see raw PII.')}

${exlinks([
  ['08-pii-redaction.ts', 'Example 08 — PII Redaction'],
  ['127-phase5-security.ts', 'Example 127 — Auto-Redaction on Audit Writes'],
])}

${section('red-setup', 'Basic Setup', `
${code('typescript', `import { weaveRedactor } from '@weaveintel/guardrails/redaction';
import { weaveContext } from '@weaveintel/core';

const redactor = weaveRedactor({
  patterns: [
    { name: 'email',       type: 'builtin', builtinType: 'email' },
    { name: 'phone',       type: 'builtin', builtinType: 'phone' },
    { name: 'ssn',         type: 'builtin', builtinType: 'ssn' },
    { name: 'credit-card', type: 'builtin', builtinType: 'credit_card' },
    { name: 'ipv4',        type: 'builtin', builtinType: 'ipv4' },
    // Custom pattern — redact any AWS access key
    { name: 'aws-key', type: 'regex', pattern: 'AKIA[0-9A-Z]{16}',
      replacement: '[AWS_KEY]' },
  ],
  allowlist:  ['noreply@weaveintel.com'],  // never redact this email
  reversible: true,    // store originals so we can de-redact responses
});

const ctx = weaveContext({ userId: 'alice' });

// Redact before the model call
const userMessage = 'My email is alice@example.com and SSN is 123-45-6789.';
const { redacted, detections } = await redactor.redact(ctx, userMessage);
// redacted = "My email is [EMAIL_1] and SSN is [SSN_1]."
// detections = [{ type:'email', start:12, end:29, token:'[EMAIL_1]', original:'alice@example.com' }, ...]

// Send redacted text to the model
const response = await model.generate({
  messages: [{ role: 'user', content: redacted }],
});

// Restore originals in the response (reversible mode).
// detections is a readonly array — spread into a mutable copy for restore().
const restored = await redactor.restore!(ctx, response.content, [...detections]);`, ['@weaveintel/guardrails/redaction', '@weaveintel/core'])}
`)}

${section('red-model-middleware', 'Model Middleware (Recommended)', `
<p>Wrap the model with a redaction middleware so every <code>model.generate()</code> call transparently redacts + de-redacts without any call-site changes.</p>

${code('typescript', `import { weaveRedactor } from '@weaveintel/guardrails/redaction';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext } from '@weaveintel/core';

const redactor = weaveRedactor({
  patterns: [
    { name: 'email', type: 'builtin', builtinType: 'email' },
    { name: 'phone', type: 'builtin', builtinType: 'phone' },
  ],
  reversible: true,
});

const model = weaveAnthropicModel('claude-sonnet-4-6');
const ctx   = weaveContext({ userId: 'alice' });

// Redact → generate → restore, so PII never reaches Anthropic's servers.
async function safeGenerate(userText: string): Promise<string> {
  const { redacted, detections } = await redactor.redact(ctx, userText);
  const response = await model.generate(ctx, { messages: [{ role: 'user', content: redacted }] });
  // The model sees "[PHONE_1]"; restore de-redacts it back in the response.
  return redactor.restore!(ctx, response.content, [...detections]);
}

const answer = await safeGenerate('My phone is 555-867-5309. Can you update my profile?');`, ['@weaveintel/guardrails/redaction', '@weaveintel/provider-anthropic', '@weaveintel/core'])}
`)}

${section('red-audit', 'Auto-Redaction on Audit Writes', `
<p>When a <code>redactor</code> is configured on <code>weaveRuntime</code>, every audit entry's <code>details</code> object is automatically redacted before reaching the KV store. No call-site changes required.</p>

${code('typescript', `import { weaveRuntime, weaveContext, weaveAudit } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveRedactor } from '@weaveintel/guardrails/redaction';

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './audit.db' }),
  redactor: weaveRedactor({
    patterns: [
      { name: 'email', type: 'builtin', builtinType: 'email' },
      { name: 'ssn',   type: 'builtin', builtinType: 'ssn' },
    ],
  }),
});

const ctx = weaveContext({ runtime });

// This details.email will be "[EMAIL]" in the KV store
await weaveAudit(ctx, {
  action:   'user.profile.update',
  outcome:  'success',
  resource: 'users/alice',
  details:  { email: 'alice@example.com', newPlan: 'pro' },
});`, ['@weaveintel/core', '@weaveintel/persistence', '@weaveintel/guardrails/redaction'])}

${params([
  ['patterns', 'RedactionPattern[]', 'required', 'Array of patterns to detect. Each has <code>name</code>, <code>type</code> (builtin|regex|model), and optional <code>replacement</code>.'],
  ['allowlist', 'string[]', 'optional', 'Values that should never be redacted even if they match a pattern.'],
  ['reversible', 'boolean', 'optional', 'Store original values so they can be restored after a model call. Default: false.'],
])}
`)}`;
}

// ── Section: Compliance ───────────────────────────────────────────────────

function sCompliance(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/guardrails/compliance</span></div>
  <h1 class="pkg-title">Compliance</h1>
  <p class="pkg-desc">Data governance primitives for regulated environments: legal hold, consent management, data residency enforcement, retention policies with scheduled deletion, audit export, and GDPR-compliant user deletion. All six stores are runtime-aware — pass a persistence slot to make them restart-safe.</p>
</div>

${featureCards([
  ['Legal hold', 'Freeze specific data subjects or record sets, preventing deletion during litigation or regulatory review.'],
  ['Consent management', 'Per-subject, per-purpose consent records with versioned policies and temporal validity windows.'],
  ['Data residency', 'Enforce that data for a given subject is only processed in specified geographic regions.'],
  ['Retention policies', 'Declarative TTL policies per data category. Scheduler purges expired records on configurable intervals.'],
  ['Audit export', 'Export structured audit trails in compliance-ready formats (NDJSON, CSV) for regulatory submission.'],
  ['GDPR deletion', 'Right-to-erasure workflows: request intake, hold check, scheduled execution, and confirmation receipt.'],
])}

${section('comp-setup', 'Setup — Durable Compliance Stores', `
${code('typescript', `import {
  createDurableLegalHoldManager,
  createDurableConsentManager,
  createDurableRetentionEngine,
  createDurableDeletionManager,
} from '@weaveintel/guardrails/compliance';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveRuntime } from '@weaveintel/core';

const runtime = weaveRuntime({
  persistence: weaveSqlitePersistence({ path: './compliance.db' }),
});

// All stores use the same runtime slot — one persistence config for all
const holds     = createDurableLegalHoldManager({ runtime, namespace: 'legal-hold' });
const consent   = createDurableConsentManager({ runtime, namespace: 'consent' });
const retention = createDurableRetentionEngine({ runtime, namespace: 'retention' });
const deletion  = createDurableDeletionManager({ runtime, namespace: 'deletion' });`, ['@weaveintel/guardrails/compliance', '@weaveintel/persistence', '@weaveintel/core'])}
`)}

${section('comp-consent', 'Consent Management', `
${code('typescript', `import { createDurableConsentManager } from '@weaveintel/guardrails/compliance';

const consent = createDurableConsentManager({ runtime });

// Record user consent — grant(subjectId, purpose, source, expiresAt?)
await consent.grant(
  'user-alice',
  'marketing',
  'signup-form',
  Date.now() + 365 * 24 * 3600 * 1000,
);

// Check consent before sending — isGranted returns a boolean
const allowed = await consent.isGranted('user-alice', 'marketing');
if (!allowed) {
  console.log('No consent for marketing emails');
}

// Revoke consent
await consent.revoke('user-alice', 'marketing');`, ['@weaveintel/guardrails/compliance'])}
`)}

${section('comp-gdpr', 'GDPR Deletion (Right to Erasure)', `
${code('typescript', `import { createDurableDeletionManager } from '@weaveintel/guardrails/compliance';
import { createDurableLegalHoldManager } from '@weaveintel/guardrails/compliance';

const deletion = createDurableDeletionManager({ runtime });
const holds    = createDurableLegalHoldManager({ runtime });

// Step 1: Create a deletion request — create(subjectId, requestedBy, reason, dataCategories)
const req = await deletion.create(
  'user-alice',
  'gdpr-officer',
  'GDPR Article 17 erasure request',
  ['profile', 'messages'],
);

// Step 2: Check for active legal holds before executing — isHeld returns a boolean
const held = await holds.isHeld('user-alice', 'profile');
if (held) {
  console.log('Deletion deferred — active legal hold');
} else {
  // Step 3: Execute deletion and mark the request complete
  await yourDb.deleteUserData('user-alice');
  await deletion.complete(req.id);
}`, ['@weaveintel/guardrails/compliance'])}
`)}`;
}

// ── Section: Triggers ─────────────────────────────────────────────────────

function sTriggers(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/triggers</span></div>
  <h1 class="pkg-title">Triggers</h1>
  <p class="pkg-desc">Event-driven invocation of workflows and agents. Triggers subscribe to events from multiple sources (cron, webhooks, DB change, file watch, contract events, MCP events, manual) and route them to workflow runs or agent ticks. Rate limiting and JSONLogic filters ship built-in.</p>
</div>

${featureCards([
  ['9 source kinds', 'cron, webhook, filewatch, mcp_event, db_change, contract_emitted, workflow_event, signal_bus, manual'],
  ['2 target kinds', 'workflow (start a run), webhook_out (POST to external URL). Agent tick routing is road-mapped.'],
  ['JSONLogic filters', 'Evaluate event payload against a JSONLogic expression before dispatching. Unknown ops fail-closed.'],
  ['Rate limiting', 'Per-trigger token bucket with a 60-second tumbling window. Excess invocations are recorded as rate_limited.'],
  ['Durable rate-limit windows', 'createDurableTriggerRateLimiter uses runtime.persistence.kv — rate state survives process restart.'],
])}

${section('trig-setup', 'Defining a Trigger', `
${code('typescript', `import { createTriggerDispatcher, InMemoryTriggerStore } from '@weaveintel/triggers';
import type { Trigger } from '@weaveintel/triggers';

const store      = new InMemoryTriggerStore();
const dispatcher = createTriggerDispatcher({ store, targetAdapters: [workflowTargetAdapter] });

// Cron trigger — run a report workflow every day at 09:00 UTC
const trigger: Trigger = {
  id:     'daily-report',
  key:    'daily-report',        // human-readable key (Trigger uses 'key', not 'name')
  enabled: true,
  source: {
    kind:   'cron',
    config: { schedule: '0 9 * * *', timezone: 'UTC' },
  },
  target: {
    kind:   'workflow',
    config: { workflowId: 'revenue-report', input: { currency: 'USD' } },
  },
  rateLimit: { perMinute: 2 },  // safety valve
};

await store.save(trigger);
await dispatcher.reload();  // always call after store changes

// Webhook trigger — route incoming GitHub push events to a CI workflow
const webhookTrigger: Trigger = {
  id:     'github-push',
  key:    'github-push',
  enabled: true,
  source: {
    kind:   'webhook',
    config: { secret: process.env['GITHUB_WEBHOOK_SECRET'] },
  },
  filter: { expression: { '===': [{ var: 'ref' }, 'refs/heads/main'] } },
  target: {
    kind:   'workflow',
    config: { workflowId: 'ci-pipeline' },
  },
};
await store.save(webhookTrigger);
await dispatcher.reload();`, ['@weaveintel/triggers'])}
`)}

${section('trig-fire', 'Firing & Monitoring', `
${code('typescript', `import { TriggerDispatcher } from '@weaveintel/triggers';

// Manual fire (source.kind must be 'manual')
await dispatcher.fire('daily-report', { triggeredBy: 'admin@example.com' });

// Express webhook endpoint
app.post('/webhooks/github', async (req, res) => {
  await dispatcher.handleWebhook('github-push', req.body, req.headers);
  res.status(200).send('ok');
});

// List invocation history
const invocations = await store.listInvocations({ triggerId: 'daily-report' });
for (const inv of invocations) {
  console.log(inv.id, inv.status, inv.dispatchedAt);
  // status: dispatched | filtered | rate_limited | disabled | no_target_adapter | error
}`, ['@weaveintel/triggers'])}
`)}`;
}

// ── Section: Tools — Browser ──────────────────────────────────────────────

function sToolsBrowser(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/tools-browser</span></div>
  <h1 class="pkg-title">Browser Tools</h1>
  <p class="pkg-desc">Web page fetching, content extraction, structured scraping, screenshot capture, and Playwright browser automation — all as agent-callable tools with SSRF protection built in.</p>
</div>

${featureCards([
  ['fetch_page', 'Fetch the raw HTML/text content of a URL. SSRF-blocked. Configurable User-Agent, timeout, and size limit.'],
  ['extract_content', 'Extract clean readable text from a URL using Mozilla Readability — strips navigation, ads, and boilerplate.'],
  ['scrape_structured', 'Scrape structured data from a URL using CSS selectors and return as JSON.'],
  ['take_screenshot', 'Capture a full-page or viewport screenshot using Playwright (requires browser-enabled sandbox).'],
  ['fill_form', 'Fill and submit a web form using Playwright — for automating login, search, or data entry flows.'],
  ['click_element', 'Click a page element identified by CSS selector using Playwright.'],
])}

${section('browser-setup', 'Setup', `
${code('typescript', `import { createBrowserTools } from '@weaveintel/tools-browser';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext, weaveToolRegistry } from '@weaveintel/core';

// createBrowserTools() returns the browser Tool[] — register them in a registry
const tools = weaveToolRegistry();
for (const t of createBrowserTools()) tools.register(t);

const agent = weaveAgent({
  model:        weaveAnthropicModel('claude-sonnet-4-6'),
  tools,
  systemPrompt: 'You are a research assistant. Use browser tools to find and extract information from the web.',
  maxSteps:     6,
});

const ctx    = weaveContext();
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is the current Node.js LTS version? Check nodejs.org.' }],
});
console.log(result.output);`, ['@weaveintel/tools-browser', '@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/core'])}
`)}

${section('browser-playwright', 'Playwright Automation', `
<p>Playwright tools require the sandbox with a browser-enabled image. Use them for dynamic pages that require JavaScript execution.</p>

${code('typescript', `import { createAutomationTools } from '@weaveintel/tools-browser';
import { weaveToolRegistry } from '@weaveintel/core';

// Browser-automation tools drive a real browser (Playwright) — register them
const tools = weaveToolRegistry();
for (const t of createAutomationTools()) tools.register(t);

const agent = weaveAgent({
  model: weaveAnthropicModel('claude-sonnet-4-6'),
  tools,
  systemPrompt: 'You can control a browser. Take screenshots and interact with web pages.',
});

const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'Go to github.com/trending and screenshot the top 5 repos.' }],
});`, ['@weaveintel/tools-browser', '@weaveintel/sandbox'])}
`)}`;
}

// ── Section: Tools — Search ───────────────────────────────────────────────

function sToolsSearch(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/tools/search</span></div>
  <h1 class="pkg-title">Search Tools</h1>
  <p class="pkg-desc">Multi-provider web search with automatic failover. 9 search providers supported. A single <code>web_search</code> tool tries providers in order and returns results from the first that succeeds — no call-site changes needed to swap providers.</p>
</div>

${featureCards([
  ['9 providers', 'Tavily, Brave, Bing, Google Custom Search, SerpApi, You.com, Exa, Perplexity, DuckDuckGo'],
  ['Auto-failover', 'Tries providers in configured priority order. If provider A is down or rate-limited, B is tried automatically.'],
  ['Unified result shape', 'Every provider returns the same SearchResult shape: title, url, snippet, rank, source.'],
  ['SSRF protected', 'All outbound fetch calls go through the hardened egress client — search result URLs are not blindly followed.'],
])}

${section('search-setup', 'Setup', `
${code('typescript', `import { createSearchTools, createSearchRouter } from '@weaveintel/tools/search';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext, weaveToolRegistry } from '@weaveintel/core';

// A router tries its providers in priority order (lower priority = tried first)
const router = createSearchRouter({
  configs: {
    tavily: { name: 'tavily', enabled: true, apiKey: process.env['TAVILY_API_KEY']!, priority: 10 },
    brave:  { name: 'brave',  enabled: true, apiKey: process.env['BRAVE_API_KEY']!,  priority: 20 },
    bing:   { name: 'bing',   enabled: true, apiKey: process.env['BING_API_KEY']!,   priority: 30 },
  },
});

// createSearchTools(router) returns the search Tool[] — register them
const tools = weaveToolRegistry();
for (const t of createSearchTools(router)) tools.register(t);

const agent = weaveAgent({
  model:        weaveAnthropicModel('claude-sonnet-4-6'),
  tools,
  systemPrompt: 'You are a research assistant with web search capability.',
  maxSteps:     4,
});

const ctx    = weaveContext();
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What are the top 3 AI safety papers published in 2025?' }],
});
console.log(result.output);`, ['@weaveintel/tools/search', '@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/core'])}

${params([
  ['configs', 'Record<string, SearchProviderConfig>', 'required', 'Per-provider config keyed by provider name: { name, enabled, apiKey?, priority? }. Lower priority is tried first; others are failovers.'],
  ['providers', 'SearchProvider[]', 'optional', 'Custom provider instances, merged with the built-ins.'],
  ['fallback', 'boolean', 'optional', 'Fall through to the next provider when one fails.'],
])}
`)}

${section('search-e2e', 'End-to-End: Research Agent', `
${code('typescript', `import { createSearchTools, createSearchRouter } from '@weaveintel/tools/search';
import { createBrowserTools } from '@weaveintel/tools-browser';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext, weaveToolRegistry } from '@weaveintel/core';

// Combine search + browser tools for deep research
const tools = weaveToolRegistry();
const router = createSearchRouter({
  configs: { tavily: { name: 'tavily', enabled: true, apiKey: process.env['TAVILY_API_KEY']! } },
});

// Merge both tool sets into one registry
for (const t of createSearchTools(router)) tools.register(t);
for (const t of createBrowserTools()) tools.register(t);

const agent = weaveAgent({
  model:        weaveAnthropicModel('claude-opus-4-8'),
  tools,
  systemPrompt: \`You are a thorough research assistant.
Steps to follow for every research task:
1. Search for the topic to get an overview.
2. Extract full content from the 2 most relevant results.
3. Synthesise findings into a structured report.\`,
  maxSteps: 8,
});

const ctx    = weaveContext();
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'Research the current state of multi-modal AI models.' }],
});
console.log(result.output);`, ['@weaveintel/tools/search', '@weaveintel/tools-browser', '@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/core'])}
`)}`;
}

// new sections
(DOCS_SECTIONS as Record<string, () => string>)['security']     = sSecurity;
(DOCS_SECTIONS as Record<string, () => string>)['providers']    = sProviders;
(DOCS_SECTIONS as Record<string, () => string>)['sandbox']      = sSandbox;
(DOCS_SECTIONS as Record<string, () => string>)['a2a']          = sA2A;
// Piece 3
(DOCS_SECTIONS as Record<string, () => string>)['live-agents']  = sLiveAgents;
(DOCS_SECTIONS as Record<string, () => string>)['durability']   = sDurability;
(DOCS_SECTIONS as Record<string, () => string>)['persistence']  = sPersistence;
(DOCS_SECTIONS as Record<string, () => string>)['encryption']   = sEncryption;
// ── Section: Skills ──────────────────────────────────────────────────────

function sSkills(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/skills</span></div>
  <h1 class="pkg-title">Skills</h1>
  <p class="pkg-desc">Reusable capability bundles that combine instructions, tool activation, execution guidance, and optional prompt templates into a single composable unit. Skills are registered once and resolved by name — agents pick them up without knowing the implementation details.</p>
</div>

${callout('info', '🎯', 'Skills vs Prompts vs Tools.', 'A <strong>prompt</strong> is model instructions. A <strong>tool</strong> is a capability. A <strong>skill</strong> is a named bundle that activates both — it defines which tools are available, what the system prompt says, and how the agent should behave for a specific task type.')}

${section('skills-define', 'Defining Skills', `
${code('typescript', `import { defineSkill, createSkillRegistry } from '@weaveintel/skills';

const registry = createSkillRegistry();

// A skill is a declarative playbook the runtime injects into the prompt and
// uses to gate tools — query-aware, so only relevant skills are activated.
registry.register(defineSkill({
  id:   'web-research',
  name: 'Web Research',
  category: 'research',
  summary: 'Search the web, extract content, and synthesise findings into a structured report.',
  reasoningGuidance: \`For every research task:
1. Search for the topic to get an overview.
2. Extract full content from the 2 most relevant results.
3. Synthesise findings into a structured bullet-point report with citations.\`,
  toolNames:       ['web_search', 'extract_content'],   // tools this skill may use
  triggerPatterns: ['research', 'find out about', 'look up'],
}));

registry.register(defineSkill({
  id:   'code-review',
  name: 'Code Review',
  category: 'code',
  summary: 'Review code for correctness, security, and style.',
  reasoningGuidance: 'Review the provided code for bugs, security issues, and style violations. Output findings as a structured list.',
  toolNames:       [],   // no external tools — pure model reasoning
  triggerPatterns: ['review this code', 'code review'],
}));`, ['@weaveintel/skills'])}
`)}

${section('skills-invoke', 'Invoking a Skill', `
${code('typescript', `import { createSkillRegistry, buildSkillSystemPrompt } from '@weaveintel/skills';

const registry = createSkillRegistry();
// ...register skills as above...

// Query-aware activation: the registry picks the skills relevant to the input
// and reports which were selected (and which were rejected, and why).
const activation = await registry.activate(
  'Research the latest advances in quantum error correction.',
);

console.log(activation.selected.map((m) => m.skill.name));

// Build the augmented system prompt to feed into your agent's model call
const systemPrompt = buildSkillSystemPrompt([...activation.selected]);
console.log(systemPrompt);`, ['@weaveintel/skills'])}
`)}`;
}

// ── Section: Routing ──────────────────────────────────────────────────────

function sRouting(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/routing</span></div>
  <h1 class="pkg-title">Model Routing</h1>
  <p class="pkg-desc">Capability-based model routing and health tracking. Declare what your agent needs (tool calling, vision, long context) and the router selects the cheapest model that meets those requirements — automatically failing over when a model is unavailable.</p>
</div>

${callout('info', '🔀', 'Prefer routing over hardcoded model IDs.', 'Hardcoding a model ID means a single failing model breaks the feature. The router selects from a pool and tracks health — a degraded model is skipped automatically.')}

${section('routing-setup', 'Setup & Usage', `
${code('typescript', `import { SmartModelRouter } from '@weaveintel/routing';

// Declare the candidate pool + cost table. The router tracks health internally.
const router = new SmartModelRouter({
  candidates: [
    { modelId: 'claude-haiku-4-5-20251001', providerId: 'anthropic', capabilities: ['text', 'tool_calling'] },
    { modelId: 'claude-sonnet-4-6',         providerId: 'anthropic', capabilities: ['text', 'tool_calling', 'vision', 'long_context'] },
    { modelId: 'llama3.2',                  providerId: 'ollama',    capabilities: ['text'] },
  ],
  costs: [
    { modelId: 'claude-haiku-4-5-20251001', providerId: 'anthropic', inputCostPer1M: 0.25, outputCostPer1M: 1.25 },
    { modelId: 'claude-sonnet-4-6',         providerId: 'anthropic', inputCostPer1M: 3.00, outputCostPer1M: 15.0 },
    { modelId: 'llama3.2',                  providerId: 'ollama',    inputCostPer1M: 0,    outputCostPer1M: 0 },
  ],
});

// route(request, policy) returns a RoutingDecision (modelId + providerId + reason).
const base = { strategy: 'cost-optimized' as const, enabled: true };
const chat   = await router.route({ prompt: 'Say hi.' },        { ...base, id: 'chat',   name: 'chat',   constraints: { requiredCapabilities: ['text'] } });
const agent  = await router.route({ prompt: 'Use a tool.' },    { ...base, id: 'agent',  name: 'agent',  constraints: { requiredCapabilities: ['text', 'tool_calling'] } });
const vision = await router.route({ prompt: 'Describe image.' },{ ...base, id: 'vision', name: 'vision', constraints: { requiredCapabilities: ['text', 'vision'] } });
const budget = await router.route({ prompt: 'Cheap task.' },    { ...base, id: 'budget', name: 'budget', constraints: { requiredCapabilities: ['text'], maxCostPerRequest: 1.0 } });

// The decision names the model + provider to instantiate for this request
console.log(agent.modelId, agent.providerId, agent.reason);`, ['@weaveintel/routing'])}

${params([
  ['constraints.requiredCapabilities', 'string[]', 'optional', 'Capabilities the selected model must have. Available: <code>text</code>, <code>tool_calling</code>, <code>vision</code>, <code>long_context</code>, <code>embedding</code>.'],
  ['constraints.maxCostPerRequest', 'number', 'optional', 'Maximum estimated cost per request in USD. Models over this threshold are excluded.'],
  ['constraints.excludeModels', 'string[]', 'optional', 'Model IDs to skip for this request (e.g. when a model has circuit-opened).'],
])}
`)}`;
}

// ── Section: Contracts ────────────────────────────────────────────────────

function sContracts(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/core/contracts</span></div>
  <h1 class="pkg-title">Contracts</h1>
  <p class="pkg-desc">Evidence ledger for agent decisions. Every significant model output — a claim, a verdict, a recommendation — is recorded as a signed, append-only contract entry. Contracts are queryable, replayable, and provide the audit trail that makes AI decisions explainable after the fact.</p>
</div>

${featureCards([
  ['Immutable evidence chain', 'Entries are append-only with a tip-anchor hash — tampering breaks the chain and is detectable.'],
  ['Structured schema', 'Contract entries carry: runId, workflowId, stepId, kind (claim/verdict/recommendation/evidence), payload, confidence, and a payload hash.'],
  ['Workflow integration', 'WorkflowOutputContract packs and unpacks the contract via a reserved metadata key — no dedicated column needed.'],
  ['Replay compatibility', 'Contracts are used by the replay system to reconstruct the exact evidence a model had access to when making a decision.'],
])}

${section('contracts-emit', 'Emitting Contracts from Workflows', `
${code('typescript', `import { DefaultWorkflowEngine } from '@weaveintel/workflows';
import type { ContractEmitter } from '@weaveintel/workflows';
import type { WorkflowDefinition } from '@weaveintel/core';

// ContractEmitter is a small interface: emit(contract) — back it with your DB.
const contractEmitter: ContractEmitter = {
  async emit(contract) {
    await db.insertContract(contract);   // writes to the evidence ledger
  },
};

const engine = new DefaultWorkflowEngine({
  resolverRegistry: myResolvers,
  contractEmitter,
});

// In your workflow definition, declare an outputContract (kind + body/evidence map)
const def: WorkflowDefinition = {
  id: 'equity-analysis',
  name: 'Equity Analysis',
  version: '1.0.0',
  entryStepId: 'analyse',
  steps: [/* ...your WorkflowStep[] ... */],
  outputContract: {
    kind: 'recommendation',
    bodyMap: { ticker: 'ticker', action: 'action', confidence: 'confidence', reasoning: 'reasoning' },
    evidence: { fromHistory: true },
  },
};

await engine.createDefinition(def);
const run = await engine.startRun('equity-analysis', { ticker: 'AAPL' });
// After completion, a signed contract entry is appended to the evidence ledger.`, ['@weaveintel/workflows', '@weaveintel/core'])}
`)}

${section('contracts-query', 'Recording Completion Evidence', `
${code('typescript', `import { createEvidenceBundle, evidence, createCompletionReport } from '@weaveintel/core/contracts';

// Attach the evidence gathered while fulfilling the contract
const bundle = createEvidenceBundle(
  evidence.text('summary', 'Extracted 42 line items from the invoice.'),
  evidence.metric('confidence', 0.94),
  evidence.url('source', 'https://example.com/invoice/123'),
);

// Roll the validator results + evidence into an auditable completion report
const report = createCompletionReport(contract.id, validationResults, bundle);

console.log(report.status);      // 'fulfilled' | 'partial' | 'failed'
console.log(report.confidence);  // aggregate score across acceptance criteria
for (const item of report.evidence.items) {
  console.log(item.type, item.label);
}`, ['@weaveintel/core/contracts'])}
`)}`;
}

// ── Section: Artifacts ────────────────────────────────────────────────────

function sArtifacts(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/artifacts</span></div>
  <h1 class="pkg-title">Artifacts</h1>
  <p class="pkg-desc">Versioned file and blob storage for agent outputs — charts, PDFs, generated code files, data exports. Artifacts are referenced by a stable handle, stored in a pluggable backend (local filesystem, S3, Azure Blob, GCS), and can be attached to workflow runs for downstream consumption.</p>
</div>

${featureCards([
  ['Stable handles', 'Every artifact has a stable id (UUIDv7) and a human-readable slug. The id never changes even if the file is renamed.'],
  ['Versioning', 'Creating an artifact with the same slug creates a new version. Previous versions are retained and queryable.'],
  ['Backend-agnostic', 'Local filesystem for development; S3, Azure Blob, or GCS for production. One interface, swap a config line.'],
  ['Workflow attachment', 'Artifacts can be attached to workflow runs so downstream steps can retrieve them by name without tracking the id.'],
])}

${section('artifacts-store', 'Storing & Retrieving', `
${code('typescript', `import { createArtifactStore, inferMimeType } from '@weaveintel/artifacts';

// In-memory store (testing / development)
const store = await createArtifactStore({ backend: 'memory' });

// Filesystem store (production dev / single-server)
// const store = await createArtifactStore({ backend: 'filesystem', path: './artifacts' });

// SQLite store (embedded production — requires a better-sqlite3 Database instance)
// import Database from 'better-sqlite3';
// const rawDb = new Database('./geneweave.db');
// const store = await createArtifactStore({ backend: 'sqlite', db: rawDb });

// Save an artifact — scoped to a session
const artifact = await store.save({
  name:      'AAPL Price Chart Q3',
  type:      'svg',
  mimeType:  inferMimeType('svg'),
  data:      svgMarkup,
  sessionId: 'chat-abc',
  userId:    'alice',
  scope:     'session',
  tags:      ['chart', 'equity', 'AAPL'],
  metadata:  { ticker: 'AAPL', period: '2025-Q3' },
  version:   1,
});
console.log(artifact.id, artifact.version);  // "01JP..." v1

// Retrieve by id
const fetched = await store.get(artifact.id);

// Update — creates version 2 with a changelog
const updated = await store.update(artifact.id, { data: newSvgMarkup }, 'Refreshed with latest prices');

// List all session artifacts for a user
const all = await store.list({ sessionId: 'chat-abc', scope: 'session' });`, ['@weaveintel/artifacts', '@weaveintel/core'])}
`)}

${section('artifacts-types', 'Extended Type System (18 Types)', `
<p>This expands the artifact type system to 18 types with smart MIME detection, code-language inference, image magic-byte detection, and per-tenant type allowlists.</p>

<h4>All 18 Artifact Types</h4>
${code('typescript', `import { inferMimeType, inferCodeMime, detectImageMime } from '@weaveintel/artifacts';

// Text / document types
inferMimeType('text')        // → 'text/plain'
inferMimeType('markdown')    // → 'text/markdown'
inferMimeType('csv')         // → 'text/csv'
inferMimeType('json')        // → 'application/json'
inferMimeType('pdf')         // → 'application/pdf'
inferMimeType('report')      // → 'text/html'
inferMimeType('spreadsheet') // → 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// Code types — language-aware MIME inference
inferMimeType('code')                            // → 'text/plain' (no language)
inferMimeType('code', { language: 'python' })    // → 'text/x-python'
inferMimeType('code', { language: 'typescript' })// → 'text/typescript'
inferMimeType('code', { language: 'sql' })       // → 'application/sql'
inferCodeMime('javascript')                      // → 'text/javascript'
inferCodeMime('bash')                            // → 'text/x-sh'

// Visual types
inferMimeType('html')        // → 'text/html'
inferMimeType('svg')         // → 'image/svg+xml'
inferMimeType('diagram')     // → 'image/svg+xml'
inferMimeType('mermaid')     // → 'text/x-mermaid'
inferMimeType('react')       // → 'text/typescript'  (TSX source)
inferMimeType('interactive') // → 'text/html'

// Media types
inferMimeType('image')       // → 'image/png' (base default)
inferMimeType('audio')       // → 'audio/mpeg' (override via metadata.mimeType)
inferMimeType('video')       // → 'video/mp4'  (override via metadata.mimeType)

// Image magic-byte detection from binary data
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
detectImageMime(pngBytes)  // → 'image/png'

const jpegBytes = Buffer.from([0xff, 0xd8, 0xff]);
detectImageMime(jpegBytes) // → 'image/jpeg'

// Custom (opaque binary/text blobs)
inferMimeType('custom')      // → 'application/octet-stream'`, ['@weaveintel/artifacts'])}

<h4>Tenant-Specific Type Configuration</h4>
<p>Operators configure per-tenant allowlists via the Admin Panel → Knowledge → Type Settings.
The <code>emit_artifact</code> tool enforces these constraints at runtime before persisting.</p>

${code('typescript', `// Tenant artifact settings are resolved by the ChatEngine
// and passed into createToolRegistry() as resolvedArtifactSettings.
// You can pass them manually in custom agent setups:

import { createToolRegistry } from '@weaveintel/geneweave-api';

const registry = await createToolRegistry(['emit_artifact'], [], {
  actorPersona: 'tenant_user',
  artifactSave: async (input) => myStore.save(input),
  resolvedArtifactSettings: {
    allowed_types: ['text', 'json', 'csv', 'code', 'markdown'], // null = allow all 18
    max_size_bytes: 5 * 1024 * 1024,   // 5 MB cap; null = unlimited
    emit_enabled: true,                 // false blocks all artifact emission
    preview_enabled: true,              // controls UI preview rendering
    sandbox_html: true,                 // sandboxes HTML/React/Interactive iframes
  },
});

// If emit_enabled=false, or the type is not in allowed_types, or the data
// exceeds max_size_bytes, the tool returns { ok: false, error: "..." }
// without writing to the database.`, ['@weaveintel/geneweave-api'])}

<h4>Chat UI: Type-Aware Cards & Preview Panel</h4>
<p>The geneWeave chat UI automatically renders type-aware artifact cards after each agent turn.
Previewable types (<code>text, markdown, json, csv, code, html, svg, mermaid, react, interactive, image, audio, video</code>) show a 👁 button that opens a modal preview:</p>
<ul>
  <li><strong>SVG</strong> — inline SVG render (scripts stripped)</li>
  <li><strong>HTML / React / Interactive</strong> — sandboxed <code>&lt;iframe sandbox="allow-scripts"&gt;</code></li>
  <li><strong>Mermaid</strong> — iframe with mermaid.js CDN rendering</li>
  <li><strong>Code / JSON / CSV</strong> — syntax-highlighted <code>&lt;pre&gt;</code> block</li>
  <li><strong>Image</strong> — <code>&lt;img&gt;</code> tag with object URL</li>
  <li><strong>Audio / Video</strong> — native HTML5 player</li>
  <li><strong>Markdown</strong> — rendered HTML via mdToHtml()</li>
</ul>
<p>Code artifacts display a language badge (e.g. <code>python</code>) on the card when the <code>language</code> parameter was passed to <code>emit_artifact</code>.</p>
`)}

${section('artifacts-phase3', 'DB Persistence, Admin API & Versioning', `
<p>This wires artifact storage into the geneWeave database (SQLite, m77 migration), exposes a full admin REST API, and adds artifact version history. Every artifact emitted by an agent is persisted across server restarts, browsable in the admin panel, and downloadable on demand.</p>

<h4>DB Adapter methods (m77)</h4>
${code('typescript', `import { SQLiteAdapter } from '@weaveintel/geneweave-api';

const db = new SQLiteAdapter('./geneweave.db');
await db.initialize();  // runs all migrations including m77

// Save an artifact — creates artifacts row + artifact_versions row (v1)
const row = await db.saveArtifact!({
  name: 'q3-forecast.md',
  type: 'markdown',
  mimeType: 'text/markdown',
  data: '# Q3 Forecast\\n\\nAll segments on track.',
  sessionId: 'chat-001',
  userId: 'alice',
  agentId: 'analyst-agent',
  scope: 'session',           // 'session' | 'user' (user scope = cross-session)
  tags: ['forecast', 'q3'],
  metadata: { confidence: 0.92 },
});
// row.id = UUIDv7, row.version = 1

// Create a new version (updateArtifact increments version + writes artifact_versions row)
const v2 = await db.updateArtifact!(row.id, { data: '# Q3 Forecast (revised)\\n\\nRevised after board review.' }, 'Revised after board review');
// v2.version = 2

// List with filters
const myArtifacts = await db.listArtifacts!({ userId: 'alice', scope: 'session' });
const csvOnly     = await db.listArtifacts!({ type: 'csv' });
const bySession   = await db.listArtifacts!({ sessionId: 'chat-001' });

// Get single
const artifact = await db.getArtifact!(row.id);

// Version history
const versions = await db.getArtifactVersions!(row.id);
// versions = [{ version:1, ... }, { version:2, changelog:'Revised...', ... }]

// Specific version
const v1 = await db.getArtifactVersion!(row.id, 1);

// Delete (cascades to artifact_versions via FK)
await db.deleteArtifact!(row.id);

// Run retention — deletes artifacts past their policy's retention_days
const deletedCount = await db.expireArtifacts!();`, ['@weaveintel/geneweave-api'])}

<h4>Admin REST API (/api/admin/artifacts)</h4>
<p>All six admin endpoints are registered by <code>registerArtifactRoutes()</code> in <code>server-admin.ts</code>. Endpoints require authentication (<code>platform_admin</code> or <code>tenant_admin</code> persona).</p>
${code('http', `# GET  /api/admin/artifacts                        — list with filters
// GET  /api/admin/artifacts/:id                    — get single artifact
// GET  /api/admin/artifacts/:id/versions           — full version history
// GET  /api/admin/artifacts/:id/versions/:n        — specific version
// GET  /api/admin/artifacts/:id/download           — download raw data
// DELETE /api/admin/artifacts/:id                  — delete + cascade versions

// Query parameters for list:
//   type        e.g. ?type=markdown
//   session_id  e.g. ?session_id=chat-001
//   user_id     e.g. ?user_id=alice
//   agent_id    e.g. ?agent_id=analyst-agent
//   run_id      e.g. ?run_id=run-42
//   scope       e.g. ?scope=user
//   limit       e.g. ?limit=50  (max 500, default 100)
//   offset      e.g. ?offset=50

// Example response from GET /api/admin/artifacts
{
  "artifacts": [
    { "id": "01JP...", "name": "q3-forecast.md", "type": "markdown",
      "mime_type": "text/markdown", "size_bytes": 48, "version": 2,
      "session_id": "chat-001", "user_id": "alice",
      "agent_id": "analyst-agent", "scope": "session",
      "tags": ["forecast","q3"], "created_at": "2026-06-20T..." }
  ],
  "total": 1, "limit": 100, "offset": 0
}

// Example response from GET /api/admin/artifacts/:id/versions
{
  "versions": [
    { "id": "01JQ...", "artifact_id": "01JP...", "version": 1, "changelog": null, "created_at": "..." },
    { "id": "01JR...", "artifact_id": "01JP...", "version": 2, "changelog": "Revised after board review", "created_at": "..." }
  ]
}`)}

<h4>Artifact Retention Job</h4>
${code('typescript', `import { startArtifactRetentionJob } from '../../src/artifact-retention-job.js';

// Runs expireArtifacts() once on startup and then every 24h (fixed interval).
// Any artifact whose policy.retention_days has elapsed is deleted along with its versions.
const handle = startArtifactRetentionJob(db);

// Stop when server shuts down
process.on('SIGTERM', () => handle.stop());`)}

<h4>Admin UI browser (Knowledge → Artifacts)</h4>
<p>The <strong>Artifacts</strong> tab in the geneWeave admin panel (under the <em>Knowledge</em> group) shows all persisted artifacts in a sortable table. Each artifact row has a <strong>Download</strong> button that streams the raw data with the correct <code>Content-Disposition</code> header and file extension.</p>
<p>See also: <strong>Knowledge → Type Settings</strong> for the per-tenant allowlist configuration (m78).</p>
`)}

${section('artifacts-agent', 'Agent Tool: emit_artifact', `
${code('typescript', `// In geneWeave, agents call emit_artifact to persist typed outputs.
// The tool is automatically available when a chat session is active.
// No extra setup is needed — the tool calls db.saveArtifact() internally.

// Example agent system prompt excerpt:
// "When you produce a complete analysis, call emit_artifact to persist it."

// The agent would call:
// emit_artifact({
//   name: "Q3 Forecast Analysis",
//   type: "report",
//   data: "<html>...</html>",
//   tags: ["forecast", "q3"]
// })

// To use @weaveintel/artifacts directly in your own agent:
import { createArtifactStore, inferMimeType } from '@weaveintel/artifacts';
import { weaveTool, weaveToolRegistry, weaveContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

// Switch backend for production:
// const store = await createArtifactStore({ backend: 'filesystem', path: './artifacts' });
const store = await createArtifactStore({ backend: 'memory' });

const saveChartTool = weaveTool({
  name: 'save_chart',
  description: 'Save a generated SVG chart as a named artifact.',
  parameters: {
    type: 'object', required: ['name', 'svgContent'],
    properties: {
      name:       { type: 'string', description: 'Human-readable artifact name.' },
      svgContent: { type: 'string', description: 'Valid SVG markup.' },
    },
  },
  riskLevel: 'write',
  execute: async ({ name, svgContent }) => {
    const artifact = await store.save({
      name: name as string,
      type: 'svg',
      mimeType: inferMimeType('svg'),
      data: svgContent as string,
      version: 1,
      scope: 'session',
    });
    return JSON.stringify({ artifactId: artifact.id, version: artifact.version });
  },
});

const tools = weaveToolRegistry();
tools.register(saveChartTool);

const agent = weaveAgent({
  model:        weaveAnthropicModel('claude-sonnet-4-6'),
  tools,
  systemPrompt: 'Generate SVG charts for data analysis tasks and save them as artifacts.',
});

const result = await agent.run(weaveContext({ userId: 'alice' }), {
  messages: [{ role: 'user', content: 'Create a bar chart of FAANG stock returns in 2024.' }],
});
console.log(result.output);  // "Chart saved as artifact 01JP..., version 1"`, ['@weaveintel/artifacts', '@weaveintel/core', '@weaveintel/agents', '@weaveintel/provider-anthropic'])}
`)}

${section('artifacts-streaming', 'Streaming Lifecycle', `
<p>This adds real-time artifact generation with progressive SSE delivery. Large reports, live data feeds, or multi-step analysis can stream partial content to the client while the agent is still generating — providing instant feedback rather than a long wait before the full result appears.</p>

<h4>Core concepts</h4>
<ul>
  <li><strong><code>streamArtifact(store, opts, streamOpts)</code></strong> — creates an artifact immediately (stable <code>id</code> assigned before generation starts) and returns an <code>ArtifactStreamHandle</code>.</li>
  <li><strong><code>ArtifactStreamHandle</code></strong> — exposes <code>update(partial, progress)</code>, <code>complete(final, changelog)</code>, and <code>error(message)</code>. Only <code>complete()</code> writes a new version to the store.</li>
  <li><strong><code>artifact-stream-bus</code></strong> — lightweight in-process event bus (<code>Map</code>-based, synchronous dispatch) that bridges the tool execution path to the SSE endpoint.</li>
  <li><strong><code>GET /api/artifacts/:id/stream</code></strong> — SSE endpoint; auto-closes on <code>complete</code>/<code>error</code>; sends keepalive every 15 s.</li>
  <li><strong>m79 migration</strong> — adds <code>streaming_status TEXT</code> and <code>streaming_progress REAL</code> columns; cleared to <code>NULL</code> when generation finalises.</li>
</ul>

<h4>streamArtifact() — standalone API</h4>
${code('typescript', `import { streamArtifact, createArtifactStore } from '@weaveintel/artifacts';

const store = await createArtifactStore({ backend: 'memory' });

const handle = await streamArtifact<string>(
  store,
  { name: 'report.md', type: 'markdown', mimeType: 'text/markdown', data: '', scope: 'session' },
  {
    // Host pushes this event to SSE clients
    onProgress: (ev) => sseClient.send(JSON.stringify(ev)),
  },
);

// handle.id is stable from here — subscribe SSE clients before streaming begins
console.log('artifact id:', handle.id);   // e.g. "019ef1cb-..."

// Progressively build content
for (let i = 0; i < chunks.length; i++) {
  await handle.update(chunks.slice(0, i + 1).join(''), (i + 1) / chunks.length);
}

// Write final version to store (version bumps to 2+)
const artifact = await handle.complete(fullContent, 'Generated analysis report');
console.log('version:', artifact.version);   // 2
console.log('status:', handle.status);       // 'complete'

// On failure:
// await handle.error('LLM quota exceeded');
// console.log(handle.status);  // 'error'`, ['@weaveintel/artifacts'])}

<h4>emit_artifact streaming mode</h4>
<p>In geneWeave chat sessions the built-in <code>emit_artifact</code> tool supports a <code>streaming: true</code> flag. When set, the tool:</p>
<ol>
  <li>Saves an initial DB row with <code>streaming_status='streaming'</code> and returns the artifact id immediately.</li>
  <li>Splits the data into chunks (with <code>setImmediate</code> yields) and emits <code>update</code> events via the in-process bus.</li>
  <li>Calls <code>updateArtifact()</code> to write the final content and clears <code>streaming_status</code> to <code>NULL</code>.</li>
  <li>Returns <code>{ ok: true, streaming: true, streamUrl: '/api/artifacts/{id}/stream', version: N }</code>.</li>
</ol>
${code('typescript', `// Inside a geneWeave agent session, the model calls:
// emit_artifact({
//   name: "q3-analysis.md",
//   type: "markdown",
//   data: longMarkdownContent,
//   streaming: true,
//   changelog: "Generated Q3 market analysis"
// })
//
// The tool response includes:
// { ok: true, artifactId: "019ef1cb-...", version: 2, streaming: true,
//   streamUrl: "/api/artifacts/019ef1cb-.../stream" }

// Wire artifactUpdate alongside artifactSave in createToolRegistry:
const registry = await createToolRegistry(['emit_artifact'], [], {
  actorPersona: 'tenant_user',
  artifactSave: async (input) => {
    const row = await db.saveArtifact!({ ...input, userId: session.userId });
    return { id: row.id, version: row.version };
  },
  artifactUpdate: async (id, patch, changelog) => {
    const row = await db.updateArtifact!(id, patch, changelog);
    return { id: row.id, version: row.version };
  },
});`, ['@weaveintel/geneweave-api'])}

<h4>SSE endpoint: GET /api/artifacts/:id/stream</h4>
<p>Clients open this endpoint to receive live progress. The connection is kept open until the artifact finalises or the client disconnects.</p>
${code('typescript', `// Server-Sent Events format:
//
//   event: update
//   data: {"kind":"update","artifactId":"...","progress":0.33,"data":"partial content","timestamp":"..."}
//
//   event: complete
//   data: {"kind":"complete","artifactId":"...","progress":1,"version":2,"timestamp":"..."}
//
//   event: error
//   data: {"kind":"error","artifactId":"...","progress":0.5,"message":"LLM quota exceeded","timestamp":"..."}
//
//   : keepalive   ← sent every 15 s so proxies don't time out

// Client-side (browser or Node.js):
const evtSource = new EventSource(\`/api/artifacts/\${artifactId}/stream\`);

evtSource.addEventListener('update', (e: MessageEvent) => {
  const ev = JSON.parse(e.data);
  progressBar.style.width = \`\${ev.progress * 100}%\`;
  previewPane.textContent = ev.data ?? '';
});

evtSource.addEventListener('complete', (e: MessageEvent) => {
  const ev = JSON.parse(e.data);
  console.log('Done! Final version:', ev.version);
  evtSource.close();
});

evtSource.addEventListener('error', (e: MessageEvent) => {
  console.error('Streaming failed:', JSON.parse(e.data).message);
  evtSource.close();
});

// Already-complete artifacts return an immediate 'complete' event and close.
// Artifacts that errored return an immediate 'error' event and close.`)}

<h4>In-process event bus</h4>
<p>The bus (<code>apps/geneweave/src/lib/artifact-stream-bus.ts</code>) is a thin <code>Map</code>-based dispatcher — no external dependency, no queuing, synchronous delivery. It follows the same pattern as <code>live-run-event-bus.ts</code>.</p>
${code('typescript', `import {
  emitArtifactStreamEvent,
  onArtifactStreamEvent,
  offArtifactStreamEvent,
  hasArtifactStreamListeners,
} from '../../src/lib/artifact-stream-bus.js';

// Subscribe (SSE endpoint does this internally):
onArtifactStreamEvent(artifactId, (event) => {
  res.write(\`event: \${event.kind}\\ndata: \${JSON.stringify(event)}\\n\\n\`);
  if (event.kind === 'complete' || event.kind === 'error') res.end();
});

// Emit (streaming tool does this internally):
emitArtifactStreamEvent(artifactId, {
  kind: 'update',
  progress: 0.5,
  data: 'Partial content accumulated so far...',
});

// Check before subscribing to avoid memory leaks on short-lived artifacts:
if (!hasArtifactStreamListeners(artifactId)) {
  // No active SSE clients — skip bus overhead
}

// Always unsubscribe when done:
offArtifactStreamEvent(artifactId, listener);`)}

<h4>m79 DB migration</h4>
${code('sql', `-- Adds streaming lifecycle columns to the artifacts table.
-- streaming_status is NULL when the artifact is at rest (not streaming / errored).
ALTER TABLE artifacts ADD COLUMN streaming_status TEXT DEFAULT NULL
  CHECK(streaming_status IN ('streaming', 'error', NULL));
ALTER TABLE artifacts ADD COLUMN streaming_progress REAL DEFAULT NULL;

-- Partial index for O(1) "find all in-flight artifacts" queries
CREATE INDEX IF NOT EXISTS idx_artifacts_streaming
  ON artifacts(streaming_status)
  WHERE streaming_status IS NOT NULL;`)}

<p>See <code>apps/geneweave/src/migrations/m79-artifact-streaming.ts</code> and the retention job (<code>artifact-retention-job.ts</code>) which expires orphaned <code>streaming_status='streaming'</code> rows left by crashed sessions.</p>
`)}

${section('artifacts-rendering', 'Sandboxed Rendering', `
<p>This adds a server-side <strong>sandboxed render endpoint</strong> that converts any stored artifact into a self-contained HTML document — optimized for each artifact type. The rendered HTML is served in an iframe with strict CSP headers, keeping arbitrary agent-generated content fully isolated from the host application.</p>

<h4>GET /api/artifacts/:id/render</h4>
<p>Returns a <code>text/html</code> document tailored to the artifact type. The response headers restrict the iframe from interacting with the parent:</p>
${code('http', `GET /api/artifacts/019ef1cb-4d92-7c02-8f3a-d1e2b6c89f04/render HTTP/1.1
Authorization: Bearer <session-token>

HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
  img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Cache-Control: private, max-age=3600`)}

<h4>Type-specific rendering strategies</h4>
<table>
  <thead><tr><th>Type</th><th>Renderer</th><th>CDN</th></tr></thead>
  <tbody>
    <tr><td><code>markdown</code></td><td>marked.js parse → innerHTML</td><td>cdn.jsdelivr.net/npm/marked@9</td></tr>
    <tr><td><code>code</code></td><td>highlight.js syntax highlighting, language class from metadata</td><td>cdnjs.cloudflare.com/highlight.js/11.9.0</td></tr>
    <tr><td><code>json</code></td><td>Interactive collapsible tree-view (inline JS, no CDN)</td><td>—</td></tr>
    <tr><td><code>csv</code></td><td>Sortable HTML table, max 2000 rows with overflow note</td><td>—</td></tr>
    <tr><td><code>mermaid</code></td><td>Mermaid ESM module, dark theme</td><td>cdn.jsdelivr.net/npm/mermaid@10</td></tr>
    <tr><td><code>react</code></td><td>Babel standalone + React/ReactDOM CDN, auto-mounts default export</td><td>cdnjs.cloudflare.com/react 18.2 + babel 7.23</td></tr>
    <tr><td><code>html / report / interactive</code></td><td>Raw passthrough, CSP meta tag injected into <code>&lt;head&gt;</code></td><td>—</td></tr>
    <tr><td><code>svg / diagram</code></td><td>Centred in dark-body page</td><td>—</td></tr>
    <tr><td><code>text</code></td><td>Monospace pre-block with line numbers</td><td>—</td></tr>
    <tr><td><code>image / audio / video</code></td><td>Self-referencing <code>/api/artifacts/:id/data</code> as src</td><td>—</td></tr>
    <tr><td><code>pdf</code></td><td>Embedded <code>&lt;object&gt;</code> pointing to <code>/data</code></td><td>—</td></tr>
    <tr><td><code>spreadsheet</code></td><td>CSV fallback table when data contains commas/newlines</td><td>—</td></tr>
  </tbody>
</table>

<h4>Embedding in the chat UI</h4>
${code('typescript', `// Replace any content-rendering logic with a single sandboxed iframe:
const iframe = document.createElement('iframe');
iframe.src = \`/api/artifacts/\${artifactId}/render\`;
iframe.sandbox.add('allow-scripts', 'allow-same-origin');
iframe.referrerPolicy = 'no-referrer';
iframe.loading = 'lazy';
iframe.className = 'artifact-render-frame';
container.appendChild(iframe);

// Fullscreen:
window.open(\`/api/artifacts/\${artifactId}/render\`, '_blank');`)}

<h4>Admin preview modal</h4>
<p>The admin panel exposes the same endpoint at <code>GET /api/admin/artifacts/:id/render</code> (requires platform admin auth). Operators can open any stored artifact in a preview window without downloading the raw data:</p>
${code('typescript', `// Admin artifact preview button:
window.open(
  \`/api/admin/artifacts/\${artifactId}/render\`,
  'artifact-preview',
  'width=960,height=700,resizable=yes',
);`)}

<h4>buildArtifactRenderHtml() — server-side helper</h4>
<p>The <code>buildArtifactRenderHtml(type, data, mimeType, name, language?, artifactId?)</code> function in <code>apps/geneweave/src/routes/artifacts.ts</code> generates the type-specific HTML. It is exported so the admin API routes can reuse the same logic without duplication. Key XSS defense: all user-controlled strings inserted into HTML attribute or text nodes pass through <code>esc()</code> (HTML entity encoding).</p>

<h4>Example 119</h4>
<p>See <code>examples/119-artifact-sandbox-rendering.ts</code> for a self-contained demo covering all 9 types, CSP headers, auth guards, admin endpoint, and a live <code>weaveAgent</code> emit-then-render round-trip.</p>
`)}

${section('artifacts-live', 'Live Artifacts & MCP Connectivity', `
<p>This makes artifacts <strong>dynamic</strong>: any artifact can be backed by a <code>refreshFn</code> callback that re-fetches the underlying data on demand. The rendered iframe gets an injected LIVE toolbar with a Refresh button and an optional auto-refresh timer, and the live config is managed per-artifact via a dedicated admin CRUD API.</p>

<h4>Architecture overview</h4>
<table>
  <thead><tr><th>Component</th><th>Location</th><th>Purpose</th></tr></thead>
  <tbody>
    <tr><td>m80 migration</td><td><code>migrations/m80-live-artifact-configs.ts</code></td><td>Adds <code>live_artifact_configs</code> table with <code>refresh_interval_seconds</code>, <code>cache_ttl_seconds</code>, <code>last_refreshed_at</code>, <code>refresh_count</code></td></tr>
    <tr><td><code>refreshFn</code></td><td><code>RegisterArtifactRoutesOptions</code> interface</td><td>Optional async callback <code>(artifact, args) → { data }</code> called when the refresh endpoint is hit and the cache TTL has expired</td></tr>
    <tr><td>Refresh endpoint</td><td><code>POST /api/artifacts/:id/refresh</code></td><td>Auth-gated; returns <code>fromCache: true</code> when within TTL, otherwise calls <code>refreshFn</code> and saves the new data</td></tr>
    <tr><td>Live toolbar</td><td><code>injectLiveToolbar(html, live)</code></td><td>Injects a floating dark-themed toolbar before <code>&lt;/body&gt;&lt;/html&gt;</code> with LIVE badge, refresh counter, Refresh button, and auto-refresh toggle; sends <code>artifact-refreshed</code> postMessage to the parent iframe</td></tr>
    <tr><td>Admin CRUD</td><td><code>GET/POST/PATCH/DELETE /api/admin/artifacts/:id/live-config</code></td><td>Operators create/update/remove live configs; <code>POST /live-refresh</code> triggers an immediate touch</td></tr>
    <tr><td>UI live badge</td><td><code>geneweave-ui</code></td><td>Artifact cards show a pulsing LIVE badge when <code>isLive: true</code>; preview modal shows a Refresh button that calls the refresh endpoint and reloads the iframe</td></tr>
  </tbody>
</table>

<h4>POST /api/artifacts/:id/refresh</h4>
<p>The core live-refresh endpoint. Returns immediately from cache if within <code>cache_ttl_seconds</code>, otherwise delegates to the <code>refreshFn</code> registered at server startup:</p>
${code('http', `POST /api/artifacts/019ef2a1-7b3c-8d04-9e5f-c2d3a4b5e6f7/refresh HTTP/1.1
Authorization: Bearer <session-token>
Content-Type: application/json

{ "args": { "symbol": "NVDA" } }

HTTP/1.1 200 OK
Content-Type: application/json

{
  "artifactId": "019ef2a1-7b3c-8d04-9e5f-c2d3a4b5e6f7",
  "fromCache": false,
  "refreshedAt": "2026-06-23T14:22:01.000Z",
  "refreshCount": 5,
  "version": 6
}`)}

<h4>Registering a refreshFn</h4>
${code('typescript', `import { registerArtifactRoutes } from '../../src/routes/artifacts.js';
import type { ArtifactRow } from '../../src/db-types/artifacts.js';

registerArtifactRoutes(router, db, {
  refreshFn: async (artifact: ArtifactRow, args: Record<string, unknown>) => {
    // Called when the artifact's cache TTL has expired.
    // Fetch fresh data however you like:
    const symbol = (args['symbol'] as string) ?? 'BTC';
    const price = await fetchLivePrice(symbol);
    return {
      data: JSON.stringify({ symbol, price, ts: Date.now() }),
    };
  },
});`)}

<h4>injectLiveToolbar(html, live)</h4>
<p>Injects a floating toolbar into any artifact render HTML just before <code>&lt;/body&gt;&lt;/html&gt;</code>. When a live config exists, the render endpoint calls this automatically and adds <code>connect-src 'self'</code> to the CSP so the Refresh button can call <code>fetch()</code> back to the server:</p>
${code('typescript', `import { injectLiveToolbar } from '../../src/routes/artifacts.js';

// Manually inject a toolbar (useful for admin preview or custom routes):
const liveHtml = injectLiveToolbar(renderedHtml, {
  artifactId: 'abc-123',
  refreshIntervalSeconds: 30,
  refreshCount: 4,
  lastRefreshedAt: '2026-06-23T14:00:00Z',
  refreshEndpoint: '/api/artifacts/abc-123/refresh',
});
// → html with a dark toolbar: LIVE badge | Refreshed: 4× | [Refresh] | [Auto-refresh: 30s]`)}

<h4>Admin CRUD API</h4>
${code('http', `# Create live config
POST   /api/admin/artifacts/:id/live-config
{ "refreshIntervalSeconds": 30, "cacheTtlSeconds": 10 }
→ 201  { liveConfig: { artifact_id, refresh_interval_seconds, cache_ttl_seconds, ... } }

# Read live config
GET    /api/admin/artifacts/:id/live-config
→ 200  { liveConfig: { ... } }   or   404 { error: "No live config" }

# Partial update (e.g. bump TTL only)
PATCH  /api/admin/artifacts/:id/live-config
{ "cacheTtlSeconds": 60 }
→ 200  { liveConfig: { ... } }

# Delete live config (artifact becomes static again)
DELETE /api/admin/artifacts/:id/live-config
→ 200  { ok: true }

# Touch last_refreshed_at (admin-triggered refresh)
POST   /api/admin/artifacts/:id/live-refresh
→ 200  { ok: true }`)}

<h4>Admin UI: Configure Live button</h4>
<p>Clicking <strong>📡 Configure Live</strong> on an artifact detail panel toggles the live config via browser <code>prompt()</code>/<code>confirm()</code> dialogs — no separate form needed. If no config exists the operator is prompted for <code>refreshIntervalSeconds</code>; if one exists they can confirm deletion to revert to static.</p>

<h4>UI cards: LIVE badge</h4>
<p>Artifact cards in the chat panel show a pulsing blue LIVE badge when <code>ref.isLive === true</code>. The preview modal adds a <strong>Refresh</strong> button that calls <code>POST /api/artifacts/:id/refresh</code>, then reloads the iframe <code>src</code>. The iframe itself sends an <code>artifact-refreshed</code> postMessage to the parent after each auto-refresh cycle.</p>

<h4>Example 120</h4>
<p>See <code>examples/120-live-artifacts.ts</code> for a full end-to-end walkthrough: artifact creation, live config CRUD, toolbar injection, the <code>refreshFn</code> callback, cache TTL guard, admin touch endpoint, and a live <code>gpt-4o-mini</code> round-trip that emits a JSON artifact and then refreshes it.</p>
`)}`;
}

// ── Section: Replay ───────────────────────────────────────────────────────

function sReplay(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/observability/replay</span></div>
  <h1 class="pkg-title">Replay</h1>
  <p class="pkg-desc">Deterministic re-execution of workflow runs from a saved snapshot. Replay uses the same definition, inputs, and tool outputs from the original run — so you can reproduce exact model behaviour, debug failures, or run evals against historical data without hitting live APIs.</p>
</div>

${callout('info', '🔁', 'Reproducibility is always @weaveintel/observability/replay.', 'Never invent a bespoke bundle format for reproducing runs. The replay package handles definition snapshots, step-level output recording, and ordinal-strict re-execution.')}

${section('replay-record', 'Recording a Run for Replay', `
<p>Every workflow run automatically records step outputs when a checkpoint store and run repository are configured. No extra wiring is needed — runs are replayable by default when persistence is on.</p>

${code('typescript', `import { DefaultWorkflowEngine } from '@weaveintel/workflows';
import { weaveSqliteWorkflowRunRepository, weaveSqliteCheckpointStore } from '@weaveintel/workflows';

// Configure durable stores — this enables replay automatically
const engine = new DefaultWorkflowEngine({
  runRepository:   weaveSqliteWorkflowRunRepository({ databasePath: './workflows.db' }),
  checkpointStore: weaveSqliteCheckpointStore({ databasePath: './workflows.db' }),
  resolverRegistry: myResolvers,
});

// Run normally
const run = await engine.startRun('equity-analysis', { ticker: 'AAPL' });
console.log('run id:', run.id);   // save this for replay`, ['@weaveintel/workflows'])}
`)}

${section('replay-replay', 'Re-executing a Run', `
${code('typescript', `import { DefaultWorkflowEngine } from '@weaveintel/workflows';

// Replay from a specific step — steps before fromStepId use recorded outputs
const replayRun = await engine.replayRun(originalRunId, {
  fromStepId: 'generate-recommendation',  // re-execute from this step onwards
  tenantId:   'acme',

  // Override specific step outputs (e.g. inject fixed tool responses for eval)
  overrides: {
    'fetch-price-data': { price: 189.50, volume: 54_200_000 },
  },
});

console.log(replayRun.status);   // 'completed' | 'failed'
console.log(replayRun.state.variables);  // final output variables

// Full replay (re-run all steps from scratch with recorded context)
const fullReplay = await engine.replayRun(originalRunId);`, ['@weaveintel/workflows'])}

${params([
  ['originalRunId', 'string', 'required', 'The run ID to replay. The run must have been executed with a durable runRepository.'],
  ['fromStepId', 'string', 'optional', 'Step ID to resume from. Steps before this are replayed from checkpoints without calling handlers. Default: replay all steps.'],
  ['tenantId', 'string', 'optional', 'Override tenantId for the replay run. Useful for cross-tenant eval.'],
  ['overrides', 'Record&lt;string, unknown&gt;', 'optional', 'Map of stepId → output override. Replaces the recorded output for that step, useful for injecting controlled data in evals.'],
])}
`)}`;
}

// ── Section: Live Agents Trace Tools ─────────────────────────────────────

function sLiveAgentsTraceTools(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/live-agents/trace-tools</span></div>
  <h1 class="pkg-title">Live Agents Trace Tools</h1>
  <p class="pkg-desc">A thin tool pack that exposes live-agent mesh state as agent-callable tools. Attach these to any agent so it can inspect running meshes, read agent contracts, and trace the history of an agent's decisions — useful for supervisor agents and for admin/debugging interfaces.</p>
</div>

${exlinks([
  ['110-live-agents-trace-tools.ts', 'Example 110 — Live Agents Trace Tools'],
])}

${section('trace-tools-setup', 'Setup', `
${code('typescript', `import { createLiveTraceTools } from '@weaveintel/live-agents/trace-tools';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext } from '@weaveintel/core';

// Create the live-agent trace tools. They are scoped to a single runId and
// read from event/step/cost readers you provide.
const traceTools = createLiveTraceTools({
  runId:       'mesh-run-123',    // the ONLY run these tools may read
  eventReader: liveRunEventReader, // required
  stepReader:  liveRunStepReader,  // optional
});

// Attach to a supervisor agent that monitors the mesh
const monitorAgent = weaveAgent({
  model:        weaveAnthropicModel('claude-sonnet-4-6'),
  tools:        traceTools,
  systemPrompt: \`You are a mesh monitor. Use the trace tools to:
- List all active agents and their current status
- Read the most recent contracts for any agent
- Diagnose agents that appear stuck or have high error rates
- Summarise what the mesh has been doing in the last hour\`,
  maxSteps: 6,
});

const ctx    = weaveContext({ userId: 'admin' });
const result = await monitorAgent.run(ctx, {
  messages: [{ role: 'user', content: 'Which agents are currently active and what did they produce in the last 30 minutes?' }],
});
console.log(result.output);`, ['@weaveintel/live-agents/trace-tools', '@weaveintel/agents', '@weaveintel/provider-anthropic', '@weaveintel/core'])}
`)}

${section('trace-tools-list', 'Available Tools', `
<table class="ptable"><thead><tr><th>Tool</th><th>Description</th></tr></thead><tbody>
<tr><td><code>list_agents</code></td><td>List all agents in the mesh with id, role, status, and last-active timestamp</td></tr>
<tr><td><code>get_agent_state</code></td><td>Full state for a specific agent: backlog, inbox, active contracts</td></tr>
<tr><td><code>list_contracts</code></td><td>List recent contract entries for an agent — claims, verdicts, recommendations</td></tr>
<tr><td><code>get_run_events</code></td><td>Retrieve tick events (started/completed/errored) for an agent over a time window</td></tr>
<tr><td><code>get_backlog</code></td><td>List pending backlog items for an agent with status and priority</td></tr>
<tr><td><code>read_message</code></td><td>Read a specific inbox message by id</td></tr>
<tr><td><code>get_mesh_summary</code></td><td>High-level mesh health: agent count, tick rate, error rate, last-contract timestamps</td></tr>
</tbody></table>
`)}`;
}

// ── Section: OAuth ───────────────────────────────────────────────────────

function sOAuth(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/identity/oauth</span></div>
  <h1 class="pkg-title">OAuth</h1>
  <p class="pkg-desc">OAuth 2.0 Authorization Code flow for agent tools that need per-user credentials — Google Calendar, Gmail, Dropbox, OneDrive, Slack, and any OAuth 2.0 provider. Flow state is durable (survives restarts via <code>runtime.persistence.kv</code>) and PKCE is applied by default.</p>
</div>

${featureCards([
  ['Durable flow state', 'OAuth state (nonce, code verifier, redirect URI) is stored in KV with a TTL. Survives process restarts between redirect and callback.'],
  ['PKCE by default', 'Code verifier and challenge are generated and verified automatically. No need to configure it explicitly.'],
  ['Token refresh', 'Access tokens are refreshed automatically before expiry. Refresh failures surface a structured error so the agent can re-initiate the flow.'],
  ['Multi-tenant', 'State and tokens are namespaced by userId + tenantId so different users never see each other\'s credentials.'],
])}

${section('oauth-setup', 'Setup & Flow', `
${code('typescript', `import { OAuthClient, createOAuthProvider, InMemoryOAuthStateStore } from '@weaveintel/identity/oauth';
import { randomUUID } from 'node:crypto';

// Configure a provider (clientId, clientSecret, redirectUri)
const google = createOAuthProvider(
  'google',
  process.env['GOOGLE_CLIENT_ID']!,
  process.env['GOOGLE_CLIENT_SECRET']!,
  'https://myapp.example.com/oauth/callback',
);

// The client holds the state store (swap in a durable one for production)
const oauth = new OAuthClient(new InMemoryOAuthStateStore());

// Step 1: Generate the authorization URL (redirect user here)
const state = randomUUID();
const { authUrl, codeVerifier } = await oauth.generateAuthorizationUrl(google, state);
// Redirect the user to: authUrl (persist codeVerifier + state for the callback)

// Step 2: Handle the callback (after user grants permission)
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query as { code: string; state: string };
  const { token } = await oauth.exchangeCodeForToken(google, code, state);
  // token.access_token, token.refresh_token, token.expires_in
  await tokenStore.save({ userId: 'alice', provider: 'google', token });
  res.redirect('/app');
});

// Step 3: Read the user's profile with the token
const profile = await oauth.getUserProfile(google, savedToken);`, ['@weaveintel/identity/oauth'])}
`)}

${section('oauth-tool', 'OAuth as an Agent Tool', `
${code('typescript', `import { weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

// googleFlow here is your app's OAuth helper around OAuthClient (see Setup above).
const tools = weaveToolRegistry();

// Tool that checks if the user has granted Google Calendar access
tools.register(weaveTool({
  name: 'check_google_auth',
  description: 'Check if the user has granted Google Calendar access. If not, return the authorization URL.',
  parameters: { type: 'object', properties: {} },
  execute: async (_, ctx) => {
    const token = await googleFlow.getValidToken({ userId: ctx.userId!, tokenStore });
    if (!token) {
      const { url } = await googleFlow.authorize({ userId: ctx.userId!, tenantId: ctx.tenantId! });
      return JSON.stringify({ authorized: false, authUrl: url });
    }
    return JSON.stringify({ authorized: true });
  },
}));

tools.register(weaveTool({
  name: 'list_calendar_events',
  description: 'List upcoming Google Calendar events for the authenticated user.',
  parameters: { type:'object', properties:{ days: { type:'number' } } },
  execute: async ({ days = 7 }, ctx) => {
    const token  = await googleFlow.getValidToken({ userId: ctx.userId!, tokenStore });
    if (!token) return JSON.stringify({ error: 'Not authorized. Call check_google_auth first.' });
    const events = await gcal.listEvents(token.accessToken, { days: days as number });
    return JSON.stringify(events);
  },
}));

const agent = weaveAgent({ model, tools, maxSteps: 4 });`, ['@weaveintel/identity/oauth', '@weaveintel/core', '@weaveintel/agents'])}
`)}`;
}

// ── Section: Extraction ───────────────────────────────────────────────────

function sExtraction(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/extraction</span></div>
  <h1 class="pkg-title">Extraction</h1>
  <p class="pkg-desc">Structured data extraction from unstructured text using LLM-powered schemas. Define what you want to extract with a JSON Schema; the extraction pipeline handles prompting, validation, repair, and confidence scoring. Works on single documents or streaming batches.</p>
</div>

${featureCards([
  ['Schema-driven', 'Define extraction targets as JSON Schema. The pipeline generates appropriate prompts and validates the output against the schema.'],
  ['LLM + rule hybrid', 'Combine LLM extraction for complex fields with regex rules for structured fields (emails, phone numbers, dates) to minimise cost.'],
  ['Auto-repair', 'Malformed JSON outputs are automatically repaired using a smaller, faster model before falling back to a manual repair pass.'],
  ['Confidence scoring', 'Each extracted field gets a confidence score. Low-confidence fields are flagged for human review.'],
  ['Batch streaming', 'Process thousands of documents in parallel with configurable concurrency. Progress callbacks for pipeline observability.'],
])}

${exlinks([
  ['113-extraction-pipeline.ts', 'Example 113 — Document Extraction Pipeline'],
])}

${section('extraction-schema', 'Knowledge-Graph Extraction', `
${code('typescript', `import { extractKnowledgeGraph } from '@weaveintel/extraction';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext } from '@weaveintel/core';

const model = weaveAnthropicModel('claude-haiku-4-5-20251001');
const ctx   = weaveContext({ userId: 'alice' });

// extractKnowledgeGraph is model-agnostic: pass a text→text \`generate\` callback.
const graph = await extractKnowledgeGraph(
  \`Anthropic, founded in 2021, is an AI safety company based in San Francisco.
   The company employs approximately 800 people and is led by CEO Dario Amodei.\`,
  async ({ system, user, temperature, maxTokens }) => {
    const res = await model.generate(ctx, {
      messages: [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        { role: 'user' as const, content: user },
      ],
      temperature,
      maxTokens,
    });
    return res.content;
  },
  { maxItems: 24, maxChars: 6000 },
);

console.log(graph.entities);
// [{ name: 'Anthropic', type: 'organization' }, { name: 'Dario Amodei', type: 'person' }, ...]

console.log(graph.relations);
// [{ subject: 'Dario Amodei', predicate: 'is CEO of', object: 'Anthropic' }, ...]`, ['@weaveintel/extraction', '@weaveintel/provider-anthropic', '@weaveintel/core'])}
`)}

${section('extraction-batch', 'Batch Extraction from Documents', `
${code('typescript', `import { autofillProperty } from '@weaveintel/extraction';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext } from '@weaveintel/core';

const model = weaveAnthropicModel('claude-haiku-4-5-20251001');
const ctx   = weaveContext();

const generate = async ({ system, user, temperature, maxTokens }) => {
  const res = await model.generate(ctx, {
    messages: [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      { role: 'user' as const, content: user },
    ],
    temperature,
    maxTokens,
  });
  return res.content;
};

// Fill a whole column across many rows in one batched pass — each cell is
// grounded in that row's context and returns the source ids it used.
const cells = await autofillProperty({
  property: { name: 'foundingYear', type: 'number', instruction: 'Year the company was founded.' },
  rows: [
    { rowId: 'anthropic', title: 'Anthropic', context: 'Anthropic, founded in 2021, is an AI safety company. [src-1]', sourceIds: ['src-1'] },
    { rowId: 'openai',    title: 'OpenAI',    context: 'OpenAI was founded in December 2015. [src-2]',              sourceIds: ['src-2'] },
  ],
  generate,
});

for (const cell of cells) {
  console.log(cell.rowId, cell.value, cell.citations);
  // 'anthropic' 2021 ['src-1']
}`, ['@weaveintel/extraction', '@weaveintel/provider-anthropic', '@weaveintel/core'])}
`)}

${section('extraction-e2e', 'End-to-End: Research → Extract → Store', `
${code('typescript', `import { extractKnowledgeGraph } from '@weaveintel/extraction';
import { weaveAgent } from '@weaveintel/agents';
import { createBrowserTools } from '@weaveintel/tools-browser';
import { weaveTool, weaveToolRegistry, weaveContext } from '@weaveintel/core';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

const extractModel = weaveAnthropicModel('claude-haiku-4-5-20251001');

// Tool that fetches a URL and extracts a structured knowledge graph
const tools = weaveToolRegistry();
for (const t of createBrowserTools()) tools.register(t);

tools.register(weaveTool({
  name: 'extract_company_data',
  description: 'Extract structured company facts (entities + relations) from a URL.',
  parameters: { type:'object', required:['url'], properties:{ url:{type:'string'} } },
  execute: async ({ url }, ctx) => {
    const content = await fetch(url as string).then(r => r.text());
    const graph = await extractKnowledgeGraph(content, async ({ system, user, temperature, maxTokens }) => {
      const res = await extractModel.generate(ctx, {
        messages: [
          ...(system ? [{ role: 'system' as const, content: system }] : []),
          { role: 'user' as const, content: user },
        ],
        temperature,
        maxTokens,
      });
      return res.content;
    });
    return JSON.stringify(graph);
  },
}));

const agent = weaveAgent({
  model:        weaveAnthropicModel('claude-sonnet-4-6'),
  tools,
  systemPrompt: 'Research companies by extracting structured data from web pages.',
});

const ctx = weaveContext({ userId: 'analyst' });
const res = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'Extract the key financial metrics for Apple from their investor relations page.' }],
});
console.log(res.output);`, ['@weaveintel/extraction', '@weaveintel/agents', '@weaveintel/tools-browser', '@weaveintel/core', '@weaveintel/provider-anthropic'])}
`)}`;
}

// Piece 7
(DOCS_SECTIONS as Record<string, () => string>)['oauth']        = sOAuth;
(DOCS_SECTIONS as Record<string, () => string>)['extraction']   = sExtraction;
// Piece 6
(DOCS_SECTIONS as Record<string, () => string>)['contracts']    = sContracts;
(DOCS_SECTIONS as Record<string, () => string>)['artifacts']    = sArtifacts;
(DOCS_SECTIONS as Record<string, () => string>)['replay']       = sReplay;
(DOCS_SECTIONS as Record<string, () => string>)['trace-tools']  = sLiveAgentsTraceTools;
// Piece 5
(DOCS_SECTIONS as Record<string, () => string>)['skills']       = sSkills;
(DOCS_SECTIONS as Record<string, () => string>)['routing']      = sRouting;
// Piece 4
(DOCS_SECTIONS as Record<string, () => string>)['tenancy']      = sTenancy;
(DOCS_SECTIONS as Record<string, () => string>)['redaction']    = sRedaction;
(DOCS_SECTIONS as Record<string, () => string>)['compliance']   = sCompliance;
(DOCS_SECTIONS as Record<string, () => string>)['triggers']     = sTriggers;
(DOCS_SECTIONS as Record<string, () => string>)['tools-browser']= sToolsBrowser;
(DOCS_SECTIONS as Record<string, () => string>)['tools-search'] = sToolsSearch;

// ── Full HTML export ──────────────────────────────────────────────────────

export function getDocsHTML(): string {
  // Pre-render all sections at build time, and store as a single JSON string for robust embedding
  const rendered: Record<string, string> = {};
  for (const [key, fn] of Object.entries(DOCS_SECTIONS)) {
    rendered[key] = fn();
  }
  // Serialize the entire object as a single JSON string
  let sectionsJsonString = JSON.stringify(rendered);
  // Escape </script> to prevent script tag termination
  sectionsJsonString = sectionsJsonString.replace(/<\/script>/gi, '<\\/script>'); // Escape </script> to prevent script tag termination

  const NAV_STRUCTURE = JSON.stringify([
    { id: 'home',         label: 'Home',            icon: '🏠', group: 'Overview' },
    // ── Agent Layer
    { id: 'agents',       label: 'Agents',           icon: '🤖', group: 'Agent Layer',
      subs: ['weave-agent','supervisor','agent-tools','agent-memory','agent-events'] },
    { id: 'workflows',    label: 'Workflows',        icon: '⚙️', group: 'Agent Layer',
      subs: ['wf-engine','wf-builder','wf-steps','wf-resolvers','wf-policy','wf-phases'] },
    { id: 'a2a',          label: 'A2A Protocol',     icon: '🔄', group: 'Agent Layer',
      subs: ['a2a-local','a2a-http'] },
    { id: 'live-agents',  label: 'Live Agents',      icon: '⚡', group: 'Agent Layer',
      subs: ['la-mesh','la-supervisor','la-state-stores','la-db-boot','la-e2e'] },
    { id: 'skills',       label: 'Skills',           icon: '🎯', group: 'Agent Layer',
      subs: ['skills-define','skills-invoke'] },
    // ── Model Layer
    { id: 'providers',    label: 'Providers',        icon: '☁️', group: 'Model Layer',
      subs: ['prov-anthropic','prov-openai','prov-google','prov-ollama','prov-llamacpp','prov-resilience'] },
    { id: 'routing',      label: 'Model Routing',    icon: '🔀', group: 'Model Layer',
      subs: ['routing-setup'] },
    { id: 'models',       label: 'Models',           icon: '🧠', group: 'Model Layer',
      subs: ['models-register','models-routing','models-providers'] },
    { id: 'prompts',      label: 'Prompts',          icon: '💬', group: 'Model Layer',
      subs: ['prompts-registry','prompts-contracts','prompts-frameworks','prompts-execution','prompts-ab'] },
    { id: 'contracts',    label: 'Contracts',        icon: '📜', group: 'Model Layer',
      subs: ['contracts-emit','contracts-query'] },
    { id: 'cost-governor',label: 'Cost Governor',    icon: '💰', group: 'Model Layer',
      subs: ['cost-levers','cost-setup'] },
    // ── Memory & Knowledge
    { id: 'memory',       label: 'Memory',           icon: '🧩', group: 'Memory & Knowledge',
      subs: ['memory-types','memory-extraction','memory-runtime','memory-backends'] },
    { id: 'retrieval',    label: 'Retrieval',        icon: '🔍', group: 'Memory & Knowledge',
      subs: ['retrieval-chunking','retrieval-embedding','retrieval-hybrid','retrieval-e2e'] },
    { id: 'extraction',   label: 'Extraction',       icon: '🔬', group: 'Memory & Knowledge',
      subs: ['extraction-schema','extraction-batch','extraction-e2e'] },
    // ── Tools
    { id: 'oauth',         label: 'OAuth',            icon: '🔑', group: 'Tools',
      subs: ['oauth-setup','oauth-tool'] },
    { id: 'tools',         label: 'Tool Framework',   icon: '🔧', group: 'Tools',
      subs: ['tools-define','tools-policy','tools-approval','tools-e2e'] },
    { id: 'tools-time',    label: 'tools-time',       icon: '🕐', group: 'Tools',
      subs: ['tools-time-setup'] },
    { id: 'tools-browser', label: 'Browser Tools',    icon: '🌐', group: 'Tools',
      subs: ['browser-setup','browser-playwright'] },
    { id: 'tools-search',  label: 'Search Tools',     icon: '🔎', group: 'Tools',
      subs: ['search-setup','search-e2e'] },
    { id: 'sandbox',       label: 'Sandbox',          icon: '📦', group: 'Tools',
      subs: ['sandbox-setup','sandbox-ephemeral','sandbox-session','sandbox-agent'] },
    { id: 'mcp',           label: 'MCP',              icon: '🔌', group: 'Tools',
      subs: ['mcp-client','mcp-server','mcp-e2e'] },
    { id: 'trace-tools',   label: 'Trace Tools',      icon: '🔭', group: 'Tools',
      subs: ['trace-tools-setup','trace-tools-list'] },
    { id: 'triggers',      label: 'Triggers',         icon: '⚡', group: 'Tools',
      subs: ['trig-setup','trig-fire'] },
    // ── Quality & Safety
    { id: 'guardrails',   label: 'Guardrails',       icon: '🛡️', group: 'Quality & Safety',
      subs: ['guardrails-pipeline','guardrails-checks','guardrails-runtime'] },
    { id: 'evals',        label: 'Evals',            icon: '📊', group: 'Quality & Safety',
      subs: ['evals-runner','evals-compare','evals-ci'] },
    { id: 'redaction',    label: 'Redaction',        icon: '✂️', group: 'Quality & Safety',
      subs: ['red-setup','red-model-middleware','red-audit'] },
    { id: 'resilience',   label: 'Resilience',       icon: '♻️', group: 'Quality & Safety',
      subs: ['resilience-run','resilience-primitives','resilience-durable','resilience-e2e'] },
    { id: 'observability',label: 'Observability',    icon: '📈', group: 'Quality & Safety',
      subs: ['obs-tracer','obs-budget','obs-otel'] },
    // ── Operations
    { id: 'artifacts',    label: 'Artifacts',        icon: '📎', group: 'Operations',
      subs: ['artifacts-store','artifacts-types','artifacts-phase3','artifacts-agent','artifacts-streaming','artifacts-rendering','artifacts-live'] },
    { id: 'replay',       label: 'Replay',           icon: '⏮️', group: 'Operations',
      subs: ['replay-record','replay-replay'] },
    { id: 'tenancy',      label: 'Tenancy',          icon: '🏢', group: 'Operations',
      subs: ['ten-context','ten-budget','ten-caps'] },
    { id: 'compliance',   label: 'Compliance',       icon: '📋', group: 'Operations',
      subs: ['comp-setup','comp-consent','comp-gdpr'] },
    { id: 'durability',   label: 'Durability',       icon: '💾', group: 'Operations',
      subs: ['dur-dlq','dur-idempotency','dur-retry-budget','dur-health'] },
    { id: 'persistence',  label: 'Persistence',      icon: '🗄️', group: 'Operations',
      subs: ['pers-slot','pers-kv','pers-adapters'] },
    { id: 'encryption',   label: 'Encryption',       icon: '🔐', group: 'Operations',
      subs: ['enc-setup','enc-proxy','enc-blind-index'] },
    // ── Security
    { id: 'security',     label: 'Security',         icon: '🔒', group: 'Security',
      subs: ['sec-egress','sec-tls','sec-audit','sec-redaction','sec-guardrails','sec-sandbox-egress','sec-runtime-secrets'] },
    // ── Core
    { id: 'core',         label: '@weaveintel/core', icon: '⚛️', group: 'Core',
      subs: ['core-runtime','core-capabilities','core-context','core-tools','core-events','core-audit'] },
  ]);

  const SUB_LABELS = JSON.stringify({
    // Agents
    'weave-agent':'weaveAgent','supervisor':'Supervisor Mode','agent-tools':'Tool Binding',
    'agent-memory':'Memory Integration','agent-events':'Event Bus',
    // Workflows
    'wf-engine':'Engine Setup','wf-builder':'Defining Workflows','wf-steps':'All Step Types',
    'wf-resolvers':'Handler Resolvers','wf-policy':'WorkflowPolicy','wf-phases':'Phase Reference',
    'step-deterministic':'deterministic','step-agentic':'agentic','step-condition':'condition',
    'step-switch':'switch','step-forEach':'forEach','step-parallel':'parallel (lanes)',
    'step-fork-join':'fork / join','step-wait':'wait','step-human-task':'human-task',
    'step-dynamic':'dynamic (W7)',
    // A2A
    'a2a-local':'In-Process A2A','a2a-http':'HTTP Transport',
    // Live Agents
    'la-mesh':'Provisioning a Mesh','la-supervisor':'Heartbeat Supervisor','la-state-stores':'State Store Backends',
    // Tenancy
    'ten-context':'Tenant Context','ten-budget':'Per-Tenant Budget','ten-caps':'Capability Bindings',
    // Compliance
    'comp-setup':'Setup','comp-consent':'Consent Management','comp-gdpr':'GDPR Deletion',
    // Triggers
    'trig-setup':'Defining a Trigger','trig-fire':'Firing & Monitoring',
    // Browser Tools
    'browser-setup':'Setup','browser-playwright':'Playwright Automation',
    // Search Tools
    'search-setup':'Setup','search-e2e':'Research Agent',
    // Evals
    'evals-compare':'Model Comparison','evals-ci':'CI Quality Gate',
    // Resilience
    'resilience-durable':'Durable Endpoint Registry','resilience-e2e':'End-to-End Example',
    // Prompts
    'prompts-execution':'Execution Pipeline','prompts-ab':'A/B Experiments',
    // MCP
    'mcp-e2e':'End-to-End Agent',
    // Trace Tools
    'trace-tools-setup':'Setup','trace-tools-list':'Available Tools',
    // Contracts
    'contracts-emit':'Emitting Contracts','contracts-query':'Querying Evidence',
    // Artifacts
    'artifacts-store':'Storing & Retrieving','artifacts-types':'Extended Types','artifacts-phase3':'DB & Admin API','artifacts-agent':'Agent Tool','artifacts-streaming':'Streaming','artifacts-rendering':'Rendering','artifacts-live':'Live Artifacts',
    // Replay
    'replay-record':'Recording a Run','replay-replay':'Re-executing',
    // Redaction
    'red-setup':'Basic Setup','red-model-middleware':'Model Middleware','red-audit':'Audit Auto-Redaction',
    // Durability
    'dur-dlq':'Dead-Letter Queue','dur-idempotency':'Idempotency Keys',
    'dur-retry-budget':'Retry Budget','dur-health':'Health Checks',
    // Persistence
    'pers-slot':'RuntimePersistenceSlot','pers-kv':'Direct KV Access','pers-adapters':'Workflow Store Adapters',
    // Encryption
    'enc-setup':'Setup','enc-proxy':'Encrypted DB Proxy','enc-blind-index':'Blind Indexes',
    // Providers
    'prov-anthropic':'Anthropic (Claude)','prov-openai':'OpenAI (GPT)','prov-google':'Google (Gemini)',
    'prov-ollama':'Ollama (Local)','prov-llamacpp':'llama.cpp (Local)','prov-resilience':'Built-in Resilience',
    // Models
    'models-register':'Registration','models-routing':'Smart Routing','models-providers':'Providers',
    // Prompts
    'prompts-registry':'Registry & Versioning','prompts-contracts':'Output Contracts',
    'prompts-frameworks':'Frameworks',
    // Cost Governor
    'cost-levers':'8 Levers','cost-setup':'Setup & Usage',
    // Memory
    'memory-types':'Memory Types','memory-extraction':'Extraction',
    'memory-runtime':'Runtime-Backed Store','memory-backends':'Backend Options',
    // Retrieval
    'retrieval-chunking':'Chunking','retrieval-embedding':'Embedding Pipeline',
    'retrieval-hybrid':'Hybrid Search',
    // Tools
    'tools-define':'Defining Tools','tools-policy':'Policy-Enforced Registry',
    'tools-approval':'Approval Gates','tools-e2e':'End-to-End Agent',
    'tools-time-setup':'Setup & Tools',
    // Skills
    'skills-define':'Defining Skills','skills-invoke':'Invoking a Skill',
    // Routing
    'routing-setup':'Setup & Usage',
    // Sandbox
    'sandbox-setup':'Setup & Config','sandbox-ephemeral':'Ephemeral Execution',
    'sandbox-session':'Session REPL','sandbox-agent':'Code-Interpreter Agent',
    // MCP
    'mcp-client':'MCP Client','mcp-server':'MCP Server',
    // Quality & Safety
    'guardrails-pipeline':'Building a Pipeline','guardrails-checks':'Built-in Checks',
    'evals-runner':'Eval Runner','resilience-run':'runResilient','resilience-primitives':'Primitives',
    'obs-tracer':'Tracing Setup','obs-budget':'Budget Tracking','obs-otel':'OpenTelemetry Export',
    // Security
    'sec-egress':'Hardened Egress (SSRF)','sec-tls':'TLS Floor','sec-audit':'Durable Audit Logger',
    'sec-redaction':'Auto-Redaction','sec-guardrails':'Guardrails Slot',
    'sec-sandbox-egress':'Sandbox Egress Allowlist','sec-runtime-secrets':'Secret Resolution',
    // Retrieval (expanded)
    'retrieval-e2e':'RAG Agent',
    // Extraction
    'extraction-schema':'Schema-Driven Extraction','extraction-batch':'Batch Extraction','extraction-e2e':'Research→Extract→Store',
    // OAuth
    'oauth-setup':'Setup & Flow','oauth-tool':'OAuth as Agent Tool',
    // Live Agents (expanded)
    'la-db-boot':'DB-Backed Boot','la-e2e':'Full Production Setup',
    // Guardrails (expanded)
    'guardrails-runtime':'Runtime Slot (Recommended)',
    // Core (expanded)
    'core-runtime':'weaveRuntime Constructor','core-capabilities':'RuntimeCapabilities',
    'core-context':'ExecutionContext','core-tools':'Tool Interfaces','core-events':'EventBus','core-audit':'AuditEntry Reference',
  });

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeaveIntel Docs</title>
<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin="anonymous">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" id="hljs-theme" crossorigin="anonymous">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js" crossorigin="anonymous"></script>
<style>
/* ── geneWeave design tokens ─────────────────────────────────────── */
:root{
  --bg:#EDF5F0;--bg2:#F7FBF8;--bg3:#F5F7F6;--bg4:#E2EAE5;
  --fg:#1A2B23;--fg2:#5A6B63;--fg3:#8A9B93;
  --accent:#2AB090;--accent2:#1E8A6F;--accent-dim:#E0F5EE;
  --solid:#1A2B23;--solid-hover:#24382F;--solid-contrast:#FFFFFF;
  --danger:#dc2626;--success:#16a34a;--warn:#d97706;
  --radius:12px;--radius-lg:16px;
  --font:'DM Sans','Plus Jakarta Sans',system-ui,sans-serif;
  --font-display:'Plus Jakarta Sans','DM Sans',sans-serif;
  --mono:'JetBrains Mono','Fira Code',monospace;
  --shadow-soft:0 1px 3px rgba(26,43,35,.06),0 8px 20px rgba(26,43,35,.06);
  --shadow-hover:0 2px 8px rgba(26,43,35,.10),0 14px 28px rgba(26,43,35,.10);
  --topbar:52px;--sidebar:268px;
}
html[data-theme='dark']{
  --bg:#0E1713;--bg2:#121E19;--bg3:#1A2B23;--bg4:#2E4339;
  --fg:#E5F2EC;--fg2:#B4CBC0;--fg3:#88A498;
  --accent:#34C9A5;--accent2:#2AB090;--accent-dim:#1C3A31;
  --solid:#28453A;--solid-hover:#315447;--solid-contrast:#F7FBF8;
  --danger:#F87171;--success:#4ADE80;--warn:#FBBF24;
  --shadow-soft:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
button{font-family:inherit;cursor:pointer;border:none;outline:none;background:none}
input{font-family:inherit;outline:none}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--fg3)}

/* ── Top bar ─────────────────────────────────────────────────────── */
.topbar{
  position:fixed;top:0;left:0;right:0;height:var(--topbar);z-index:200;
  background:var(--bg2);border-bottom:1px solid var(--bg4);
  display:flex;align-items:center;padding:0 18px;gap:14px;
  box-shadow:var(--shadow-soft);
}
.tb-brand{display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-weight:700;font-size:17px;color:var(--fg);text-decoration:none;flex-shrink:0}
.tb-brand-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.tb-brand span{color:var(--accent)}
.tb-divider{width:1px;height:20px;background:var(--bg4);flex-shrink:0}
.tb-label{font-size:13px;color:var(--fg3);font-weight:500;flex-shrink:0}
.breadcrumbs{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--fg3);flex:1;min-width:0;overflow:hidden}
.bc-item{color:var(--fg3);cursor:pointer;white-space:nowrap;transition:color .14s}
.bc-item:hover{color:var(--accent)}
.bc-item.current{color:var(--fg2);font-weight:500}
.bc-sep{color:var(--fg3);font-size:10px;flex-shrink:0}
.tb-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0}
.tb-btn{padding:6px 12px;border-radius:999px;font-size:12px;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);font-weight:500;transition:all .15s;cursor:pointer;white-space:nowrap}
.tb-btn:hover{background:var(--bg4);color:var(--fg);border-color:var(--fg3)}
.search-wrap{position:relative}
.search-wrap input{
  background:var(--bg3);border:1px solid var(--bg4);border-radius:8px;
  color:var(--fg);padding:6px 12px 6px 30px;font-size:12px;width:200px;
  transition:width .2s,border-color .2s;
}
.search-wrap input:focus{border-color:var(--accent);width:260px}
.search-wrap .s-icon{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--fg3);font-size:13px;pointer-events:none}
.search-wrap .kbd{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--fg3);background:var(--bg4);border-radius:4px;padding:1px 5px}

/* ── Layout ─────────────────────────────────────────────────────── */
.layout{
  display:flex;
  position:fixed;top:var(--topbar);left:0;right:0;bottom:0;
}

/* ── Sidebar — independently scrollable ─────────────────────────── */
.sidebar{
  width:var(--sidebar);flex-shrink:0;
  background:var(--bg2);border-right:1px solid var(--bg4);
  height:100%;overflow-y:auto;overflow-x:hidden;
  padding:12px 0 24px;
}
.sg-label{padding:10px 16px 4px;font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--fg3);text-transform:uppercase}
.nav-item{
  display:flex;align-items:center;gap:9px;
  padding:8px 14px;font-size:13px;font-weight:500;color:var(--fg2);
  cursor:pointer;transition:all .13s;border-left:2px solid transparent;
  user-select:none;
}
.nav-item:hover{background:var(--bg3);color:var(--fg)}
.nav-item.active{color:var(--accent);background:var(--accent-dim);border-left-color:var(--accent);font-weight:600}
.nav-item .ni-icon{font-size:14px;flex-shrink:0;width:18px;text-align:center}
.nav-item .ni-caret{margin-left:auto;font-size:10px;color:var(--fg3);transition:transform .14s}
.nav-item.open .ni-caret{transform:rotate(90deg)}
.nav-subs{overflow:hidden;max-height:0;transition:max-height .2s ease}
.nav-subs.open{max-height:600px}
.nav-sub-item{
  display:flex;align-items:center;gap:8px;
  padding:6px 14px 6px 38px;font-size:12px;color:var(--fg3);
  cursor:pointer;transition:all .12s;border-left:2px solid transparent;
}
.nav-sub-item::before{content:'';width:4px;height:4px;border-radius:50%;background:var(--fg3);flex-shrink:0}
.nav-sub-item:hover{background:var(--bg3);color:var(--fg2)}
.nav-sub-item.active{color:var(--accent2);border-left-color:var(--accent);font-weight:500}
.nav-sub-item.active::before{background:var(--accent)}

/* ── Main content — independently scrollable ────────────────────── */
.main{
  flex:1;height:100%;overflow-y:auto;overflow-x:hidden;
  padding:0 0 80px;min-width:0;
}
.main-inner{max-width:900px;padding:36px 48px;margin:0 auto}

/* ── Content styles ─────────────────────────────────────────────── */
.hero{text-align:center;padding:40px 0 32px;margin-bottom:8px}
.hero-icon{font-size:48px;margin-bottom:16px}
.hero-title{font-family:var(--font-display);font-size:32px;font-weight:700;color:var(--fg);margin-bottom:12px;line-height:1.2}
.hero-sub{font-size:16px;color:var(--fg2);max-width:600px;margin:0 auto 20px;line-height:1.6}
.hero-badges{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.badge{display:inline-flex;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600}
.badge-accent{background:var(--accent-dim);color:var(--accent2);border:1px solid color-mix(in oklab,var(--accent) 30%,transparent)}
.badge-muted{background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4)}
.pkg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:16px 0}
.pkg-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius);padding:16px;cursor:pointer;transition:all .15s}
.pkg-card:hover{border-color:var(--accent);box-shadow:var(--shadow-hover);transform:translateY(-1px)}
.pkg-icon{font-size:20px;margin-bottom:8px}
.pkg-name{font-size:13px;font-weight:600;color:var(--fg);margin-bottom:4px}
.pkg-desc{font-size:12px;color:var(--fg3);line-height:1.4}

.pkg-hdr{margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--bg4)}
.pkg-badge-wrap{margin-bottom:10px}
.pkg-badge{display:inline-flex;background:var(--accent-dim);color:var(--accent2);border:1px solid color-mix(in oklab,var(--accent) 25%,transparent);border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;font-family:var(--mono)}
.pkg-title{font-family:var(--font-display);font-size:28px;font-weight:700;color:var(--fg);margin-bottom:10px;line-height:1.2}
.pkg-desc{font-size:15px;color:var(--fg2);line-height:1.6;max-width:700px}

.sec-title{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;color:var(--fg);margin:32px 0 14px}
.sec-anchor{color:var(--accent);font-size:14px;font-weight:400;opacity:.7;cursor:pointer;text-decoration:none}
.sec-anchor:hover{opacity:1}
.subsec-title{font-size:16px;font-weight:600;color:var(--fg);margin:22px 0 10px;padding-left:12px;border-left:3px solid var(--accent)}
h4{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--fg3);margin:18px 0 8px}
p{color:var(--fg2);margin-bottom:12px;line-height:1.7;font-size:14px}
ul,ol{color:var(--fg2);padding-left:20px;margin-bottom:12px}
li{margin-bottom:4px;line-height:1.6;font-size:14px}
li code,p code,td code{font-family:var(--mono);font-size:12px;background:var(--bg3);border:1px solid var(--bg4);padding:1px 6px;border-radius:4px;color:var(--accent2)}
strong{color:var(--fg);font-weight:600}

.callout{display:flex;gap:12px;border-radius:var(--radius);padding:13px 16px;margin:16px 0;border:1px solid;font-size:14px;line-height:1.6}
.callout-icon{font-size:16px;flex-shrink:0;margin-top:1px}
.callout-info{background:color-mix(in oklab,var(--accent-dim) 60%,var(--bg2));border-color:color-mix(in oklab,var(--accent) 25%,transparent);color:var(--fg2)}
.callout-tip{background:color-mix(in oklab,rgba(76,175,147,.08) 100%,transparent);border-color:rgba(76,175,147,.3);color:var(--fg2)}
.callout-warn{background:color-mix(in oklab,rgba(217,119,6,.06) 100%,transparent);border-color:rgba(217,119,6,.3);color:var(--fg2)}
.callout-danger{background:rgba(220,38,38,.05);border-color:rgba(220,38,38,.3);color:var(--fg2)}
.callout strong{color:var(--fg)}
.callout code{font-family:var(--mono);font-size:12px;background:var(--bg3);padding:1px 5px;border-radius:3px}
.callout a{color:var(--accent)}

.cb{margin:14px 0 20px;border-radius:var(--radius);overflow:hidden;border:1px solid var(--bg4)}
.cb-hdr{display:flex;align-items:center;justify-content:space-between;background:var(--bg3);padding:8px 14px;border-bottom:1px solid var(--bg4)}
.cb-lang{font-size:10px;color:var(--fg3);font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.cb-actions{display:flex;align-items:center;gap:6px}
.copy-btn,.run-btn{background:var(--bg4);border:1px solid var(--bg4);color:var(--fg3);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;transition:all .14s}
.copy-btn:hover,.run-btn:hover{background:var(--bg);color:var(--fg);border-color:var(--fg3)}
.copy-btn.ok{color:var(--success);border-color:var(--success)}
.run-btn{color:var(--accent2);border-color:color-mix(in oklab,var(--accent) 30%,transparent)}
.run-btn:hover{background:var(--accent-dim);color:var(--accent);border-color:var(--accent)}

/* ── Docker run modal ──────────────────────────────────────────── */
.docker-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:600;align-items:center;justify-content:center}
.docker-overlay.open{display:flex}
.docker-box{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);width:680px;max-width:96vw;box-shadow:var(--shadow-hover);overflow:hidden}
.docker-hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--bg4);background:var(--bg3)}
.docker-hdr-title{font-weight:700;font-size:14px;color:var(--fg);display:flex;align-items:center;gap:8px}
.docker-close{background:none;border:none;color:var(--fg3);font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:4px}
.docker-close:hover{background:var(--bg4);color:var(--fg)}
.docker-body{padding:18px;overflow-y:auto;max-height:70vh}
.docker-step{margin-bottom:16px}
.docker-step-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:6px}
.docker-note{font-size:12px;color:var(--fg2);margin-bottom:12px;line-height:1.5}
.docker-note code{font-family:var(--mono);font-size:11px;background:var(--bg3);border:1px solid var(--bg4);padding:1px 5px;border-radius:3px;color:var(--accent2)}
.docker-cmd{background:var(--bg3);border:1px solid var(--bg4);border-radius:8px;padding:12px 14px;font-family:var(--mono);font-size:12px;color:var(--fg);white-space:pre-wrap;word-break:break-all;line-height:1.5;position:relative}
.docker-copy{position:absolute;top:8px;right:8px;background:var(--bg4);border:1px solid var(--bg4);color:var(--fg3);border-radius:5px;padding:2px 8px;font-size:10px;cursor:pointer}
.docker-copy:hover{background:var(--bg);color:var(--fg)}
.cb pre{margin:0;padding:16px;overflow-x:auto;background:var(--bg2)}
.cb pre code.hljs{font-family:var(--mono);font-size:13px;line-height:1.6;background:transparent!important;padding:0}
.tbl-wrap{overflow-x:auto;margin:14px 0 20px}
.ptable{width:100%;border-collapse:collapse;font-size:13px}
.ptable th{background:var(--bg3);color:var(--fg2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:9px 13px;text-align:left;border:1px solid var(--bg4);white-space:nowrap}
.ptable td{padding:9px 13px;border:1px solid var(--bg4);vertical-align:top;color:var(--fg2);line-height:1.5;font-size:13px}
.ptable tr:nth-child(even) td{background:color-mix(in oklab,var(--bg3) 50%,transparent)}
.pname code{font-family:var(--mono);font-size:12px;color:var(--accent2);white-space:nowrap}
.ptype code{font-family:var(--mono);font-size:11px;color:var(--fg3)}
.pdesc code{font-family:var(--mono);font-size:11px;background:var(--bg3);border:1px solid var(--bg4);padding:1px 4px;border-radius:3px;color:var(--accent2)}
.req{display:inline-block;background:color-mix(in oklab,var(--warn) 12%,transparent);color:var(--warn);border:1px solid color-mix(in oklab,var(--warn) 30%,transparent);border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;white-space:nowrap}
.opt{display:inline-block;background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4);border-radius:4px;padding:1px 6px;font-size:10px;white-space:nowrap}
.fcard-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:14px 0 20px}
.fcard{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius);padding:14px}
.fcard-title{font-weight:600;color:var(--fg);font-size:13px;margin-bottom:5px}
.fcard-desc{font-size:12px;color:var(--fg3);line-height:1.4}
.ex-links{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:14px 16px;margin:16px 0}
.ex-links-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:10px}
.ex-links-list{display:flex;flex-wrap:wrap;gap:8px}
.ex-link{display:inline-flex;align-items:center;gap:6px;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:5px 10px;font-size:12px;color:var(--fg2);text-decoration:none;transition:all .13s}
.ex-link:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.ex-icon{font-size:13px}
.ex-title{font-weight:500}
.ex-ext{font-size:10px;color:var(--fg3)}
.doc-section{margin-bottom:40px}
.doc-subsection{margin-top:20px;padding-top:16px;border-top:1px solid var(--bg4)}

/* ── Search overlay ─────────────────────────────────────────────── */
.s-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;align-items:flex-start;justify-content:center;padding-top:80px}
.s-overlay.open{display:flex}
.s-box{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);width:560px;overflow:hidden;box-shadow:var(--shadow-hover)}
.s-box input{width:100%;background:transparent;border:none;color:var(--fg);padding:16px 18px;font-size:15px;outline:none;font-family:var(--font)}
.s-results{max-height:380px;overflow-y:auto;border-top:1px solid var(--bg4)}
.s-result{padding:11px 18px;cursor:pointer;border-bottom:1px solid var(--bg4);transition:background .12s}
.s-result:hover{background:var(--bg3)}
.s-result .sr-title{font-size:14px;color:var(--fg);font-weight:500;margin-bottom:2px}
.s-result .sr-pkg{font-size:12px;color:var(--fg3)}
.s-empty{padding:14px 18px;color:var(--fg3);font-size:13px}
</style>
</head>
<body>

<!-- Top bar -->
<div class="topbar">
  <a class="tb-brand" href="/" target="_blank" rel="noopener" title="Open geneWeave">
    <div class="tb-brand-mark">🧬</div>
    <span>gene<span>Weave</span></span>
  </a>
  <div class="tb-divider"></div>
  <span class="tb-label">Developer Docs</span>
  <div class="breadcrumbs" id="bc">
    <span class="bc-item current" onclick="nav('home')">Docs</span>
  </div>
  <div class="tb-actions">
    <div class="search-wrap">
      <span class="s-icon">⌕</span>
      <input type="text" placeholder="Search…" id="searchTrigger" readonly onclick="openSearch()" title="Search (⌘K)">
      <span class="kbd">⌘K</span>
    </div>
    <button class="tb-btn" id="themeBtn" onclick="toggleTheme()" title="Toggle theme">🌙</button>
    <button class="tb-btn" onclick="window.close()">✕ Close</button>
  </div>
</div>

<!-- Docker run modal -->
<div class="docker-overlay" id="dockerOverlay" onclick="closeRun(event)">
  <div class="docker-box" onclick="event.stopPropagation()">
    <div class="docker-hdr">
      <div class="docker-hdr-title">🐳 Run in Docker</div>
      <button class="docker-close" onclick="closeRun()">✕</button>
    </div>
    <div class="docker-body" id="dockerBody"></div>
  </div>
</div>

<!-- Search overlay -->
<div class="s-overlay" id="sOverlay" onclick="closeSO(event)">
  <div class="s-box" onclick="event.stopPropagation()">
    <input type="text" id="sInput" placeholder="Search packages, functions, parameters…" oninput="doSearch(this.value)" autocomplete="off">
    <div class="s-results" id="sResults"></div>
  </div>
</div>

<!-- Layout -->
<div class="layout">
  <!-- Sidebar -->
  <nav class="sidebar" id="sidebar"></nav>

  <!-- Main content -->
  <main class="main" id="main">
    <div class="main-inner" id="mainInner"></div>
  </main>
</div>


<script type="application/json" id="sections-json">${sectionsJsonString}</script>
<script>
// Robustly parse all section HTML from a JSON script tag
const SECTIONS_JSON = document.getElementById('sections-json').textContent;
const SECTIONS = JSON.parse(SECTIONS_JSON);
const NAV        = ${NAV_STRUCTURE};
const SUB_LABELS = ${SUB_LABELS};

const TITLES = {};
NAV.forEach(n => { TITLES[n.id] = n.label; });

let currentSection = 'home';
let currentSub     = '';
let expandedGroups = {};

// ── Sidebar rendering ────────────────────────────────────────────
function buildSidebar() {
  const sidebar = document.getElementById('sidebar');
  let groupLabel = '';
  let html = '';

  NAV.forEach(item => {
    if (item.group !== groupLabel) {
      groupLabel = item.group;
      html += '<div class="sg-label">' + groupLabel + '</div>';
    }
    const isActive = currentSection === item.id;
    const hasSubs  = item.subs && item.subs.length > 0;
    const isOpen   = expandedGroups[item.id] || isActive;
    html += '<div class="nav-item' + (isActive ? ' active' : '') + (hasSubs && isOpen ? ' open' : '') +
      '" id="navitem-' + item.id + '" onclick="navItemClick(\'' + item.id + '\')">' +
      '<span class="ni-icon">' + item.icon + '</span>' +
      '<span>' + item.label + '</span>' +
      (hasSubs ? '<span class="ni-caret">' + (isOpen ? '▾' : '▸') + '</span>' : '') +
      '</div>';
    if (hasSubs && isOpen) {
      html += '<div class="nav-subs open" id="subs-' + item.id + '">';
      item.subs.forEach(function(subId) {
        const isSubActive = currentSub === subId;
        const label = SUB_LABELS[subId] || subId.replace(/-/g, ' ');
        html += '<div class="nav-sub-item' + (isSubActive ? ' active' : '') +
          '" onclick="navToSub(\'' + item.id + "','" + subId + '\')">' + label + '</div>';
      });
      html += '</div>';
    }
  });

  sidebar.innerHTML = html;
}

function navItemClick(id) {
  if (currentSection === id) {
    // Toggle expand/collapse if already on this section
    expandedGroups[id] = !expandedGroups[id];
    buildSidebar();
  } else {
    nav(id);
  }
}

function navToSub(sectionId, subId) {
  if (currentSection !== sectionId) nav(sectionId, false);
  currentSub = subId;
  buildSidebar();
  setTimeout(function() {
    var el = document.getElementById(subId);
    var main = document.getElementById('main');
    if (el && main) {
      // Manual scrollTop instead of scrollIntoView to keep sidebar independent
      var elTop = el.getBoundingClientRect().top;
      var mainTop = main.getBoundingClientRect().top;
      main.scrollTop += (elTop - mainTop) - 24;
    }
  }, 80);
  updateBreadcrumbs(sectionId, subId);
}

// ── Navigation ───────────────────────────────────────────────────
function nav(id, scroll) {
  currentSection = id;
  currentSub = '';
  expandedGroups[id] = true;

  const content = SECTIONS[id];
  const inner = document.getElementById('mainInner');
  inner.innerHTML = content || '<p style="color:var(--fg3)">Section not found.</p>';
  hljs.highlightAll();
  document.getElementById('main').scrollTop = 0;

  buildSidebar();
  updateBreadcrumbs(id, '');

  if (scroll !== false) {
    var navEl = document.getElementById('navitem-' + id);
    if (navEl) navEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function updateBreadcrumbs(sectionId, subId) {
  var bc = document.getElementById('bc');
  var html = '<span class="bc-item" onclick="nav(\'home\')">Docs</span>';
  if (sectionId !== 'home') {
    var t = TITLES[sectionId] || sectionId;
    html += '<span class="bc-sep">›</span>';
    html += '<span class="bc-item' + (subId ? '' : ' current') + '" onclick="nav(\'' + sectionId + '\')">' + t + '</span>';
    if (subId) {
      var st = SUB_LABELS[subId] || subId.replace(/-/g, ' ');
      html += '<span class="bc-sep">›</span>';
      html += '<span class="bc-item current">' + st + '</span>';
    }
  } else {
    html += '<span class="bc-sep">›</span><span class="bc-item current">Home</span>';
  }
  bc.innerHTML = html;
}

// ── Copy code ────────────────────────────────────────────────────
function copyCode(btn) {
  var pre = btn.closest('.cb').querySelector('code');
  navigator.clipboard.writeText(pre.innerText).then(function() {
    btn.textContent = '✓ Copied';
    btn.classList.add('ok');
    setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 2000);
  });
}

// ── Docker Run modal ─────────────────────────────────────────────
function showRun(cbId) {
  var cb   = document.getElementById(cbId);
  var code = cb ? cb.querySelector('code').innerText : '';
  var deps = (cb && cb.dataset.deps) ? cb.dataset.deps.split(',') : ['@weaveintel/core'];
  var pkgs = deps.join(' ');
  // Escape code for shell heredoc
  var escaped = code.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "'\\''");

  var dockerCmd = "docker run --rm -it \\\n" +
    "  -e OPENAI_API_KEY=\"$OPENAI_API_KEY\" \\\n" +
    "  -e ANTHROPIC_API_KEY=\"$ANTHROPIC_API_KEY\" \\\n" +
    "  -e GOOGLE_API_KEY=\"$GOOGLE_API_KEY\" \\\n" +
    "  node:20-slim bash -c '\\\n" +
    "    mkdir /app && cd /app && npm init -y -q && \\\n" +
    "    npm install --save-dev tsx " + pkgs + " && \\\n" +
    "    cat > example.ts << '\"'\"'EOF'\"'\"'\n" +
    escaped + "\n" +
    "EOF\n" +
    "    npx tsx example.ts'";

  var altCmd = "# OR: save example.ts locally then:\n" +
    "docker run --rm -it \\\n" +
    "  -v \"$(pwd)/example.ts:/app/example.ts\" \\\n" +
    "  -e OPENAI_API_KEY=\"$OPENAI_API_KEY\" \\\n" +
    "  -e ANTHROPIC_API_KEY=\"$ANTHROPIC_API_KEY\" \\\n" +
    "  node:20-slim bash -c '\\\n" +
    "    cd /app && npm init -y -q && \\\n" +
    "    npm install --save-dev tsx " + pkgs + " && \\\n" +
    "    npx tsx example.ts'";

  document.getElementById('dockerBody').innerHTML =
    '<div class="docker-step">' +
    '<div class="docker-step-label">Dependencies</div>' +
    '<div class="docker-note">The following npm packages will be installed inside the container: ' +
    deps.map(function(d) { return '<code>' + d + '</code>'; }).join(', ') + '</div>' +
    '</div>' +
    '<div class="docker-step">' +
    '<div class="docker-step-label">Option A — inline (copies code into the container)</div>' +
    '<div class="docker-cmd" id="dockerCmdA">' + escHtml(dockerCmd) +
    '<button class="docker-copy" onclick="copyDockerCmd(\'dockerCmdA\')">Copy</button></div>' +
    '</div>' +
    '<div class="docker-step">' +
    '<div class="docker-step-label">Option B — mount local file</div>' +
    '<div class="docker-note">Save the snippet as <code>example.ts</code> in your working directory first, then run:</div>' +
    '<div class="docker-cmd" id="dockerCmdB">' + escHtml(altCmd) +
    '<button class="docker-copy" onclick="copyDockerCmd(\'dockerCmdB\')">Copy</button></div>' +
    '</div>' +
    '<div class="docker-note" style="margin-top:12px">Set your API keys as environment variables before running. The container is ephemeral — no data persists after it exits.</div>';

  document.getElementById('dockerOverlay').classList.add('open');
}

function closeRun(e) {
  if (e && e.target !== document.getElementById('dockerOverlay')) return;
  document.getElementById('dockerOverlay').classList.remove('open');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function copyDockerCmd(id) {
  var el = document.getElementById(id);
  var text = el.innerText.replace(/Copy$/,'').trim();
  navigator.clipboard.writeText(text).then(function() {
    var btn = el.querySelector('.docker-copy');
    btn.textContent = '✓';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1800);
  });
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeRun({ target: document.getElementById('dockerOverlay') });
});

// ── Theme toggle ─────────────────────────────────────────────────
function toggleTheme() {
  var html = document.documentElement;
  var isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('themeBtn').textContent = isDark ? '🌙' : '☀️';
  var hljsLink = document.getElementById('hljs-theme');
  hljsLink.href = isDark
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
}

// ── Search ───────────────────────────────────────────────────────
var SEARCH_IDX = [
  // Agents
  {s:'agents',    t:'weaveAgent — Creating an Agent',   k:'weaveagent agent tool calling model tools system prompt'},
  {s:'agents',    t:'Supervisor Mode',                  k:'supervisor workers delegate delegation hierarchy multi-agent', sub:'supervisor'},
  {s:'agents',    t:'Tool Binding',                     k:'tool register weavetool tool registry execute', sub:'agent-tools'},
  {s:'agents',    t:'Memory Integration',               k:'memory agent cross-session context semantic', sub:'agent-memory'},
  // Workflows
  {s:'workflows', t:'Workflow Engine Setup',            k:'workflow engine defaultworkflowengine setup checkpoint run repository'},
  {s:'workflows', t:'Step Types',                       k:'deterministic agentic condition switch foreach parallel fork join wait human-task dynamic', sub:'wf-steps'},
  {s:'workflows', t:'Handler Resolvers',                k:'resolver noop script tool prompt agent mcp subworkflow plan', sub:'wf-resolvers'},
  {s:'workflows', t:'Dynamic Graphs (W7)',              k:'dynamic expansion planner sub-graph w7 dynamicexpansion', sub:'step-dynamic'},
  {s:'workflows', t:'WorkflowPolicy',                   k:'policy maxsteps costceiling concurrency expansion', sub:'wf-policy'},
  // A2A
  {s:'a2a',       t:'In-Process A2A',                   k:'a2a agent to agent message bus in-process local', sub:'a2a-local'},
  {s:'a2a',       t:'A2A HTTP Transport',               k:'a2a http distributed remote agent server client', sub:'a2a-http'},
  // Providers
  {s:'providers', t:'Anthropic — Claude Models',        k:'anthropic claude haiku sonnet opus model api key', sub:'prov-anthropic'},
  {s:'providers', t:'OpenAI — GPT Models',              k:'openai gpt gpt-4o embedding tool calling api key', sub:'prov-openai'},
  {s:'providers', t:'Google — Gemini Models',           k:'google gemini flash pro embedding api key', sub:'prov-google'},
  {s:'providers', t:'Ollama — Local Models',            k:'ollama local llama mistral phi3 on-prem offline', sub:'prov-ollama'},
  {s:'providers', t:'llama.cpp — GGUF Local Models',    k:'llamacpp llama.cpp gguf local server offline', sub:'prov-llamacpp'},
  {s:'providers', t:'Provider Resilience Defaults',     k:'resilience defaults provider circuit breaker retry 429', sub:'prov-resilience'},
  // Models
  {s:'models',    t:'Model Registration',               k:'register model weaveregistermodel weavegetmodel anthropic openai'},
  {s:'models',    t:'Smart Routing',                    k:'routing smart model router capability cost'},
  // Prompts
  {s:'prompts',   t:'Prompt Registry & Versioning',     k:'prompt registry version render template variables'},
  {s:'prompts',   t:'Output Contracts',                 k:'contract validate json schema repair output'},
  // Resilience (expanded)
  {s:'resilience', t:'Durable Endpoint Registry',   k:'endpoint registry durable circuit breaker KV restart persist', sub:'resilience-durable'},
  {s:'resilience', t:'Resilient External API Call',  k:'resilient callable provider defaults SSRF hardened fetch', sub:'resilience-e2e'},
  // Prompts (expanded)
  {s:'prompts',    t:'Prompt Execution Pipeline',    k:'resolve prompt execution record version experiment variant', sub:'prompts-execution'},
  {s:'prompts',    t:'A/B Prompt Experiments',       k:'experiment ab test variant weight promote winner prompt', sub:'prompts-ab'},
  // MCP (expanded)
  {s:'mcp',        t:'End-to-End MCP Agent',         k:'mcp agent filesystem tools e2e client agent run', sub:'mcp-e2e'},
  // Contracts
  {s:'contracts',  t:'Emitting Contracts from Workflows', k:'contract evidence ledger workflow output signed append', sub:'contracts-emit'},
  {s:'contracts',  t:'Querying the Evidence Ledger', k:'contract query ledger list verify chain integrity', sub:'contracts-query'},
  // Artifacts
  {s:'artifacts',  t:'Storing & Retrieving Artifacts',             k:'artifact file blob storage versioned s3 gcs local', sub:'artifacts-store'},
  {s:'artifacts',  t:'Extended Type System (18 Types)',  k:'artifact type mermaid react svg audio video spreadsheet interactive mime detect', sub:'artifacts-types'},
  {s:'artifacts',  t:'DB Persistence, Admin API & Versioning', k:'artifact sqlite admin api version history retention expire download delete', sub:'artifacts-phase3'},
  {s:'artifacts',  t:'Agent Artifact Tool',                       k:'artifact agent tool save chart svg pdf generated output emit', sub:'artifacts-agent'},
  {s:'artifacts',  t:'Streaming Lifecycle (SSE)',        k:'artifact streaming sse progress handle streamArtifact update complete error bus m79 real-time', sub:'artifacts-streaming'},
  {s:'artifacts',  t:'Sandboxed Rendering',             k:'artifact render iframe csp sandbox html markdown code json csv mermaid react svg admin preview buildArtifactRenderHtml xss', sub:'artifacts-rendering'},
  {s:'artifacts',  t:'Live Artifacts & MCP Connectivity', k:'artifact live refresh toolbar injectLiveToolbar refreshFn cache ttl m80 live-artifact-configs badge auto-refresh postMessage connect-src csp mcp connectivity 120', sub:'artifacts-live'},
  // Replay
  {s:'replay',     t:'Recording a Run for Replay',   k:'replay record workflow run durable checkpoint reproducible', sub:'replay-record'},
  {s:'replay',     t:'Re-executing a Workflow Run',   k:'replay rerun from step override deterministic reproduce eval', sub:'replay-replay'},
  // Trace Tools
  {s:'trace-tools', t:'Live Agents Trace Tools Setup', k:'trace tools live agent mesh state monitor admin supervisor', sub:'trace-tools-setup'},
  {s:'trace-tools', t:'Available Trace Tools',         k:'trace tools list agents contracts events backlog mesh summary', sub:'trace-tools-list'},
  // Skills
  {s:'skills',    t:'Defining Skills',                  k:'skill bundle system prompt tools instructions capability key', sub:'skills-define'},
  {s:'skills',    t:'Invoking a Skill',                 k:'skill invoke agent get registry toAgent', sub:'skills-invoke'},
  // Routing
  {s:'routing',   t:'Model Routing & Health Tracking',  k:'routing smart model router capability cost failover health', sub:'routing-setup'},
  // Memory
  {s:'memory',    t:'Runtime-Backed Memory Store',      k:'memory runtime kv store durable weaveRuntimeMemoryStore', sub:'memory-runtime'},
  {s:'memory',    t:'Memory Types',                     k:'semantic conversation entity working memory store'},
  {s:'memory',    t:'Automatic Extraction',             k:'extract memory conversation turn rules llm'},
  // Tools
  {s:'tools',     t:'Defining Tools with Risk Levels',  k:'tool define risk level read write destructive requires capability', sub:'tools-define'},
  {s:'tools',     t:'Approval Gates',                   k:'approval gate human review tool send email side effect queue', sub:'tools-approval'},
  // Retrieval
  {s:'retrieval', t:'Hybrid Search',                    k:'hybrid rag retrieval dense sparse bm25 rrf rerank'},
  {s:'retrieval', t:'Embedding Pipeline',               k:'embedding pipeline index vector store chunk'},
  // Tools
  {s:'tools',     t:'Policy-Enforced Registry',         k:'tool policy audit approval gate rate limit network'},
  {s:'tools-time',t:'Time Tools',                       k:'time datetime timezone timer stopwatch reminder'},
  // Sandbox
  {s:'sandbox',   t:'Sandbox Setup',                    k:'sandbox docker container code execution python javascript setup', sub:'sandbox-setup'},
  {s:'sandbox',   t:'Ephemeral Code Execution',         k:'sandbox execute python code run ephemeral container', sub:'sandbox-ephemeral'},
  {s:'sandbox',   t:'Session REPL',                     k:'sandbox session repl stateful persistent container chat', sub:'sandbox-session'},
  {s:'sandbox',   t:'Code-Interpreter Agent',           k:'code interpreter agent sandbox tool run python', sub:'sandbox-agent'},
  // MCP
  {s:'mcp',       t:'MCP Client',                       k:'mcp client stdio http transport tools protocol', sub:'mcp-client'},
  {s:'mcp',       t:'MCP Server',                       k:'mcp server expose tools host claude desktop', sub:'mcp-server'},
  // Evals / Guardrails / Resilience / Observability
  {s:'evals',     t:'Eval Runner',                      k:'eval evaluation rubric judge score accuracy'},
  {s:'guardrails',t:'Guardrails Pipeline',              k:'guardrail safety risk pii injection confidence'},
  {s:'resilience',t:'runResilient',                     k:'resilient retry circuit breaker rate limit token bucket concurrency'},
  {s:'cost-governor',t:'8 Cost Levers',                 k:'cost governor lever model cascade tool subset prompt cache'},
  {s:'observability',t:'Tracing Setup',                  k:'trace span console memory tracer observability ambient', sub:'obs-tracer'},
  {s:'observability',t:'Budget Tracking & Alerts',       k:'budget tracker monthly spend alert threshold token cost', sub:'obs-budget'},
  {s:'observability',t:'OpenTelemetry Export',           k:'opentelemetry otel jaeger tempo honeycomb span export', sub:'obs-otel'},
  // Tenancy
  {s:'tenancy',     t:'Tenant Context',              k:'tenant context tenantid propagation multi-tenant isolation', sub:'ten-context'},
  {s:'tenancy',     t:'Per-Tenant Budget Enforcement',k:'budget tenant spend USD cap monthly enforcement', sub:'ten-budget'},
  {s:'tenancy',     t:'Capability Bindings',          k:'capability binding tool policy subscription tier agent mesh', sub:'ten-caps'},
  // Compliance
  {s:'compliance',  t:'Durable Compliance Stores',    k:'compliance legal hold consent residency retention deletion gdpr', sub:'comp-setup'},
  {s:'compliance',  t:'Consent Management',           k:'consent gdpr purpose grant revoke subject', sub:'comp-consent'},
  {s:'compliance',  t:'GDPR Right to Erasure',        k:'gdpr deletion erasure right subject legal hold', sub:'comp-gdpr'},
  // Triggers
  {s:'triggers',    t:'Defining a Trigger',           k:'trigger cron webhook event dispatch workflow agent', sub:'trig-setup'},
  {s:'triggers',    t:'Firing & Monitoring',          k:'trigger fire manual monitor invocation history status', sub:'trig-fire'},
  // Browser Tools
  {s:'tools-browser',t:'Browser Tools Setup',         k:'browser fetch page extract content scrape screenshot tool', sub:'browser-setup'},
  {s:'tools-browser',t:'Playwright Automation',       k:'playwright browser automation screenshot form click dynamic', sub:'browser-playwright'},
  // Search Tools
  {s:'tools-search', t:'Search Tools Setup',          k:'search tavily brave bing serpapi web multi-provider failover', sub:'search-setup'},
  {s:'tools-search', t:'Research Agent (Search+Browser)',k:'research agent search browser combined deep extract', sub:'search-e2e'},
  // Evals
  {s:'evals',        t:'Model Comparison',            k:'eval compare baseline candidate regression score delta', sub:'evals-compare'},
  {s:'evals',        t:'CI Quality Gate',             k:'eval CI gate vitest jest quality threshold fail build', sub:'evals-ci'},
  // Redaction
  {s:'redaction',    t:'PII Redaction Setup',         k:'redaction pii email phone ssn credit card regex builtin', sub:'red-setup'},
  {s:'redaction',    t:'Model Middleware',            k:'redaction model middleware transparent create wrap reversible', sub:'red-model-middleware'},
  {s:'redaction',    t:'Audit Auto-Redaction',        k:'redaction audit write path auto automatic strip pii', sub:'red-audit'},
  // Live Agents
  {s:'live-agents', t:'Provisioning a Mesh',           k:'live agent mesh provision role agentid heartbeat', sub:'la-mesh'},
  {s:'live-agents', t:'Heartbeat Supervisor',           k:'supervisor heartbeat tick interval workers live agent', sub:'la-supervisor'},
  {s:'live-agents', t:'State Store Backends',           k:'state store sqlite postgres redis mongodb dynamodb live agent', sub:'la-state-stores'},
  // Durability
  {s:'durability',  t:'Dead-Letter Queue',              k:'dlq dead letter queue failed operation retry recover', sub:'dur-dlq'},
  {s:'durability',  t:'Idempotency Keys',               k:'idempotency key duplicate prevent retry TTL', sub:'dur-idempotency'},
  {s:'durability',  t:'Retry Budget',                   k:'retry budget shared process hot path exhausted', sub:'dur-retry-budget'},
  {s:'durability',  t:'Health Checks',                  k:'health check liveness readiness probe status', sub:'dur-health'},
  // Persistence
  {s:'persistence', t:'RuntimePersistenceSlot',         k:'persistence slot sqlite kv runtime weavesqlitepersistence', sub:'pers-slot'},
  {s:'persistence', t:'Direct KV Access',               k:'kv key value get set delete list prefix persistence', sub:'pers-kv'},
  {s:'persistence', t:'Workflow Store Adapters',        k:'workflow checkpoint run repository sqlite postgres adapter', sub:'pers-adapters'},
  // Encryption
  {s:'encryption',  t:'Per-Tenant Field Encryption',    k:'encryption aes-256-gcm tenant field column key rotation', sub:'enc-setup'},
  {s:'encryption',  t:'Encrypted DB Proxy',             k:'proxy db column transparent encrypt decrypt', sub:'enc-proxy'},
  {s:'encryption',  t:'Blind Indexes',                  k:'blind index hmac equality search encrypted column', sub:'enc-blind-index'},
  // Security
  {s:'security',  t:'Hardened Egress — SSRF Protection',k:'ssrf fetch hardened egress url validation metadata private network redirect', sub:'sec-egress'},
  {s:'security',  t:'TLS Floor',                        k:'tls ssl certificate verification node tls reject unauthorized', sub:'sec-tls'},
  {s:'security',  t:'Durable Audit Logger',             k:'audit logger durable persistence kv entry weaveaudit', sub:'sec-audit'},
  {s:'security',  t:'Auto-Redaction on Audit',          k:'redact pii email phone ssn audit write path automatic', sub:'sec-redaction'},
  {s:'security',  t:'Guardrails Slot',                  k:'guardrails check tool call output deny allow runtime slot', sub:'sec-guardrails'},
  {s:'security',  t:'Sandbox Egress Allowlist',         k:'sandbox network allowlist egress docker bridge none', sub:'sec-sandbox-egress'},
  {s:'security',  t:'Secret Resolution',                k:'secret resolver process.env vault kms api key runtime', sub:'sec-runtime-secrets'},
  // Retrieval (expanded)
  {s:'retrieval', t:'End-to-End RAG Agent',             k:'rag agent chunking embedding hybrid bm25 retrieval search', sub:'retrieval-e2e'},
  // Extraction
  {s:'extraction', t:'Schema-Driven Extraction',        k:'extract schema json llm structured repair confidence', sub:'extraction-schema'},
  {s:'extraction', t:'Batch Document Extraction',       k:'extraction batch documents parallel streaming concurrency', sub:'extraction-batch'},
  {s:'extraction', t:'Research → Extract → Store',      k:'extraction agent browser research end-to-end pipeline', sub:'extraction-e2e'},
  // OAuth
  {s:'oauth',     t:'OAuth Flow Setup',                 k:'oauth google calendar gmail dropbox pkce token refresh authorize', sub:'oauth-setup'},
  {s:'oauth',     t:'OAuth as Agent Tool',              k:'oauth agent tool check auth authorize token calendar', sub:'oauth-tool'},
  // Live Agents (expanded)
  {s:'live-agents', t:'DB-Backed Boot',                 k:'live agent db boot weaveLiveMeshFromDb weaveLiveAgentFromDb production', sub:'la-db-boot'},
  {s:'live-agents', t:'Full Production Setup',          k:'live agent full production mesh supervisor runtime boot', sub:'la-e2e'},
  {s:'live-agents', t:'Kaggle Competition Mesh',        k:'kaggle competition mesh nine agents playbook nlp vision time series discoverer strategist implementer parallel validator submitter observer leaderboard debrief', sub:'la-kaggle-mesh'},
  // Agents (expanded)
  {s:'agents', t:'Agent Strategy Settings',             k:'agent strategy settings hitl threshold max hops tool confirmation memory policy global tenant scope a2a reflect parallel', sub:'agent-strategy'},
  // A2A (expanded)
  {s:'a2a', t:'A2A Skills Taxonomy',                   k:'a2a skills taxonomy general chat supervisor computer use browser code execution document intelligence image voice data pipeline memory workflow research review hypothesis', sub:'a2a-skills'},
  {s:'a2a', t:'Handler Kinds for Live Agents',          k:'handler kind agentic react scripted deterministic template forward observer human approval external webhook', sub:'a2a-handler-kinds'},
  // Guardrails (expanded)
  {s:'guardrails', t:'Runtime Slot — Ambient Guardrails', k:'guardrails runtime slot ambient weaveruntime automatic every agent', sub:'guardrails-runtime'},
  {s:'guardrails', t:'EU AI Act Compliance Checks',    k:'eu ai act euaia transparency human oversight manipulation bias fairness article compliance', sub:'guardrails-2026'},
  {s:'guardrails', t:'AI Content & Agent Safety Checks', k:'guardrails aigc deepfake watermark hallucination agent safety pii injection hop limit irreversible tool scope ip data residency', sub:'guardrails-2026'},
  // Models (expanded)
  {s:'models', t:'Model Capability Flags',              k:'model capability supports thinking vision json computer use long context deprecated gemini 1.5 llama phi', sub:'models-providers'},
  // Core (expanded)
  {s:'core',      t:'weaveRuntime — The Composition Root', k:'weaveruntime runtime composition root options tracer secrets persistence', sub:'core-runtime'},
  {s:'core',      t:'RuntimeCapabilities Reference',    k:'runtime capabilities net egress audit persistence guardrails encryption', sub:'core-capabilities'},
  {s:'core',      t:'ExecutionContext',                  k:'context userid sessionid traceid metadata', sub:'core-context'},
  {s:'core',      t:'Tool Interfaces',                  k:'weavetool toolregistry toolschema execute parameters', sub:'core-tools'},
  {s:'core',      t:'EventBus',                         k:'eventbus events subscribe agent model call step', sub:'core-events'},
  {s:'core',      t:'AuditEntry Reference',             k:'audit entry fields action outcome resource details timestamp', sub:'core-audit'},
];

function openSearch() {
  document.getElementById('sOverlay').classList.add('open');
  setTimeout(function() { document.getElementById('sInput').focus(); }, 50);
}
function closeSO(e) {
  if (e && e.target !== document.getElementById('sOverlay')) return;
  document.getElementById('sOverlay').classList.remove('open');
  document.getElementById('sInput').value = '';
  document.getElementById('sResults').innerHTML = '';
}
document.addEventListener('keydown', function(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape') closeSO({ target: document.getElementById('sOverlay') });
});

function doSearch(q) {
  var lq = q.toLowerCase().trim();
  if (!lq) { document.getElementById('sResults').innerHTML = ''; return; }
  var hits = SEARCH_IDX.filter(function(i) {
    return i.t.toLowerCase().includes(lq) || i.k.includes(lq);
  }).slice(0, 10);

  document.getElementById('sResults').innerHTML = hits.length
    ? hits.map(function(h) {
        return '<div class="s-result" onclick="closeSO({target:document.getElementById(\'sOverlay\')});' +
          (h.sub ? 'navToSub(\'' + h.s + "','" + h.sub + '\')">' : 'nav(\'' + h.s + '\')">' ) +
          '<div class="sr-title">' + h.t + '</div>' +
          '<div class="sr-pkg">@weaveintel/' + h.s + '</div></div>';
      }).join('')
    : '<div class="s-empty">No results for "' + q + '"</div>';
}

// ── Init ─────────────────────────────────────────────────────────
nav('home', false);
</script>
</body>
</html>`;
}
