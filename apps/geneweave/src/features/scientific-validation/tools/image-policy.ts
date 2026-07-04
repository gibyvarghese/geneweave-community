/**
 * Scientific Validation — Image policy configuration
 *
 * Builds an ImagePolicy for the three scientific sandbox containers.
 * Digests are loaded from digests.json at module load time.
 *
 * In local development the digests.json contains placeholder zeros.
 * In production (post CI) they contain the actual sha256 digests
 * auto-committed by the sv-images workflow.
 */

import { createImagePolicy } from '@weaveintel/sandbox';
import type { ImagePolicy } from '@weaveintel/sandbox';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIGESTS_PATH = join(__dirname, 'digests.json');

export interface SvImageDigests {
  'sandbox-sym': string;
  'sandbox-num': string;
  'sandbox-dom': string;
}

/** Load pinned digests from digests.json. Returns placeholder zeros if file is missing. */
export function loadSvDigests(): SvImageDigests {
  const zero = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  try {
    const raw = readFileSync(DIGESTS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SvImageDigests>;
    return {
      'sandbox-sym': parsed['sandbox-sym'] ?? zero,
      'sandbox-num': parsed['sandbox-num'] ?? zero,
      'sandbox-dom': parsed['sandbox-dom'] ?? zero,
    };
  } catch {
    return { 'sandbox-sym': zero, 'sandbox-num': zero, 'sandbox-dom': zero };
  }
}

/** Create an ImagePolicy for the three scientific sandbox images. */
export function createSvImagePolicy(digests: SvImageDigests): ImagePolicy {
  return createImagePolicy([
    {
      digest: digests['sandbox-sym'],
      description: 'Scientific Validation symbolic math sandbox (SymPy)',
      envAllowList: [],
      networkAllowList: [],
      resourceCeiling: { cpuMillis: 2000, memoryMB: 512, wallTimeSeconds: 30 },
    },
    {
      digest: digests['sandbox-num'],
      description: 'Scientific Validation numerical sandbox (SciPy / statsmodels / PyMC / R)',
      envAllowList: [],
      networkAllowList: [],
      resourceCeiling: { cpuMillis: 4000, memoryMB: 4096, wallTimeSeconds: 300 },
    },
    {
      digest: digests['sandbox-dom'],
      description: 'Scientific Validation domain sandbox (RDKit / BioPython / NetworkX)',
      envAllowList: [],
      networkAllowList: [],
      resourceCeiling: { cpuMillis: 4000, memoryMB: 2048, wallTimeSeconds: 60 },
    },
  ]);
}
