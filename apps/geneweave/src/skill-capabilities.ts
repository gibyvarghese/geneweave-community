// Skill capabilities — app-side wiring for the mid-2026 @weaveintel/skills 0.1.2 engine.
//
// The engine ships the *mechanism* (retrieval, composition, security gates); the app owns *policy*
// (which embedding model, what's on/off, what the catalogue is). This module is that policy layer.
// Everything here is opt-in and safe-by-default: if a model isn't available or a flag isn't set, the
// app behaves exactly as it did before (lexical skill matching, no gating changes).

import type { Model, ExecutionContext } from '@weaveintel/core';
import {
  hybridSkillRetriever,
  resolveSkillGraph,
  scanTextForInjection,
  importSkillMd,
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
  return process.env['WEAVE_SKILL_SEMANTIC'] === '1' || process.env['WEAVE_SKILL_SEMANTIC'] === 'true';
}

/**
 * Build a hybrid (keyword + meaning) retriever backed by the app's embedding model, or `undefined`
 * when semantic matching is off / no embedder is available (the caller then uses the lexical default).
 */
export function buildSkillRetriever(ctx: ExecutionContext): SkillRetriever | undefined {
  if (!semanticSkillMatchingEnabled()) return undefined;
  const embeddingModel = getActiveGuardrailEmbeddingModel();
  if (!embeddingModel) return undefined;
  const embed: SkillEmbedFn = async (texts) => {
    const res = await embeddingModel.embed(ctx, { input: [...texts] });
    return (res.embeddings ?? []) as number[][];
  };
  // fallbackToLexical (default true) means a transient embedding error degrades to keyword matching
  // rather than dropping skill selection entirely.
  return hybridSkillRetriever({ embed });
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

  const enriched: SkillDefinition[] = matches.map((m) => {
    const e = edges.get(m.skill.id);
    if (!e) return m.skill;
    return {
      ...m.skill,
      provides: parseArr(e.provides),
      requires: parseArr(e.requires),
      precondition: parseArr(e.precondition).length ? { requires: parseArr(e.precondition) } : undefined,
      composesWith: parseArr(e.composes_with),
      conflictsWith: parseArr(e.conflicts_with),
      trust: typeof e.trust === 'number' ? e.trust : m.skill.trust,
    } as SkillDefinition;
  });
  try {
    const plan = resolveSkillGraph(enriched, enriched);
    if (!plan.ordered.length) return [...matches];
    const rank = new Map(plan.ordered.map((s, i) => [s.id, i]));
    // Stable sort the original matches by their resolved dependency rank (unranked keep their place).
    return [...matches].sort((a, b) => (rank.get(a.skill.id) ?? 1e9) - (rank.get(b.skill.id) ?? 1e9));
  } catch { return [...matches]; }
}

// ── Phase 3: security — never trust unreviewed skill text ──────────────────────────────────────

export interface SkillThreatScan { readonly safe: boolean; readonly findings: readonly string[] }

/**
 * Scan an admin-supplied skill's text (name + description + instructions) for prompt-injection before
 * it's saved — a skill's guidance goes straight into the model's system prompt, so a hidden "ignore
 * your instructions…" here would hijack every future turn.
 */
export function scanSkillForThreats(parts: { name?: string; description?: string; instructions?: string }): SkillThreatScan {
  const text = [parts.name, parts.description, parts.instructions].filter(Boolean).join('\n');
  const scan = scanTextForInjection(text);
  return { safe: !scan.injection, findings: scan.findings };
}

/**
 * Import an external SKILL.md package: it always enters untrusted (tier T1) and is fully scanned.
 * Returns the parsed skill + the security assessment; the caller decides whether to accept it.
 */
export async function importExternalSkill(md: string) {
  return importSkillMd(md, { scan: {} });
}
