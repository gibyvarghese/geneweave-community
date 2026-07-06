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
parity with SQLite: chat & skills (`users`, `chats`, `messages`, `skills`), plus `cost`, `capabilities`,
`voice`, `workflows`, `scopes`, `agents`, `prompts`, `tools`, `routing`, `memory`, `encryption`,
`agenda/notes`, `kaggle`, and `live-agents` — with only the admin console and current-user (`me`) areas
still in progress. Areas not yet ported raise a clear error the instant they're
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

## License

MIT — see [LICENSE](./LICENSE).
