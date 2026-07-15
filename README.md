# geneWeave — community edition

geneWeave is an open-source **AI assistant workspace** you can run yourself. You sign in, chat with an
assistant that can **run code, browse the web, remember things about you, and use tools**, and you
configure how it all behaves from a built-in **admin console** — no code required.

It's built on the [weaveIntel](https://github.com/gibyvarghese/weaveintel) framework, which it consumes
as published `@weaveintel/*` npm packages (there is no framework source in this repo). Bring your own
model API key (OpenAI, Anthropic, or Google) and you have a working product in a couple of minutes.

<p align="center"><img src="docs/screenshots/02-chat-answer.png" alt="geneWeave chat" width="900"></p>

---

## Quick start

Requires **Node 20+**. You'll need at least one model provider API key.

```bash
git clone https://github.com/gibyvarghese/geneweave-community.git
cd geneweave-community

npm install          # pulls @weaveintel/* from the npm registry
npm run build

cp .env.example .env # then edit .env (see below)
npm start            # → http://localhost:3500
```

Minimum `.env` to get running:

```bash
PORT=3500
JWT_SECRET=            # any long random string:  openssl rand -hex 32
OPENAI_API_KEY=        # or ANTHROPIC_API_KEY / GOOGLE_API_KEY
GENEWEAVE_DEFAULT_PROVIDER=openai
GENEWEAVE_DEFAULT_MODEL=gpt-4o

# First-run admin so you have someone to sign in as (created once, on first boot):
GENEWEAVE_ADMIN_EMAIL=admin@example.com
GENEWEAVE_ADMIN_PASSWORD=change-me-please
```

Open **http://localhost:3500** and sign in with the admin email/password you set. That account is a
platform admin, so it can reach the **Admin** and **Builder** areas where everything is configured.

<p align="center"><img src="docs/screenshots/01-login.png" alt="Sign in" width="520"></p>

> **Tip — run a throwaway test instance on another port:** set `PORT=3600` and
> `DB_PATH=/tmp/geneweave-test.db`, keep `NODE_ENV=development`, and `npm start`. It's a self-contained
> SQLite database you can delete anytime.

---

## What you can do (and where to configure it)

Everything below is configured from the **Admin** console in the left sidebar. Each capability lives
under a labelled section of the admin menu — the path is given as **Admin → Section → Page**.

<p align="center"><img src="docs/screenshots/03-admin-overview.png" alt="Admin console" width="900"></p>

### 💬 Chat with an assistant
Sign in and just type. Ask a question and you get an answer with the **model used, token count, cost,
and latency** shown under each reply (see the first screenshot). Switch a conversation between **Direct**
(plain chat), **Agent** (can use tools), and **Supervisor** (can delegate to worker agents) modes.

Try:
> *"In one sentence, what's the capital of France? Then share a fun fact about it."*

### 🧠 Pick the right model automatically (LLM routing)
geneWeave routes each message to a model by a **policy** (cheapest, best-quality, balanced, local-first,
…). Change the active policy's strategy or weights and the routed model changes — e.g. flipping the
default policy to *cost* routes simple chats to a cheap fast model instead of an expensive reasoning one.

**Configure:** Admin → **Routing** → **Routing** (policies), plus **Routing Simulator** to preview which
model a prompt would pick before you commit.

### 🛡️ Guardrails (safe, sensible defaults out of the box)
geneWeave ships a large safety library. By default the **deterministic** guards are on — PII redaction,
prompt-injection filters, credential/SSRF blocking, content moderation, token budgets — while the
heavier **LLM-judge** guards (reasoning judges, hallucination/factuality, cognitive checks) are **off by
default** so a fresh install is fast and doesn't second-guess correct answers. Turn any of them on with a
click, or set `GENEWEAVE_ENABLE_LLM_JUDGES=1` to enable them all on a fresh database. The LLM judges use
a capable model by default (`GUARDRAIL_JUDGE_MODEL`, default `gpt-4o`) so their verdicts are reliable.

**Configure:** Admin → **Governance** → **Guardrails**. The `Enabled` column shows the lean default —
`regex`/deterministic guards on, `model-graded` judges off:

<p align="center"><img src="docs/screenshots/04-guardrails.png" alt="Guardrails admin — lean default" width="900"></p>

### 🐍 Run code (CSE)
In **Agent** mode the assistant can execute real code in an isolated Docker container and use the result.
Ask it to compute something and it writes + runs Python for you (requires Docker running).

