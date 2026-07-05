// Skill capabilities — app-side wiring for the mid-2026 @weaveintel/skills 0.1.2 engine.
//
// The engine ships the *mechanism* (retrieval, composition, security gates); the app owns *policy*
// (which embedding model, what's on/off, what the catalogue is). This module is that policy layer.
// Everything here is opt-in and safe-by-default: if a model isn't available or a flag isn't set, the
// app behaves exactly as it did before (lexical skill matching, no gating changes).

import type { ExecutionContext } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import {
  hybridSkillRetriever,
  resolveSkillGraph,
  scanTextForInjection,
  importSkillMd,
  defineSkill,
  type SkillRetriever,
  type SkillEmbedFn,
  type SkillDefinition,
} from '@weaveintel/skills';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';

// ── Phase 0: meaning-based skill retrieval ─────────────────────────────────────────────────────
//
// Opt-in: set WEAVE_SKILL_SEMANTIC=1 (or the tenant flag) to match skills by MEANING using the
// workspace's existing embedding model, so "tidy up my messy numbers" finds the data-analysis skill
// even though it shares no keywords. Falls back to lexical automatically if no embedder is configured.

export function semanticSkillMatchingEnabled(): boolean {
  // Default ON: whenever a workspace has an embedding model configured, match skills by meaning.
  // Safe because `buildSkillRetriever` returns undefined (→ lexical) when no embedder is available, so
  // this never breaks a workspace without embeddings. Set WEAVE_SKILL_SEMANTIC=0 to force lexical-only.
  const v = process.env['WEAVE_SKILL_SEMANTIC'];
  if (v === '0' || v === 'false') return false;
  return true;
}

// The retriever holds a cached embedding index that re-embeds only *changed* skill cards, so it must
// PERSIST across chat turns (rebuilding it every turn would re-embed the whole catalogue each time).
// Skill cards AND queries are GLOBAL text (the skill catalogue is not per-user), so we embed them with
// one stable system context rather than the per-request one — that keeps the cache alive AND avoids a
// concurrency race (a shared mutable request-ctx could attribute one user's embed call to another).
let cachedRetriever: SkillRetriever | undefined;
let cachedModel: unknown;
let systemCtx: ExecutionContext | undefined;

/**
 * A hybrid (keyword + meaning) retriever backed by the app's embedding model, or `undefined` when
 * semantic matching is off / no embedder is available (the caller then uses the lexical default).
 * Built once and reused across turns; rebuilt only if the embedding model instance changes.
 */
export function buildSkillRetriever(_ctx: ExecutionContext): SkillRetriever | undefined {
  if (!semanticSkillMatchingEnabled()) return undefined;
  const embeddingModel = getActiveGuardrailEmbeddingModel();
  if (!embeddingModel) return undefined;
  if (!cachedRetriever || cachedModel !== embeddingModel) {
    systemCtx = systemCtx ?? weaveContext({ userId: 'system:skill-retrieval' });
    const embed: SkillEmbedFn = async (texts) => {
      const res = await embeddingModel.embed(systemCtx!, { input: [...texts] });
      return (res.embeddings ?? []) as number[][];
    };
    // fallbackToLexical (default true) means a transient embedding error degrades to keyword matching
    // rather than dropping skill selection entirely.
    cachedRetriever = hybridSkillRetriever({ embed });
    cachedModel = embeddingModel;
  }
  return cachedRetriever;
}

// ── Phase 1: order a multi-skill turn by its dependencies ──────────────────────────────────────
//
// When several skills fire at once (e.g. "analyse this then write it up"), run them in dependency
// order: a skill that needs an earlier skill's output waits for it. The composition edges live in the
// skills table (m148 columns) but the package's row→skill mapper doesn't read them, so we augment the
// already-selected skills with their edges here, then let resolveSkillGraph order them.

