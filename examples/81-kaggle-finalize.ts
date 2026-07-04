// Example: Phase K7b — Finalizer skill and adversarial validation
// Demonstrates: (1) Adversarial validation round-trip, (2) Finalizer skill logic
// Usage: npx tsx examples/81-kaggle-finalize.ts

import { createKaggleLocalTools, type AdversarialValidationInput } from '../apps/geneweave/src/kaggle/index.js';
import { FakeRuntime, ContainerExecutor, createImagePolicy } from '@weaveintel/sandbox';
import { kaggleRunnerImagePolicyEntry } from '../apps/geneweave/src/kaggle/index.js';

async function main() {
  // 1. Adversarial validation round-trip
  const trainMatrix = [
    [1, 2],
    [2, 3],
    [1, 1],
    [2, 2],
  ];
  const testMatrix = [
    [10, 20],
    [20, 30],
    [10, 10],
    [20, 20],
  ];
  const featureNames = ['f1', 'f2'];
  const input: AdversarialValidationInput = { trainMatrix, testMatrix, featureNames, metric: 'auc', topFeatures: 2 };
  const stdin = JSON.stringify({ command: 'adversarial_validation', payload: input });
  const fakeResult = {
    stdout: JSON.stringify({
      auc: 0.91,
      logloss: 0.22,
      topFeatures: [['f1', 0.8], ['f2', 0.7]],
      model: 'GradientBoostingClassifier',
      converged: true,
      iterations: 5,
    }),
    stderr: '',
    exitCode: 0,
    wallMs: 1,
    cpuMs: 1,
    truncated: { stdout: false, stderr: false },
  };
  const KAGGLE_RUNNER_IMAGE_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const fake = new FakeRuntime().register(KAGGLE_RUNNER_IMAGE_DIGEST, stdin, fakeResult);
  const executor = new ContainerExecutor({
    runtime: fake,
    imagePolicy: createImagePolicy([kaggleRunnerImagePolicyEntry(KAGGLE_RUNNER_IMAGE_DIGEST)]),
  });
  const localTools = createKaggleLocalTools({ executor, imageDigest: KAGGLE_RUNNER_IMAGE_DIGEST });
  const result = await localTools.adversarialValidation(input);
  console.log('Adversarial validation result:', result);

  // 2. Finalizer skill logic (pseudo, as actual skill runs in GeneWeave)
  // Here we simulate the selection logic for 5 runs with known CV/LB
  const runs = [
    { id: 'run1', cv_score: 0.85, public_score: 0.84 },
    { id: 'run2', cv_score: 0.83, public_score: 0.86 },
    { id: 'run3', cv_score: 0.80, public_score: 0.81 },
    { id: 'run4', cv_score: 0.87, public_score: 0.86 },
    { id: 'run5', cv_score: 0.82, public_score: 0.80 },
  ];
  // Compute cv_lb_gap
  for (const r of runs) (r as any).cv_lb_gap = r.public_score - r.cv_score;
  // Median gap
  const gaps = runs.map((r) => Math.abs((r as any).cv_lb_gap)).sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  // (1) Trust-your-CV: highest CV with |gap| < median
  const trust = runs.filter((r) => Math.abs((r as any).cv_lb_gap) <= medianGap).sort((a, b) => b.cv_score - a.cv_score)[0];
  // (2) Diverse swing: next highest CV with different gap sign
  const trustGapSign = Math.sign((trust as any).cv_lb_gap);
  const swing = runs.filter((r) => Math.sign((r as any).cv_lb_gap) !== trustGapSign).sort((a, b) => b.cv_score - a.cv_score)[0];
  console.log('Finalizer picks:');
  console.log('  Trust-your-CV:', trust);
  console.log('  Diverse swing:', swing);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
