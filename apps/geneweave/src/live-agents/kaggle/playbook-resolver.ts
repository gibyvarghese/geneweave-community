/**
 * Kaggle competition playbook resolver — DB-driven, competition-agnostic.
 *
 * The Kaggle live-agents framework is generic. All competition-specific
 * behavior (ARC-AGI-3 API facts, solver-script templates, strategy presets,
 * iteration ladder) lives in the GeneWeave database as:
 *
 *   - `skills` rows with category='kaggle_playbook' (one per competition family)
 *   - `prompt_fragments` rows referenced via {{>fragmentKey}} inside the skill
 *     instructions and as named solver templates
 *
 * Resolution flow (per strategist tick):
 *   1. Strategist extracts a competition slug from its inbound seed message.
 *   2. Calls `resolveKagglePlaybook(slug, db)`.
 *   3. Resolver picks the most-specific enabled `kaggle_playbook` skill whose
 *      `trigger_patterns` matches the slug (`*` is the catch-all default).
 *   4. Resolver expands `{{>fragmentKey}}` markers in the skill instructions
 *      using `prompt_fragments` rows.
 *   5. Returns the rendered system prompt + per-competition execution config
 *      (solver template, strategy presets, max iterations, shape).
 *
 * This file contains NO ARC-specific text. ARC content is seeded into the DB
 * by `playbook-seed.ts`.
 */

import { resolveFragments, fragmentFromRecord, InMemoryFragmentRegistry } from '@weaveintel/prompts';
import type { DatabaseAdapter, SkillRow } from '../../db-types.js';

export const KAGGLE_PLAYBOOK_CATEGORY = 'kaggle_playbook';
export const KAGGLE_PLAYBOOK_DEFAULT_PATTERN = '*';

/**
 * Parsed contents of a kaggle_playbook skill's `examples` JSON column.
 * All fields are optional — the resolver fills sensible defaults so a minimal
 * playbook (just instructions text) still works.
 */
