# Hypothesis Validation Feature

Multi-agent scientific hypothesis validation pipeline for the **weaveIntel** platform.

Accepts a natural-language hypothesis, decomposes it into testable sub-claims, orchestrates a panel of seven specialist AI agents to gather, analyse, and challenge evidence, and emits a structured, evidence-backed verdict.

---

## Architecture

```
POST /api/sv/hypotheses
          │
          ▼
  SVWorkflowRunner.startRun()
          │
   WorkflowEngine (sv-workflow-v1)
          │
   ┌──────┴──────────────────────────────────────┐
   │  decompose → gather → analyse* → falsify    │
   │                         ├── statistical     │
   │                         ├── mathematical    │
   │                         └── simulation      │
   │              → deliberate → verdict         │
   └─────────────────────────────────────────────┘
          │
   SvVerdictRow + SvEvidenceEventRow[] + SvAgentTurnRow[]
          │
   GET /api/sv/hypotheses/:id
   GET /api/sv/verdicts/:id/bundle
```

### Agent Roster

| Key | Role | Model tier |
|---|---|---|
| `decomposer` | Breaks the hypothesis into typed sub-claims (mechanism/epidemiological/mathematical/dose_response/causal) | reasoning |
| `literature` | Searches arXiv, PubMed, Semantic Scholar, OpenAlex for primary evidence | tool-use |
| `statistical` | Runs meta-analysis, power calculations, and statistical model tests | tool-use |
| `mathematical` | Applies symbolic maths (SymPy, Wolfram) to verify formulae and derive implications | tool-use |
| `simulation` | Runs Monte Carlo and agent-based simulations via SciPy / PyMC containers | tool-use |
| `adversarial` | Attempts to falsify the hypothesis; identifies confounders and alternative explanations | reasoning |
| `supervisor` | Synthesises all evidence and emits the final structured verdict JSON | reasoning |

### Workflow Steps (sv-workflow-v1)

| Step | Handler | Timeout |
|---|---|---|
| `decompose` | `decomposer` agent | 60 s |
| `gather` | `literature` agent | 120 s |
| `analyse` (fan-out) | `statistical` + `mathematical` + `simulation` agents in parallel | 180 s |
| `falsify` | `adversarial` agent | 120 s |
| `deliberate` | convergence loop (max 3 rounds, ε = 0.15) | 600 s |
| `verdict` | `supervisor` agent → writes `hv_verdict` row | 60 s |

---

## DB Tables

| Table | Purpose |
|---|---|
| `hv_hypothesis` | One row per submitted hypothesis; UUID PK |
| `hv_sub_claim` | Decomposed sub-claims; UUID PK |
| `hv_verdict` | Final verdict; UUID PK |
| `hv_evidence_event` | Evidence records emitted per agent/step; UUID PK |
| `hv_agent_turn` | Inter-agent dialogue messages; UUID PK |
| `hv_budget_envelope` | Cost/token/time budget envelope; UUID PK |

All primary keys use UUID v7 (sortable) via `newUUIDv7()`.

---

## API Routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sv/hypotheses` | Submit hypothesis → `{ id, status: 'queued', traceId, contractId }` |
| `GET` | `/api/sv/hypotheses/:id` | Fetch hypothesis + verdict (if complete) |
| `POST` | `/api/sv/hypotheses/:id/cancel` | Cancel in-progress run → `{ id, status: 'abandoned' }` |
| `POST` | `/api/sv/hypotheses/:id/reproduce` | Reproduce with same inputs → `{ id, originalId, status: 'queued' }` |
| `GET` | `/api/sv/verdicts/:id/bundle` | Download full evidence bundle (JSON) |
| `GET` | `/api/sv/hypotheses/:id/events` | SSE stream of evidence events |
| `GET` | `/api/sv/hypotheses/:id/turns` | SSE stream of agent dialogue turns |

---

## Verdict Labels

| Label | Meaning |
|---|---|
| `supported` | Evidence strongly supports the hypothesis |
| `refuted` | Evidence actively contradicts the hypothesis |
| `inconclusive` | Evidence too sparse, mixed, or hypothesis not testable |

---

## Tool Groups

