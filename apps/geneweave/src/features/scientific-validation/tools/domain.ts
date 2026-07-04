/**
 * Scientific Validation — Domain-layer tools
 *
 * Tools that run inside the weaveintel/sandbox-dom container:
 *   rdkit_descriptors   — Compute molecular descriptors from a SMILES string
 *   biopython_align     — Pairwise sequence alignment (global/local)
 *   networkx_analyse    — Compute graph metrics (nodes, edges, centrality, etc.)
 *
 * All tools require a sha256 image digest via ImagePolicy.
 * The caller must supply a ContainerExecutor instance.
 */

import { createHash } from 'node:crypto';
import { weaveTool } from '@weaveintel/core';
import type { Tool } from '@weaveintel/core';
import type { ContainerExecutor, ContainerRunSpec } from '@weaveintel/sandbox';

const EXECUTOR_VERSION = '1';

function computeReproducibilityHash(imageDigest: string, stdinJson: string): string {
  return createHash('sha256')
    .update(imageDigest)
    .update('\x00')
    .update(stdinJson)
    .update('\x00')
    .update(EXECUTOR_VERSION)
    .digest('hex');
}

function parseContainerOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return { ok: false, error: `Non-JSON output: ${stdout.slice(0, 200)}` };
  }
}

// ─── Default container limits for domain compute ──────────────────────────
const DOMAIN_LIMITS = {
  cpuMillis: 4000,
  memoryMB: 2048,
  wallTimeSeconds: 60,
  stdoutBytes: 512 * 1024,
  stderrBytes: 128 * 1024,
};

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDomainTools(opts: {
  executor: ContainerExecutor;
  domDigest: string;
}): Record<string, Tool> {
  const { executor, domDigest } = opts;

  // ── rdkit_descriptors ────────────────────────────────────────────────────────
  const rdkitDescriptors = weaveTool({
    name: 'rdkit_descriptors',
    description:
      'Compute molecular descriptors and properties from a SMILES string using RDKit. Returns molecular weight, LogP, TPSA, H-bond donors/acceptors, and any additional requested descriptors.',
    parameters: {
      type: 'object',
      properties: {
        smiles: {
          type: 'string',
          description: 'SMILES string representing the molecule (e.g. "CC(=O)Oc1ccccc1C(=O)O" for aspirin)',
        },
        descriptors: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of specific descriptor names to compute (e.g. ["MolWt", "LogP", "TPSA", "InChIKey"]). Defaults to a standard set.',
        },
      },
      required: ['smiles'],
    },
    execute: async (args: { smiles: string; descriptors?: string[] }) => {
      const stdin = JSON.stringify({ op: 'rdkit_descriptors', ...args });
      const spec: ContainerRunSpec = {
        imageDigest: domDigest,
        stdin,
        limits: DOMAIN_LIMITS,
        reproducibilityHash: computeReproducibilityHash(domDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `rdkit_descriptors failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'domain', 'chemistry', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── biopython_align ──────────────────────────────────────────────────────────
  const biopythonAlign = weaveTool({
    name: 'biopython_align',
    description:
      'Perform pairwise sequence alignment using BioPython (global or local). Returns the best alignment, alignment score, and formatted alignment text.',
    parameters: {
      type: 'object',
      properties: {
        seq_a: {
          type: 'string',
          description: 'First sequence to align (nucleotide or protein)',
        },
        seq_b: {
          type: 'string',
          description: 'Second sequence to align',
        },
        mode: {
          type: 'string',
          enum: ['globalxx', 'localxx', 'globalms'],
          description: 'Alignment mode: globalxx (global, identical scores), localxx (local), globalms (global with custom match/mismatch)',
        },
        match: {
          type: 'number',
          description: 'Match score for globalms mode (default: 2)',
        },
        mismatch: {
          type: 'number',
          description: 'Mismatch penalty for globalms mode (default: -1)',
        },
        open_gap: {
          type: 'number',
          description: 'Gap open penalty for globalms mode (default: -0.5)',
        },
        extend_gap: {
          type: 'number',
          description: 'Gap extension penalty for globalms mode (default: -0.1)',
        },
      },
      required: ['seq_a', 'seq_b'],
    },
    execute: async (args: {
      seq_a: string;
      seq_b: string;
      mode?: string;
      match?: number;
      mismatch?: number;
      open_gap?: number;
      extend_gap?: number;
    }) => {
      const stdin = JSON.stringify({ op: 'biopython_align', ...args });
      const spec: ContainerRunSpec = {
        imageDigest: domDigest,
        stdin,
        limits: DOMAIN_LIMITS,
        reproducibilityHash: computeReproducibilityHash(domDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `biopython_align failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'domain', 'biology', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── networkx_analyse ──────────────────────────────────────────────────────────
  const networkxAnalyse = weaveTool({
    name: 'networkx_analyse',
    description:
      'Compute structural graph metrics (node/edge counts, density, degree centrality, betweenness centrality, clustering, diameter) using NetworkX.',
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of node identifiers',
        },
        edges: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Edge as [source, target] or [source, target, weight]',
          },
          description:
            'List of edges as [source, target] pairs, or [source, target, weight] for weighted graphs',
        },
        directed: {
          type: 'boolean',
          description: 'Whether the graph is directed (default: false)',
        },
        weighted: {
          type: 'boolean',
          description: 'Whether edges carry weights (default: false)',
        },
      },
      required: ['nodes', 'edges'],
    },
    execute: async (args: {
      nodes: string[];
      edges: (string | number)[][];
      directed?: boolean;
      weighted?: boolean;
    }) => {
      const stdin = JSON.stringify({ op: 'networkx_analyse', ...args });
      const spec: ContainerRunSpec = {
        imageDigest: domDigest,
        stdin,
        limits: DOMAIN_LIMITS,
        reproducibilityHash: computeReproducibilityHash(domDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `networkx_analyse failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'domain', 'graph', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  return {
    'rdkit_descriptors': rdkitDescriptors,
    'biopython_align': biopythonAlign,
    'networkx_analyse': networkxAnalyse,
  };
}
