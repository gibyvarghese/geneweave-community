/**
 * Hypothesis Validation — Tools barrel and top-level factory
 *
 * Usage (in apps/geneweave/src/tools.ts):
 *
 *   import { createSVToolMap } from './features/scientific-validation/tools/index.js';
 *   export const BUILTIN_TOOLS: Record<string, Tool> = {
 *     ...existingTools,
 *     ...createSVToolMap(),
 *   };
 *
 * Environment variables (all optional):
 *   WOLFRAM_APP_ID           — Wolfram Alpha short-answers API key
 *   NCBI_API_KEY             — NCBI E-utilities API key (higher rate limits)
 *   SEMANTIC_SCHOLAR_API_KEY — Semantic Scholar API key
 *   OPENALEX_MAILTO          — Contact address for OpenAlex polite pool
 *   CROSSREF_MAILTO          — Contact address for Crossref polite pool
 *   FAKE_CONTAINER_RUNTIME   — Set to '1' to use FakeRuntime (local dev / CI)
 */

import { FakeRuntime, DockerRuntime, weaveContainerExecutor } from '@weaveintel/sandbox';
import type { Tool } from '@weaveintel/core';

import { loadSvDigests, createSvImagePolicy } from './image-policy.js';
import { createSymbolicTools } from './symbolic.js';
import { createNumericalTools } from './numerical.js';
import { createDomainTools } from './domain.js';
import { createEvidenceTools } from './evidence.js';

export { createSymbolicTools } from './symbolic.js';
export { createNumericalTools } from './numerical.js';
export { createDomainTools } from './domain.js';
export { createEvidenceTools } from './evidence.js';
export { loadSvDigests, createSvImagePolicy } from './image-policy.js';
export type { SvImageDigests } from './image-policy.js';
export type { EvidenceResult, EvidenceItem } from './evidence.js';

/**
 * Create all hypothesis-validation tools and return them as a flat
 * `Record<string, Tool>` suitable for spreading into `BUILTIN_TOOLS`.
 *
 * Container images:
 *   sandbox-sym  — SymPy / Wolfram (symbolic)
 *   sandbox-num  — SciPy / statsmodels / PyMC / R metafor (numerical)
 *   sandbox-dom  — RDKit / BioPython / NetworkX (domain)
 *
 * Digests are loaded from `digests.json` at call time. In local dev the
 * placeholder zeros are always present; use FakeRuntime to bypass policy.
 */
export function createHypothesisValidationToolMap(): Record<string, Tool> {
  const digests = loadSvDigests();
  const policy = createSvImagePolicy(digests);

  // In CI or local dev with FAKE_CONTAINER_RUNTIME=1, use FakeRuntime
  const useFake = process.env['FAKE_CONTAINER_RUNTIME'] === '1';
  const runtime = useFake
    ? new FakeRuntime({ defaultResult: { stdout: '{"ok":true,"result":"fake"}', stderr: '', exitCode: 0, wallMs: 1, cpuMs: 1, truncated: { stdout: false, stderr: false } } })
    : new DockerRuntime();

  const executor = weaveContainerExecutor({ runtime, imagePolicy: policy });

  const symbolic = createSymbolicTools({ executor, symDigest: digests['sandbox-sym'] });
  const numerical = createNumericalTools({ executor, numDigest: digests['sandbox-num'] });
  const domain = createDomainTools({ executor, domDigest: digests['sandbox-dom'] });
  const evidence = createEvidenceTools();

  return {
    ...symbolic,
    ...numerical,
    ...domain,
    ...evidence,
  };
}

// Backward-compatible export used by existing imports.
export const createSVToolMap = createHypothesisValidationToolMap;