### Evidence (18 tools total)
- **Literature search**: `arxiv.search`, `pubmed.search`, `semanticscholar.search`, `openalex.search`, `crossref.resolve`, `europepmc.search`
- **Statistical**: `scipy.stats.test`, `statsmodels.meta`, `scipy.power`, `pymc.mcmc`, `r.metafor`
- **Symbolic / Mathematical**: `sympy.simplify`, `sympy.solve`, `sympy.integrate`, `wolfram.query`
- **Domain**: `rdkit.descriptors`, `biopython.align`, `networkx.analyse`

All containerised tools require `FAKE_CONTAINER_RUNTIME=1` to be unset (or explicitly `0`) in production. Set `FAKE_CONTAINER_RUNTIME=1` for local dev and CI.

---

## Recipe Config

The feature registers itself as a DB-backed recipe via `recipe.ts` → `seedSVRecipe(db)`.

```
recipe_type:  'scientific-validation'
recipe id:    f1e2d3c4-b5a6-7890-a1b2-c3d4e5f60001
options:
  workflowId:                  sv-workflow-v1
  agents:                      [decomposer, literature, statistical,
                                mathematical, simulation, adversarial, supervisor]
  maxRounds:                   3
  epsilonConfidenceThreshold:  0.15
  budgetEnvelope:              { maxTokens: 500000, maxCostUsd: 5.0, maxWallMs: 900000 }
```

---

## Extending the Eval Corpus

The eval corpus lives at `evals/corpus.json` (20 curated hypotheses).

To add a case:
1. Append a JSON object to `evals/corpus.json`:
   ```json
   {
     "id": "corpus-<n>",
     "statement": "...",
     "expectedVerdict": "supported | refuted | inconclusive | needs_revision",
     "category": "known-true | known-false | ill-posed | p-hacked",
     "domainTags": ["..."]
   }
   ```
2. Run `npx ts-node evals/run-corpus.ts` to execute the full corpus and see pass/fail by category.
3. Target accuracy: ≥ 85% on `known-true`, `known-false`, and `p-hacked` categories.

---

## Files

```
features/scientific-validation/
├── index.ts            — public exports
├── recipe.ts           — DB recipe config + seedSVRecipe()
├── runner.ts           — SVWorkflowRunner — orchestrates all 7 handlers
├── sv-seed.ts          — Seeds SV agent system prompts + worker rows into DB
├── workflow.ts         — defineWorkflow('scientific-validation') definition
├── sv-workflow.test.ts — Workflow integration tests (weaveFakeModel + in-memory DB)
├── agents/
│   └── index.ts        — 7 agent factory functions
├── routes/
│   ├── index.ts        — registerSVRoutes() — mounts all HTTP + SSE handlers
│   └── sv-routes.test.ts — Route-level unit tests
├── tools/
│   ├── index.ts        — createSVToolMap() — all 18 SV tools
│   ├── evidence.ts     — Literature search tools
│   ├── numerical.ts    — Stats tools (SciPy/PyMC/R via container)
│   ├── symbolic.ts     — Symbolic maths tools (SymPy/Wolfram via container)
│   ├── domain.ts       — Domain tools (RDKit/BioPython/NetworkX via container)
│   └── image-policy.ts — Container image digest verification
├── ui/
│   ├── index.ts        — UI view exports barrel
│   ├── sv-submit-view.ts   — Hypothesis submission form
│   ├── sv-live-view.ts     — SSE deliberation stream display
│   └── sv-verdict-view.ts  — Final verdict + evidence bundle view
└── evals/
    ├── corpus.json         — 20 curated evaluation hypotheses
    └── run-corpus.ts       — CLI corpus runner
```

---

## Local Development

```sh
# Run workflow integration tests only
npx vitest run apps/geneweave/src/features/scientific-validation/sv-workflow.test.ts

# Run all SV route tests
npx vitest run apps/geneweave/src/features/scientific-validation/routes/sv-routes.test.ts

# Run full eval corpus (requires real API keys)
OPENAI_API_KEY=sk-... npx ts-node evals/run-corpus.ts

# Use fake container runtime (no Docker required)
FAKE_CONTAINER_RUNTIME=1 npx vitest run
```
