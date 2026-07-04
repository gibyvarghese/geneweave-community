/**
 * Scientific Validation — Eval Corpus Runner
 *
 * Runs the 20-hypothesis corpus against a live GeneWeave server and reports
 * how many verdicts match expected outcomes.
 *
 * Usage:
 *   npx ts-node --esm apps/geneweave/src/features/scientific-validation/evals/run-corpus.ts \
 *     --url http://localhost:3000 \
 *     --apiKey <optional-key>
 *
 * Options:
 *   --url       Base URL of the running GeneWeave server (default: http://localhost:3000)
 *   --apiKey    Optional bearer token if auth is required
 *   --timeout   Max seconds to wait per hypothesis (default: 300)
 *   --category  Filter by category: known-true | known-false | ill-posed | p-hacked
 *   --dryRun    Print corpus entries without calling the server
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { hardenedFetch } from '@weaveintel/core';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CorpusEntry {
  id: string;
  category: string;
  title: string;
  statement: string;
  domainTags: string[];
  expectedVerdict: 'supported' | 'refuted' | 'inconclusive' | 'needs_revision';
  rationale: string;
}

interface CorpusFile {
  schemaVersion: string;
  hypotheses: CorpusEntry[];
}

interface HypothesisResponse {
  id: string;
  status: string;
  traceId?: string;
}

interface VerdictShape {
  id: string;
  verdict: string;
  confidenceLo: number;
  confidenceHi: number;
  limitations?: string;
}

interface StatusResponse {
  hypothesis: {
    id: string;
    title: string;
    status: string;
    createdAt: string;
  };
  verdict: VerdictShape | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(): {
  url: string;
  apiKey: string;
  timeout: number;
  category: string | null;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  return {
    url: get('--url') ?? 'http://localhost:3000',
    apiKey: get('--apiKey') ?? '',
    timeout: parseInt(get('--timeout') ?? '300', 10),
    category: get('--category') ?? null,
    dryRun: args.includes('--dryRun'),
  };
}

async function post(url: string, body: unknown, apiKey: string): Promise<unknown> {
  const res = await hardenedFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  }, { errorTag: 'sv-eval-corpus', enforceHttps: false });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function get(url: string, apiKey: string): Promise<unknown> {
  const res = await hardenedFetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }, { errorTag: 'sv-eval-corpus', enforceHttps: false });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function pollForVerdict(
  baseUrl: string,
  hypothesisId: string,
  apiKey: string,
  timeoutMs: number,
): Promise<VerdictShape | null> {
  const terminalStatuses = new Set(['verdict', 'abandoned']);
  const start = Date.now();
  const interval = 5_000;
  while (Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, interval));
    const data = await get(`${baseUrl}/api/sv/hypotheses/${hypothesisId}`, apiKey) as StatusResponse;
    if (terminalStatuses.has(data.hypothesis.status)) {
      return data.verdict;
    }
  }
  return null;
}

// ── ANSI colours ──────────────────────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ── Main ──────────────────────────────────────────────────────────────────────

interface RunResult {
  entry: CorpusEntry;
  hypothesisId: string | null;
  actualVerdict: string | null;
  pass: boolean;
  durationMs: number;
  error?: string;
}

async function main() {
  const opts = parseArgs();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const corpusPath = join(__dirname, 'corpus.json');
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusFile;

  let entries = corpus.hypotheses;
  if (opts.category) {
    entries = entries.filter(e => e.category === opts.category);
    console.log(dim(`Filtered to category '${opts.category}': ${entries.length} entries`));
  }

  console.log(bold(`\nScientific Validation Eval Corpus Runner`));
  console.log(dim(`Server: ${opts.url}  Timeout: ${opts.timeout}s  Entries: ${entries.length}\n`));

  if (opts.dryRun) {
    console.log(bold('DRY RUN — corpus listing:\n'));
    entries.forEach(e => {
      console.log(`  [${e.category}] ${e.id}: ${e.title}`);
      console.log(dim(`    Expected: ${e.expectedVerdict}`));
    });
    return;
  }

  const results: RunResult[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const [i, entry] of entries.entries()) {
    const start = Date.now();
    const prefix = `[${i + 1}/${entries.length}]`;
    process.stdout.write(`${prefix} ${entry.title.substring(0, 60)}… `);

    try {
      // Submit hypothesis
      const resp = await post(`${opts.url}/api/sv/hypotheses`, {
        title: entry.title,
        statement: entry.statement,
        domainTags: entry.domainTags,
      }, opts.apiKey) as HypothesisResponse;

      const hypothesisId = resp.id;

      // Poll for verdict
      const verdict = await pollForVerdict(opts.url, hypothesisId, opts.apiKey, opts.timeout * 1_000);
      const durationMs = Date.now() - start;
      const actual = verdict?.verdict ?? null;
      const pass = actual === entry.expectedVerdict;

      if (pass) {
        passed++;
        console.log(green(`PASS`) + dim(` (${(durationMs / 1000).toFixed(1)}s)`));
      } else {
        failed++;
        console.log(red(`FAIL`) + dim(` got=${actual ?? 'timeout'} expected=${entry.expectedVerdict} (${(durationMs / 1000).toFixed(1)}s)`));
      }

      results.push({ entry, hypothesisId, actualVerdict: actual, pass, durationMs });
    } catch (err: unknown) {
      errors++;
      const durationMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`ERROR`) + dim(` ${msg}`));
      results.push({ entry, hypothesisId: null, actualVerdict: null, pass: false, durationMs, error: msg });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  const total = entries.length;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';

  console.log('\n' + bold('─'.repeat(60)));
  console.log(bold(`Results: ${passed}/${total} passed (${passRate}%)`));
  if (failed > 0) console.log(red(`  Failed: ${failed}`));
  if (errors > 0) console.log(yellow(`  Errors: ${errors}`));

  // Per-category breakdown
  const categories = [...new Set(entries.map(e => e.category))];
  if (categories.length > 1) {
    console.log('\n' + bold('By category:'));
    for (const cat of categories) {
      const catResults = results.filter(r => r.entry.category === cat);
      const catPassed = catResults.filter(r => r.pass).length;
      const line = `  ${cat}: ${catPassed}/${catResults.length}`;
      console.log(catPassed === catResults.length ? green(line) : yellow(line));
    }
  }

  // Failures detail
  const failures = results.filter(r => !r.pass);
  if (failures.length) {
    console.log('\n' + bold('Failures:'));
    failures.forEach(r => {
      console.log(red(`  ✗ ${r.entry.id}`));
      console.log(dim(`    ${r.entry.title}`));
      console.log(dim(`    Expected: ${r.entry.expectedVerdict}  Got: ${r.actualVerdict ?? r.error ?? 'timeout'}`));
    });
  }

  console.log('');
  process.exit(failed > 0 || errors > 0 ? 1 : 0);
}

void main();
