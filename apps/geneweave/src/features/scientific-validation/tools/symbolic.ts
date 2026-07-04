/**
 * Scientific Validation — Symbolic-layer tools
 *
 * Tools that run inside the weaveintel/sandbox-sym container:
 *   sympy_simplify  — Algebraic expression simplification
 *   sympy_solve     — Symbolic equation solving
 *   sympy_integrate — Symbolic / definite integration
 *
 * Plus one HTTP tool:
 *   wolfram_query   — Wolfram Alpha natural-language query (external API)
 *
 * All container tools require a sha256 image digest via ImagePolicy.
 * The caller must supply a ContainerExecutor instance.
 */

import { createHash } from 'node:crypto';
import { weaveTool } from '@weaveintel/core';
import type { Tool } from '@weaveintel/core';
import type { ContainerExecutor, ContainerRunSpec } from '@weaveintel/sandbox';
import { httpRequest } from '@weaveintel/tools/http';

const EXECUTOR_VERSION = '1';

/** Compute the reproducibility hash for a container run per the spec. */
function computeReproducibilityHash(imageDigest: string, stdinJson: string): string {
  return createHash('sha256')
    .update(imageDigest)
    .update('\x00')
    .update(stdinJson)
    .update('\x00')
    .update(EXECUTOR_VERSION)
    .digest('hex');
}

/** Parse the JSON result from the container runner, returning the raw result or an error. */
function parseContainerOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return { ok: false, error: `Non-JSON output: ${stdout.slice(0, 200)}` };
  }
}

