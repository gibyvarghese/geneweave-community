/**
 * ./index.js — fixture tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createKaggleMCPServer, fixtureKaggleAdapter } from './kaggle.js';

const READONLY_TOOL_NAMES = [
  'kaggle.competitions.list',
  'kaggle.competitions.get',
  'kaggle.competitions.files.list',
  'kaggle.competitions.leaderboard.get',
  'kaggle.competitions.submissions.list',
  'kaggle.datasets.list',
  'kaggle.datasets.get',
  'kaggle.datasets.files.list',
  'kaggle.kernels.list',
  'kaggle.kernels.get',
  'kaggle.kernels.pull',
  'kaggle.kernels.status',
  'kaggle.kernels.output',
];

describe('./index.js (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  let listTools: () => Promise<Array<{ name: string }>>;

  beforeEach(async () => {
    const adapter = fixtureKaggleAdapter();
    const server = createKaggleMCPServer({ adapter });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: { kaggleUsername: 'tester', kaggleKey: 'fake-key' } });

    callTool = async (name, args) => {
      const result = await mcpClient.callTool(ctx, { name, arguments: args });
      return result as { content: Array<{ type: string; text: string }> };
    };
    listTools = async () => mcpClient.listTools();
  });

  it('exposes all 13 read-only Kaggle tools', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    for (const expected of READONLY_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
    // K2 tools must now be present
    expect(names).toContain('kaggle.competitions.submit');
    expect(names).toContain('kaggle.kernels.push');
    expect(names).toContain('kaggle.local.validate_submission');
    expect(names).toContain('kaggle.local.score_cv');
    expect(names).toContain('kaggle.local.blend');
  });

  it('kaggle.competitions.list returns an array of competitions', async () => {
    const result = await callTool('kaggle.competitions.list', { search: 'titanic' });
    const data = JSON.parse(result.content[0]!.text);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].id).toBe('titanic');
    expect(data[0].evaluationMetric).toBe('CategorizationAccuracy');
  });

  it('kaggle.competitions.get returns a single competition', async () => {
    const result = await callTool('kaggle.competitions.get', { ref: 'titanic' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.id).toBe('titanic');
    expect(data.title).toContain('Titanic');
  });

  it('kaggle.competitions.files.list returns competition files', async () => {
    const result = await callTool('kaggle.competitions.files.list', { ref: 'titanic' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(2);
    expect(data[0].name).toBe('train.csv');
  });

  it('kaggle.competitions.leaderboard.get returns ranked entries', async () => {
    const result = await callTool('kaggle.competitions.leaderboard.get', { ref: 'titanic' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data[0].rank).toBe(1);
    expect(data[0].score).toBe(0.85);
  });

  it('kaggle.competitions.submissions.list returns submissions', async () => {
    const result = await callTool('kaggle.competitions.submissions.list', { ref: 'titanic' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data[0].status).toBe('complete');
    expect(data[0].publicScore).toBe(0.78);
  });

  it('kaggle.datasets.list returns datasets', async () => {
    const result = await callTool('kaggle.datasets.list', { search: 'sample' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data[0].ref).toBe('kaggle/sample-dataset');
  });

  it('kaggle.datasets.get returns a single dataset', async () => {
    const result = await callTool('kaggle.datasets.get', { ref: 'kaggle/sample-dataset' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.ref).toBe('kaggle/sample-dataset');
  });

  it('kaggle.datasets.files.list returns dataset files', async () => {
    const result = await callTool('kaggle.datasets.files.list', { ref: 'kaggle/sample-dataset' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data[0].name).toBe('data.csv');
  });

  it('kaggle.kernels.list returns kernels', async () => {
    const result = await callTool('kaggle.kernels.list', { search: 'sample' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data[0].ref).toBe('alice/sample-notebook');
    expect(data[0].language).toBe('python');
  });

  it('kaggle.kernels.get returns a kernel', async () => {
    const result = await callTool('kaggle.kernels.get', { ref: 'alice/sample-notebook' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.ref).toBe('alice/sample-notebook');
  });

  it('kaggle.kernels.pull returns source + metadata', async () => {
    const result = await callTool('kaggle.kernels.pull', { ref: 'alice/sample-notebook' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.source).toContain('hello');
    expect(data.metadata.language).toBe('python');
  });

  it('kaggle.kernels.status returns a status string', async () => {
    const result = await callTool('kaggle.kernels.status', { ref: 'alice/sample-notebook' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.status).toBe('complete');
  });

  it('kaggle.kernels.output returns output files + log', async () => {
    const result = await callTool('kaggle.kernels.output', { ref: 'alice/sample-notebook' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.files[0].fileName).toBe('submission.csv');
    expect(data.log).toContain('completed');
  });

  it('rejects calls without Kaggle credentials in execution context', async () => {
    const adapter = fixtureKaggleAdapter();
    const server = createKaggleMCPServer({ adapter });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctxNoCreds = weaveContext({});
    await expect(
      mcpClient.callTool(ctxNoCreds, { name: 'kaggle.competitions.list', arguments: {} }),
    ).rejects.toThrow(/Kaggle credentials missing/);
  });
});

// ─── Phase K2: write tools + local container tools ───────────

import {
  ContainerExecutor,
  FakeRuntime,
  createImagePolicy,
} from '@weaveintel/sandbox';
import {
  KAGGLE_RUNNER_IMAGE_DIGEST,
  kaggleRunnerImagePolicyEntry,
} from './local-tools.js';

describe('./index.js K2 (fixture write tools)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const adapter = fixtureKaggleAdapter();
    const server = createKaggleMCPServer({ adapter });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: { kaggleUsername: 'tester', kaggleKey: 'fake-key' } });
    callTool = async (name, args) => {
      const result = await mcpClient.callTool(ctx, { name, arguments: args });
      return result as { content: Array<{ type: string; text: string }> };
    };
  });

  it('kaggle.competitions.submit returns a submission record', async () => {
    const result = await callTool('kaggle.competitions.submit', {
      competitionRef: 'titanic',
      fileName: 'submission.csv',
      fileContent: 'PassengerId,Survived\n1,0\n',
      description: 'baseline',
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.competitionRef).toBe('titanic');
    expect(data.submissionId).toMatch(/fixture-sub-/);
    expect(data.status).toBe('pending');
  });

  it('kaggle.kernels.push returns a kernel ref + version', async () => {
    const result = await callTool('kaggle.kernels.push', {
      slug: 'tester/baseline',
      title: 'Baseline',
      source: 'print("hi")',
      kernelType: 'script',
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.ref).toBe('tester/baseline');
    expect(typeof data.versionNumber).toBe('number');
    expect(data.status).toBe('queued');
  });

  it('kaggle.local.validate_submission rejects header mismatch', async () => {
    const result = await callTool('kaggle.local.validate_submission', {
      csvContent: 'Id,Outcome\n1,0\n',
      expectedHeaders: ['PassengerId', 'Survived'],
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.valid).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it('kaggle.local.validate_submission accepts a clean submission', async () => {
    const result = await callTool('kaggle.local.validate_submission', {
      csvContent: 'PassengerId,Survived\n1,0\n2,1\n',
      expectedHeaders: ['PassengerId', 'Survived'],
      idColumn: 'PassengerId',
      expectedIds: ['1', '2'],
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.valid).toBe(true);
    expect(data.rows).toBe(2);
  });

  it('kaggle.discussions.create posts a top-level topic (fixture)', async () => {
    const result = await callTool('kaggle.discussions.create', {
      competitionRef: 'titanic',
      title: 'Approach update',
      body: 'Tried gradient boosting; CV=0.82.',
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.competitionRef).toBe('titanic');
    expect(data.topicId).toMatch(/fixture-topic-/);
    expect(data.status).toBe('posted');
    expect(data.url).toContain('/discussion/fixture-topic-');
  });

  it('kaggle.discussions.create posts a reply when parentTopicId is set', async () => {
    const result = await callTool('kaggle.discussions.create', {
      competitionRef: 'titanic',
      title: 'unused for reply',
      body: 'Following up on your suggestion.',
      parentTopicId: 'topic-42',
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.message).toContain('Reply to topic-42');
  });
});

describe('./index.js K2 (sandboxed score_cv)', () => {
  it('errors clearly when no containerExecutor was wired', async () => {
    const adapter = fixtureKaggleAdapter();
    const server = createKaggleMCPServer({ adapter });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: { kaggleUsername: 'tester', kaggleKey: 'fake-key' } });
    await expect(
      mcpClient.callTool(ctx, {
        name: 'kaggle.local.score_cv',
        arguments: { trainCsv: 'a,b\n1,0\n', targetColumn: 'b', metric: 'accuracy' },
      }),
    ).rejects.toThrow(/containerExecutor/);
  });

  it('round-trips score_cv through FakeRuntime + ContainerExecutor', async () => {
    const stdin = JSON.stringify({
      command: 'score_cv',
      payload: { trainCsv: 'a,b\n1,0\n2,1\n3,0\n4,1\n5,0\n', targetColumn: 'b', metric: 'accuracy' },
    });
    const fakeResult = {
      stdout: JSON.stringify({
        cvScore: 0.92,
        foldScores: [0.9, 0.95, 0.9],
        metric: 'accuracy',
        model: 'logistic_regression',
        durationMs: 12,
      }),
      stderr: '',
      exitCode: 0,
      wallMs: 1,
      cpuMs: 1,
      truncated: { stdout: false, stderr: false },
    };
    const fake = new FakeRuntime().register(KAGGLE_RUNNER_IMAGE_DIGEST, stdin, fakeResult);
    const executor = new ContainerExecutor({
      runtime: fake,
      imagePolicy: createImagePolicy([kaggleRunnerImagePolicyEntry()]),
    });

    const adapter = fixtureKaggleAdapter();
    const server = createKaggleMCPServer({ adapter, containerExecutor: executor });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: { kaggleUsername: 'tester', kaggleKey: 'fake-key' } });

    const result = await mcpClient.callTool(ctx, {
      name: 'kaggle.local.score_cv',
      arguments: { trainCsv: 'a,b\n1,0\n2,1\n3,0\n4,1\n5,0\n', targetColumn: 'b', metric: 'accuracy' },
    }) as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(result.content[0]!.text);
    expect(data.cvScore).toBe(0.92);
    expect(data.foldScores).toHaveLength(3);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('./index.js K7a (blend)', () => {
  it('errors clearly when blend is called without containerExecutor', async () => {
    const adapter = fixtureKaggleAdapter();
    const server = createKaggleMCPServer({ adapter });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: { kaggleUsername: 'tester', kaggleKey: 'fake-key' } });
    await expect(
      mcpClient.callTool(ctx, {
        name: 'kaggle.local.blend',
        arguments: { oofMatrix: [[0.1, 0.9], [0.2, 0.8]], yTrue: [0, 1], metric: 'auc' },
      }),
    ).rejects.toThrow(/containerExecutor/);
  });

  it('round-trips blend through FakeRuntime + ContainerExecutor', async () => {
    const oofMatrix = [
      [0.1, 0.4, 0.6, 0.9],
      [0.2, 0.3, 0.7, 0.8],
      [0.15, 0.35, 0.65, 0.85],
    ];
    const yTrue = [0, 0, 1, 1];
    const stdin = JSON.stringify({
      command: 'blend',
      payload: { oofMatrix, yTrue, metric: 'auc' },
    });
    const fakeResult = {
      stdout: JSON.stringify({
        weights: [0.4, 0.3, 0.3],
        blendedScore: 0.95,
        baselineMeanScore: 0.92,
        baselineBestSoloScore: 0.93,
        modelCount: 3,
        sampleCount: 4,
        metric: 'auc',
        converged: true,
        iterations: 12,
      }),
      stderr: '',
      exitCode: 0,
      wallMs: 1,
      cpuMs: 1,
      truncated: { stdout: false, stderr: false },
    };
    const fake = new FakeRuntime().register(KAGGLE_RUNNER_IMAGE_DIGEST, stdin, fakeResult);
    const executor = new ContainerExecutor({
      runtime: fake,
      imagePolicy: createImagePolicy([kaggleRunnerImagePolicyEntry()]),
    });

    const adapter = fixtureKaggleAdapter();
    const server = createKaggleMCPServer({ adapter, containerExecutor: executor });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: { kaggleUsername: 'tester', kaggleKey: 'fake-key' } });

    const result = await mcpClient.callTool(ctx, {
      name: 'kaggle.local.blend',
      arguments: { oofMatrix, yTrue, metric: 'auc' },
    }) as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(result.content[0]!.text);
    expect(data.weights).toHaveLength(3);
    expect(data.blendedScore).toBe(0.95);
    expect(data.baselineBestSoloScore).toBe(0.93);
    expect(data.modelCount).toBe(3);
    expect(data.converged).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });
});

// ─── Live-sandbox tests (env-gated) ──────────────────────────

describe('./index.js (live-sandbox)', () => {
  if (!process.env['TEST_LIVE_SANDBOX'] || !process.env['KAGGLE_USERNAME'] || !process.env['KAGGLE_KEY']) {
    it.skip('skipped — set TEST_LIVE_SANDBOX=1 plus KAGGLE_USERNAME and KAGGLE_KEY to run', () => {});
    return;
  }

  it('lists real Kaggle competitions', async () => {
    const { liveKaggleAdapter } = await import('./kaggle.js');
    const creds = { username: process.env['KAGGLE_USERNAME']!, key: process.env['KAGGLE_KEY']! };
    const competitions = await liveKaggleAdapter.listCompetitions(creds, { page: 1 });
    expect(Array.isArray(competitions)).toBe(true);
  });
});
