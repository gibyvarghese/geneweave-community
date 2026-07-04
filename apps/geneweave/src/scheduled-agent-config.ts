// SPDX-License-Identifier: MIT
/**
 * geneWeave (weaveNotes) — SCHEDULED / TRIGGERED WORKSPACE AGENTS: the product config + recipes.
 *
 * A scheduled agent is a recurring, multi-step AI task over your OWN notes — "every weekday at 8am,
 * summarise the notes I touched yesterday into a digest", "weekly, suggest wiki-links between related
 * notes", "flag notes I haven't opened in 60 days". It runs unattended, but anything that WRITES is
 * staged as a reviewable suggestion the human approves (never a silent overwrite), inside a hard BUDGET.
 *
 * This module owns the weaveNotes-specific pieces: the typed config, the note task RECIPES, and the
 * validator. The GENERIC primitives it builds on — the cron schedule evaluator and the run budget —
 * live in the framework (`@weaveintel/triggers`) and are reused here.
 */
import { isValidCron, isValidTimezone } from '@weaveintel/triggers';

/** The built-in task recipes (each a useful, bounded multi-step note task). `custom` = free-form prompt. */
export type ScheduleRecipe = 'daily_digest' | 'link_suggester' | 'action_items' | 'stale_flagger' | 'custom';
export const SCHEDULE_RECIPES: readonly ScheduleRecipe[] = ['daily_digest', 'link_suggester', 'action_items', 'stale_flagger', 'custom'];

/** How the agent fires: on a clock (cron) or only when run by hand / a tool. */
export type ScheduleTriggerType = 'schedule' | 'manual';

/** Which notes the agent looks at. */
export type ScheduleScope = 'recent' | 'all' | 'tag';

export interface ScheduledAgentConfig {
  /** A human label, e.g. "Morning digest". */
  name: string;
  /** Which built-in task (or `custom`). */
  recipe: ScheduleRecipe;
  /** Free-form extra instruction (required for `custom`; optional flavour for the others). */
  taskPrompt: string;
  /** Clock-triggered or manual-only. */
  triggerType: ScheduleTriggerType;
  /** Standard 5-field cron (minute hour day-of-month month day-of-week), evaluated in `timezone`. */
  cron: string;
  /** IANA timezone the cron is read in (e.g. "America/New_York"). Defaults to UTC. */
  timezone: string;
  /** Which notes to consider. */
  scope: ScheduleScope;
  /** When scope = 'tag', the tag/word to match. */
  scopeTag: string;
  /** For recent-scope / digests: how many days back to look. */
  lookbackDays: number;
  /** Hard cap on how many notes the run will scan (cost control). */
  maxNotes: number;
  /** Hard per-run TOKEN budget — the run stops gracefully when this is reached. */
  tokenBudget: number;
  /** Hard per-run STEP budget (tool calls / LLM steps) — anti-runaway. */
  maxSteps: number;
  /** Stage all writes as pending suggestions for human approval (overnight-safe). */
  requireApproval: boolean;
  /** Paused agents keep their definition but never fire. */
  enabled: boolean;
}

export interface RecipeInfo { id: ScheduleRecipe; label: string; description: string; defaultPrompt: string; writes: string }
/** The catalog the UI/admin shows + the runner reads for default behaviour. */
export const RECIPE_CATALOG: readonly RecipeInfo[] = [
  { id: 'daily_digest', label: 'Daily digest', description: 'Summarise the notes you touched recently into one digest note.', defaultPrompt: 'Write a concise digest of what changed across these notes, grouped by theme, with the key points and any open questions.', writes: 'Creates a new digest note' },
  { id: 'link_suggester', label: 'Link suggester', description: 'Find related notes and suggest wiki-links between them.', defaultPrompt: 'For each note, name the 1–3 most related other notes and the phrase that should link to them.', writes: 'Suggests [[wiki-links]] as edits' },
  { id: 'action_items', label: 'Action-item extractor', description: 'Pull action items / to-dos out of recent notes into one list.', defaultPrompt: 'Extract every concrete action item or to-do, with who/when if stated, as a checklist.', writes: 'Creates an action-items note' },
  { id: 'stale_flagger', label: 'Stale-note flagger', description: 'List notes you have not updated in a while so nothing rots.', defaultPrompt: 'List the notes that look stale and, for each, one sentence on what to do with it.', writes: 'Creates a "needs attention" note' },
  { id: 'custom', label: 'Custom task', description: 'Your own instruction, run over the chosen notes.', defaultPrompt: '', writes: 'Per your instruction (staged for approval)' },
];