export interface KagglePlaybookConfig {
  /** Human-readable competition shape. Common values: 'static_files',
   *  'live_api', 'unknown'. Used by handlers for branching, never to gate. */
  shape?: string;
  /** Submission contract — drives the validator's PATH A vs PATH B branch.
   *  - `kernel_emits_file` (default): kernel writes /kaggle/working/<filename>
   *    and validator parity-checks against sample_submission.csv (PATH A).
   *  - `kernel_is_submission`: the kernel script itself IS the submission
   *    (live-API / interactive-agent comps with no sample_submission.csv);
   *    validator runs PATH B (status=complete + score line + no traceback).
   *  When omitted, the validator falls back to PATH A. */
  submissionWriter?: 'kernel_emits_file' | 'kernel_is_submission';
  /** Submission file format hint (e.g. 'csv', 'python_script',
   *  'python_agent_class'). Forwarded to the validator for context. */
  submissionFormat?: string;
  /** Submission filename hint (e.g. 'submission.csv', 'main.py').
   *  Forwarded to the validator for context. */
  submissionFilename?: string;
  /** Key into `prompt_fragments` whose body is the Python solver template
   *  the deterministic Implementer should push when no LLM strategist is
   *  driving. Optional — when absent, deterministic mode logs a notice
   *  and skips the push. */
  solverTemplateFragmentKey?: string;
  /** Optional ordered list of preset variable bundles the deterministic
   *  Strategist rotates through across iterations. Each preset is a
   *  free-form record substituted into the solver template via
   *  `{{varName}}` markers. */
  strategyPresets?: Array<{ label: string; variables: Record<string, unknown> }>;
  /** Cap on iterations the deterministic Strategist will rotate through.
   *  Default 3. Agentic strategist ignores this (it uses ReAct maxSteps). */
  maxIterations?: number;
  /** Top-N competitions the agentic Discoverer seeds the strategist with.
   *  Read from the catch-all playbook config (slug=''). Default 5. */
  topNAgentic?: number;
  /** Top-N competitions the deterministic Discoverer forwards. Default 3. */
  topNDeterministic?: number;
  /** Kernel poll interval (seconds) used by the deterministic Implementer
   *  while waiting for a kernel to reach a terminal state. Default 10. */
  pollIntervalSec?: number;
  /** Total kernel poll budget (seconds). Default 300. The Implementer
   *  stops polling and reports the last-known status after this. */
  pollTimeoutSec?: number;
  /** Bytes of kernel log head to keep in the agentic `kaggle_get_kernel_output`
   *  tool response. Default 4000. Inventory + framework READMEs sit here. */
  kernelOutputHeadBytes?: number;
  /** Bytes of kernel log tail to keep in the agentic `kaggle_get_kernel_output`
   *  tool response. Default 4000. Tracebacks sit here. */
  kernelOutputTailBytes?: number;
  /** Hard cap (seconds) on the agentic `kaggle_wait_for_kernel` tool's
   *  `timeoutSeconds` argument. Default 600. */
  kernelWaitMaxTimeoutSec?: number;
  /** Minutes between rest ticks for kaggle role attention policies when the
   *  inbox is empty. Default 60. Read from the catch-all (`*`) playbook. */
  attentionRestMinutes?: number;
  /** Cross-mesh bridge topics surfaced from the kaggle mesh to the user mesh.
   *  Default: ['kaggle.submission_result', 'kaggle.rank_change',
   *  'kaggle.escalation_request']. Read from the catch-all (`*`) playbook. */
  bridgeTopics?: string[];
  /** Per-hour rate limit on the cross-mesh bridge. Default 100. */
  bridgeRateLimitPerHour?: number;
  /** Operator-tunable prose stating why the bridge exists. */
  bridgePurposeProse?: string;
  /** Operator-tunable prose stating bridge constraints. Auto-fills topics
   *  + rate limit when omitted. */
  bridgeConstraintsProse?: string;
  /** Per-role capability override. Each role's array REPLACES the historical
   *  default in `KAGGLE_CAPABILITY_MATRIX` (no merging). Roles missing from
   *  this map keep their hardcoded defaults. Read from the catch-all (`*`)
   *  playbook. Capability revocation takes effect on the next tick. */
  capabilityMatrix?: Partial<Record<
    'discoverer' | 'strategist' | 'implementer' | 'validator' | 'submitter' | 'observer',
    string[]
  >>;
  /** Mesh-level dual-control gate: list of action keys that require a second
   *  human approval before execution. REPLACES the historical default
   *  `['kaggle.competitions.submit', 'kaggle.kernels.push']`. Read from the
   *  catch-all (`*`) playbook. */
  dualControlRequiredFor?: string[];
  /** Per-role persona override. Each provided field REPLACES the matching
   *  field in the in-code default (field-level merge — unspecified fields
   *  fall back). Read from the catch-all (`*`) playbook. Drives the agent's
   *  display name, role label, and contract `persona` / `objectives` /
   *  `successIndicators`. */
  rolePersonas?: Partial<Record<
    'discoverer' | 'strategist' | 'implementer' | 'validator' | 'submitter' | 'observer',
    Partial<{ name: string; role: string; persona: string; objectives: string; success: string }>
  >>;
  /** Pipeline delegation edges. REPLACES the historical 5-edge default
   *  (discoverer→strategist→implementer→validator→submitter +
   *  observer↔strategist). Read from the catch-all (`*`) playbook. */
  pipelineEdges?: Array<{
    from: 'discoverer' | 'strategist' | 'implementer' | 'validator' | 'submitter' | 'observer';
    to: 'discoverer' | 'strategist' | 'implementer' | 'validator' | 'submitter' | 'observer';
    relationship: 'DIRECTS' | 'COLLABORATES_WITH';
    prose: string;
  }>;
}

export interface KagglePlaybook {
  /** Skill row id (audit + admin link). */
  skillId: string;
  /** Skill name (human-readable). */
  name: string;
  /** Pattern that matched (or `*` for default). */
  matchedPattern: string;
  /** Slug requested by the caller (may be empty for "no competition known yet"). */
  competitionSlug: string;
  /** Final fragment-expanded system prompt for the agent. */
  systemPrompt: string;
  /** Tool names this skill activates. */
  toolNames: string[];
  /** Parsed config from skill.examples. */
  config: KagglePlaybookConfig;
  /** Resolved solver template body (already substituted), or empty string. */
  solverTemplate: string;
}

