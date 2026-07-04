/**
 * ./index.js — Kaggle MCP server (Phase K1, read-only)
 *
 * Exposes Kaggle REST operations as MCP tools. Credentials are supplied by the
 * MCP caller via _meta.executionContext.metadata (kaggleUsername, kaggleKey).
 * This package does not store secrets.
 *
 * Read-only operations (Phase K1):
 *   kaggle.competitions.list
 *   kaggle.competitions.get
 *   kaggle.competitions.files.list
 *   kaggle.competitions.leaderboard.get
 *   kaggle.competitions.submissions.list
 *   kaggle.datasets.list
 *   kaggle.datasets.get
 *   kaggle.datasets.files.list
 *   kaggle.kernels.list
 *   kaggle.kernels.get
 *   kaggle.kernels.pull
 *   kaggle.kernels.status
 *   kaggle.kernels.output
 *
 * Write operations (`kaggle.competitions.submit`, `kaggle.kernels.push`)
 * and local container-backed operations (`kaggle.local.*`) are deferred to
 * Phases K2/K4.
 */

import { hardenedFetch, weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';
import type {
  KaggleCompetition,
  KaggleCompetitionFile,
  KaggleCompetitionOverview,
  KaggleCompetitionPage,
  KaggleLeaderboardEntry,
  KaggleSubmission,
  KaggleDataset,
  KaggleDatasetFile,
  KaggleKernel,
  KaggleKernelOutput,
  KaggleSubmitInput,
  KaggleSubmitResult,
  KaggleKernelPushInput,
  KaggleKernelPushResult,
  KaggleDiscussionPostInput,
  KaggleDiscussionPostResult,
} from './types.js';
import {
  createKaggleLocalTools,
  type KaggleLocalTools,
  type ScoreCvInput,
  type BlendInput,
  type BlendMetric,
} from './local-tools.js';
import fs from 'fs/promises';
import path from 'path';

// Default-on safety wrapper for fetching Kaggle kernel-output files. URLs come
// from the Kaggle API and are signed object-storage URLs (https). The wrapper
// rejects non-https schemes and IP-literal hosts (SSRF defence in depth
// against a tampered API response), enforces a request timeout, and caps the
// response body so an attacker-chosen URL cannot stream gigabytes into
// process memory. Returns null on any rejection or failure so callers can
// continue gracefully.
export async function safeFetchKaggleOutputText(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (/^[0-9.]+$/.test(parsed.hostname) || parsed.hostname.includes(':')) return null;

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;

  let resp: Response;
  try {
    resp = await hardenedFetch(
      url,
      { signal: AbortSignal.timeout(timeoutMs) },
      { errorTag: 'tools-kaggle', timeoutMs: 0, maxBytes: 0 },
    );
  } catch {
    return null;
  }
  if (!resp.ok || !resp.body) return null;

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}
// ─── Kernel-based hyperparameter search (K7c) ─────────────────────────────

export interface KernelOptimizeHyperparamsInput {
  competitionRef: string;
  datasetPath: string;
  targetColumn: string;
  nTrials?: number;
  timeoutSeconds?: number;
  kernelTitle?: string;
}

export interface KernelOptimizeHyperparamsResult {
  kernelRef: string;
  bestParams: Record<string, unknown>;
  searchHistory: Array<{ value: number; params: Record<string, unknown> }>;
  status: string;
  log: string;
}

/**
 * Pushes a hyperparameter search notebook to Kaggle, polls for completion, and fetches results.
 */
export async function kernelOptimizeHyperparams(
  creds: KaggleCredentials,
  input: KernelOptimizeHyperparamsInput,
  adapter: KaggleAdapter
): Promise<KernelOptimizeHyperparamsResult> {
  // 1. Load notebook template and parameterize
  const templatePath = path.resolve(__dirname, '../runner/templates/hyperparam_search_optuna.ipynb');
  const nb = JSON.parse(await fs.readFile(templatePath, 'utf8')) as {
    cells: Array<{ cell_type: string; source: string | string[] }>;
  };
  const nTrials = input.nTrials ?? 30;
  const timeout = input.timeoutSeconds ?? 60;
  for (const cell of nb.cells) {
    if (cell.cell_type !== 'code') continue;
    const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    const patched = src
      .replace(/pd\.read_csv\(['"][^'"]*['"]\)/, `pd.read_csv('${input.datasetPath}')`)
      .replace(/train\[['"]target['"]\]/, `train['${input.targetColumn}']`)
      .replace(/drop\(\[['"]target['"]\],/, `drop(['${input.targetColumn}'],`)
      .replace(/n_trials=\d+/, `n_trials=${nTrials}`)
      .replace(/timeout=\d+/, `timeout=${timeout}`);
    cell.source = patched.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line);
  }

  // 2. Write notebook to a temp file
  const tmpNbPath = path.join('/tmp', `optuna_search_${Date.now()}.ipynb`);
  await fs.writeFile(tmpNbPath, JSON.stringify(nb));

  // 3. Push notebook as a Kaggle kernel
  // Read notebook file as string for source
  const nbSource = await fs.readFile(tmpNbPath, 'utf8');
  const slug = `optuna-hyperparam-search-${Date.now()}`;
  const kernelPushInput = {
    slug,
    title: input.kernelTitle || `Optuna Hyperparam Search (${input.competitionRef})`,
    source: nbSource,
    kernelType: 'notebook' as 'notebook',
    language: 'python' as 'python',
    isPrivate: true,
    enableGpu: false,
    enableInternet: false,
    datasetSources: [input.datasetPath],
    competitionSource: input.competitionRef,
    // Optionally add metadata if supported by the adapter
  };
  const pushResult = await adapter.pushKernel(creds, kernelPushInput);
  const kernelRef = pushResult.ref;

  // 4. Poll for completion
  let status = 'pending';
  let log = '';
  for (let i = 0; i < 60; ++i) {
    const st = await adapter.getKernelStatus(creds, kernelRef);
    status = st.status;
    if (status === 'complete' || status === 'error') break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  // 5. Fetch outputs
  const output = await adapter.getKernelOutput(creds, kernelRef);
  let bestParams = {};
  let searchHistory = [];
  for (const f of output.files) {
    if (f.fileName === 'best_params.json') {
      const text = await safeFetchKaggleOutputText(f.url, { maxBytes: 1024 * 1024 });
      if (text) {
        try { bestParams = JSON.parse(text); } catch { /* skip malformed */ }
      }
    } else if (f.fileName === 'search_history.json') {
      const text = await safeFetchKaggleOutputText(f.url, { maxBytes: 4 * 1024 * 1024 });
      if (text) {
        try { searchHistory = JSON.parse(text); } catch { /* skip malformed */ }
      }
    }
  }
  log = output.log || '';
  return { kernelRef, bestParams, searchHistory, status, log };
}
import type { ContainerExecutor } from '@weaveintel/sandbox';
import { validateSubmissionCsv, type ValidateSubmissionInput } from './validate.js';

// ─── Credentials ──────────────────────────────────────────────

export interface KaggleCredentials {
  username: string;
  key: string;
}

function extractCredentials(ctx: ExecutionContext): KaggleCredentials {
  const username = ctx.metadata?.['kaggleUsername'] as string | undefined;
  const key = ctx.metadata?.['kaggleKey'] as string | undefined;
  if (!username || !key) {
    throw new Error(
      'Kaggle credentials missing from execution context: set metadata.kaggleUsername and metadata.kaggleKey.',
    );
  }
  return { username, key };
}

// ─── Adapter contract ────────────────────────────────────────

export interface KaggleAdapter {
  listCompetitions(creds: KaggleCredentials, args: {
    category?: string;
    search?: string;
    sortBy?: string;
    page?: number;
  }): Promise<KaggleCompetition[]>;
  getCompetition(creds: KaggleCredentials, ref: string): Promise<KaggleCompetition>;
  listCompetitionFiles(creds: KaggleCredentials, ref: string): Promise<KaggleCompetitionFile[]>;
  /**
   * Download a single competition data file as text. Used by the Strategist
   * to introspect README.md, agents.md, llms.txt, sample_submission.* and
   * similar small text files BEFORE pushing any kernel — this is how the
   * pipeline learns the per-competition submission contract (filename +
   * format) without any per-competition code.
   *
   * Truncates at `maxBytes` (default 64 KiB). Binary files (best-effort
   * detected by null-byte presence) are returned with `binary: true` and
   * a hex-preview of the first 256 bytes.
   */
  downloadCompetitionFile(
    creds: KaggleCredentials,
    ref: string,
    fileName: string,
    opts?: { maxBytes?: number },
  ): Promise<{ fileName: string; sizeBytes: number; truncated: boolean; binary: boolean; content: string }>;
  /**
   * Fetch the competition's public narrative pages — Overview, Evaluation,
   * Rules, Data, Timeline. For simulation/agent competitions (e.g. orbit-wars),
   * the actual rules, scoring math, observation/action specs, and submission
   * contract live HERE rather than in the data bundle. The Strategist needs
   * this in Phase 0 alongside README.md/agents.md to fully understand what to
   * build.
   *
   * Implementation fetches `https://www.kaggle.com/competitions/<ref>/<page>`
   * for each requested page and extracts the visible text from the page's
   * embedded `__NEXT_DATA__` blob. Falls back to HTML tag-stripping when the
   * blob is unparseable. Auth header is sent for consistency but most pages
   * are publicly readable.
   */
  getCompetitionOverview(
    creds: KaggleCredentials,
    ref: string,
    opts?: { pageSlugs?: string[]; maxBytesPerPage?: number; combinedMaxBytes?: number },
  ): Promise<KaggleCompetitionOverview>;
  getLeaderboard(creds: KaggleCredentials, ref: string): Promise<KaggleLeaderboardEntry[]>;
  listSubmissions(creds: KaggleCredentials, ref: string): Promise<KaggleSubmission[]>;
  listDatasets(creds: KaggleCredentials, args: {
    search?: string;
    user?: string;
    page?: number;
  }): Promise<KaggleDataset[]>;
  getDataset(creds: KaggleCredentials, ref: string): Promise<KaggleDataset>;
  listDatasetFiles(creds: KaggleCredentials, ref: string): Promise<KaggleDatasetFile[]>;
  listKernels(creds: KaggleCredentials, args: {
    search?: string;
    user?: string;
    competition?: string;
    dataset?: string;
    page?: number;
  }): Promise<KaggleKernel[]>;
  getKernel(creds: KaggleCredentials, ref: string): Promise<KaggleKernel>;
  pullKernel(creds: KaggleCredentials, ref: string): Promise<{ ref: string; metadata: Record<string, unknown>; source: string }>;
  getKernelStatus(creds: KaggleCredentials, ref: string): Promise<{ ref: string; status: string; failureMessage: string | null }>;
  getKernelOutput(creds: KaggleCredentials, ref: string): Promise<KaggleKernelOutput>;

  /**
   * Submit a file to a competition. External-side-effect: Kaggle counts this
   * against the daily submission cap (commonly 5/day). Callers must enforce
   * approval + rate-limit gates at the policy layer.
   */
  submitToCompetition(creds: KaggleCredentials, input: KaggleSubmitInput): Promise<KaggleSubmitResult>;

  /**
   * Push (create or version) a kernel. External-side-effect; defaults to
   * private + no internet + no GPU.
   */
  pushKernel(creds: KaggleCredentials, input: KaggleKernelPushInput): Promise<KaggleKernelPushResult>;

  /**
   * Phase K6 (deferred): create a discussion post or reply on a Kaggle
   * competition forum. PRIVILEGED — public, irrevocable, attributable to the
   * Kaggle account. The platform layer MUST gate this with approval and a
   * tenant-level kill switch (kaggle_discussion_settings.enabled).
   */
  postDiscussion(creds: KaggleCredentials, input: KaggleDiscussionPostInput): Promise<KaggleDiscussionPostResult>;
}

// ─── Live adapter (real Kaggle REST API) ─────────────────────

const KAGGLE_API_BASE = 'https://www.kaggle.com/api/v1';

function authHeader(creds: KaggleCredentials): string {
  // New Kaggle API tokens use the "KGAT_" prefix and Bearer auth.
  // Legacy tokens (32-char hex) use HTTP Basic auth with username:key.
  if (creds.key.startsWith('KGAT_')) {
    return `Bearer ${creds.key}`;
  }
  const token = Buffer.from(`${creds.username}:${creds.key}`).toString('base64');
  return `Basic ${token}`;
}

async function kaggleFetch(creds: KaggleCredentials, path: string, init?: RequestInit): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${KAGGLE_API_BASE}${path}`;
  const resp = await hardenedFetch(
    url,
    {
      ...init,
      headers: {
        Authorization: authHeader(creds),
        Accept: 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    },
    { errorTag: 'tools-kaggle' },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`Kaggle API error ${resp.status} ${resp.statusText}: ${text}`);
  }
  const ct = resp.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
function n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function b(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return Boolean(v);
}

function parseCompetition(raw: Record<string, unknown>): KaggleCompetition {
  const ref = s(raw['ref']) ?? s(raw['id']) ?? '';
  return {
    id: ref,
    title: s(raw['title']) ?? ref,
    url: s(raw['url']) ?? `https://www.kaggle.com/competitions/${ref}`,
    category: s(raw['category']),
    deadline: s(raw['deadline']) ?? s(raw['enabledDate']),
    reward: s(raw['reward']),
    evaluationMetric: s(raw['evaluationMetric']),
    teamCount: n(raw['teamCount']),
    userHasEntered: b(raw['userHasEntered']),
    description: s(raw['description']),
  };
}

function parseDataset(raw: Record<string, unknown>): KaggleDataset {
  const ref = s(raw['ref']) ?? '';
  return {
    ref,
    title: s(raw['title']) ?? ref,
    url: s(raw['url']) ?? `https://www.kaggle.com/datasets/${ref}`,
    ownerName: s(raw['ownerName']) ?? s(raw['creatorName']) ?? '',
    totalBytes: n(raw['totalBytes']),
    lastUpdated: s(raw['lastUpdated']),
    downloadCount: n(raw['downloadCount']),
  };
}

function parseKernel(raw: Record<string, unknown>): KaggleKernel {
  const ref = s(raw['ref']) ?? '';
  return {
    ref,
    title: s(raw['title']) ?? ref,
    url: s(raw['url']) ?? `https://www.kaggle.com/code/${ref}`,
    author: s(raw['author']) ?? '',
    language: s(raw['language']),
    kernelType: s(raw['kernelType']),
    lastRunTime: s(raw['lastRunTime']),
    totalVotes: n(raw['totalVotes']),
  };
}

// ─── Competition overview narrative (Overview / Evaluation / Rules / …) ─────
//
// Kaggle's REST API does not expose the full markdown narrative for a
// competition's public pages. The HTML pages are server-rendered Next.js
// documents that embed the raw page payload in a <script id="__NEXT_DATA__">
// JSON blob. We extract the largest markdown-ish strings from that blob and
// fall back to a best-effort HTML→text strip if the blob is missing or the
// markdown can't be located.
//
// This is intentionally a single self-contained helper rather than a
// fully-typed Next.js page model because Kaggle's internal payload schema
// changes without notice. Robustness comes from the layered fallback, not
// from precise schema knowledge.

const DEFAULT_PAGE_SLUGS: ReadonlyArray<string> = ['overview', 'evaluation', 'rules', 'data', 'timeline'];
const DEFAULT_MAX_BYTES_PER_PAGE = 8 * 1024;
const DEFAULT_COMBINED_MAX_BYTES = 24 * 1024;

function buildCompetitionPageUrl(ref: string, slug: string): string {
  // `evaluation` lives under `/overview/evaluation`; the others are top-level.
  const path = slug === 'evaluation' ? 'overview/evaluation' : slug;
  return `https://www.kaggle.com/competitions/${encodeURIComponent(ref)}/${path}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripHtmlToText(html: string): string {
  // Drop scripts/styles entirely.
  const noScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  const text = noScripts.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractNextDataMarkdown(html: string): string | null {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m || !m[1]) return null;
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  // Walk the tree, collect long string values that look like markdown/prose.
  const candidates: string[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [data];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === null || cur === undefined) continue;
    if (typeof cur === 'string') {
      // Only consider substantial strings that look like body text.
      if (cur.length >= 200 && /\s/.test(cur)) {
        candidates.push(cur);
      }
      continue;
    }
    if (typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
    }
  }
  if (candidates.length === 0) return null;
  // Prefer the longest unique candidate; concatenate the top few for safety.
  candidates.sort((a, b) => b.length - a.length);
  const top = candidates.slice(0, 3);
  // De-duplicate substrings: drop any candidate fully contained in a longer one.
  const kept: string[] = [];
  for (const c of top) {
    if (!kept.some((k) => k.includes(c))) kept.push(c);
  }
  return kept.join('\n\n').trim();
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m && m[1] ? decodeEntities(m[1]).trim() : null;
}

async function fetchCompetitionPage(
  creds: KaggleCredentials,
  ref: string,
  slug: string,
  maxBytes: number,
): Promise<KaggleCompetitionPage> {
  const url = buildCompetitionPageUrl(ref, slug);
  const resp = await hardenedFetch(
    url,
    {
      headers: {
        // Auth is sent for consistency with other adapter calls; most overview
        // pages are public but private/closed competitions require it.
        Authorization: authHeader(creds),
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'weaveintel-tools-kaggle/0.1 (+https://github.com/)',
      },
      redirect: 'follow',
    },
    { errorTag: 'tools-kaggle' },
  );
  if (!resp.ok) {
    throw new Error(`Kaggle page fetch error ${resp.status} ${resp.statusText} for ${url}`);
  }
  const html = await resp.text();
  const title = extractTitle(html);
  let content = extractNextDataMarkdown(html);
  let source: KaggleCompetitionPage['source'] = 'next-data';
  if (!content) {
    content = stripHtmlToText(html);
    source = 'html-strip';
  }
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    content = Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8');
    content += `\n\n...[truncated to ${maxBytes} bytes]`;
    truncated = true;
  }
  return {
    slug,
    title,
    content,
    source,
    bytes: Buffer.byteLength(content, 'utf8'),
    truncated,
  };
}

async function fetchCompetitionOverview(
  creds: KaggleCredentials,
  ref: string,
  opts?: { pageSlugs?: string[]; maxBytesPerPage?: number; combinedMaxBytes?: number },
): Promise<KaggleCompetitionOverview> {
  const slugs = opts?.pageSlugs ?? DEFAULT_PAGE_SLUGS;
  const maxBytesPerPage = opts?.maxBytesPerPage ?? DEFAULT_MAX_BYTES_PER_PAGE;
  const combinedMaxBytes = opts?.combinedMaxBytes ?? DEFAULT_COMBINED_MAX_BYTES;
  const pages: KaggleCompetitionPage[] = [];
  const missing: string[] = [];
  // Sequential to keep auth headers under one socket and to avoid Kaggle 429s.
  for (const slug of slugs) {
    try {
      const page = await fetchCompetitionPage(creds, ref, slug, maxBytesPerPage);
      pages.push(page);
    } catch {
      missing.push(slug);
    }
  }
  let combined = pages.map((p) => `### ${p.slug}\n${p.content}`).join('\n\n');
  let truncated = false;
  if (Buffer.byteLength(combined, 'utf8') > combinedMaxBytes) {
    combined = Buffer.from(combined, 'utf8').subarray(0, combinedMaxBytes).toString('utf8');
    combined += `\n\n...[combined truncated to ${combinedMaxBytes} bytes]`;
    truncated = true;
  }
  return {
    competitionRef: ref,
    pages,
    combinedText: combined,
    truncated,
    missing,
  };
}

export const liveKaggleAdapter: KaggleAdapter = {
  async listCompetitions(creds, args) {
    const params = new URLSearchParams();
    if (args.category) params.set('category', args.category);
    if (args.search) params.set('search', args.search);
    if (args.sortBy) params.set('sortBy', args.sortBy);
    if (args.page) params.set('page', String(args.page));
    const qs = params.toString();
    const data = await kaggleFetch(creds, `/competitions/list${qs ? `?${qs}` : ''}`) as Array<Record<string, unknown>>;
    return Array.isArray(data) ? data.map(parseCompetition) : [];
  },

  async getCompetition(creds, ref) {
    // Kaggle has no single-competition endpoint; filter list by ref.
    const list = await this.listCompetitions(creds, { search: ref });
    const match = list.find((c) => c.id === ref) ?? list[0];
    if (!match) throw new Error(`Competition not found: ${ref}`);
    return match;
  },

  async listCompetitionFiles(creds, ref) {
    const data = await kaggleFetch(creds, `/competitions/data/list/${encodeURIComponent(ref)}`) as Array<Record<string, unknown>>;
    return Array.isArray(data)
      ? data.map((r) => ({
          ref: s(r['ref']) ?? s(r['name']) ?? '',
          name: s(r['name']) ?? '',
          size: n(r['size']) ?? 0,
          creationDate: s(r['creationDate']),
        }))
      : [];
  },

  async downloadCompetitionFile(creds, ref, fileName, opts) {
    const maxBytes = opts?.maxBytes ?? 64 * 1024;
    // Kaggle endpoint returns a 302 to a signed CDN URL; fetch follows it.
    const url = `${KAGGLE_API_BASE}/competitions/data/download/${encodeURIComponent(ref)}/${encodeURIComponent(fileName)}`;
    const resp = await hardenedFetch(
      url,
      {
        headers: { Authorization: authHeader(creds), Accept: 'application/octet-stream' },
        redirect: 'follow',
      },
      { errorTag: 'tools-kaggle', maxBytes: Math.max(maxBytes, 256 * 1024 * 1024) },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`Kaggle file download error ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const sizeBytes = buf.length;
    const truncated = sizeBytes > maxBytes;
    const slice = truncated ? buf.subarray(0, maxBytes) : buf;
    // Heuristic binary detection: any null byte in the first 1 KiB.
    const sniff = slice.subarray(0, Math.min(slice.length, 1024));
    const binary = sniff.includes(0);
    let content: string;
    if (binary) {
      content = `[binary file, first 256 bytes hex]\n${slice.subarray(0, 256).toString('hex')}`;
    } else {
      content = slice.toString('utf8');
      if (truncated) {
        content += `\n\n...[${sizeBytes - maxBytes} bytes truncated]`;
      }
    }
    return { fileName, sizeBytes, truncated, binary, content };
  },

  async getCompetitionOverview(creds, ref, opts) {
    return fetchCompetitionOverview(creds, ref, opts);
  },

  async getLeaderboard(creds, ref) {
    const data = await kaggleFetch(creds, `/competitions/${encodeURIComponent(ref)}/leaderboard/view`) as Record<string, unknown>;
    const submissions = (data['submissions'] as Array<Record<string, unknown>> | undefined) ?? [];
    return submissions.map((row, i) => ({
      teamId: s(row['teamId']) ?? '',
      teamName: s(row['teamName']) ?? '',
      rank: n(row['rank']) ?? i + 1,
      score: n(row['score']),
      submissionDate: s(row['submissionDate']),
    }));
  },

  async listSubmissions(creds, ref) {
    const data = await kaggleFetch(creds, `/competitions/submissions/list/${encodeURIComponent(ref)}`) as Array<Record<string, unknown>>;
    return Array.isArray(data)
      ? data.map((r) => ({
          ref: s(r['ref']) ?? '',
          fileName: s(r['fileName']),
          date: s(r['date']),
          description: s(r['description']),
          status: s(r['status']),
          publicScore: n(r['publicScore']),
          privateScore: n(r['privateScore']),
        }))
      : [];
  },

  async listDatasets(creds, args) {
    const params = new URLSearchParams();
    if (args.search) params.set('search', args.search);
    if (args.user) params.set('user', args.user);
    if (args.page) params.set('page', String(args.page));
    const qs = params.toString();
    const data = await kaggleFetch(creds, `/datasets/list${qs ? `?${qs}` : ''}`) as Array<Record<string, unknown>>;
    return Array.isArray(data) ? data.map(parseDataset) : [];
  },

  async getDataset(creds, ref) {
    const list = await this.listDatasets(creds, { search: ref.split('/').pop() ?? ref });
    const match = list.find((d) => d.ref === ref) ?? list[0];
    if (!match) throw new Error(`Dataset not found: ${ref}`);
    return match;
  },

  async listDatasetFiles(creds, ref) {
    const data = await kaggleFetch(creds, `/datasets/list/${encodeURIComponent(ref)}`) as Record<string, unknown>;
    const files = (data['datasetFiles'] as Array<Record<string, unknown>> | undefined) ?? [];
    return files.map((r) => ({
      ref: s(r['ref']) ?? s(r['name']) ?? '',
      name: s(r['name']) ?? '',
      size: n(r['totalBytes']) ?? n(r['size']) ?? 0,
      creationDate: s(r['creationDate']),
    }));
  },

  async listKernels(creds, args) {
    const params = new URLSearchParams();
    if (args.search) params.set('search', args.search);
    if (args.user) params.set('user', args.user);
    if (args.competition) params.set('competition', args.competition);
    if (args.dataset) params.set('dataset', args.dataset);
    if (args.page) params.set('page', String(args.page));
    const qs = params.toString();
    const data = await kaggleFetch(creds, `/kernels/list${qs ? `?${qs}` : ''}`) as Array<Record<string, unknown>>;
    return Array.isArray(data) ? data.map(parseKernel) : [];
  },

  async getKernel(creds, ref) {
    const list = await this.listKernels(creds, { search: ref.split('/').pop() ?? ref });
    const match = list.find((k) => k.ref === ref) ?? list[0];
    if (!match) throw new Error(`Kernel not found: ${ref}`);
    return match;
  },

  async pullKernel(creds, ref) {
    const data = await kaggleFetch(creds, `/kernels/pull?userName=${encodeURIComponent(ref.split('/')[0] ?? '')}&kernelSlug=${encodeURIComponent(ref.split('/')[1] ?? '')}`) as Record<string, unknown>;
    const blob = (data['blob'] as Record<string, unknown> | undefined) ?? undefined;
    const source = blob ? (s(blob['source']) ?? s(blob['sourceNullable']) ?? '') : (s(data['source']) ?? '');
    return {
      ref,
      metadata: (data['metadata'] as Record<string, unknown>) ?? (blob ?? {}),
      source,
    };
  },

  async getKernelStatus(creds, ref) {
    const data = await kaggleFetch(creds, `/kernels/status?userName=${encodeURIComponent(ref.split('/')[0] ?? '')}&kernelSlug=${encodeURIComponent(ref.split('/')[1] ?? '')}`) as Record<string, unknown>;
    return {
      ref,
      status: s(data['status']) ?? 'unknown',
      failureMessage: s(data['failureMessage']),
    };
  },

  async getKernelOutput(creds, ref) {
    const data = await kaggleFetch(creds, `/kernels/output?userName=${encodeURIComponent(ref.split('/')[0] ?? '')}&kernelSlug=${encodeURIComponent(ref.split('/')[1] ?? '')}`) as Record<string, unknown>;
    const files = (data['files'] as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      ref,
      files: files.map((f) => ({
        fileName: s(f['fileName']) ?? '',
        size: n(f['size']) ?? 0,
        url: s(f['url']) ?? '',
      })),
      log: s(data['log']),
    };
  },

  async submitToCompetition(creds, input) {
    // 3-step flow. Newer competitions (e.g. simulation/agent comps) only
    // accept the gRPC-style endpoints (CompetitionApiService); older ones
    // still accept the legacy REST paths. Try gRPC first, fall back to REST.
    const bytes = Buffer.byteLength(input.fileContent, 'utf8');
    const epoch = Math.floor(Date.now() / 1000);

    let createUrl: string | null = null;
    let token: string | null = null;
    try {
      const urlInfo = await kaggleFetch(
        creds,
        `/competitions.CompetitionApiService/StartSubmissionUpload`,
        {
          method: 'POST',
          body: JSON.stringify({
            competitionName: input.competitionRef,
            fileName: input.fileName,
            contentLength: bytes,
            lastModifiedEpochSeconds: epoch,
          }),
          headers: { 'content-type': 'application/json' },
        },
      ) as Record<string, unknown>;
      createUrl = s(urlInfo['createUrl']);
      token = s(urlInfo['token']);
    } catch {
      const urlInfo = await kaggleFetch(
        creds,
        `/competitions/submissions/url/${bytes}/${epoch}/${encodeURIComponent(input.fileName)}`,
        { method: 'POST' },
      ) as Record<string, unknown>;
      createUrl = s(urlInfo['createUrl']);
      token = s(urlInfo['token']);
    }
    if (!createUrl || !token) {
      throw new Error('Kaggle submit: missing createUrl/token in upload response');
    }

    const uploadResp = await hardenedFetch(
      createUrl,
      { method: 'PUT', body: input.fileContent },
      { errorTag: 'tools-kaggle' },
    );
    if (!uploadResp.ok) {
      const body = await uploadResp.text().catch(() => uploadResp.statusText);
      throw new Error(`Kaggle submit upload failed (${uploadResp.status}): ${body}`);
    }

    let submit: Record<string, unknown>;
    try {
      submit = await kaggleFetch(
        creds,
        `/competitions.CompetitionApiService/CreateSubmission`,
        {
          method: 'POST',
          body: JSON.stringify({
            competitionName: input.competitionRef,
            blobFileTokens: token,
            submissionDescription: input.description,
          }),
          headers: { 'content-type': 'application/json' },
        },
      ) as Record<string, unknown>;
    } catch {
      const params = new URLSearchParams();
      params.set('blobFileTokens', token);
      params.set('submissionDescription', input.description);
      submit = await kaggleFetch(
        creds,
        `/competitions/submissions/submit/${encodeURIComponent(input.competitionRef)}`,
        { method: 'POST', body: params, headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      ) as Record<string, unknown>;
    }

    return {
      competitionRef: input.competitionRef,
      submissionId: s(submit['id']) ?? s(submit['ref']) ?? s(submit['submissionId']) ?? '',
      status: s(submit['status']) ?? 'pending',
      publicScore: n(submit['publicScore']),
      message: s(submit['message']),
    };
  },

  async pushKernel(creds, input) {
    const lang = input.language ?? 'python';
    // Kaggle's /kernels/push REST endpoint expects:
    //   - `id` is a numeric kernel id (0 for new)
    //   - `slug` is the bare kernel slug (e.g. "my-kernel")
    //   - owner is inferred from the authenticated user; pass `userName` to override
    const slugParts = input.slug.includes('/') ? input.slug.split('/') : [creds.username, input.slug];
    const ownerSlug = slugParts[0] ?? creds.username;
    const bareSlug = slugParts[1] ?? input.slug;
    // Kaggle's protobuf-backed kernels API expects snake_case field names.
    // We also include the legacy camelCase aliases for backwards compatibility
    // with older REST endpoints that still accept them.
    const datasetSources = input.datasetSources ?? [];
    const competitionSources = input.competitionSource ? [input.competitionSource] : [];
    const kernelSources = input.kernelSources ?? [];
    const modelSources = input.modelSources ?? [];
    const body = {
      id: 0,
      slug: bareSlug,
      // snake_case (current API)
      user_name: ownerSlug,
      new_title: input.title,
      text: input.source,
      language: lang,
      kernel_type: input.kernelType,
      is_private: input.isPrivate ?? true,
      enable_gpu: input.enableGpu ?? false,
      enable_internet: input.enableInternet ?? false,
      dataset_data_sources: datasetSources,
      competition_data_sources: competitionSources,
      kernel_data_sources: kernelSources,
      model_data_sources: modelSources,
      category_ids: [],
      // camelCase aliases (legacy REST endpoint compatibility)
      userName: ownerSlug,
      newTitle: input.title,
      kernelType: input.kernelType,
      isPrivate: input.isPrivate ?? true,
      enableGpu: input.enableGpu ?? false,
      enableInternet: input.enableInternet ?? false,
      datasetDataSources: datasetSources,
      competitionDataSources: competitionSources,
      kernelDataSources: kernelSources,
      modelDataSources: modelSources,
      categoryIds: [],
    };
    const data = await kaggleFetch(creds, `/kernels/push`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as Record<string, unknown>;
    return {
      ref: s(data['ref']) ?? input.slug,
      versionNumber: n(data['versionNumber']),
      url: s(data['url']) ?? `https://www.kaggle.com/code/${input.slug}`,
      status: s(data['status']) ?? 'queued',
      errorMessage: s(data['error']) ?? s(data['errorMessage']),
    };
  },

  async postDiscussion(creds, input) {
    // Kaggle's discussion API is undocumented; the public surface used by
    // the website is /discussions/forums/{forumId}/topics/new. We accept
    // either a top-level topic or a reply (parentTopicId set).
    const path = input.parentTopicId
      ? `/discussions/topics/${encodeURIComponent(input.parentTopicId)}/replies/new`
      : `/discussions/competitions/${encodeURIComponent(input.competitionRef)}/topics/new`;
    const body: Record<string, unknown> = { title: input.title, body: input.body };
    const data = await kaggleFetch(creds, path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as Record<string, unknown>;
    const topicId = s(data['id']) ?? s(data['topicId']) ?? s(data['ref']) ?? '';
    return {
      competitionRef: input.competitionRef,
      topicId,
      url: s(data['url']) ?? `https://www.kaggle.com/competitions/${input.competitionRef}/discussion/${topicId}`,
      status: s(data['status']) ?? 'posted',
      message: s(data['message']),
    };
  },
};

// ─── Fixture adapter (deterministic, in-memory) ──────────────

export function fixtureKaggleAdapter(): KaggleAdapter {
  let submissionCounter = 0;
  let pushCounter = 0;
  let discussionCounter = 0;
  const COMP: KaggleCompetition = {
    id: 'titanic',
    title: 'Titanic - Machine Learning from Disaster',
    url: 'https://www.kaggle.com/competitions/titanic',
    category: 'Getting Started',
    deadline: '2030-01-01T00:00:00Z',
    reward: 'Knowledge',
    evaluationMetric: 'CategorizationAccuracy',
    teamCount: 14000,
    userHasEntered: false,
    description: 'Predict survival on the Titanic.',
  };
  const DS: KaggleDataset = {
    ref: 'kaggle/sample-dataset',
    title: 'Sample Dataset',
    url: 'https://www.kaggle.com/datasets/kaggle/sample-dataset',
    ownerName: 'kaggle',
    totalBytes: 1024,
    lastUpdated: '2024-01-01T00:00:00Z',
    downloadCount: 100,
  };
  const KER: KaggleKernel = {
    ref: 'alice/sample-notebook',
    title: 'Sample Notebook',
    url: 'https://www.kaggle.com/code/alice/sample-notebook',
    author: 'alice',
    language: 'python',
    kernelType: 'notebook',
    lastRunTime: '2024-06-01T12:00:00Z',
    totalVotes: 42,
  };
  return {
    async listCompetitions() { return [COMP]; },
    async getCompetition(_creds, ref) {
      if (ref === COMP.id) return COMP;
      throw new Error(`Competition not found: ${ref}`);
    },
    async listCompetitionFiles() {
      return [
        { ref: 'train.csv', name: 'train.csv', size: 60000, creationDate: '2018-01-01T00:00:00Z' },
        { ref: 'test.csv', name: 'test.csv', size: 28000, creationDate: '2018-01-01T00:00:00Z' },
      ];
    },
    async downloadCompetitionFile(_creds, _ref, fileName) {
      const body = `# fixture content for ${fileName}`;
      return { fileName, sizeBytes: body.length, truncated: false, binary: false, content: body };
    },
    async getCompetitionOverview(_creds, ref) {
      const overviewBody = `Fixture overview narrative for competition ${ref}.\nGoal: predict X.\nMetric: Y.`;
      const evalBody = `Fixture evaluation page for ${ref}.\nMetric definition and submission file format described here.`;
      const pages: KaggleCompetitionPage[] = [
        { slug: 'overview', title: 'Overview', content: overviewBody, source: 'next-data', bytes: overviewBody.length, truncated: false },
        { slug: 'evaluation', title: 'Evaluation', content: evalBody, source: 'next-data', bytes: evalBody.length, truncated: false },
      ];
      const combined = pages.map((p) => `### ${p.slug}\n${p.content}`).join('\n\n');
      return { competitionRef: ref, pages, combinedText: combined, truncated: false, missing: [] };
    },
    async getLeaderboard() {
      return [
        { teamId: 't1', teamName: 'Top Team', rank: 1, score: 0.85, submissionDate: '2024-05-01T00:00:00Z' },
        { teamId: 't2', teamName: 'Second Team', rank: 2, score: 0.83, submissionDate: '2024-05-02T00:00:00Z' },
      ];
    },
    async listSubmissions() {
      return [
        { ref: 'sub-1', fileName: 'submission.csv', date: '2024-05-01T00:00:00Z', description: 'baseline', status: 'complete', publicScore: 0.78, privateScore: null },
      ];
    },
    async listDatasets() { return [DS]; },
    async getDataset(_creds, ref) {
      if (ref === DS.ref) return DS;
      throw new Error(`Dataset not found: ${ref}`);
    },
    async listDatasetFiles() {
      return [{ ref: 'data.csv', name: 'data.csv', size: 1024, creationDate: '2024-01-01T00:00:00Z' }];
    },
    async listKernels() { return [KER]; },
    async getKernel(_creds, ref) {
      if (ref === KER.ref) return KER;
      throw new Error(`Kernel not found: ${ref}`);
    },
    async pullKernel(_creds, ref) {
      return { ref, metadata: { id: ref, language: 'python', kernel_type: 'notebook' }, source: '# fixture notebook source\nprint("hello")\n' };
    },
    async getKernelStatus(_creds, ref) {
      return { ref, status: 'complete', failureMessage: null };
    },
    async getKernelOutput(_creds, ref) {
      return {
        ref,
        files: [{ fileName: 'submission.csv', size: 256, url: `https://example.com/${ref}/submission.csv` }],
        log: 'Run completed successfully.',
      };
    },
    async submitToCompetition(_creds, input) {
      submissionCounter++;
      return {
        competitionRef: input.competitionRef,
        submissionId: `fixture-sub-${submissionCounter}`,
        status: 'pending',
        publicScore: null,
        message: `Submission "${input.description}" accepted (${input.fileName}, ${input.fileContent.length} bytes)`,
      };
    },
    async pushKernel(_creds, input) {
      pushCounter++;
      return {
        ref: input.slug,
        versionNumber: pushCounter,
        url: `https://www.kaggle.com/code/${input.slug}`,
        status: 'queued',
        errorMessage: null,
      };
    },
    async postDiscussion(_creds, input) {
      discussionCounter++;
      const topicId = `fixture-topic-${discussionCounter}`;
      return {
        competitionRef: input.competitionRef,
        topicId,
        url: `https://www.kaggle.com/competitions/${input.competitionRef}/discussion/${topicId}`,
        status: 'posted',
        message: input.parentTopicId
          ? `Reply to ${input.parentTopicId} accepted (${input.body.length} chars)`
          : `Topic "${input.title}" posted (${input.body.length} chars)`,
      };
    },
  };
}

// ─── MCP server factory ──────────────────────────────────────

export interface KaggleMCPServerOptions {
  adapter?: KaggleAdapter;
  /**
   * Optional sandbox executor used by `kaggle.local.score_cv`. When omitted,
   * that tool will throw a clear error explaining how to wire one in.
   */
  containerExecutor?: ContainerExecutor;
  /** Optional override of the runner image digest (defaults to KAGGLE_RUNNER_IMAGE_DIGEST). */
  runnerImageDigest?: string;
}

export function createKaggleMCPServer(opts: KaggleMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveKaggleAdapter;
  const localTools: KaggleLocalTools | null = opts.containerExecutor
    ? createKaggleLocalTools({
        executor: opts.containerExecutor,
        ...(opts.runnerImageDigest !== undefined ? { imageDigest: opts.runnerImageDigest } : {}),
      })
    : null;
  const server = weaveMCPServer(
    { name: 'kaggle', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  // Risk descriptors (all read-only in K1)
  const READONLY: ReadonlyArray<[string, string]> = [
    ['kaggle.competitions.list', 'List Kaggle competitions with optional filters'],
    ['kaggle.competitions.get', 'Get a single Kaggle competition by ref/slug'],
    ['kaggle.competitions.files.list', 'List the data files attached to a competition'],
    ['kaggle.competitions.overview.get', "Fetch the competition's public narrative pages (overview/evaluation/rules) as text"],
    ['kaggle.competitions.leaderboard.get', 'Fetch the public leaderboard for a competition'],
    ['kaggle.competitions.submissions.list', "List the caller's prior submissions for a competition"],
    ['kaggle.datasets.list', 'Search the Kaggle dataset catalog'],
    ['kaggle.datasets.get', 'Get a single Kaggle dataset by owner/slug ref'],
    ['kaggle.datasets.files.list', 'List files inside a Kaggle dataset'],
    ['kaggle.kernels.list', 'List Kaggle kernels (notebooks/scripts) with filters'],
    ['kaggle.kernels.get', 'Get a single Kaggle kernel by owner/slug ref'],
    ['kaggle.kernels.pull', 'Fetch a kernel\'s source and metadata'],
    ['kaggle.kernels.status', 'Get the most recent run status of a kernel'],
    ['kaggle.kernels.output', 'List the output files produced by the most recent kernel run'],
  ];
  for (const [name, desc] of READONLY) describeT(name, desc, 'read-only');

  // Phase K2 risk descriptors
  describeT('kaggle.competitions.submit', 'Submit a file to a Kaggle competition', 'external-side-effect');
  describeT('kaggle.kernels.push', 'Create or version a Kaggle kernel (notebook/script)', 'external-side-effect');
  describeT('kaggle.local.validate_submission', 'Validate a submission CSV in-process (header/row/id checks); no network', 'read-only');
  describeT('kaggle.local.score_cv', 'Run cross-validation in a sandboxed container; no network', 'read-only');
  describeT('kaggle.local.blend', 'Find optimal weighted blend of N OOF prediction vectors in a sandboxed container; no network', 'read-only');

  function asText(value: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  }

  server.addTool(
    {
      name: 'kaggle.competitions.list',
      description: 'List Kaggle competitions. Optional filters: category, search, sortBy, page.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Competition category (e.g. featured, getting-started, research)' },
          search: { type: 'string', description: 'Free-text search query' },
          sortBy: { type: 'string', description: 'Sort key (e.g. recentlyCreated, prize, deadline)' },
          page: { type: 'number', description: '1-indexed page number' },
        },
      },
    },
    async (ctx, args) => asText(await adapter.listCompetitions(extractCredentials(ctx), {
      category: args['category'] as string | undefined,
      search: args['search'] as string | undefined,
      sortBy: args['sortBy'] as string | undefined,
      page: args['page'] as number | undefined,
    })),
  );

  server.addTool(
    {
      name: 'kaggle.competitions.get',
      description: 'Get a single Kaggle competition by ref/slug (e.g. "titanic").',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Competition ref/slug' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.getCompetition(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.competitions.files.list',
      description: 'List the data files attached to a competition.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.listCompetitionFiles(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.competitions.overview.get',
      description:
        "Fetch the competition's public narrative pages (Overview, Evaluation, Rules, Data, Timeline) as text. " +
        'For simulation/agent competitions (e.g. orbit-wars) this is where the actual rules, scoring math, and ' +
        'submission contract live — NOT in the data bundle. Use in Phase 0 alongside README.md/agents.md.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Competition ref/slug (e.g. "orbit-wars")' },
          pageSlugs: {
            type: 'array',
            description: 'Optional subset of page slugs to fetch. Default: overview, evaluation, rules, data, timeline.',
            items: { type: 'string' },
          },
          maxBytesPerPage: { type: 'number', description: 'Per-page truncation cap. Default 8192.' },
          combinedMaxBytes: { type: 'number', description: 'Combined text truncation cap. Default 24576.' },
        },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.getCompetitionOverview(
      extractCredentials(ctx),
      String(args['ref']),
      {
        ...(Array.isArray(args['pageSlugs']) ? { pageSlugs: (args['pageSlugs'] as unknown[]).map(String) } : {}),
        ...(typeof args['maxBytesPerPage'] === 'number' ? { maxBytesPerPage: args['maxBytesPerPage'] } : {}),
        ...(typeof args['combinedMaxBytes'] === 'number' ? { combinedMaxBytes: args['combinedMaxBytes'] } : {}),
      },
    )),
  );

  server.addTool(
    {
      name: 'kaggle.competitions.leaderboard.get',
      description: 'Fetch the public leaderboard for a competition.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.getLeaderboard(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.competitions.submissions.list',
      description: "List the caller's submissions for a competition.",
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.listSubmissions(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.datasets.list',
      description: 'Search the Kaggle dataset catalog. Optional filters: search, user, page.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          user: { type: 'string', description: 'Filter to datasets owned by this Kaggle user' },
          page: { type: 'number' },
        },
      },
    },
    async (ctx, args) => asText(await adapter.listDatasets(extractCredentials(ctx), {
      search: args['search'] as string | undefined,
      user: args['user'] as string | undefined,
      page: args['page'] as number | undefined,
    })),
  );

  server.addTool(
    {
      name: 'kaggle.datasets.get',
      description: 'Get a single Kaggle dataset by owner/slug ref.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'owner/slug e.g. "kaggle/sample-dataset"' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.getDataset(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.datasets.files.list',
      description: 'List the files contained in a Kaggle dataset.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.listDatasetFiles(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.kernels.list',
      description: 'List Kaggle kernels (notebooks/scripts). Optional filters: search, user, competition, dataset, page.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          user: { type: 'string' },
          competition: { type: 'string' },
          dataset: { type: 'string' },
          page: { type: 'number' },
        },
      },
    },
    async (ctx, args) => asText(await adapter.listKernels(extractCredentials(ctx), {
      search: args['search'] as string | undefined,
      user: args['user'] as string | undefined,
      competition: args['competition'] as string | undefined,
      dataset: args['dataset'] as string | undefined,
      page: args['page'] as number | undefined,
    })),
  );

  server.addTool(
    {
      name: 'kaggle.kernels.get',
      description: 'Get a single Kaggle kernel by owner/slug ref.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'owner/slug e.g. "alice/sample-notebook"' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.getKernel(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.kernels.pull',
      description: 'Pull a Kaggle kernel\'s source and metadata.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.pullKernel(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.kernels.status',
      description: 'Get the latest run status of a Kaggle kernel.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.getKernelStatus(extractCredentials(ctx), String(args['ref']))),
  );

  server.addTool(
    {
      name: 'kaggle.kernels.output',
      description: 'List the output files (and log) from the latest kernel run.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
    async (ctx, args) => asText(await adapter.getKernelOutput(extractCredentials(ctx), String(args['ref']))),
  );

  // ─── Phase K2 write tools ────────────────────────────────

  server.addTool(
    {
      name: 'kaggle.competitions.submit',
      description:
        'Submit a file to a Kaggle competition. EXTERNAL SIDE EFFECT — counts against the daily submission cap. Default policy requires approval and a per-day rate limit; callers must pass a pre-validated CSV via `fileContent`.',
      inputSchema: {
        type: 'object',
        properties: {
          competitionRef: { type: 'string', description: 'Competition ref/slug (e.g. "titanic")' },
          fileName: { type: 'string', description: 'Submission file name shown on Kaggle' },
          fileContent: { type: 'string', description: 'Raw submission file content (CSV)' },
          description: { type: 'string', description: 'Free-text description for the submission' },
        },
        required: ['competitionRef', 'fileName', 'fileContent', 'description'],
      },
    },
    async (ctx, args) =>
      asText(
        await adapter.submitToCompetition(extractCredentials(ctx), {
          competitionRef: String(args['competitionRef']),
          fileName: String(args['fileName']),
          fileContent: String(args['fileContent']),
          description: String(args['description']),
        }),
      ),
  );

  server.addTool(
    {
      name: 'kaggle.kernels.push',
      description:
        'Create or version a Kaggle kernel. EXTERNAL SIDE EFFECT — defaults to private, no internet, no GPU. Override only when the policy explicitly permits.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'owner/slug — owner is inferred from credentials when omitted' },
          title: { type: 'string' },
          source: { type: 'string', description: 'Notebook JSON or script source' },
          kernelType: { type: 'string', enum: ['notebook', 'script'] },
          language: { type: 'string', enum: ['python', 'r'] },
          isPrivate: { type: 'boolean', description: 'Default true' },
          datasetSources: { type: 'array', items: { type: 'string' } },
          competitionSource: { type: 'string' },
          kernelSources: { type: 'array', items: { type: 'string' } },
          enableInternet: { type: 'boolean', description: 'Default false' },
          enableGpu: { type: 'boolean', description: 'Default false' },
        },
        required: ['slug', 'title', 'source', 'kernelType'],
      },
    },
    async (ctx, args) => {
      const input: KaggleKernelPushInput = {
        slug: String(args['slug']),
        title: String(args['title']),
        source: String(args['source']),
        kernelType: args['kernelType'] === 'script' ? 'script' : 'notebook',
      };
      if (args['language'] !== undefined) input.language = args['language'] === 'r' ? 'r' : 'python';
      if (args['isPrivate'] !== undefined) input.isPrivate = Boolean(args['isPrivate']);
      if (Array.isArray(args['datasetSources'])) input.datasetSources = (args['datasetSources'] as unknown[]).map(String);
      if (typeof args['competitionSource'] === 'string') input.competitionSource = args['competitionSource'] as string;
      if (Array.isArray(args['kernelSources'])) input.kernelSources = (args['kernelSources'] as unknown[]).map(String);
      if (args['enableInternet'] !== undefined) input.enableInternet = Boolean(args['enableInternet']);
      if (args['enableGpu'] !== undefined) input.enableGpu = Boolean(args['enableGpu']);
      return asText(await adapter.pushKernel(extractCredentials(ctx), input));
    },
  );

  // ─── Phase K6 (deferred): discussion bot ─────────────────
  // Tool registered unconditionally so the MCP surface is consistent across
  // builds, but the host application layer ships it disabled in tool_catalog and
  // requires both (a) tenant kill-switch ON and (b) per-call human approval
  // before any execution. Risk: PRIVILEGED.
  server.addTool(
    {
      name: 'kaggle.discussions.create',
      description:
        'Post a topic or reply on a Kaggle competition discussion forum. PRIVILEGED + PUBLIC + IRREVOCABLE — every call is human-attributable to the bound Kaggle account. Requires approval gate + tenant kill switch in the platform layer.',
      inputSchema: {
        type: 'object',
        properties: {
          competitionRef: { type: 'string', description: 'Competition slug (e.g. "titanic")' },
          title: { type: 'string', description: 'Topic title (ignored when parentTopicId is set)' },
          body: { type: 'string', description: 'Markdown body of the post' },
          parentTopicId: { type: 'string', description: 'When set, posts a reply instead of a new topic' },
        },
        required: ['competitionRef', 'title', 'body'],
      },
    },
    async (ctx, args) => {
      const input: KaggleDiscussionPostInput = {
        competitionRef: String(args['competitionRef']),
        title: String(args['title']),
        body: String(args['body']),
      };
      if (typeof args['parentTopicId'] === 'string') input.parentTopicId = args['parentTopicId'] as string;
      return asText(await adapter.postDiscussion(extractCredentials(ctx), input));
    },
  );

  // ─── Phase K2 local (no network) tools ───────────────────

  server.addTool(
    {
      name: 'kaggle.local.validate_submission',
      description:
        'Validate a submission CSV in-process: header order, row count, ID uniqueness/coverage. Pure TS — no network, no credentials needed.',
      inputSchema: {
        type: 'object',
        properties: {
          csvContent: { type: 'string', description: 'Raw CSV text' },
          expectedHeaders: { type: 'array', items: { type: 'string' } },
          expectedRowCount: { type: 'number' },
          idColumn: { type: 'string' },
          expectedIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['csvContent', 'expectedHeaders'],
      },
    },
    async (_ctx, args) => {
      const input: ValidateSubmissionInput = {
        csvContent: String(args['csvContent'] ?? ''),
        expectedHeaders: Array.isArray(args['expectedHeaders']) ? (args['expectedHeaders'] as unknown[]).map(String) : [],
      };
      if (args['expectedRowCount'] !== undefined) input.expectedRowCount = Number(args['expectedRowCount']);
      if (typeof args['idColumn'] === 'string') input.idColumn = args['idColumn'] as string;
      if (Array.isArray(args['expectedIds'])) input.expectedIds = (args['expectedIds'] as unknown[]).map(String);
      return asText(validateSubmissionCsv(input));
    },
  );

  server.addTool(
    {
      name: 'kaggle.local.score_cv',
      description:
        'Run k-fold cross-validation in a sandboxed container (Python + sklearn / lightgbm / xgboost). Returns mean score, per-fold scores, and OOF predictions for downstream blending. No network. Requires a containerExecutor in KaggleMCPServerOptions.',
      inputSchema: {
        type: 'object',
        properties: {
          trainCsv: { type: 'string', description: 'CSV training data including header' },
          targetColumn: { type: 'string' },
          metric: { type: 'string', description: 'sklearn metric key (e.g. accuracy, roc_auc, f1)' },
          folds: { type: 'number', description: 'Default 5' },
          model: { type: 'string', description: 'logistic_regression | random_forest | gradient_boosting | lightgbm | xgboost' },
          modelKwargs: { type: 'object' },
          randomState: { type: 'number', description: 'Default 42' },
          captureOof: { type: 'boolean', description: 'Capture OOF predictions for blending. Default true.' },
        },
        required: ['trainCsv', 'targetColumn', 'metric'],
      },
    },
    async (_ctx, args) => {
      if (!localTools) {
        throw new Error(
          'kaggle.local.score_cv requires a containerExecutor: pass `containerExecutor` to createKaggleMCPServer().',
        );
      }
      const input: ScoreCvInput = {
        trainCsv: String(args['trainCsv'] ?? ''),
        targetColumn: String(args['targetColumn'] ?? ''),
        metric: String(args['metric'] ?? ''),
      };
      if (args['folds'] !== undefined) input.folds = Number(args['folds']);
      if (typeof args['model'] === 'string') input.model = args['model'] as string;
      if (args['modelKwargs'] && typeof args['modelKwargs'] === 'object') {
        input.modelKwargs = args['modelKwargs'] as Record<string, unknown>;
      }
      if (args['randomState'] !== undefined) input.randomState = Number(args['randomState']);
      if (args['captureOof'] !== undefined) input.captureOof = Boolean(args['captureOof']);
      return asText(await localTools.scoreCv(input));
    },
  );

  server.addTool(
    {
      name: 'kaggle.local.blend',
      description:
        'Find optimal weighted blend of N OOF prediction vectors via SLSQP optimization on the simplex (weights ≥ 0, sum = 1). Returns optimal weights, blended score, and baseline mean / best-solo scores for context. No network. Requires a containerExecutor.',
      inputSchema: {
        type: 'object',
        properties: {
          oofMatrix: {
            type: 'array',
            description: 'OOF prediction matrix: outer = models, inner = samples. Must be rectangular.',
            items: { type: 'array', items: { type: 'number' } },
          },
          yTrue: {
            type: 'array',
            description: 'True labels aligned to the inner sample axis.',
            items: { type: 'number' },
          },
          metric: {
            type: 'string',
            description: 'auc | rmse | logloss',
            enum: ['auc', 'rmse', 'logloss'],
          },
        },
        required: ['oofMatrix', 'yTrue', 'metric'],
      },
    },
    async (_ctx, args) => {
      if (!localTools) {
        throw new Error(
          'kaggle.local.blend requires a containerExecutor: pass `containerExecutor` to createKaggleMCPServer().',
        );
      }
      const oofMatrix = Array.isArray(args['oofMatrix'])
        ? (args['oofMatrix'] as unknown[]).map((row) =>
            Array.isArray(row) ? (row as unknown[]).map((v) => Number(v)) : [],
          )
        : [];
      const yTrue = Array.isArray(args['yTrue']) ? (args['yTrue'] as unknown[]).map((v) => Number(v)) : [];
      const metric = (String(args['metric'] ?? 'auc') as BlendMetric);
      const input: BlendInput = { oofMatrix, yTrue, metric };
      return asText(await localTools.blend(input));
    },
  );

  server.addTool(
    {
      name: 'kaggle.local.adversarial_validation',
      description:
        'Detect train/test distribution shift by fitting a classifier to distinguish train/test rows. Returns AUC, logloss, and top features by importance. No network. Requires a containerExecutor.',
      inputSchema: {
        type: 'object',
        properties: {
          trainMatrix: {
            type: 'array',
            description: 'Train matrix: samples × features.',
            items: { type: 'array', items: { type: 'number' } },
          },
          testMatrix: {
            type: 'array',
            description: 'Test matrix: samples × features.',
            items: { type: 'array', items: { type: 'number' } },
          },
          featureNames: {
            type: 'array',
            description: 'Optional feature names.',
            items: { type: 'string' },
          },
          metric: {
            type: 'string',
            description: 'auc | logloss (default auc)',
            enum: ['auc', 'logloss'],
          },
          topFeatures: {
            type: 'number',
            description: 'How many top features to return (default 10)',
          },
        },
        required: ['trainMatrix', 'testMatrix'],
      },
    },
    async (_ctx, args) => {
      if (!localTools) {
        throw new Error(
          'kaggle.local.adversarial_validation requires a containerExecutor: pass `containerExecutor` to createKaggleMCPServer().',
        );
      }
      const trainMatrix = Array.isArray(args['trainMatrix'])
        ? (args['trainMatrix'] as unknown[]).map((row) =>
            Array.isArray(row) ? (row as unknown[]).map((v) => Number(v)) : [],
          )
        : [];
      const testMatrix = Array.isArray(args['testMatrix'])
        ? (args['testMatrix'] as unknown[]).map((row) =>
            Array.isArray(row) ? (row as unknown[]).map((v) => Number(v)) : [],
          )
        : [];
      const featureNames = Array.isArray(args['featureNames'])
        ? (args['featureNames'] as unknown[]).map(String)
        : undefined;
      let metric: 'auc' | 'logloss' | undefined = undefined;
      if (args['metric'] === 'auc' || args['metric'] === 'logloss') metric = args['metric'];
      const topFeatures = args['topFeatures'] !== undefined ? Number(args['topFeatures']) : undefined;
      const input = { trainMatrix, testMatrix, featureNames, metric, topFeatures };
      return asText(await localTools.adversarialValidation(input));
    },
  );

  // ─── Phase K7c: kernel-based hyperparameter search ─────────────
  server.addTool(
    {
      name: 'kaggle.kernel.optimize_hyperparams',
      description: 'Run hyperparameter search via Optuna in a Kaggle kernel. Pushes a notebook, polls for completion, and fetches best params and search history.',
      inputSchema: {
        type: 'object',
        properties: {
          competitionRef: { type: 'string', description: 'Competition ref/slug (e.g. "titanic")' },
          datasetPath: { type: 'string', description: 'Path to the dataset file in Kaggle (e.g. "/kaggle/input/train.csv")' },
          targetColumn: { type: 'string', description: 'Name of the target column' },
          nTrials: { type: 'number', description: 'Number of Optuna trials (default 30)' },
          timeoutSeconds: { type: 'number', description: 'Wall-time timeout in seconds (default 600)' },
          kernelTitle: { type: 'string', description: 'Optional kernel title' },
        },
        required: ['competitionRef', 'datasetPath', 'targetColumn'],
      },
    },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const input = {
        competitionRef: String(args['competitionRef']),
        datasetPath: String(args['datasetPath']),
        targetColumn: String(args['targetColumn']),
        nTrials: args['nTrials'] !== undefined ? Number(args['nTrials']) : undefined,
        timeoutSeconds: args['timeoutSeconds'] !== undefined ? Number(args['timeoutSeconds']) : undefined,
        kernelTitle: args['kernelTitle'] !== undefined ? String(args['kernelTitle']) : undefined,
      };
      const result = await kernelOptimizeHyperparams(creds, input, adapter);
      return asText(result);
    },
  );
  return server;
}
