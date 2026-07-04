/**
 * Scientific Validation — Numerical-layer tools
 *
 * Tools that run inside the weaveintel/sandbox-num container:
 *   scipy_stats_test    — Parametric and non-parametric statistical tests
 *   statsmodels_meta    — Random-effects meta-analysis (REML)
 *   scipy_power         — Power analysis (sample size / achieved power)
 *   pymc_mcmc           — Bayesian posterior sampling via PyMC
 *   r_metafor           — Meta-analysis via R metafor package
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

// ─── Default container limits for numerical compute ──────────────────────────
const NUMERICAL_LIMITS = {
  cpuMillis: 4000,
  memoryMB: 2048,
  wallTimeSeconds: 120,
  stdoutBytes: 512 * 1024,
  stderrBytes: 128 * 1024,
};

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createNumericalTools(opts: {
  executor: ContainerExecutor;
  numDigest: string;
}): Record<string, Tool> {
  const { executor, numDigest } = opts;

  // ── scipy_stats_test ────────────────────────────────────────────────────────
  const scipyStatsTest = weaveTool({
    name: 'scipy_stats_test',
    description:
      'Run parametric or non-parametric statistical tests (t-test, Mann-Whitney U, Wilcoxon, Kruskal-Wallis, chi-squared). Returns test statistic and p-value.',
    parameters: {
      type: 'object',
      properties: {
        test: {
          type: 'string',
          enum: ['ttest_ind', 'ttest_1samp', 'mannwhitneyu', 'wilcoxon', 'kruskal', 'chi2_contingency'],
          description: 'Statistical test to run',
        },
        data_a: {
          type: 'array',
          items: { type: 'number' },
          description: 'Primary data array (or observed counts matrix for chi2_contingency)',
        },
        data_b: {
          type: 'array',
          items: { type: 'number' },
          description: 'Secondary data array (required for two-sample tests)',
        },
        alternative: {
          type: 'string',
          enum: ['two-sided', 'less', 'greater'],
          description: 'Alternative hypothesis direction (default: two-sided)',
        },
        popmean: {
          type: 'number',
          description: 'Population mean for one-sample t-test',
        },
        groups: {
          type: 'array',
          items: { type: 'array', items: { type: 'number' } },
          description: 'All groups for Kruskal-Wallis test',
        },
      },
      required: ['test', 'data_a'],
    },
    execute: async (args: {
      test: string;
      data_a: number[];
      data_b?: number[];
      alternative?: string;
      popmean?: number;
      groups?: number[][];
    }) => {
      const stdin = JSON.stringify({ op: 'stats_test', ...args });
      const spec: ContainerRunSpec = {
        imageDigest: numDigest,
        stdin,
        limits: NUMERICAL_LIMITS,
        reproducibilityHash: computeReproducibilityHash(numDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `scipy_stats_test failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'numerical', 'statistics', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── statsmodels_meta ────────────────────────────────────────────────────────
  const statsmodelsMeta = weaveTool({
    name: 'statsmodels_meta',
    description:
      'Perform random-effects meta-analysis using statsmodels (REML estimator). Accepts arrays of effect sizes and their variances. Returns pooled effect, confidence interval, I², and τ².',
    parameters: {
      type: 'object',
      properties: {
        effects: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of effect sizes from individual studies',
        },
        variances: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of sampling variances corresponding to each effect size',
        },
      },
      required: ['effects', 'variances'],
    },
    execute: async (args: { effects: number[]; variances: number[] }) => {
      const stdin = JSON.stringify({ op: 'meta_analysis', ...args });
      const spec: ContainerRunSpec = {
        imageDigest: numDigest,
        stdin,
        limits: NUMERICAL_LIMITS,
        reproducibilityHash: computeReproducibilityHash(numDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `statsmodels_meta failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'numerical', 'meta-analysis', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── scipy_power ─────────────────────────────────────────────────────────────
  const scipyPower = weaveTool({
    name: 'scipy_power',
    description:
      'Compute statistical power or required sample size using statsmodels power analysis. Supports independent t-test, paired t-test, and normal test. Provide either n_obs (to compute achieved power) or power (to compute required n).',
    parameters: {
      type: 'object',
      properties: {
        analysis_type: {
          type: 'string',
          enum: ['tt_ind', 'tt_1samp', 'normal'],
          description: 'Type of power analysis: tt_ind (independent t-test), tt_1samp (one-sample), normal (z-test)',
        },
        effect_size: {
          type: 'number',
          description: "Cohen's d or standardised effect size",
        },
        alpha: {
          type: 'number',
          description: 'Significance level (default: 0.05)',
        },
        power: {
          type: 'number',
          description: 'Desired power level (e.g. 0.8). Omit to compute achieved power from n_obs.',
        },
        n_obs: {
          type: 'number',
          description: 'Observed/planned sample size per group. Omit to solve for required n.',
        },
      },
      required: ['effect_size'],
    },
    execute: async (args: {
      analysis_type?: string;
      effect_size: number;
      alpha?: number;
      power?: number;
      n_obs?: number;
    }) => {
      const stdin = JSON.stringify({ op: 'power_analysis', ...args });
      const spec: ContainerRunSpec = {
        imageDigest: numDigest,
        stdin,
        limits: NUMERICAL_LIMITS,
        reproducibilityHash: computeReproducibilityHash(numDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `scipy_power failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'numerical', 'power', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── pymc_mcmc ───────────────────────────────────────────────────────────────
  const pymcMcmc = weaveTool({
    name: 'pymc_mcmc',
    description:
      'Sample from a Bayesian posterior distribution using PyMC (NUTS sampler). Currently supports Gaussian models (infer μ and σ from data). Returns summary statistics and R-hat convergence diagnostics.',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'object',
          description: 'Model specification: { data: number[], mu_prior: number, mu_sigma_prior: number, sigma_prior: number }',
          properties: {
            data: {
              type: 'array',
              items: { type: 'number' },
              description: 'Observed data points',
            },
            mu_prior: { type: 'number', description: 'Prior mean for μ (default: 0)' },
            mu_sigma_prior: { type: 'number', description: 'Prior standard deviation for μ (default: 10)' },
            sigma_prior: { type: 'number', description: 'Prior scale for σ half-normal (default: 1)' },
          },
          required: ['data'],
        },
        draws: {
          type: 'number',
          description: 'Number of posterior draws per chain (default: 500)',
        },
        tune: {
          type: 'number',
          description: 'Number of tuning steps (default: 500)',
        },
        chains: {
          type: 'number',
          description: 'Number of MCMC chains (default: 2)',
        },
      },
      required: ['model'],
    },
    execute: async (args: {
      model: { data: number[]; mu_prior?: number; mu_sigma_prior?: number; sigma_prior?: number };
      draws?: number;
      tune?: number;
      chains?: number;
    }) => {
      const stdin = JSON.stringify({ op: 'mcmc_sample', ...args });
      const spec: ContainerRunSpec = {
        imageDigest: numDigest,
        stdin,
        limits: { ...NUMERICAL_LIMITS, wallTimeSeconds: 300, memoryMB: 4096 },
        reproducibilityHash: computeReproducibilityHash(numDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `pymc_mcmc failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'numerical', 'bayesian', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  // ── r_metafor ────────────────────────────────────────────────────────────────
  const rMetafor = weaveTool({
    name: 'r_metafor',
    description:
      'Run meta-analysis using the R metafor package (rma() with REML estimator). Returns pooled estimate, confidence interval, I², τ², and p-value.',
    parameters: {
      type: 'object',
      properties: {
        effects: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of effect sizes (yi) from individual studies',
        },
        variances: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of sampling variances (vi) corresponding to each effect size',
        },
      },
      required: ['effects', 'variances'],
    },
    execute: async (args: { effects: number[]; variances: number[] }) => {
      const stdin = JSON.stringify({ op: 'r_metafor', ...args });
      const spec: ContainerRunSpec = {
        imageDigest: numDigest,
        stdin,
        limits: NUMERICAL_LIMITS,
        reproducibilityHash: computeReproducibilityHash(numDigest, stdin),
      };
      const result = await executor.execute(spec);
      if (result.exitCode !== 0) {
        const errOut = parseContainerOutput(result.stdout) as { error?: string };
        return {
          content: `r_metafor failed (exit ${result.exitCode}): ${errOut.error ?? result.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
      return JSON.stringify(parseContainerOutput(result.stdout), null, 2);
    },
    tags: ['scientific', 'numerical', 'meta-analysis', 'r', 'sandbox'],
    riskLevel: 'external-side-effect',
  });

  return {
    'scipy_stats_test': scipyStatsTest,
    'statsmodels_meta': statsmodelsMeta,
    'scipy_power': scipyPower,
    'pymc_mcmc': pymcMcmc,
    'r_metafor': rMetafor,
  };
}