/** Convert a glob pattern (`arc-prize-*`, `*arc-agi*`) to a RegExp. */
function patternToRegex(pattern: string): RegExp {
  if (pattern === '*' || pattern === '') return /.*/;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Score a pattern by specificity. Default catch-all loses to anything else. */
function patternSpecificity(pattern: string): number {
  if (pattern === '*' || pattern === '') return 0;
  // More non-wildcard chars → more specific. Tiebreak on length.
  return pattern.length - (pattern.match(/\*/g)?.length ?? 0) * 2;
}

interface PlaybookCandidate {
  skill: SkillRow;
  pattern: string;
  specificity: number;
}

function pickBestPlaybookSkill(skills: SkillRow[], slug: string): PlaybookCandidate | null {
  const candidates: PlaybookCandidate[] = [];
  for (const skill of skills) {
    if (skill.category !== KAGGLE_PLAYBOOK_CATEGORY) continue;
    if (!skill.enabled) continue;
    let patterns: string[] = [];
    try {
      patterns = JSON.parse(skill.trigger_patterns || '[]');
    } catch {
      patterns = [];
    }
    if (patterns.length === 0) patterns = [KAGGLE_PLAYBOOK_DEFAULT_PATTERN];
    for (const pattern of patterns) {
      const re = patternToRegex(pattern);
      // Empty slug only matches the catch-all `*`/'' pattern.
      const matches = slug ? re.test(slug) : (pattern === KAGGLE_PLAYBOOK_DEFAULT_PATTERN || pattern === '');
      if (matches) {
        candidates.push({ skill, pattern, specificity: patternSpecificity(pattern) });
      }
    }
  }
  if (candidates.length === 0) return null;
  // Highest specificity wins; tiebreak on skill priority then name.
  candidates.sort((a, b) => {
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    if (a.skill.priority !== b.skill.priority) return b.skill.priority - a.skill.priority;
    return a.skill.name.localeCompare(b.skill.name);
  });
  return candidates[0]!;
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Substitute `{{varName}}` markers (single-brace style is reserved for
 *  fragment templates handled elsewhere). Used for solver-template variable
 *  injection — kept deliberately tiny so it works for both Python and JS bodies. */
function substituteSimpleVars(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return JSON.stringify(v);
    }
    return `{{${name}}}`; // leave unknowns untouched so caller can inspect
  });
}

export interface PlaybookResolveOptions {
  /** Optional preset index to apply to the solver template. Default 0. */
  presetIndex?: number;
  /** Optional override variables merged ON TOP of the preset variables. */
  variables?: Record<string, unknown>;
}

export type KagglePlaybookResolver = (
  competitionSlug: string,
  options?: PlaybookResolveOptions,
) => Promise<KagglePlaybook | null>;

/**
 * Build a DB-backed playbook resolver. Reads from `skills` (category=
 * `kaggle_playbook`) and `prompt_fragments` on every call (no cache — DB
 * edits in admin take effect on the next strategist tick). For a long-lived
 * mesh that's an acceptable tradeoff; bolt on a TTL cache later if needed.
 */
export function createDbKagglePlaybookResolver(db: DatabaseAdapter): KagglePlaybookResolver {
  return async (competitionSlug, options = {}) => {
    const skills = await db.listSkills();
    const picked = pickBestPlaybookSkill(skills, competitionSlug);
    if (!picked) return null;

    // Build fragment registry from enabled fragments.
    const fragmentRows = await db.listPromptFragments();
    const registry = new InMemoryFragmentRegistry();
    for (const row of fragmentRows) {
      if (!row.enabled) continue;
      registry.register(fragmentFromRecord(row));
    }

    const systemPrompt = resolveFragments(picked.skill.instructions || '', registry);
    const toolNames = safeJsonParse<string[]>(picked.skill.tool_names, []);
    const config = safeJsonParse<KagglePlaybookConfig>(picked.skill.examples, {});

    // Resolve solver template (optional).
    let solverTemplate = '';
    if (config.solverTemplateFragmentKey) {
      try {
        const frag = await db.getPromptFragmentByKey(config.solverTemplateFragmentKey);
        if (frag && frag.enabled) {
          const presets = config.strategyPresets ?? [];
          const presetIdx = Math.max(0, options.presetIndex ?? 0) % Math.max(1, presets.length);
          const presetVars = presets[presetIdx]?.variables ?? {};
          const merged = { ...presetVars, ...(options.variables ?? {}) };
          solverTemplate = substituteSimpleVars(frag.content, merged);
        }
      } catch {
        // non-fatal: solverTemplate stays empty
      }
    }

    return {
      skillId: picked.skill.id,
      name: picked.skill.name,
      matchedPattern: picked.pattern,
      competitionSlug,
      systemPrompt,
      toolNames,
      config,
      solverTemplate,
    };
  };
}

/**
 * Extract a Kaggle competition slug from free-form inbound text. Looks for:
 *   - URLs of the form `kaggle.com/competitions/<slug>`
 *   - `competitionId: <slug>` and `"competitionId":"<slug>"` markers
 *   - bare slug-shaped tokens after the literal phrase "competition" / "comp"
 * Returns '' when nothing reliable is found — the caller will then fall
 * through to the catch-all playbook.
 */
export function extractCompetitionSlugFromText(text: string): string {
  if (!text) return '';
  const url = text.match(/competitions\/([a-z0-9][a-z0-9-]+)/i);
  if (url && url[1]) return url[1].toLowerCase();
  const json = text.match(/"competitionId"\s*:\s*"([^"]+)"/);
  if (json && json[1]) return json[1].toLowerCase();
  const yaml = text.match(/competition(?:Id|_id|Ref)?\s*[:=]\s*([a-z0-9][a-z0-9-]+)/i);
  if (yaml && yaml[1]) return yaml[1].toLowerCase();
  return '';
}