Try (Agent mode):
> *"What is the sum of the squares of the numbers 1 through 10? Work it out in Python."*
> → it runs the code in a container and answers **385**.

**Configure:** Admin → **Integrations** → **Tool Catalog** / **Tool Policies** (the `cse_*` tools).

### 🌐 Browse the web
In **Agent** mode the assistant has a real headless browser and will open pages, read them, and answer
from what it saw.

Try (Agent mode):
> *"Open https://example.com and tell me the exact main heading on the page."*
> → it navigates the page and reports **"Example Domain"**.

**Configure:** Admin → **Integrations** → **Tool Catalog** (the `browser_*` tools).

### 🧩 Memory (it remembers you across chats)
Tell the assistant something about yourself in one conversation and it recalls it in a brand-new one.

Try (Agent mode), then start a **new chat** and ask:
> *"Remember that my favourite language is Rust and I work on embedded systems."* … *"Based on what you
> know about me, what's my favourite language and field?"* → *"Rust … embedded systems."*

**Configure:** Admin → **Governance** → **Memory Settings** / **Semantic Memory** / **Episodic Memory**.

### 🤝 Agents & delegation
Supervisor mode can break a task down and delegate to worker agents. Define and tune those agents,
including live/background ones.

**Configure:** Admin → **Live Agents** → **Supervisor Agents** / **Worker Agents**.

### 🧰 Tools & 📝 prompts & 💵 cost
- **Tools:** register/gate/audit every tool the assistant can call — Admin → **Integrations** → **Tool
  Catalog**, **Tool Policies**, **Tool Audit**, **Tool Approvals**.
- **Prompts:** a versioned prompt library with experiments and evals — Admin → **Prompt Studio** →
  **Prompts** (shown in the admin screenshot above).
- **Cost:** budgets and per-task spend — Admin → **Monitoring** → **Cost Policies** / **Cost by Task**.

### 🏗️ Builder
The **Builder** area gives every one of these a friendly structured editor (instead of raw tables), with
live On/Off toggles and validation:

<p align="center"><img src="docs/screenshots/05-builder.png" alt="Builder" width="900"></p>

### 🏢 Per-tenant customization (the Tenancy Realm)
Everything above — prompts, skills, guardrails, model-routing rules, cost budgets, tool policies, output
contracts, prompt strategies — ships as one shared **global default** that every workspace uses. If you run
geneWeave for **multiple tenants** (customers / workspaces / orgs), any one tenant can keep its **own copy**
of any of these and tweak it, **without affecting anyone else** — and without you maintaining a separate
config per customer.

Think of it like a shared document template each team can *make a copy of* and edit for itself. A team that
never copies it keeps getting the latest template automatically; a team that copies it keeps *their* version.
The rule for who gets what is **nearest-owner-wins**: your own tenant's copy beats a parent org's shared
copy, which beats the global default. A copy is never visible to another tenant.

```bash
# Give tenant "acme" its own stricter copy of the built-in "PII Redaction" guardrail
# (same shape for /prompt-strategies, /tool-policies, /routing, /cost-policies, /skills, ...):
curl -X POST /api/admin/guardrails/GLOBAL_ID/customize \
  -H 'content-type: application/json' -H 'x-csrf-token: ...' \
  -d '{ "tenantId": "acme", "config": { "threshold": 0.95 } }'

curl '/api/admin/guardrails/GLOBAL_ID/realm?tenantId=acme'      # who acme gets + provenance
curl -X DELETE '/api/admin/guardrails/GLOBAL_ID/customize?tenantId=acme'   # revert to the global
```

- **Safe updates:** ship a new built-in default and tenants who didn't customise it get the update; those
  who did keep their edit (flagged for review). A per-tenant **state overlay** can disable or reprioritise a
  shared built-in for one tenant without copying it.
- **Org tree:** a parent org can customise once and have child tenants inherit it; a great tenant tweak can
  be **promoted** up to become the new global default for everyone.