// ─── Default container limits for symbolic compute ──────────────────────────
const SYMBOLIC_LIMITS = {
  cpuMillis: 2000,
  memoryMB: 512,
  wallTimeSeconds: 30,
  stdoutBytes: 256 * 1024,
  stderrBytes: 64 * 1024,
};

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createSymbolicTools(opts: {
  executor: ContainerExecutor;
  symDigest: string;
}): Record<string, Tool> {
  const { executor, symDigest } = opts;

  // ── sympy_simplify ──────────────────────────────────────────────────────────
  const sympySimplify = weaveTool({
    name: 'sympy_simplify',
    description:
      'Algebraically simplify a mathematical expression using SymPy. Returns the simplified form and LaTeX representation. Risk: read-only sandboxed compute.',
    parameters: {
      type: 'object',
      properties: {
        expr: {
          type: 'string',
          description:
            'Mathematical expression to simplify (SymPy syntax, e.g. "sin(x)**2 + cos(x)**2")',
        },
      },
      required: ['expr'],
    },
    execute: async (args: { expr: string }) => {
      const stdin = JSON.stringify({ op: 'simplify', expr: args.expr });
      const spec: ContainerRunSpec = {
        imageDigest: symDigest,
        stdin,
        limits: SYMBOLIC_LIMITS,
        reproducibilityHash: computeReproducibilityHash(symDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `sympy_simplify failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'symbolic', 'math', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── sympy_solve ────────────────────────────────────────────────────────────
  const sympySolve = weaveTool({
    name: 'sympy_solve',
    description:
      'Solve one or more equations symbolically using SymPy. Accepts a list of equation strings (SymPy syntax) and a list of symbol names to solve for.',
    parameters: {
      type: 'object',
      properties: {
        equations: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of equations to solve (e.g. ["x**2 - 4", "x + y - 3"])',
        },
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of symbol names to solve for (e.g. ["x", "y"])',
        },
      },
      required: ['equations', 'symbols'],
    },
    execute: async (args: { equations: string[]; symbols: string[] }) => {
      const stdin = JSON.stringify({
        op: 'solve',
        equations: args.equations,
        symbols: args.symbols,
      });
      const spec: ContainerRunSpec = {
        imageDigest: symDigest,
        stdin,
        limits: SYMBOLIC_LIMITS,
        reproducibilityHash: computeReproducibilityHash(symDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `sympy_solve failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'symbolic', 'math', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── sympy_integrate ────────────────────────────────────────────────────────
  const sympyIntegrate = weaveTool({
    name: 'sympy_integrate',
    description:
      'Compute the indefinite or definite integral of an expression using SymPy. For definite integrals supply lower and upper bounds via the limits array.',
    parameters: {
      type: 'object',
      properties: {
        expr: {
          type: 'string',
          description: 'Expression to integrate (SymPy syntax, e.g. "x**2 + sin(x)")',
        },
        var: {
          type: 'string',
          description: 'Integration variable (e.g. "x")',
        },
        limits: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional [lower, upper] bounds for definite integration (e.g. ["0", "pi"])',
        },
      },
      required: ['expr', 'var'],
    },
    execute: async (args: { expr: string; var: string; limits?: string[] }) => {
      const stdin = JSON.stringify({
        op: 'integrate',
        expr: args.expr,
        var: args.var,
        limits: args.limits,
      });
      const spec: ContainerRunSpec = {
        imageDigest: symDigest,
        stdin,
        limits: SYMBOLIC_LIMITS,
        reproducibilityHash: computeReproducibilityHash(symDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `sympy_integrate failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'symbolic', 'math', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── wolfram_query (HTTP) ───────────────────────────────────────────────────
  const wolframQuery = weaveTool({
    name: 'wolfram_query',
    description:
      'Query Wolfram Alpha with a natural-language or mathematical question. Requires WOLFRAM_APP_ID environment variable. Risk: external-side-effect.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language or mathematical query to send to Wolfram Alpha',
        },
        format: {
          type: 'string',
          enum: ['short', 'full'],
          description: 'Response format: "short" (concise answer) or "full" (all pods)',
        },
      },
      required: ['query'],
    },
    execute: async (args: { query: string; format?: string }) => {
      const appId = process.env['WOLFRAM_APP_ID'];
      if (!appId) {
        return {
          content: 'WOLFRAM_APP_ID environment variable is not configured.',
          isError: true,
        };
      }

      const format = args.format ?? 'short';
      const isShort = format === 'short';
      const baseUrl = isShort
        ? 'https://api.wolframalpha.com/v1/result'
        : 'https://api.wolframalpha.com/v2/query';

      const params = new URLSearchParams({ input: args.query, appid: appId });
      if (!isShort) {
        params.set('output', 'json');
        params.set('format', 'plaintext');
      }

      const resp = await httpRequest({
        url: `${baseUrl}?${params.toString()}`,
        method: 'GET',
        timeout: 15_000,
      });

      if (resp.status !== 200) {
        return {
          content: `Wolfram Alpha returned HTTP ${resp.status}: ${resp.body.slice(0, 300)}`,
          isError: true,
        };
      }

      if (isShort) {
        return JSON.stringify({ ok: true, query: args.query, answer: resp.body }, null, 2);
      }

      try {
        const parsed = JSON.parse(resp.body) as {
          queryresult?: { pods?: Array<{ title: string; subpods: Array<{ plaintext: string }> }> };
        };
        const pods = parsed.queryresult?.pods ?? [];
        const results = pods.map((pod) => ({
          title: pod.title,
          text: pod.subpods.map((sp) => sp.plaintext).filter(Boolean).join('\n'),
        }));
        return JSON.stringify({ ok: true, query: args.query, pods: results }, null, 2);
      } catch {
        return JSON.stringify({ ok: true, query: args.query, raw: resp.body.slice(0, 2000) }, null, 2);
      }
    },
    tags: ['scientific', 'symbolic', 'external', 'math'],
    riskLevel: 'external-side-effect',
  });

  return {
    'sympy_simplify': sympySimplify,
    'sympy_solve': sympySolve,
    'sympy_integrate': sympyIntegrate,
    'wolfram_query': wolframQuery,
  };
}
