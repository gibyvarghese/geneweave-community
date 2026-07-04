/**
 * Competition probe — pre-fetches the per-competition "agent definition"
 * surface (file list + small metadata files) so the strategist starts a
 * tick already knowing the submission shape, candidate libraries, and any
 * hinted runtime env name. Without this, the strategist burns most of its
 * tool budget rediscovering the same files every tick (and frequently
 * guesses the env name wrong, e.g. `make("crawl", ...)` for maze-crawler).
 *
 * Read-only. All failures are swallowed — a probe miss is never fatal,
 * the strategist still has its DB-driven playbook to fall back on.
 */

import type { KaggleAdapter, KaggleCredentials, KaggleCompetitionFile } from '../../kaggle/index.js';

export interface CompetitionIntel {
  /** Files Kaggle will mount at /kaggle/input/<slug>/. */
  files: { name: string; sizeBytes: number }[];
  /** Detected SHAPE: A=static-file (train/test/sample_submission), B=interactive/agent, unknown=neither matched. */
  shape: 'A' | 'B' | 'unknown';
  /** One of csv/json/python_script/python_agent_class/kernel_is_submission/unknown. */
  submissionFormat:
    | 'csv'
    | 'json'
    | 'python_script'
    | 'python_agent_class'
    | 'kernel_is_submission'
    | 'unknown';
  /** Likely submission filename Kaggle expects (read from sample_submission.* or README hints). */
  submissionFilename: string | null;
  /** Top-level Python imports observed across probed files. Deduped, max ~30. */
  libraries: string[];
  /** When `kaggle_environments` is present, candidate env names extracted from
   *  `make("xxx"...)` / `envs.xxx` literals. The strategist MUST verify these
   *  via a probe kernel before relying on them. */
  envHints: string[];
  /** Per-file content snippets actually fetched (truncated to ~2000 chars each). */
  snippets: { fileName: string; content: string }[];
  /**
   * Combined text of the competition's public narrative pages (Overview /
   * Evaluation / Rules / Data / Timeline) fetched via
   * `adapter.getCompetitionOverview`. Truncated to ~6 KiB. For
   * simulation/agent competitions this carries the actual game rules,
   * scoring math, and per-turn timeouts that DO NOT appear in /kaggle/input/
   * files. Best-effort — null when the fetch failed or returned nothing.
   */
  overview: string | null;
  /** Files we tried to fetch but got an error (404 etc). Informational. */
  missing: string[];
}

const CANDIDATE_FILES = [
  'README.md',
  'README.txt',
  'OVERVIEW.md',
  'agents.md',
  'AGENTS.md',
  'llms.txt',
  'INSTRUCTIONS.md',
  'sample_submission.csv',
  'sample_submission.json',
  'sample_submission.py',
  'gender_submission.csv',
  'submission_format.csv',
  'main.py',
  'requirements.txt',
  'environment.yml',
];

const PER_FILE_TRUNCATE = 2000;
const MAX_LIBRARIES = 30;
const MAX_ENV_HINTS = 8;
const OVERVIEW_TRUNCATE_BYTES = 6 * 1024;

/** Pull `import X` / `from X import` top-level module names. */
function extractImports(text: string): string[] {
  const out = new Set<string>();
  const re = /^(?:from\s+([\w_.]+)|import\s+([\w_.,\s]+))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const captured = m[1] ?? m[2] ?? '';
    for (const part of captured.split(',')) {
      const top = part.trim().split('.')[0]?.trim();
      if (top && /^[a-zA-Z_]\w*$/.test(top)) out.add(top);
    }
  }
  return [...out];
}

/** Pull strings that look like kaggle_environments env names from
 *  `make("xxx"...)` and `envs.xxx`. */
