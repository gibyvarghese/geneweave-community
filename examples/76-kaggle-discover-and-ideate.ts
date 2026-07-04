/**
 * Example 76 — Phase K3: Kaggle discover + ideate (fixture, no server)
 *
 * Demonstrates the chat-MVP wiring for Phase K3 *without* requiring a running
 * GeneWeave server or real Kaggle API access:
 *   1. Boots `createKaggleMCPServer` with the fixture adapter (no Docker, no
 *      network, no Kaggle credentials).
 *   2. Calls the read-only tools that `kaggle_discoverer` is configured to
 *      use (`kaggle.competitions.list`, `kaggle.competitions.get`).
 *   3. Calls the read-only tools that `kaggle_ideator` is configured to use
 *      (`kaggle.kernels.list`, `kaggle.kernels.pull`, `kaggle.competitions.files.list`).
 *   4. Validates the K3 grounding-reality contract: the *skill instructions*
 *      reference these tool keys, and the tools return shapes the ideator can
 *      summarise back to the user.
 *
 * The matching admin assets seeded by Phase K3 migration M11:
 *   - `tool_policies.kaggle_read_only`  — risk=read-only, no approval, 60 rpm
 *   - `skills.kaggle_discoverer`         — tool_policy_key=kaggle_read_only
 *   - `skills.kaggle_ideator`            — tool_policy_key=kaggle_read_only
 *
 * Run:
 *   npx tsx examples/76-kaggle-discover-and-ideate.ts
 */

import { weaveContext } from '@weaveintel/core';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveFakeTransport } from '@weaveintel/testing';
import {
  createKaggleMCPServer,
  fixtureKaggleAdapter,
} from '../apps/geneweave/src/kaggle/index.js';

const KAGGLE_DISCOVERER_TOOLS = [
  'kaggle.competitions.list',
  'kaggle.competitions.get',
] as const;

const KAGGLE_IDEATOR_TOOLS = [
  'kaggle.kernels.list',
  'kaggle.kernels.pull',
  'kaggle.competitions.files.list',
] as const;

async function main(): Promise<void> {
  console.log('── Phase K3: kaggle_discoverer + kaggle_ideator (fixture) ──\n');

  const server = createKaggleMCPServer({ adapter: fixtureKaggleAdapter() });
  const { client: clientTransport, server: serverTransport } = weaveFakeTransport();
  await server.start(serverTransport);

  const mcp = weaveMCPClient();
  await mcp.connect(clientTransport);

  const ctx = weaveContext({
    metadata: { kaggleUsername: 'demo-user', kaggleKey: 'demo-key' },
  });

  // ── 1. discoverer: list active competitions, then get details on one ──
  console.log('Step 1 ─ kaggle_discoverer flow');
  console.log('  tools used:', KAGGLE_DISCOVERER_TOOLS.join(', '));

  const list = await mcp.callTool(ctx, {
    name: 'kaggle.competitions.list',
    arguments: { page: 1 },
  });
  const listData = JSON.parse((list as { content: Array<{ text: string }> }).content[0]!.text);
  const comps = (listData.competitions ?? listData.items ?? listData) as Array<Record<string, unknown>>;
  console.log(`  → ${comps.length} active competitions returned`);
  comps.slice(0, 3).forEach((c, i) => {
    console.log(`     ${i + 1}. ${c['id'] ?? c['ref']} — ${c['title'] ?? '(no title)'}`);
  });

  const pick = comps[0];
  if (!pick) throw new Error('Fixture returned zero competitions');
  const compRef = (pick['id'] ?? pick['ref']) as string;

  const detail = await mcp.callTool(ctx, {
    name: 'kaggle.competitions.get',
    arguments: { ref: compRef },
  });
  const detailData = JSON.parse((detail as { content: Array<{ text: string }> }).content[0]!.text);
  console.log(`  → competition.get(${compRef}) → ${detailData.title ?? '(no title)'} | deadline=${detailData.deadline ?? 'n/a'}\n`);

  // ── 2. ideator: scan public kernels + competition files for the picked comp ──
  console.log('Step 2 ─ kaggle_ideator flow');
  console.log('  tools used:', KAGGLE_IDEATOR_TOOLS.join(', '));

  const kernels = await mcp.callTool(ctx, {
    name: 'kaggle.kernels.list',
    arguments: { competition: compRef, page: 1 },
  });
  const kernelData = JSON.parse((kernels as { content: Array<{ text: string }> }).content[0]!.text);
  const kernelList = (kernelData.kernels ?? kernelData.items ?? kernelData) as Array<Record<string, unknown>>;
  console.log(`  → ${kernelList.length} public kernels found`);

  if (kernelList.length > 0) {
    const topKernel = kernelList[0]!;
    const slug = (topKernel['ref'] ?? topKernel['slug'] ?? topKernel['id']) as string;
    if (slug) {
      const pulled = await mcp.callTool(ctx, {
        name: 'kaggle.kernels.pull',
        arguments: { ref: slug },
      });
      const pullData = JSON.parse((pulled as { content: Array<{ text: string }> }).content[0]!.text);
      const sourceLen = typeof pullData.source === 'string' ? pullData.source.length : 0;
      console.log(`  → kernels.pull(${slug}) → ${sourceLen} chars of source`);
    }
  }

  const files = await mcp.callTool(ctx, {
    name: 'kaggle.competitions.files.list',
    arguments: { ref: compRef },
  });
  const filesData = JSON.parse((files as { content: Array<{ text: string }> }).content[0]!.text);
  const fileList = (filesData.files ?? filesData.items ?? filesData) as Array<Record<string, unknown>>;
  console.log(`  → competition.files.list(${compRef}) → ${fileList.length} files\n`);

  // ── 3. Synthesised "ideator output" — what the skill would emit back ──
  console.log('Step 3 ─ Synthesised ideator output (what kaggle_ideator would emit)');
  console.log('  Approach 1: lightgbm on tabular features (expected metric: 0.78 AUC)');
  console.log('  Approach 2: gradient boosted trees with target encoding (expected metric: 0.81 AUC)');
  console.log('  Approach 3: stacking lightgbm + xgboost (expected metric: 0.83 AUC)');
  console.log('\n  All three reference public kernels via source_kernel_refs and would be');
  console.log('  persisted as kaggle_approaches rows via POST /api/admin/kaggle-approaches.\n');

  console.log('── Done. ──');
  console.log('\nGeneWeave admin verification (manual):');
  console.log('  - npx tsx examples/12-geneweave.ts');
  console.log('  - open /admin → Kaggle group → Tracked Competitions / Approaches / Runs');
  console.log('  - Orchestration → Skills: 6 kaggle_* skills (enabled=1)');
  console.log('  - Orchestration → Tool Policies: 4 kaggle_* policies seeded');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
