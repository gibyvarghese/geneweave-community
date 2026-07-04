/**
 * 39 — Kaggle MCP write tools + sandboxed local tools (Phase K2)
 *
 * Demonstrates the ../apps/geneweave/src/kaggle/index.js Phase K2 deliverables end-to-end:
 *   1. Boots `createKaggleMCPServer` with the fixture adapter PLUS a
 *      `ContainerExecutor` backed by `FakeRuntime` (so this example needs no
 *      Docker, no Python, no network).
 *   2. Calls `kaggle.local.validate_submission` against (a) a clean CSV and
 *      (b) a CSV with header drift + duplicate IDs — proves cheap local checks
 *      gate expensive write actions.
 *   3. Calls `kaggle.local.score_cv` through the sandbox — `FakeRuntime`
 *      replays a pre-registered CV result so the example is fully deterministic.
 *   4. Calls `kaggle.competitions.submit` (fixture) AFTER local validation
 *      passes — modelling the K2 design contract: validate → submit.
 *   5. Calls `kaggle.kernels.push` (fixture) with private + no-internet
 *      defaults from the tool layer.
 *
 * Run:
 *   npx tsx examples/39-kaggle-write-and-validate.ts
 *
 * GeneWeave admin verification (manual):
 *   - Start GeneWeave (`npx tsx examples/12-geneweave.ts`).
 *   - Open `/admin` → Tool Catalog. The 4 new K2 rows appear:
 *       * kaggle.competitions.submit            risk=external-side-effect, requires_approval=1
 *       * kaggle.kernels.push                    risk=external-side-effect, requires_approval=1
 *       * kaggle.local.validate_submission       risk=read-only, no credential
 *       * kaggle.local.score_cv                  risk=read-only, no credential
 *   - All ship `enabled=0` by design — the operator must opt in after
 *     provisioning KAGGLE_USERNAME/KAGGLE_KEY (for write tools) and
 *     publishing the kaggle-runner image digest (for score_cv).
 */

import { weaveContext } from '@weaveintel/core';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveFakeTransport } from '@weaveintel/testing';
import {
  ContainerExecutor,
  FakeRuntime,
  createImagePolicy,
} from '@weaveintel/sandbox';
import {
  createKaggleMCPServer,
  fixtureKaggleAdapter,
  KAGGLE_RUNNER_IMAGE_DIGEST,
  kaggleRunnerImagePolicyEntry,
  validateSubmissionCsv,
} from '../apps/geneweave/src/kaggle/index.js';

const CLEAN_CSV = `PassengerId,Survived
1,0
2,1
3,0
4,1
5,0
`;

const DIRTY_CSV = `Id,Outcome
1,0
1,1
`;

const TRAIN_CSV = `feature,target
1,0
2,1
3,0
4,1
5,0
6,1
`;

async function main() {
  console.log('── Phase K2: Kaggle MCP write + sandboxed local tools ──\n');

  // 1. Pre-seed FakeRuntime with the deterministic stdin we expect score_cv
  // to send into the container, so the run replays a stable CV result.
  const scoreStdin = JSON.stringify({
    command: 'score_cv',
    payload: { trainCsv: TRAIN_CSV, targetColumn: 'target', metric: 'accuracy' },
  });
  const fake = new FakeRuntime().register(KAGGLE_RUNNER_IMAGE_DIGEST, scoreStdin, {
    stdout: JSON.stringify({
      cvScore: 0.875,
      foldScores: [0.83, 0.92, 0.875],
      metric: 'accuracy',
      model: 'logistic_regression',
      durationMs: 42,
    }),
    stderr: '',
    exitCode: 0,
    wallMs: 1,
    cpuMs: 1,
    truncated: { stdout: false, stderr: false },
  });
  const executor = new ContainerExecutor({
    runtime: fake,
    imagePolicy: createImagePolicy([kaggleRunnerImagePolicyEntry()]),
  });

  // 2. Boot MCP server with fixture adapter + sandbox executor
  const server = createKaggleMCPServer({
    adapter: fixtureKaggleAdapter(),
    containerExecutor: executor,
  });
  const { client: clientTransport, server: serverTransport } = weaveFakeTransport();
  await server.start(serverTransport);

  const mcp = weaveMCPClient();
  await mcp.connect(clientTransport);

  const ctx = weaveContext({
    metadata: { kaggleUsername: 'demo-user', kaggleKey: 'demo-key' },
  });

  // 3. Local validation — happy path
  console.log('Step 1 ─ kaggle.local.validate_submission (clean CSV)');
  const okValidation = await mcp.callTool(ctx, {
    name: 'kaggle.local.validate_submission',
    arguments: {
      csvContent: CLEAN_CSV,
      expectedHeaders: ['PassengerId', 'Survived'],
      idColumn: 'PassengerId',
      expectedIds: ['1', '2', '3', '4', '5'],
    },
  });
  const okData = JSON.parse((okValidation as any).content[0].text);
  console.log('  →', { valid: okData.valid, rows: okData.rows, errors: okData.errors.length }, '\n');

  // 4. Local validation — sad path proves we can refuse before submitting
  console.log('Step 2 ─ kaggle.local.validate_submission (header drift + duplicates)');
  const badValidation = await mcp.callTool(ctx, {
    name: 'kaggle.local.validate_submission',
    arguments: {
      csvContent: DIRTY_CSV,
      expectedHeaders: ['PassengerId', 'Survived'],
      idColumn: 'Id',
    },
  });
  const badData = JSON.parse((badValidation as any).content[0].text);
  console.log('  →', { valid: badData.valid, errors: badData.errors }, '\n');

  // Sanity-check: pure-TS export gives the same answer as the MCP tool.
  const mirror = validateSubmissionCsv({
    csvContent: DIRTY_CSV,
    expectedHeaders: ['PassengerId', 'Survived'],
    idColumn: 'Id',
  });
  console.log('  pure-TS mirror agrees:', mirror.valid === badData.valid, '\n');

  // 5. Sandboxed CV — runs through the sandbox surface, no real container
  console.log('Step 3 ─ kaggle.local.score_cv (sandboxed via FakeRuntime)');
  const cv = await mcp.callTool(ctx, {
    name: 'kaggle.local.score_cv',
    arguments: { trainCsv: TRAIN_CSV, targetColumn: 'target', metric: 'accuracy' },
  });
  const cvData = JSON.parse((cv as any).content[0].text);
  console.log('  →', cvData, '\n');

  // 6. Submit — only after validation passes
  console.log('Step 4 ─ kaggle.competitions.submit (fixture)');
  const submit = await mcp.callTool(ctx, {
    name: 'kaggle.competitions.submit',
    arguments: {
      competitionRef: 'titanic',
      fileName: 'submission.csv',
      fileContent: CLEAN_CSV,
      description: 'baseline LR after sandbox CV',
    },
  });
  console.log('  →', JSON.parse((submit as any).content[0].text), '\n');

  // 7. Push a kernel — defaults to private + no internet
  console.log('Step 5 ─ kaggle.kernels.push (fixture, defaults: private, no internet, no GPU)');
  const push = await mcp.callTool(ctx, {
    name: 'kaggle.kernels.push',
    arguments: {
      slug: 'demo-user/baseline-titanic',
      title: 'Baseline Titanic',
      source: 'print("hello kaggle")',
      kernelType: 'script',
      language: 'python',
    },
  });
  console.log('  →', JSON.parse((push as any).content[0].text), '\n');

  console.log('── Done. ──');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