function extractEnvHints(text: string): string[] {
  const out = new Set<string>();
  const reMake = /\bmake\s*\(\s*['"]([\w_-]+)['"]/g;
  const reEnvs = /\bkaggle_environments\.envs\.([\w_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = reMake.exec(text)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  while ((m = reEnvs.exec(text)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  return [...out].slice(0, MAX_ENV_HINTS);
}

/** Decide SHAPE + submission format from the file inventory + snippets. */
function detectShape(
  files: KaggleCompetitionFile[],
  snippets: { fileName: string; content: string }[],
): {
  shape: CompetitionIntel['shape'];
  submissionFormat: CompetitionIntel['submissionFormat'];
  submissionFilename: string | null;
} {
  const names = new Set(files.map((f) => f.name.toLowerCase()));
  const hasCsvSample =
    names.has('sample_submission.csv') ||
    names.has('gender_submission.csv') ||
    names.has('submission_format.csv');
  const hasJsonSample = names.has('sample_submission.json');
  const hasPySample = names.has('sample_submission.py');
  const hasMainPy = names.has('main.py');
  const hasAgentsMd = names.has('agents.md');
  const hasAgentsDir = files.some((f) => /(^|\/)agents\//i.test(f.name));
  const hasKaggleEnvironments = snippets.some((s) =>
    /\bkaggle_environments\b/.test(s.content),
  );

  // SHAPE B = agent/live-API competition. Strong signals first.
  if (hasAgentsDir || hasAgentsMd || hasKaggleEnvironments) {
    return {
      shape: 'B',
      submissionFormat: 'kernel_is_submission',
      submissionFilename: null,
    };
  }
  if (hasMainPy && !hasCsvSample) {
    return {
      shape: 'B',
      submissionFormat: 'python_script',
      submissionFilename: 'main.py',
    };
  }
  if (hasCsvSample) {
    return {
      shape: 'A',
      submissionFormat: 'csv',
      submissionFilename: names.has('gender_submission.csv')
        ? 'submission.csv'
        : 'submission.csv',
    };
  }
  if (hasJsonSample) {
    return { shape: 'A', submissionFormat: 'json', submissionFilename: 'submission.json' };
  }
  if (hasPySample) {
    return {
      shape: 'A',
      submissionFormat: 'python_script',
      submissionFilename: 'submission.py',
    };
  }
  return { shape: 'unknown', submissionFormat: 'unknown', submissionFilename: null };
}

export interface ProbeOptions {
  /** Cap on text bytes pulled per file. Default 2048. */
  perFileMaxBytes?: number;
  /** Override the candidate file list. */
  candidateFiles?: string[];
  /** Optional logger for non-fatal warnings. */
  log?: (msg: string) => void;
}

/**
 * Best-effort probe of a single competition. Lists files, fetches the
 * shortlist of common metadata files, parses imports + env hints, returns
 * a structured intel record. Never throws — on hard adapter error the
 * function returns an `unknown`-shape intel with empty arrays and a
 * single `missing` entry naming the failure.
 */
export async function probeCompetitionFiles(
  adapter: KaggleAdapter,
  creds: KaggleCredentials,
  slug: string,
  opts: ProbeOptions = {},
): Promise<CompetitionIntel> {
  const log = opts.log ?? (() => {});
  const perFile = opts.perFileMaxBytes ?? PER_FILE_TRUNCATE + 1024;
  const candidates = opts.candidateFiles ?? CANDIDATE_FILES;

  let files: KaggleCompetitionFile[] = [];
  try {
    files = await adapter.listCompetitionFiles(creds, slug);
  } catch (err) {
    log(
      `competition-probe: listCompetitionFiles failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      files: [],
      shape: 'unknown',
      submissionFormat: 'unknown',
      submissionFilename: null,
      libraries: [],
      envHints: [],
      snippets: [],
      overview: null,
      missing: ['__list_failed__'],
    };
  }

  // Build the actual fetch set: any candidate file that actually exists in
  // the listing, plus any file under 16 KiB whose name is a strong
  // metadata signal (agents.md anywhere, main.py at root).
  const namesLower = new Set(files.map((f) => f.name.toLowerCase()));
  const wanted = new Set<string>();
  for (const c of candidates) {
    if (namesLower.has(c.toLowerCase())) wanted.add(c);
  }
  // Pick up anything in agents/ or templates/ subdirs that's small.
  for (const f of files) {
    if (
      /\.md$|\.txt$|\.py$|\.yml$|\.yaml$/i.test(f.name) &&
      f.size > 0 &&
      f.size < 16_384 &&
      (/(^|\/)agents\//i.test(f.name) || /(^|\/)templates\//i.test(f.name))
    ) {
      wanted.add(f.name);
    }
  }

  const snippets: { fileName: string; content: string }[] = [];
  const missing: string[] = [];
  // Sequential fetch to avoid hammering Kaggle. The candidate list is short.
  for (const fileName of wanted) {
    try {
      const out = await adapter.downloadCompetitionFile(creds, slug, fileName, {
        maxBytes: perFile,
      });
      if (out.binary) {
        // Skip binary blobs entirely — useless for intel extraction.
        continue;
      }
      const text =
        out.content.length > PER_FILE_TRUNCATE
          ? `${out.content.slice(0, PER_FILE_TRUNCATE)}\n…[truncated ${out.content.length - PER_FILE_TRUNCATE} bytes]`
          : out.content;
      snippets.push({ fileName, content: text });
    } catch (err) {
      missing.push(fileName);
      log(
        `competition-probe: downloadCompetitionFile(${fileName}) failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Parse libraries + env hints from every fetched .py / .md / .txt body.
  const libSet = new Set<string>();
  const envSet = new Set<string>();
  for (const s of snippets) {
    for (const lib of extractImports(s.content)) libSet.add(lib);
    for (const e of extractEnvHints(s.content)) envSet.add(e);
  }
  const libraries = [...libSet].slice(0, MAX_LIBRARIES);
  const envHints = [...envSet].slice(0, MAX_ENV_HINTS);

  const detected = detectShape(files, snippets);

  // Best-effort: fetch the public competition narrative (overview / evaluation
  // / rules / data / timeline). For simulation/agent competitions this is
  // where the rules, scoring math, and submission contract actually live.
  // Failures are non-fatal: overview stays null and the strategist can still
  // call kaggle_get_competition_overview manually.
  let overview: string | null = null;
  try {
    const ov = await adapter.getCompetitionOverview(creds, slug, {
      maxBytesPerPage: 4 * 1024,
      combinedMaxBytes: OVERVIEW_TRUNCATE_BYTES,
    });
    if (ov.combinedText && ov.combinedText.trim().length > 0) {
      overview = ov.combinedText;
    }
    if (ov.missing.length > 0) {
      log(`competition-probe: overview missing pages for ${slug}: ${ov.missing.join(', ')}`);
    }
  } catch (err) {
    log(
      `competition-probe: getCompetitionOverview failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    files: files.map((f) => ({ name: f.name, sizeBytes: f.size })),
    shape: detected.shape,
    submissionFormat: detected.submissionFormat,
    submissionFilename: detected.submissionFilename,
    libraries,
    envHints,
    snippets,
    overview,
    missing,
  };
}

/**
 * Render a CompetitionIntel into a compact Markdown header that can be
 * prepended to the body sent to the strategist. Designed to be both
 * model-readable AND obvious enough that a human operator scanning audit
 * events can immediately see what the discoverer found.
 */
export function renderIntelHeader(slug: string, intel: CompetitionIntel): string {
  const lines: string[] = [];
  lines.push(`### DISCOVERED COMPETITION INTEL (${slug})`);
  lines.push(`shape: ${intel.shape}`);
  lines.push(`submissionFormat: ${intel.submissionFormat}`);
  if (intel.submissionFilename) lines.push(`submissionFilename: ${intel.submissionFilename}`);
  if (intel.libraries.length > 0) {
    lines.push(`libraries: ${intel.libraries.join(', ')}`);
  }
  if (intel.envHints.length > 0) {
    lines.push(
      `envHints: ${intel.envHints.join(', ')}  (UNVERIFIED — push a probe kernel that prints kaggle_environments env list before trusting any of these)`,
    );
  }
  if (intel.files.length > 0) {
    const top = intel.files.slice(0, 25).map((f) => `${f.name} (${f.sizeBytes}B)`);
    lines.push(`files (${intel.files.length}): ${top.join(', ')}${intel.files.length > 25 ? ', …' : ''}`);
  }
  if (intel.snippets.length > 0) {
    lines.push('');
    lines.push('--- METADATA SNIPPETS ---');
    for (const s of intel.snippets) {
      lines.push('');
      lines.push(`#### ${s.fileName}`);
      lines.push('```');
      lines.push(s.content);
      lines.push('```');
    }
  }
  if (intel.overview) {
    lines.push('');
    lines.push('--- COMPETITION OVERVIEW (truncated, fetched from public competition pages) ---');
    lines.push(intel.overview);
    lines.push('--- END OVERVIEW ---');
  }
  if (intel.missing.length > 0) {
    lines.push('');
    lines.push(`(probe could not fetch: ${intel.missing.join(', ')})`);
  }
  lines.push('');
  lines.push('--- END INTEL ---');
  lines.push('');
  return lines.join('\n');
}