// The composition columns ride along on the raw `skills` rows (listEnabledSkills does SELECT *),
// so we read them straight off those rows — no extra query, no schema coupling.
export interface SkillCompositionRow {
  id: string; provides?: string | null; requires?: string | null; precondition?: string | null;
  composes_with?: string | null; conflicts_with?: string | null; trust?: number | null;
}
const parseArr = (s: string | null | undefined): string[] => {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

/**
 * Reorder the selected skill matches so dependencies come first ("analyse" before "write up the
 * findings"). `rawRows` are the rows from `listEnabledSkills()` (they carry the composition columns).
 * If no selected skill declares any edges, the input order is returned unchanged — always safe.
 */
export function orderSkillMatchesByComposition<T extends { skill: SkillDefinition }>(
  rawRows: readonly SkillCompositionRow[],
  matches: readonly T[],
): T[] {
  if (matches.length < 2) return [...matches];
  const edges = new Map(rawRows.map((r) => [r.id, r]));
  const hasEdges = matches.some((m) => {
    const e = edges.get(m.skill.id);
    return e && (parseArr(e.provides).length || parseArr(e.requires).length || parseArr(e.precondition).length);
  });
  if (!hasEdges) return [...matches];

  const enrich = (base: SkillDefinition, e: SkillCompositionRow | undefined): SkillDefinition => e ? ({
    ...base,
    provides: parseArr(e.provides),
    requires: parseArr(e.requires),
    precondition: parseArr(e.precondition).length ? { requires: parseArr(e.precondition) } : undefined,
    composesWith: parseArr(e.composes_with),
    conflictsWith: parseArr(e.conflicts_with),
    trust: typeof e.trust === 'number' ? e.trust : base.trust,
  } as SkillDefinition) : base;

  const selectedDefs = matches.map((m) => enrich(m.skill, edges.get(m.skill.id)));
  // Build the FULL enabled catalogue (a lightweight def per row) as the resolution universe, so a
  // `requires` that points at a skill NOT co-selected still resolves — instead of dropping the selected
  // skill to the back for a reason unrelated to its relevance.
  const bySelected = new Map(matches.map((m) => [m.skill.id, m.skill]));
  const catalog: SkillDefinition[] = rawRows.map((r) => {
    const sel = bySelected.get(r.id);
    return sel ? enrich(sel, r) : enrich(defineSkill({ id: r.id, name: r.id, summary: r.id }), r);
  });

  try {
    const plan = resolveSkillGraph(selectedDefs, catalog);
    if (!plan.ordered.length) return [...matches];
    const rank = new Map(plan.ordered.map((s, i) => [s.id, i]));
    const origIndex = new Map(matches.map((m, i) => [m.skill.id, i]));
    const BIG = plan.ordered.length + 1;
    // Ranked skills lead in dependency order; any that fell out keep their ORIGINAL relative order.
    const key = (id: string) => rank.get(id) ?? BIG + (origIndex.get(id) ?? 0);
    return [...matches].sort((a, b) => key(a.skill.id) - key(b.skill.id));
  } catch { return [...matches]; }
}

// ── Phase 3: security — never trust unreviewed skill text ──────────────────────────────────────

export interface SkillThreatScan {
  readonly safe: boolean;
  /** True for signals that are NEVER legitimate (hidden/invisible characters) → always block. */
  readonly hardBlock: boolean;
  readonly findings: readonly string[];
}

/**
 * Scan an admin-supplied skill's text (name + description + instructions) for prompt-injection before
 * it's saved — a skill's guidance goes straight into the model's system prompt, so a hidden "ignore
 * your instructions…" here would hijack every future turn.
 *
 * Two tiers: hidden/invisible characters are never legitimate (`hardBlock`), while an instructional
 * *phrase* ("ignore previous instructions") can appear as subject matter in a genuine security/red-team
 * skill — so the caller may allow those on explicit acknowledgement rather than blocking outright.
 */
export function scanSkillForThreats(parts: { name?: string; description?: string; instructions?: string }): SkillThreatScan {
  const text = [parts.name, parts.description, parts.instructions].filter(Boolean).join('\n');
  const scan = scanTextForInjection(text);
  const hardBlock = scan.findings.some((f) => /invisible|hidden/i.test(f));
  return { safe: !scan.injection, hardBlock, findings: scan.findings };
}

/**
 * Import an external SKILL.md package: it always enters untrusted (tier T1) and is fully scanned.
 * Returns the parsed skill + the security assessment; the caller decides whether to accept it.
 */
export async function importExternalSkill(md: string) {
  return importSkillMd(md, { scan: {} });
}