export function recipeInfo(r: ScheduleRecipe): RecipeInfo { return RECIPE_CATALOG.find((x) => x.id === r) ?? RECIPE_CATALOG[RECIPE_CATALOG.length - 1]!; }

export const DEFAULT_SCHEDULED_AGENT: ScheduledAgentConfig = {
  name: 'Scheduled task', recipe: 'daily_digest', taskPrompt: '', triggerType: 'schedule',
  cron: '0 8 * * *', timezone: 'UTC', scope: 'recent', scopeTag: '', lookbackDays: 1,
  maxNotes: 25, tokenBudget: 8000, maxSteps: 8, requireApproval: true, enabled: true,
};

const MIN_TOKEN_BUDGET = 500, MAX_TOKEN_BUDGET = 200_000;
const MIN_STEPS = 1, MAX_STEPS = 30;

function asBool(v: unknown, f: boolean): boolean { if (typeof v === 'boolean') return v; if (v === 1 || v === '1' || v === 'true') return true; if (v === 0 || v === '0' || v === 'false') return false; return f; }
function clampInt(v: unknown, lo: number, hi: number, f: number): number { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : f; }

/** Validate + normalise a (partial) scheduled-agent config. Rejects unknown enums + a clearly-invalid cron. */
export function validateScheduledAgent(partial: Partial<Record<keyof ScheduledAgentConfig, unknown>>, base: ScheduledAgentConfig = DEFAULT_SCHEDULED_AGENT): { config: ScheduledAgentConfig; warnings: string[] } {
  const p = partial ?? {}; const warnings: string[] = [];
  const recipe = SCHEDULE_RECIPES.includes(p.recipe as ScheduleRecipe) ? p.recipe as ScheduleRecipe : (p.recipe === undefined ? base.recipe : (warnings.push(`Unknown recipe "${String(p.recipe)}".`), base.recipe));
  const triggerType = p.triggerType === 'manual' || p.triggerType === 'schedule' ? p.triggerType : base.triggerType;
  const scope = (['recent', 'all', 'tag'] as const).includes(p.scope as ScheduleScope) ? p.scope as ScheduleScope : (p.scope === undefined ? base.scope : (warnings.push(`Unknown scope "${String(p.scope)}".`), base.scope));
  let cron = typeof p.cron === 'string' && p.cron.trim() ? p.cron.trim() : base.cron;
  if (triggerType === 'schedule' && !isValidCron(cron)) { warnings.push(`Invalid cron "${cron}" — kept previous.`); cron = isValidCron(base.cron) ? base.cron : '0 8 * * *'; }
  const name = String(p.name ?? base.name).trim().slice(0, 120) || 'Scheduled task';
  const taskPrompt = String(p.taskPrompt ?? base.taskPrompt).slice(0, 4000);
  if (recipe === 'custom' && !taskPrompt.trim()) warnings.push('A custom task needs an instruction (taskPrompt).');
  return {
    config: {
      name, recipe, taskPrompt, triggerType, cron,
      timezone: isValidTimezone(p.timezone) ? String(p.timezone) : (p.timezone === undefined ? base.timezone : (warnings.push(`Unknown timezone "${String(p.timezone)}" — using UTC.`), 'UTC')),
      scope, scopeTag: String(p.scopeTag ?? base.scopeTag).trim().slice(0, 80),
      lookbackDays: clampInt(p.lookbackDays ?? base.lookbackDays, 1, 365, base.lookbackDays),
      maxNotes: clampInt(p.maxNotes ?? base.maxNotes, 1, 200, base.maxNotes),
      tokenBudget: clampInt(p.tokenBudget ?? base.tokenBudget, MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET, base.tokenBudget),
      maxSteps: clampInt(p.maxSteps ?? base.maxSteps, MIN_STEPS, MAX_STEPS, base.maxSteps),
      requireApproval: asBool(p.requireApproval ?? base.requireApproval, base.requireApproval),
      enabled: asBool(p.enabled ?? base.enabled, base.enabled),
    },
    warnings,
  };
}