- **More settings inherit down the org tree too:** three per-tenant knobs that used to be a flat "this
  tenant's row, else the global one" now inherit the same nearest-owner-wins way — a parent org sets them
  once and children inherit unless they set their own: **model-routing weight overrides** (cost vs. speed
  vs. quality per task), **model capability scores** (a tenant's tuned quality score for a model + task),
  and **weaveNotes AI-action modes** (whether "turn this into a diagram", freehand ink, restructure, etc.
  runs directly, hands off to an agent, or goes through a supervisor). Set nothing → everyone keeps the
  shared default, exactly as before.
- **Provenance:** every run records which tenant's fork produced its system prompt, so "which config
  produced this output, for this tenant?" is answerable.

Resolution runs **byte-for-byte identically on SQLite and Postgres** (built on the open-source
`@weaveintel/realm` engine). **Configure:** Admin → the relevant area (Governance / Prompts / Routing / Cost)
→ the row's **Customize** action.

**Referential integrity:** `users.tenant_id` is a real foreign key to the `tenants` table (enforced on
both engines), so a user can never be assigned to a tenant that doesn't exist — a bad assignment is
rejected at write time rather than stored as a dangling reference. Deleting a tenant falls its users back
to the global scope (`ON DELETE SET NULL`) instead of deleting them.

#### Governing the shared defaults

Changing what *one* tenant sees is safe — a copy only affects its owner. Changing the **global default**
changes what *every* tenant sees, so those actions are **platform-admin only** and go through review.

- **Propose, then review.** A tenant admin who improves their copy can *propose* it as the new global
  default. Nothing changes yet: it lands in a queue, and only a platform admin may approve (which performs
  the promote) or reject. Re-proposing the same copy updates the open proposal rather than stacking
  duplicates, and a failed promote leaves it `pending` instead of falsely reading as approved.
  ```bash
  curl -X POST /api/admin/realm/proposals \
    -d '{ "family": "guardrails", "forkId": "FORK_ID", "note": "catches more PII" }'
  curl '/api/admin/realm/proposals?status=pending'      # the review queue
  curl -X POST /api/admin/realm/proposals/ID/approve    # platform admin → promotes it
  ```
- **Pin a version.** A tenant can pin a shared default to a specific published version — "keep giving me
  v3 of the support prompt even after v4 ships" — *without* copying it. Runs then serve v3's exact
  historical text. A pin to a version that never existed is ignored, so a stale pin can never take the
  assistant offline. (A tenant's own copy already opts out of upstream changes, so a copy beats a pin.)
- **Deprecate a default.** Retire a built-in without breaking anyone: tenants already using it keep
  resolving it, but it can gain **no new customisations**, and it can name its replacement.
  ```bash
  curl -X POST /api/admin/realm/prompts/GLOBAL_ID/deprecate \
    -d '{ "note": "superseded", "supersededById": "NEW_ID" }'
  ```
- **Customize, don't duplicate.** If you can already *see* a record under a key (a global, or a parent
  org's shared copy), creating a second one under that key is refused with a `409` naming the record to
  customize instead — so one key never has two competing definitions.
- **Reparent a tenant.** Moving a tenant under a new parent changes its lineage, and therefore everything
  it *inherits*. The move is cycle-safe, reports the whole affected subtree, and flushes tenant-keyed caches.
  ```bash
  curl -X POST /api/admin/tenants/emea/reparent -d '{ "newParentTenantId": "apac" }'
  # → { ok, from: {...}, to: {...}, affectedTenantIds: ["emea", "uk"] }
  ```

Every family — prompts, prompt fragments, skills, worker agents, guardrails, tool policies, routing and
cost policies, and the prompt catalog — supports `customize`, `revert`, `propose`, and `deprecate` through
the same shaped endpoints.

#### Resolving a diverged record (the diff/merge workbench)

Most drift resolves itself: a record nobody edited adopts the new default, one only you edited keeps your
edit. Only **`diverged`** — you changed it *and* upstream changed it — needs a person. That gets a real
**three-way merge**, like git, applied to config: **BASE** (what you originally copied, recovered from the
version log), **LOCAL** (what you have now) and **REMOTE** (the latest default).

Each field is judged on its own — only you touched it → keep yours; only upstream → take theirs; both made
the same change → no conflict; both changed it differently → a **conflict** you resolve.

```bash
curl '/api/admin/realm/prompts/drift'                  # what drifted, and how
curl '/api/admin/realm/prompts/RECORD_ID/diff'         # BASE / LOCAL / REMOTE, field by field
curl -X POST '/api/admin/realm/prompts/RECORD_ID/merge' \
  -d '{ "resolved": { "description": "the wording we agreed on" } }'
# → { ok: true, drift: "customized" }   # re-baselined; never "diverged" again
```

A merge is **refused while any conflict is unresolved** — silently picking a side is exactly the failure a
merge tool exists to prevent. If the version you copied from was never published there is no BASE, so the
workbench says so (`baseAvailable: false`) instead of guessing who moved.

#### Guardrail posture per tenant

Every guardrail is always **installed**; which ones *run* for a tenant is a setting, not an accident of how
the database was first created. The **lean profile** switches off the model-graded checks (an extra LLM call
per turn) for one tenant, and **never** a safety control — PII redaction, content filters, injection
detectors, budgets and escalation policies are protected and reported back as such.

```bash
curl -X POST '/api/admin/realm/guardrails/profile/lean?tenantId=acme'
# → { disabled: ["Hallucination Check", ...], protected: ["PII Redaction", ...] }
curl -X DELETE '/api/admin/realm/guardrails/profile/lean?tenantId=acme'   # back to the shared posture
```

Underneath it's the state overlay, which can only ever **subtract**: a tenant can never turn *on* a
guardrail the platform has disabled globally.

#### The workbench (admin UI)

All of the above is a screen, not just an API. **Admin → Governance → Tenancy Realm** opens a workbench:

- **Drift & merge** — load a family's drift; every record shows a colour-coded state badge; click a
  `diverged` row and the three-way merge (Base / Yours / Upstream) opens inline, field by field. The
  **Apply merge** button stays disabled until every conflict has a resolved value — it won't merge by
  guessing.
- **State overlay** — turn a shared record off for a tenant, set priority, or pin a version; guardrails
  get a one-click **lean posture**.
- **Share & reach** — preview a fork's blast radius (who inherits, who's shadowed, who's out of scope)
  before you apply a share mode.

Provenance is visible in place too: any admin list with a **realm** column badges each row — grey for a
global default, blue for a tenant's own copy, **amber for a copy shared down the org tree**, red for a
deprecated one.

### Staying up to date across releases

geneWeave ships built-in defaults — prompts, skills, guardrails, routing/cost policies, and the rest. When
you upgrade to a newer release, some of those defaults change. geneWeave reconciles them the way a good
package manager handles a config file you edited: it never clobbers your edits, and never leaves you stuck
on an old default. On startup, for every built-in it compares three things — what it shipped last time,
what's in your database now, and what this release wants to ship — and:

- a default **you never touched** that the release improved is **adopted automatically**;
- a default **you customised** is **kept** and flagged, never overwritten;
- one where **both** changed is **kept** and surfaced for you to merge (the same three-way merge workbench
  above);
- brand-new defaults are added, and a built-in that's been retired is flagged, never silently deleted.

Every one of these outcomes is recorded, so after an upgrade you can see exactly what was adopted, what was
kept because you'd customised it, and what needs a look — ordered by priority (safety-critical items like
guardrails first). Schema migrations are tracked in a ledger so each one runs once and only once, and the
database is snapshotted before an upgrade touches it so a failed upgrade rolls back cleanly. None of this
needs configuration — it's simply how startup works. Set `GENEWEAVE_ENABLE_LLM_JUDGES=1` and the other
documented flags as usual; the reconcile respects your choices.

Beyond the startup reconcile, the engine can discover + cryptographically verify releases, apply them across
package/code/schema/data layers with auto-rollback, **automate** the safe parts of the review queue with rules,
**propagate** triage decisions between instances as signed bundles, and **prune** its version-log history
(always keeping the head, anything a live record references, and every tenant-pinned version). Telemetry is
local and opt-out. See [`docs/UPGRADE_ENGINE.md`](docs/UPGRADE_ENGINE.md) for the full model,
[`docs/RUNBOOKS.md`](docs/RUNBOOKS.md) for operator/publisher/private-edition procedures, and
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the update-security threat model.

geneWeave follows **Semantic Versioning** with a fabric codename on majors, and both editions share the same
version line — see [`VERSIONING.md`](VERSIONING.md). Those Major/Minor/Patch meanings are exactly what the Upgrade
Center's bump badge and anti-rollback use.

---

## Configuration reference

All settings are stored in the database and editable from the admin console; the environment variables
below set the initial defaults (full list in [`.env.example`](./.env.example)).

| What | Where to configure | Env default |
|---|---|---|
| Provider + default model | Admin → Routing → Routing | `OPENAI_API_KEY`, `GENEWEAVE_DEFAULT_PROVIDER/MODEL` |
| First admin | created on first boot | `GENEWEAVE_ADMIN_EMAIL/PASSWORD` |
| Guardrails | Admin → Governance → Guardrails | `GENEWEAVE_ENABLE_LLM_JUDGES`, `GUARDRAIL_JUDGE_MODEL` |
| Tools (code, browser, …) | Admin → Integrations → Tool Catalog / Policies | — |
| Memory | Admin → Governance → Memory Settings | — |
| Agents | Admin → Live Agents → Supervisor / Worker Agents | — |
| Cost budgets | Admin → Monitoring → Cost Policies | — |
| Sign-in token secret | — | `JWT_SECRET` |
| Database | SQLite (default) or Postgres — see [Running on Postgres](#running-on-postgres) | `WEAVE_DB`, `DATABASE_URL`, `WEAVE_DB_PATH` |
| Release updates | trusted publisher keys + repo | `GENEWEAVE_UPGRADE_REPO`, `GENEWEAVE_UPGRADE_TRUSTED_KEYS`, `GENEWEAVE_EDITION` |
| Resolution-bundle signing / trust | publisher/fleet keys | `GENEWEAVE_UPGRADE_SIGNING_KEY(_CREDENTIAL_ID)`, `GENEWEAVE_UPGRADE_BUNDLE_TRUSTED_KEYS` |
| Telemetry (local, opt-out) | — | `GENEWEAVE_TELEMETRY=0` / `DO_NOT_TRACK=1`; `OTEL_EXPORTER_OTLP_ENDPOINT` |

> **Note:** guardrail changes are applied when the server starts, so restart after toggling judges on/off.

### Running on Postgres

geneWeave stores your data (users, chats, messages, skills, …) in a single **SQLite** file by default —
nothing to install, ideal for local use and small deployments. When you need a real server database
(many concurrent writers, a database on its own host, backups, or embeddings living next to your data),
switch to **Postgres** by setting two environment variables — no code changes:

```bash
export WEAVE_DB=postgres
export DATABASE_URL="postgres://user:password@localhost:5432/geneweave"
# Leaving WEAVE_DB unset keeps SQLite (optionally at WEAVE_DB_PATH).
```

**Same answers on both.** SQLite and Postgres sort text and store flags/dates differently; the Postgres
adapter is pinned so a row reads back identically on either (byte-order sorting, integer on/off flags,
matching timestamp format). A parity test suite runs the same operations against both — plus a real
Postgres instance and a real-LLM round-trip — and checks the results match.

**What runs on Postgres today.** On Postgres, geneWeave creates the **entire** database schema (all
tables, generated from the SQLite schema and validated against real Postgres). Areas implemented at full
parity with SQLite: **every area** — `users`, `chats`, `messages`, `skills`, `cost`, `capabilities`,
`voice`, `workflows`, `scopes`, `agents`, `prompts`, `tools`, `routing`, `memory`, `encryption`,
`agenda/notes`, `kaggle`, `live-agents`, the admin console, and current-user (`me`) context. The only
piece still SQLite-only is first-run **default-data seeding** (demo skills/agents/routing policies).
Anything not yet ported raises a clear error the instant they're
used (never a silent wrong answer), so it's always obvious what's ready. For complete coverage today, stay
on SQLite; the rest lands incrementally. With the `pgvector` extension, embeddings can live in the same
Postgres as everything else — no separate vector database.

---

## Layout & relationship to the framework

```
apps/
  geneweave/       the API + server (chat, notes, agents, tools, admin)
  geneweave-ui/    the browser UI + the geneWeave brand (design tokens, themes)
clients/
  mobile/          React Native app
  desktop/         Tauri desktop app
start.mjs          the launcher (loads .env, boots the server, bootstraps the first admin)
```

geneWeave is the reference product for weaveIntel — a real-world example of how the framework's pieces
(model providers, agents, tools, retrieval, guardrails, memory, collaboration) come together. When the
framework releases a new version on npm, bump the `@weaveintel/*` versions here and re-run
`npm run build && npm test`. For the framework's own docs and package guide, see the
[weaveIntel repository](https://github.com/gibyvarghese/weaveintel).

## Versioning

geneWeave is versioned as **one product** with **Semantic Versioning** and a fabric codename on each major;
both editions (community + private) ship the **same version line** — currently **1.0.0 "Aertex"**. A CI guard
(the **Product version** workflow) keeps the version, its codename, [`VERSIONING.md`](VERSIONING.md), and
[`CHANGELOG.md`](CHANGELOG.md) consistent. The `@weaveintel/*` framework libraries version independently on their
own track. Full details: [`VERSIONING.md`](VERSIONING.md).

## License

MIT — see [LICENSE](./LICENSE).
